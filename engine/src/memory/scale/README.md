# Memory scale store

The billion-token memory store: a sharded SQLite + FTS5 inverted index that
keeps retrieval bounded regardless of memory size. Entries are distributed
across N shards by hash; each shard keeps an on-disk FTS5 inverted index
(BM25 ranking) plus a bounded in-RAM hot cache.

## What each file does

- `memory-store-1b.ts` — the sharded store: FTS5 inverted index per shard,
  lazy content loading, batched transactional inserts, and the hot/cold
  tier split.
- `scale-config.ts` — the centralized configuration owner for the scale
  store: every threshold is a declared configurable.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/memory/scale/`.

- `memory-store-1b.ts` is consumed by `engine/scripts/exp452/run-exp452.mjs`.
- `scale-config.ts` is consumed by `engine/scripts/exp452/run-exp452.mjs`, `engine/src/memory/scale/memory-store-1b.ts`.

<!-- /consumers:generated -->
