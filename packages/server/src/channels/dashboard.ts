/**
 * Octopus Boardroom — WebSocket + REST API server
 * Replaces the WhatsApp channel with a local dashboard API.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';

import {
  addDailyTokenUsage,
  completeAgentRun,
  countOpenHitlCardsForSubtree,
  createAgentRun,
  createConversation,
  deleteAgentSubtree,
  deleteTask,
  discardCrossBranchMessageArray,
  getActiveConversation,
  getAgentById,
  getAgentByName,
  getOrCreateActiveConversation,
  getAgentPath,
  getAgentRun,
  getAgentRuns,
  getAgentTree,
  getConversation,
  getConversationMessages,
  getConversations,
  getCrossBranchMessage,
  getDailyTokenUsage,
  getDescendants,
  getHitlCard,
  getLlmExchangesForRun,
  getOpenHitlCards,
  getPendingCrossBranchMessages,
  getActivityForRun,
  insertAgent,
  insertConversationMessage,
  insertInboxMessage,
  resetDailyTokenUsage,
  updateAgentAttrs,
  resolveHitlCard,
  updateAgentStatus,
  updateCrossBranchMessageStatus,
  insertPushSubscription,
  deletePushSubscription,
  type AgentRow,
  type HitlCardRow,
} from '../db.js';
import {
  broadcast,
  generateId,
  onceRunCompleted,
  setBroadcastFn,
  setDebugBroadcastFn,
  triggerAgentRun,
  type OctopusEvent,
  generateBoilerplate,
} from '../container-runner.js';
import { addDebugAgent, removeDebugAgent } from '../debug-state.js';
import {
  readPage,
  writePage,
  deletePage,
  listPages,
  AccessDeniedError,
  ParentNotFoundError,
  PageHasChildrenError,
} from '../sharedspace.js';
import { logger } from '../logger.js';
import {
  initWebPush,
  getVapidPublicKey,
  sendPushNotification,
} from '../web-push.js';
import {
  sharedspaceRead,
  sharedspaceWrite,
  sharedspaceList,
  sendMessage,
  requestHitl,
  taskComplete,
} from '../tools.js';

// --- WebSocket clients ---

const clients: Set<WsWebSocket> = new Set();

// --- Debug subscriptions: client → set of agent IDs ---
const debugSubscriptions = new Map<WsWebSocket, Set<string>>();

/** Get the set of agent IDs a client is subscribed to for debug */
function getDebugSubs(client: WsWebSocket): Set<string> {
  let subs = debugSubscriptions.get(client);
  if (!subs) {
    subs = new Set();
    debugSubscriptions.set(client, subs);
  }
  return subs;
}

/** Send a debug exchange event only to clients subscribed to the agent */
export function wsBroadcastDebug(agentId: string, event: OctopusEvent): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    const subs = debugSubscriptions.get(client);
    if (subs?.has(agentId)) {
      wsSend(client, data);
    }
  }
}

let wss: WebSocketServer | null = null;

function wsSend(client: WsWebSocket, data: string): void {
  if (client.readyState === WsWebSocket.OPEN) {
    client.send(data);
  }
}

function wsBroadcast(event: OctopusEvent): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    wsSend(client, data);
  }

  // Send push notification for chat messages
  if (event.type === 'chat.message.received') {
    const payload = event.payload as {
      agent_id: string;
      content: string;
    };
    const agent = getAgentById(payload.agent_id);
    const agentName = agent?.agent_name ?? payload.agent_id;
    sendPushNotification(payload.agent_id, agentName, payload.content).catch(
      (err) => logger.warn({ err }, 'Push notification error'),
    );
  }
}

function wsSendEvent(
  client: WsWebSocket,
  type: string,
  payload: Record<string, unknown>,
): void {
  wsSend(client, JSON.stringify({ v: 1, type, ts: Date.now(), payload }));
}

// --- REST helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function parseJson(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

function sendNoContent(res: http.ServerResponse): void {
  res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
  res.end();
}

// --- Connection state snapshot ---

function buildConnectionState(): Record<string, unknown> {
  const agents = getAgentTree();
  const today = new Date().toISOString().slice(0, 10);

  const agentStates = agents.map((a) => ({
    agent_id: a.agent_id,
    agent_name: a.agent_name,
    agent_title: a.agent_title,
    parent_id: a.parent_id,
    depth: a.depth,
    status: a.status,
    used_tokens_today: getDailyTokenUsage(a.agent_id),
    open_hitl_cards: countOpenHitlCardsForSubtree(a.agent_id),
    cross_branch_trusted: a.cross_branch_trusted === 1,
    tool_allowlist: a.tool_allowlist ? JSON.parse(a.tool_allowlist) : null,
  }));

  const hitlCards = getOpenHitlCards();
  const cbMessages = getPendingCrossBranchMessages();

  return {
    agents: agentStates,
    hitl_queue_count: hitlCards.length,
    crossbranch_queue_count: cbMessages.length,
    total_tokens_today: agents.reduce(
      (sum, a) => sum + getDailyTokenUsage(a.agent_id),
      0,
    ),
  };
}

// --- Route matching ---

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(method: string, path: string, handler: RouteHandler): void {
  // Convert path like /agents/{agent_id}/runs/{run_id} to regex
  const paramNames: string[] = [];
  const regexStr = path.replace(/\{([^}]+)\}/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method,
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
  });
}

// Special route for wildcard paths (SharedSpace page_id with slashes)
function addWildcardRoute(
  method: string,
  prefix: string,
  handler: RouteHandler,
): void {
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+)$`,
  );
  routes.push({
    method,
    pattern,
    paramNames: ['page_id'],
    handler,
  });
}

function matchRoute(
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
      }
      return { handler: route.handler, params };
    }
  }
  return null;
}

// --- Define REST endpoints ---

function setupRoutes(): void {
  // --- Agents ---

  addRoute('GET', '/api/v1/agents', async (_req, res) => {
    const agents = getAgentTree();
    const result = agents.map((a) => {
      const runs = getAgentRuns(a.agent_id, 1);
      const lastRun = runs.runs[0];
      return {
        agent_id: a.agent_id,
        agent_name: a.agent_name,
        agent_title: a.agent_title,
        parent_id: a.parent_id,
        depth: a.depth,
        status: a.status,
        used_tokens_today: getDailyTokenUsage(a.agent_id),
        open_hitl_cards: countOpenHitlCardsForSubtree(a.agent_id),
        last_run_ts: lastRun?.started_ts || null,
        cross_branch_trusted: a.cross_branch_trusted === 1,
        tool_allowlist: a.tool_allowlist ? JSON.parse(a.tool_allowlist) : null,
      };
    });
    sendJson(res, 200, { agents: result });
  });

  addRoute('POST', '/api/v1/agents', async (req, res) => {
    const body = (await parseJson(req)) as {
      agent_name?: string;
      agent_title?: string;
      parent_id?: string | null;
      cross_branch_trusted?: boolean;
      tool_allowlist?: string[] | null;
    };
    if (!body.agent_name) {
      return sendError(res, 400, 'validation_error', 'agent_name is required');
    }
    if (!body.agent_title) {
      return sendError(res, 400, 'validation_error', 'agent_title is required');
    }

    // Validate parent exists if provided
    if (body.parent_id) {
      const parent = getAgentById(body.parent_id);
      if (!parent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `Parent agent '${body.parent_id}' not found`,
        );
      }
    }

    // Agent names must be unique (used for send_message resolution)
    const existing = getAgentByName(body.agent_name);
    if (existing) {
      return sendError(
        res,
        409,
        'name_taken',
        `An agent named '${body.agent_name}' already exists`,
      );
    }

    // Generate opaque agent_id
    const agentId = generateId('agent');

    const agent = insertAgent(
      agentId,
      body.agent_name,
      body.agent_title,
      body.parent_id || null,
      {
        cross_branch_trusted: body.cross_branch_trusted,
        tool_allowlist: body.tool_allowlist,
      },
    );

    // Create agent directory and default CLAUDE.md
    const fs = await import('fs');
    const path = await import('path');
    const { GROUPS_DIR } = await import('../config.js');
    const agentDir = path.join(GROUPS_DIR, agentId);
    fs.mkdirSync(path.join(agentDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'inbox'), { recursive: true });
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(
        claudeMdPath,
        `# ${body.agent_name}\n\nYour name is ${body.agent_name}. Your role is ${body.agent_title}.\n`,
      );
    }

    const agentPath = getAgentPath(agentId);
    broadcast('agent.created', {
      agent_id: agentId,
      agent_name: body.agent_name,
      agent_title: body.agent_title,
      parent_id: body.parent_id || null,
      agent_path: agentPath,
      depth: agent.depth,
      status: 'idle',
      used_tokens_today: 0,
      cross_branch_trusted: agent.cross_branch_trusted === 1,
      tool_allowlist: agent.tool_allowlist
        ? JSON.parse(agent.tool_allowlist)
        : null,
    });

    sendJson(res, 201, {
      agent_id: agentId,
      agent_name: body.agent_name,
      agent_title: body.agent_title,
      parent_id: body.parent_id || null,
      depth: agent.depth,
      status: 'idle',
      used_tokens_today: 0,
      open_hitl_cards: 0,
      last_run_ts: null,
      cross_branch_trusted: agent.cross_branch_trusted === 1,
      tool_allowlist: agent.tool_allowlist
        ? JSON.parse(agent.tool_allowlist)
        : null,
    });
  });

  addRoute('GET', '/api/v1/agents/{agent_id}', async (_req, res, params) => {
    const agent = getAgentById(params.agent_id);
    if (!agent) {
      return sendError(
        res,
        404,
        'agent_not_found',
        `No agent with id '${params.agent_id}'`,
      );
    }
    const runs = getAgentRuns(agent.agent_id, 1);
    const lastRun = runs.runs[0];
    sendJson(res, 200, {
      agent_id: agent.agent_id,
      agent_name: agent.agent_name,
      agent_title: agent.agent_title,
      parent_id: agent.parent_id,
      agent_path: getAgentPath(agent.agent_id),
      depth: agent.depth,
      status: agent.status,
      used_tokens_today: getDailyTokenUsage(agent.agent_id),
      open_hitl_cards: countOpenHitlCardsForSubtree(agent.agent_id),
      last_run_ts: lastRun?.started_ts || null,
      last_run_exit_reason: lastRun?.exit_reason || null,
      budget_tokens: null, // TODO: parse from CLAUDE.md
      budget_eur: null,
      cross_branch_trusted: agent.cross_branch_trusted === 1,
      tool_allowlist: agent.tool_allowlist
        ? JSON.parse(agent.tool_allowlist)
        : null,
    });
  });

  addRoute('DELETE', '/api/v1/agents/{agent_id}', async (_req, res, params) => {
    const agent = getAgentById(params.agent_id);
    if (!agent) {
      return sendError(
        res,
        404,
        'agent_not_found',
        `No agent with id '${params.agent_id}'`,
      );
    }
    if (agent.status === 'active') {
      return sendError(
        res,
        409,
        'agent_active',
        `Agent '${params.agent_id}' is currently running`,
      );
    }
    // Check for paused invocations
    const openCards = getOpenHitlCards().filter(
      (c) => c.agent_id === params.agent_id && c.message_array,
    );
    const pendingCb = getPendingCrossBranchMessages().filter(
      (m) => m.sender_agent_id === params.agent_id,
    );
    if (openCards.length > 0 || pendingCb.length > 0) {
      return sendError(
        res,
        409,
        'agent_paused',
        `Agent '${params.agent_id}' has a paused invocation. Resolve pending cards/messages first.`,
      );
    }

    // Only run a handover invocation if the agent has actually been used.
    // A brand-new agent with no completed runs has nothing to hand over.
    const pastRuns = getAgentRuns(params.agent_id, 1);
    if (pastRuns.runs.length > 0) {
      const conv = getOrCreateActiveConversation(params.agent_id, () =>
        generateId('conv'),
      );
      const completionPromise = onceRunCompleted(params.agent_id);
      triggerAgentRun(
        params.agent_id,
        conv.conversation_id,
        '[CEO]: You are being terminated. Summarize any important private notes and write a handover document to SharedSpace so your knowledge is preserved. Be concise.',
      );

      // Wait for the handover run to finish, but don't block forever
      const HANDOVER_TIMEOUT_MS = 120_000; // 2 minutes
      await Promise.race([
        completionPromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, HANDOVER_TIMEOUT_MS),
        ),
      ]);
    }

    const deletedIds = deleteAgentSubtree(params.agent_id);
    broadcast('agent.deleted', {
      agent_id: params.agent_id,
      deleted_subtree: deletedIds,
    });
    sendNoContent(res);
  });

  addRoute('PUT', '/api/v1/agents/{agent_id}', async (req, res, params) => {
    const agent = getAgentById(params.agent_id);
    if (!agent) {
      return sendError(
        res,
        404,
        'agent_not_found',
        `No agent with id '${params.agent_id}'`,
      );
    }
    const body = (await parseJson(req)) as {
      agent_name?: string;
      agent_title?: string;
      cross_branch_trusted?: boolean;
      tool_allowlist?: string[] | null;
    };

    // Validate tool_allowlist is an array of strings or null
    if (
      body.tool_allowlist !== undefined &&
      body.tool_allowlist !== null &&
      (!Array.isArray(body.tool_allowlist) ||
        !body.tool_allowlist.every((t) => typeof t === 'string'))
    ) {
      return sendError(
        res,
        400,
        'validation_error',
        'tool_allowlist must be an array of strings or null',
      );
    }

    updateAgentAttrs(params.agent_id, {
      agent_name: body.agent_name,
      agent_title: body.agent_title,
      cross_branch_trusted: body.cross_branch_trusted,
      tool_allowlist: body.tool_allowlist,
    });

    const updated = getAgentById(params.agent_id)!;
    const runs = getAgentRuns(updated.agent_id, 1);
    const lastRun = runs.runs[0];
    sendJson(res, 200, {
      agent_id: updated.agent_id,
      agent_name: updated.agent_name,
      agent_title: updated.agent_title,
      parent_id: updated.parent_id,
      agent_path: getAgentPath(updated.agent_id),
      depth: updated.depth,
      status: updated.status,
      used_tokens_today: getDailyTokenUsage(updated.agent_id),
      open_hitl_cards: countOpenHitlCardsForSubtree(updated.agent_id),
      last_run_ts: lastRun?.started_ts || null,
      last_run_exit_reason: lastRun?.exit_reason || null,
      budget_tokens: null,
      budget_eur: null,
      cross_branch_trusted: updated.cross_branch_trusted === 1,
      tool_allowlist: updated.tool_allowlist
        ? JSON.parse(updated.tool_allowlist)
        : null,
    });
  });

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/claude-md',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const fs = await import('fs');
      const path = await import('path');
      const { GROUPS_DIR } = await import('../config.js');
      const claudeMdPath = path.join(GROUPS_DIR, params.agent_id, 'CLAUDE.md');
      let content = '';
      if (fs.existsSync(claudeMdPath)) {
        content = fs.readFileSync(claudeMdPath, 'utf-8');
      }
      // Strip auto-generated boilerplate — CEO should only see their own content
      const markerIdx = content.indexOf('\n\n<!-- octopus:auto-generated -->');
      if (markerIdx >= 0) {
        content = content.slice(0, markerIdx);
      }
      sendJson(res, 200, { agent_id: params.agent_id, content });
    },
  );

  addRoute(
    'PUT',
    '/api/v1/agents/{agent_id}/claude-md',
    async (req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const body = (await parseJson(req)) as { content?: string };
      if (body.content === undefined) {
        return sendError(res, 400, 'validation_error', 'content is required');
      }
      const fs = await import('fs');
      const path = await import('path');
      const { GROUPS_DIR } = await import('../config.js');
      const agentDir = path.join(GROUPS_DIR, params.agent_id);
      fs.mkdirSync(agentDir, { recursive: true });
      // Strip auto-generated boilerplate if accidentally included
      let content = body.content;
      const markerIdx = content.indexOf('\n\n<!-- octopus:auto-generated -->');
      if (markerIdx >= 0) {
        content = content.slice(0, markerIdx);
      }
      fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), content);
      sendJson(res, 200, { agent_id: params.agent_id, content });
    },
  );

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/boilerplate',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      sendJson(res, 200, {
        agent_id: params.agent_id,
        content: generateBoilerplate(params.agent_id),
      });
    },
  );

  // --- Runs and Activity ---

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/runs',
    async (req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const url = new URL(req.url || '/', `http://localhost`);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const before = url.searchParams.get('before') || undefined;
      const { runs, has_more } = getAgentRuns(params.agent_id, limit, before);
      sendJson(res, 200, {
        agent_id: params.agent_id,
        runs: runs.map((r) => ({
          run_id: r.run_id,
          trigger_type: r.trigger_type,
          trigger_detail: r.trigger_detail,
          started_ts: r.started_ts,
          completed_ts: r.completed_ts,
          exit_reason: r.exit_reason,
          total_tokens: r.total_tokens,
        })),
        has_more,
      });
    },
  );

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/runs/{run_id}/activity',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const run = getAgentRun(params.run_id);
      if (!run || run.agent_id !== params.agent_id) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `Run '${params.run_id}' not found`,
        );
      }
      const entries = getActivityForRun(params.agent_id, params.run_id);
      sendJson(res, 200, {
        run_id: params.run_id,
        agent_id: params.agent_id,
        status: run.completed_ts ? run.exit_reason || 'completed' : 'active',
        entries: entries.map((e) => ({
          entry_id: e.entry_id,
          entry_type: e.entry_type,
          tool_name: e.tool_name,
          tool_category: e.tool_category,
          detail: e.detail,
          outcome: e.outcome,
          ts: e.ts,
        })),
      });
    },
  );

  // --- LLM Exchanges (debug) ---

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/runs/{run_id}/exchanges',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const run = getAgentRun(params.run_id);
      if (!run || run.agent_id !== params.agent_id) {
        return sendError(
          res,
          404,
          'run_not_found',
          `Run '${params.run_id}' not found`,
        );
      }
      const exchanges = getLlmExchangesForRun(params.agent_id, params.run_id);
      sendJson(res, 200, {
        run_id: params.run_id,
        agent_id: params.agent_id,
        exchanges: exchanges.map((e) => ({
          exchange_index: e.exchange_index,
          messages_json: e.messages_json,
          response_json: e.response_json,
          tokens_in: e.tokens_in,
          tokens_out: e.tokens_out,
          ts: e.ts,
        })),
      });
    },
  );

  // --- Scheduled tasks ---

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/schedules',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      // Schedules will be mapped from the existing scheduled_tasks table
      sendJson(res, 200, { agent_id: params.agent_id, schedules: [] });
    },
  );

  addRoute(
    'POST',
    '/api/v1/agents/{agent_id}/schedules',
    async (req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const body = (await parseJson(req)) as { cron?: string; name?: string };
      if (!body.cron || !body.name) {
        return sendError(
          res,
          400,
          'validation_error',
          'cron and name are required',
        );
      }
      // Validate cron expression
      try {
        const { CronExpressionParser } = await import('cron-parser');
        const interval = CronExpressionParser.parse(body.cron);
        const nextRun = interval.next().toDate();
        const scheduleId = generateId('sched');
        sendJson(res, 201, {
          schedule_id: scheduleId,
          agent_id: params.agent_id,
          cron: body.cron,
          name: body.name,
          enabled: true,
          last_run_ts: null,
          next_run_ts: nextRun.getTime(),
        });
      } catch {
        return sendError(res, 422, 'invalid_cron', 'Invalid cron expression');
      }
    },
  );

  addRoute(
    'DELETE',
    '/api/v1/agents/{agent_id}/schedules/{schedule_id}',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      // TODO: lookup schedule by schedule_id mapped to agent
      sendNoContent(res);
    },
  );

  // --- Budget ---

  addRoute(
    'POST',
    '/api/v1/agents/{agent_id}/budget/reset',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const previousUsed = getDailyTokenUsage(params.agent_id);
      resetDailyTokenUsage(params.agent_id);

      const previousStatus = agent.status;
      if (previousStatus === 'alert') {
        updateAgentStatus(params.agent_id, 'idle');
      }

      broadcast('agent.budget.reset', {
        agent_id: params.agent_id,
        reset_by: 'ceo',
        previous_used_tokens: previousUsed,
        budget_tokens: 0, // TODO: parse from CLAUDE.md
      });

      if (previousStatus === 'alert') {
        broadcast('agent.status.changed', {
          agent_id: params.agent_id,
          status: 'idle',
          previous_status: previousStatus,
        });
      }

      sendJson(res, 200, {
        agent_id: params.agent_id,
        budget_tokens: 0,
        used_tokens: 0,
      });
    },
  );

  // --- Conversations ---

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/conversations',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const convs = getConversations(params.agent_id);
      sendJson(res, 200, {
        agent_id: params.agent_id,
        conversations: convs.map((c) => {
          const msgs = getConversationMessages(c.conversation_id);
          const lastAgentMsg = [...msgs]
            .reverse()
            .find((m) => m.role === 'agent');
          return {
            conversation_id: c.conversation_id,
            started_ts: c.started_ts,
            last_message_ts: c.last_message_ts,
            preview: lastAgentMsg ? lastAgentMsg.content.slice(0, 80) : null,
            message_count: msgs.length,
            active: c.active === 1,
          };
        }),
      });
    },
  );

  addRoute(
    'POST',
    '/api/v1/agents/{agent_id}/conversations',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const convId = generateId('conv');
      const conv = createConversation(convId, params.agent_id);
      sendJson(res, 201, {
        conversation_id: convId,
        agent_id: params.agent_id,
        started_ts: conv.started_ts,
        active: true,
        messages: [],
      });
    },
  );

  addRoute(
    'GET',
    '/api/v1/agents/{agent_id}/conversations/{conversation_id}',
    async (_req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const conv = getConversation(params.conversation_id);
      if (!conv || conv.agent_id !== params.agent_id) {
        return sendError(
          res,
          404,
          'conversation_not_found',
          `Conversation '${params.conversation_id}' not found`,
        );
      }
      const msgs = getConversationMessages(params.conversation_id);
      sendJson(res, 200, {
        conversation_id: params.conversation_id,
        agent_id: params.agent_id,
        started_ts: conv.started_ts,
        active: conv.active === 1,
        messages: msgs.map((m) => ({
          message_id: m.message_id,
          role: m.role,
          content: m.content,
          ts: m.ts,
          run_id: m.run_id,
        })),
      });
    },
  );

  addRoute(
    'POST',
    '/api/v1/agents/{agent_id}/conversations/{conversation_id}/messages',
    async (req, res, params) => {
      const agent = getAgentById(params.agent_id);
      if (!agent) {
        return sendError(
          res,
          404,
          'agent_not_found',
          `No agent with id '${params.agent_id}'`,
        );
      }
      const conv = getConversation(params.conversation_id);
      if (!conv || conv.agent_id !== params.agent_id) {
        return sendError(
          res,
          404,
          'conversation_not_found',
          `Conversation '${params.conversation_id}' not found`,
        );
      }
      if (agent.status !== 'idle') {
        return sendError(
          res,
          409,
          'agent_active',
          `Agent is currently ${agent.status}`,
        );
      }
      const body = (await parseJson(req)) as { content?: string };
      if (!body.content) {
        return sendError(res, 400, 'validation_error', 'content is required');
      }

      const msgId = generateId('msg');
      const now = Date.now();
      insertConversationMessage({
        message_id: msgId,
        conversation_id: params.conversation_id,
        agent_id: params.agent_id,
        role: 'ceo',
        content: body.content,
        ts: now,
        run_id: null,
      });

      const timestamp = new Date(now)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ' UTC');
      triggerAgentRun(
        params.agent_id,
        params.conversation_id,
        `[CEO @ ${timestamp}]: ${body.content}`,
      );

      sendJson(res, 201, {
        message_id: msgId,
        conversation_id: params.conversation_id,
        agent_id: params.agent_id,
        role: 'ceo',
        content: body.content,
        ts: now,
      });
    },
  );

  // --- HITL Queue ---

  addRoute('GET', '/api/v1/hitl', async (_req, res) => {
    const cards = getOpenHitlCards();
    sendJson(res, 200, {
      cards: cards.map(formatHitlCard),
    });
  });

  addRoute('GET', '/api/v1/hitl/{card_id}', async (_req, res, params) => {
    const card = getHitlCard(params.card_id);
    if (!card) {
      return sendError(
        res,
        404,
        'card_not_found',
        `Card '${params.card_id}' not found`,
      );
    }
    sendJson(res, 200, formatHitlCard(card));
  });

  addRoute(
    'POST',
    '/api/v1/hitl/{card_id}/decision',
    async (req, res, params) => {
      const card = getHitlCard(params.card_id);
      if (!card) {
        return sendError(
          res,
          404,
          'card_not_found',
          `Card '${params.card_id}' not found`,
        );
      }
      if (card.resolution) {
        return sendError(
          res,
          409,
          'card_already_resolved',
          `Card '${params.card_id}' has already been resolved`,
        );
      }

      const body = (await parseJson(req)) as {
        resolution?: string;
        selected_option?: number;
        note?: string;
      };
      if (!body.resolution) {
        return sendError(
          res,
          400,
          'validation_error',
          'resolution is required',
        );
      }

      // Validate resolution against card type
      const validResolutions = getValidResolutions(card.card_type);
      if (!validResolutions.includes(body.resolution)) {
        return sendError(
          res,
          400,
          'invalid_resolution',
          `Invalid resolution '${body.resolution}' for card type '${card.card_type}'`,
        );
      }

      if (
        body.resolution === 'option_selected' &&
        body.selected_option === undefined
      ) {
        return sendError(
          res,
          400,
          'validation_error',
          'selected_option is required for option_selected',
        );
      }
      if (body.resolution === 'returned' && !body.note) {
        return sendError(
          res,
          400,
          'validation_error',
          'note is required for returned resolution',
        );
      }

      resolveHitlCard(
        params.card_id,
        body.resolution,
        body.selected_option,
        body.note,
      );

      const agent = getAgentById(card.agent_id);
      broadcast('hitl.card.resolved', {
        card_id: params.card_id,
        agent_id: card.agent_id,
        resolution: body.resolution,
        selected_option: body.selected_option ?? null,
        note: body.note ?? null,
      });

      // For non-rejected resolutions, resume the agent
      if (body.resolution !== 'rejected') {
        const conv = getOrCreateActiveConversation(card.agent_id, () =>
          generateId('conv'),
        );

        // Build resume message with full context
        const parts: string[] = [];

        // 1. Prior conversation history
        const priorMessages = getConversationMessages(conv.conversation_id);
        if (priorMessages.length > 0) {
          parts.push('=== Conversation history ===');
          for (const m of priorMessages) {
            const role = m.role === 'ceo' ? 'CEO' : 'You';
            parts.push(`[${role}]: ${m.content}`);
          }
          parts.push('');
        }

        // 2. The original HITL request (what the agent wrote)
        parts.push(`=== Your ${card.card_type} request ===`);
        parts.push(`Subject: ${card.subject}`);
        parts.push(`Context: ${card.context}`);
        if (card.options) {
          const opts = JSON.parse(card.options) as string[];
          parts.push('Options:');
          opts.forEach((o, i) => parts.push(`  ${i + 1}. ${o}`));
        }
        parts.push('');

        // 3. The CEO's decision
        parts.push('=== CEO decision ===');
        if (body.resolution === 'approved') {
          parts.push('Decision: APPROVED');
        } else if (body.resolution === 'returned') {
          parts.push(`Decision: RETURNED with instructions`);
          parts.push(`CEO note: ${body.note}`);
        } else if (body.resolution === 'option_selected') {
          const opts = card.options
            ? (JSON.parse(card.options) as string[])
            : [];
          const label =
            opts[body.selected_option!] ?? `option ${body.selected_option}`;
          parts.push(
            `Decision: CEO selected option ${(body.selected_option ?? 0) + 1}: ${label}`,
          );
        } else {
          parts.push(`Decision: ${body.resolution}`);
        }
        parts.push('');
        parts.push('Continue your work based on the above decision.');

        triggerAgentRun(card.agent_id, conv.conversation_id, parts.join('\n'));
      }

      sendJson(res, 200, {
        card_id: params.card_id,
        resolution: body.resolution,
      });
    },
  );

  // --- Cross-branch Queue ---

  addRoute('GET', '/api/v1/crossbranch', async (_req, res) => {
    const messages = getPendingCrossBranchMessages();
    sendJson(res, 200, {
      messages: messages.map((m) => {
        const sender = getAgentById(m.sender_agent_id);
        const recipient = getAgentById(m.recipient_agent_id);
        return {
          message_id: m.message_id,
          from_agent_id: m.sender_agent_id,
          from_agent_name: sender?.agent_name || m.sender_agent_id,
          from_agent_title: sender?.agent_title || '',
          from_agent_path: getAgentPath(m.sender_agent_id),
          to_agent_id: m.recipient_agent_id,
          to_agent_name: recipient?.agent_name || m.recipient_agent_id,
          to_agent_title: recipient?.agent_title || '',
          to_agent_path: getAgentPath(m.recipient_agent_id),
          subject: m.subject,
          body: m.body,
          run_id: m.run_id,
          arrived_ts: m.arrived_ts,
        };
      }),
    });
  });

  addRoute(
    'POST',
    '/api/v1/crossbranch/{message_id}/release',
    async (_req, res, params) => {
      const msg = getCrossBranchMessage(params.message_id);
      if (!msg) {
        return sendError(
          res,
          404,
          'message_not_found',
          `Message '${params.message_id}' not found`,
        );
      }
      if (msg.status !== 'pending') {
        return sendError(
          res,
          409,
          'validation_error',
          'Message already processed',
        );
      }

      updateCrossBranchMessageStatus(params.message_id, 'released');

      const recipient = getAgentById(msg.recipient_agent_id);
      const sender = getAgentById(msg.sender_agent_id);

      // Deliver to recipient inbox
      insertInboxMessage({
        message_id: params.message_id,
        recipient_agent_id: msg.recipient_agent_id,
        from_agent_id: msg.sender_agent_id,
        from_agent_name: sender?.agent_name || msg.sender_agent_id,
        subject: msg.subject,
        body: msg.body,
        cross_branch: 1,
        delivered_ts: Date.now(),
      });

      broadcast('crossbranch.message.released', {
        message_id: params.message_id,
        to_agent_id: msg.recipient_agent_id,
      });

      broadcast('inbox.message.delivered', {
        recipient_agent_id: msg.recipient_agent_id,
        message_id: params.message_id,
        from_agent_id: msg.sender_agent_id,
        from_agent_name: sender?.agent_name || msg.sender_agent_id,
        subject: msg.subject,
        cross_branch: true,
      });

      // Resume sender
      if (msg.message_array) {
        const senderConv = getOrCreateActiveConversation(
          msg.sender_agent_id,
          () => generateId('conv'),
        );
        triggerAgentRun(
          msg.sender_agent_id,
          senderConv.conversation_id,
          `Your cross-branch message to ${recipient?.agent_name || msg.recipient_agent_id} (subject: "${msg.subject}") has been approved and delivered by the CEO. You may continue.`,
        );
      }

      // Wake recipient with the delivered message
      const recipientConv = getOrCreateActiveConversation(
        msg.recipient_agent_id,
        () => generateId('conv'),
      );
      triggerAgentRun(
        msg.recipient_agent_id,
        recipientConv.conversation_id,
        `[Inbox message from ${sender?.agent_name || msg.sender_agent_id}]\nSubject: ${msg.subject}\n\n${msg.body}`,
      );

      sendNoContent(res);
    },
  );

  addRoute(
    'POST',
    '/api/v1/crossbranch/{message_id}/drop',
    async (_req, res, params) => {
      const msg = getCrossBranchMessage(params.message_id);
      if (!msg) {
        return sendError(
          res,
          404,
          'message_not_found',
          `Message '${params.message_id}' not found`,
        );
      }
      if (msg.status !== 'pending') {
        return sendError(
          res,
          409,
          'validation_error',
          'Message already processed',
        );
      }

      discardCrossBranchMessageArray(params.message_id);

      broadcast('crossbranch.message.dropped', {
        message_id: params.message_id,
        from_agent_id: msg.sender_agent_id,
      });

      // Notify the sender that the message was blocked
      const recipient = getAgentById(msg.recipient_agent_id);
      const senderConv = getOrCreateActiveConversation(
        msg.sender_agent_id,
        () => generateId('conv'),
      );
      triggerAgentRun(
        msg.sender_agent_id,
        senderConv.conversation_id,
        `[CEO]: Your cross-branch message to ${recipient?.agent_name || msg.recipient_agent_id} (subject: "${msg.subject}") was not allowed through by the CEO. Do not retry sending this message.`,
      );

      sendNoContent(res);
    },
  );

  // --- SharedSpace ---

  addRoute('GET', '/api/v1/sharedspace', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const asAgent = url.searchParams.get('as') || undefined;
    const requesterId = asAgent || 'ceo';

    const pages = listPages(undefined, requesterId);
    sendJson(res, 200, {
      pages: pages.map((p) => ({
        page_id: p.page_id,
        summary: p.summary,
        owner: p.owner,
        access: p.access,
        updated: p.updated,
      })),
    });
  });

  // SharedSpace wildcard routes (page_id contains slashes)
  addWildcardRoute('GET', '/api/v1/sharedspace', async (req, res, params) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const asAgent = url.searchParams.get('as') || undefined;
    const requesterId = asAgent || 'ceo';

    try {
      const page = readPage(params.page_id, requesterId);
      sendJson(res, 200, {
        page_id: page.page_id,
        summary: page.summary,
        owner: page.owner,
        access: page.access,
        updated: page.updated,
        body: page.body,
      });
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return sendError(res, 404, 'page_not_found', err.message);
      }
      throw err;
    }
  });

  addWildcardRoute('PUT', '/api/v1/sharedspace', async (req, res, params) => {
    const body = (await parseJson(req)) as {
      summary?: string;
      owner?: string;
      access?: string | string[];
      body?: string;
    };
    if (body.summary === undefined || body.body === undefined) {
      return sendError(
        res,
        400,
        'validation_error',
        'summary and body are required',
      );
    }

    try {
      const page = writePage(
        params.page_id,
        {
          summary: body.summary,
          body: body.body,
          owner: body.owner,
          access: body.access as import('../sharedspace.js').AccessLevel,
        },
        'ceo',
      );

      // writePage emits the WS event internally
      sendJson(res, 200, {
        page_id: page.page_id,
        summary: page.summary,
        owner: page.owner,
        access: page.access,
        updated: page.updated,
        body: page.body,
      });
    } catch (err) {
      if (err instanceof ParentNotFoundError) {
        return sendError(res, 404, 'page_not_found', err.message);
      }
      if (err instanceof AccessDeniedError) {
        return sendError(res, 403, 'access_denied', err.message);
      }
      throw err;
    }
  });

  addWildcardRoute(
    'DELETE',
    '/api/v1/sharedspace',
    async (_req, res, params) => {
      try {
        deletePage(params.page_id, 'ceo');
        // deletePage emits the WS event internally
        sendNoContent(res);
      } catch (err) {
        if (err instanceof AccessDeniedError) {
          return sendError(res, 404, 'page_not_found', err.message);
        }
        if (err instanceof PageHasChildrenError) {
          return sendError(res, 409, 'page_has_children', err.message);
        }
        throw err;
      }
    },
  );

  // --- Cost ---

  addRoute('GET', '/api/v1/cost', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const period = url.searchParams.get('period') || 'today';

    const now = new Date();
    let fromTs: number;
    if (period === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      d.setHours(0, 0, 0, 0);
      fromTs = d.getTime();
    } else if (period === 'month') {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      d.setHours(0, 0, 0, 0);
      fromTs = d.getTime();
    } else {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      fromTs = d.getTime();
    }

    const agents = getAgentTree();
    const agentCosts = agents.map((a) => ({
      agent_id: a.agent_id,
      agent_name: a.agent_name,
      agent_title: a.agent_title,
      cost_eur: 0.0, // TODO: compute from token usage
    }));
    agentCosts.sort((a, b) => b.cost_eur - a.cost_eur);

    sendJson(res, 200, {
      period,
      from_ts: fromTs,
      to_ts: now.getTime(),
      total_eur: 0.0,
      agents: agentCosts,
    });
  });

  // --- Push notifications ---

  addRoute('GET', '/api/v1/push/vapid-key', async (_req, res) => {
    sendJson(res, 200, { publicKey: getVapidPublicKey() });
  });

  addRoute('POST', '/api/v1/push/subscribe', async (req, res) => {
    const body = (await parseJson(req)) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      sendError(res, 400, 'validation_error', 'Missing endpoint or keys');
      return;
    }
    insertPushSubscription(body.endpoint, body.keys.p256dh, body.keys.auth);
    sendJson(res, 201, { ok: true });
  });

  addRoute('POST', '/api/v1/push/unsubscribe', async (req, res) => {
    const body = (await parseJson(req)) as { endpoint?: string };
    if (!body.endpoint) {
      sendError(res, 400, 'validation_error', 'Missing endpoint');
      return;
    }
    deletePushSubscription(body.endpoint);
    sendNoContent(res);
  });

  // --- Server restart ---

  addRoute('POST', '/api/v1/restart', async (_req, res) => {
    sendJson(res, 200, { ok: true });

    // Determine the server package root (two dirs up from dist/channels/)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const serverRoot = path.resolve(__dirname, '..', '..');

    // Spawn a detached process that waits for us to die, then rebuilds and restarts
    const logFile = path.resolve(serverRoot, 'server.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(
      'bash',
      ['-c', `sleep 1 && npm run build 2>&1 && npm run start 2>&1`],
      {
        cwd: serverRoot,
        detached: true,
        stdio: ['ignore', out, out],
      },
    );
    child.unref();

    // Give the response time to flush, then exit
    setTimeout(() => process.exit(0), 200);
  });

  // --- Internal: tool calls from agent containers ---

  addRoute('POST', '/api/v1/internal/tool-call', async (req, res) => {
    const body = await parseJson(req);
    const { tool, agent_id, run_id, args } = body as {
      tool: string;
      agent_id: string;
      run_id: string;
      args: Record<string, unknown>;
    };

    if (!tool || !agent_id || !run_id) {
      sendJson(res, 400, { error: 'Missing tool, agent_id, or run_id' });
      return;
    }

    // Enforce tool_allowlist: if the agent has one, reject unlisted tools
    const callingAgent = getAgentById(agent_id);
    if (callingAgent?.tool_allowlist) {
      const allowed: string[] = JSON.parse(callingAgent.tool_allowlist);
      if (!allowed.includes(tool)) {
        sendJson(res, 200, {
          success: false,
          error: `Tool '${tool}' is not in your allowlist. Permitted tools: ${allowed.join(', ')}`,
        });
        return;
      }
    }

    try {
      let result: unknown;
      switch (tool) {
        case 'sharedspace_read':
          result = sharedspaceRead(agent_id, args.page_id as string, run_id);
          break;
        case 'sharedspace_write':
          result = sharedspaceWrite(
            agent_id,
            args.page_id as string,
            args.content as {
              summary: string;
              body: string;
              owner?: string;
              access?: string | string[];
            },
            run_id,
          );
          break;
        case 'sharedspace_list':
          result = sharedspaceList(
            agent_id,
            run_id,
            args.prefix as string | undefined,
          );
          break;
        case 'send_message':
          result = sendMessage(
            agent_id,
            args as { to: string; subject: string; body: string },
            run_id,
          );
          break;
        case 'request_hitl':
          result = requestHitl(
            agent_id,
            args as {
              type: 'approval' | 'choice' | 'fyi';
              subject: string;
              context: string;
              options?: string[];
              preference?: number;
            },
            run_id,
          );
          break;
        case 'task_complete':
          result = taskComplete(
            agent_id,
            run_id,
            args.message as string | undefined,
          );
          break;
        default:
          sendJson(res, 400, { error: `Unknown tool: ${tool}` });
          return;
      }
      sendJson(res, 200, result as Record<string, unknown>);
    } catch (err) {
      logger.error({ tool, agent_id, err }, 'Internal tool-call failed');
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// --- Helpers ---

function formatHitlCard(card: HitlCardRow): Record<string, unknown> {
  const agent = getAgentById(card.agent_id);
  return {
    card_id: card.card_id,
    card_type: card.card_type,
    agent_id: card.agent_id,
    agent_name: agent?.agent_name || card.agent_id,
    agent_title: agent?.agent_title || '',
    agent_path: getAgentPath(card.agent_id),
    subject: card.subject,
    context: card.context,
    options: card.options ? JSON.parse(card.options) : null,
    preference: card.preference,
    run_id: card.run_id,
    created_ts: card.created_ts,
  };
}

function getValidResolutions(cardType: string): string[] {
  switch (cardType) {
    case 'approval':
    case 'circuit_breaker':
      return ['approved', 'rejected', 'returned'];
    case 'choice':
      return ['option_selected', 'returned'];
    case 'fyi':
      return ['acknowledged'];
    default:
      return [];
  }
}

// --- Server startup ---

let server: http.Server | null = null;

export function startDashboardServer(port: number): http.Server {
  // Initialize web push (generates VAPID keys on first run)
  initWebPush();
  setupRoutes();

  // Wire up broadcast
  setBroadcastFn(wsBroadcast);
  setDebugBroadcastFn(wsBroadcastDebug);

  server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      const match = matchRoute(req.method || 'GET', pathname);
      if (match) {
        await match.handler(req, res, match.params);
      } else {
        sendError(
          res,
          404,
          'not_found',
          `No route for ${req.method} ${pathname}`,
        );
      }
    } catch (err) {
      logger.error({ err, path: pathname }, 'REST handler error');
      sendError(res, 500, 'internal_error', 'Internal server error');
    }
  });

  // WebSocket server — shares the HTTP server via 'upgrade'
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send connection.ready then connection.state — no events interleaved
    wsSendEvent(ws, 'connection.ready', { server_version: '0.1.0' });
    wsSendEvent(ws, 'connection.state', buildConnectionState());

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          agent_id?: string;
        };
        if (msg.type === 'debug.subscribe' && msg.agent_id) {
          getDebugSubs(ws).add(msg.agent_id);
          // Track globally so the credential proxy knows to capture
          addDebugAgent(msg.agent_id);
          logger.debug({ agent_id: msg.agent_id }, 'Debug subscribed');
        } else if (msg.type === 'debug.unsubscribe' && msg.agent_id) {
          getDebugSubs(ws).delete(msg.agent_id);
          // Only remove from global state if no other clients are subscribed
          let otherSubscribers = false;
          for (const [client, subs] of debugSubscriptions) {
            if (client !== ws && subs.has(msg.agent_id)) {
              otherSubscribers = true;
              break;
            }
          }
          if (!otherSubscribers) {
            removeDebugAgent(msg.agent_id);
          }
          logger.debug({ agent_id: msg.agent_id }, 'Debug unsubscribed');
        }
      } catch {
        // Ignore malformed messages
      }
    });

    const cleanupClient = () => {
      // Remove debug subscriptions; clean up global debug state
      const subs = debugSubscriptions.get(ws);
      if (subs) {
        for (const agentId of subs) {
          let otherSubscribers = false;
          for (const [client, clientSubs] of debugSubscriptions) {
            if (client !== ws && clientSubs.has(agentId)) {
              otherSubscribers = true;
              break;
            }
          }
          if (!otherSubscribers) {
            removeDebugAgent(agentId);
          }
        }
      }
      clients.delete(ws);
      debugSubscriptions.delete(ws);
    };

    ws.on('close', cleanupClient);
    ws.on('error', cleanupClient);
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Octopus Boardroom API started');
  });

  return server;
}

export function stopDashboardServer(): void {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  for (const client of clients) {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
}

// --- Channel self-registration ---

import { registerChannel } from './registry.js';
import type { Channel } from '../types.js';

const DASHBOARD_PORT = parseInt(process.env.NANOCLAW_PORT || '3000', 10);

registerChannel('dashboard', (_opts) => {
  const channel: Channel = {
    name: 'dashboard',
    async connect() {
      startDashboardServer(DASHBOARD_PORT);
    },
    async sendMessage(_jid: string, _text: string) {
      // Dashboard doesn't send messages via JID — events go over WebSocket
    },
    isConnected() {
      return server !== null;
    },
    ownsJid(_jid: string) {
      // Dashboard doesn't own any JIDs — it's a local API server
      return false;
    },
    async disconnect() {
      stopDashboardServer();
    },
  };
  return channel;
});
