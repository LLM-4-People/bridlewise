# Integrations domain

The integrations domain owns the server's connections to external systems:
configured MCP servers and the live connections to them, and the harness
extensions the operator has installed. Each integration is listed from config
and probed for live status; nothing here is static.

## What each file does

- `mcp-bridge.ts` — lists configured MCP servers from the harness config,
  joined with live connection status from the runtime owner.
- `mcp-runtime-bridge.ts` — the single process-scoped host for live MCP
  connections, and the ONE door a client is built through
  (`mcpServerClient`): it resolves `${VAR}` credentials (an unset one makes
  the server "not connected"), and starts every stdio server CONFINED through
  the confinement owner (`mcpStdioSpawn`, purpose `mcp-server`: its own home —
  with `TMPDIR` inside it — as the only writable root, no project scratch and
  no operator command rules; the minimal `tools.mcp.stdioInheritedEnv`;
  `readPaths` read-and-run only, refused when they overlap a write root, a
  secret directory, the harness or a project root). Network egress is not
  restricted (Landlock is filesystem-only). The registry and the settings
  test verb build clients with the same options (`mcpClientFactoryOptions`);
  each server's `confinement` state and `lastErrorCode` are served to the
  settings list. Calls dispatch by the harness name the registry minted
  (`mcp__<server>__<tool>`), looked up — never parsed.
- `extensions-bridge.ts` — reads the harness config to list configured
  extensions and their manifest metadata.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/integrations/`.

- `extensions-bridge.ts` is consumed by `server/routes/extensions.ts`, `server/tools/tool-executor.ts`.
- `mcp-bridge.ts` is consumed by `server/routes/config.ts`, `server/routes/mcp.ts`.
- `mcp-runtime-bridge.ts` is consumed by `server/index.ts`, `server/integrations/mcp-bridge.ts`, `server/tools/tool-executor.ts`, `server/tools/tools-bridge.ts`.

<!-- /consumers:generated -->
