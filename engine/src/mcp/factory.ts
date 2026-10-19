/**
 * MCP client factory — the heart of "easily add MCP tools without coding".
 *
 * Given one `McpServerEntry` from the config, this builds the right
 * transport (stdio / Streamable HTTP `http` / websocket), merges auth +
 * custom headers, wraps the transport in the JSON-RPC core, and returns a
 * ready `McpClient`. The caller never writes transport/auth/header code — it
 * only edits JSON config.
 *
 * A stdio entry needs the HOST's placement (`stdioHost`): the directory the
 * server runs in, the environment it is given and the spawn that starts it.
 * There is no default for any of the three — inheriting this process's
 * directory or environment, or starting a process some other way than the
 * host decided, is exactly the unconfined door this module must not have.
 *
 * fetch/websocket are injectable so tests can drive the factory without a
 * network.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import { authEnv, authHeaders, type McpAuthConfig } from "./auth.ts";
import { mergeHeaders } from "./headers.ts";
import { createMcpCoreClient, MCP_MAX_MESSAGE_BYTES, type McpClient, type McpClientInfo } from "./core.ts";
import { normalizeMcpModuleConfig, unresolvedCredentialPlaceholders, validateMcpServerEntry, type McpServerEntry } from "./config.ts";
import { McpError } from "./errors.ts";
import { InputError } from "../kernel/errors.ts";
import { createStdioTransport } from "./transport/stdio.ts";
import { createStreamableHttpTransport } from "./transport/streamable-http.ts";
import { createWebSocketTransport } from "./transport/websocket.ts";
import type { McpSpawn, McpTransportFactoryOptions } from "./transport/types.ts";

/** Where and how the host runs one stdio server (see the module doc). */
export type McpStdioHost = Readonly<{
  /** The server's working directory (the web host: its own harness-owned home). */
  cwd: string;
  /** The server's base environment (the web host: the subprocess allowlist). */
  environment: Readonly<Record<string, string>>;
  /** The host's process starter (the web host: the confinement owner's spawn). */
  spawn: McpSpawn;
}>;

export type McpClientFactoryOptions = McpTransportFactoryOptions & Readonly<{
  clientInfo: McpClientInfo;
  onTransportClose?: () => void;
  defaultProtocolVersion: string;
  defaultTimeoutMs: number;
  /** Required to build a stdio entry; unused by the remote transports. */
  stdioHost?: McpStdioHost;
}>;

/** Build the merged header bag for an http/websocket transport. */
export function buildTransportHeaders(
  customHeaders: Readonly<Record<string, string>> | undefined,
  auth: McpAuthConfig | undefined,
): Readonly<Record<string, string>> {
  return mergeHeaders(authHeaders(auth), customHeaders);
}

/** Build the merged env bag for a stdio transport. */
export function buildTransportEnv(
  customEnv: Readonly<Record<string, string>> | undefined,
  auth: McpAuthConfig | undefined,
): Readonly<Record<string, string>> {
  return deepFreeze({ ...authEnv(auth), ...(customEnv ?? {}) });
}

/** Create a connected-ready `McpClient` from a single config entry. No coding. */
export function createMcpClientFromConfig(
  entry: McpServerEntry,
  options: McpClientFactoryOptions,
): McpClient {
  validateMcpServerEntry(entry);
  // A credential the host could not resolve is MISSING, and a missing
  // credential is "not connected" — never a request that carries the literal
  // `${NAME}` spelling to a server as if it were the secret.
  const missing = unresolvedCredentialPlaceholders(entry);
  if (missing.length > 0) {
    throw new McpError(
      `MCP server '${entry.id}' is not connected: its credential variable${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set`,
      "mcp_credential_missing",
      false,
      { serverId: entry.id, variables: missing.join(",") },
    );
  }
  const protocolVersion = entry.protocolVersion ?? options.defaultProtocolVersion;
  const timeoutMs = entry.timeoutMs ?? options.defaultTimeoutMs;
  // Every module default below belongs to the module config's owner: the
  // caller's option wins, the module's declared default otherwise.
  const moduleDefaults = normalizeMcpModuleConfig({}).defaults;

  let transport;
  if (entry.transport === "stdio") {
    const host = options.stdioHost;
    if (host === undefined) {
      throw new InputError(`stdio MCP server '${entry.id}' needs the host's placement (directory, environment, spawn); none was given`, "mcp_config_invalid");
    }
    transport = createStdioTransport({
      command: entry.command!,
      ...(entry.args !== undefined ? { args: entry.args } : {}),
      cwd: host.cwd,
      // The host's base environment, then the entry's own credentials: the
      // configured env and auth are the only additions, and nothing comes
      // from this process's environment.
      env: deepFreeze({ ...host.environment, ...buildTransportEnv(entry.env, entry.auth) }),
      spawn: host.spawn,
      closeGraceMs: options.closeGraceMs ?? moduleDefaults.closeGraceMs,
      stderrTailBytes: options.stderrTailBytes ?? moduleDefaults.stderrTailBytes,
      stderrLinesPerSecond: options.stderrLinesPerSecond ?? moduleDefaults.stderrLinesPerSecond,
      maxMessageBytes: MCP_MAX_MESSAGE_BYTES,
      ...(options.onStderr !== undefined ? { onStderr: (line: string) => options.onStderr!(entry.id, line) } : {}),
    });
  } else if (entry.transport === "http") {
    transport = createStreamableHttpTransport({
      url: entry.url!,
      headers: buildTransportHeaders(entry.headers, entry.auth),
      timeoutMs,
      protocolVersion,
      sseReconnectMs: options.sseReconnectMs ?? moduleDefaults.sseReconnectMs,
      sseRetryMaxMs: options.sseRetryMaxMs ?? moduleDefaults.sseRetryMaxMs,
      resumeAttempts: options.resumeAttempts ?? moduleDefaults.resumeAttempts,
      closeGraceMs: options.closeGraceMs ?? moduleDefaults.closeGraceMs,
    });
  } else {
    transport = createWebSocketTransport({
      url: entry.url!,
      headers: buildTransportHeaders(entry.headers, entry.auth),
      ...(entry.subprotocol !== undefined ? { subprotocol: entry.subprotocol } : {}),
      timeoutMs,
      maxMessageBytes: MCP_MAX_MESSAGE_BYTES,
    });
  }

  return createMcpCoreClient({
    serverId: entry.id,
    transport,
    protocolVersion,
    timeoutMs,
    serverRequestBacklog: options.serverRequestBacklog ?? moduleDefaults.serverRequestBacklog,
    clientInfo: options.clientInfo,
    ...(options.onTransportClose !== undefined ? { onTransportClose: options.onTransportClose } : {}),
  });
}
