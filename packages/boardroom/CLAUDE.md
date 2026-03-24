# @octopus/boardroom

The Octopus Boardroom — a local React SPA that serves as the CEO's control centre. Connects to the server over WebSocket for real-time events and calls the REST API for actions.

## Running

```bash
npm run dev       # Vite dev server (hot reload)
npm run build     # tsc -b && vite build → dist/
npm run preview   # serve the built dist/
```

The server (`@octopus/server`) must be running first. The boardroom connects to it on the port set in `.env`:

```
VITE_NANOCLAW_PORT=3000
```

## Tech stack

- React 18 + TypeScript (strict)
- Vite 6 (bundler + dev server)
- Zustand 5 (state management)
- CSS Modules (scoped styling, no utility framework)
- `marked` (Markdown rendering for SharedSpace pages)
- IBM Plex fonts (sans + mono)

## Application structure

```
src/
├── main.tsx                          # Entry point — mounts App, loads global styles
├── App.tsx                           # Root — WS init, store seeding, layout, keyboard shortcuts
├── types/api.ts                      # Re-exports all types from @octopus/shared
├── api/
│   ├── websocket.ts                  # WS client — singleton, event emitter, auto-reconnect
│   └── rest.ts                       # REST client — typed fetch wrappers for every endpoint
├── store/
│   ├── agents.ts                     # Agent tree, selection, status updates
│   ├── queues.ts                     # HITL cards + cross-branch messages
│   ├── chat.ts                       # Conversations and messages per agent
│   ├── sharedspace.ts                # Page index, current page, recently-updated tracking
│   └── cost.ts                       # Per-agent and total cost tracking
├── hooks/
│   ├── useWebSocket.ts               # Connection status via useSyncExternalStore
│   └── useKeyboard.ts                # Global keyboard shortcuts + command palette trigger
├── components/
│   ├── layout/
│   │   ├── Topbar.tsx                # Connection status, keyboard hints, total cost
│   │   ├── AgentTree.tsx             # Left sidebar — depth-indented agent hierarchy
│   │   ├── PrimaryPanel.tsx          # Centre — switches between queue/chat/sharedspace/cost
│   │   ├── RightPanel.tsx            # Right — context-aware (agent info / activity / page tree)
│   │   └── CostOverview.tsx          # Cost breakdown by period
│   ├── queue/
│   │   ├── QueueMode.tsx             # Main HITL queue — decisions, cross-branch, FYI sections
│   │   ├── ApprovalCard.tsx          # Approve / reject / return-with-note
│   │   ├── ChoiceCard.tsx            # Numbered option selection
│   │   ├── FyiCard.tsx               # Read-only, auto-dismiss after 5s
│   │   └── CrossBranchCard.tsx       # Release / drop cross-branch message
│   ├── chat/
│   │   ├── ChatMode.tsx              # Conversation selector + message thread + input
│   │   ├── MessageThread.tsx         # Scrollable message list (CEO / agent styled differently)
│   │   └── ChatInput.tsx             # Textarea — Enter sends, Shift+Enter newline
│   ├── sharedspace/
│   │   ├── SharedSpaceMode.tsx       # Page viewer/editor wrapper
│   │   └── PageView.tsx              # Markdown display, edit mode, delete with confirmation
│   ├── rightpanel/
│   │   ├── AgentInfo.tsx             # Status, budget, schedules, action buttons
│   │   ├── ActivityFeed.tsx          # Live run activity stream, colour-coded by tool category
│   │   └── PageTree.tsx              # SharedSpace page hierarchy with update indicators
│   └── common/
│       ├── CommandPalette.tsx         # Ctrl-K fuzzy command search
│       ├── StatusDot.tsx              # Coloured dot per agent status
│       └── Badge.tsx                  # Numeric badge
├── utils/
│   └── format.ts                     # Timestamp formatting
└── styles/
    ├── tokens.css                    # Design system — colours, spacing, typography variables
    └── reset.css                     # Box-sizing and form element normalisation
```

## Data flow

```
WebSocket events → event emitter (api/websocket.ts)
                      ↓
              Zustand store subscriptions (store/*.ts)
                      ↓
              React re-renders
```

On app mount, `App.tsx` calls `init()` on the WebSocket client, waits for `connection.state`, then seeds all stores. After that, stores subscribe to specific WS event types and update reactively.

CEO actions (approve card, send message, edit page, etc.) go through the REST client. Many stores apply optimistic updates and roll back on API failure.

## Store design

Five Zustand stores, each owning a slice of state:

| Store | Key state | Subscribes to |
|-------|-----------|---------------|
| `agents` | agent tree, selected agent | `agent.*`, `cost.updated`, `connection.state` |
| `queues` | HITL cards, cross-branch messages, selected item | `hitl.*`, `crossbranch.*` |
| `chat` | conversations + messages per agent | `chat.message.received` |
| `sharedspace` | page index, current page, recently-updated set | `sharedspace.page.updated` |
| `cost` | per-agent token usage, total tokens today | `cost.updated`, `connection.state` |

## WebSocket client

`api/websocket.ts` — singleton connection to `ws://localhost:{port}/ws`.

- Connection phases: `waiting_ready` → `waiting_state` → `streaming`
- Validates protocol version (`v: 1`) on `connection.ready`
- Auto-reconnects with exponential backoff (1s, 2s, 4s cap)
- Internal event emitter: `on(eventType, callback)` returns unsubscribe function
- Connection status exposed via `useSyncExternalStore` hook

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl-K` | Command palette |
| `Ctrl-Shift-N` | New conversation |
| `Esc` | Return to queue |
| `Up/Down` | Navigate queue items |
| `A` | Approve / resume |
| `R` | Reject / terminate |
| `N` | Open note field |
| `1-9` | Select choice option |
| `Space` | Release cross-branch message |
| `Delete` | Drop cross-branch message |

## Styling conventions

- Dark theme defined in `tokens.css` (base `#0f0f0f`, surfaces `#161616`–`#252525`)
- Semantic colours: green (idle), blue (active), red (alert), purple (circuit-breaker), amber (accent)
- Typography: IBM Plex Sans 12–13px body, IBM Plex Mono 10px for labels and code
- Layout: fixed topbar (36px), left tree panel (220px), right context panel (280px), fluid centre
- Every component has its own `.module.css` file — import as `styles` and use `styles.className`
- No inline styles, no utility classes, no global class names
