# Shared debug system

The centralized debug, error, and audit system — the single entry point for
all debug logging, error handling, and audit events across the harness.
Everything goes through here; when debug is off, debug calls are ignored.

## What each file does

- `debug-system.ts` — the central debug/error/audit system itself.
- `debug-config.ts` — the single source of truth for the debug system's
  configuration, composed into the central config contract.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/debug/`.

- `debug-config.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `engine/src/runtime/cli-debug.ts`, `engine/src/shared/debug/debug-system.ts`, `server/kernel/canonical.ts`.
- `debug-system.ts` is consumed by `engine/scripts/tooling/launcher-watch.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/verification/filesystem-cache.ts`, `engine/scripts/verification/staged-move-loss.ts`, `engine/src/awareness/engine.ts`, `engine/src/awareness/git-command-runner.ts` and 80 more.

<!-- /consumers:generated -->
