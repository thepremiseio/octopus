# Octopus — API Specification

> **WebSocket (§1–6):** Primarily server-to-client push events. The only client-to-server messages are `debug.subscribe` and `debug.unsubscribe` (§3.20).
>
> **REST (§7):** All CEO actions travel over HTTP. Approve a card, send a message, create an agent, edit a CLAUDE.md — everything the Boardroom *initiates* is a REST call.
>
> **Version:** `v1`

---

## 1. Connection

### Endpoint

```
ws://localhost:{NANOCLAW_PORT}/ws
```

No authentication. Single local user; the port is treated as the trust boundary.

### Behaviour on connect

On every connection (initial and reconnect) the server sends exactly two messages in this order, with no domain events interleaved between them:

1. `connection.ready` — confirms the protocol version. Sent first so the client can gate on `v` before processing anything else.
2. `connection.state` — snapshot of current system state. Sent immediately after.

`connection.ready` and `connection.state` are the only server-initiated messages that are not domain events. See §3.1 and §3.21 for their full definitions.

**Boardroom startup path:** open WebSocket → receive `connection.ready` (check `v`) → receive `connection.state` (render tree and badges) → fetch full card/message details via HTTP in the background. The UI is useful before the HTTP round-trips complete.

### Multiple connections

All connections receive every event (broadcast). The Boardroom may have multiple tabs open simultaneously; each tab maintains its own connection and receives the full event stream.

### Reconnection

The client is responsible for reconnecting on disconnect. There is no server-side replay of missed events — the client must re-fetch current state over HTTP after reconnecting. On reconnect, the Boardroom should apply the `connection.state` snapshot as a reconciliation pass before treating subsequent events as incremental updates.

---

## 2. Envelope

Every message from the server is a JSON object with this shape:

```json
{
  "v": 1,
  "type": "<namespace>.<event>",
  "ts": 1741000000000,
  "payload": { }
}
```

| Field     | Type     | Description |
|-----------|----------|-------------|
| `v`       | integer  | Protocol version. Currently `1`. Bump when the contract changes in a breaking way. |
| `type`    | string   | Dot-namespaced event type. See §3. |
| `ts`      | integer  | Unix timestamp in **milliseconds** (UTC). |
| `payload` | object   | Event-specific data. Never null; use `{}` for events with no data. |

---

## 3. Event Reference

### Namespace index

| Namespace         | Events |
|-------------------|--------|
| `connection.*`    | `connection.ready`, `connection.state` |
| `hitl.*`          | `hitl.card.created`, `hitl.card.resolved` |
| `crossbranch.*`   | `crossbranch.message.arrived`, `crossbranch.message.released`, `crossbranch.message.dropped` |
| `agent.*`         | `agent.created`, `agent.deleted`, `agent.status.changed` |
| `agent.run.*`     | `agent.run.started`, `agent.run.completed`, `agent.run.activity` |
| `agent.budget.*`  | `agent.budget.exceeded`, `agent.budget.circuit_breaker`, `agent.budget.reset` |
| `chat.*`          | `chat.message.received` |
| `cost.*`          | `cost.updated` |
| `sharedspace.*`   | `sharedspace.page.updated` |
| `inbox.*`         | `inbox.message.delivered` |
| `debug.*`         | `debug.subscribe` (client→server), `debug.unsubscribe` (client→server), `debug.exchange.recorded` (server→client, targeted) |

---

### 3.1 `connection.ready`

**Trigger:** Sent by the server as the first message on every WebSocket connection, before `connection.state` and before any domain events.

**Purpose:** Lets the client verify the protocol version before processing anything. If `v` does not match the version the Boardroom was built against, the client should display a version mismatch warning and avoid processing subsequent events.

```json
{
  "v": 1,
  "type": "connection.ready",
  "ts": 1741000000000,
  "payload": {
    "server_version": "0.1.0"
  }
}
```

| Field            | Type   | Notes |
|------------------|--------|-------|
| `server_version` | string | NanoClaw semver string, for display purposes only |

---

### 3.2 `hitl.card.created`

**Trigger:** An agent calls `request_hitl`. The runner has written the card to SQLite, serialised the message array (for `approval`/`choice` cards), and terminated the container.

**Boardroom behaviour:** Append the card to the top of the relevant Decision Queue section. Increment the queue tab badge. Increment the badge on the agent's tree node (and all ancestors up to the top-level branch node).

```json
{
  "v": 1,
  "type": "hitl.card.created",
  "ts": 1741000000000,
  "payload": {
    "card_id": "card_01jq8z",
    "card_type": "approval",
    "agent_id": "outreach-agent",
    "agent_name": "Outreach Agent",
    "agent_path": ["Work Coach", "Startup A Manager", "Outreach Agent"],
    "subject": "Send cold outreach to 3 prospects",
    "context": "I have drafted emails to three warm leads from the SharedSpace contacts list. All three were pre-approved by the Startup A Manager last week. I recommend sending.",
    "options": null,
    "preference": null,
    "run_id": "run_01jq8y"
  }
}
```

**For `choice` cards**, `options` is a non-empty array and `preference` is the index (0-based) of the agent's stated preference:

```json
{
  "options": [
    "Draft the proposal and request CEO approval before sending",
    "Send a scoping question first to gather requirements",
    "Decline and explain current capacity constraints"
  ],
  "preference": 1
}
```

**For `fyi` cards**, `options` is `null`, `preference` is `null`, and no message array is serialised (the container is not terminated).

**For `circuit_breaker` cards**, `options` is `null`, `preference` is `null`, `subject` and `context` are system-generated by the runner (not agent-authored). The card behaves like an `approval` card: the CEO approves to resume the agent or rejects to terminate the invocation permanently. A corresponding `agent.budget.circuit_breaker` event always precedes this card's arrival.

| Field         | Type            | Notes |
|---------------|-----------------|-------|
| `card_id`     | string          | Unique card identifier |
| `card_type`   | `"approval"` \| `"choice"` \| `"fyi"` \| `"circuit_breaker"` | `"circuit_breaker"` cards are system-generated when the circuit breaker trips; they behave like `approval` cards (the CEO approves to resume or rejects to terminate) but are created by the runner, not the agent |
| `agent_id`    | string          | Stable machine identifier |
| `agent_name`  | string          | Display name |
| `agent_path`  | string[]        | Ordered list from top-level branch down to this agent (for breadcrumb display) |
| `subject`     | string          | One-line subject written by the agent |
| `context`     | string          | Agent's full context paragraph |
| `options`     | string[] \| null | Choice options; `null` for `approval` and `fyi` |
| `preference`  | integer \| null | 0-based index into `options`; `null` for `approval` and `fyi` |
| `run_id`      | string          | The run that produced this card (used to fetch the activity feed) |

---

### 3.3 `hitl.card.resolved`

**Trigger:** The CEO acts on an approval or choice card (approve, reject, select option, or return with instructions). The runner has processed the decision and either resumed the container or discarded the card.

**Boardroom behaviour:** Remove the card from the queue. Decrement badges.

```json
{
  "v": 1,
  "type": "hitl.card.resolved",
  "ts": 1741000000000,
  "payload": {
    "card_id": "card_01jq8z",
    "agent_id": "outreach-agent",
    "resolution": "approved",
    "note": null
  }
}
```

| Field        | Type   | Notes |
|--------------|--------|-------|
| `card_id`    | string | |
| `agent_id`   | string | |
| `resolution` | `"approved"` \| `"rejected"` \| `"option_selected"` \| `"returned"` | `"option_selected"` for choice cards, `"returned"` when CEO used note & return |
| `selected_option` | integer \| null | 0-based index; present only when `resolution` is `"option_selected"` |
| `note`       | string \| null | CEO's note, if resolution is `"returned"`; `null` otherwise |

---

### 3.4 `crossbranch.message.arrived`

**Trigger:** An agent calls `send_message` with a recipient in a different top-level branch. The runner has written the message to the `cross_branch_queue` and serialised the sending agent's message array.

**Boardroom behaviour:** Append a card to the Cross-Branch Message Queue section. Increment the queue tab badge.

```json
{
  "v": 1,
  "type": "crossbranch.message.arrived",
  "ts": 1741000000000,
  "payload": {
    "message_id": "xbmsg_01jq9a",
    "from_agent_id": "strength-programme-agent",
    "from_agent_name": "Strength Programme Agent",
    "from_agent_path": ["Health Coach", "Strength Programme Agent"],
    "to_agent_id": "work-coach",
    "to_agent_name": "Work Coach",
    "to_agent_path": ["Work Coach"],
    "subject": "Flagging schedule conflict for next week",
    "body": "I noticed a potential conflict between the planned travel week and the scheduled gym sessions. Wanted to flag before finalising.",
    "run_id": "run_01jq9b"
  }
}
```

| Field             | Type     | Notes |
|-------------------|----------|-------|
| `message_id`      | string   | |
| `from_agent_id`   | string   | |
| `from_agent_name` | string   | |
| `from_agent_path` | string[] | |
| `to_agent_id`     | string   | |
| `to_agent_name`   | string   | |
| `to_agent_path`   | string[] | |
| `subject`         | string   | |
| `body`            | string   | Full message body |
| `run_id`          | string   | For fetching the sender's activity feed |

---

### 3.5 `crossbranch.message.released`

**Trigger:** CEO releases a cross-branch message. The runner has delivered it to the recipient's inbox and queued a container invocation for the recipient.

**Boardroom behaviour:** Remove the card from the Cross-Branch Message Queue. Decrement badge.

```json
{
  "v": 1,
  "type": "crossbranch.message.released",
  "ts": 1741000000000,
  "payload": {
    "message_id": "xbmsg_01jq9a",
    "to_agent_id": "work-coach"
  }
}
```

---

### 3.6 `crossbranch.message.dropped`

**Trigger:** CEO drops a cross-branch message. The runner has discarded it. The sending agent's serialised message array is permanently deleted — the container is never resumed and the sender receives no notification. This is a terminal action for that invocation.

**Boardroom behaviour:** Remove the card from the Cross-Branch Message Queue. Decrement badge.

```json
{
  "v": 1,
  "type": "crossbranch.message.dropped",
  "ts": 1741000000000,
  "payload": {
    "message_id": "xbmsg_01jq9a",
    "from_agent_id": "strength-programme-agent"
  }
}
```

---

### 3.7 `agent.status.changed`

**Trigger:** An agent transitions between status states. Emitted by the runner whenever the agent's status changes.

**Boardroom behaviour:** Update the status dot on the agent's tree node.

```json
{
  "v": 1,
  "type": "agent.status.changed",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "status": "active",
    "previous_status": "idle"
  }
}
```

| Field             | Type   | Notes |
|-------------------|--------|-------|
| `agent_id`        | string | |
| `status`          | `"idle"` \| `"active"` \| `"alert"` \| `"circuit-breaker"` | |
| `previous_status` | `"idle"` \| `"active"` \| `"alert"` \| `"circuit-breaker"` | |

Status meanings as defined in the UI spec: `idle` — no animation; `active` — green glow; `alert` — amber pulse; `circuit-breaker` — red pulse.

---

### 3.8 `agent.run.started`

**Trigger:** The runner starts a container for an agent.

**Boardroom behaviour:** Update agent status dot (complemented by `agent.status.changed`). Used to open a live activity feed panel if the agent is currently selected.

```json
{
  "v": 1,
  "type": "agent.run.started",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "run_id": "run_01jq8y",
    "trigger_type": "chat",
    "trigger_detail": "Direct message from CEO"
  }
}
```

| Field            | Type   | Notes |
|------------------|--------|-------|
| `agent_id`       | string | |
| `run_id`         | string | Stable identifier for this invocation; referenced by `agent.run.activity` and HITL cards |
| `trigger_type`   | `"chat"` \| `"inbox"` \| `"scheduled"` \| `"hitl_resume"` \| `"crossbranch_resume"` | `"hitl_resume"` when resuming after a CEO HITL decision; `"crossbranch_resume"` when resuming the **sender's** serialised message array after the CEO releases a cross-branch message |
| `trigger_detail` | string \| null | Human-readable description; e.g. schedule name, or `null` |

---

### 3.9 `agent.run.completed`

**Trigger:** A container exits cleanly (agent loop concluded, HITL pause, budget block, or circuit breaker).

**Boardroom behaviour:** Mark the run as finished in the activity feed. No more `agent.run.activity` events will arrive for this `run_id`.

```json
{
  "v": 1,
  "type": "agent.run.completed",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "run_id": "run_01jq8y",
    "exit_reason": "completed",
    "total_tokens": 14200
  }
}
```

| Field          | Type    | Notes |
|----------------|---------|-------|
| `agent_id`     | string  | |
| `run_id`       | string  | |
| `exit_reason`  | `"completed"` \| `"hitl_pause"` \| `"crossbranch_pause"` \| `"budget_exceeded"` \| `"circuit_breaker"` \| `"error"` | |
| `total_tokens` | integer | Tokens consumed in this run |
| `error_detail` | string \| null | Present only when `exit_reason` is `"error"`; brief description |

---

### 3.10 `agent.run.activity`

**Trigger:** The runner intercepts a tool call or tool result in the agent event stream. One event per entry.

> **Note:** This event is not in the original event list but is required to drive the live activity feed in the Right Panel. It is the stream of entries that `agent.run.started` / `agent.run.completed` bookend.

**Boardroom behaviour:** Append the entry to the activity feed for the relevant `run_id`. If the Right Panel is showing this agent's activity feed, render the new row immediately.

```json
{
  "v": 1,
  "type": "agent.run.activity",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "run_id": "run_01jq8y",
    "entry_id": "entry_01jqac",
    "entry_type": "tool_call",
    "tool_name": "sharedspace_read",
    "tool_category": "read",
    "detail": "id: work/ventures/startup-a-overview",
    "outcome": null
  }
}
```

For tool results, `entry_type` is `"tool_result"` and `outcome` carries a brief summary:

```json
{
  "entry_type": "tool_result",
  "tool_name": "sharedspace_read",
  "tool_category": "read",
  "detail": "id: work/ventures/startup-a-overview",
  "outcome": "Page retrieved (1,240 tokens)"
}
```

| Field           | Type    | Notes |
|-----------------|---------|-------|
| `agent_id`      | string  | |
| `run_id`        | string  | |
| `entry_id`      | string  | Correlation identifier shared by a `tool_call` and its corresponding `tool_result`. Both entries in a call/result pair carry the same `entry_id` so the Boardroom can link them. IDs are unique across pairs within a run but intentionally repeated within each pair. |
| `entry_type`    | `"tool_call"` \| `"tool_result"` | |
| `tool_name`     | string  | Exact tool identifier, e.g. `sharedspace_read`, `sharedspace_delete`, `sharedspace_move`, `send_message`, `request_hitl` |
| `tool_category` | `"read"` \| `"write"` \| `"hitl"` \| `"message"` \| `"shell"` | Used by the Boardroom to colour-code entries. `"read"` → blue; `"hitl"` → amber; `"write"`, `"message"`, `"shell"` → muted |
| `detail`        | string  | Serialised tool arguments, truncated to 200 chars |
| `outcome`       | string \| null | Brief result summary for `tool_result`; `null` for `tool_call` |

---

### 3.11 `agent.created`

**Trigger:** CEO creates a new agent via the Boardroom. The runner has provisioned the container, written `CLAUDE.md`, generated boilerplate, and added the node to the tree in SQLite.

**Boardroom behaviour:** Insert the new node into the Agent Tree at the correct position.

```json
{
  "v": 1,
  "type": "agent.created",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "outreach-agent",
    "agent_name": "Outreach Agent",
    "parent_id": "startup-a-manager",
    "agent_path": ["Work Coach", "Startup A Manager", "Outreach Agent"],
    "depth": 3,
    "status": "idle",
    "cost_today_eur": 0.00
  }
}
```

| Field            | Type    | Notes |
|------------------|---------|-------|
| `agent_id`       | string  | |
| `agent_name`     | string  | |
| `parent_id`      | string \| null | `null` only if this is a top-level agent (direct child of CEO) |
| `agent_path`     | string[] | From top-level branch down to this agent |
| `depth`          | integer | 0 = top-level (direct child of CEO) |
| `status`         | string  | Always `"idle"` on creation |
| `cost_today_eur` | number  | Always `0.00` on creation |

---

### 3.12 `agent.deleted`

**Trigger:** CEO deletes an agent. The runner has torn down the container, removed the node (and all descendants) from the tree, and written the final handover invocation result to SharedSpace (if one was produced).

**Boardroom behaviour:** Remove the node and all its children from the Agent Tree. If any of the deleted agents had open HITL cards, remove those cards from the queue and decrement badges.

```json
{
  "v": 1,
  "type": "agent.deleted",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "outreach-agent",
    "deleted_subtree": ["outreach-agent"]
  }
}
```

| Field             | Type     | Notes |
|-------------------|----------|-------|
| `agent_id`        | string   | The root of the deletion (what the CEO deleted) |
| `deleted_subtree` | string[] | All agent IDs removed, including the root and all descendants. Allows the Boardroom to clean up any references to descendant agents in queues or feeds. |

---

### 3.13 `agent.budget.exceeded`

**Trigger:** An agent's daily token budget is hit. The runner has blocked the container from starting and recorded the event in SQLite.

**Boardroom behaviour:** Set the agent's status dot to `alert`. Surface a notification (the Boardroom's inline queue notification, not a system alert). The agent will not run again today unless the CEO manually resets the budget.

```json
{
  "v": 1,
  "type": "agent.budget.exceeded",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "budget_tokens": 100000,
    "used_tokens": 100043,
    "period": "daily",
    "blocked_trigger_type": "inbox"
  }
}
```

| Field                  | Type    | Notes |
|------------------------|---------|-------|
| `agent_id`             | string  | |
| `budget_tokens`        | integer | The configured limit |
| `used_tokens`          | integer | Actual usage at the point of blocking |
| `period`               | `"daily"` | Only daily budgets exist for now |
| `blocked_trigger_type` | string  | The trigger that was blocked (`"chat"`, `"inbox"`, `"scheduled"`) |

---

### 3.14 `agent.budget.circuit_breaker`

**Trigger:** An agent exceeds either N actions within a sliding time window (action-count breaker) or the per-run token budget (token-budget breaker). The runner has paused the agent, killed the container (for token breaker), and written a decision card to the HITL queue.

**Boardroom behaviour:** Set the agent's status dot to `circuit-breaker`. A corresponding `hitl.card.created` event will also fire for the decision card — the Boardroom does not need to synthesise a card from this event. This event exists to update the status dot immediately, before the card event arrives.

**Action-count variant:**

```json
{
  "v": 1,
  "type": "agent.budget.circuit_breaker",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "run_id": "run_01jq8y",
    "action_count": 52,
    "window_seconds": 300,
    "threshold": 50
  }
}
```

| Field            | Type    | Notes |
|------------------|---------|-------|
| `agent_id`       | string  | |
| `run_id`         | string  | The run that triggered the breaker |
| `action_count`   | integer | Actions observed in the window |
| `window_seconds` | integer | The sliding window duration |
| `threshold`      | integer | The configured limit |

**Token-budget variant:**

```json
{
  "v": 1,
  "type": "agent.budget.circuit_breaker",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "run_id": "run_01jq8y",
    "tokens_used": 310000,
    "budget": 300000,
    "reason": "run_token_budget"
  }
}
```

| Field            | Type    | Notes |
|------------------|---------|-------|
| `agent_id`       | string  | |
| `run_id`         | string  | The run that triggered the breaker |
| `tokens_used`    | integer | Total tokens consumed in this run |
| `budget`         | integer | The configured per-run token budget (`RUN_TOKEN_BUDGET`) |
| `reason`         | string  | `"run_token_budget"` — distinguishes from action-count breaker |


---

### 3.15 `agent.budget.reset`

**Trigger:** The CEO manually resets an agent's daily token budget via the Boardroom (HTTP action). The agent is unblocked and can run again.

**Boardroom behaviour:** Clear the `alert` status dot on the agent's tree node, restoring it to `idle`. This event is emitted in addition to `agent.status.changed` (which fires immediately after with `status: "idle"`) — the Boardroom may use either to update the dot; the reset event additionally confirms that the cause was a budget reset rather than any other idle transition.

```json
{
  "v": 1,
  "type": "agent.budget.reset",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "reset_by": "ceo",
    "previous_used_tokens": 100043,
    "budget_tokens": 100000
  }
}
```

| Field                   | Type   | Notes |
|-------------------------|--------|-------|
| `agent_id`              | string | |
| `reset_by`              | `"ceo"` | Only the CEO can reset budgets; field reserved for future extension |
| `previous_used_tokens`  | integer | Token count at the time of reset, for the activity log |
| `budget_tokens`         | integer | The configured daily limit (unchanged by the reset) |
---

### 3.16 `chat.message.received`

**Trigger:** An agent produces a chat message addressed to the CEO during an active run.

**Boardroom behaviour:** If the agent's chat is the active tab, append the message to the thread and scroll to bottom. If not, show an unread indicator on the agent's tree node and on the chat tab label.

```json
{
  "v": 1,
  "type": "chat.message.received",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "work-coach",
    "conversation_id": "conv_01jqae",
    "message_id": "msg_01jqaf",
    "content": "I've completed the weekly review. Three items need your attention — I'll request approval for each shortly.",
    "run_id": "run_01jqad"
  }
}
```

| Field             | Type   | Notes |
|-------------------|--------|-------|
| `agent_id`        | string | |
| `conversation_id` | string | Stable per-conversation identifier; used to fetch full history via REST |
| `message_id`      | string | |
| `content`         | string | Full message text |
| `run_id`          | string | The run that produced this message |

---

### 3.17 `cost.updated`

**Trigger:** The runner accumulates cost deltas server-side and emits at most once per second per agent. Throttling is applied by NanoClaw, not the Boardroom — the client applies whatever it receives without buffering or debouncing. The payload carries the agent's **cumulative** cost for the current day, not the delta.

**Boardroom behaviour:** Update the cost figure on the agent's tree node. Update the total in the tree footer and the topbar. If the Cost Overview is open, refresh the relevant row.

```json
{
  "v": 1,
  "type": "cost.updated",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "research-agent",
    "run_id": "run_01jq8y",
    "cost_today_eur": 0.14,
    "total_today_eur": 1.83
  }
}
```

| Field             | Type   | Notes |
|-------------------|--------|-------|
| `agent_id`        | string | The agent whose cost changed |
| `run_id`          | string | The run that incurred the cost |
| `cost_today_eur`  | number | This agent's cumulative spend today, in euros. Always rounded to 2 decimal places server-side before emission — the Boardroom will never receive a value like `0.14299999`. |
| `total_today_eur` | number | Sum across all agents today, also rounded to 2 decimal places server-side. Used to update the topbar total without a REST round-trip. |

---

### 3.18 `sharedspace.page.updated`

**Trigger:** Any agent or the CEO writes, deletes, or moves a SharedSpace page (`sharedspace_write`, `sharedspace_delete`, or `sharedspace_move` tool, direct edit via the Boardroom, or external filesystem edit detected by the vault watcher). Fired after the change is committed and the SharedSpace index cache is invalidated.

**Boardroom behaviour:** If the SharedSpace Browser is open and this page is visible, update the `●` recently-updated indicator in the page tree. If the page is currently being viewed and `updated_by_agent_id` is **not** `"ceo"`, prompt the user that the page has changed externally (or auto-reload if the page is unedited). If `updated_by_agent_id` is `"ceo"`, the Boardroom was the writer — suppress the prompt to avoid the CEO being notified of their own save.

```json
{
  "v": 1,
  "type": "sharedspace.page.updated",
  "ts": 1741000000000,
  "payload": {
    "page_id": "work/ventures/startup-a-overview",
    "title": "Startup A — Overview",
    "summary": "Core thesis, current status, and key contacts for Startup A",
    "owner_agent_id": "startup-a-manager",
    "updated_by_agent_id": "research-agent",
    "operation": "updated",
    "access": "branch",
    "parent_id": "work/ventures",
    "depth": 2
  }
}
```

| Field                | Type    | Notes |
|----------------------|---------|-------|
| `page_id`            | string  | Full page path, e.g. `work/ventures/startup-a-overview` |
| `title`              | string  | |
| `summary`            | string  | One-line summary (the index-visible field) |
| `owner_agent_id`     | string  | Agent that owns this page |
| `updated_by_agent_id`| string  | Agent, `"ceo"`, or `"filesystem"` (for external edits detected by vault watcher) |
| `operation`          | `"created"` \| `"updated"` \| `"deleted"` | For `"deleted"`, `title` and `summary` reflect the last known values. A `sharedspace_move` emits two events: `"created"` for the new page and `"deleted"` for the old. |
| `access`             | string \| string[] | Read access level: `"ceo-only"`, `"owner-and-above"`, `"branch"`, `"everyone"`, or an array of agent IDs |
| `parent_id`          | string \| null | Optional. Parent page ID, or `null` for root-level pages. May be omitted. |
| `depth`              | integer | Optional. 0-based depth in the page tree. May be omitted. |

---

### 3.19 `inbox.message.delivered`

**Trigger:** A message is delivered to an agent's inbox — either from a same-branch direct delivery or after the CEO releases a cross-branch message. The runner has written the message to the recipient's private storage and queued a container invocation.

**Boardroom behaviour:** This event exists for observability — the agent will run shortly (an `agent.run.started` event will follow). The Boardroom may surface a subtle indicator on the recipient's tree node if desired, but no queue action is required.

```json
{
  "v": 1,
  "type": "inbox.message.delivered",
  "ts": 1741000000000,
  "payload": {
    "recipient_agent_id": "work-coach",
    "message_id": "xbmsg_01jq9a",
    "from_agent_id": "strength-programme-agent",
    "from_agent_name": "Strength Programme Agent",
    "subject": "Flagging schedule conflict for next week",
    "cross_branch": true
  }
}
```

| Field                 | Type    | Notes |
|-----------------------|---------|-------|
| `recipient_agent_id`  | string  | |
| `message_id`          | string  | Matches `message_id` from `crossbranch.message.arrived` when applicable |
| `from_agent_id`       | string  | |
| `from_agent_name`     | string  | |
| `subject`             | string  | |
| `cross_branch`        | boolean | `true` if this message crossed a top-level branch boundary |

---

### 3.20 Debug (`debug.*`)

The debug namespace provides opt-in, per-agent LLM exchange observation. Unlike all other events, the debug namespace includes **client-to-server** messages and uses **targeted delivery** (events are sent only to subscribed clients, not broadcast to all).

#### Client-to-server: `debug.subscribe` / `debug.unsubscribe`

The Boardroom sends these as plain JSON over the WebSocket connection (no envelope):

```json
{ "type": "debug.subscribe", "agent_id": "work-coach" }
{ "type": "debug.unsubscribe", "agent_id": "work-coach" }
```

Subscribing activates LLM exchange capture for the agent on the credential proxy. Unsubscribing stops capture (if no other clients are subscribed to the same agent). Subscriptions are cleaned up automatically when the WebSocket connection closes.

#### Server-to-client: `debug.exchange.recorded`

**Trigger:** The credential proxy intercepts an LLM API call from a subscribed agent's container, captures the request and response, and forwards the exchange to subscribed clients.

**Delivery:** Targeted — only sent to WebSocket clients that have an active `debug.subscribe` for the agent. Not broadcast.

```json
{
  "v": 1,
  "type": "debug.exchange.recorded",
  "ts": 1741000000000,
  "payload": {
    "agent_id": "work-coach",
    "run_id": "run_01jq8y",
    "exchange_index": 0,
    "messages_json": "{\"system\":...,\"messages\":[...]}",
    "response_json": "{\"role\":\"assistant\",\"content\":[...]}",
    "tokens_in": 1420,
    "tokens_out": 380,
    "ts": 1741000001000
  }
}
```

| Field            | Type           | Notes |
|------------------|----------------|-------|
| `agent_id`       | string         | |
| `run_id`         | string         | Groups exchanges within a single agent run |
| `exchange_index` | integer        | 0-based sequence number within the run |
| `messages_json`  | string         | Full API request body as JSON string (system prompt + message history) |
| `response_json`  | string \| null | Full API response as JSON string; `null` if the response could not be captured |
| `tokens_in`      | integer        | Input tokens for this exchange |
| `tokens_out`     | integer        | Output tokens for this exchange |
| `ts`             | integer        | Unix timestamp in milliseconds |

---

### 3.21 `connection.state`

**Trigger:** Sent by the server as the second message on every WebSocket connection, immediately after `connection.ready`. It is a point-in-time snapshot of all agent states and queue counts. On reconnect, the Boardroom applies this snapshot as a reconciliation pass — overwriting any stale statuses or badge counts accumulated while disconnected — and then resumes treating subsequent events as incremental updates.

```json
{
  "v": 1,
  "type": "connection.state",
  "ts": 1741000000000,
  "payload": {
    "agents": [
      {
        "agent_id": "work-coach",
        "agent_name": "Work Coach",
        "parent_id": null,
        "depth": 0,
        "status": "idle",
        "cost_today_eur": 0.07,
        "open_hitl_cards": 2,
        "cross_branch_trusted": false,
        "tool_allowlist": null
      },
      {
        "agent_id": "startup-a-manager",
        "agent_name": "Startup A Manager",
        "parent_id": "work-coach",
        "depth": 1,
        "status": "active",
        "cost_today_eur": 0.31,
        "open_hitl_cards": 0,
        "cross_branch_trusted": false,
        "tool_allowlist": null
      }
    ],
    "hitl_queue_count": 2,
    "crossbranch_queue_count": 1,
    "total_today_eur": 1.83
  }
}
```

| Field                     | Type     | Notes |
|---------------------------|----------|-------|
| `agents`                  | object[] | One entry per agent in the tree. Ordered depth-first so the Boardroom can reconstruct the tree by processing the array top to bottom. |
| `agents[].agent_id`       | string   | |
| `agents[].agent_name`     | string   | |
| `agents[].parent_id`      | string \| null | `null` for top-level agents (direct children of CEO) |
| `agents[].depth`          | integer  | 0 = top-level |
| `agents[].status`         | string   | Current status dot state |
| `agents[].cost_today_eur` | number   | This agent's cumulative spend today |
| `agents[].open_hitl_cards`| integer  | Count of open HITL cards for this agent's subtree; drives tree node badges |
| `hitl_queue_count`        | integer  | Total open HITL cards across all agents; drives the queue tab badge |
| `crossbranch_queue_count` | integer  | Messages currently awaiting CEO routing |
| `total_today_eur`         | number   | Sum of all agent costs today; drives the topbar and tree footer |

---

## 4. Event Ordering Guarantees

The server sends events over a single WebSocket connection per client. Within that connection:

- Events are sent in the order the server processes them.
- `agent.run.activity` entries for a given `run_id` are guaranteed to arrive in tool-call order.
- `agent.run.started` is always sent before any `agent.run.activity` events for that `run_id`.
- `agent.run.completed` is always sent after all `agent.run.activity` events for that `run_id`.
- `hitl.card.created` and `crossbranch.message.arrived` are sent after the container has been terminated (for blocking types), so the corresponding `agent.status.changed` (`idle`) and `agent.run.completed` events will have already been sent.

No ordering guarantee exists between events for **different** agents.

---

## 5. Error Cases

The server does not send structured error events over WebSocket. Connection-level errors (e.g. NanoClaw process crash) are surfaced as a WebSocket close frame; the Boardroom should display a disconnected state and attempt reconnection.

If a payload cannot be serialised for any reason, the event is dropped and the failure logged server-side. The Boardroom should treat gaps in the `run_id` activity stream as a signal to re-fetch the feed via REST.

---

## 6. Open Questions (Deferred)

None at this stage.

---

## 7. REST API

### 7.1 Conventions

**Base URL**

```
http://localhost:{NANOCLAW_PORT}/api/v1
```

**Headers**

All requests that carry a body must include `Content-Type: application/json`. All responses return `Content-Type: application/json`.

**Timestamps**

All timestamp fields are Unix milliseconds (integer), consistent with WebSocket envelopes.

**Field naming**

Field names are consistent with their WebSocket counterparts. A field named `agent_id` in a WS event payload has the same type and meaning in the corresponding REST response.

**HTTP status codes**

| Code | When |
|------|------|
| `200 OK` | Successful read or update |
| `201 Created` | Successful creation; response body contains the created resource |
| `204 No Content` | Successful delete or action with no response body |
| `400 Bad Request` | Malformed request or invalid field value |
| `404 Not Found` | Resource does not exist |
| `409 Conflict` | Valid request that cannot be fulfilled in current state (e.g. acting on an already-resolved card) |
| `422 Unprocessable Entity` | Request is well-formed but semantically invalid (e.g. invalid cron expression) |
| `500 Internal Server Error` | Unexpected server-side failure |

**Error response shape**

All error responses use this envelope:

```json
{
  "error": {
    "code": "agent_not_found",
    "message": "No agent with id 'xyz' exists."
  }
}
```

Common `code` values: `agent_not_found`, `card_not_found`, `card_already_resolved`, `message_not_found`, `page_not_found`, `page_has_children`, `conversation_not_found`, `schedule_not_found`, `invalid_resolution`, `agent_active`, `agent_paused`, `invalid_cron`, `validation_error`.

**WebSocket side effects**

Many REST actions cause the server to emit WebSocket events to all connected clients. These are noted per endpoint. The calling tab receives the event too — the Boardroom should handle this gracefully (e.g. not double-rendering a card it already optimistically removed).

---

### 7.2 Endpoint Index

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents` | Full agent tree |
| `POST` | `/agents` | Create agent |
| `GET` | `/agents/{agent_id}` | Single agent detail |
| `PUT` | `/agents/{agent_id}` | Update agent attributes |
| `DELETE` | `/agents/{agent_id}` | Delete agent and subtree |
| `GET` | `/agents/{agent_id}/claude-md` | Get CLAUDE.md |
| `PUT` | `/agents/{agent_id}/claude-md` | Update CLAUDE.md |
| `GET` | `/agents/{agent_id}/boilerplate` | Get auto-generated boilerplate |
| `GET` | `/agents/{agent_id}/runs` | List recent runs |
| `GET` | `/agents/{agent_id}/runs/{run_id}/activity` | Activity feed for a run |
| `GET` | `/agents/{agent_id}/schedules` | List scheduled tasks |
| `POST` | `/agents/{agent_id}/schedules` | Create scheduled task |
| `DELETE` | `/agents/{agent_id}/schedules/{schedule_id}` | Delete scheduled task |
| `POST` | `/agents/{agent_id}/budget/reset` | Reset daily token budget |
| `GET` | `/agents/{agent_id}/conversations` | List conversations |
| `POST` | `/agents/{agent_id}/conversations` | Start new conversation |
| `GET` | `/agents/{agent_id}/conversations/{conversation_id}` | Get conversation with messages |
| `POST` | `/agents/{agent_id}/conversations/{conversation_id}/messages` | Send message |
| `GET` | `/hitl` | Get all open HITL cards |
| `GET` | `/hitl/{card_id}` | Get single HITL card |
| `POST` | `/hitl/{card_id}/decision` | Submit CEO decision on card |
| `GET` | `/crossbranch` | Get all pending cross-branch messages |
| `POST` | `/crossbranch/{message_id}/release` | Release message to recipient |
| `POST` | `/crossbranch/{message_id}/drop` | Drop message |
| `GET` | `/sharedspace` | SharedSpace page index (metadata only); `?as={agent_id}` for agent-scoped view |
| `GET` | `/sharedspace/{page_id}` | Get page with body; `?as={agent_id}` for access check |
| `PUT` | `/sharedspace/{page_id}` | Create or update page |
| `DELETE` | `/sharedspace/{page_id}` | Delete page |
| `GET` | `/cost` | Cost summary |
| `POST` | `/restart` | Rebuild and restart the server (spawns detached process, exits current) |

---

### 7.3 Agents

#### `GET /agents`

Returns the full agent tree. This is the authoritative source of tree structure and is used by the Boardroom after startup (once `connection.state` has pre-populated status and badges) and after any reconnect where the tree may have changed.

**Response `200 OK`**

```json
{
  "agents": [
    {
      "agent_id": "work-coach",
      "agent_name": "Work Coach",
      "parent_id": null,
      "depth": 0,
      "status": "idle",
      "cost_today_eur": 0.07,
      "open_hitl_cards": 2,
      "last_run_ts": 1740999000000,
      "cross_branch_trusted": false,
      "tool_allowlist": null
    },
    {
      "agent_id": "startup-a-manager",
      "agent_name": "Startup A Manager",
      "parent_id": "work-coach",
      "depth": 1,
      "status": "active",
      "cost_today_eur": 0.31,
      "open_hitl_cards": 0,
      "last_run_ts": 1741000000000,
      "cross_branch_trusted": false,
      "tool_allowlist": ["sharedspace_read", "sharedspace_list", "request_hitl", "task_complete"]
    }
  ]
}
```

Ordered depth-first. `last_run_ts` is `null` if the agent has never run. `cross_branch_trusted` defaults to `false`. `tool_allowlist` is `null` (all tools permitted) or an array of tool name strings.

---

#### `POST /agents`

Creates a new agent. The server provisions the container, writes a default `CLAUDE.md`, generates boilerplate, and adds the node to the SQLite tree.

**Request body**

```json
{
  "agent_name": "Outreach Agent",
  "parent_id": "startup-a-manager",
  "cross_branch_trusted": false,
  "tool_allowlist": null
}
```

| Field                  | Type                   | Required | Notes |
|------------------------|------------------------|----------|-------|
| `agent_name`           | string                 | yes      | Display name; must be unique among siblings |
| `parent_id`            | string \| null         | yes      | Parent agent ID. `null` creates a top-level agent (direct child of CEO). |
| `cross_branch_trusted` | boolean                | no       | Default `false`. When `true`, cross-branch messages from or to this agent are delivered directly without CEO review (bidirectional). |
| `tool_allowlist`       | string[] \| null       | no       | Default `null` (all tools permitted). When set, the runner rejects any tool call whose name is not in the list. |

**Response `201 Created`**

```json
{
  "agent_id": "outreach-agent",
  "agent_name": "Outreach Agent",
  "parent_id": "startup-a-manager",
  "depth": 3,
  "status": "idle",
  "cost_today_eur": 0.00,
  "open_hitl_cards": 0,
  "last_run_ts": null,
  "cross_branch_trusted": false,
  "tool_allowlist": null
}
```

**WS side effect:** `agent.created`

---

#### `GET /agents/{agent_id}`

Returns a single agent's details. Used by the Right Panel when an agent is selected.

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "agent_name": "Research Agent",
  "parent_id": "startup-a-manager",
  "agent_path": ["Work Coach", "Startup A Manager", "Research Agent"],
  "depth": 3,
  "status": "idle",
  "cost_today_eur": 0.14,
  "open_hitl_cards": 0,
  "last_run_ts": 1740999000000,
  "last_run_exit_reason": "completed",
  "budget_tokens": 100000,
  "used_tokens_today": 14200,
  "budget_eur": null,
  "cross_branch_trusted": false,
  "tool_allowlist": null
}
```

`last_run_exit_reason` mirrors the `exit_reason` field from `agent.run.completed`. `null` if the agent has never run.

`budget_tokens` is the configured daily token hard limit for this agent (set in `CLAUDE.md` and read by the runner). `used_tokens_today` is the count consumed since the daily reset. Both are `null` if no budget is configured for the agent.

`budget_eur` is reserved for a future euro-denominated budget limit. Always `null` for now. The Boardroom Cost Overview should derive a euro spend figure from `used_tokens_today` using the known per-token rate, not from this field.

---

#### `PUT /agents/{agent_id}`

Updates mutable attributes of an existing agent. Only provided fields are changed; omitted fields are left unchanged.

**Request body**

```json
{
  "agent_name": "Research Agent v2",
  "cross_branch_trusted": true,
  "tool_allowlist": ["sharedspace_read", "sharedspace_list", "request_hitl", "task_complete"]
}
```

| Field                  | Type                   | Required | Notes |
|------------------------|------------------------|----------|-------|
| `agent_name`           | string                 | no       | New display name |
| `agent_title`          | string                 | no       | New title/role description |
| `cross_branch_trusted` | boolean                | no       | When `true`, cross-branch messages are delivered directly without CEO review |
| `tool_allowlist`       | string[] \| null       | no       | When set, the runner rejects any tool call whose name is not in the list. `null` permits all tools. |

**Response `200 OK`** — full agent detail object (same shape as `GET /agents/{agent_id}`)

---

#### `DELETE /agents/{agent_id}`

Deletes the agent and its entire subtree. The server fires a final handover invocation before deletion (see system design doc).

Returns `409 Conflict` in the following cases:

- `agent_active` — the agent's container is currently running (`status: "active"`). Wait for the run to complete.
- `agent_paused` — the agent has a serialised message array in a paused state (`hitl_pause` or `crossbranch_pause`). The container is not running but there is in-flight invocation state. The CEO must either resolve the pending HITL card or release/drop the cross-branch message to clear the pause before deleting.

Silent discard (as with `crossbranch.message.dropped`) is not permitted for paused invocations — the CEO must explicitly resolve the blocking condition first. Add `agent_active` and `agent_paused` to the error code vocabulary in §7.1.

**Response `204 No Content`**

**Error `409 Conflict`**

```json
{
  "error": {
    "code": "agent_paused",
    "message": "Agent 'research-agent' has a paused invocation (hitl_pause). Resolve the pending HITL card before deleting."
  }
}
```

**WS side effect:** `agent.deleted`

---

#### `GET /agents/{agent_id}/claude-md`

Returns the raw content of the agent's `CLAUDE.md` file.

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "content": "# Research Agent\n\nYou are responsible for..."
}
```

---

#### `PUT /agents/{agent_id}/claude-md`

Replaces the agent's `CLAUDE.md`. The previous content is overwritten. This is the only write operation on `CLAUDE.md` — the system never modifies it automatically.

**Request body**

```json
{
  "content": "# Research Agent\n\nYou are responsible for competitive analysis..."
}
```

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "content": "# Research Agent\n\nYou are responsible for competitive analysis..."
}
```

---

#### `GET /agents/{agent_id}/boilerplate`

Returns the auto-generated boilerplate for the agent (position in hierarchy, escalation instructions, inbox instructions, approval policy reference, available tools). This is read-only — boilerplate is regenerated by the server when the tree structure changes.

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "content": "## Position\n\nYou report to Startup A Manager..."
}
```

---

### 7.4 Runs and Activity Feed

#### `GET /agents/{agent_id}/runs`

Lists recent runs for an agent, newest first. Used by the Right Panel to show last run details and to navigate the activity feed history.

**Query parameters**

| Parameter | Type    | Default | Notes |
|-----------|---------|---------|-------|
| `limit`   | integer | `20`    | Maximum number of runs to return |
| `before`  | string  | —       | Return runs older than this `run_id` (cursor-based pagination) |

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "runs": [
    {
      "run_id": "run_01jq8y",
      "trigger_type": "chat",
      "trigger_detail": "Direct message from CEO",
      "started_ts": 1741000000000,
      "completed_ts": 1741000042000,
      "exit_reason": "completed",
      "total_tokens": 14200
    }
  ],
  "has_more": false
}
```

`completed_ts` and `exit_reason` are `null` if the run is still active.

---

#### `GET /agents/{agent_id}/runs/{run_id}/activity`

Returns the full activity feed for a specific run. Used to populate the activity feed tab in the Right Panel when reviewing a HITL card or inspecting an agent's recent run.

**Response `200 OK`**

```json
{
  "run_id": "run_01jq8y",
  "agent_id": "research-agent",
  "status": "completed",
  "entries": [
    {
      "entry_id": "entry_01jqac",
      "entry_type": "tool_call",
      "tool_name": "sharedspace_read",
      "tool_category": "read",
      "detail": "id: work/ventures/startup-a-overview",
      "outcome": null,
      "ts": 1741000001000
    },
    {
      "entry_id": "entry_01jqac",
      "entry_type": "tool_result",
      "tool_name": "sharedspace_read",
      "tool_category": "read",
      "detail": "id: work/ventures/startup-a-overview",
      "outcome": "Page retrieved (1,240 tokens)",
      "ts": 1741000002000
    }
  ]
}
```

Field definitions match `agent.run.activity` (§3.10). `entry_id` is shared by each `tool_call`/`tool_result` pair; see §3.10 for details. `status` is `"active"` if the run is still in progress; the Boardroom should switch to live streaming via WS in that case rather than polling this endpoint.

---

### 7.5 Scheduled Tasks

#### `GET /agents/{agent_id}/schedules`

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "schedules": [
    {
      "schedule_id": "sched_01jqah",
      "cron": "0 9 * * 1",
      "name": "Weekly market research",
      "enabled": true,
      "last_run_ts": 1740960000000,
      "next_run_ts": 1741564800000
    }
  ]
}
```

`last_run_ts` and `next_run_ts` are `null` if the schedule has never run or cannot be computed.

---

#### `POST /agents/{agent_id}/schedules`

**Request body**

```json
{
  "cron": "0 9 * * 1",
  "name": "Weekly market research"
}
```

| Field  | Type   | Required | Notes |
|--------|--------|----------|-------|
| `cron` | string | yes      | Standard 5-field cron expression. Returns `422` if invalid. |
| `name` | string | yes      | Human-readable label shown in the Boardroom |

**Response `201 Created`**

```json
{
  "schedule_id": "sched_01jqah",
  "agent_id": "research-agent",
  "cron": "0 9 * * 1",
  "name": "Weekly market research",
  "enabled": true,
  "last_run_ts": null,
  "next_run_ts": 1741564800000
}
```

---

#### `DELETE /agents/{agent_id}/schedules/{schedule_id}`

**Response `204 No Content`**

---

### 7.6 Budget Management

#### `POST /agents/{agent_id}/budget/reset`

Resets the agent's daily token counter to zero, unblocking it from running again today.

**Request body:** none

**Response `200 OK`**

```json
{
  "agent_id": "research-agent",
  "budget_tokens": 100000,
  "used_tokens": 0
}
```

**WS side effects:** `agent.budget.reset`, then `agent.status.changed` (status → `"idle"`)

---

### 7.7 Chat

One active conversation exists per agent at any time. Starting a new conversation archives the current one; archived conversations are read-only.

#### `GET /agents/{agent_id}/conversations`

Lists all conversations for the agent, newest first. Used to populate the history dropdown in the chat header.

**Response `200 OK`**

```json
{
  "agent_id": "work-coach",
  "conversations": [
    {
      "conversation_id": "conv_01jqae",
      "started_ts": 1741000000000,
      "last_message_ts": 1741000050000,
      "preview": "I've completed the weekly review.",
      "message_count": 12,
      "active": true
    },
    {
      "conversation_id": "conv_01jqa0",
      "started_ts": 1740900000000,
      "last_message_ts": 1740900300000,
      "preview": "Ready to start the week.",
      "message_count": 6,
      "active": false
    }
  ]
}
```

`preview` is the first 80 characters of the most recent agent message in the conversation.

---

#### `POST /agents/{agent_id}/conversations`

Archives the current active conversation (if any) and creates a new empty one.

**Request body:** none

**Response `201 Created`**

```json
{
  "conversation_id": "conv_01jqbf",
  "agent_id": "work-coach",
  "started_ts": 1741001000000,
  "active": true,
  "messages": []
}
```

---

#### `GET /agents/{agent_id}/conversations/{conversation_id}`

Returns a conversation with its full message list. Used when the CEO opens a conversation in chat mode.

**Response `200 OK`**

```json
{
  "conversation_id": "conv_01jqae",
  "agent_id": "work-coach",
  "started_ts": 1741000000000,
  "active": true,
  "messages": [
    {
      "message_id": "msg_01jqaf",
      "role": "agent",
      "content": "Hello. Ready to help.",
      "ts": 1741000000000,
      "run_id": "run_01jqad"
    },
    {
      "message_id": "msg_01jqag",
      "role": "ceo",
      "content": "Please summarise the week.",
      "ts": 1741000010000,
      "run_id": null
    }
  ]
}
```

| Field      | Type            | Notes |
|------------|-----------------|-------|
| `role`     | `"agent"` \| `"ceo"` | |
| `run_id`   | string \| null  | The run that produced this agent message. `null` for CEO messages. |

---

#### `POST /agents/{agent_id}/conversations/{conversation_id}/messages`

Sends a CEO message to the conversation and triggers a new agent run (`trigger_type: "chat"`).

Returns `409 Conflict` if the conversation is not active (i.e. it has been archived) or if the agent is currently running (`status: "active"` or paused). The Boardroom should not rely on this error as the primary guard — the chat input should be disabled whenever the agent's status is anything other than `idle`, so the CEO cannot submit while a run is in progress. The `409` is a server-side safety net for race conditions, not the normal flow.

**Request body**

```json
{
  "content": "Please summarise the week."
}
```

**Response `201 Created`**

```json
{
  "message_id": "msg_01jqag",
  "conversation_id": "conv_01jqae",
  "agent_id": "work-coach",
  "role": "ceo",
  "content": "Please summarise the week.",
  "ts": 1741000010000
}
```

**WS side effects:** `agent.run.started` (shortly after; the runner processes the trigger asynchronously)

---

### 7.8 HITL Queue

#### `GET /hitl`

Returns all open HITL cards across all agents. This is the primary startup fetch — the Boardroom calls this immediately after receiving `connection.state` to get full card details for the queue panel.

**Response `200 OK`**

```json
{
  "cards": [
    {
      "card_id": "card_01jq8z",
      "card_type": "approval",
      "agent_id": "outreach-agent",
      "agent_name": "Outreach Agent",
      "agent_path": ["Work Coach", "Startup A Manager", "Outreach Agent"],
      "subject": "Send cold outreach to 3 prospects",
      "context": "I have drafted emails to three warm leads...",
      "options": null,
      "preference": null,
      "run_id": "run_01jq8y",
      "created_ts": 1741000000000
    }
  ]
}
```

Field definitions match `hitl.card.created` (§3.2). `created_ts` is added here for display ordering (the WS `ts` envelope field serves this purpose on the push path).

---

#### `GET /hitl/{card_id}`

Returns a single HITL card. Used when the Boardroom needs to re-fetch a specific card (e.g. after a reconnect where only one card is stale).

**Response `200 OK`** — same shape as a single item from `GET /hitl`.

---

#### `POST /hitl/{card_id}/decision`

Submits the CEO's decision on a card. The server processes the decision, resumes or discards the agent container, and marks the card resolved.

Returns `409 Conflict` if the card has already been resolved.

**Request body — approval card**

```json
{ "resolution": "approved" }
{ "resolution": "rejected" }
{ "resolution": "returned", "note": "Please check the budget ceiling before sending." }
```

**Request body — choice card**

```json
{ "resolution": "option_selected", "selected_option": 1 }
{ "resolution": "returned", "note": "Consider a fourth option: pause and reassess next week." }
```

| Field             | Type    | Required | Notes |
|-------------------|---------|----------|-------|
| `resolution`      | string  | yes      | Must be valid for the card's `card_type`. `"approved"`/`"rejected"` only for `approval` cards; `"option_selected"` only for `choice` cards; `"returned"` valid for both. |
| `selected_option` | integer | conditional | Required when `resolution` is `"option_selected"`. 0-based index into `options`. |
| `note`            | string  | conditional | Required when `resolution` is `"returned"`. |

**Response `200 OK`**

```json
{
  "card_id": "card_01jq8z",
  "resolution": "approved"
}
```

**WS side effects:** `hitl.card.resolved`, then (for `approved`/`option_selected`/`returned`) `agent.run.started` as the container resumes

---

### 7.9 Cross-Branch Message Queue

#### `GET /crossbranch`

Returns all messages currently awaiting CEO routing. This is fetched at startup alongside `GET /hitl`.

**Response `200 OK`**

```json
{
  "messages": [
    {
      "message_id": "xbmsg_01jq9a",
      "from_agent_id": "strength-programme-agent",
      "from_agent_name": "Strength Programme Agent",
      "from_agent_path": ["Health Coach", "Strength Programme Agent"],
      "to_agent_id": "work-coach",
      "to_agent_name": "Work Coach",
      "to_agent_path": ["Work Coach"],
      "subject": "Flagging schedule conflict for next week",
      "body": "I noticed a potential conflict between the planned travel week...",
      "run_id": "run_01jq9b",
      "arrived_ts": 1741000000000
    }
  ]
}
```

Field definitions match `crossbranch.message.arrived` (§3.4).

---

#### `POST /crossbranch/{message_id}/release`

Releases the message to the recipient's inbox. The runner delivers it, wakes the recipient's container, and resumes the sender.

**Request body:** none

**Response `204 No Content`**

**WS side effects:** `crossbranch.message.released`, then `agent.run.started` for the **sender** (the sending container's serialised message array is resumed), then `inbox.message.delivered` to the recipient, then `agent.run.started` for the **recipient**

---

#### `POST /crossbranch/{message_id}/drop`

Drops the message. The sender's serialised message array is permanently discarded.

**Request body:** none

**Response `204 No Content`**

**WS side effect:** `crossbranch.message.dropped`

---

### 7.10 SharedSpace

SharedSpace pages are stored as `.md` files with YAML frontmatter in the vault directory (`store/vault/` by default). The `page_id` is derived from the file path relative to the vault root (e.g. `work/ventures/startup-a-overview` corresponds to `store/vault/work/ventures/startup-a-overview.md`). SQLite holds a metadata-only index for fast querying; page bodies are read from disk on demand.

The `page_id` path parameter contains forward slashes. Routes must be defined as wildcard/catch-all paths on the server. When constructing URLs in the Boardroom, encode the full `page_id` as-is after the `/sharedspace/` prefix — do not percent-encode the internal slashes, as this is a URL-path hierarchy, not a query parameter.

#### `GET /sharedspace`

Returns the page index: metadata and summaries for pages, without bodies. Used to populate the SharedSpace page tree in the Right Panel.

**Query parameters**

| Parameter | Type   | Default | Notes |
|-----------|--------|---------|-------|
| `as`      | string | (none)  | Optional agent ID. When provided, returns only pages the specified agent can read (based on each page's `access` field). When omitted, returns all pages (CEO view). |

**Response `200 OK`**

```json
{
  "pages": [
    {
      "page_id": "work",
      "title": "Work",
      "summary": "Root page for the Work branch",
      "owner": "work-coach",
      "access": "branch",
      "updated": "2026-03-01T12:00:00.000Z"
    },
    {
      "page_id": "work/ventures/startup-a-overview",
      "title": "Startup A — Overview",
      "summary": "Core thesis, current status, and key contacts for Startup A",
      "owner": "startup-a-manager",
      "access": "branch",
      "updated": "2026-03-02T14:30:00.000Z"
    }
  ]
}
```

Pages are returned sorted by `page_id` (parent before children, siblings alphabetically). The hierarchy is derivable from the `page_id` path segments — the Boardroom computes depth as `page_id.split('/').length - 1`.

---

#### `GET /sharedspace/{page_id}`

Returns a single page including its full markdown body.

**Query parameters**

| Parameter | Type   | Default | Notes |
|-----------|--------|---------|-------|
| `as`      | string | (none)  | Optional agent ID. When provided, access is checked against the page's `access` field for that agent. Returns `404` if the agent cannot read the page. When omitted, reads as CEO (full access). |

**Response `200 OK`**

```json
{
  "page_id": "work/ventures/startup-a-overview",
  "title": "Startup A — Overview",
  "summary": "Core thesis, current status, and key contacts for Startup A",
  "owner": "startup-a-manager",
  "access": "branch",
  "updated": "2026-03-02T14:30:00.000Z",
  "body": "## Core Thesis\n\nStartup A targets..."
}
```

---

#### `PUT /sharedspace/{page_id}`

Creates or updates a page. The operation is idempotent — calling it on a non-existent `page_id` creates the page; calling it on an existing one replaces its content. The page is written to the filesystem as a `.md` file with YAML frontmatter.

**On creation:** `owner` is required. The parent path (everything before the last `/` segment) must already exist as a page on disk or the server returns `404`.

**On update:** `owner` is ignored — ownership cannot change after creation.

**Request body**

```json
{
  "title": "Startup A — Overview",
  "summary": "Core thesis, current status, and key contacts for Startup A",
  "owner": "startup-a-manager",
  "access": "branch",
  "body": "## Core Thesis\n\nStartup A targets..."
}
```

| Field     | Type             | Required on create | Notes |
|-----------|------------------|--------------------|-------|
| `title`   | string           | yes                | |
| `summary` | string           | yes                | One-line; appears in every applicable agent's SharedSpace index context. Recommended maximum: 160 characters. The server does not hard-reject longer values, but the Boardroom should warn the CEO when this limit is exceeded — summaries that are too long silently inflate agent context costs on every run. |
| `owner`   | string           | yes                | Ignored on update |
| `access`  | string \| string[] | no               | Access level: `"ceo-only"` (default), `"owner-and-above"`, `"branch"`, `"everyone"`, or an array of agent IDs |
| `body`    | string           | yes                | Markdown |

**Response `200 OK`** — full page object (same shape as `GET /sharedspace/{page_id}`)

**WS side effect:** `sharedspace.page.updated` with `operation: "created"` or `"updated"`

---

#### `DELETE /sharedspace/{page_id}`

Deletes a page. Returns `409 Conflict` if the page has child pages — delete children first.

**Response `204 No Content`**

**WS side effect:** `sharedspace.page.updated` with `operation: "deleted"`

---

### 7.11 Cost

#### `GET /cost`

Returns cost data for all agents over a specified period.

**Query parameters**

| Parameter | Type   | Default | Values |
|-----------|--------|---------|--------|
| `period`  | string | `today` | `today`, `week`, `month` |

**Response `200 OK`**

```json
{
  "period": "today",
  "from_ts": 1740960000000,
  "to_ts": 1741046400000,
  "total_eur": 1.83,
  "agents": [
    {
      "agent_id": "research-agent",
      "agent_name": "Research Agent",
      "cost_eur": 0.31
    },
    {
      "agent_id": "work-coach",
      "agent_name": "Work Coach",
      "cost_eur": 0.07
    }
  ]
}
```

Agents are sorted by `cost_eur` descending. All monetary values are rounded to 2 decimal places server-side. Agents with zero spend for the period are included with `cost_eur: 0.00`.

---

### 7.12 Server Management

#### `POST /restart`

Triggers a server rebuild and restart. The server responds `200 OK`, spawns a detached process that runs `npm run build && npm run start`, then exits. Output is logged to `server.log` in the server package root.

**Response `200 OK`**

```json
{ "ok": true }
```

The WebSocket connection will drop after the response. The Boardroom auto-reconnects once the new server is up.
