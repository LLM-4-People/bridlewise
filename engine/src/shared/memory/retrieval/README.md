# Shared memory retrieval

The canonical retrieval math for all memory and search: each primitive is
owned once here so every consumer shares one implementation rather than
re-deriving it.

## What each file does

- `retriever.ts` — the canonical retrieval facade: the single entry point
  that dispatches to the backends.
- `cosine.ts` — the canonical cosine similarity.
- `tfidf.ts` — the canonical TF-IDF index and query.
- `embeddings.ts` — the canonical embeddings provider (the lazy
  `@xenova/transformers` loader).
- `hnsw.ts` — the minimal pure-TS HNSW vector index.
- `inverted-index.ts` — the posting-list inverted index for lexical
  retrieval.
- `rrf.ts` — reciprocal rank fusion.
- `text-utils.ts` — the canonical tokenizer.
- `types.ts` — the shared retrieval types.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/memory/retrieval/`.

- `cosine.ts` is consumed by `engine/src/memory/tool-result-retrieval.ts`, `engine/src/quality-packs/prevention/embedding-provider.ts`, `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/hnsw.ts`, `engine/src/shared/memory/retrieval/retriever.ts`, `engine/src/shared/memory/retrieval/tfidf.ts`.
- `embeddings.ts` is consumed by `engine/src/quality-packs/prevention/embedding-provider.ts`, `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/retriever.ts`, `engine/src/shared/memory/shared-memory-store.ts`.
- `hnsw.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/retriever.ts`.
- `inverted-index.ts` is consumed by `engine/src/memory/memory-search.ts`, `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/retriever.ts`.
- `retriever.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/shared-memory-store.ts`.
- `rrf.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/retriever.ts`.
- `text-utils.ts` is consumed by `engine/src/memory/memory-search.ts`, `engine/src/memory/tool-result-retrieval.ts`, `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/inverted-index.ts`, `engine/src/shared/memory/retrieval/retriever.ts`, `engine/src/shared/memory/retrieval/tfidf.ts` and 1 more.
- `tfidf.ts` is consumed by `engine/src/memory/tool-result-retrieval.ts`, `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/retrieval/retriever.ts`.
- `types.ts` is consumed by `engine/src/shared/memory/retrieval/embeddings.ts`, `engine/src/shared/memory/retrieval/retriever.ts`, `engine/src/shared/memory/retrieval/rrf.ts`.

<!-- /consumers:generated -->
