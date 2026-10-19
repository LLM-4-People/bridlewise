# Memory

The memory domain: the persistent memory store, its backends, and the retrieve and inject paths that carry context between sessions.

## What each file does

- `attempt-history.ts` — the attempt-history module.
- `context-helpers.ts` — the context-helpers module.
- `memory-config.ts` — the memory-config module.
- `memory-search.ts` — the memory-search module.
- `memory-store.ts` — the memory-store module.
- `memory-types.ts` — the memory-types module.
- `tool-result-exposure.ts` — Test-only hook to reset the registration flag AND clear the shared exposure registry.
- `tool-result-retrieval.ts` — Semantic retrieval for the tool-result-in-memory store (EXP433).
- `tool-result-store.ts` — Tool-result-in-memory store (EXP433).
- `tool-result-summary.ts` — Deterministic per-tool-type summary generator for the tool-result-in-memory.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/memory/`.

- `attempt-history.ts` is consumed by `engine/src/runtime/interactive-session.ts`.
- `context-helpers.ts` is consumed by `engine/src/memory/unified/unified-context-manager.ts`.
- `memory-config.ts` is consumed by `engine/src/memory/attempt-history.ts`, `engine/src/memory/context-helpers.ts`, `engine/src/memory/unified/trust-enforcer.ts`, `engine/src/memory/unified/unified-tool-result-store.ts`.
- `memory-search.ts` is consumed by `engine/src/memory/attempt-history.ts`, `engine/src/memory/memory-store.ts`.
- `memory-store.ts` is consumed by `engine/src/index.ts`, `engine/src/memory/attempt-history.ts`, `server/kernel/canonical.ts`.
- `memory-types.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `engine/src/memory/attempt-history.ts`, `engine/src/memory/memory-search.ts`, `engine/src/memory/memory-store.ts`, `engine/src/memory/scale/memory-store-1b.ts`, `engine/src/memory/tool-result-store.ts` and 2 more.
- `tool-result-exposure.ts` is consumed by nothing yet.
- `tool-result-retrieval.ts` is consumed by `engine/src/memory/tool-result-store.ts`.
- `tool-result-store.ts` is consumed by nothing yet.
- `tool-result-summary.ts` is consumed by `engine/src/memory/tool-result-store.ts`.

<!-- /consumers:generated -->
