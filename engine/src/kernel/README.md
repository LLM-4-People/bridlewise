# Engine kernel

The engine's trusted kernel: the typed error hierarchy, canonical integrity and hashing, the root policy invariants, and the verification, schema, and protocol contracts every other engine domain builds on. Nothing here depends on a feature; the features depend on these.

## What each file does

- `contracts.ts` — the contracts module.
- `engine-root.ts` — THE engine checkout's root (`engineRoot`, `pinnedRepositoryRoot`: above the root-policy owner's declared location), asked by the config document's location and the key home's admission.
- `errors.ts` — the errors module.
- `execution-closure.ts` — the execution-closure module.
- `integrity.ts` — the canonical owner of hashing and random bytes: `sha256`, the canonical JSON hashes, `gitBlobId` (the id git gives a blob, SHA-1 or SHA-256), the id generators, `deepFreeze`; the only engine module that imports `createHash`, `randomUUID` or `randomBytes` from `node:crypto`.
- `json-integrity.ts` — JSON integrity primitives: duplicate-key refusal and
  `parseJsonExact`, the one never-throwing exact parse (the value boxed, so
  JSON `null` stays distinct from "not JSON"; the parser's message, which
  quotes the input, never surfaces).
- `language-extensions.ts` — Canonical TypeScript/JavaScript file-extension sets.
- `ledger-canonical.ts` — the ledger-canonical module.
- `lexical-policy.ts` — dependency-free canonical ceilings for immutable lexical reuse, shared by the full root policy and scanner.
- `ordered.ts` — the ordered module.
- `preflight.ts` — the preflight module.
- `product-identity.ts` — the product-identity owner: the single source of truth for the product name, schema-namespace prefix, config-file basename, state-directory name, and crypto domain prefix, plus the schemaId/cryptoDomain/statePath derivers.
- `protocol-projections.ts` — the protocol-projections module.
- `requirements.ts` — the requirements module.
- `root-policy.ts` — the root-policy module.
- `safe-structural.ts` — the safe-structural module.
- `schema-subset.ts` — the schema-subset module.
- `test-surface-manifest.ts` — the test-surface-manifest module.
- `config.ts` — the engine configuration owner: the resolved values the engine reads.
- `config-contracts.ts` — the config schema contracts: types and validation for the configuration document.
- `verification-paths.ts` — the verification-paths module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/kernel/`.

- `config-contracts.ts` is consumed by `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/test-run-lock.ts`, `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/agents/agent-config.ts`, `engine/src/editor/edit-operations.ts`, `engine/src/evaluation/matrix-generator.ts` and 31 more.
- `config-write-lock.ts` is consumed by `engine/src/shared/exposure/config-binding.ts`, `server/kernel/harness-config.ts`.
- `config.ts` is consumed by `engine/scripts/commit-guard.ts`, `engine/scripts/tooling/candidate-checkout.ts`, `engine/scripts/tooling/foundation.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/test-execution.ts` and 19 more.
- `contracts.ts` is consumed by `engine/scripts/tooling/verification/slice-traces.ts`, `engine/scripts/verification/slice-projection-inputs.ts`, `engine/scripts/verification/slice-projections.ts`, `engine/src/evaluation/matrix-generator.ts`, `engine/src/forensics/offline-contracts.ts`, `engine/src/kernel/protocol-projections.ts` and 9 more.
- `engine-root.ts` is consumed by `engine/src/filesystem/self-protection/key-home.ts`, `engine/src/kernel/config.ts`, `engine/src/workflow/promotion/promoter-home.ts`.
- `errors.ts` is consumed by `engine/scripts/generation/repository-path-unicode.ts`, `engine/scripts/pin-authority-regeneration.ts`, `engine/scripts/regenerate-handoff-manifest.ts`, `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/bootstrap-permissions.ts`, `engine/scripts/tooling/candidate-checkout.ts` and 294 more.
- `execution-closure.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/runtime/interactive-session.ts`, `engine/src/timeline/recorded-effect.ts`, `engine/src/timeline/timeline-recorder.ts`.
- `integrity.ts` is consumed by `engine/scripts/generation/repository-path-unicode.ts`, `engine/scripts/pin-authority-regeneration.ts`, `engine/scripts/regenerate-handoff-manifest.ts`, `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/bootstrap-permissions.ts`, `engine/scripts/tooling/candidate-checkout.ts` and 308 more.
- `json-integrity.ts` is consumed by `engine/scripts/generation/repository-path-unicode.ts`, `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/planned-node-test-evidence.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/test-execution.ts` and 18 more.
- `language-extensions.ts` is consumed by `engine/src/editor/syntax-validator.ts`, `engine/src/quality-packs/typescript-pack.ts`.
- `ledger-canonical.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/forensic-crypto.ts`, `engine/src/forensics/forensic-normalization.ts`, `engine/src/forensics/forensic-projection.ts`, `engine/src/forensics/offline-forensics.ts`, `engine/src/timeline/ledger-primitives.ts` and 1 more.
- `lexical-policy.ts` is consumed by `engine/scripts/verification/source-view.ts`, `engine/src/kernel/root-policy.ts`.
- `ordered.ts` is consumed by `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/test-receipt.ts`, `engine/scripts/tooling/verification/artifact-admission.ts`, `engine/scripts/tooling/verification/slice-traces.ts`, `engine/scripts/verification/architecture.ts` and 10 more.
- `preflight.ts` is consumed by `engine/src/cli.ts`.
- `product-identity.ts` is consumed by `engine/scripts/commit-guard.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/verification/official-fragment-manifest.ts`, `engine/scripts/verification/ratchet.ts`, `engine/src/awareness/types.ts` and 61 more.
- `protocol-projections.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-contracts.ts`, `engine/src/runtime/event-state.ts`.
- `requirements.ts` is consumed by `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/verification/slice-traces.ts`, `engine/scripts/verification/slice-projection-inputs.ts`, `engine/scripts/verification/slice-projections.ts`, `engine/src/forensics/offline-contracts.ts`, `engine/src/forensics/offline-forensics.ts` and 2 more.
- `root-policy.ts` is consumed by `engine/scripts/build-bundle.ts`, `engine/scripts/commit-guard.ts`, `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/bootstrap-permissions.ts`, `engine/scripts/tooling/candidate-checkout.ts`, `engine/scripts/tooling/candidate-manifest.ts` and 125 more.
- `safe-structural.ts` is consumed by `engine/scripts/tooling/test-receipt.ts`, `engine/scripts/verification/safe-repository-reader.ts`, `engine/scripts/verification/slice-projection-captured-values.ts`, `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/filesystem/repository-root-capability-contracts.ts`, `engine/src/filesystem/repository-root-capability-internal.ts` and 23 more.
- `schema-subset.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-contracts.ts`, `engine/src/kernel/protocol-projections.ts`.
- `test-surface-manifest.ts` is consumed by `engine/scripts/tooling/test-run-lock.ts`, `engine/scripts/verification/hermetic-skips.ts`, `engine/scripts/verification/test-surface.ts`, `engine/src/workflow/harness-commands.ts`.
- `verification-paths.ts` is consumed by `engine/scripts/pin-authority-regeneration.ts`, `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/test-worker.ts`, `engine/scripts/verification/decision-index.ts`, `engine/scripts/verification/shipped-hooks.ts` and 9 more.
- `web-performance-budgets.ts` is consumed by `engine/src/kernel/root-policy.ts`.

<!-- /consumers:generated -->
