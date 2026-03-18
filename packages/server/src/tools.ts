/**
 * Octopus Agent Tools
 *
 * Tools available to agents running in containers:
 * - sharedspace_read(id)
 * - sharedspace_write(id, content)
 * - sharedspace_list(prefix?)
 * - send_message(to, subject, body)
 * - request_hitl(type, subject, context, options?, preference?)
 */
import {
  appendActivityEntry,
  getAgentById,
  getAgentPath,
  getSharedSpacePage,
  getAllSharedSpacePages,
  getTopLevelBranch,
  insertCrossBranchMessage,
  insertHitlCard,
  insertInboxMessage,
  upsertSharedSpacePage,
  type SharedSpacePageRow,
} from './db.js';
import {
  broadcast,
  checkCircuitBreaker,
  generateId,
  getToolCategory,
} from './container-runner.js';
import {
  canRead,
  canWrite,
  invalidateIndicesForPageOwner,
} from './sharedspace.js';

// --- Activity recording ---

function recordToolCall(
  agentId: string,
  runId: string,
  toolName: string,
  detail: string,
): string {
  const entryId = generateId('entry');
  const category = getToolCategory(toolName);
  const ts = Date.now();

  appendActivityEntry({
    ts,
    agent_id: agentId,
    run_id: runId,
    entry_id: entryId,
    entry_type: 'tool_call',
    tool_name: toolName,
    tool_category: category,
    detail: detail.slice(0, 200),
    outcome: null,
  });

  broadcast('agent.run.activity', {
    agent_id: agentId,
    run_id: runId,
    entry_id: entryId,
    entry_type: 'tool_call',
    tool_name: toolName,
    tool_category: category,
    detail: detail.slice(0, 200),
    outcome: null,
  });

  return entryId;
}

function recordToolResult(
  agentId: string,
  runId: string,
  entryId: string,
  toolName: string,
  detail: string,
  outcome: string,
): void {
  const category = getToolCategory(toolName);
  const ts = Date.now();

  appendActivityEntry({
    ts,
    agent_id: agentId,
    run_id: runId,
    entry_id: entryId,
    entry_type: 'tool_result',
    tool_name: toolName,
    tool_category: category,
    detail: detail.slice(0, 200),
    outcome,
  });

  broadcast('agent.run.activity', {
    agent_id: agentId,
    run_id: runId,
    entry_id: entryId,
    entry_type: 'tool_result',
    tool_name: toolName,
    tool_category: category,
    detail: detail.slice(0, 200),
    outcome,
  });
}

// --- SharedSpace tools ---

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function sharedspaceRead(
  agentId: string,
  pageId: string,
  runId: string,
): ToolResult {
  const entryId = recordToolCall(
    agentId,
    runId,
    'sharedspace_read',
    `id: ${pageId}`,
  );

  const page = getSharedSpacePage(pageId);
  if (!page) {
    recordToolResult(
      agentId,
      runId,
      entryId,
      'sharedspace_read',
      `id: ${pageId}`,
      'Page not found',
    );
    return { success: false, error: `Page '${pageId}' not found` };
  }
  if (!canRead(agentId, page)) {
    recordToolResult(
      agentId,
      runId,
      entryId,
      'sharedspace_read',
      `id: ${pageId}`,
      'Access denied',
    );
    return {
      success: false,
      error: `Access denied: cannot read page '${pageId}'`,
    };
  }

  recordToolResult(
    agentId,
    runId,
    entryId,
    'sharedspace_read',
    `id: ${pageId}`,
    `Page retrieved (${page.body.length} chars)`,
  );

  // Check circuit breaker
  checkCircuitBreaker(agentId, runId);

  return {
    success: true,
    data: {
      page_id: page.page_id,
      title: page.title,
      summary: page.summary,
      owner_agent_id: page.owner_agent_id,
      body: page.body,
    },
  };
}

export function sharedspaceWrite(
  agentId: string,
  pageId: string,
  content: {
    title: string;
    summary: string;
    body: string;
    owner_agent_id?: string;
  },
  runId: string,
): ToolResult {
  const entryId = recordToolCall(
    agentId,
    runId,
    'sharedspace_write',
    `id: ${pageId}, title: ${content.title}`,
  );

  const existing = getSharedSpacePage(pageId);

  if (existing) {
    if (!canWrite(agentId, existing)) {
      recordToolResult(
        agentId,
        runId,
        entryId,
        'sharedspace_write',
        `id: ${pageId}`,
        'Access denied',
      );
      return {
        success: false,
        error: `Access denied: cannot write page '${pageId}'`,
      };
    }
  }

  const ownerAgentId = existing
    ? existing.owner_agent_id
    : content.owner_agent_id || agentId;

  const { created } = upsertSharedSpacePage(
    pageId,
    content.title,
    content.summary,
    ownerAgentId,
    agentId,
    content.body,
  );

  // Invalidate cached indices for all agents whose readable scope includes this page
  invalidateIndicesForPageOwner(ownerAgentId);

  const lastSlash = pageId.lastIndexOf('/');
  broadcast('sharedspace.page.updated', {
    page_id: pageId,
    title: content.title,
    summary: content.summary,
    owner_agent_id: ownerAgentId,
    updated_by_agent_id: agentId,
    operation: created ? 'created' : 'updated',
    parent_id: lastSlash > 0 ? pageId.slice(0, lastSlash) : null,
    depth: pageId.split('/').length - 1,
  });

  const outcome = created ? 'Page created' : 'Page updated';
  recordToolResult(
    agentId,
    runId,
    entryId,
    'sharedspace_write',
    `id: ${pageId}`,
    outcome,
  );
  checkCircuitBreaker(agentId, runId);

  return {
    success: true,
    data: { page_id: pageId, operation: created ? 'created' : 'updated' },
  };
}

export function sharedspaceList(
  agentId: string,
  runId: string,
  prefix?: string,
): ToolResult {
  const entryId = recordToolCall(
    agentId,
    runId,
    'sharedspace_list',
    prefix ? `prefix: ${prefix}` : '(all)',
  );

  const allPages = getAllSharedSpacePages();
  const readable = allPages.filter((p) => canRead(agentId, p));
  const filtered = prefix
    ? readable.filter((p) => p.page_id.startsWith(prefix))
    : readable;

  recordToolResult(
    agentId,
    runId,
    entryId,
    'sharedspace_list',
    prefix || '(all)',
    `${filtered.length} pages`,
  );
  checkCircuitBreaker(agentId, runId);

  return {
    success: true,
    data: filtered.map((p) => ({
      page_id: p.page_id,
      title: p.title,
      summary: p.summary,
      owner_agent_id: p.owner_agent_id,
    })),
  };
}

// --- send_message tool ---

export interface SendMessageArgs {
  to: string;
  subject: string;
  body: string;
}

export interface SendMessageResult {
  delivered: boolean;
  queued_for_ceo: boolean;
  message_id: string;
}

/**
 * Send a message from one agent to another.
 * Same-branch: deliver directly to inbox.
 * Cross-branch: queue for CEO review.
 *
 * Returns an object indicating whether the message was delivered directly
 * or queued for CEO review. The caller (container-runner) is responsible
 * for terminating the container on cross-branch sends.
 */
export function sendMessage(
  senderAgentId: string,
  args: SendMessageArgs,
  runId: string,
  messageArray?: string,
): SendMessageResult {
  const entryId = recordToolCall(
    senderAgentId,
    runId,
    'send_message',
    `to: ${args.to}, subject: ${args.subject}`,
  );

  const sender = getAgentById(senderAgentId);
  const recipient = getAgentById(args.to);

  if (!recipient) {
    throw new Error(`Recipient agent '${args.to}' not found`);
  }
  if (!sender) {
    throw new Error(`Sender agent '${senderAgentId}' not found`);
  }

  const senderBranch = getTopLevelBranch(senderAgentId);
  const recipientBranch = getTopLevelBranch(args.to);

  const isSameBranch =
    senderBranch &&
    recipientBranch &&
    senderBranch.agent_id === recipientBranch.agent_id;

  const messageId = generateId('msg');

  if (isSameBranch) {
    // Same-branch: deliver directly
    insertInboxMessage({
      message_id: messageId,
      recipient_agent_id: args.to,
      from_agent_id: senderAgentId,
      from_agent_name: sender.agent_name,
      subject: args.subject,
      body: args.body,
      cross_branch: 0,
      delivered_ts: Date.now(),
    });

    broadcast('inbox.message.delivered', {
      recipient_agent_id: args.to,
      message_id: messageId,
      from_agent_id: senderAgentId,
      from_agent_name: sender.agent_name,
      subject: args.subject,
      cross_branch: false,
    });

    recordToolResult(
      senderAgentId,
      runId,
      entryId,
      'send_message',
      `to: ${args.to}`,
      'Delivered directly',
    );
    checkCircuitBreaker(senderAgentId, runId);
    return { delivered: true, queued_for_ceo: false, message_id: messageId };
  } else {
    // Cross-branch: queue for CEO
    const xbMsgId = generateId('xbmsg');
    insertCrossBranchMessage({
      message_id: xbMsgId,
      sender_agent_id: senderAgentId,
      recipient_agent_id: args.to,
      subject: args.subject,
      body: args.body,
      run_id: runId,
      message_array: messageArray || null,
      arrived_ts: Date.now(),
    });

    const senderPath = getAgentPath(senderAgentId);
    const recipientPath = getAgentPath(args.to);

    broadcast('crossbranch.message.arrived', {
      message_id: xbMsgId,
      from_agent_id: senderAgentId,
      from_agent_name: sender.agent_name,
      from_agent_path: senderPath,
      to_agent_id: args.to,
      to_agent_name: recipient.agent_name,
      to_agent_path: recipientPath,
      subject: args.subject,
      body: args.body,
      run_id: runId,
    });

    recordToolResult(
      senderAgentId,
      runId,
      entryId,
      'send_message',
      `to: ${args.to}`,
      'Queued for CEO (cross-branch)',
    );
    return { delivered: false, queued_for_ceo: true, message_id: xbMsgId };
  }
}

// --- request_hitl tool ---

export interface RequestHitlArgs {
  type: 'approval' | 'choice' | 'fyi';
  subject: string;
  context: string;
  options?: string[];
  preference?: number;
}

/**
 * Request human-in-the-loop input from the CEO.
 *
 * For approval and choice cards: the caller must serialize the message array
 * and terminate the container.
 * For fyi cards: non-blocking, container continues.
 *
 * Returns the card_id and whether the container should terminate.
 */
export function requestHitl(
  agentId: string,
  args: RequestHitlArgs,
  runId: string,
  messageArray?: string,
): { card_id: string; should_terminate: boolean } {
  const entryId = recordToolCall(
    agentId,
    runId,
    'request_hitl',
    `type: ${args.type}, subject: ${args.subject}`,
  );

  const agent = getAgentById(agentId);
  const cardId = generateId('card');

  const shouldTerminate = args.type === 'approval' || args.type === 'choice';

  insertHitlCard({
    card_id: cardId,
    card_type: args.type,
    agent_id: agentId,
    subject: args.subject,
    context: args.context,
    options: args.options ? JSON.stringify(args.options) : null,
    preference: args.preference ?? null,
    run_id: runId,
    message_array: shouldTerminate ? messageArray || null : null,
    created_ts: Date.now(),
  });

  broadcast('hitl.card.created', {
    card_id: cardId,
    card_type: args.type,
    agent_id: agentId,
    agent_name: agent?.agent_name || agentId,
    agent_path: getAgentPath(agentId),
    subject: args.subject,
    context: args.context,
    options: args.options || null,
    preference: args.preference ?? null,
    run_id: runId,
  });

  recordToolResult(
    agentId,
    runId,
    entryId,
    'request_hitl',
    `type: ${args.type}`,
    `Card ${cardId} created`,
  );

  return { card_id: cardId, should_terminate: shouldTerminate };
}
