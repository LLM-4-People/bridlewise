# Runtime

The engine's runtime: the bootstrap, the provider and tool adapters, capability negotiation, the SSE event parser, and the runtime capability probe that decides what the host supports.

## What each file does

- `admitted-node-runtime.ts` — the admitted-node-runtime module.
- `agent-tools.ts` — the agent-tools module.
- `capability-negotiation.ts` — the capability-negotiation module.
- `cli-debug.ts` — `bootstrapProcess({ role })`, the ONE process bootstrap every process entry point runs first (the main guard of every CLI and tool, the commit guard, the farm child, the long-task unit): it installs the process fault policy for the role FIRST (`src/process/fault-policy.ts`: a `cli` or `worker` fails closed, exit 70, on a lost rejection or a guarded callback fault — SCALE-CR1-FIX H1/H2), then central logging — the debug system configured from the config document's `debug` section, read as DATA through `inspectConfigDocument` so the bootstrap never throws (an unreadable document is the tool's own typed refusal; logging then runs on the declared defaults: audit on, redaction on, the console sink), so an audit event (a sweep, a journal rollback or recovery) reaches stderr in CLI processes too; idempotent, a host that configured already (the web server) keeps its own. `engine/test/runtime/cli-debug.test.ts` derives the entry points by scanning.
- `event-state.ts` — the event-state module.
- `extension-tools.ts` — the extension-tools module.
- `git-tools.ts` — the git-tools module.
- `harness-bootstrap.ts` — Harness runtime bootstrap — the ONE place a production entry point makes.
- `intelligence-tools.ts` — the intelligence-tools module.
- `interactive-session.ts` — the interactive-session module.
- `response-turn.ts` — collects lossless native Responses evidence and releases projections only after the stream and observer settle. `ResponseTurn.stream` is the single provider-turn driver for every foreground host (receipt capture, failure evidence before the native observer, `retireReceipt`), and `turnRequest` freezes a turn's request once. A failed terminal resource carries its failure, classified once by the stream decoder under the configured limits.
- `governed-tool-dispatch.ts` — preflights a completed action batch through the existing tool gate and dispatches through the configured executor.
- `orchestrator-tools.ts` — the orchestrator-tools module.
- `provider-adapter.ts` — OpenAI-compatible provider adapter — façade over the v2 `SharedLLMClient`.
- `quality-tools.ts` — the quality-tools module.
- `runtime-capabilities.ts` — the runtime-capabilities module.
- `runtime-config.ts` — the runtime-config module.
- `sse-parser.ts` — the sse-parser module.
- `tool-args.ts` — the tool-args module.
- `tool-registry.ts` — the tool-registry module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/runtime/`.

- `admitted-node-runtime.ts` is consumed by `engine/scripts/tooling/run-tests.ts`, `engine/src/filesystem/durable-filesystem-internal.ts`, `engine/src/workflow/evidence-store.ts`.
- `agent-tools.ts` is consumed by `server/kernel/canonical.ts`.
- `capability-negotiation.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-contracts.ts`.
- `cli-debug.ts` is consumed by `engine/scripts/build-bundle.ts`, `engine/scripts/commit-guard.ts`, `engine/scripts/exp409/sweep.mjs`, `engine/scripts/generation/repository-path-unicode.ts`, `engine/scripts/pin-authority-regeneration.ts`, `engine/scripts/post-commit.ts` and 25 more.
- `event-state.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-contracts.ts`.
- `extension-tools.ts` is consumed by nothing yet.
- `git-tools.ts` is consumed by nothing yet.
- `governed-tool-dispatch.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/runtime/interactive-session.ts`.
- `harness-bootstrap.ts` is consumed by `engine/src/cli.ts`, `engine/src/workflow/harness-commands.ts`.
- `intelligence-tools.ts` is consumed by nothing yet.
- `interactive-session.ts` is consumed by `engine/src/index.ts`.
- `orchestrator-tools.ts` is consumed by `server/kernel/canonical.ts`.
- `provider-adapter.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/editor/edit-tools.ts`, `engine/src/evaluation/cli.ts`, `engine/src/evaluation/scenario-runner.ts`, `engine/src/index.ts` and 9 more.
- `quality-tools.ts` is consumed by nothing yet.
- `response-turn.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/runtime/interactive-session.ts`, `engine/src/runtime/provider-adapter.ts`.
- `runtime-capabilities.ts` is consumed by `engine/scripts/tooling/planned-node-test-evidence.ts`, `engine/src/repository-path/logical.ts`.
- `runtime-config.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/runtime/agent-tools.ts`, `engine/src/runtime/git-tools.ts`, `engine/src/runtime/intelligence-tools.ts`, `engine/src/runtime/interactive-session.ts`, `engine/src/runtime/orchestrator-tools.ts` and 3 more.
- `sse-parser.ts` is consumed by `engine/src/mcp/transport/streamable-http.ts`, `engine/src/runtime/event-state.ts`, `engine/src/runtime/provider-adapter.ts`, `engine/src/shared/llm/client.ts`.
- `tool-args.ts` is consumed by `engine/src/index.ts`, `engine/src/runtime/agent-tools.ts`, `engine/src/runtime/git-tools.ts`, `engine/src/runtime/intelligence-tools.ts`, `engine/src/runtime/orchestrator-tools.ts`, `engine/src/tools/built-in-tools.ts`.
- `tool-registry.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/index.ts`, `engine/src/mcp/registry.ts`, `engine/src/mcp/tool-adapter.ts`, `engine/src/runtime/agent-tools.ts` and 8 more.

<!-- /consumers:generated -->

The request adapter currently remains a request-shape facade, but its legacy ProviderError mapping is removed. Native LLMError identity, code and observed status pass through unchanged; unknown session failures use a fixed private diagnostic. ResponseTurn classifies admitted failed resources before host observation, preserving known failure through observer/abort/generic-finish paths and retaining an actual supplied native error instance. Interactive sessions and agent runtimes stop subsequent work on the same instance after exact policy refusal, before message/history mutation, hooks or provider dispatch. This does not yet qualify persisted/restored engine conversation authority; native host/intake adoption remains required.
