/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const octopusHostUrl = process.env.OCTOPUS_HOST_URL || '';
const octopusRunId = process.env.OCTOPUS_RUN_ID || '';
const octopusAgentId = process.env.OCTOPUS_AGENT_ID || '';
const isOctopus = !!octopusHostUrl;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

// In Octopus mode, send_message sends to another agent (via host server).
// In NanoClaw mode, send_message sends to the chat/group (via IPC).
if (isOctopus) {
  server.tool(
    'send_message',
    'Send a message to another agent in the organisation. Same-branch messages are delivered directly. Cross-branch messages are queued for CEO review.',
    {
      to: z.string().describe('The agent_id of the recipient'),
      subject: z.string().describe('Short subject line'),
      body: z.string().describe('Message body'),
    },
    async (args) => {
      const result = await callHostTool('send_message', args);
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      const msg = result.queued_for_ceo
        ? `Message queued for CEO review (cross-branch). ID: ${result.message_id}`
        : `Message delivered to ${args.to}. ID: ${result.message_id}`;
      return { content: [{ type: 'text' as const, text: msg }] };
    },
  );
} else {
  server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
    {
      text: z.string().describe('The message text to send'),
      sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    },
    async (args) => {
      const data: Record<string, string | undefined> = {
        type: 'message',
        chatJid,
        text: args.text,
        sender: args.sender || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(MESSAGES_DIR, data);

      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    },
  );
}

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Octopus tools (only registered when running inside Octopus) ---

async function callHostTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${octopusHostUrl}/api/v1/internal/tool-call`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, agent_id: octopusAgentId, run_id: octopusRunId, args }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { error: `HTTP ${resp.status}: ${text}` };
    }
    return resp.json() as Promise<Record<string, unknown>>;
  } catch (err) {
    const cause = err instanceof Error && 'cause' in err ? ` cause: ${(err as any).cause}` : '';
    return { error: `fetch to ${url} failed: ${err instanceof Error ? err.message : String(err)}${cause}` };
  }
}

if (isOctopus) {
  server.tool(
    'sharedspace_read',
    'Read a SharedSpace page by its ID. Returns the page title, summary, owner, and body.',
    {
      page_id: z.string().describe('The page ID (e.g. "work/ventures/startup-a")'),
    },
    async (args) => {
      const result = await callHostTool('sharedspace_read', { page_id: args.page_id });
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      const data = result.data as { page_id: string; title: string; summary: string; owner_agent_id: string; body: string };
      return {
        content: [{ type: 'text' as const, text: `# ${data.title}\n\n**Summary:** ${data.summary}\n**Owner:** ${data.owner_agent_id}\n\n${data.body}` }],
      };
    },
  );

  server.tool(
    'sharedspace_write',
    'Create or update a SharedSpace page. Provide the page ID and content (title, summary, body).',
    {
      page_id: z.string().describe('The page ID (e.g. "work/ventures/startup-a")'),
      title: z.string().describe('Page title'),
      summary: z.string().describe('Brief one-line summary'),
      body: z.string().describe('Full page content (markdown)'),
    },
    async (args) => {
      const result = await callHostTool('sharedspace_write', {
        page_id: args.page_id,
        content: { title: args.title, summary: args.summary, body: args.body },
      });
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      const data = result.data as { page_id: string; operation: string };
      return { content: [{ type: 'text' as const, text: `Page '${data.page_id}' ${data.operation}.` }] };
    },
  );

  server.tool(
    'sharedspace_list',
    'List SharedSpace pages visible to you. Optionally filter by prefix.',
    {
      prefix: z.string().optional().describe('Filter pages whose ID starts with this prefix (e.g. "work/")'),
    },
    async (args) => {
      const result = await callHostTool('sharedspace_list', { prefix: args.prefix });
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      const pages = result.data as Array<{ page_id: string; title: string; summary: string; owner_agent_id: string }>;
      if (pages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No pages found.' }] };
      }
      const list = pages.map((p) => `- **${p.page_id}**: ${p.title} — ${p.summary} (owner: ${p.owner_agent_id})`).join('\n');
      return { content: [{ type: 'text' as const, text: `SharedSpace pages:\n${list}` }] };
    },
  );

  server.tool(
    'task_complete',
    `Always call this when your work is complete.
- If your work produced something the CEO should see, pass it as \`message\`.
- If your work was purely internal (sending a message to another agent,
  updating SharedSpace, running a scheduled task), call with no argument.
The invocation ends immediately when this tool is called. Do not call any
other tools after task_complete.`,
    {
      message: z.string().optional().describe('Optional message to route to CEO chat'),
    },
    async (args) => {
      const result = await callHostTool('task_complete', { message: args.message });
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: 'Invocation complete.' }] };
    },
  );

  server.tool(
    'request_hitl',
    'Request human-in-the-loop input from the CEO. Use "approval" for yes/no decisions, "choice" for multiple options, or "fyi" for informational notifications.',
    {
      type: z.enum(['approval', 'choice', 'fyi']).describe('Card type'),
      subject: z.string().describe('Short subject line for the card'),
      context: z.string().describe('Detailed context explaining the situation'),
      options: z.array(z.string()).optional().describe('Options for choice cards'),
      preference: z.number().optional().describe('Your recommended option index (0-based) for choice cards'),
    },
    async (args) => {
      const result = await callHostTool('request_hitl', args);
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      const msg = result.should_terminate
        ? `HITL card created (${result.card_id}). Your execution will be paused until the CEO responds.`
        : `FYI card created (${result.card_id}). Continuing execution.`;
      return { content: [{ type: 'text' as const, text: msg }] };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
