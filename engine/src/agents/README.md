# Agents

The agent domain: the agent type registry, the agent state store, and the contracts for delegated and background work.

## What each file does

- `agent-config.ts` — the agent-config module.
- `agent-runtime.ts` — the agent-runtime module.
- `agent-state.ts` — the agent-state module.
- `agent-type-background.ts` — the agent-type-background module.
- `agent-type-call-return.ts` — the agent-type-call-return module.
- `agent-type-registry.ts` — the agent-type-registry module.
- `agents-config.ts` — the agents-config module.
- `index.ts` — the index module.
- `orchestrator.ts` — the orchestrator module.
- `stigmergy-coordination.ts` — the stigmergy-coordination module.
- `workspace-peek.ts` — the workspace-peek module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/agents/`.

- `agent-config.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/agent-type-background.ts`, `engine/src/agents/agent-type-call-return.ts`, `engine/src/agents/agent-type-registry.ts`, `engine/src/agents/index.ts`, `engine/src/agents/orchestrator.ts` and 5 more.
- `agent-runtime.ts` is consumed by `engine/src/agents/agent-type-background.ts`, `engine/src/agents/agent-type-call-return.ts`, `engine/src/agents/agent-type-registry.ts`, `engine/src/agents/index.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/runtime/agent-tools.ts` and 1 more.
- `agent-state.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/agent-type-background.ts`, `engine/src/agents/agent-type-registry.ts`, `engine/src/agents/index.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/agents/workspace-peek.ts` and 2 more.
- `agent-type-background.ts` is consumed by `engine/src/agents/index.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/agents/workspace-peek.ts`.
- `agent-type-call-return.ts` is consumed by `engine/src/agents/index.ts`, `engine/src/agents/orchestrator.ts`.
- `agent-type-registry.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/agent-type-background.ts`, `engine/src/agents/agent-type-call-return.ts`, `engine/src/agents/index.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/kernel/config-contracts.ts` and 1 more.
- `agents-config.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/agent-state.ts`, `engine/src/agents/agent-type-background.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/agents/workspace-peek.ts`, `engine/src/shared/exposure/registrations/agents.ts` and 1 more.
- `index.ts` is consumed by nothing yet.
- `orchestrator.ts` is consumed by `engine/src/agents/index.ts`, `engine/src/agents/stigmergy-coordination.ts`, `engine/src/index.ts`, `engine/src/runtime/orchestrator-tools.ts`.
- `stigmergy-coordination.ts` is consumed by nothing yet.
- `workspace-peek.ts` is consumed by `engine/src/agents/index.ts`.

<!-- /consumers:generated -->
