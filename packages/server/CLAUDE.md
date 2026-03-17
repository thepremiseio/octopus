# @octopus/server

The Octopus agent runner. A fork of NanoClaw that adds an agent hierarchy, SharedSpace wiki, cross-branch messaging, HITL queue, token budgets, activity feed, and a WebSocket + REST API for the Boardroom frontend.

## Running

```bash
npm run build       # tsc → dist/
npm run start       # node dist/index.js
npm run dev         # tsx src/index.ts (no build step)
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run test:watch  # vitest (watch mode)
npm run format      # prettier
npm run setup       # first-time setup wizard
```

The server listens on port 3000 (env `NANOCLAW_PORT`). The credential proxy runs on port 3001 (env `CREDENTIAL_PROXY_PORT`).

## Architecture overview

```
CEO (Boardroom) ←── WebSocket + REST ──→ Server (this package)
                                            │
                                            ├─ agent tree (SQLite)
                                            ├─ HITL queue (SQLite)
                                            ├─ cross-branch queue (SQLite)
                                            ├─ SharedSpace pages (SQLite)
                                            ├─ activity feed (SQLite)
                                            ├─ token budgets (SQLite)
                                            │
                                            └─ container runner
                                               ├─ Docker / Apple Container
                                               └─ Claude Agent SDK inside each container
```

All persistent state is in a single SQLite file at `store/messages.db`.

## Key source files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — init DB, start credential proxy, register channels, wire up message handling, start scheduler and IPC watcher |
| `src/db.ts` | All SQLite schema and data access — agent tree, SharedSpace, HITL queue, cross-branch queue, activity feed, token budgets, conversations, inbox, runs, plus legacy NanoClaw tables |
| `src/container-runner.ts` | Spawns agent containers, assembles system prompts, records token usage, enforces daily budget and circuit breaker, broadcasts domain events over WebSocket |
| `src/sharedspace.ts` | Tree-aware access control for SharedSpace pages — computes readable/writable scope from agent hierarchy, builds and caches the per-agent page index |
| `src/tools.ts` | Agent tool implementations: `sharedspace_read`, `sharedspace_write`, `sharedspace_list`, `send_message`, `request_hitl` — each enforces access rules and emits events |
| `src/channels/dashboard.ts` | WebSocket + REST API server (replaces WhatsApp channel) — implements the full contract from `spec/api-spec.md` |
| `src/channels/registry.ts` | Channel factory registry — channels self-register on import |
| `src/channels/index.ts` | Barrel file — imports channels to trigger registration |
| `src/config.ts` | Environment-driven configuration constants |
| `src/types.ts` | TypeScript interfaces for channels, messages, tasks |
| `src/credential-proxy.ts` | HTTP proxy that injects LLM API credentials so containers never see real keys |
| `src/container-runtime.ts` | Docker/Apple Container abstraction — start, stop, mount flags, host gateway |
| `src/ipc.ts` | Polls IPC files written by agents inside containers |
| `src/task-scheduler.ts` | Cron-based scheduled task execution |
| `src/router.ts` | Message formatting and channel routing |
| `src/remote-control.ts` | Claude Code remote session management |
| `src/logger.ts` | Pino logger |

## SQLite schema

The database has two layers: legacy NanoClaw tables (chats, messages, registered_groups, scheduled_tasks, sessions, router_state) and Octopus tables:

| Table | Purpose |
|-------|---------|
| `agents` | Agent hierarchy tree — id, name, parent_id, depth, status |
| `agent_runs` | Execution history — run_id, trigger_type, tokens, exit_reason |
| `activity_feed` | Per-tool-call log — entry_type (tool_call/tool_result), tool_category (read/write/hitl/message/shell) |
| `daily_token_usage` | Budget tracking — (agent_id, date) → tokens_used |
| `sharedspace_pages` | Wiki pages — page_id, title, summary, owner, body, parent_id, depth |
| `sharedspace_index_cache` | Cached per-agent readable page index (invalidated on page changes) |
| `hitl_queue` | HITL cards — card_type (approval/choice/fyi/circuit_breaker), serialised message array, resolution |
| `cross_branch_queue` | Inter-branch messages awaiting CEO review — sender, recipient, serialised message array, status |
| `conversations` / `conversation_messages` | Multi-turn CEO-agent chat |
| `inbox_messages` | Agent-to-agent inbox (same-branch direct, cross-branch via CEO) |

## System prompt assembly

At container start, the prompt is assembled in order:

1. Agent's `CLAUDE.md` (role definition, written by CEO)
2. Auto-generated boilerplate (hierarchy position, manager name, escalation instruction, inbox instruction, approval policy, available tools)
3. Cached SharedSpace index (readable pages with titles and summaries)

If the agent has unread inbox messages, an inbox notification is prepended to the boilerplate section.

## Access control (SharedSpace)

- **Read**: ancestry chain (CEO down to self) + own subtree one level deep + CEO-owned pages
- **Write**: own level and all descendants
- **CEO**: full access everywhere

## Key environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NANOCLAW_PORT` | `3000` | WebSocket + REST API port |
| `CREDENTIAL_PROXY_PORT` | `3001` | Credential proxy port |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker image for agent containers |
| `CONTAINER_TIMEOUT` | `1800000` (30 min) | Max container runtime |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Concurrent container limit |
| `DEFAULT_DAILY_TOKEN_BUDGET` | `0` (unlimited) | Daily token budget per agent |
| `CIRCUIT_BREAKER_WINDOW_MS` | `300000` (5 min) | Sliding window for action counting |
| `CIRCUIT_BREAKER_THRESHOLD` | `50` | Max actions per window before pause |
| `ASSISTANT_NAME` | `Andy` | Name used in trigger pattern |

## Directory structure (runtime)

```
store/messages.db         # SQLite — single source of truth
groups/{groupFolder}/     # Per-agent folders containing CLAUDE.md
data/ipc/{groupFolder}/   # IPC files (input/ and output/ per agent)
```

## Testing

Tests use Vitest with in-memory SQLite (`_initTestDatabase()` from `db.ts`). Test files live alongside source files as `*.test.ts`.
