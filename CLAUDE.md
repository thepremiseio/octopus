You are implementing a series of code modifications to a forked version of NanoClaw, an open-source TypeScript/Node.js agent runner. The fork is called Octopus.

Read spec/octopus-spec.md and spec/api-spec.md in full before writing any code.

The repo is a monorepo with this layout:

    octopus/
    ├── packages/
    │   ├── server/        ← the NanoClaw fork (current codebase)
    │   └── boardroom/     ← the new frontend
    ├── package.json       ← workspace root
    └── spec/
        ├── octopus-spec.md
        └── api-spec.md

All server-side source paths (src/, setup/, container/, etc.) live under packages/server/.

Do not modify any file that is not listed below. Do not invent abstractions beyond what the specs require. Where the specs are silent on implementation detail, choose the simplest approach consistent with the existing codebase.

Implement the following changes in order, as each builds on the previous. Use your todo list to track each of the 8 tasks. Mark a task complete only after confirming the interfaces it exposes are consistent with dependent tasks.

1. Agent hierarchy schema — packages/server/src/db.ts
Add the SQLite schema for the agent tree: a table storing each agent's ID, display name, parent ID, depth, and status. Ordered depth-first. Include the helpers needed to read the full tree, insert a node, delete a node and its subtree, and look up an agent's ancestry chain and descendants (both needed for SharedSpace access control).
2. Token budget and circuit breaker — packages/server/src/db.ts, packages/server/src/container-runner.ts
In db.ts: add tables for daily token usage per agent and the activity feed (timestamp, agent ID, run ID, tool name, tool category, arguments, outcome).
In container-runner.ts: after each run, record tokens consumed and check against the configured daily budget. If the budget is exceeded, block the next container start and emit agent.budget.exceeded. Implement the circuit breaker: track action count per agent in a sliding window across invocations using the activity feed table; if the threshold is exceeded mid-run, pause the agent, write a circuit_breaker HITL card to the queue (see API spec §3.2 for its shape), and emit agent.budget.circuit_breaker.
3. WebSocket and REST server — packages/server/src/channels/dashboard.ts (replaces src/channels/whatsapp.ts)
Implement the full server contract from the API spec: WebSocket endpoint at ws://localhost:{NANOCLAW_PORT}/ws, REST API at http://localhost:{NANOCLAW_PORT}/api/v1. On every WebSocket connection send connection.ready then connection.state with no events interleaved. Broadcast all domain events to all connected clients. Implement every REST endpoint listed in API spec §7.2 with the exact HTTP methods, paths, status codes, request bodies, and response shapes defined there. Error responses must use the envelope from §7.1.
4. SharedSpace service — packages/server/src/sharedspace.ts, packages/server/src/db.ts, packages/server/src/tools.ts
In db.ts: add the SharedSpace pages table (page ID, title, summary, owner agent ID, last updated by, timestamp, markdown body, parent ID, depth). Add the cached SharedSpace index table and invalidation logic (recompute when a page in an agent's readable scope is created, deleted, renamed, or has its summary changed).
In sharedspace.ts: implement tree-aware access control using the agent hierarchy from step 1. Read rules: ancestry chain plus own subtree one level deep. Write rules: own level and below. CEO has full access.
In tools.ts: implement sharedspace_read(id), sharedspace_write(id, content), and sharedspace_list(prefix?). Each call is tagged with the requesting agent's ID; enforce access rules before executing. On any write, invalidate the cached index for all agents whose readable scope includes this page, then emit sharedspace.page.updated.
5. Prompt assembly — packages/server/src/container-runner.ts
At container start, assemble the system prompt in this exact order: (1) the agent's CLAUDE.md content, (2) the auto-generated boilerplate (hierarchy position, manager name, escalation instruction, inbox instruction, approval policy reference, available tools), (3) the cached SharedSpace index for this agent. If the agent has unread inbox messages, prepend an inbox notification to the boilerplate section. Pull the cached index from SQLite; do not recompute it at runtime.
6. Activity feed — packages/server/src/container-runner.ts, packages/server/src/db.ts
Intercept every tool call and tool result in the runner's event stream. For each, append a row to the activity feed table using the schema from step 2. Set tool_category according to the mapping: sharedspace_read, sharedspace_list → read; sharedspace_write → write; request_hitl → hitl; send_message → message; shell tools → shell. Emit agent.run.activity over WebSocket for each entry (see API spec §3.10 for payload shape). Feed the circuit breaker check in step 2 from these entries.
7. Cross-branch messaging — packages/server/src/tools.ts, packages/server/src/container-runner.ts, packages/server/src/db.ts
In db.ts: add the cross_branch_queue table with columns for message ID, sender, recipient, subject, body, run ID, serialised message array, and arrival timestamp.
In tools.ts: implement send_message(to, subject, body). For same-branch messages (sender and recipient share a top-level branch), deliver directly to the recipient's inbox and queue a container wake-up. For cross-branch messages, serialise the sender's message array to the queue, terminate the sender's container, emit crossbranch.message.arrived, and block until the CEO acts. On CEO release (POST /crossbranch/{message_id}/release): deliver to recipient's inbox, emit crossbranch.message.released, resume the sender's container with trigger_type: "crossbranch_resume", and queue a container start for the recipient. On CEO drop (POST /crossbranch/{message_id}/drop): discard the serialised array permanently and emit crossbranch.message.dropped.
8. HITL queue — packages/server/src/tools.ts, packages/server/src/container-runner.ts, packages/server/src/db.ts
In db.ts: add the hitl_queue table with columns for card ID, card type, agent ID, subject, context, options (JSON), preference, run ID, serialised message array, and resolution.
In tools.ts: implement request_hitl(type, subject, context, options?, preference?). For approval and choice cards: serialise the message array, write the card, emit hitl.card.created, terminate the container. For fyi cards: write the card, emit hitl.card.created, do not terminate. For circuit_breaker cards (written by the runner in step 2, not the agent): same behaviour as approval.
In container-runner.ts: implement the CEO-resume path. On POST /hitl/{card_id}/decision: validate the resolution against the card type (see API spec §7.8), rehydrate the message array, append the decision as a tool_result on the pending tool_use block, start a fresh container with trigger_type: "hitl_resume", mark the card resolved, emit hitl.card.resolved.
