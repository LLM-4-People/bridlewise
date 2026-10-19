# Context domain

The context domain owns what the model knows before it answers: the assembled
conversation history, the project it is working in, and the long-term memory
the harness carries between sessions. The LLM never reads the database or the
memory store directly — these modules build the prompt context once.

## What each file does

- `context-bridge.ts` — wires the canonical unified context manager and memory
  store into the web chat pipeline.
- `chat-history.ts` — reconstructs the `ChatMessage[]` projection from the
  database so the model has memory of the conversation.
- `project-context.ts` — builds the system prompt that gives the model
  awareness of the selected project: name, path, and file listing.
- `memory-bridge.ts` — the single server-side owner of harness memory access;
  every memory store, retrieve, and inject goes through here.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/context/`.

- `chat-history.ts` is consumed by `server/blocks/compose.ts`, `server/routes/run.ts`.
- `context-bridge.ts` is consumed by `server/blocks/compose.ts`, `server/context/memory-bridge.ts`, `server/routes/run.ts`, `server/routes/safety.ts`, `server/run/run-executor.ts`, `server/run/run-registry.ts`.
- `memory-bridge.ts` is consumed by `server/blocks/compose.ts`, `server/routes/memory.ts`, `server/routes/run.ts`, `server/run/run-executor.ts`, `server/tools/tool-executor.ts`.
- `project-context.ts` is consumed by `server/context/context-bridge.ts`, `server/routes/settings.ts`.

<!-- /consumers:generated -->
