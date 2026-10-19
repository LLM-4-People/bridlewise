# MCP transports

The per-transport implementations of the Model Context Protocol client.
Each transport speaks JSON-RPC over a different channel and implements the
shared `types.ts` interface, so the MCP core never knows which transport
served it. The agnostic machinery is shared; each transport is its own file.

## What each file does

- `types.ts` — the transport interface every implementation (stdio,
  Streamable HTTP `http`, websocket) satisfies (`send(raw, { signal,
  answered })`, an optional `closeReason()`), the host's process starter type
  (`McpSpawn`), and the transports' log category.
- `stdio.ts` — the stdio transport: starts the server ONLY through the host's
  spawn (no default, no inherited directory or environment) and exchanges
  newline-delimited JSON-RPC over its stdin/stdout; a host refusal is
  `mcp_spawn_refused`. Stderr is always drained (each line to the host's
  `onStderr`, the newest `stderrTailBytes` kept as the close reason).
- `streamable-http.ts` — the MCP Streamable HTTP transport (2025-11-25),
  entirely on the one outbound HTTP policy (`shared/outbound-http.ts`: no
  redirect followed, verified TLS, the cleartext decision, the header
  allowlist, bounded bodies): the spec's Accept and Content-Type on every
  POST, JSON or event-stream answers through the harness's one SSE parser,
  202 handling, session id, `MCP-Protocol-Version`, 404 session expiry,
  resumption of an early-closed stream (GET with `Last-Event-ID` after
  `retry`), DELETE on close. Not implemented (a spec MAY): the standalone
  listening GET stream.
- `websocket.ts` — the websocket transport (custom, not an MCP standard
  transport): one JSON-RPC message per WebSocket frame; the URL passes the
  outbound policy and the configured headers ride the handshake.
- `helpers.ts` — shared transport helpers.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/mcp/transport/`.

- `helpers.ts` is consumed by `engine/src/mcp/transport/stdio.ts`.
- `stdio.ts` is consumed by `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`.
- `streamable-http.ts` is consumed by `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`.
- `types.ts` is consumed by `engine/src/mcp/auth.ts`, `engine/src/mcp/config.ts`, `engine/src/mcp/core.ts`, `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/transport/stdio.ts` and 2 more.
- `websocket.ts` is consumed by `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`.

<!-- /consumers:generated -->
