# MCP

The MCP domain: the model-context-protocol transports and the registry of configured servers.

## What each file does

- `auth.ts` — MCP authentication — translate an `auth` config block into transport-specific.
- `config.ts` — MCP config schema — the single config-driven entry point, the config-document → runtime-entry resolver (`resolveMcpServerConfigs`), and the `${NAME}` credential-placeholder grammar.
- `core.ts` — MCP core — the transport-agnostic JSON-RPC 2.0 client (lifecycle, paginated `tools/list`, tool annotations, `structuredContent`).
- `errors.ts` — MCP error hierarchy. `McpError` carries a retryable flag so the retry.
- `exposure.ts` — MCP exposure — the single shared surface through which the harness (and.
- `factory.ts` — MCP client factory — the heart of "easily add MCP tools without coding"; a stdio entry needs the host's placement (`stdioHost`), and an unresolved credential refuses (`mcp_credential_missing`).
- `headers.ts` — MCP header builder — merge custom headers, auth headers, and a default.
- `index.ts` — MCP module public surface. Re-exports the canonical types and factories.
- `registry.ts` — MCP registry — the central manager. One instance owns every MCP server; it mints each tool's harness name and hands the host the registration record.
- `retry.ts` — MCP retry layer — seamless error handling for tool calls and transport.
- `tool-adapter.ts` — MCP tool adapter — bridges a discovered MCP tool into the harness, with the ONE read/write classifier (`mcpToolCapabilities`).
- `tool-name.ts` — MCP tool naming — the ONE place a (server id, tool name) pair becomes a spec-legal harness name.
- `unavailability.ts` — MCP tool-unavailability taxonomy — the ONE owner of the typed-code →.

## Security model (stdio servers)

A stdio MCP server is a **model-directed proxy**: the operator chose which
server runs, but the model chooses its tool arguments (a path, a query, a
command), exactly like `execute_command`'s argv. So:

- **The module holds no process capability.** The stdio transport starts a
  server only through the host's `McpStdioHost.spawn`, in the host's `cwd`,
  with exactly the host's environment. There is no default spawn, directory
  or environment to fall back to (`mcp_config_invalid` without a host).
- **The web host confines every stdio server** through the one confinement
  owner (`server/safety/landlock-runner.ts`: `prepareConfinedSpawn` with
  purpose `mcp-server` → `spawnPlanned`). Its only writable root is a
  harness-owned home of its own (`mcpServerHomeDir`, 0700, also its `cwd`,
  `HOME` and — `<home>/.tmp` — its `TMPDIR`); beyond it only the safety
  floor's device files (`/dev`) are writable. It gets no project scratch
  folder and none of the operator's `selfProtection.additionalAllowRules`
  (those widen what commands reach, not MCP servers) — never the project:
  project file effects go only through the governed native tools (write set,
  editor, rollback, timeline). Every root is probed from inside the server
  under the real guardian (`tests/unit/mcp-stdio-landlock.test.ts`). It may
  read and execute its own installation (`readPaths`, operator-named), the
  interpreter and the safety floor. A read path that overlaps a write root is
  refused (`tool_path_overlaps_writable`, W^X), as is one that overlaps the
  ONE keep-out list (`self-protection/keep-out.ts`: every home's credential
  stores, the key home and every registered harness database, the harness's
  own databases and config, `selfProtection.additionalProtectedSubtrees`) or a declared project root
  (`HARNESS_WEB_ALLOWED_ROOTS`) — `read_path_refused`, by (device, inode), at
  save time and at every spawn. A `${NAME}` placeholder resolves only a name
  on `tools.mcp.credentialEnv` (exact or `PREFIX*`; `HARNESS_*` refused by the
  schema): anything else is `mcp_credential_env_refused` before it is read. A refusal is the
  server's typed status (`mcp_spawn_refused`, with the owner's code as the
  `confinementReason` signal) and is logged with its code; only
  `selfProtection.enabled: false` starts it unconfined (logged; the
  `confinement` signal says `unconfined`). An absent `selfProtection` section
  means confined.
- **Network egress is NOT restricted.** Landlock confines the filesystem
  only: a confined server can open network connections and could send out
  anything it can read. That is why what it can read is kept to its own
  installation and home, and why secret directories are refused as read
  paths.
- **No run-time fetch.** Nothing writable is executable under the
  confinement, so `npx -y …` / `uvx …` cannot run: install and pin a server
  first, then name its command and `readPaths` (outside the harness tree).
  For example Kagi (not shipped: `readPaths` are machine-specific):
  `uv tool install kagimcp==1.0.2`, then `"command": "kagimcp"` and
  `"readPaths": ["<home>/.local/share/uv/tools/kagimcp", "<the uv python it
  links to>"]`.
- **Minimal environment.** A server inherits only `tools.mcp.stdioInheritedEnv`
  (default `PATH LANG LC_ALL TZ TERM USER LOGNAME SHELL`, projected by the one
  `buildSubprocessEnv`; a bare `*` is refused), plus `HOME`, `TMPDIR` and its
  entry's own configured `env`/auth — never the harness's secrets, and not
  `execute_command`'s wider allowlist.
- **Stderr is drained.** Every stderr line reaches the central log
  (`mcp-runtime`, info); the last `tools.mcp.stderrTailBytes` are the reason
  reported when the process dies (a confinement denial is visible in
  `lastError`, not just "transport closed").
- **Credentials.** A `${NAME}` placeholder the environment does not define
  makes the server "not connected" (`mcp_credential_missing`, naming the
  variable); the placeholder is never sent as the secret.
- **Annotations classify, confinement bounds.** A tool is classified `read`
  only when its server declares `readOnlyHint: true`, otherwise `write`
  (fail closed), and `network` unless `openWorldHint: false`. The hints are
  untrusted claims; they decide how a call is classified (the event feed),
  never what the process can touch.
- The shipped config carries no filesystem server: it duplicated the governed
  native file tools (`read_file`, `list_files`, `search_code`, `edit`).

## Tool names

Every MCP tool is named `mcp__<serverId>__<toolName>` by `tool-name.ts`
(`mcpToolName`): a legal Responses function name (`^[A-Za-z0-9_-]{1,128}$`).
A server id is letters, digits and inner hyphens only (no `_`, no `.`), so
the first `__` after the prefix always ends the id and no two servers share a
head. A tool name that is not legal as-is (MCP allows `.`, servers send other
characters too) or is too long is sanitised and suffixed with an 8-hex digest
of the raw (server, tool) pair, which keeps minting deterministic and distinct
pairs distinct; a collision inside one server makes that server an error
(`mcp_tool_name_collision`). The registry mints the name once per
registration, keeps it, and answers the one reverse lookup
(`registry.resolveToolName`); the host dispatches by that lookup, and nothing
parses or re-mints a name. The minted output is persisted, so changing it
needs a new rename migration (migration 19 keeps a frozen copy; golden tests
pin both). The Responses projection (`toolsToResponses`) only
validates names and refuses an illegal one (`responses_tool_name_invalid`).
Stored names from before this rule are renamed once by DB migration 19.

## Transports

- `stdio` — a local server process, started by the host (see above).
- `http` — MCP **Streamable HTTP** (2025-11-25), the only remote transport:
  `Accept: application/json, text/event-stream` on every POST, JSON or
  event-stream answers (framed by the harness's one SSE parser), 202 for
  notifications, `MCP-Session-Id` echoed, `MCP-Protocol-Version` after
  `initialize`, 404 → `mcp_session_expired` (the registry reconnects into a
  new session), `DELETE` on close. A POST stream the server closes before
  the answer is RESUMED: `GET` with `Last-Event-ID` after the stream's
  `retry` (or `tools.mcp.sseReconnectMs`), until the answer or the timeout
  (405 → `mcp_resume_unsupported`; no event id → `mcp_stream_ended_without_response`).
  The standalone listening `GET` stream (a spec MAY) is not opened. The
  retired HTTP+SSE transport (`"sse"`, `/sse` endpoints) is not accepted; an
  older config's `"sse"` entry (or an id with `_`/`.`) is that server's
  `mcp_config_invalid` status, never an outage of the others.
- `websocket` — a custom transport (not an MCP standard one) over the
  platform WebSocket; its configured headers (auth included) ride the
  handshake (the handshake is not address-pinned by the outbound door: a
  recorded residual). A connection dropped after the open reaches the core
  as a close (the platform reports it as error-then-close).
- **One outbound HTTP policy.** Both remote transports (and the LLM client)
  go through `shared/outbound-http.ts`: redirects are refused
  (`outbound_redirect_refused` — a followed redirect re-sent `X-API-Key` and
  `Mcp-Session-Id` to another host), TLS verification may not be switched
  off, a cleartext `http://`/`ws://` server on another machine is refused or
  warned per the door's ONE setting `network.cleartextRemote` (default
  `refuse`; exact loopback only — `*.localhost` is not), an environment proxy
  never relays a cleartext request silently, configured headers pass a
  grammar/role allowlist, and bodies and lifetimes are bounded.
- **Bounded by config (`tools.mcp`).** A stdio message is framed in bytes
  with a linear scan and closed typed past `maxMessageBytes`
  (`mcp_message_oversized`); a websocket message past it closes the
  connection with 4009 (1009 in the application range — the platform refuses
  1009 from a client) and nothing after it is delivered; a
  server's SSE `retry` is clamped to `sseRetryMaxMs` and resumes stop after
  `resumeAttempts` (`mcp_resume_exhausted`); at most `serverRequestBacklog`
  server requests are answered at once; stderr lines are logged at most
  `stderrLinesPerSecond`; a timed-out or cancelled call sends
  `notifications/cancelled`; the close-time session DELETE is bounded by
  `closeGraceMs`.
- **The JSON-RPC core** routes by shape: a server's own request (`ping`) is
  answered (`ping` → `{}`, anything else → -32601, the client declares no
  capabilities) and never resolves a pending call; an aborted call sends
  `notifications/cancelled`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/mcp/`.

- `auth.ts` is consumed by `engine/src/mcp/config.ts`, `engine/src/mcp/exposure.ts`, `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`.
- `config.ts` is consumed by `engine/src/mcp/exposure.ts`, `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`, `engine/src/shared/exposure/registrations/mcp.ts`, `server/kernel/canonical.ts`.
- `core.ts` is consumed by `engine/src/mcp/exposure.ts`, `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`, `engine/src/mcp/tool-adapter.ts`, `server/kernel/canonical.ts`.
- `errors.ts` is consumed by `engine/src/mcp/config.ts`, `engine/src/mcp/core.ts`, `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`, `engine/src/mcp/retry.ts` and 6 more.
- `exposure.ts` is consumed by `engine/src/mcp/index.ts`.
- `factory.ts` is consumed by `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`, `server/kernel/canonical.ts`.
- `headers.ts` is consumed by `engine/src/mcp/exposure.ts`, `engine/src/mcp/factory.ts`, `engine/src/mcp/index.ts`, `server/kernel/canonical.ts`.
- `index.ts` is consumed by nothing yet.
- `registry.ts` is consumed by `engine/src/mcp/exposure.ts`, `engine/src/mcp/index.ts`, `server/kernel/canonical.ts`.
- `retry.ts` is consumed by `engine/src/mcp/config.ts`, `engine/src/mcp/exposure.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`.
- `tool-adapter.ts` is consumed by `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`.
- `tool-name.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `engine/src/mcp/config.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/registry.ts`, `server/kernel/canonical.ts`.
- `unavailability.ts` is consumed by `engine/src/safety/investigation.ts`, `server/kernel/canonical.ts`.

<!-- /consumers:generated -->
