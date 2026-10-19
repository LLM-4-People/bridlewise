# Tasks agents application

The tasks-agents application layer: the use-cases that admit a handoff and compile an assignment contract, driving the domain authority.

## What each file does

- `admit-handoff.ts` — Admit a handoff under the admission context.
- `compile-assignment-contract.ts` — Snapshots an untrusted assignment exactly once before schema or hash work.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/modules/tasks-agents/application/`.

- `admit-handoff.ts` is consumed by `engine/src/modules/tasks-agents/index.ts`.
- `compile-assignment-contract.ts` is consumed by `engine/src/modules/tasks-agents/application/admit-handoff.ts`, `engine/src/modules/tasks-agents/index.ts`.

<!-- /consumers:generated -->
