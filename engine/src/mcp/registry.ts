/**
 * MCP registry — the central manager. One instance owns every MCP server
 * the harness knows about. It is the operational surface the runtime and
 * the exposure layer talk to.
 *
 * Responsibilities:
 * - Start every enabled server (`start`): build the client from the config
 * entry via the factory, connect, discover tools, and register each
 * tool in the harness tool registry — with zero per-tool code.
 * - Restart a crashed server transparently: the core fires
 * `onTransportClose` when the transport drops; the registry reconnects
 * and re-discovers tools, so the next tool call succeeds.
 * - Retry every tool call seamlessly: each `callTool` is wrapped in the
 * retry layer; a retryable failure triggers a reconnect + retry.
 * - Stop a server (`stop`) or all servers (`stopAll`).
 * - Track per-server + per-tool signals (calls, errors, latency, status)
 * for the exposure layer.
 *
 * The registry is the single source of truth for "which MCP servers are
 * running, what tools do they expose, and are they healthy".
 */

import { deepFreeze } from "../kernel/integrity.ts";
import { extractErrorMessage, HarnessError } from "../kernel/errors.ts";
import { bestEffortAsync } from "../shared/best-effort.ts";
import { withReconnect, type RetryAttempt } from "./retry.ts";
import { McpError } from "./errors.ts";
import { createMcpClientFromConfig, type McpClientFactoryOptions } from "./factory.ts";
import { buildRegisteredTool, createMcpToolManifestEntry } from "./tool-adapter.ts";
import { mcpToolName } from "./tool-name.ts";
import { validateMcpModuleConfig, validateMcpServerEntry, type McpModuleConfig, type McpServerEntry } from "./config.ts";
import type { McpClient, McpCallResult, McpTool } from "./core.ts";
import type { RegisteredTool } from "../runtime/tool-registry.ts";
import type { ToolManifestEntry } from "../tools/tool-manifest.ts";

/** Injectable client factory — tests pass a mock; production uses the default. */
export type McpClientFactory = (entry: McpServerEntry, options: McpClientFactoryOptions) => McpClient;

export type ServerStatus = "stopped" | "connecting" | "connected" | "error" | "reconnecting";

export type ServerSignals = Readonly<{
  id: string;
  status: ServerStatus;
  transport: string;
  toolCount: number;
  callCount: number;
  errorCount: number;
  retryCount: number;
  avgLatencyMs: number;
  lastError: string | null;
  /** The typed code of the last failure (e.g. `mcp_credential_missing`), null when it had none. */
  lastErrorCode: string | null;
  lastHealthOk: boolean | null;
  startedAt: number | null;
}>;

export type ToolSignals = Readonly<{
  id: string;
  serverId: string;
  name: string;
  callCount: number;
  errorCount: number;
  avgLatencyMs: number;
  enabled: boolean;
}>;

export type GlobalSignals = Readonly<{
  serverCount: number;
  connectedServers: number;
  totalTools: number;
  totalCalls: number;
  totalErrors: number;
  totalRetries: number;
  uptimeMs: number;
}>;

type ServerState = {
  entry: McpServerEntry;
  /** The entry's own validation refusal: this server is in error, the others run. */
  configError: HarnessError | undefined;
  client: McpClient | undefined;
  tools: readonly McpTool[];
  /** The harness name minted for each discovered tool (raw MCP name → harness name), once per registration. */
  names: Map<string, string>;
  status: ServerStatus;
  callCount: number;
  errorCount: number;
  retryCount: number;
  latencySumMs: number;
  lastError: string | null;
  lastErrorCode: string | null;
  lastHealthOk: boolean | null;
  startedAt: number | null;
  disabledTools: Set<string>;
  restartInProgress: boolean;
  startedAt0: number;
};

/**
 * What the registry hands the host with every registration: the harness name
 * it minted (the one naming owner), the pair that name resolves back to, the
 * server's tool as discovered, and its manifest entry (classification
 * included). A host that needs the pair from a name keeps this record and
 * LOOKS IT UP; nothing parses a harness name.
 */
export type McpToolRegistration = Readonly<{
  name: string;
  serverId: string;
  tool: McpTool;
  manifest: ToolManifestEntry;
}>;

export type RegistryOptions = McpClientFactoryOptions & Readonly<{
  config: McpModuleConfig;
  /** Register a discovered tool into the harness tool registry. */
  registerTool: (tool: RegisteredTool, registration: McpToolRegistration) => void;
  /** Unregister a tool (by its harness name) when its server stops. */
  unregisterTool?: (toolName: string) => void;
  /** Injectable client factory — tests pass a mock; production uses the default. */
  clientFactory?: McpClientFactory;
}>;

/** A server that did not start, with its typed code when the failure had one. */
export type McpStartError = Readonly<{ serverId: string; message: string; code: string | null }>;

export type McpRegistry = Readonly<{
  readonly started: boolean;
  start(): Promise<Readonly<{ started: readonly string[]; errors: readonly McpStartError[] }>>;
  stop(serverId: string): Promise<void>;
  stopAll(): Promise<void>;
  restart(serverId: string): Promise<void>;
  callTool(serverId: string, toolName: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallResult>;
  disableTool(serverId: string, toolName: string): void;
  enableTool(serverId: string, toolName: string): void;
  getServerSignals(serverId: string): ServerSignals | undefined;
  getAllServerSignals(): readonly ServerSignals[];
  getToolSignals(serverId: string, toolName: string): ToolSignals | undefined;
  getAllToolSignals(): readonly ToolSignals[];
  getGlobalSignals(): GlobalSignals;
  getServerIds(): readonly string[];
  getTools(serverId: string): readonly McpTool[];
  /**
   * THE reverse lookup: which (server, MCP tool) a harness name means, from
   * the names minted at registration. Undefined when no connected server
   * registered the name. Nothing parses or re-mints a name to answer this.
   */
  resolveToolName(name: string): Readonly<{ serverId: string; toolName: string }> | undefined;
}>;

export function createMcpRegistry(options: RegistryOptions): McpRegistry {
  const config = options.config;
  // Module-level faults (too many servers, a duplicate id) refuse the whole
  // registry; ONE entry's own fault (a retired "sse" transport, an id with
  // `_` or `.` from an older config) is THAT server's typed error status —
  // it never takes the other servers down.
  validateMcpModuleConfig(config, { perEntry: false });
  const states = new Map<string, ServerState>();
  /** harness name → (server, MCP tool name), for every registered tool. */
  const byName = new Map<string, Readonly<{ serverId: string; toolName: string }>>();
  const toolCallCounts = new Map<string, number>();
  const toolErrorCounts = new Map<string, number>();
  const toolLatency = new Map<string, number>();
  const globalStart = Date.now();
  let started = false;

  for (const entry of config.servers) {
    let configError: HarnessError | undefined;
    try { validateMcpServerEntry(entry); } catch (error) {
      configError = error instanceof HarnessError ? error : new McpError(extractErrorMessage(error), "mcp_config_invalid");
    }
    states.set(entry.id, {
      entry, configError, client: undefined, tools: [], names: new Map(), status: configError === undefined ? "stopped" : "error",
      callCount: 0, errorCount: 0, retryCount: 0, latencySumMs: 0,
      lastError: configError === undefined ? null : `This server's configuration is not valid: ${configError.message}. Correct or remove the entry.`,
      lastErrorCode: configError === undefined ? null : configError.code,
      lastHealthOk: null, startedAt: null,
      disabledTools: new Set(), restartInProgress: false, startedAt0: 0,
    });
  }

  function recordAttempt(serverId: string, attempt: RetryAttempt): void {
    const state = states.get(serverId);
    if (state === undefined) return;
    if (!attempt.ok) state.errorCount += 1;
    if (attempt.attempt > 1) state.retryCount += attempt.attempt - 1;
  }

  /**
   * Mint the harness names for one server's discovery, refusing a collision
   * before anything is registered: two tools of one server that mint one name
   * (only a crafted name can, the digest keeps honest ones apart) would make
   * one of them unreachable, so the whole server reports the collision and
   * contributes nothing — visible, never a silent shadow.
   */
  function mintNames(serverId: string, tools: readonly McpTool[]): readonly string[] {
    const names = tools.map((tool) => mcpToolName(serverId, tool.name));
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        throw new McpError(`MCP server '${serverId}' exposes two tools that share the harness name '${name}'`, "mcp_tool_name_collision", false, { serverId, name });
      }
      seen.add(name);
    }
    return names;
  }

  function register(client: McpClient, serverId: string, tool: McpTool, name: string): void {
    options.registerTool(
      buildRegisteredTool(client, serverId, tool, name),
      deepFreeze({ name, serverId, tool, manifest: createMcpToolManifestEntry(serverId, tool, name) }),
    );
  }

  /** Drop every registration of one server (stop, restart, drop): its names resolve no more. */
  function unregisterAll(state: ServerState): void {
    for (const name of state.names.values()) {
      byName.delete(name);
      options.unregisterTool?.(name);
    }
    state.names = new Map();
    state.tools = [];
  }

  async function connectServer(state: ServerState): Promise<void> {
    state.status = "connecting";
    const factory = options.clientFactory ?? createMcpClientFromConfig;
    const factoryOptions: McpClientFactoryOptions = deepFreeze({
      ...options,
      onTransportClose: () => {
        if (state.status === "connected" && !state.restartInProgress) {
          state.status = "reconnecting";
          // Fire-and-forget restart; the next callTool will await it.
          // A failed restart records its reason exactly as a failed connect does.
          reconnectServer(state).catch((error: unknown) => { state.status = "error"; state.lastError = extractErrorMessage(error); });
        }
      },
    });
    // The factory runs INSIDE the failure boundary: a host factory refuses
    // an entry it cannot start (a missing credential, a refused
    // confinement), and that refusal is this server's status, recorded like
    // any failed connect — never an escape that leaves it "connecting".
    let client: McpClient | undefined;
    try {
      if (state.configError !== undefined) throw state.configError;
      client = factory(state.entry, factoryOptions);
      state.client = client;
      await client.connect();
      const tools = await client.listTools();
      const names = mintNames(state.entry.id, tools);
      state.tools = tools;
      state.names = new Map(tools.map((tool, index) => [tool.name, names[index]!] as const));
      // Every discovered tool resolves — a disabled one too, so its call is
      // refused with its own cause (`mcp_tool_disabled`), never "not connected".
      tools.forEach((tool, index) => byName.set(names[index]!, deepFreeze({ serverId: state.entry.id, toolName: tool.name })));
      state.status = "connected";
      state.startedAt = Date.now();
      state.lastHealthOk = true;
      state.lastError = null;
      state.lastErrorCode = null;
      // Register each discovered tool — zero per-tool code.
      tools.forEach((tool, index) => {
        if (!state.disabledTools.has(tool.name)) register(client!, state.entry.id, tool, names[index]!);
      });
    } catch (error) {
      state.status = "error";
      if (error !== state.configError) {
        state.lastError = extractErrorMessage(error);
        state.lastErrorCode = error instanceof HarnessError ? error.code : null;
      }
      const failed = client;
      if (failed !== undefined) await bestEffortAsync(() => failed.close());
      state.client = undefined;
      throw error;
    }
  }

  async function reconnectServer(state: ServerState): Promise<void> {
    if (state.restartInProgress) return;
    state.restartInProgress = true;
    try {
      // Unregister old tools (the server may re-advertise a different set).
      unregisterAll(state);
      await bestEffortAsync(async () => { await state.client?.close(); });
      state.client = undefined;
      await connectServer(state);
    } finally {
      state.restartInProgress = false;
    }
  }

  return deepFreeze({
    get started() { return started; },

    async start() {
      // Connect servers CONCURRENTLY: a sequential loop holds the whole set's
      // startup for the SUM of the per-server connect timeouts, so one
      // unreachable remote server would stall the rest. Connecting together
      // keeps startup at the SLOWEST server's time. Each server's connect is
      // still isolated (its own state + failure), so a failed server reports
      // its error and contributes no tools without stalling or aborting the
      // others. `connectServer` mutates only its own `state`, so the map is
      // safe under concurrency (no two servers share a state entry).
      const outcomes = await Promise.all(
        config.servers
          .filter((entry) => entry.enabled !== false)
          .map(async (entry) => {
            const state = states.get(entry.id)!;
            try {
              await connectServer(state);
              return { id: entry.id, error: undefined as McpStartError | undefined };
            } catch (error) {
              return { id: entry.id, error: deepFreeze({ serverId: entry.id, message: extractErrorMessage(error), code: error instanceof HarnessError ? error.code : null }) };
            }
          }),
      );
      const startedIds: string[] = [];
      const errors: McpStartError[] = [];
      for (const outcome of outcomes) {
        if (outcome.error === undefined) startedIds.push(outcome.id);
        else errors.push(outcome.error);
      }
      started = true;
      return deepFreeze({ started: deepFreeze(startedIds), errors: deepFreeze(errors) });
    },

    async stop(serverId) {
      const state = states.get(serverId);
      if (state === undefined) return;
      unregisterAll(state);
      await bestEffortAsync(async () => { await state.client?.close(); });
      state.client = undefined;
      // A server whose entry is invalid stays in its error; stopping it is not a repair.
      if (state.configError === undefined) state.status = "stopped";
      state.startedAt = null;
    },

    async stopAll() {
      for (const id of [...states.keys()]) {
        await this.stop(id);
      }
      started = false;
    },

    async restart(serverId) {
      const state = states.get(serverId);
      if (state === undefined) return;
      await reconnectServer(state);
    },

    async callTool(serverId, toolName, args, signal) {
      const state = states.get(serverId);
      if (state === undefined) {
        throw new McpError(`MCP server '${serverId}' is not registered`, "mcp_server_not_registered", false, { serverId });
      }
      if (state.client === undefined) {
        // The server IS registered — its connect failed, a reconnect is in
        // flight, or the registry was stopped. That is a connectivity
        // refusal, never a "not registered" one: misnaming it sends the user
        // to configure a server that is already configured and hides the
        // real cause. Unlike the client-level "not connected" below, this
        // door throws BEFORE the retry wrapper — nothing here self-heals a
        // clientless state — so the refusal is not marked retryable; the way
        // back is a start().
        throw new McpError(`MCP server '${serverId}' is not connected`, "mcp_not_connected", false, { serverId }, true);
      }
      if (state.disabledTools.has(toolName)) {
        throw new McpError(`MCP tool '${toolName}' on '${serverId}' is disabled`, "mcp_tool_disabled", false, { serverId, toolName });
      }
      const retry = state.entry.retry ?? config.defaults.retry;
      const toolId = state.names.get(toolName) ?? toolName;
      const start = Date.now();
      try {
        const result = await withReconnect(
          (sig) => state.client!.callTool(toolName, args, sig),
          async () => { await reconnectServer(state); },
          { retry, ...(signal !== undefined ? { signal } : {}), onAttempt: (a) => recordAttempt(serverId, a) },
        );
        const dur = Date.now() - start;
        state.callCount += 1;
        state.latencySumMs += dur;
        toolCallCounts.set(toolId, (toolCallCounts.get(toolId) ?? 0) + 1);
        toolLatency.set(toolId, (toolLatency.get(toolId) ?? 0) + dur);
        return result;
      } catch (error) {
        state.errorCount += 1;
        state.lastError = extractErrorMessage(error);
        toolErrorCounts.set(toolId, (toolErrorCounts.get(toolId) ?? 0) + 1);
        throw error;
      }
    },

    disableTool(serverId, toolName) {
      const state = states.get(serverId);
      if (state === undefined) return;
      state.disabledTools.add(toolName);
      const name = state.names.get(toolName);
      if (name !== undefined) options.unregisterTool?.(name);
    },

    enableTool(serverId, toolName) {
      const state = states.get(serverId);
      if (state === undefined) return;
      state.disabledTools.delete(toolName);
      const tool = state.tools.find((t) => t.name === toolName);
      const name = state.names.get(toolName);
      if (tool !== undefined && name !== undefined && state.client !== undefined) {
        register(state.client, serverId, tool, name);
      }
    },

    getServerSignals(serverId) {
      const state = states.get(serverId);
      if (state === undefined) return undefined;
      const avg = state.callCount > 0 ? state.latencySumMs / state.callCount : 0;
      return deepFreeze({
        id: serverId, status: state.status, transport: state.entry.transport,
        toolCount: state.tools.length, callCount: state.callCount, errorCount: state.errorCount,
        retryCount: state.retryCount, avgLatencyMs: avg, lastError: state.lastError, lastErrorCode: state.lastErrorCode,
        lastHealthOk: state.lastHealthOk, startedAt: state.startedAt,
      });
    },

    getAllServerSignals() {
      return deepFreeze([...states.keys()].map((id) => this.getServerSignals(id)!));
    },

    getToolSignals(serverId, toolName) {
      const state = states.get(serverId);
      const toolId = state?.names.get(toolName);
      if (state === undefined || toolId === undefined) return undefined;
      const calls = toolCallCounts.get(toolId) ?? 0;
      const errors = toolErrorCounts.get(toolId) ?? 0;
      const lat = toolLatency.get(toolId) ?? 0;
      return deepFreeze({
        id: toolId, serverId, name: toolName,
        callCount: calls, errorCount: errors,
        avgLatencyMs: calls > 0 ? lat / calls : 0,
        enabled: !state.disabledTools.has(toolName),
      });
    },

    getAllToolSignals() {
      const out: ToolSignals[] = [];
      for (const [serverId, state] of states) {
        for (const tool of state.tools) {
          out.push(this.getToolSignals(serverId, tool.name)!);
        }
      }
      return deepFreeze(out);
    },

    getGlobalSignals() {
      let totalCalls = 0, totalErrors = 0, totalRetries = 0, connected = 0, totalTools = 0;
      for (const state of states.values()) {
        totalCalls += state.callCount;
        totalErrors += state.errorCount;
        totalRetries += state.retryCount;
        if (state.status === "connected") connected += 1;
        totalTools += state.tools.length;
      }
      return deepFreeze({
        serverCount: states.size, connectedServers: connected, totalTools,
        totalCalls, totalErrors, totalRetries, uptimeMs: Date.now() - globalStart,
      });
    },

    getServerIds() { return deepFreeze([...states.keys()]); },
    getTools(serverId) { return states.get(serverId)?.tools ?? deepFreeze([]); },
    resolveToolName(name) { return byName.get(name); },
  });
}
