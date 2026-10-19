# Blocks

The block layer: the capability units the cockpit renders — each block is a self-describing panel the server composes, evaluates, and streams to the client.

`custody.state` awaits confined Git measurements and two scoped attribution reads. It preserves full conversation turn ordinals and foreign ownership while avoiding repeated full-history reads. Recorded file effects still determine the parcel join; message metadata cannot confer ownership.

## What each file does

- `anatomy.ts` — ANATOMY — `observability.anatomy`: the harness anatomy read (process census + component registry).
- `arm.ts` — ARM — `arm.flags`.
- `breaker.ts` — BREAKER PANEL — `tools.breaker`.
- `checks.ts` — Pilot block — `checks.auto`.
- `client-telemetry.ts` — CLIENT TELEMETRY — the browser's back-channel (`client.telemetry/ingest`): the page's captured facts, redacted, ownership-verified and rate-bounded into the ledger.
- `compose.ts` — CONTEXT DESK — `run.compose`.
- `coverage.ts` — ANNUNCIATOR — the system's honest self-knowledge, as blocks.
- `custody.ts` — CUSTODY — git as verbs.
- `define.ts` — `Block` — the only way a capability enters the system.
- `editor.ts` — the editor module.
- `intelligence.ts` — Code-intelligence blocks.
- `provenance.ts` — The causal-ancestry block — "why does this value exist?".
- `settings.ts` — Settings block — the generic inline write for a declared setting.
- `spectrum.ts` — The read behind the sweep band: a time-binned density skyline of every event.
- `synthesis.ts` — THE SYNTHESIS ENGINE — first blocks.
- `tools.ts` — Tools block — which tools are on for this user, and the switch that governs them.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/blocks/`.

- `anatomy.ts` is consumed by `server/routes/registry.ts`.
- `arm.ts` is consumed by `server/routes/registry.ts`.
- `breaker.ts` is consumed by `server/routes/registry.ts`, `server/run/run-executor.ts`.
- `checks.ts` is consumed by `server/routes/registry.ts`.
- `client-telemetry.ts` is consumed by `server/observability/metrics-bridge.ts`, `server/routes/registry.ts`.
- `compose.ts` is consumed by `server/routes/registry.ts`, `server/routes/run.ts`.
- `coverage.ts` is consumed by `server/routes/registry.ts`.
- `custody.ts` is consumed by `server/routes/registry.ts`.
- `define.ts` is consumed by `server/blocks/anatomy.ts`, `server/blocks/arm.ts`, `server/blocks/breaker.ts`, `server/blocks/checks.ts`, `server/blocks/client-telemetry.ts`, `server/blocks/compose.ts` and 13 more.
- `editor.ts` is consumed by `server/routes/registry.ts`.
- `intelligence.ts` is consumed by `server/routes/intelligence.ts`, `server/routes/registry.ts`.
- `provenance.ts` is consumed by `server/routes/registry.ts`.
- `settings.ts` is consumed by `server/routes/registry.ts`.
- `spectrum.ts` is consumed by `server/routes/registry.ts`.
- `synthesis.ts` is consumed by `server/routes/registry.ts`.
- `tools.ts` is consumed by `server/routes/registry.ts`.

<!-- /consumers:generated -->
