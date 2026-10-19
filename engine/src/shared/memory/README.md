# Shared memory

The shared memory architecture: the multi-layer (hot/warm/cold) store, the
canonical memory entry, the tree classification, and the token-cap pruning,
all owned once. The retrieval math and the storage backends are in the
`retrieval/` and `storage/` subfolders.

## What each file does

- `index.ts` — the public API barrel for the shared memory architecture.
- `shared-memory-store.ts` — the multi-layer shared memory store with tree
  classification and full metadata.
- `memory-entry.ts` — the canonical memory entry shape.
- `memory-config.ts` — the single canonical owner of all shared-memory
  configuration.
- `memory-exposure.ts` — the module's exposure registrations.
- `memory-tree.ts` — the tree classification: project → conversation → type
  → entry.
- `ebbinghaus.ts` — the canonical Ebbinghaus forgetting-curve and
  spaced-repetition scoring.
- `token-cap.ts` — the single owner of the token-cap pruning and
  compression strategies.

## The subfolders

- `retrieval/` — the canonical retrieval math: cosine, TF-IDF, embeddings,
  HNSW, inverted index, RRF.
- `storage/` — the storage backends behind the single backend contract.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/memory/`.

- `ebbinghaus.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/shared-memory-store.ts`, `engine/src/shared/memory/token-cap.ts`.
- `index.ts` is consumed by nothing yet.
- `memory-config.ts` is consumed by `engine/src/shared/memory/ebbinghaus.ts`, `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/memory-entry.ts`, `engine/src/shared/memory/memory-exposure.ts`, `engine/src/shared/memory/memory-tree.ts`, `engine/src/shared/memory/retrieval/embeddings.ts` and 4 more.
- `memory-entry.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/memory-tree.ts`, `engine/src/shared/memory/retrieval/retriever.ts`, `engine/src/shared/memory/shared-memory-store.ts`, `engine/src/shared/memory/storage/append-log-backend.ts`, `engine/src/shared/memory/storage/backend.ts` and 5 more.
- `memory-exposure.ts` is consumed by `engine/src/shared/memory/index.ts`.
- `memory-tree.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/shared-memory-store.ts`.
- `shared-memory-store.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/memory-exposure.ts`.
- `token-cap.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/shared-memory-store.ts`.

<!-- /consumers:generated -->
