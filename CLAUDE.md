# Octopus

Octopus is a personal operating system that lets one person run an organisation of AI agents. It is a fork of [NanoClaw](https://github.com/anthropics/nanoclaw), an open-source TypeScript/Node.js agent runner, extended with a company-style agent hierarchy, shared wiki, human-in-the-loop controls, and a local web dashboard.

The user is the CEO. Agents are organised in a tree (departments, managers, workers). Every agent runs in an isolated Linux container using the Claude Agent SDK. All state lives in a single SQLite database. Communication between branches routes through the CEO for review. The entire system runs locally — no cloud dependency beyond the LLM API.

## Monorepo layout

```
octopus/
├── packages/
│   ├── server/        # NanoClaw fork — agent runner, REST + WebSocket API
│   └── boardroom/     # React frontend — CEO control centre
├── spec/
│   ├── octopus-spec.md   # Full system design spec
│   └── api-spec.md       # WebSocket + REST API contract
├── package.json       # npm workspace root
└── CLAUDE.md          # this file
```

Uses npm workspaces. `packages/*` are the two workspace members.

## How the packages relate

The **server** (`@octopus/server`) is the backend: it manages the agent tree, spawns containers, enforces budgets and circuit breakers, serves the REST API, and pushes domain events over WebSocket.

The **boardroom** (`@octopus/boardroom`) is the frontend: a single-page React app that connects to the server's WebSocket for real-time events and calls the REST API for CEO actions (approving HITL cards, routing cross-branch messages, chatting with agents, editing SharedSpace pages).

They communicate over `localhost:3000` — WebSocket at `/ws`, REST at `/api/v1`.

## Quick start

```bash
npm install                          # install all workspace deps
npm run build   -w @octopus/server   # compile server TypeScript
npm run start   -w @octopus/server   # start the server (port 3000)
npm run dev     -w @octopus/boardroom # start the frontend dev server
```

The server must be running before the boardroom can connect.

## Specs

Read `spec/octopus-spec.md` for the full system design: agent hierarchy, SharedSpace access rules, cross-branch messaging, HITL mechanism, token budgets, circuit breaker, and prompt assembly.

Read `spec/api-spec.md` for the exact WebSocket event catalogue and REST endpoint contract (methods, paths, status codes, request/response shapes).

## Conventions

- TypeScript throughout, strict mode
- Server: Node.js ESM (`"type": "module"`), compiled with `tsc`
- Frontend: Vite + React, CSS Modules
- Tests: Vitest (server only for now)
- Formatting: Prettier (server)
- Git hooks: Husky (workspace root)
