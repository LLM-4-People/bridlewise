# LLM domain

The LLM domain owns the server's relationship with the model providers: which
provider and model answer a request, the wiring to the shared LLM client, the
PII redaction applied before anything leaves the process, and the outbound
message construction. The database is the source of truth for providers.

## What each file does

- `llm-bridge.ts` — wires the web UI to the shared LLM client and owns the
  outbound message construction, applying redaction and dedup at the choke
  point. It never falls back to fixtures.
- `providers.ts` — the one source of model providers; the database is that
  source.
- `redaction.ts` — the single web-UI owner of PII redaction, wrapping the
  canonical engine so sensitive content is redacted before it reaches the
  model or the user.
- `template-tokens.ts` — the provider template-token sanitizer: the
  pipe-delimited angle-bracket lattice a model can leak into its answer
  text, the matcher for it, and the streaming filter the bridge strips
  with at the single point every text delta crosses.
- `fixtures.ts` — fixture builders used by tests and demo paths.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/llm/`.

- `fixtures.ts` is consumed by `server/llm/llm-bridge.ts`.
- `llm-bridge.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/blocks/compose.ts`, `server/context/chat-history.ts`, `server/context/context-bridge.ts`, `server/routes/models.ts`, `server/run/run-executor.ts`.
- `providers.ts` is consumed by `server/agent/agent-runtime-bridge.ts`, `server/blocks/compose.ts`, `server/llm/llm-bridge.ts`, `server/routes/models.ts`, `server/routes/run.ts`, `server/run/run-registry.ts` and 1 more.
- `redaction.ts` is consumed by `server/blocks/client-telemetry.ts`, `server/blocks/compose.ts`, `server/blocks/settings.ts`, `server/context/context-bridge.ts`, `server/index.ts`, `server/llm/llm-bridge.ts` and 7 more.
- `template-tokens.ts` is consumed by `server/llm/llm-bridge.ts`.

<!-- /consumers:generated -->
