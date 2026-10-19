# Awareness domain

The awareness domain owns what the harness computes about a codebase on its
own initiative: the awareness snapshot (complexity, clones, drift, hotspots,
risk), the quality indicators derived from it, the auto-check runner that runs
real validation, and dedup/compression of the content sent to the model. The
snapshot compute runs on a worker thread so it never wedges the request loop.

## What each file does

- `awareness-bridge.ts` — runs the canonical awareness engine on a project and
  returns the snapshot with all computed signals, through the worker pool.
- `awareness-worker.ts` — the worker-thread entry point for the snapshot
  compute.
- `quality-bridge.ts` — derives codebase quality indicators from the awareness
  engine's quality signal.
- `auto-check-runner.ts` — executes real quality and validation checks against
  a project and returns a structured completed status.
- `dedup-bridge.ts` — the single web-UI owner of the dedup-compression adapter
  applied to content before it is sent to the model.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/awareness/`.

- `auto-check-runner.ts` is consumed by `server/blocks/checks.ts`, `server/routes/auto-checks.ts`.
- `awareness-bridge.ts` is consumed by `server/awareness/quality-bridge.ts`, `server/routes/awareness.ts`, `server/routes/projects.ts`.
- `awareness-worker.ts` is consumed by nothing yet.
- `dedup-bridge.ts` is consumed by `server/llm/llm-bridge.ts`, `server/routes/run.ts`, `server/routes/safety.ts`, `server/run/run-executor.ts`.
- `quality-bridge.ts` is consumed by `server/awareness/auto-check-runner.ts`, `server/routes/quality.ts`, `server/run/run-executor.ts`, `server/tools/tool-executor.ts`.

<!-- /consumers:generated -->
