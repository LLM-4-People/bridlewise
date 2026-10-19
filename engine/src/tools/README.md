# Tools

The tools domain: the tool manifest, registry, and the concurrent dispatcher the run executes tools through.

## What each file does

- `built-in-tool-manifest.ts` — the built-in-tool-manifest module.
- `built-in-tools.ts` — the built-in-tools module.
- `tool-adapter.ts` — the tool-adapter module.
- `tool-manifest.ts` — the tool-manifest module.
- `tools-config.ts` — the tools-config module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/tools/`.

- `built-in-tool-manifest.ts` is consumed by `engine/src/tools/built-in-tools.ts`, `server/kernel/canonical.ts`.
- `built-in-tools.ts` is consumed by nothing yet.
- `tool-adapter.ts` is consumed by `engine/src/mcp/tool-adapter.ts`, `engine/src/tools/built-in-tools.ts`.
- `tool-manifest.ts` is consumed by `engine/src/mcp/registry.ts`, `engine/src/mcp/tool-adapter.ts`, `engine/src/runtime/git-tools.ts`, `engine/src/tools/built-in-tool-manifest.ts`, `engine/src/tools/tool-adapter.ts`, `server/kernel/canonical.ts`.
- `tools-config.ts` is consumed by `engine/src/tools/concurrent/worker-pool.ts`.

<!-- /consumers:generated -->
