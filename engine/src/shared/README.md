# Shared

The shared domain: the agnostic helpers every engine domain consumes, owned once so a fix reaches every consumer.

## What each file does

- `abort-signals.ts` — Canonical AbortSignal combination helpers, and the
  one abortable delay (`abortableDelay`).
- `backoff.ts` — THE retry backoff formula (`backoffDelayMs`: base, factor, cap, jitter) — the LLM client and the MCP registry both ask it.
- `best-effort.ts` — Canonical best-effort operation helpers: `bestEffort`,
  `bestEffortAsync`, and `bestEffortBoxed` (the value boxed, for an operation
  whose `undefined` result is meaningful). (`guarded`, the event loop's door,
  is the fault policy's own: `src/process/fault-policy.ts`.)
- `budget-verdict.ts` — The runtime budget's DECISION, as a pure function of a recorded summary.
- `dev-mode-env.ts` — the dev-mode-env module.
- `flake-reproduction.ts` — THE RECORDS THAT EXPLAIN A FLAKY SUSPECT (FLAKE-REPRO): the schemas, file names, folder (`ROOT_POLICY.workflow.flakeReproductions`), serializers and reader of the reproductions (deterministic or statistical, with their one set of conditions, digests, counts and loads) and of the identity moves `harness flake` writes. The flaky verdict explains a suspect only with such a record.
- `git-churn-config.ts` — Canonical configuration owner for the shared git-churn helper.
- `git-churn.ts` — the git-churn module.
- `identity.ts` — Canonical `BigIntStats` identity comparison.
- `json-pointer.ts` — Canonical JSON Pointer (RFC 6901) helpers.
- `long-task-timing.ts` — the long-task-timing module.
- `module-location.ts` — The single owner of where an engine module lives, resolved from the tree.
- `numeric-helpers.ts` — the numeric-helpers module.
- `outbound-http.ts` — THE outbound door: every HTTP request and WebSocket
  the harness sends goes through it, and it OWNS its transport — ONE client,
  `undici` (a direct dependency, loaded when the first request or WebSocket
  is sent), with no seam (tests answer through a real loopback server,
  `engine/test/support/loopback-upstream.ts`). Every request and handshake is
  resolved once and PINNED to the checked addresses, on a connection pool
  keyed by them (a kept-alive connection never serves a request pinned
  elsewhere; `closeOutboundConnections` closes the pools, at the web server's
  shutdown), and states `allowPrivateAddress` (the destination rule,
  `privateAddressesAllowedFor`). No redirect is followed (any 3xx is
  `outbound_redirect_refused`), TLS verification cannot be switched off,
  cleartext to a host that is not EXACTLY loopback (`isLoopbackHostName`;
  `*.localhost` is not) is refused or warned per `network.cleartextRemote`,
  an environment proxy never relays a cleartext request silently and never
  carries a request held off private addresses
  (`outbound_destination_unpinnable`), a request held off private addresses
  refuses loopback, private, link-local, shared, benchmark, multicast,
  reserved and documentation ranges (IPv4 embedded in IPv6 judged by the
  inner IPv4), operator headers pass a grammar/role allowlist (protocol
  headers win), every refusal is logged once and counted, a WebSocket
  message is bounded before it is assembled (`openOutboundWebSocket`), and
  bodies (`readBody`, `decodeReadableStream`, `discardBody`) and lifetimes
  (`outboundDeadline`) are bounded.
  `engine/test/prevention/outbound-http-owner.test.ts` (AST) refuses any
  other `fetch`, `http(s).request`, socket, `WebSocket` or `undici` use in
  the product trees and scripts.
- `outbound-policy.ts` — the door's POLICY and observable state, with no
  transport: the `network` config section (schema, defaults, the host's live
  source), the destination rule (`privateAddressesAllowedFor`,
  `OPERATOR_OWNER`) and the door's counters (`outboundSignals`), so the
  config contract and the `network` exposure module never load the HTTP
  client.
- `path-utils.ts` — Canonical path-extension helper.
- `run-cpu.ts` — The CPU time a test run actually consumed — the run's WORK, as opposed to.
- `run-history.ts` — THE RUN-HISTORY LEDGER — what makes "sustained" a measurable word, for.
- `similarity.ts` — Canonical set-similarity primitives.
- `source-extensions.ts` — the source-extensions module.
- `source-scan.ts` — Experiment source-directory exclusion — the single source of truth.
- `source-structure.ts` — STRUCTURAL SCOPES FOR SOURCE ASSERTIONS — the shared owner that makes a.
- `stats.ts` — Canonical statistical helpers.
- `tree-identity.ts` — TREE IDENTITY — the answers a measurement record binds to: WHICH commit the.
- `type-guards.ts` — Canonical type-guard and exhaustiveness helpers.
- `fault-description.ts` — `describeFault(value)`: the one TOTAL description of a thrown or rejected value (an Error, `undefined`, a Symbol, a null-prototype object, a throwing getter — one hostile getter loses only its own field) as plain strings, and `faultLine`/`describeFaultLine`: the one `Name [code]: message` spelling (the fault policy's report, a refusal reason, the database threads' restart report); a leaf module, so the fault policy, `guarded` and the debug system use it without a cycle.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/`.

- `abort-signals.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/evaluation/scenario-runner.ts`, `engine/src/mcp/retry.ts`, `engine/src/mcp/transport/streamable-http.ts`, `engine/src/memory/unified/drift-detector.ts`, `engine/src/runtime/provider-adapter.ts` and 6 more.
- `backoff.ts` is consumed by `engine/src/mcp/retry.ts`, `engine/src/shared/llm/client.ts`.
- `best-effort.ts` is consumed by `engine/scripts/tooling/compile-cache.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/verification/filesystem-cache.ts`, `engine/src/agents/agent-runtime.ts`, `engine/src/agents/agent-state.ts` and 38 more.
- `budget-verdict.ts` is consumed by `engine/scripts/tooling/run-diff.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/test-receipt.ts`, `engine/src/shared/run-history.ts`, `engine/src/workflow/promotion/context.ts`, `engine/src/workflow/workspace-manager.ts`.
- `dependency-spans.ts` is consumed by `engine/src/memory/unified/unified-context-manager.ts`, `engine/src/shared/llm/response-transcript.ts`.
- `dev-mode-env.ts` is consumed by `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/test-worker.ts`.
- `fault-description.ts` is consumed by `engine/src/process/fault-policy.ts`, `engine/src/process/worker-bootstrap.ts`, `server/kernel/canonical.ts`.
- `flake-reproduction.ts` is consumed by `engine/src/git/flake-cause-fixes.ts`, `engine/src/shared/run-history.ts`, `engine/src/workflow/flake-cli.ts`.
- `git-churn-config.ts` is consumed by `engine/src/shared/git-churn.ts`.
- `git-churn.ts` is consumed by `engine/src/awareness/temperature.ts`, `engine/src/quality-packs/prevention/le-chatelier-bandaid.ts`, `engine/src/quality-packs/prevention/tierra-dead-code.ts`.
- `identity.ts` is consumed by `engine/src/kernel/config.ts`, `engine/src/kernel/preflight.ts`.
- `json-pointer.ts` is consumed by `engine/src/kernel/protocol-projections.ts`, `engine/src/kernel/schema-subset.ts`, `engine/src/runtime/event-state.ts`.
- `long-task-timing.ts` is consumed by `engine/src/tools/concurrent/long-task-runner.ts`.
- `module-location.ts` is consumed by `engine/scripts/tooling/verification/governed-source.ts`, `engine/scripts/tooling/verification/slice-traces.ts`.
- `numeric-helpers.ts` is consumed by `engine/src/awareness/delta.ts`, `engine/src/awareness/fisher-ranking.ts`, `engine/src/awareness/signals/architecture.ts`, `engine/src/awareness/signals/banach-contraction.ts`, `engine/src/awareness/signals/bell-clones.ts`, `engine/src/awareness/signals/benford.ts` and 42 more.
- `outbound-http.ts` is consumed by `engine/src/evaluation/scenario-runner.ts`, `engine/src/mcp/transport/streamable-http.ts`, `engine/src/mcp/transport/websocket.ts`, `engine/src/memory/unified/drift-detector.ts`, `engine/src/shared/llm/client.ts`, `engine/src/shared/llm/provider-http.ts` and 2 more.
- `outbound-policy.ts` is consumed by `engine/src/evaluation/scenario-runner.ts`, `engine/src/kernel/config-contracts.ts`, `engine/src/mcp/transport/streamable-http.ts`, `engine/src/mcp/transport/websocket.ts`, `engine/src/memory/unified/drift-detector.ts`, `engine/src/runtime/provider-adapter.ts` and 3 more.
- `path-utils.ts` is consumed by `engine/src/editor/syntax-validator.ts`, `engine/src/intelligence/language-registry.ts`, `engine/src/quality-packs/cli.ts`, `engine/src/quality-packs/typescript-pack.ts`, `engine/src/workflow/module-registrar.ts`.
- `run-cpu.ts` is consumed by `engine/scripts/tooling/run-tests.ts`.
- `run-history.ts` is consumed by `engine/scripts/commit-guard.ts`, `engine/scripts/tooling/candidate-checkout.ts`, `engine/scripts/tooling/flake-reproduction-reporter.ts`, `engine/scripts/tooling/run-diff.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/test-execution.ts` and 11 more.
- `similarity.ts` is consumed by `engine/src/awareness/clone-helpers.ts`, `engine/src/quality-packs/prevention/ast-helpers.ts`, `engine/src/quality-packs/prevention/async-effect-normalizer.ts`, `engine/src/quality-packs/prevention/duplicate-body-detector.ts`, `engine/src/quality/checks/duplicates.ts`, `engine/src/safety/bias-detector.ts` and 1 more.
- `source-extensions.ts` is consumed by `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/verification/command-effect-inventory.ts`, `engine/scripts/verification/effect-surface.ts`, `engine/scripts/verification/static-source.ts`, `engine/src/intelligence/file-slice.ts`, `engine/src/intelligence/quick-view.ts` and 3 more.
- `source-scan.ts` is consumed by `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/verification/architecture.ts`, `engine/scripts/verification/safe-repository-reader.ts`, `engine/scripts/verification/source-walk.ts`, `engine/src/cli.ts` and 7 more.
- `source-structure.ts` is consumed by nothing yet.
- `stats.ts` is consumed by `engine/src/awareness/fisher-ranking.ts`, `engine/src/evaluation/matrix-executor.ts`, `engine/src/shared/git-churn.ts`.
- `string-values.ts` is consumed by `engine/src/privacy/responses-observation.ts`, `engine/src/privacy/responses-redaction.ts`, `engine/src/shared/llm/provider-observation.ts`.
- `tree-identity.ts` is consumed by `engine/scripts/tooling/run-tests.ts`.
- `type-guards.ts` is consumed by `engine/scripts/tooling/run-tests.ts`, `engine/scripts/verification/architecture.ts`, `engine/scripts/verification/static-source.ts`, `engine/src/editor/edit-operations.ts`, `engine/src/extensions/extension-manifest.ts`, `engine/src/filesystem/durable-filesystem-internal.ts` and 26 more.

<!-- /consumers:generated -->
