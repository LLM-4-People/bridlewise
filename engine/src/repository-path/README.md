# Repository path

The repository-path domain: the logical path model and the set and map operations over it.

## What each file does

- `contracts.ts` — the contracts module.
- `index.ts` — the index module.
- `logical.ts` — the logical module.
- `set.ts` — the set module.
- `unicode-case-fold.generated.ts` — the unicode-case-fold.generated module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/repository-path/`.

- `contracts.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `engine/src/repository-path/index.ts`, `engine/src/repository-path/logical.ts`, `engine/src/repository-path/set.ts`, `server/kernel/canonical.ts`.
- `index.ts` is consumed by nothing yet.
- `logical.ts` is consumed by `engine/src/repository-path/index.ts`, `engine/src/repository-path/set.ts`.
- `set.ts` is consumed by `engine/src/repository-path/index.ts`.
- `unicode-case-fold.generated.ts` is consumed by `engine/src/repository-path/logical.ts`.

<!-- /consumers:generated -->
