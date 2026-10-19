# Run domain

The run domain owns the lifecycle of a single LLM run: claiming the run so it
executes once, assembling and sending the prompt, dispatching tool calls,
publishing what the run said to whoever is listening, and the worker pool that
runs CPU-heavy analysis off the main thread. Nothing else in the server spends
money or spawns a general-purpose worker — those two facts are mechanically
enforced against this folder.

## What each file does

- `run-executor.ts` — the only module that spends money. Assembles the prompt,
  calls the provider through the LLM bridge, dispatches tools through the tool
  executor, writes the projection, and records the ledger. The first effect is
  a primary-key claim on `run_executions.run_id`, so a second execution of one
  run is refused by the database before a prompt is assembled.
- `run-feed.ts` — the run frame pub/sub. A run publishes frames here and
  subscribers read them, decoupling the run's lifetime from any single HTTP
  response so a second connection does not start a second execution.
- `run-registry.ts` — the process-global table of in-flight runs. Answers
  "does this run exist and whose is it" for the routes, and holds the mutable
  per-run state the executor accumulates while a turn streams.
- `rewind.ts` — conversation rewind. Retracts or replaces a prior turn and
  re-runs from that point, recording the rewind so the ledger stays append-only.
- `attempt-counter.ts` — the per-tool retry badge logic. A pure helper that
  decides the attempt number shown against each tool call in the run stream.
- `worker-pool.ts` — the owner of general-purpose `node:worker_threads`
  spawning. Bridges call `runWorkerTask(...)`; the pool owns spawning,
  same-key dedup, the per-spawn timeout, and shutdown. The one declared
  exception is the database thread (`db/thread-backend.ts`), which outlives
  every task this pool would run.
- `worker-ipc.ts` — the single owner of the `post` helper the worker entry
  points use to forward a shaped result to the parent thread.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/run/`.

- `attempt-counter.ts` is consumed by `server/run/run-executor.ts`.
- `rewind.ts` is consumed by `server/blocks/compose.ts`, `server/context/chat-history.ts`, `server/routes/chats.ts`.
- `run-executor.ts` is consumed by `server/blocks/compose.ts`, `server/routes/run.ts`.
- `run-feed.ts` is consumed by `server/agent/agents-bridge.ts`, `server/index.ts`, `server/routes/run-stream.ts`, `server/run/run-executor.ts`, `server/run/run-registry.ts`.
- `run-registry.ts` is consumed by `server/routes/run-status.ts`, `server/routes/run-stream.ts`, `server/routes/run.ts`, `server/run/run-executor.ts`.
- `worker-ipc.ts` is consumed by `server/awareness/awareness-worker.ts`, `server/db/key-scan-worker.ts`, `server/intelligence/content-search-worker.ts`, `server/intelligence/quick-view-worker.ts`, `server/intelligence/repository-map-worker.ts`, `server/observability/timeline-migration-worker.ts`.
- `worker-pool.ts` is consumed by `server/awareness/awareness-bridge.ts`, `server/db/key-tool.ts`, `server/intelligence/content-search.ts`, `server/intelligence/intelligence-bridge.ts`, `server/observability/timeline-bridge.ts`.

<!-- /consumers:generated -->
