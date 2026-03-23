/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  NANOCLAW_PORT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { ensureCachedIndex } from './sharedspace.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  addDailyTokenUsage,
  appendActivityEntry,
  completeAgentRun,
  createAgentRun,
  getActionCountInWindow,
  getAgentById,
  getAgentPath,
  getAncestryChain,
  getDailyTokenUsage,
  getDirectChildren,
  getUnreadInboxMessages,
  insertHitlCard,
  markInboxMessagesRead,
  pruneOldRuns,
  updateAgentStatus,
  type AgentRow,
} from './db.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// --- Octopus: Event broadcast ---

export type OctopusEvent = {
  v: 1;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
};

type BroadcastFn = (event: OctopusEvent) => void;
let broadcastFn: BroadcastFn = () => {};

export function setBroadcastFn(fn: BroadcastFn): void {
  broadcastFn = fn;
}

// Debug broadcast: sends events only to clients subscribed to a specific agent
type DebugBroadcastFn = (agentId: string, event: OctopusEvent) => void;
let debugBroadcastFn: DebugBroadcastFn = () => {};

export function setDebugBroadcastFn(fn: DebugBroadcastFn): void {
  debugBroadcastFn = fn;
}

export function broadcastDebug(
  agentId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  debugBroadcastFn(agentId, { v: 1, type, ts: Date.now(), payload });
}

// --- Octopus: Agent run trigger ---

type RunAgentFn = (
  agentId: string,
  conversationId: string,
  message: string,
) => void;
let runAgentFn: RunAgentFn = () => {};

export function setRunAgentFn(fn: RunAgentFn): void {
  runAgentFn = fn;
}

export function triggerAgentRun(
  agentId: string,
  conversationId: string,
  message: string,
): void {
  runAgentFn(agentId, conversationId, message);
}

// --- Octopus: One-shot run completion listeners ---

const runCompletionListeners = new Map<string, Array<() => void>>();

/** Register a one-shot listener that fires when the next run for this agent completes. */
export function onceRunCompleted(agentId: string): Promise<void> {
  return new Promise((resolve) => {
    const arr = runCompletionListeners.get(agentId) || [];
    arr.push(resolve);
    runCompletionListeners.set(agentId, arr);
  });
}

/** Called internally when a run completes to fire pending listeners. */
export function notifyRunCompleted(agentId: string): void {
  const arr = runCompletionListeners.get(agentId);
  if (arr) {
    runCompletionListeners.delete(agentId);
    for (const cb of arr) cb();
  }
}

export function broadcast(
  type: string,
  payload: Record<string, unknown>,
): void {
  broadcastFn({ v: 1, type, ts: Date.now(), payload });
}

// --- Octopus: Configuration ---

const CIRCUIT_BREAKER_WINDOW_MS = parseInt(
  process.env.CIRCUIT_BREAKER_WINDOW_MS || '300000',
  10,
); // 5 min default
const CIRCUIT_BREAKER_THRESHOLD = parseInt(
  process.env.CIRCUIT_BREAKER_THRESHOLD || '50',
  10,
);
const DEFAULT_DAILY_TOKEN_BUDGET = parseInt(
  process.env.DEFAULT_DAILY_TOKEN_BUDGET || '0',
  10,
); // 0 = no limit

// --- Octopus: ID generation ---

let idCounter = 0;
export function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}${rand}${(idCounter++).toString(36)}`;
}

// --- Octopus: Budget check ---

export function checkDailyBudget(
  agentId: string,
  triggerType: string,
  budgetTokens?: number,
): boolean {
  const budget = budgetTokens || DEFAULT_DAILY_TOKEN_BUDGET;
  if (budget <= 0) return true; // No budget configured
  const used = getDailyTokenUsage(agentId);
  if (used >= budget) {
    broadcast('agent.budget.exceeded', {
      agent_id: agentId,
      budget_tokens: budget,
      used_tokens: used,
      period: 'daily',
      blocked_trigger_type: triggerType,
    });
    updateAgentStatus(agentId, 'alert');
    broadcast('agent.status.changed', {
      agent_id: agentId,
      status: 'alert',
      previous_status: 'idle',
    });
    return false;
  }
  return true;
}

// --- Octopus: Circuit breaker check ---

export function checkCircuitBreaker(agentId: string, runId: string): boolean {
  const count = getActionCountInWindow(agentId, CIRCUIT_BREAKER_WINDOW_MS);
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    const agent = getAgentById(agentId);
    updateAgentStatus(agentId, 'circuit-breaker');
    broadcast('agent.budget.circuit_breaker', {
      agent_id: agentId,
      run_id: runId,
      action_count: count,
      window_seconds: Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000),
      threshold: CIRCUIT_BREAKER_THRESHOLD,
    });

    // Write circuit_breaker HITL card
    const cardId = generateId('card');
    insertHitlCard({
      card_id: cardId,
      card_type: 'circuit_breaker',
      agent_id: agentId,
      subject: `Circuit breaker tripped: ${count} actions in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}s`,
      context: `Agent '${agent?.agent_name || agentId}' exceeded the action threshold of ${CIRCUIT_BREAKER_THRESHOLD} actions within a ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}-second sliding window. Current action count: ${count}. The agent has been paused.`,
      options: null,
      preference: null,
      run_id: runId,
      message_array: null, // Will be set by caller if needed
      created_ts: Date.now(),
    });

    broadcast('hitl.card.created', {
      card_id: cardId,
      card_type: 'circuit_breaker',
      agent_id: agentId,
      agent_name: agent?.agent_name || agentId,
      agent_title: agent?.agent_title || '',
      agent_path: getAgentPath(agentId),
      subject: `Circuit breaker tripped: ${count} actions in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}s`,
      context: `Agent exceeded ${CIRCUIT_BREAKER_THRESHOLD} actions within sliding window.`,
      options: null,
      preference: null,
      run_id: runId,
    });

    return true; // breaker tripped
  }
  return false;
}

// --- Octopus: task_complete state tracking ---

// Tracks runs where task_complete was called.
// Value is the message (if any) or empty string for silent completion.
const taskCompleteState = new Map<string, string>();

export function setTaskComplete(runId: string, message?: string): void {
  taskCompleteState.set(runId, message || '');
}

/**
 * Returns the task_complete state for a run.
 * - undefined: task_complete was NOT called
 * - '': task_complete was called with no message (silent)
 * - non-empty string: task_complete was called with a message
 */
export function getTaskComplete(runId: string): string | undefined {
  return taskCompleteState.get(runId);
}

export function clearTaskComplete(runId: string): void {
  taskCompleteState.delete(runId);
}

// --- Octopus: Tool category mapping ---

export function getToolCategory(toolName: string): string {
  switch (toolName) {
    case 'sharedspace_read':
    case 'sharedspace_list':
      return 'read';
    case 'sharedspace_write':
      return 'write';
    case 'request_hitl':
    case 'task_complete':
      return 'hitl';
    case 'send_message':
      return 'message';
    default:
      return 'shell';
  }
}

// --- Octopus: Boilerplate generation (single source of truth) ---

/**
 * Build the auto-generated boilerplate for an agent.
 * This is the canonical copy — every call site that needs boilerplate
 * should call this function rather than duplicating the text.
 */
export function generateBoilerplate(agentId: string): string {
  const agent = getAgentById(agentId);
  if (!agent) return '';

  const ancestry = getAncestryChain(agentId);
  const parent = ancestry.length > 1 ? ancestry[ancestry.length - 2] : null;
  const children = getDirectChildren(agentId);

  let bp = `Your name is ${agent.agent_name}. Your role is ${agent.agent_title}.\n\n`;

  // Position
  bp += '## Position\n\n';
  if (parent) {
    bp += `You report to ${parent.agent_name} (${parent.agent_title}).\n`;
  } else {
    bp += 'You report directly to the CEO.\n';
  }
  bp += `Your position in the hierarchy: ${ancestry.map((a) => a.agent_name).join(' → ')}\n`;
  if (children.length > 0) {
    bp += `Direct reports: ${children.map((c) => `${c.agent_name} (${c.agent_title})`).join(', ')}\n`;
  }

  // Instructions
  bp += '\n## Instructions\n\n';
  bp +=
    '- **Escalation:** If you hit a decision you cannot make alone, escalate to your manager.\n';
  bp += '- **Inbox:** Process unread inbox messages before your main task.\n';
  bp +=
    '- **Approvals:** See SharedSpace approval policy for when approval is required.\n';
  bp +=
    '- **Ending your invocation:** Always call `task_complete` when your work is done. If you sent a message to another agent, updated SharedSpace, or completed a task with no CEO-facing output, call `task_complete()` with no argument. Only pass a message if there is something the CEO genuinely needs to see or act on.\n';

  // Available Tools
  bp += '\n## Available Tools\n\n';
  bp += '- `sharedspace_read(id)` — Read a SharedSpace page\n';
  bp += '- `sharedspace_write(id, content)` — Write a SharedSpace page\n';
  bp += '- `sharedspace_list(prefix?)` — List SharedSpace pages\n';
  bp +=
    '- `send_message(to, subject, body)` — Send a message to another agent\n';
  bp +=
    '- `request_hitl(type, subject, context, options?, preference?)` — Request CEO input\n';
  bp +=
    '- `task_complete(message?)` — Call when your work is complete. Pass `message` if the CEO needs to see an outcome; omit it if your work was purely internal.\n';

  // SharedSpace usage guidance
  bp += '\n## SharedSpace\n\n';
  bp +=
    'SharedSpace is a shared knowledge layer — a wiki that agents read to build context ';
  bp +=
    'and write to when they produce information others will need. It is not a task list, ';
  bp += 'a scratchpad, or a communication channel.\n\n';

  bp += '**Write to SharedSpace when:**\n';
  bp +=
    '- You are recording something that another agent (or future you) will need to consult — an overview, a running log, a reference document\n';
  bp += '- The information is durable: it will still be relevant next week\n\n';

  bp += '**Do not write to SharedSpace when:**\n';
  bp +=
    '- The output is a one-time answer to a specific question — send it via message\n';
  bp +=
    '- You are noting something for your own reference — use your private storage\n';
  bp += '- The page would not be consulted again after this session\n\n';

  bp += '**Never put the following in SharedSpace:**\n';
  bp +=
    '- Actions, tasks, or next steps for the CEO — surface these via a HITL card or a chat message. The CEO does not read SharedSpace to find out what to do.\n';
  bp +=
    '- Recommendations waiting for a decision — those belong in a choice or approval card, not a page\n';
  bp +=
    '- Summaries of conversations you just had — that is private storage territory\n\n';

  bp += '**Page hygiene:**\n';
  bp +=
    '- Write summaries that answer "should I read this now?" — not "what is in here"\n';
  bp += '- Keep summaries under 160 characters\n';
  bp +=
    '- Update an existing page rather than creating a new one wherever possible\n';
  bp += '- Do not create a page hierarchy deeper than the task warrants\n';

  return bp;
}

// --- Octopus: Prompt assembly ---

export function assembleSystemPrompt(agentId: string): string {
  const agent = getAgentById(agentId);
  if (!agent) return '';

  // 1. Agent's CLAUDE.md content
  const agentDir = path.join(GROUPS_DIR, agent.agent_id);
  let claudeMd = '';
  const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  // 2. Auto-generated boilerplate
  let boilerplate = generateBoilerplate(agentId);

  // Inbox notification
  const unread = getUnreadInboxMessages(agentId);
  if (unread.length > 0) {
    boilerplate =
      `**📬 You have ${unread.length} unread inbox message(s). Process these before your main task.**\n\n` +
      boilerplate;
  }

  // 3. Cached SharedSpace index
  const ssIndex = ensureCachedIndex(agentId);

  const parts = [claudeMd, boilerplate];
  if (ssIndex) {
    parts.push('## SharedSpace Index\n\n' + ssIndex);
  }

  return parts.filter(Boolean).join('\n\n---\n\n');
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  singleRun?: boolean;
  runId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets).
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Octopus tools endpoint — the MCP server calls back to this URL.
  args.push(
    '-e',
    `OCTOPUS_HOST_URL=http://${CONTAINER_HOST_GATEWAY}:${NANOCLAW_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Inject boilerplate + SharedSpace index into CLAUDE.md for the container.
  // The CEO's original content is preserved above a marker; everything below
  // the marker is regenerated on each run.
  const BOILERPLATE_MARKER = '\n\n<!-- octopus:auto-generated -->\n';
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    let original = fs.readFileSync(claudeMdPath, 'utf-8');
    // Strip any previous auto-generated section
    const markerIdx = original.indexOf(BOILERPLATE_MARKER);
    if (markerIdx >= 0) {
      original = original.slice(0, markerIdx);
    }
    const agent = getAgentById(input.groupFolder);
    if (agent) {
      let boilerplate = generateBoilerplate(input.groupFolder);

      const unread = getUnreadInboxMessages(input.groupFolder);
      if (unread.length > 0) {
        boilerplate =
          `**📬 You have ${unread.length} unread inbox message(s). Process these before your main task.**\n\n` +
          boilerplate;
      }

      const ssIndex = ensureCachedIndex(input.groupFolder);
      const parts = [boilerplate];
      if (ssIndex) {
        parts.push('## SharedSpace Index\n\n' + ssIndex);
      }

      fs.writeFileSync(
        claudeMdPath,
        original + BOILERPLATE_MARKER + parts.join('\n\n'),
      );
    }
  }

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  // Mark agent as active and record run start
  const agentId = input.groupFolder;
  const runId = input.runId || generateId('run');
  const prevAgent = getAgentById(agentId);
  if (prevAgent && prevAgent.status !== 'active') {
    updateAgentStatus(agentId, 'active');
    broadcast('agent.status.changed', {
      agent_id: agentId,
      status: 'active',
      previous_status: prevAgent.status,
    });
  }
  createAgentRun(runId, agentId, 'conversation');
  pruneOldRuns(agentId, 10);
  broadcast('agent.run.started', {
    agent_id: agentId,
    run_id: runId,
    trigger_type: 'conversation',
    trigger_detail: null,
  });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Record run completion
      const exitReason =
        code === 0 ? 'completed' : timedOut ? 'timeout' : 'error';
      completeAgentRun(runId, exitReason, 0);
      broadcast('agent.run.completed', {
        agent_id: agentId,
        run_id: runId,
        exit_reason: exitReason,
        total_tokens: null,
      });

      // Mark agent as idle (unless circuit-breaker or alert set it otherwise)
      const curAgent = getAgentById(agentId);
      if (curAgent && curAgent.status === 'active') {
        updateAgentStatus(agentId, 'idle');
        broadcast('agent.status.changed', {
          agent_id: agentId,
          status: 'idle',
          previous_status: 'active',
        });
      }

      // Fire one-shot completion listeners (e.g. handover before deletion)
      notifyRunCompleted(agentId);

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
