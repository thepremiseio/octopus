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
  resolveAgent,
  getOrCreateActiveConversation,
  getAgentPath,
  getTopLevelBranch,
  insertCrossBranchMessage,
  insertHitlCard,
  insertInboxMessage,
} from './db.js';
import {
  broadcast,
  checkCircuitBreaker,
  generateId,
  getToolCategory,
  setTaskComplete,
  triggerAgentRun,
} from './container-runner.js';
import {
  readPage,
  writePage,
  listPages,
  AccessDeniedError,
  ParentNotFoundError,
} from './sharedspace.js';

// --- Activity recording ---

function recordToolCall(
  agentId: string,
  runId: string,
  toolName: string,
  detail: string,
  fullDetail?: string,
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
    full_detail: fullDetail ?? null,
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
    full_detail: fullDetail ?? null,
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
  fullDetail?: string,
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
    full_detail: fullDetail ?? null,
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
    full_detail: fullDetail ?? null,
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

  try {
    const page = readPage(pageId, agentId);
    recordToolResult(
      agentId,
      runId,
      entryId,
      'sharedspace_read',
      `id: ${pageId}`,
      `Page retrieved (${page.body.length} chars)`,
    );
    checkCircuitBreaker(agentId, runId);
    return {
      success: true,
      data: {
        page_id: page.page_id,
        owner: page.owner,
        access: page.access,
        summary: page.summary,
        updated: page.updated,
        body: page.body,
      },
    };
  } catch (err) {
    const msg =
      err instanceof AccessDeniedError
        ? err.message
        : `Error reading page '${pageId}'`;
    recordToolResult(
      agentId,
      runId,
      entryId,
      'sharedspace_read',
      `id: ${pageId}`,
      msg,
    );
    return { success: false, error: msg };
  }
}

export function sharedspaceWrite(
  agentId: string,
  pageId: string,
  content: {
    summary: string;
    body: string;
    owner?: string;
    access?: string | string[];
  },
  runId: string,
): ToolResult {
  const entryId = recordToolCall(
    agentId,
    runId,
    'sharedspace_write',
    `id: ${pageId}`,
    `Page: ${pageId}\nSummary: ${content.summary}\n\n${content.body}`,
  );

  try {
    // Check if page exists before write to determine operation
    let isCreate: boolean;
    try {
      readPage(pageId, 'ceo');
      isCreate = false;
    } catch {
      isCreate = true;
    }

    const page = writePage(
      pageId,
      {
        summary: content.summary,
        body: content.body,
        owner: content.owner || getAgentById(agentId)?.agent_name || agentId,
        access: content.access as import('./sharedspace.js').AccessLevel,
      },
      agentId,
    );

    const operation = isCreate ? 'created' : 'updated';
    const outcome = `Page ${operation}`;
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
      data: { page_id: page.page_id, owner: page.owner, operation },
    };
  } catch (err) {
    const msg =
      err instanceof AccessDeniedError || err instanceof ParentNotFoundError
        ? err.message
        : `Error writing page '${pageId}'`;
    recordToolResult(
      agentId,
      runId,
      entryId,
      'sharedspace_write',
      `id: ${pageId}`,
      msg,
    );
    return { success: false, error: msg };
  }
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

  const pages = listPages(prefix, agentId);

  recordToolResult(
    agentId,
    runId,
    entryId,
    'sharedspace_list',
    prefix || '(all)',
    `${pages.length} pages`,
  );
  checkCircuitBreaker(agentId, runId);

  return {
    success: true,
    data: pages.map((p) => ({
      page_id: p.page_id,
      summary: p.summary,
      owner: p.owner,
      access: p.access,
      updated: p.updated,
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
    `To: ${args.to}\nSubject: ${args.subject}\n\n${args.body}`,
  );

  const sender = getAgentById(senderAgentId);
  const recipient = resolveAgent(args.to);

  if (!recipient) {
    throw new Error(`Recipient agent '${args.to}' not found`);
  }
  if (!sender) {
    throw new Error(`Sender agent '${senderAgentId}' not found`);
  }

  // Normalize to the resolved agent_id for all downstream operations
  const recipientId = recipient.agent_id;

  const senderBranch = getTopLevelBranch(senderAgentId);
  const recipientBranch = getTopLevelBranch(recipientId);

  const isSameBranch =
    senderBranch &&
    recipientBranch &&
    senderBranch.agent_id === recipientBranch.agent_id;

  // cross_branch_trusted agents bypass the CEO queue for cross-branch messages
  // (either the sender OR the recipient being trusted is sufficient)
  const isTrusted =
    sender.cross_branch_trusted === 1 ||
    recipient.cross_branch_trusted === 1;

  const messageId = generateId('msg');

  if (isSameBranch || isTrusted) {
    // Same-branch or trusted cross-branch: deliver directly
    const isCrossBranch = !isSameBranch;
    insertInboxMessage({
      message_id: messageId,
      recipient_agent_id: recipientId,
      from_agent_id: senderAgentId,
      from_agent_name: sender.agent_name,
      subject: args.subject,
      body: args.body,
      cross_branch: isCrossBranch ? 1 : 0,
      delivered_ts: Date.now(),
    });

    broadcast('inbox.message.delivered', {
      recipient_agent_id: recipientId,
      message_id: messageId,
      from_agent_id: senderAgentId,
      from_agent_name: sender.agent_name,
      subject: args.subject,
      cross_branch: isCrossBranch,
    });

    // Trigger recipient agent run with the inbox message as context
    const conv = getOrCreateActiveConversation(recipientId, () =>
      generateId('conv'),
    );
    const triggerMessage = `[Inbox message from ${sender.agent_name}]\nSubject: ${args.subject}\n\n${args.body}`;
    triggerAgentRun(recipientId, conv.conversation_id, triggerMessage);

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
      recipient_agent_id: recipientId,
      subject: args.subject,
      body: args.body,
      run_id: runId,
      message_array: messageArray || null,
      arrived_ts: Date.now(),
    });

    const senderPath = getAgentPath(senderAgentId);
    const recipientPath = getAgentPath(recipientId);

    broadcast('crossbranch.message.arrived', {
      message_id: xbMsgId,
      from_agent_id: senderAgentId,
      from_agent_name: sender.agent_name,
      from_agent_title: sender.agent_title,
      from_agent_path: senderPath,
      to_agent_id: recipientId,
      to_agent_name: recipient.agent_name,
      to_agent_title: recipient.agent_title,
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

// --- task_complete tool ---

export interface TaskCompleteResult {
  success: boolean;
  message?: string;
}

/**
 * Signal that the agent's work is complete.
 * If `message` is provided and non-empty, it will be routed to CEO chat.
 * If absent or empty, the invocation ends silently.
 *
 * The runner tracks this per-run and uses it to decide whether to route
 * the agent's final text output to CEO chat.
 */
export function taskComplete(
  agentId: string,
  runId: string,
  message?: string,
): TaskCompleteResult {
  const entryId = recordToolCall(
    agentId,
    runId,
    'task_complete',
    message ? `message: ${message.slice(0, 100)}` : '(silent)',
    message || undefined,
  );

  recordToolResult(
    agentId,
    runId,
    entryId,
    'task_complete',
    message ? 'Completing with message' : 'Completing silently',
    'Invocation ended',
  );

  // Record in per-run state so the runner can intercept final output
  setTaskComplete(runId, message);

  return {
    success: true,
    message: message || undefined,
  };
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
    `Type: ${args.type}\nSubject: ${args.subject}\n\n${args.context}${args.options ? '\n\nOptions:\n' + args.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n') : ''}${args.preference !== undefined ? `\n\nAgent preference: option ${(args.preference ?? 0) + 1}` : ''}`,
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
    agent_title: agent?.agent_title || '',
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
