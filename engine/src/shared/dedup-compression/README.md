# Dedup and compression lower layer

Transparent deduplication and compression applied below the API to all data
flowing through the harness. Modules call `store(data, moduleId)` and
`retrieve(id)` without knowing dedup or compression happened — the layer
dedups, compresses, stores, and reverses it on read.

## What each file does

- `index.ts` — the public API: `store`/`retrieve`.
- `lower-layer.ts` — the lower layer itself: the store→dedup→compress→keep
  pipeline.
- `dedup.ts` — the dedup engine (line, token, and structural techniques).
- `compression.ts` / `decompression.ts` — the lossless compression and its
  inverse.
- `dynamic-keywords.ts` — dynamic keyword detection for the dedup engine.
- `config.ts` — the single source of truth for the layer's tunables.
- `exposure.ts` — the exposure signals for the layer.
- `module-integration.ts` — wires the layer into each module.
- `shared-helpers.ts` — helpers shared inside the layer.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/dedup-compression/`.

- `compression.ts` is consumed by `engine/src/shared/dedup-compression/index.ts`, `engine/src/shared/dedup-compression/lower-layer.ts`.
- `config.ts` is consumed by `engine/src/shared/dedup-compression/compression.ts`, `engine/src/shared/dedup-compression/decompression.ts`, `engine/src/shared/dedup-compression/dedup.ts`, `engine/src/shared/dedup-compression/dynamic-keywords.ts`, `engine/src/shared/dedup-compression/exposure.ts`, `engine/src/shared/dedup-compression/index.ts` and 2 more.
- `decompression.ts` is consumed by `engine/src/shared/dedup-compression/index.ts`, `engine/src/shared/dedup-compression/lower-layer.ts`.
- `dedup.ts` is consumed by `engine/src/shared/dedup-compression/index.ts`, `engine/src/shared/dedup-compression/lower-layer.ts`.
- `dynamic-keywords.ts` is consumed by `engine/src/shared/dedup-compression/dedup.ts`, `engine/src/shared/dedup-compression/index.ts`.
- `exposure.ts` is consumed by `engine/src/shared/dedup-compression/index.ts`.
- `index.ts` is consumed by `engine/src/shared/dedup-compression/module-integration.ts`, `engine/src/shared/exposure/registrations/dedup.ts`, `server/awareness/dedup-bridge.ts`.
- `lower-layer.ts` is consumed by `engine/src/shared/dedup-compression/exposure.ts`, `engine/src/shared/dedup-compression/index.ts`.
- `module-integration.ts` is consumed by `engine/src/shared/dedup-compression/index.ts`.
- `shared-helpers.ts` is consumed by `engine/src/shared/dedup-compression/dedup.ts`, `engine/src/shared/dedup-compression/dynamic-keywords.ts`, `engine/src/shared/dedup-compression/lower-layer.ts`.

<!-- /consumers:generated -->
