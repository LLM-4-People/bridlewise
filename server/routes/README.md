# Routes

The HTTP route layer: every API endpoint the web UI calls — one file per resource, all registered through the single route registry that owns auth, validation, and error mapping.

## What each file does

- `agents.ts` — Agents route — returns the current agent states, available agent types.
- `auth.ts` — Auth routes — multi-user authentication.
- `auto-checks.ts` — Auto-checks routes — backed by the SQLite projection.
- `awareness.ts` — Awareness routes — codebase awareness signals (complexity, clones, …).
- `chats.ts` — Chat routes — backed by the SQLite projection.
- `config.ts` — Config route — reads the real harness config (not a fixture).
- `editor.ts` — Editor routes — file reading, writing, and editing within the project root.
- `extensions.ts` — Extensions routes — list configured extensions and manifest info.
- `filesystem.ts` — Filesystem routes — server-side directory browsing.
- `file-tree.ts` — File tree routes — list files (not just directories) in a project.
- `git-ops.ts` — Git operations routes — branches, log, diff, status for a project.
- `health.ts` — Health check route — reports server liveness and harness readiness.
- `intelligence.ts` — Intelligence routes — code graph, repository map, symbol search.
- `live.ts` — THE STANDING LIVENESS STREAM — the socket that answers "is the API there".
- `mcp.ts` — MCP routes — list configured MCP servers with live connection status.
- `memory.ts` — Memory route — searches and retrieves from the real harness memory store.
- `metrics.ts` — Metrics route — returns a combined metrics payload.
- `models.ts` — Model providers — the HTTP surface over the user's saved providers.
- `projects.ts` — Project routes — backed by the SQLite projection (server/db).
- `quality.ts` — Quality routes — codebase quality indicator and recommendations.
- `registry.ts` — Route registry — the SINGLE owner of route registration.
- `run.ts` — RUN CONTROL — start, cancel, steer. Every route here is a POST.
- `run-status.ts` — THE RUN'S ONE STATUS READ — a GET-only module answering liveness from the registry alone.
- `run-stream.ts` — THE RUN STREAM — a subscriber, and only a subscriber.
- `safety.ts` — Safety feature testing routes — lets the user trigger each detector.
- `schema.ts` — Schema route — serves the schema-driven UI extension manifest.
- `settings.ts` — Settings routes — per-user preferences stored encrypted in the DB.
- `timeline.ts` — Timeline route — queries the timeline event ledger.
- `tools.ts` — Tools route — returns the tool manifest (built-in + MCP).
- `views.ts` — DB row → client view mappers. The single owner of the snake_case → camelCase mapping.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/routes/`.

- `agents.ts` is consumed by `server/routes/registry.ts`.
- `auth.ts` is consumed by `server/routes/registry.ts`.
- `auto-checks.ts` is consumed by `server/routes/registry.ts`.
- `awareness.ts` is consumed by `server/routes/registry.ts`.
- `chats.ts` is consumed by `server/routes/registry.ts`.
- `config.ts` is consumed by `server/routes/registry.ts`.
- `editor.ts` is consumed by `server/routes/registry.ts`.
- `extensions.ts` is consumed by `server/routes/registry.ts`.
- `file-tree.ts` is consumed by `server/routes/registry.ts`.
- `filesystem.ts` is consumed by `server/routes/registry.ts`.
- `git-ops.ts` is consumed by `server/routes/registry.ts`.
- `health.ts` is consumed by `server/routes/registry.ts`.
- `intelligence.ts` is consumed by `server/routes/registry.ts`.
- `live.ts` is consumed by `server/routes/registry.ts`.
- `mcp.ts` is consumed by `server/routes/registry.ts`.
- `memory.ts` is consumed by `server/routes/registry.ts`.
- `metrics.ts` is consumed by `server/routes/registry.ts`.
- `models.ts` is consumed by `server/routes/registry.ts`.
- `projects.ts` is consumed by `server/routes/registry.ts`.
- `quality.ts` is consumed by `server/routes/registry.ts`.
- `registry.ts` is consumed by `server/index.ts`.
- `run-status.ts` is consumed by `server/routes/registry.ts`.
- `run-stream.ts` is consumed by `server/routes/registry.ts`.
- `run.ts` is consumed by `server/routes/registry.ts`.
- `safety.ts` is consumed by `server/routes/registry.ts`.
- `schema.ts` is consumed by `server/routes/registry.ts`.
- `settings.ts` is consumed by `server/routes/registry.ts`.
- `timeline.ts` is consumed by `server/routes/registry.ts`.
- `tools.ts` is consumed by `server/routes/registry.ts`.
- `views.ts` is consumed by `server/blocks/checks.ts`, `server/routes/auto-checks.ts`, `server/routes/chats.ts`, `server/routes/projects.ts`.

<!-- /consumers:generated -->
