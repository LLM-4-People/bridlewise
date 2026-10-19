# Concurrent tool dispatch

The unified executor for batches of tool calls. Supports sequential,
parallel, worker, and dependency-ordered dispatch, so a batch of tool calls
is scheduled once and every caller goes through the same executor.

## What each file does

- `index.ts` — the public surface.
- `dispatcher.ts` — the unified executor with its dispatch modes.
- `dependency-graph.ts` — the dependency graph and topological levels:
  explicit `$ref` placeholders and inferred dependencies.
- `worker-pool.ts` — the worker-thread pool for CPU-bound handlers.
- `long-task-runner.ts` — runs long tasks (minutes to hours) from the
  agent's shell without being killed by session cleanup.
- `long-task-wrapper.mjs` — the in-unit wrapper that runs as the
  `ExecStart` of a transient systemd user unit.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/tools/concurrent/`.

- `dependency-graph.ts` is consumed by `engine/src/tools/concurrent/dispatcher.ts`, `engine/src/tools/concurrent/index.ts`.
- `dispatcher.ts` is consumed by `engine/src/tools/concurrent/index.ts`.
- `index.ts` is consumed by nothing yet.
- `long-task-runner.ts` is consumed by `engine/src/cli.mjs`, `engine/src/tools/concurrent/index.ts`.
- `long-task-wrapper.mjs` is consumed by nothing yet.
- `worker-pool.ts` is consumed by `engine/src/tools/concurrent/dispatcher.ts`, `engine/src/tools/concurrent/index.ts`.

<!-- /consumers:generated -->
