import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    -- Octopus: Agent hierarchy
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      parent_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);

    -- Octopus: Daily token usage per agent
    CREATE TABLE IF NOT EXISTS daily_token_usage (
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, date),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );

    -- Octopus: Activity feed
    CREATE TABLE IF NOT EXISTS activity_feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_category TEXT NOT NULL,
      detail TEXT,
      outcome TEXT,
      full_detail TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_activity_agent_run ON activity_feed(agent_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_activity_agent_ts ON activity_feed(agent_id, ts);

    -- Octopus: Agent runs
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_detail TEXT,
      started_ts INTEGER NOT NULL,
      completed_ts INTEGER,
      exit_reason TEXT,
      total_tokens INTEGER DEFAULT 0,
      error_detail TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_id, started_ts);

    -- Octopus: SharedSpace pages
    CREATE TABLE IF NOT EXISTS sharedspace_pages (
      page_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_ts INTEGER NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ss_parent ON sharedspace_pages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_ss_owner ON sharedspace_pages(owner_agent_id);

    -- Octopus: Cached SharedSpace index per agent
    CREATE TABLE IF NOT EXISTS sharedspace_index_cache (
      agent_id TEXT PRIMARY KEY,
      index_text TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );

    -- Octopus: Cross-branch message queue
    CREATE TABLE IF NOT EXISTS cross_branch_queue (
      message_id TEXT PRIMARY KEY,
      sender_agent_id TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      run_id TEXT NOT NULL,
      message_array TEXT,
      arrived_ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (sender_agent_id) REFERENCES agents(agent_id),
      FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id)
    );

    -- Octopus: HITL queue
    CREATE TABLE IF NOT EXISTS hitl_queue (
      card_id TEXT PRIMARY KEY,
      card_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      context TEXT NOT NULL,
      options TEXT,
      preference INTEGER,
      run_id TEXT NOT NULL,
      message_array TEXT,
      resolution TEXT,
      selected_option INTEGER,
      note TEXT,
      created_ts INTEGER NOT NULL,
      resolved_ts INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hitl_agent ON hitl_queue(agent_id);

    -- Octopus: Conversations
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      started_ts INTEGER NOT NULL,
      last_message_ts INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id);

    -- Octopus: Conversation messages
    CREATE TABLE IF NOT EXISTS conversation_messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      run_id TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_convmsg_conv ON conversation_messages(conversation_id, ts);

    -- Octopus: Agent inbox messages
    CREATE TABLE IF NOT EXISTS inbox_messages (
      message_id TEXT PRIMARY KEY,
      recipient_agent_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      from_agent_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      cross_branch INTEGER NOT NULL DEFAULT 0,
      delivered_ts INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_recipient ON inbox_messages(recipient_agent_id, read);

    -- Octopus: LLM exchanges (debug inspector)
    CREATE TABLE IF NOT EXISTS llm_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      exchange_index INTEGER NOT NULL,
      messages_json TEXT NOT NULL,
      response_json TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_llm_exchanges_run ON llm_exchanges(run_id, exchange_index);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add full_detail column to activity_feed (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE activity_feed ADD COLUMN full_detail TEXT`,
    );
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

// --- Octopus: Agent hierarchy ---

export interface AgentRow {
  agent_id: string;
  agent_name: string;
  parent_id: string | null;
  depth: number;
  status: string;
  created_at: number;
}

/** Get full agent tree ordered depth-first */
export function getAgentTree(): AgentRow[] {
  // Build depth-first order using recursive CTE
  const rows = db
    .prepare(
      `WITH RECURSIVE tree AS (
        SELECT agent_id, agent_name, parent_id, depth, status, created_at, agent_name AS sort_path
        FROM agents WHERE parent_id IS NULL
        UNION ALL
        SELECT a.agent_id, a.agent_name, a.parent_id, a.depth, a.status, a.created_at,
               tree.sort_path || '/' || a.agent_name
        FROM agents a JOIN tree ON a.parent_id = tree.agent_id
      )
      SELECT agent_id, agent_name, parent_id, depth, status, created_at FROM tree ORDER BY sort_path`,
    )
    .all() as AgentRow[];
  return rows;
}

export function getAgentById(agentId: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as
    | AgentRow
    | undefined;
}

export function insertAgent(
  agentId: string,
  agentName: string,
  parentId: string | null,
): AgentRow {
  let depth = 0;
  if (parentId) {
    const parent = getAgentById(parentId);
    if (!parent) throw new Error(`Parent agent '${parentId}' not found`);
    depth = parent.depth + 1;
  }
  const now = Date.now();
  db.prepare(
    'INSERT INTO agents (agent_id, agent_name, parent_id, depth, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(agentId, agentName, parentId, depth, 'idle', now);
  return {
    agent_id: agentId,
    agent_name: agentName,
    parent_id: parentId,
    depth,
    status: 'idle',
    created_at: now,
  };
}

/** Delete an agent and its entire subtree. Returns all deleted agent IDs. */
export function deleteAgentSubtree(agentId: string): string[] {
  const descendants = getDescendants(agentId);
  const allIds = [...descendants.map((d) => d.agent_id), agentId];

  const deleteIn = db.transaction(() => {
    for (const id of allIds) {
      // Clean up related data
      db.prepare('DELETE FROM daily_token_usage WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM activity_feed WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM sharedspace_index_cache WHERE agent_id = ?').run(
        id,
      );
      db.prepare(
        'DELETE FROM cross_branch_queue WHERE sender_agent_id = ? OR recipient_agent_id = ?',
      ).run(id, id);
      db.prepare('DELETE FROM hitl_queue WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM conversation_messages WHERE agent_id = ?').run(
        id,
      );
      db.prepare('DELETE FROM conversations WHERE agent_id = ?').run(id);
      db.prepare(
        'DELETE FROM inbox_messages WHERE recipient_agent_id = ? OR from_agent_id = ?',
      ).run(id, id);
    }
    // Delete agents bottom-up to respect FK
    for (const id of allIds.reverse()) {
      db.prepare('DELETE FROM agents WHERE agent_id = ?').run(id);
    }
  });
  deleteIn();
  return allIds;
}

/** Get ancestry chain from root to this agent (inclusive) */
export function getAncestryChain(agentId: string): AgentRow[] {
  const chain: AgentRow[] = [];
  let current = getAgentById(agentId);
  while (current) {
    chain.unshift(current);
    current = current.parent_id ? getAgentById(current.parent_id) : undefined;
  }
  return chain;
}

/** Get all descendants of an agent (not including the agent itself) */
export function getDescendants(agentId: string): AgentRow[] {
  return db
    .prepare(
      `WITH RECURSIVE desc AS (
        SELECT agent_id, agent_name, parent_id, depth, status, created_at
        FROM agents WHERE parent_id = ?
        UNION ALL
        SELECT a.agent_id, a.agent_name, a.parent_id, a.depth, a.status, a.created_at
        FROM agents a JOIN desc ON a.parent_id = desc.agent_id
      )
      SELECT * FROM desc`,
    )
    .all(agentId) as AgentRow[];
}

/** Get direct children of an agent */
export function getDirectChildren(agentId: string): AgentRow[] {
  return db
    .prepare('SELECT * FROM agents WHERE parent_id = ?')
    .all(agentId) as AgentRow[];
}

export function updateAgentStatus(agentId: string, status: string): void {
  db.prepare('UPDATE agents SET status = ? WHERE agent_id = ?').run(
    status,
    agentId,
  );
}

/** Get the agent_path (display names from top-level to this agent) */
export function getAgentPath(agentId: string): string[] {
  return getAncestryChain(agentId).map((a) => a.agent_name);
}

/** Get the top-level branch agent for a given agent */
export function getTopLevelBranch(agentId: string): AgentRow | undefined {
  const chain = getAncestryChain(agentId);
  return chain.length > 0 ? chain[0] : undefined;
}

// --- Octopus: Token budget ---

export function getDailyTokenUsage(agentId: string, date?: string): number {
  const d = date || new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      'SELECT tokens_used FROM daily_token_usage WHERE agent_id = ? AND date = ?',
    )
    .get(agentId, d) as { tokens_used: number } | undefined;
  return row?.tokens_used || 0;
}

export function addDailyTokenUsage(
  agentId: string,
  tokens: number,
  date?: string,
): number {
  const d = date || new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO daily_token_usage (agent_id, date, tokens_used)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_id, date) DO UPDATE SET tokens_used = tokens_used + ?`,
  ).run(agentId, d, tokens, tokens);
  return getDailyTokenUsage(agentId, d);
}

export function resetDailyTokenUsage(agentId: string, date?: string): void {
  const d = date || new Date().toISOString().slice(0, 10);
  db.prepare(
    'DELETE FROM daily_token_usage WHERE agent_id = ? AND date = ?',
  ).run(agentId, d);
}

// --- Octopus: Activity feed ---

export interface ActivityEntry {
  id: number;
  ts: number;
  agent_id: string;
  run_id: string;
  entry_id: string;
  entry_type: string;
  tool_name: string;
  tool_category: string;
  detail: string | null;
  outcome: string | null;
  full_detail: string | null;
}

export function appendActivityEntry(entry: Omit<ActivityEntry, 'id'>): number {
  const result = db
    .prepare(
      `INSERT INTO activity_feed (ts, agent_id, run_id, entry_id, entry_type, tool_name, tool_category, detail, outcome, full_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.ts,
      entry.agent_id,
      entry.run_id,
      entry.entry_id,
      entry.entry_type,
      entry.tool_name,
      entry.tool_category,
      entry.detail,
      entry.outcome,
      entry.full_detail,
    );
  return result.lastInsertRowid as number;
}

export function getActivityForRun(
  agentId: string,
  runId: string,
): ActivityEntry[] {
  return db
    .prepare(
      'SELECT * FROM activity_feed WHERE agent_id = ? AND run_id = ? ORDER BY ts',
    )
    .all(agentId, runId) as ActivityEntry[];
}

/** Count actions in a sliding window for circuit breaker */
export function getActionCountInWindow(
  agentId: string,
  windowMs: number,
): number {
  const since = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM activity_feed
       WHERE agent_id = ? AND ts >= ? AND entry_type = 'tool_call'`,
    )
    .get(agentId, since) as { cnt: number };
  return row.cnt;
}

// --- Octopus: LLM exchanges (debug inspector) ---

export interface LlmExchangeRow {
  id: number;
  run_id: string;
  agent_id: string;
  exchange_index: number;
  messages_json: string;
  response_json: string | null;
  tokens_in: number;
  tokens_out: number;
  ts: number;
}

export function insertLlmExchange(entry: {
  run_id: string;
  agent_id: string;
  exchange_index: number;
  messages_json: string;
  response_json: string | null;
  tokens_in: number;
  tokens_out: number;
  ts: number;
}): number {
  const result = db
    .prepare(
      `INSERT INTO llm_exchanges (run_id, agent_id, exchange_index, messages_json, response_json, tokens_in, tokens_out, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.run_id,
      entry.agent_id,
      entry.exchange_index,
      entry.messages_json,
      entry.response_json,
      entry.tokens_in,
      entry.tokens_out,
      entry.ts,
    );
  return result.lastInsertRowid as number;
}

export function getLlmExchangesForRun(
  agentId: string,
  runId: string,
): LlmExchangeRow[] {
  return db
    .prepare(
      'SELECT * FROM llm_exchanges WHERE agent_id = ? AND run_id = ? ORDER BY exchange_index',
    )
    .all(agentId, runId) as LlmExchangeRow[];
}

// --- Octopus: Agent runs ---

export interface AgentRunRow {
  run_id: string;
  agent_id: string;
  trigger_type: string;
  trigger_detail: string | null;
  started_ts: number;
  completed_ts: number | null;
  exit_reason: string | null;
  total_tokens: number;
  error_detail: string | null;
}

export function createAgentRun(
  runId: string,
  agentId: string,
  triggerType: string,
  triggerDetail?: string | null,
): void {
  db.prepare(
    `INSERT INTO agent_runs (run_id, agent_id, trigger_type, trigger_detail, started_ts)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, agentId, triggerType, triggerDetail || null, Date.now());
}

export function completeAgentRun(
  runId: string,
  exitReason: string,
  totalTokens: number,
  errorDetail?: string | null,
): void {
  db.prepare(
    `UPDATE agent_runs SET completed_ts = ?, exit_reason = ?, total_tokens = ?, error_detail = ?
     WHERE run_id = ?`,
  ).run(Date.now(), exitReason, totalTokens, errorDetail || null, runId);
}

export function getAgentRuns(
  agentId: string,
  limit: number = 20,
  beforeRunId?: string,
): { runs: AgentRunRow[]; has_more: boolean } {
  let runs: AgentRunRow[];
  if (beforeRunId) {
    const cursor = db
      .prepare('SELECT started_ts FROM agent_runs WHERE run_id = ?')
      .get(beforeRunId) as { started_ts: number } | undefined;
    const ts = cursor?.started_ts || 0;
    runs = db
      .prepare(
        `SELECT * FROM agent_runs WHERE agent_id = ? AND started_ts < ?
         ORDER BY started_ts DESC LIMIT ?`,
      )
      .all(agentId, ts, limit + 1) as AgentRunRow[];
  } else {
    runs = db
      .prepare(
        'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_ts DESC LIMIT ?',
      )
      .all(agentId, limit + 1) as AgentRunRow[];
  }
  const has_more = runs.length > limit;
  if (has_more) runs.pop();
  return { runs, has_more };
}

export function getAgentRun(runId: string): AgentRunRow | undefined {
  return db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as
    | AgentRunRow
    | undefined;
}

/** Keep only the N most recent runs per agent, deleting older runs and their activity_feed entries. */
export function pruneOldRuns(agentId: string, keep: number = 10): void {
  const oldRuns = db
    .prepare(
      `SELECT run_id FROM agent_runs WHERE agent_id = ?
       ORDER BY started_ts DESC LIMIT -1 OFFSET ?`,
    )
    .all(agentId, keep) as { run_id: string }[];
  if (oldRuns.length === 0) return;
  const ids = oldRuns.map((r) => r.run_id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM activity_feed WHERE run_id IN (${placeholders})`).run(
    ...ids,
  );
  db.prepare(`DELETE FROM agent_runs WHERE run_id IN (${placeholders})`).run(
    ...ids,
  );
}

// --- Octopus: SharedSpace pages ---

export interface SharedSpacePageRow {
  page_id: string;
  title: string;
  summary: string;
  owner_agent_id: string;
  updated_by: string;
  updated_ts: number;
  body: string;
  parent_id: string | null;
  depth: number;
}

export function getSharedSpacePage(
  pageId: string,
): SharedSpacePageRow | undefined {
  return db
    .prepare('SELECT * FROM sharedspace_pages WHERE page_id = ?')
    .get(pageId) as SharedSpacePageRow | undefined;
}

export function getAllSharedSpacePages(): SharedSpacePageRow[] {
  return db
    .prepare('SELECT * FROM sharedspace_pages ORDER BY depth, page_id')
    .all() as SharedSpacePageRow[];
}

export function upsertSharedSpacePage(
  pageId: string,
  title: string,
  summary: string,
  ownerAgentId: string,
  updatedBy: string,
  body: string,
): { created: boolean } {
  const existing = getSharedSpacePage(pageId);
  const now = Date.now();

  // Compute parent_id and depth from page_id
  const lastSlash = pageId.lastIndexOf('/');
  const parentId = lastSlash > 0 ? pageId.slice(0, lastSlash) : null;
  const depth = pageId.split('/').length - 1;

  if (existing) {
    db.prepare(
      `UPDATE sharedspace_pages SET title = ?, summary = ?, owner_agent_id = ?, updated_by = ?, updated_ts = ?, body = ?
       WHERE page_id = ?`,
    ).run(title, summary, ownerAgentId, updatedBy, now, body, pageId);
    return { created: false };
  } else {
    db.prepare(
      `INSERT INTO sharedspace_pages (page_id, title, summary, owner_agent_id, updated_by, updated_ts, body, parent_id, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pageId,
      title,
      summary,
      ownerAgentId,
      updatedBy,
      now,
      body,
      parentId,
      depth,
    );
    return { created: true };
  }
}

export function deleteSharedSpacePage(pageId: string): boolean {
  const result = db
    .prepare('DELETE FROM sharedspace_pages WHERE page_id = ?')
    .run(pageId);
  return result.changes > 0;
}

export function getSharedSpaceChildren(parentId: string): SharedSpacePageRow[] {
  return db
    .prepare('SELECT * FROM sharedspace_pages WHERE parent_id = ?')
    .all(parentId) as SharedSpacePageRow[];
}

// --- Octopus: SharedSpace index cache ---

export function getCachedSharedSpaceIndex(agentId: string): string | null {
  const row = db
    .prepare(
      'SELECT index_text FROM sharedspace_index_cache WHERE agent_id = ?',
    )
    .get(agentId) as { index_text: string } | undefined;
  return row?.index_text || null;
}

export function setCachedSharedSpaceIndex(
  agentId: string,
  indexText: string,
): void {
  db.prepare(
    `INSERT INTO sharedspace_index_cache (agent_id, index_text, computed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET index_text = ?, computed_at = ?`,
  ).run(agentId, indexText, Date.now(), indexText, Date.now());
}

export function invalidateSharedSpaceIndex(agentIds: string[]): void {
  if (agentIds.length === 0) return;
  const placeholders = agentIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM sharedspace_index_cache WHERE agent_id IN (${placeholders})`,
  ).run(...agentIds);
}

// --- Octopus: Cross-branch queue ---

export interface CrossBranchMessageRow {
  message_id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  subject: string;
  body: string;
  run_id: string;
  message_array: string | null;
  arrived_ts: number;
  status: string;
}

export function insertCrossBranchMessage(
  msg: Omit<CrossBranchMessageRow, 'status'>,
): void {
  db.prepare(
    `INSERT INTO cross_branch_queue (message_id, sender_agent_id, recipient_agent_id, subject, body, run_id, message_array, arrived_ts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    msg.message_id,
    msg.sender_agent_id,
    msg.recipient_agent_id,
    msg.subject,
    msg.body,
    msg.run_id,
    msg.message_array,
    msg.arrived_ts,
  );
}

export function getCrossBranchMessage(
  messageId: string,
): CrossBranchMessageRow | undefined {
  return db
    .prepare('SELECT * FROM cross_branch_queue WHERE message_id = ?')
    .get(messageId) as CrossBranchMessageRow | undefined;
}

export function getPendingCrossBranchMessages(): CrossBranchMessageRow[] {
  return db
    .prepare(
      "SELECT * FROM cross_branch_queue WHERE status = 'pending' ORDER BY arrived_ts",
    )
    .all() as CrossBranchMessageRow[];
}

export function updateCrossBranchMessageStatus(
  messageId: string,
  status: string,
): void {
  db.prepare(
    'UPDATE cross_branch_queue SET status = ? WHERE message_id = ?',
  ).run(status, messageId);
}

export function discardCrossBranchMessageArray(messageId: string): void {
  db.prepare(
    "UPDATE cross_branch_queue SET message_array = NULL, status = 'dropped' WHERE message_id = ?",
  ).run(messageId);
}

// --- Octopus: HITL queue ---

export interface HitlCardRow {
  card_id: string;
  card_type: string;
  agent_id: string;
  subject: string;
  context: string;
  options: string | null;
  preference: number | null;
  run_id: string;
  message_array: string | null;
  resolution: string | null;
  selected_option: number | null;
  note: string | null;
  created_ts: number;
  resolved_ts: number | null;
}

export function insertHitlCard(
  card: Omit<
    HitlCardRow,
    'resolution' | 'selected_option' | 'note' | 'resolved_ts'
  >,
): void {
  db.prepare(
    `INSERT INTO hitl_queue (card_id, card_type, agent_id, subject, context, options, preference, run_id, message_array, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    card.card_id,
    card.card_type,
    card.agent_id,
    card.subject,
    card.context,
    card.options,
    card.preference,
    card.run_id,
    card.message_array,
    card.created_ts,
  );
}

export function getHitlCard(cardId: string): HitlCardRow | undefined {
  return db
    .prepare('SELECT * FROM hitl_queue WHERE card_id = ?')
    .get(cardId) as HitlCardRow | undefined;
}

export function getOpenHitlCards(): HitlCardRow[] {
  return db
    .prepare(
      'SELECT * FROM hitl_queue WHERE resolution IS NULL ORDER BY created_ts DESC',
    )
    .all() as HitlCardRow[];
}

export function getOpenHitlCardsForAgent(agentId: string): HitlCardRow[] {
  return db
    .prepare(
      'SELECT * FROM hitl_queue WHERE agent_id = ? AND resolution IS NULL',
    )
    .all(agentId) as HitlCardRow[];
}

export function resolveHitlCard(
  cardId: string,
  resolution: string,
  selectedOption?: number | null,
  note?: string | null,
): void {
  db.prepare(
    `UPDATE hitl_queue SET resolution = ?, selected_option = ?, note = ?, resolved_ts = ?
     WHERE card_id = ?`,
  ).run(resolution, selectedOption ?? null, note ?? null, Date.now(), cardId);
}

/** Count open HITL cards for an agent's subtree */
export function countOpenHitlCardsForSubtree(agentId: string): number {
  const allIds = [agentId, ...getDescendants(agentId).map((d) => d.agent_id)];
  const placeholders = allIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM hitl_queue WHERE agent_id IN (${placeholders}) AND resolution IS NULL`,
    )
    .get(...allIds) as { cnt: number };
  return row.cnt;
}

// --- Octopus: Conversations ---

export interface ConversationRow {
  conversation_id: string;
  agent_id: string;
  started_ts: number;
  last_message_ts: number | null;
  active: number;
}

export interface ConversationMessageRow {
  message_id: string;
  conversation_id: string;
  agent_id: string;
  role: string;
  content: string;
  ts: number;
  run_id: string | null;
}

export function createConversation(
  conversationId: string,
  agentId: string,
): ConversationRow {
  // Archive existing active conversation
  db.prepare(
    'UPDATE conversations SET active = 0 WHERE agent_id = ? AND active = 1',
  ).run(agentId);
  const now = Date.now();
  db.prepare(
    'INSERT INTO conversations (conversation_id, agent_id, started_ts, active) VALUES (?, ?, ?, 1)',
  ).run(conversationId, agentId, now);
  return {
    conversation_id: conversationId,
    agent_id: agentId,
    started_ts: now,
    last_message_ts: null,
    active: 1,
  };
}

export function getConversations(agentId: string): ConversationRow[] {
  return db
    .prepare(
      'SELECT * FROM conversations WHERE agent_id = ? ORDER BY started_ts DESC',
    )
    .all(agentId) as ConversationRow[];
}

export function getConversation(
  conversationId: string,
): ConversationRow | undefined {
  return db
    .prepare('SELECT * FROM conversations WHERE conversation_id = ?')
    .get(conversationId) as ConversationRow | undefined;
}

export function getActiveConversation(
  agentId: string,
): ConversationRow | undefined {
  return db
    .prepare('SELECT * FROM conversations WHERE agent_id = ? AND active = 1')
    .get(agentId) as ConversationRow | undefined;
}

/**
 * Returns the active conversation for an agent, creating one if none exists.
 * Used by automated triggers (inbox, HITL resume, cross-branch) so they
 * route into the existing conversation instead of fragmenting history.
 */
export function getOrCreateActiveConversation(
  agentId: string,
  generateId: () => string,
): ConversationRow {
  const existing = getActiveConversation(agentId);
  if (existing) return existing;
  return createConversation(generateId(), agentId);
}

export function insertConversationMessage(msg: ConversationMessageRow): void {
  db.prepare(
    `INSERT INTO conversation_messages (message_id, conversation_id, agent_id, role, content, ts, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.message_id,
    msg.conversation_id,
    msg.agent_id,
    msg.role,
    msg.content,
    msg.ts,
    msg.run_id,
  );
  db.prepare(
    'UPDATE conversations SET last_message_ts = ? WHERE conversation_id = ?',
  ).run(msg.ts, msg.conversation_id);
}

export function getConversationMessages(
  conversationId: string,
): ConversationMessageRow[] {
  return db
    .prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY ts',
    )
    .all(conversationId) as ConversationMessageRow[];
}

// --- Octopus: Inbox ---

export interface InboxMessageRow {
  message_id: string;
  recipient_agent_id: string;
  from_agent_id: string;
  from_agent_name: string;
  subject: string;
  body: string;
  cross_branch: number;
  delivered_ts: number;
  read: number;
}

export function insertInboxMessage(msg: Omit<InboxMessageRow, 'read'>): void {
  db.prepare(
    `INSERT INTO inbox_messages (message_id, recipient_agent_id, from_agent_id, from_agent_name, subject, body, cross_branch, delivered_ts, read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    msg.message_id,
    msg.recipient_agent_id,
    msg.from_agent_id,
    msg.from_agent_name,
    msg.subject,
    msg.body,
    msg.cross_branch,
    msg.delivered_ts,
  );
}

export function getUnreadInboxMessages(agentId: string): InboxMessageRow[] {
  return db
    .prepare(
      'SELECT * FROM inbox_messages WHERE recipient_agent_id = ? AND read = 0 ORDER BY delivered_ts',
    )
    .all(agentId) as InboxMessageRow[];
}

export function markInboxMessagesRead(agentId: string): void {
  db.prepare(
    'UPDATE inbox_messages SET read = 1 WHERE recipient_agent_id = ? AND read = 0',
  ).run(agentId);
}

/** Expose the raw database for direct queries in other modules */
export function getDb(): Database.Database {
  return db;
}

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
