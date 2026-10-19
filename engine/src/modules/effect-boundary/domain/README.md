# Effect boundary domain

The exact-write-lease domain: the schema and authority that define a precise, content-hashed write lease.

## What each file does

- `write-lease.ts` — The exact-write-lease schema and authority (`EXACT_WRITE_LEASE_SCHEMA_VERSION`).

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/modules/effect-boundary/domain/`.

- `write-lease.ts` is consumed by `engine/src/modules/effect-boundary/index.ts`, `engine/src/workflow/workspace-manager.ts`.

<!-- /consumers:generated -->
