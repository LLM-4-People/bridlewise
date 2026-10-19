# Tasks agents

The tasks-agents module: the handoff and assignment protocol subsystem — how work is contracted, admitted, and handed between agents under a single production authority.

## What each file does

- `index.ts` — Re-exports the handoff protocol authority and the assignment contract.

The module's layers live one level down:

- `application/` — admit-handoff + compile-assignment-contract.
- `domain/` — handoff-contracts + handoff-protocol-authority.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/modules/tasks-agents/`.

- `index.ts` is consumed by nothing yet.

<!-- /consumers:generated -->
