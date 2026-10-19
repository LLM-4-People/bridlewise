# Observability domain

The observability domain owns what the harness records about itself: debug
logging, performance metrics, the timeline ledger of what happened, and the
self-improving analysis that turns recorded performance into suggestions. Every
event flows through here; nothing logs or records ad hoc.

The ledger's own SQL lives in the engine's timeline domain
(`engine/src/timeline/` — the store that writes it and the dig reader that
reads it); this domain holds the server's bridges to that ledger.

## What each file does

- `component-registry.ts` — the in-process half of the harness anatomy: the
  live registry of the server's own components (worker threads, DB threads,
  folder watches, the sampler timer, run feeds, stdio MCP children). Every
  choke point that creates a component registers on its own create/destroy
  path; a closed component leaves. The `observability.anatomy` block read
  and `scripts/trace.ts anatomy` read it through this module's snapshot.
- `debug-bridge.ts` — the single entry point for all debug and error logging;
  when not in debug mode it is a no-op.
- `metrics-bridge.ts` — the adapter to the canonical metrics collector,
  exposing a live call/error snapshot, the system resource snapshot, and the
  process resource sampler: a periodic, best-effort tick (config:
  `performance.resourceSampler.enabled`/`intervalMs`) that writes RSS, heap
  used, event-loop utilization and CPU user/system deltas into the ledger's
  `resource` lane on an unref'd timer, started by the server bootstrap and
  stopped at shutdown.
- `metrics-recorder.ts` — lightweight recording hooks that do not import the
  canonical chain at module load time; `recordLlmCall`/`recordToolCall` carry
  an optional resource delta (CPU + heap) into the collector's per-scope
  aggregates when the `performance.resourceDeltas.enabled` gate is on.
- `process-census.ts` — the machine half of the harness anatomy: the /proc
  walk (one enumeration, consumed by `sd.mjs`'s stale reconciliation AND the
  anatomy view), the argv pattern tables that say which process shapes this
  repo's server tree starts (the kill scope) plus the display-only operator
  tools, and per-process facts — pid, parent chain to init, start time, cwd,
  cmdline, sampled CPU, RSS, classification, provenance. Read-only: the
  census never signals anything; `sd.mjs` re-applies the cwd gate on top.
- `self-improving.ts` — tracks harness performance and suggests improvements
  in the metrics dashboard.
- `timeline-bridge.ts` — the adapter to the canonical timeline store, owning
  the persistent ledger of runs and effects. Its effect sink writes the
  timing document (`effect-timing`: duration plus, when the resource-deltas
  gate is on, `cpuMs`/`heapDeltaBytes`), the effect's redacted invocation
  arguments as their own `effect-args` document, and any documents the effect
  captured — all bounded through the same fitting path seeded by
  `TRUNCATION_ENVELOPE_OVERHEAD_BYTES`.
- `timeline-scope.ts` — shared web list/spectrum authorization. It resolves
  the selected ledger and intersects every selection with the authenticated
  user's DB-owned runs before query counts, cursors, ranges or bins. Trace
  membership hides unknown traces; it does not authorize other trace rows.
- `timeline-migration-worker.ts` — the ledger's migration worker (SCALE-CR1 C10): runs a ledger's pending migrations (`migrateTimelineFile`) off the serving thread through the one task pool, so the server listens while a large ledger migrates; the bridge (`startTimeline`) opens the ledger when it answers.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/observability/`.

- `component-registry.ts` is consumed by `server/blocks/anatomy.ts`, `server/db/thread-backend.ts`, `server/integrations/mcp-runtime-bridge.ts`, `server/intelligence/intelligence-bridge.ts`, `server/kernel/harness-config.ts`, `server/observability/metrics-bridge.ts` and 3 more.
- `debug-bridge.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/awareness/auto-check-runner.ts`, `server/awareness/dedup-bridge.ts`, `server/blocks/intelligence.ts`, `server/db/client.ts`, `server/db/conversation-archive.ts` and 29 more.
- `metrics-bridge.ts` is consumed by `server/index.ts`, `server/routes/metrics.ts`.
- `metrics-recorder.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/llm/llm-bridge.ts`, `server/observability/metrics-bridge.ts`, `server/tools/tool-executor.ts`.
- `process-census.ts` is consumed by `server/blocks/anatomy.ts`.
- `self-improving.ts` is consumed by `server/observability/metrics-bridge.ts`, `server/routes/metrics.ts`.
- `timeline-bridge.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/agent/agents-bridge.ts`, `server/blocks/arm.ts`, `server/blocks/breaker.ts`, `server/blocks/client-telemetry.ts`, `server/blocks/compose.ts` and 18 more.
- `timeline-migration-worker.ts` is consumed by nothing yet.
- `timeline-scope.ts` is consumed by `server/blocks/spectrum.ts`, `server/routes/timeline.ts`.

<!-- /consumers:generated -->
