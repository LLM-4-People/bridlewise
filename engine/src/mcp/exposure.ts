/**
 * MCP exposure — the single shared surface through which the harness (and
 * the LLM via tools) inspects and controls the MCP module. Every function
 * here is dynamically computed from live registry state — no static facts,
 * no cached snapshots that can drift.
 *
 * Three categories:
 * - **Signals** (read-only): per-server, per-tool, global, health, config
 * projection. Used for observability and the MCP status command.
 * - **Actions** (mutating): start/stop/restart, call a tool, disable/enable
 * a tool, retry the last failed call. Used for operational control.
 * - **Customization** (config): per-server, per-tool, and global config
 * knobs. Used for live reconfiguration without restart where possible.
 *
 * The exposure is a frozen record of functions — the "shared exposure
 * functions" the harness uses for every module. The registry owns the
 * mutable state; exposure only reads/writes through the registry's API.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import type { McpRegistry, GlobalSignals, ServerSignals, ToolSignals } from "./registry.ts";
import type { McpCallResult } from "./core.ts";
import type { McpModuleConfig, McpServerEntry } from "./config.ts";
import type { McpRetryConfig } from "./retry.ts";
import { redactHeaders } from "./headers.ts";
import { authHeaders } from "./auth.ts";
import { mergeHeaders } from "./headers.ts";

export type McpExposure = Readonly<{
  // Signals
  signals: Readonly<{
    global(): GlobalSignals;
    server(serverId: string): ServerSignals | undefined;
    allServers(): readonly ServerSignals[];
    tool(serverId: string, toolName: string): ToolSignals | undefined;
    allTools(): readonly ToolSignals[];
    config(): Readonly<{ servers: readonly ServerEntryProjection[]; defaults: McpModuleConfig["defaults"]; limits: McpModuleConfig["limits"] }>;
  }>;
  // Actions
  actions: Readonly<{
    start(): Promise<Readonly<{ started: readonly string[]; errors: Readonly<{ serverId: string; message: string }[]> }>>;
    stop(serverId: string): Promise<void>;
    stopAll(): Promise<void>;
    restart(serverId: string): Promise<void>;
    callTool(serverId: string, toolName: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallResult>;
    disableTool(serverId: string, toolName: string): void;
    enableTool(serverId: string, toolName: string): void;
  }>;
  // Customization (read-only projection of the config; live mutation is via the config owner)
  customization: Readonly<{
    perServer(serverId: string): ServerCustomization | undefined;
    perTool(serverId: string, toolName: string): ToolCustomization | undefined;
    global(): GlobalCustomization;
  }>;
}>;

export type ServerEntryProjection = Readonly<{
  id: string;
  transport: string;
  enabled: boolean;
  url?: string;
  command?: string;
  headers: Readonly<Record<string, string>>;
  authType: string | null;
  retry: McpRetryConfig;
  timeoutMs: number;
  protocolVersion: string;
}>;

export type ServerCustomization = Readonly<{
  transport: string;
  headers: Readonly<Record<string, string>>;
  authType: string | null;
  retry: McpRetryConfig;
  timeoutMs: number;
  enabled: boolean;
}>;

export type ToolCustomization = Readonly<{
  serverId: string;
  name: string;
  enabled: boolean;
}>;

export type GlobalCustomization = Readonly<{
  defaults: McpModuleConfig["defaults"];
  limits: McpModuleConfig["limits"];
  serverCount: number;
}>;

export function createMcpExposure(registry: McpRegistry, config: McpModuleConfig): McpExposure {
  function projectServer(entry: McpServerEntry): ServerEntryProjection {
    // Project the MERGED headers (custom + auth-derived), redacted — so the
    // operator sees exactly what goes on the wire, with secrets masked.
    const mergedHeaders = mergeHeaders(authHeaders(entry.auth), entry.headers);
    return deepFreeze({
      id: entry.id,
      transport: entry.transport,
      enabled: entry.enabled !== false,
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      headers: redactHeaders(mergedHeaders),
      authType: entry.auth?.type ?? null,
      retry: entry.retry ?? config.defaults.retry,
      timeoutMs: entry.timeoutMs ?? config.defaults.timeoutMs,
      protocolVersion: entry.protocolVersion ?? config.defaults.protocolVersion,
    });
  }

  return deepFreeze({
    signals: deepFreeze({
      global: () => registry.getGlobalSignals(),
      server: (serverId) => registry.getServerSignals(serverId),
      allServers: () => registry.getAllServerSignals(),
      tool: (serverId, toolName) => registry.getToolSignals(serverId, toolName),
      allTools: () => registry.getAllToolSignals(),
      config: () => deepFreeze({
        servers: config.servers.map(projectServer),
        defaults: config.defaults,
        limits: config.limits,
      }),
    }),
    actions: deepFreeze({
      start: () => registry.start(),
      stop: (serverId) => registry.stop(serverId),
      stopAll: () => registry.stopAll(),
      restart: (serverId) => registry.restart(serverId),
      callTool: (serverId, toolName, args, signal) => registry.callTool(serverId, toolName, args, signal),
      disableTool: (serverId, toolName) => registry.disableTool(serverId, toolName),
      enableTool: (serverId, toolName) => registry.enableTool(serverId, toolName),
    }),
    customization: deepFreeze({
      perServer: (serverId) => {
        const entry = config.servers.find((s) => s.id === serverId);
        if (entry === undefined) return undefined;
        const mergedHeaders = mergeHeaders(authHeaders(entry.auth), entry.headers);
        return deepFreeze({
          transport: entry.transport,
          headers: redactHeaders(mergedHeaders),
          authType: entry.auth?.type ?? null,
          retry: entry.retry ?? config.defaults.retry,
          timeoutMs: entry.timeoutMs ?? config.defaults.timeoutMs,
          enabled: entry.enabled !== false,
        });
      },
      perTool: (serverId, toolName) => {
        const entry = config.servers.find((s) => s.id === serverId);
        if (entry === undefined) return undefined;
        const signals = registry.getToolSignals(serverId, toolName);
        if (signals === undefined) return undefined;
        return deepFreeze({ serverId, name: toolName, enabled: signals.enabled });
      },
      global: () => deepFreeze({
        defaults: config.defaults,
        limits: config.limits,
        serverCount: config.servers.length,
      }),
    }),
  });
}
