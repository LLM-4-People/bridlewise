# Tools domain

The tools domain owns the tools the model can call: the manifest that lists
them, the one executor that dispatches them, and the UI-control contract that
lets the model drive the interface. Adding a tool means registering it in the
manifest; the executor and the UI pick it up automatically.

## What each file does

- `tools-bridge.ts` — the one canonical registry of every tool the web UI
  exposes.
- `tool-executor.ts` — the one executor; every manifest tool has a handler
  here, and tools run in the project directory with path safety enforced.
- `ui-control.ts` — the single owner of the `control_interface` tool action
  schema, the contract by which the model drives the UI.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/tools/`.

- `tool-executor.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/run/run-executor.ts`.
- `tools-bridge.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/blocks/breaker.ts`, `server/blocks/compose.ts`, `server/blocks/tools.ts`, `server/context/memory-bridge.ts`, `server/integrations/mcp-bridge.ts` and 5 more.
- `ui-control.ts` is consumed by `server/run/run-executor.ts`, `server/tools/tool-executor.ts`, `server/tools/tools-bridge.ts`.

<!-- /consumers:generated -->
