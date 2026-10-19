/**
 * Shared exposure registrations — `mcp` module.
 *
 * Exposes the MCP (Model Context Protocol) module-wide defaults as settings:
 * how many times a failed server call is retried, how long to wait between
 * retries, and how long one call may take. These are the shared defaults
 * applied to every configured MCP server (`tools.mcpServers`) unless a server
 * overrides them.
 *
 * Unlike the stub-backed modules, these knobs bind DIRECTLY to the
 * `tools.mcp` config section — the MCP runtime bridge reads that section on
 * every registry build, so a settings change takes effect on the next
 * connection and persists across restarts. There is no in-memory projection
 * to keep in step: the config file is the only state, read live at
 * `current`-time through the config store.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
  readConfigCustomization,
  writeConfigCustomization,
  schemaBounds,
  type CustomizationValue,
} from "../index.ts";
import { normalizeMcpModuleConfig } from "../../../mcp/config.ts";
import { MCP_CONFIG_SCHEMA } from "../module-config-sections.ts";

/** The MCP module defaults — served when the config file omits the key. The
 * module config owner declares them (`mcp/config.ts`); this file restates
 * none of them. */
const MODULE_DEFAULTS = normalizeMcpModuleConfig({}).defaults;
const MCP_DEFAULTS = {
  retryCount: MODULE_DEFAULTS.retry.count,
  retryBackoffMs: MODULE_DEFAULTS.retry.backoffMs,
  timeoutMs: MODULE_DEFAULTS.timeoutMs,
  closeGraceMs: MODULE_DEFAULTS.closeGraceMs,
  sseReconnectMs: MODULE_DEFAULTS.sseReconnectMs,
  sseRetryMaxMs: MODULE_DEFAULTS.sseRetryMaxMs,
  resumeAttempts: MODULE_DEFAULTS.resumeAttempts,
  serverRequestBacklog: MODULE_DEFAULTS.serverRequestBacklog,
  stderrTailBytes: MODULE_DEFAULTS.stderrTailBytes,
  stderrLinesPerSecond: MODULE_DEFAULTS.stderrLinesPerSecond,
} as const;

/** A numeric knob's range, derived from the write gate's schema (`MCP_CONFIG_SCHEMA`) by the one bounds helper. */
function schemaRange(key: keyof typeof MCP_CONFIG_SCHEMA.shape): Readonly<{ min: number; max: number }> {
  const { min, max } = schemaBounds(MCP_CONFIG_SCHEMA.shape[key]);
  return { min, max };
}

/** Read an MCP default from config, falling back to the declared default when
 * the key is absent. The default is a DEFAULT, not a fallback source — the
 * config file is the only place a persisted value is read from. */
function readMcp(configPath: string, defaultValue: CustomizationValue): CustomizationValue {
  const value = readConfigCustomization(configPath);
  return value === undefined ? defaultValue : value;
}

/** A list knob, read-only: the configured list, or the module default. */
function readMcpList(configPath: string, defaultValue: readonly string[]): string {
  const value = readConfigCustomization(configPath) as unknown;
  return (Array.isArray(value) ? value as readonly string[] : defaultValue).join(", ");
}

let mcpRegistered = false;
export function registerMcpExposure(): void {
  if (mcpRegistered) return;
  mcpRegistered = true;

  // The CATEGORY this module's settings live under, in the product's own
  // words.
  registerExposureModule({
    id: "mcp",
    title: "Connected tool servers",
    purpose:
      "How the assistant talks to external tool servers (MCP): how many times a failed call is retried, how long it waits between tries, and how long one call may take.",
  });

  registerCustomization({
    id: "mcp.retryCount",
    module: "mcp",
    name: "Retries per failed server call",
    description:
      "How many times a failed call to a connected tool server is tried again before giving up. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.retryCount,
    ...schemaRange("retryCount"),
    unit: "retries",
    current: () => readMcp("tools.mcp.retryCount", MCP_DEFAULTS.retryCount),
    set: (v) => writeConfigCustomization("tools.mcp.retryCount", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.retryCount",
  });
  registerCustomization({
    id: "mcp.retryBackoff",
    module: "mcp",
    name: "Wait between retries",
    description:
      "How many milliseconds to wait before retrying a failed call to a connected tool server. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.retryBackoffMs,
    ...schemaRange("retryBackoffMs"),
    unit: "milliseconds",
    current: () => readMcp("tools.mcp.retryBackoffMs", MCP_DEFAULTS.retryBackoffMs),
    set: (v) => writeConfigCustomization("tools.mcp.retryBackoffMs", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.retryBackoffMs",
  });
  registerCustomization({
    id: "mcp.timeout",
    module: "mcp",
    name: "Time limit per server call",
    description:
      "A call to a connected tool server is abandoned after this many milliseconds. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.timeoutMs,
    min: 100,
    max: 600000,
    unit: "milliseconds",
    current: () => readMcp("tools.mcp.timeoutMs", MCP_DEFAULTS.timeoutMs),
    set: (v) => writeConfigCustomization("tools.mcp.timeoutMs", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.timeoutMs",
  });
  registerCustomization({
    id: "mcp.closeGraceMs",
    module: "mcp",
    name: "Grace for closing a tool server",
    description:
      "When the harness stops a local tool server it first asks it to exit politely; the server gets this many milliseconds to finish cleanly before it is forcibly stopped. A remote server's closing request is given the same time. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.closeGraceMs,
    ...schemaRange("closeGraceMs"),
    unit: "milliseconds",
    current: () => readMcp("tools.mcp.closeGraceMs", MCP_DEFAULTS.closeGraceMs),
    set: (v) => writeConfigCustomization("tools.mcp.closeGraceMs", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.closeGraceMs",
  });
  registerCustomization({
    id: "mcp.sseReconnectMs",
    module: "mcp",
    name: "Wait before resuming an interrupted server stream",
    description:
      "When a remote tool server closes its answer stream before the answer, the harness waits this many milliseconds (unless the server named its own wait) and then resumes the stream. Shorter answers sooner; longer asks the server less often. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.sseReconnectMs,
    ...schemaRange("sseReconnectMs"),
    unit: "milliseconds",
    current: () => readMcp("tools.mcp.sseReconnectMs", MCP_DEFAULTS.sseReconnectMs),
    set: (v) => writeConfigCustomization("tools.mcp.sseReconnectMs", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.sseReconnectMs",
  });
  registerCustomization({
    id: "mcp.sseRetryMaxMs",
    module: "mcp",
    name: "Longest wait a server may ask for before resuming",
    description:
      "A remote tool server may name how long to wait before its interrupted answer stream is resumed. The wait is never shorter than the resume wait above and never longer than this many milliseconds, so a server can neither make the harness hammer it nor stall a call. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.sseRetryMaxMs,
    ...schemaRange("sseRetryMaxMs"),
    unit: "milliseconds",
    current: () => readMcp("tools.mcp.sseRetryMaxMs", MCP_DEFAULTS.sseRetryMaxMs),
    set: (v) => writeConfigCustomization("tools.mcp.sseRetryMaxMs", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.sseRetryMaxMs",
  });
  registerCustomization({
    id: "mcp.resumeAttempts",
    module: "mcp",
    name: "Resumes of one interrupted server answer",
    description:
      "How many times one call's interrupted answer stream is resumed before the call fails. A server that closes every stream early is failing, not slow. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.resumeAttempts,
    ...schemaRange("resumeAttempts"),
    unit: "resumes",
    current: () => readMcp("tools.mcp.resumeAttempts", MCP_DEFAULTS.resumeAttempts),
    set: (v) => writeConfigCustomization("tools.mcp.resumeAttempts", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.resumeAttempts",
  });
  registerCustomization({
    id: "mcp.serverRequestBacklog",
    module: "mcp",
    name: "Server questions waiting for an answer",
    description:
      "A tool server may ask the harness questions of its own (a liveness ping). They are answered one at a time; beyond this many waiting, further ones are dropped and logged, so a server cannot make the harness send thousands of answers at once. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.serverRequestBacklog,
    ...schemaRange("serverRequestBacklog"),
    unit: "requests",
    current: () => readMcp("tools.mcp.serverRequestBacklog", MCP_DEFAULTS.serverRequestBacklog),
    set: (v) => writeConfigCustomization("tools.mcp.serverRequestBacklog", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.serverRequestBacklog",
  });
  registerCustomization({
    id: "mcp.stderrLinesPerSecond",
    module: "mcp",
    name: "Local server error lines logged per second",
    description:
      "How many lines of a local tool server's error output reach the harness log each second; the rest are counted and reported once a second, so a flood of output is one log line a second rather than millions. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.stderrLinesPerSecond,
    ...schemaRange("stderrLinesPerSecond"),
    unit: "lines per second",
    current: () => readMcp("tools.mcp.stderrLinesPerSecond", MCP_DEFAULTS.stderrLinesPerSecond),
    set: (v) => writeConfigCustomization("tools.mcp.stderrLinesPerSecond", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.stderrLinesPerSecond",
  });
  registerCustomization({
    id: "mcp.stderrTailBytes",
    module: "mcp",
    name: "Error output kept from a local server",
    description:
      "How many bytes of a local tool server's latest error output are kept to explain why it stopped (a sandbox refusal, a crash). More keeps more of a long trace; less keeps the status short. Takes effect the next time a server connection opens.",
    type: "number",
    default: MCP_DEFAULTS.stderrTailBytes,
    ...schemaRange("stderrTailBytes"),
    unit: "bytes",
    current: () => readMcp("tools.mcp.stderrTailBytes", MCP_DEFAULTS.stderrTailBytes),
    set: (v) => writeConfigCustomization("tools.mcp.stderrTailBytes", v),
    contract: { effect: "next-run" },
    configPath: "tools.mcp.stderrTailBytes",
  });
  // The security list is served read-only (edited in the config file):
  // widening what a local server inherits is not a settings-page toggle.
  // What no confined process may read is the confinement floor's
  // (`safety.keepOut`).
  registerSignal({
    id: "mcp.stdioInheritedEnv",
    module: "mcp",
    name: "Environment a local tool server inherits",
    description:
      "The only variables of the harness's own environment a local tool server receives (a name ending in * is a prefix); its credentials come from its own entry. Shown read-only; set tools.mcp.stdioInheritedEnv in the config file.",
    type: "string",
    value: () => readMcpList("tools.mcp.stdioInheritedEnv", MODULE_DEFAULTS.stdioInheritedEnv),
  });
  registerSignal({
    id: "mcp.credentialEnv",
    module: "mcp",
    name: "Environment variables a tool server's credentials may come from",
    description:
      "The only variables of the harness's environment a server entry's ${VAR} placeholders may read (a name ending in * is a prefix); anything else — the database passphrase, another service's token — is refused. The harness's own HARNESS_* variables can never be listed. Shown read-only; set tools.mcp.credentialEnv in the config file.",
    type: "string",
    value: () => readMcpList("tools.mcp.credentialEnv", MODULE_DEFAULTS.credentialEnv),
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetMcpRegistration(): void {
  mcpRegistered = false;
}
