# Extensions

The extensions domain: the extension manifest model and the loader that discovers and validates installed extensions.

## What each file does

- `approval-workflow.ts` — the approval-workflow module.
- `compatibility-checker.ts` — the compatibility-checker module.
- `extension-lifecycle.ts` — the extension-lifecycle module.
- `extension-manifest.ts` — the extension-manifest module.
- `extension-validation.ts` — the extension-validation module.
- `extensions-config.ts` — the extensions-config module.
- `index.ts` — Extensions module — controlled self-evolution and extension lifecycle.
- `self-modification-tools.ts` — the self-modification-tools module.
- `semver.ts` — the semver module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/extensions/`.

- `approval-workflow.ts` is consumed by `engine/src/extensions/index.ts`, `engine/src/extensions/self-modification-tools.ts`.
- `compatibility-checker.ts` is consumed by `engine/src/extensions/approval-workflow.ts`, `engine/src/extensions/extension-lifecycle.ts`, `engine/src/extensions/index.ts`, `engine/src/extensions/self-modification-tools.ts`.
- `extension-lifecycle.ts` is consumed by `engine/src/extensions/approval-workflow.ts`, `engine/src/extensions/index.ts`, `engine/src/extensions/self-modification-tools.ts`.
- `extension-manifest.ts` is consumed by `engine/src/extensions/approval-workflow.ts`, `engine/src/extensions/compatibility-checker.ts`, `engine/src/extensions/extension-lifecycle.ts`, `engine/src/extensions/index.ts`, `engine/src/extensions/self-modification-tools.ts`, `engine/src/runtime/extension-tools.ts` and 1 more.
- `extension-validation.ts` is consumed by `engine/src/extensions/approval-workflow.ts`, `engine/src/extensions/extension-lifecycle.ts`, `engine/src/extensions/extension-manifest.ts`.
- `extensions-config.ts` is consumed by `engine/src/extensions/extension-manifest.ts`.
- `index.ts` is consumed by `server/kernel/canonical.ts`.
- `self-modification-tools.ts` is consumed by `engine/src/extensions/index.ts`.
- `semver.ts` is consumed by `engine/src/extensions/compatibility-checker.ts`, `engine/src/extensions/extension-lifecycle.ts`, `engine/src/extensions/extension-manifest.ts`, `engine/src/extensions/index.ts`.

<!-- /consumers:generated -->
