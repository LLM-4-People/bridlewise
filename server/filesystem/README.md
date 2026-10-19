# Filesystem domain

The filesystem domain owns how the server touches the user's files: every
project-scoped read or write is gated here so a route cannot reach outside the
allowed roots. The gate is the choke point — routes and bridges do not check
paths themselves.

## What each file does

- `fs-gate.ts` — the single filesystem access owner. Verifies project path
  ownership, resolves paths within the project root, and refuses traversal
  above it. Every project-scoped route and bridge imports the gate from here.
- `file-read.ts` — the single UTF-8 file-read owner, so the encoding is decided
  once at the lowest level and a caller never restates it.
- `editor-bridge.ts` — file reading and editing for the web UI, providing
  privacy-safe file viewing and the raw read/write primitives the tool
  executor and editor route use.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/filesystem/`.

- `editor-bridge.ts` is consumed by `server/blocks/editor.ts`, `server/intelligence/intelligence-bridge.ts`, `server/routes/editor.ts`, `server/tools/tool-executor.ts`.
- `file-read.ts` is consumed by `server/db/conversation-archive.ts`, `server/filesystem/editor-bridge.ts`, `server/intelligence/content-search-engine.ts`, `server/kernel/harness-config.ts`, `server/observability/process-census.ts`, `server/observability/timeline-bridge.ts`.
- `fs-gate.ts` is consumed by `server/agent/agent-restrictions.ts`, `server/agent/agent-runtime-bridge.ts`, `server/awareness/awareness-bridge.ts`, `server/awareness/quality-bridge.ts`, `server/blocks/checks.ts`, `server/blocks/custody.ts` and 19 more.

<!-- /consumers:generated -->
