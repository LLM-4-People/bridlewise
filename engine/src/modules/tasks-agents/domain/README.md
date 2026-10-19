# Tasks agents domain

The tasks-agents domain layer: the production authority for handoff protocol semantics and the handoff contracts built on it.

## What each file does

- `handoff-contracts.ts` — The handoff contracts (schemas, snapshots, fingerprints) built on the authority.
- `handoff-protocol-authority.ts` — Production authority for handoff protocol semantics.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/modules/tasks-agents/domain/`.

- `handoff-contracts.ts` is consumed by `engine/scripts/regenerate-handoff-manifest.ts`, `engine/src/modules/tasks-agents/application/admit-handoff.ts`, `engine/src/modules/tasks-agents/application/compile-assignment-contract.ts`, `engine/src/modules/tasks-agents/index.ts`.
- `handoff-protocol-authority.ts` is consumed by `engine/scripts/regenerate-handoff-manifest.ts`, `engine/src/modules/tasks-agents/domain/handoff-contracts.ts`, `engine/src/modules/tasks-agents/index.ts`.

<!-- /consumers:generated -->
