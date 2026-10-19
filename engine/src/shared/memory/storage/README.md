# Shared memory storage

The storage backends for the shared memory store. The agnostic contract is
shared (`backend.ts` + `serde.ts`); each backend is its own file, so adding
a backend is adding a file and registering it in the factory.

## What each file does

- `backend.ts` — the storage backend interface and factory: the single
  owner of the contract.
- `serde.ts` — the canonical serialization for a memory entry (the types
  JSON cannot carry).
- `json-backend.ts` — JSON file storage.
- `append-log-backend.ts` — append-only newline-delimited JSON log storage,
  for write-heavy workloads and replay.
- `msgpack-backend.ts` — MessagePack storage via a pure-TS minimal
  encoder/decoder.
- `sqlite-backend.ts` — SQLite storage via the built-in `node:sqlite`,
  indexed for large cold tiers with structured queries.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/memory/storage/`.

- `append-log-backend.ts` is consumed by `engine/src/shared/memory/storage/backend.ts`.
- `backend.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/shared-memory-store.ts`, `engine/src/shared/memory/storage/append-log-backend.ts`, `engine/src/shared/memory/storage/json-backend.ts`, `engine/src/shared/memory/storage/msgpack-backend.ts`, `engine/src/shared/memory/storage/sqlite-backend.ts`.
- `json-backend.ts` is consumed by `engine/src/shared/memory/storage/backend.ts`.
- `msgpack-backend.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/storage/backend.ts`.
- `serde.ts` is consumed by `engine/src/shared/memory/index.ts`, `engine/src/shared/memory/storage/append-log-backend.ts`, `engine/src/shared/memory/storage/json-backend.ts`, `engine/src/shared/memory/storage/msgpack-backend.ts`, `engine/src/shared/memory/storage/sqlite-backend.ts`.
- `sqlite-backend.ts` is consumed by `engine/src/shared/memory/storage/backend.ts`.

<!-- /consumers:generated -->
