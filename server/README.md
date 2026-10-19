# Server

The API server and trust boundary. It binds to 127.0.0.1 only, serves the
client build, owns the database and sessions, and enforces auth, CSRF, rate
limiting, and error mapping at the routing choke point. The database is the
source of truth for chats, users, providers, and projects.

## What each file does

- `index.ts` — the loopback HTTP+SSE server entry point: the trust boundary.
  Validates all outbound data with the canonical schemas and wires every
  route through the router.
- `web-tree-sitter.d.ts` — a minimal type declaration for `web-tree-sitter`,
  which is not installed in the web workspace.

## The domains

- `agent/` — the bridges between the engine's agent runtime and the server.
- `auth/` — password hashing, sessions, CSRF, and the user-context gate.
- `awareness/` — the bridges and workers serving awareness, quality, and
  dedup signals.
- `blocks/` — the block machinery: one block declaration projected into
  routes, schemas, and UI.
- `context/` — chat history, project context, and memory bridges.
- `db/` — the single database client: every read and write, encrypted at
  rest, scoped and gated here rather than in each route.
- `filesystem/` — server-side filesystem browsing and atomic writes.
- `integrations/` — external integrations (MCP runtime bridge and friends).
- `intelligence/` — code intelligence served to the client.
- `kernel/` — the server's shared kernel helpers.
- `llm/` — the server's relationship with model providers: provider storage,
  the shared LLM client wiring, and PII redaction before anything leaves the
  process.
- `observability/` — metrics, debug, and audit surfacing.
- `router/` — the HTTP boundary: routing, middleware, validation, rate
  limiting, SSE.
- `routes/` — the route handlers, organized by surface.
- `run/` — chat run execution, streaming, and the run registry.
- `safety/` — the server-side safety gates.
- `schema/` — the served UI schema builders.
- `tools/` — server-side tool execution.

Each domain folder's own README lists its files; the consumer lists are
generated from the import graph.
