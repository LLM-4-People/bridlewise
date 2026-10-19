/**
 * MCP config schema — the single config-driven entry point. An operator
 * adds a server to the config and the factory (`createMcpClientFromConfig`)
 * does all the hard work: picks the right transport, injects auth into env
 * (stdio) or headers (http/websocket), merges custom headers, applies
 * the retry budget, and returns a connected `McpClient`. No coding.
 *
 * The schema is the canonical MCP server config (no backward-compat
 * facade): `id`, `transport` (stdio|http|websocket — `http` is MCP
 * Streamable HTTP; the retired HTTP+SSE transport is not accepted),
 * `command`/`args`/`env`/`readPaths` (stdio), `url`/`headers`/`subprotocol`
 * (http/websocket), `auth`, `retry`, `enabled`, `protocolVersion`,
 * `timeoutMs`. All
 * module-level defaults are derived from `ROOT_POLICY` — no hardcoded
 * protocol versions, timeouts, or ceilings.
 *
 * TWO VALIDATION LAYERS, DELIBERATELY. `config-contracts.ts`
 * (`mcpServerConfigSchema`, spliced into the `tools.mcpServers` path) is the
 * config document's WRITE-GATE shape — it bounds what may be persisted to
 * `bridlewise.config.json`. This module's `validateMcpServerEntry` /
 * `validateMcpModuleConfig` are the RUNTIME contract the factory enforces at
 * connect time (per-transport required fields, auth/transport pairing), which
 * is a different question than "is this a storable document". They share the
 * field vocabulary but answer to different trust boundaries, so they are not
 * merged: the write gate keeps bad documents off disk, the runtime validator
 * keeps a bad entry from becoming a half-connected client.
 *
 * The module-wide DEFAULTS an operator tunes (retry count, retry backoff,
 * timeout) live in the `tools.mcp` config section (schema:
 * `shared/exposure/module-config-sections.ts` `MCP_CONFIG_SCHEMA`), surfaced
 * as the `mcp` settings module and read by the runtime bridge over the
 * `DEFAULT_MCP_MODULE_CONFIG` floor below.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import { environmentNameAllowed, MINIMAL_CHILD_ENVIRONMENT } from "../process/environment-projection.ts";
import { InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { URL_PATTERN, WS_URL_PATTERN } from "../kernel/config-contracts.ts";
import { McpError } from "./errors.ts";
import type { McpAuthConfig } from "./auth.ts";
import type { McpRetryConfig } from "./retry.ts";
import type { McpServerConfig as ConfigMcpServerConfig } from "../kernel/config-contracts.ts";
import type { McpTransportType } from "./transport/types.ts";
import { MCP_SERVER_ID_MAX_CHARACTERS, MCP_SERVER_ID_PATTERN } from "./tool-name.ts";

export type McpServerEntry = Readonly<{
  id: string;
  transport: McpTransportType;
  enabled?: boolean;
  // stdio
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  /**
   * Absolute paths the confined server process may READ and EXECUTE (its
   * install directory, its interpreter's libraries). Named by the operator,
   * never writable: a stdio server's only writable place is the home the
   * host gives it.
   */
  readPaths?: readonly string[];
  // http / websocket
  url?: string;
  headers?: Readonly<Record<string, string>>;
  subprotocol?: string;
  // auth + retry + timing
  auth?: McpAuthConfig;
  retry?: McpRetryConfig;
  protocolVersion?: string;
  timeoutMs?: number;
}>;

export type McpModuleConfig = Readonly<{
  servers: readonly McpServerEntry[];
  defaults: Readonly<{
    retry: McpRetryConfig;
    timeoutMs: number;
    protocolVersion: string;
    /**
     * How long closing a server may take: a stdio server's grace to honour
     * SIGTERM before SIGKILL, and the bound on a remote session's closing
     * DELETE. A wedged server must never hold the process (or a shutdown)
     * open, and a polite close must never be cut short — the bound is
     * between those two, operator-tunable via `tools.mcp.closeGraceMs`.
     */
    closeGraceMs: number;
    /**
     * Milliseconds before a Streamable HTTP stream the server closed early is
     * resumed, when the server sent no `retry` — and the FLOOR under a `retry`
     * it did send (a server cannot make the harness poll faster than this).
     */
    sseReconnectMs: number;
    /** The CEILING on a server-sent `retry` (an overflowing or absurd delay is clamped here). */
    sseRetryMaxMs: number;
    /** How many times ONE request's closed-early stream is resumed before it fails (`mcp_resume_exhausted`). */
    resumeAttempts: number;
    /**
     * How many requests the SERVER sent (a `ping`, or a method this client
     * does not serve) may wait for an answer at once; they are answered one
     * at a time, and one beyond the backlog is dropped and counted — a server
     * cannot make the harness fire thousands of concurrent answers.
     */
    serverRequestBacklog: number;
    /** Bytes of a stdio server's latest stderr kept (and each line's bound) for the reason its process closed. */
    stderrTailBytes: number;
    /**
     * How many stderr lines per second, per server, reach the central log;
     * the rest are counted and one line per second reports the count (the
     * tail above still keeps the newest lines).
     */
    stderrLinesPerSecond: number;
    /**
     * The ONLY variables of the harness's own environment a stdio server
     * inherits (exact names, or `PREFIX*`). Minimal on purpose — an MCP server
     * gets its own credentials explicitly through its entry's `env`, so the
     * base environment carries none; `HOME` and `TMPDIR` are set by the host
     * to the server's own home. Built by the host's one env projection.
     */
    stdioInheritedEnv: readonly string[];
    /**
     * The ONLY environment variables a server entry's `${VAR}` placeholders
     * may read (exact names or `PREFIX*`). Empty by default: a placeholder
     * could otherwise name ANY variable of the harness's environment — the
     * database passphrase included (cred-audit CRED-F14). The harness's own
     * namespace (`HARNESS_*`) can never be listed.
     */
    credentialEnv: readonly string[];
  }>;
  limits: Readonly<{
    maxServers: number;
    maxToolsPerServer: number;
  }>;
}>;

/**
 * The default module config — module-private, because `normalizeMcpModuleConfig`
 * below resolves it. A default whose owner also owns the resolver has one
 * correct reader: the resolver. Anyone who wants the fully-defaulted document
 * asks `normalizeMcpModuleConfig({})`, which is the same values plus the
 * validation, and which keeps tracking configuration when a caller supplies
 * some.
 */
const DEFAULT_MCP_MODULE_CONFIG: McpModuleConfig = deepFreeze({
  servers: [],
  defaults: {
    retry: deepFreeze({ count: 3, backoffMs: 1000 }),
    timeoutMs: ROOT_POLICY.tools.limits.defaultToolTimeoutMs,
    protocolVersion: ROOT_POLICY.contracts.mcpProtocolVersion,
    // Two seconds is generous to a server mid-flush and small beside any
    // human-noticeable shutdown. The operator override is the config owner's.
    closeGraceMs: 2_000,
    // The HTML event-stream default reconnection time is "a few seconds";
    // one second keeps a polled tool call responsive without hammering.
    sseReconnectMs: 1_000,
    // Half a minute: longer than any sensible resume delay, short enough that
    // a request still finishes inside the default tool bound.
    sseRetryMaxMs: 30_000,
    // A handful of resumes covers a flaky stream; a server that closes every
    // stream early is failing, not slow.
    resumeAttempts: 8,
    // A server sends one ping at a time; sixteen waiting answers is already
    // abnormal, and each is a request on the wire.
    serverRequestBacklog: 16,
    // Enough for a stack trace's head or the guardian's refusal line; small
    // enough to sit in a status field.
    stderrTailBytes: 8_192,
    // A chatty server's normal logging passes; a flood becomes one count per second.
    stderrLinesPerSecond: 50,
    // The MCP SDK's own default inherited set (minus HOME, which the host
    // sets): enough to find programs and speak the user's locale, and no
    // credential or proxy variable. An operator adds names deliberately.
    stdioInheritedEnv: [...MINIMAL_CHILD_ENVIRONMENT],
    credentialEnv: [],
  },
  limits: {
    maxServers: ROOT_POLICY.tools.limits.maximumMcpServers,
    maxToolsPerServer: ROOT_POLICY.tools.limits.maximumEnabledTools,
  },
});

/** Validate a single server entry. Throws `InputError` on any violation. */
export function validateMcpServerEntry(entry: McpServerEntry): void {
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MCP_SERVER_ID_MAX_CHARACTERS) {
    throw new InputError("MCP server id must be a non-empty string within length limits", "mcp_config_invalid");
  }
  if (!MCP_SERVER_ID_PATTERN.test(entry.id)) {
    throw new InputError(`MCP server id '${entry.id}' has invalid characters (letters, digits and inner hyphens only)`, "mcp_config_invalid");
  }
  if (entry.transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command.length === 0) {
      throw new InputError("stdio transport requires a 'command'", "mcp_config_invalid");
    }
  } else if (entry.transport === "http") {
    if (typeof entry.url !== "string" || !URL_PATTERN.test(entry.url)) {
      throw new InputError("http transport requires a valid http(s) 'url'", "mcp_config_invalid");
    }
  } else if (entry.transport === "websocket") {
    if (typeof entry.url !== "string" || !WS_URL_PATTERN.test(entry.url)) {
      throw new InputError("websocket transport requires a valid ws(s) 'url'", "mcp_config_invalid");
    }
  } else {
    throw new InputError(`Unknown MCP transport: ${String(entry.transport)} (use "http" with the server's Streamable HTTP endpoint for a remote server)`, "mcp_config_invalid");
  }
  if (entry.readPaths !== undefined && entry.transport !== "stdio") {
    throw new InputError("readPaths applies only to a stdio server (it names what the confined process may read)", "mcp_config_invalid");
  }
  if (entry.retry !== undefined) {
    if (!Number.isInteger(entry.retry.count) || entry.retry.count < 1) {
      throw new InputError("retry.count must be a positive integer", "mcp_config_invalid");
    }
    if (!Number.isFinite(entry.retry.backoffMs) || entry.retry.backoffMs < 0) {
      throw new InputError("retry.backoffMs must be a non-negative finite number", "mcp_config_invalid");
    }
  }
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1)) {
    throw new InputError("timeoutMs must be a positive integer", "mcp_config_invalid");
  }
  if (entry.auth !== undefined && entry.auth.type === "api-key" && entry.transport === "stdio" && entry.auth.envName === undefined) {
    throw new InputError("api-key auth on stdio requires auth.envName (the env var to set)", "mcp_config_invalid");
  }
}

/**
 * Validate a whole module config: limits + unique ids, and (by default) every
 * entry. The registry passes `perEntry: false` — it records one entry's fault
 * as that server's own typed status instead of refusing every server.
 */
export function validateMcpModuleConfig(config: McpModuleConfig, options: Readonly<{ perEntry?: boolean }> = {}): void {
  if (config.servers.length > config.limits.maxServers) {
    throw new McpError(`MCP module exceeds max servers (${config.servers.length} > ${config.limits.maxServers})`, "mcp_config_invalid", false, {});
  }
  const ids = new Set<string>();
  for (const entry of config.servers) {
    if (options.perEntry !== false) validateMcpServerEntry(entry);
    if (ids.has(entry.id)) {
      throw new InputError(`Duplicate MCP server id: ${entry.id}`, "mcp_config_invalid");
    }
    ids.add(entry.id);
  }
}

/** Normalize a raw config (e.g. from JSON) into a fully-defaulted `McpModuleConfig`. */
export type McpModuleConfigInput = Readonly<{
  servers?: McpModuleConfig["servers"];
  /** Each field is independently optional: the operator sets some, the module's default owner fills the rest. */
  defaults?: Partial<McpModuleConfig["defaults"]>;
  limits?: Partial<McpModuleConfig["limits"]>;
}>;
export function normalizeMcpModuleConfig(input: McpModuleConfigInput): McpModuleConfig {
  const servers = (input.servers ?? []).map((s) => deepFreeze({ ...s }));
  const defaults = deepFreeze({
    retry: deepFreeze({ ...DEFAULT_MCP_MODULE_CONFIG.defaults.retry, ...(input.defaults?.retry ?? {}) }),
    timeoutMs: input.defaults?.timeoutMs ?? DEFAULT_MCP_MODULE_CONFIG.defaults.timeoutMs,
    protocolVersion: input.defaults?.protocolVersion ?? DEFAULT_MCP_MODULE_CONFIG.defaults.protocolVersion,
    closeGraceMs: input.defaults?.closeGraceMs ?? DEFAULT_MCP_MODULE_CONFIG.defaults.closeGraceMs,
    sseReconnectMs: input.defaults?.sseReconnectMs ?? DEFAULT_MCP_MODULE_CONFIG.defaults.sseReconnectMs,
    sseRetryMaxMs: input.defaults?.sseRetryMaxMs ?? DEFAULT_MCP_MODULE_CONFIG.defaults.sseRetryMaxMs,
    resumeAttempts: input.defaults?.resumeAttempts ?? DEFAULT_MCP_MODULE_CONFIG.defaults.resumeAttempts,
    serverRequestBacklog: input.defaults?.serverRequestBacklog ?? DEFAULT_MCP_MODULE_CONFIG.defaults.serverRequestBacklog,
    stderrTailBytes: input.defaults?.stderrTailBytes ?? DEFAULT_MCP_MODULE_CONFIG.defaults.stderrTailBytes,
    stderrLinesPerSecond: input.defaults?.stderrLinesPerSecond ?? DEFAULT_MCP_MODULE_CONFIG.defaults.stderrLinesPerSecond,
    stdioInheritedEnv: input.defaults?.stdioInheritedEnv ?? DEFAULT_MCP_MODULE_CONFIG.defaults.stdioInheritedEnv,
    credentialEnv: input.defaults?.credentialEnv ?? DEFAULT_MCP_MODULE_CONFIG.defaults.credentialEnv,
  });
  const limits = deepFreeze({
    maxServers: input.limits?.maxServers ?? DEFAULT_MCP_MODULE_CONFIG.limits.maxServers,
    maxToolsPerServer: input.limits?.maxToolsPerServer ?? DEFAULT_MCP_MODULE_CONFIG.limits.maxToolsPerServer,
  });
  return deepFreeze({ servers, defaults, limits });
}

/**
 * Resolve the central config document's `tools.mcpServers` entries into the
 * runtime {@link McpServerEntry}. Optionals are included only when defined so
 * the assignment is exact-optional-safe under `exactOptionalPropertyTypes`.
 *
 * CONF-8: when a server does not declare its own `timeoutMs`, the caller's
 * `defaultTimeoutMs` (sourced from `tools.defaultBounds.timeoutMs` in the
 * central config document) is applied so the MCP module never falls back to
 * a hardcoded constant.
 */
export function resolveMcpServerConfigs(
  servers: readonly ConfigMcpServerConfig[],
  options: Readonly<{ defaultTimeoutMs?: number }> = {},
): readonly McpServerEntry[] {
  return servers.map((s) => deepFreeze({
    id: s.id,
    transport: s.transport,
    protocolVersion: s.protocolVersion,
    ...(s.command !== undefined ? { command: s.command } : {}),
    ...(s.args !== undefined ? { args: [...s.args] } : {}),
    ...(s.env !== undefined ? { env: { ...s.env } } : {}),
    ...(s.readPaths !== undefined ? { readPaths: [...s.readPaths] } : {}),
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.headers !== undefined ? { headers: { ...s.headers } } : {}),
    ...(s.subprotocol !== undefined ? { subprotocol: s.subprotocol } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
    ...(s.retry !== undefined ? { retry: deepFreeze({ ...s.retry }) } : {}),
    ...(s.auth !== undefined ? { auth: resolveAuth(s.auth) } : {}),
    ...(s.timeoutMs !== undefined
      ? { timeoutMs: s.timeoutMs }
      : options.defaultTimeoutMs !== undefined
        ? { timeoutMs: options.defaultTimeoutMs }
        : {}),
  }));
}

/** Build an exact-optional-safe `McpAuthConfig` from the zod-inferred config shape. */
function resolveAuth(auth: NonNullable<ConfigMcpServerConfig["auth"]>): McpAuthConfig {
  if (auth.type === "api-key") {
    return deepFreeze({
      type: "api-key",
      token: auth.token,
      ...(auth.header !== undefined ? { header: auth.header } : {}),
      ...(auth.envName !== undefined ? { envName: auth.envName } : {}),
    });
  }
  if (auth.type === "bearer") {
    return deepFreeze({
      type: "bearer",
      token: auth.token,
      ...(auth.envName !== undefined ? { envName: auth.envName } : {}),
    });
  }
  return deepFreeze({ type: "oauth", token: auth.token });
}

/**
 * The `${NAME}` placeholder grammar of a credential-bearing config value (an
 * env value, a header value, an auth token): the host replaces each one with
 * the named environment variable at connect time. ONE owner — the host's
 * resolver and the factory's refusal below read the same pattern.
 */
export const MCP_CREDENTIAL_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

/**
 * The placeholder names still present in an entry's credential-bearing
 * fields — i.e. the variables the host could not resolve. Sorted and
 * de-duplicated; empty when every credential is concrete.
 */
export function unresolvedCredentialPlaceholders(entry: McpServerEntry): readonly string[] {
  const values = [
    ...Object.values(entry.env ?? {}),
    ...Object.values(entry.headers ?? {}),
    ...(entry.auth !== undefined ? [entry.auth.token] : []),
  ];
  const names = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(MCP_CREDENTIAL_PLACEHOLDER)) names.add(match[1]!);
  }
  return Object.freeze([...names].sort());
}

/**
 * THE ${NAME} ALLOWLIST (cred-audit CRED-F14): a placeholder may name only an
 * environment variable on `tools.mcp.credentialEnv` (exact or `PREFIX*`, the
 * shared matcher). Anything else — the database passphrase, another
 * service's token — is refused typed BEFORE the host reads it.
 */
export function assertCredentialEnvPermitted(entry: McpServerEntry, allowed: readonly string[]): void {
  const refused = unresolvedCredentialPlaceholders(entry).filter((name) => !environmentNameAllowed(name, allowed));
  if (refused.length === 0) return;
  const them = refused.length === 1 ? "it" : "them";
  throw new McpError(
    `MCP server '${entry.id}' may not read ${refused.join(", ")} from the harness's environment: add ${them} to tools.mcp.credentialEnv to allow ${them}`,
    "mcp_credential_env_refused", false, { serverId: entry.id, variables: refused.join(",") },
  );
}
