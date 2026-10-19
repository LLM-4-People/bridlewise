# Agent domain

The agent domain owns delegated work: the agent types the harness can run, the
state of agents in flight, and the restriction sets that bound what a delegated
agent may touch. The main thread delegates; it never lets a sub-agent exceed
its recorded restrictions.

## What each file does

- `agent-runtime-bridge.ts` — the single owner of web-run agent delegation.
- `agents-bridge.ts` — the server-side adapter to the canonical agent state
  store, exposing which agents exist and their status.
- `agent-types-bridge.ts` — exposes the canonical agent type registry so the
  UI can list and select them.
- `agent-restrictions.ts` — the single owner of the per-delegation restriction
  sets a sub-agent runs under.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/agent/`.

- `agent-restrictions.ts` is consumed by `server/agent/agent-runtime-bridge.ts`.
- `agent-runtime-bridge.ts` is consumed by `server/run/run-executor.ts`, `server/tools/tool-executor.ts`, `server/tools/tools-bridge.ts`.
- `agent-types-bridge.ts` is consumed by `server/routes/agents.ts`.
- `agents-bridge.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/routes/agents.ts`, `server/run/run-executor.ts`.

<!-- /consumers:generated -->
