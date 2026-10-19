/**
 * MCP runtime owner (web server) — the SINGLE process-scoped host for live
 * MCP connections. The engine's MCP module (`engine/src/mcp/`) owns the
 * transports, the JSON-RPC core, the registry/lifecycle (connect, discover,
 * retry, crash-restart, signals). This module is a thin hosting layer: it
 * resolves the harness config's `tools.mcpServers` into the registry's
 * config shape, starts the registry lazily on first use, supplies the
 * stdio spawn function, and exposes the registry's live state to the
 * routes + the tool executor.
 *
 * Deny-by-default: an MCP tool that is not discovered is not in the manifest
 * and is not callable; a server that fails to connect contributes its tools
 * to nobody and reports its failure honestly through the registry signals.
 * There is no second path that answers "what MCP tools exist" — the manifest
 * owner (tools-bridge) asks THIS owner, and the executor's dynamic dispatch
 * asks THIS owner.
 *
 * Lifecycle: LAZY, not startup-eager. A dev config can list remote servers
 * (Streamable HTTP) that are unreachable from the operator's network; connecting
 * them during server boot would hold the listen for the full connect timeout
 * and spawn stdio children nobody asked for yet. The first consumer — the
 * `/api/mcp/servers` status route, the tool manifest, or a chat run's tool
 * call — triggers one shared connection attempt, memoised as a promise so
 * concurrent callers never double-connect. The server process closes every
 * client on shutdown via `stopAllMcpConnections` (called from
 * `server/index.ts` `shutdown()`).
 *
 * stdio trust model. The operator chose WHICH server runs, but the MODEL
 * chooses what it is asked to do: a tool's arguments (a path, a query, a
 * command) are model-directed exactly like `execute_command`'s argv, and the
 * safety gate checks only that the tool exists and the arguments fit its
 * schema. A stdio server is therefore a model-directed proxy, and it is
 * CONFINED like every other model-directed process — by the one confinement
 * owner (`server/safety/landlock-runner.ts`, purpose `mcp-server`):
 *
 *   - its only writable root is a harness-owned home of its own
 *     (`mcpServerHomeDir`), which is also its working directory, `HOME` and
 *     temp directory (`TMPDIR` = `<home>/.tmp`) — never the project, because
 *     project file effects go only through the governed native tools (write
 *     set, editor, rollback, timeline). It gets no project scratch folder and
 *     none of the operator's `selfProtection` allow-rules (those widen what
 *     COMMANDS reach, not every MCP server). The safety floor's device files
 *     (`/dev`) stay writable, as for every confined process;
 *   - it can read and execute its own installation (`readPaths`, named by the
 *     operator), the interpreter, and the safety floor — nothing writable is
 *     executable (the owner refuses a read path overlapping a write root), so
 *     code fetched at run time (`npx -y`, `uvx`) cannot run and servers are
 *     pre-installed and pinned. A read path overlapping (by identity, so a
 *     bind-mount alias counts) a refused path — the compiler floor's ONE
 *     policy: credential stores, any checkout's database key, the harness's
 *     code, databases, key and config, and the declared project roots — is
 *     refused, wherever the harness is installed;
 *   - its environment is `tools.mcp.stdioInheritedEnv` (a minimal list, built
 *     by the one env projection `buildSubprocessEnv`, via `inheritedProcessEnv`) plus `HOME`, `TMPDIR`
 *     and the entry's own configured credentials — never this process's
 *     environment, and not `execute_command`'s wider allowlist;
 *   - with self-protection unavailable it is REFUSED (typed, logged at the
 *     owner, visible on the server's status); only an operator's explicit
 *     `selfProtection.enabled: false` starts it unconfined — logged, and
 *     shown as the server's `confinement` signal;
 *   - NETWORK EGRESS IS NOT RESTRICTED: Landlock confines the filesystem
 *     only. A confined server can reach the network and could send out
 *     whatever it can read — which is why what it can read is kept minimal.
 *
 * The MCP module holds no process capability of its own: this host's
 * `mcpServerClient` hands it the confined spawn per entry. Auth tokens route
 * through `mcp/headers.ts` `redactHeaders` before anything reaches the LLM or
 * logs, and a `${VAR}` credential the environment does not define makes the
 * server "not connected" (`mcp_credential_missing`), never a request that
 * sends the placeholder.
 */

import type { ChildProcess } from "node:child_process";
import { canonicalHash, deepFreeze, ROOT_POLICY, guarded } from "../kernel/canonical.ts";
import { HarnessError, extractErrorMessage } from "../../engine/src/kernel/errors.ts";
import { McpError } from "../../engine/src/mcp/errors.ts";
import { mcpUnavailableReason } from "../kernel/canonical.ts";
import type { McpClient, McpClientFactoryOptions, McpRegistry, McpServerEntry, McpServerSignals, McpToolRegistration } from "../kernel/canonical.ts";
import { createMcpClientFromConfig, createMcpRegistry, isMcpServerId, MCP_CREDENTIAL_PLACEHOLDER, mcpToolNameHead, normalizeMcpModuleConfig, resolveMcpServerConfigs, assertCredentialEnvPermitted } from "../kernel/canonical.ts";
import type { McpModuleConfig } from "../kernel/canonical.ts";
import { webDebugLog, webWarn } from "../observability/debug-bridge.ts";
import { registerComponent } from "../observability/component-registry.ts";
import { inheritedProcessEnv } from "../kernel/config.ts";
import { getMcpServers, getMcpDefaults, getToolBounds } from "../kernel/harness-config.ts";
import { heldSetOf, type HeldEntry, type HeldSet } from "../../engine/src/privacy/held-set.ts";
import { DEFAULT_PRIVACY_POLICY, redactionReplacement } from "../kernel/canonical.ts";
import { knownSecretShapeRefusal } from "../../engine/src/privacy/secret-intelligence.ts";
import { ensureMcpServerHomeDir, prepareConfinedSpawnForMcpServer, spawnPlanned } from "../safety/landlock-runner.ts";
import { ServiceUnavailableError } from "../kernel/errors.ts";
import type { McpConfinementState } from "../../shared/wire-types.ts";

/**
 * The ONE warn payload for an error the bridge caught. A typed error
 * (`HarnessError`, e.g. an `McpError` rejection drained during teardown)
 * carries its classification — `code` + `retryable` — alongside the message:
 * a flattened message string alone makes "the runtime was superseded" and
 * "a server genuinely refused" indistinguishable to whoever reads the warn.
 * An untyped error keeps the message-only shape honestly (inventing a code
 * for it would be a lie). Every best-effort catch in this module routes
 * through here — never an inline message-only payload built at the call
 * site — so the shape can never drift per call site.
 */
export function mcpWarnErrorPayload(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof HarnessError) {
    return Object.freeze({ error: extractErrorMessage(error), code: error.code, retryable: error.retryable });
  }
  return Object.freeze({ error: extractErrorMessage(error) });
}

/** One interpolation site: `${VAR}` in a config string reads the process
 * env at connect time (the grammar is the engine config owner's). A `${VAR}`
 * that resolves to nothing stays in the value, and the client factory then
 * REFUSES the entry as `mcp_credential_missing`, naming the variable — the
 * server is "not connected", and no request ever carries the placeholder as
 * if it were the secret. Resolved values are HELD for this server (the
 * client {@link mcpServerClient} builds masks them in everything the server
 * authors), so what it sends back is masked before it reaches the model, the
 * user or the log. */
function resolveEnvPlaceholders(value: string, register: (v: string, label: string) => void, label: string, permitted: Readonly<Record<string, string>>): string {
  const resolved = value.replace(MCP_CREDENTIAL_PLACEHOLDER, (whole, name: string) => {
    const envValue = permitted[name];
    if (envValue !== undefined) {
      register(envValue, `${label}:${name}`);
      return envValue;
    }
    return whole;
  });
  // A value with NO placeholder intent (`${`) is a LITERAL credential field —
  // an MCP env value (or header, or auth token — every caller of this helper)
  // written straight into the config. It occupies the same credential-bearing
  // slot a placeholder resolution returns into, so it is held under the
  // field's own label too (admitted by the registry's grammar: a short
  // innocuous string such as "stdio" is never held); a leftover `${VAR}`
  // spelling (the variable is unset) is not credential material.
  if (!value.includes("${")) register(resolved, label);
  return resolved;
}

/**
 * Resolve every `${VAR}` placeholder in a server entry's credential-bearing
 * fields (env values, header values, auth token). Returns a NEW entry — the
 * config cache's frozen object is never mutated. Every resolved value — and
 * every LITERAL one (no `${` placeholder intent: a config that carries a
 * token directly must not leak it merely because it did not come from the
 * environment) — is HELD for this server (labelled by the server id +
 * field) and returned with the entry: the client door masks everything the
 * server produces with it ({@link maskedServerClient}).
 *
 * Called by {@link mcpServerClient} — the one door both a live connect and
 * the settings room's test verb build a client through, so a probe can never
 * resolve placeholders differently from the runtime.
 */
function resolveServerSecrets(
  entry: ReturnType<typeof resolveMcpServerConfigs>[number],
): Readonly<{ entry: ReturnType<typeof resolveMcpServerConfigs>[number]; held: HeldSet }> {
  // HELD FOR THIS SERVER, NOT REGISTERED PROCESS-WIDE (secd-security
  // SECD-C3): the process-wide registry masks every user-observable surface,
  // so equality there answers a guess typed anywhere (a chat title masked
  // when it equals the admin's `PGPASSWORD`). A server's credentials are
  // masked where that server's own output flows: everything its client
  // answers or raises, and its stderr lines.
  const held: HeldEntry[] = [];
  const register = (v: string, label: string): void => {
    // The registry's own admission grammar (length floor, no whitespace, not
    // a URL): a short innocuous value ("stdio") would mask itself everywhere.
    if (knownSecretShapeRefusal(v) === undefined) held.push({ value: v.trim(), label });
  };
  // ONLY the operator's `tools.mcp.credentialEnv` names may be read: a
  // placeholder naming anything else — the database passphrase, another
  // service's token — is refused typed before anything is resolved.
  const allowed = mcpModuleDefaults().credentialEnv;
  assertCredentialEnvPermitted(entry, allowed);
  const permitted = inheritedProcessEnv(allowed);
  const env = entry.env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(entry.env).map(([k, v]) => [k, resolveEnvPlaceholders(v, register, `mcp-server/${entry.id}/env/${k}`, permitted)]),
      );
  const headers = entry.headers === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(entry.headers).map(([k, v]) => [k, resolveEnvPlaceholders(v, register, `mcp-server/${entry.id}/header/${k}`, permitted)]),
      );
  const auth = entry.auth === undefined
    ? undefined
    : { ...entry.auth, token: resolveEnvPlaceholders(entry.auth.token, register, `mcp-server/${entry.id}/auth/${entry.auth.type}`, permitted) };
  return Object.freeze({
    entry: deepFreeze({
      ...entry,
      ...(env !== undefined ? { env } : {}),
      ...(headers !== undefined ? { headers: deepFreeze(headers) } : {}),
      ...(auth !== undefined ? { auth: deepFreeze(auth) } : {}),
    }),
    held: heldSetOf(held),
  });
}

/**
 * THE ONE MASK FOR WHAT A CONFIGURED SERVER AUTHORS — INTERIM: deleted by
 * CRED-3/CRED-7, where MCP secrets become `cred:` handles on the per-run
 * HeldSet (cred-final §8.1, §11). The client {@link mcpServerClient} builds,
 * wrapped so everything the server produces passes that server's own held
 * credentials before anything above sees it: the server info `connect`
 * answers; every tool's name, description, title, input schema and
 * annotations (what the model reads, and prompt-registry §1.3's variables);
 * every call result (text parts, across part boundaries, and structured
 * content); the words of every error `connect`, `listTools` and `callTool`
 * raise — a JSON-RPC error, an HTTP error body, a stdio server's last stderr
 * words, which become the registry's `lastError` (served to every signed-in
 * user) and the test verb's detail. Masking at three call sites missed
 * those (sec-e-design H2). Held per server, never process-wide (no equality
 * oracle, SECD-C3).
 */
function maskedServerClient(client: McpClient, held: HeldSet, marker: string): McpClient {
  const answered = async <T>(answer: Promise<T>, mask: (value: T) => T): Promise<T> => {
    let value: T;
    try {
      value = await answer;
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      const message = held.scrub(error.message, marker);
      throw message === error.message ? error : new McpError(message, error.code, error.retryable, error.safeDetails, error.transportLevel);
    }
    return mask(value);
  };
  return Object.freeze({
    get serverId() { return client.serverId; },
    get connected() { return client.connected; },
    connect: (signal?: AbortSignal) => answered(client.connect(signal), (info) => held.scrubStrings(info, marker)),
    listTools: (signal?: AbortSignal) => answered(client.listTools(signal), (tools) => held.scrubStrings(tools, marker)),
    callTool: (name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => answered(client.callTool(name, args, signal), (result) => held.scrubAcrossTextParts(result, marker)),
    close: () => client.close(),
  });
}

/**
 * Start one stdio MCP server CONFINED — the spawn the transport receives for
 * `entry`, bound per entry by {@link mcpServerClient}. The confinement owner
 * decides (`prepareConfinedSpawnForMcpServer` → `prepareConfinedSpawn` purpose `mcp-server`, with the server's home as the only
 * writable root and the operator's `readPaths` as read+execute tool paths)
 * and the owner's one door launches (`spawnPlanned`). A refusal throws
 * (typed, with the owner's reason code) and the transport reports it as the
 * server's `mcp_spawn_refused` status; nothing is started.
 *
 * Every child is a census component for exactly its lifetime, and its facts
 * say how it runs (`confined` / `unconfined`, with the reason when
 * unconfined). Exported because the census guard reads its body.
 */
export function mcpStdioSpawn(
  entry: McpServerEntry,
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; stdio: readonly ["pipe", "pipe", "pipe"] }>,
): ChildProcess {
  const plan = prepareConfinedSpawnForMcpServer({
    serverId: entry.id, command, args, home: options.cwd,
    readPaths: entry.readPaths ?? [],
  });
  confinementByServer.set(entry.id, plan.kind === "refused"
    ? { confinement: "refused", confinementReason: plan.code }
    : { confinement: plan.kind, confinementReason: plan.kind === "unconfined" ? plan.reason : null });
  if (plan.kind === "refused") {
    throw new ServiceUnavailableError(plan.message, plan.code);
  }
  let child: ChildProcess;
  try {
    child = spawnPlanned(plan, { cwd: options.cwd, env: options.env, stdio: [...options.stdio] });
  } catch (error) {
    // A launch that throws never produced a child: the plan's spec file is
    // released here, since no exit/error event will ever do it.
    if (plan.kind === "confined") plan.release();
    throw error;
  }
  // ANATOMY REGISTRATION — at the owner, on the spawn path: every stdio
  // MCP child this bridge starts is a registry component for exactly its
  // lifetime. Exit covers a normal close + teardown (`stopAllMcpConnections`)
  // and a crash; error covers a spawn that never produced a live child —
  // unregister is idempotent, so both paths firing is a no-op the second
  // time, never a throw out of teardown. The confined plan's spec file is
  // released on the same two events.
  const unregister = registerComponent({
    kind: "mcp-child",
    label: `${command} ${args.join(" ")}`,
    provenance: "server/integrations/mcp-runtime-bridge.ts mcpStdioSpawn (config tools.mcpServers)",
    facts: {
      serverId: entry.id,
      command,
      args: [...args],
      confinement: plan.kind,
      ...(plan.kind === "unconfined" ? { reason: plan.reason } : {}),
    },
  });
  const release = guarded("mcp.server-process.release", (): void => {
    unregister();
    if (plan.kind === "confined") plan.release();
  });
  child.once("exit", release);
  // Surface spawn errors through the transport's close handler rather than
  // an unhandled 'error' event that would crash the server process.
  child.once("error", release);
  child.on("error", guarded("mcp.server-process.error", () => {
    // The transport's own close handler reports the failure.
  }));
  return child;
}

/**
 * THE ONE DOOR a client for a configured MCP server is built through — the
 * registry's `clientFactory`, and the settings room's test verb. It resolves
 * the entry's `${VAR}` credentials (registering them with the redaction
 * owner) and, for a stdio entry, places the server: its harness-owned home
 * (created 0700) as working directory and `HOME`, the subprocess allowlist as
 * its environment, and the confined spawn above. A refusal (a missing
 * credential, a refused confinement) is thrown typed, and the registry
 * records it as the server's status.
 */
export function mcpServerClient(entry: McpServerEntry, options: McpClientFactoryOptions): McpClient {
  const { entry: resolved, held } = resolveServerSecrets(entry);
  const marker = redactionReplacement("secret", DEFAULT_PRIVACY_POLICY);
  // Its stderr lines are its own words too: masked before the sink sees them.
  const onStderr = options.onStderr;
  const masked: McpClientFactoryOptions = onStderr === undefined ? options : { ...options, onStderr: (serverId, line) => onStderr(serverId, held.scrub(line, marker)) };
  if (resolved.transport !== "stdio") return maskedServerClient(createMcpClientFromConfig(resolved, masked), held, marker);
  const home = ensureMcpServerHomeDir(resolved.id);
  return maskedServerClient(createMcpClientFromConfig(resolved, {
    ...masked,
    stdioHost: {
      cwd: home,
      // The MCP list, not `execute_command`'s: a server gets its own
      // credentials from its entry, so its inherited base carries none.
      // TMPDIR/TMP/TEMP are set by the spawn door itself (`spawnPlanned`: `<home>/.tmp`).
      environment: { ...inheritedProcessEnv(mcpModuleDefaults().stdioInheritedEnv), HOME: home },
      spawn: (command, args, spawnOptions) => mcpStdioSpawn(resolved, command, args, spawnOptions),
    },
  }), held, marker);
}

/**
 * The configured entries as the engine's runtime entries: the protocol
 * version filled (the web config shape declares it optional) and, for an
 * entry without its own `timeoutMs`, the module timeout in force
 * (`tools.mcp.timeoutMs`, else the operator's tool bound) — never a literal.
 */
export function resolveConfiguredMcpServers(
  servers: readonly McpServerEntry[],
  defaults: McpModuleConfig["defaults"] = mcpModuleDefaults(),
): ReturnType<typeof resolveMcpServerConfigs> {
  return resolveMcpServerConfigs(
    servers.map((s) => ({ ...s, protocolVersion: s.protocolVersion ?? ROOT_POLICY.contracts.mcpProtocolVersion })) as Parameters<typeof resolveMcpServerConfigs>[0],
    { defaultTimeoutMs: defaults.timeoutMs },
  );
}

/**
 * THE client options every MCP client is built with — the registry's and the
 * settings test verb's alike, so a probe connects exactly as the runtime
 * does (the same timeouts, resume bounds, stderr sink; the cleartext decision
 * is the outbound door's own, `network.cleartextRemote`).
 */
export function mcpClientFactoryOptions(defaults: McpModuleConfig["defaults"] = mcpModuleDefaults()): McpClientFactoryOptions {
  return deepFreeze({
    clientInfo: deepFreeze({ name: ROOT_POLICY.id, version: String(ROOT_POLICY.version) }),
    defaultProtocolVersion: ROOT_POLICY.contracts.mcpProtocolVersion,
    defaultTimeoutMs: defaults.timeoutMs,
    closeGraceMs: defaults.closeGraceMs,
    sseReconnectMs: defaults.sseReconnectMs,
    sseRetryMaxMs: defaults.sseRetryMaxMs,
    resumeAttempts: defaults.resumeAttempts,
    serverRequestBacklog: defaults.serverRequestBacklog,
    stderrTailBytes: defaults.stderrTailBytes,
    stderrLinesPerSecond: defaults.stderrLinesPerSecond,
    onStderr: logMcpServerStderr,
  });
}

/**
 * The lines a stdio server writes to stderr reach the central log (the
 * transport drains the pipe, bounded, and hands over at most
 * `tools.mcp.stderrLinesPerSecond` lines a second plus one count of the
 * rest; the spec says stderr is not an error channel, so the level is
 * informational). Shared by the registry and the settings test verb; the
 * client door has masked the server's credentials in `line` already.
 */
function logMcpServerStderr(serverId: string, line: string): void {
  webDebugLog("mcp-runtime", "info", "MCP server stderr", () => ({ serverId, line }));
}

/**
 * The MCP module defaults in force: the operator's `tools.mcp` overrides over
 * the module config owner's defaults (`normalizeMcpModuleConfig`) — one
 * composition, read by the registry build, the client door and the spawn.
 * An unset `timeoutMs` is the operator's tool bound (the same source
 * `execute_command` reads), never a literal.
 */
export function mcpModuleDefaults(): McpModuleConfig["defaults"] {
  const { retryCount, retryBackoffMs, timeoutMs, ...rest } = getMcpDefaults();
  const set = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Partial<McpModuleConfig["defaults"]>;
  const base = normalizeMcpModuleConfig({}).defaults;
  return normalizeMcpModuleConfig({ defaults: {
    ...set,
    retry: { count: retryCount ?? base.retry.count, backoffMs: retryBackoffMs ?? base.retry.backoffMs },
    timeoutMs: timeoutMs ?? getToolBounds().timeoutMs,
  } }).defaults;
}

/**
 * How each stdio server's LAST start was placed — the confinement owner's
 * decision, recorded at the spawn: `confined`, `unconfined` (with the
 * operator's reason) or `refused` (with the owner's code). A remote server has
 * no process: `remote`. Served with the registry's signals.
 */
const confinementByServer = new Map<string, Readonly<{ confinement: McpConfinementState; confinementReason: string | null }>>();

/** The registry's signals of one server, joined with its confinement state. */
export type McpServerLiveSignals = McpServerSignals & Readonly<{ confinement: McpConfinementState | null; confinementReason: string | null }>;

/**
 * The registry's tool-registration callbacks feed the in-memory tool
 * surface the manifest owner reads. Kept as a plain Map (insertion-ordered,
 * keyed by harness name) so the manifest's MCP enumeration is deterministic.
 * Each entry is the registry's own registration record: the harness name it
 * minted, the (server, tool) pair that name resolves to, and the manifest
 * entry (with the tool's read/write classification). Nothing parses a
 * harness name: dispatch looks the pair up in the registry (`locateMcpTool`).
 */
type DiscoveredTool = Readonly<{
  /** The harness name (`mcp__<server>__<tool>`) — what the model calls. */
  id: string;
  serverId: string;
  /** The MCP server's own tool name. */
  name: string;
  manifest: McpToolRegistration["manifest"];
}>;

type OwnerState = {
  /** The memoised NEWEST start promise — the memoisation slot. Draining is
   * NOT keyed on this slot: supersession overwrites it while the displaced
   * chain still runs, so the slot alone can never answer "which starts are
   * in flight?" — `outstanding` does. */
  starting: Promise<McpRegistry> | undefined;
  /** EVERY start transition that has not settled yet. Teardown drains this
   * whole set, not the `starting` slot: a superseded build stops itself when
   * it loses the fence, and that self-stop lives INSIDE its chain — so
   * awaiting every chain is awaiting every build's stop, and forgetting one
   * is impossible because the set is registered at the same stamp site that
   * assigns the slot. */
  outstanding: Set<Promise<McpRegistry>>;
  registry: McpRegistry | undefined;
  /** Discovered tools by harness name, mirroring exactly
   * one PUBLISHED generation: swapped wholesale when a build's fence passes,
   * then mutated by that registry's own lifecycle until the next publish.
   * An in-flight build accumulates into its own buffer, never here. */
  tools: Map<string, DiscoveredTool>;
  /** The config fingerprint the registry was built from — a config edit
   * (mtime change) rebuilds the registry on the next `ensureStarted`. */
  fingerprint: string | undefined;
  /** Fencing token for the start lifecycle: every start stamps the current
   * generation; only a start whose generation is STILL current may publish
   * into the shared state (registry, `state.starting`, the tools map). A
   * teardown (`stopAllMcpConnections`) or a newer config build bumps the
   * generation, so a superseded start's late settlement has no code path
   * that writes shared state — it stops the registry it built (no leaked
   * stdio children) and hands its awaiter the current lifecycle's outcome
   * instead of a registry born from a superseded config. */
  generation: number;
  /** Counts fences (teardowns + test resets). Adoption across a fence is
   * prohibited: a start superseded by a fence refuses its awaiters with the
   * typed supersession rather than riding a chain stamped in the NEW world —
   * otherwise a teardown's drain would transitively wait on a start that
   * began after the fence (shutdown latency), and the drained set's snapshot
   * promise would be a lie. */
  fenceEpoch: number;
  /** The epoch of the chain in the `starting` slot. */
  startingEpoch: number;
  /** Sealed by a FINAL teardown (`server/index.ts` shutdown): the lazy start
   * must never resurrect the runtime behind the shutdown sequence. A status
   * read, a manifest build or a tool call racing the exit would otherwise
   * spawn a fresh registry + stdio children AFTER the drain — an OS process
   * outliving the process meant to own it. Test resets clear the seal (the
   * next test world may start again). */
  shutDown: boolean;
};

const state: OwnerState = {
  starting: undefined,
  outstanding: new Set(),
  registry: undefined,
  tools: new Map(),
  fingerprint: undefined,
  generation: 0,
  fenceEpoch: 0,
  startingEpoch: 0,
  shutDown: false,
};

/**
 * A cheap, stable fingerprint of the MCP config the registry was built from:
 * the FULL server entries + the `tools.mcp` module-wide defaults. A config
 * edit that changes any of them rebuilds the registry; an edit to an
 * unrelated config section does not.
 *
 * The fingerprint covers the WHOLE entry, not a picked field list: an
 * args-only edit (a different fixture flag, a tuned transport argument) or
 * an env/header/auth edit that never touches id/transport/command/url used
 * to leave the memoised registry running the OLD entry — the operator's
 * change never took effect. Every entry field feeds `resolveMcpServerConfigs`
 * → the registry, so every entry field must move the fingerprint.
 *
 * The module-wide defaults MUST be in the fingerprint: an operator tunes
 * `tools.mcp.retryCount` through the settings UI (a config-bound
 * customization whose contract is `immediate`), the write gate persists it,
 * and the running registry only picks it up because the fingerprint moved.
 * Omitting them left a persisted override that never took effect until an
 * unrelated server edit forced a rebuild.
 *
 * The fingerprint is a DIGEST: the retained value is the canonical hash of
 * the serialized entries, not the serialization itself. An entry carrying a
 * literal credential (not a `${VAR}` placeholder) would otherwise duplicate
 * that credential into a second retained string for as long as the registry
 * lives — the config file and the redaction owner's registry are the only
 * places secret material may sit. The canonical encoding also makes object
 * key order immaterial: a reordered-but-identical `env` or `headers` map
 * hashes identically, so a meaningless rewrite never spuriously rebuilds.
 *
 * The hashed values are the RAW config (placeholders unresolved) — the
 * resolved secrets are derived from them deterministically at build time,
 * so raw is both sufficient and the only shape that avoids copying resolved
 * credentials into a second in-memory string.
 *
 * The fingerprint also carries the module-level timeout the build resolves
 * from the tool bounds: when `tools.mcp.timeoutMs` is unset the registry's
 * per-call default is the operator's `tools.defaultBounds.timeoutMs`
 * override — built-in tools read that value live per call, so an MCP-side
 * fingerprint that omitted it would let the override land on built-ins
 * immediately and on MCP calls only after an unrelated rebuild.
 */
function configFingerprint(): string {
  return canonicalHash({
    servers: getMcpServers(),
    defaults: getMcpDefaults(),
    defaultTimeoutMs: getToolBounds().timeoutMs,
  });
}

async function buildAndStartRegistry(generation: number): Promise<{
  registry: McpRegistry;
  publish: () => boolean;
}> {
  const defaults = mcpModuleDefaults();
  const resolved = resolveConfiguredMcpServers(getMcpServers(), defaults);

  // Discovery accumulates in a per-build buffer until THIS build's fence
  // passes and `publish` swaps it in wholesale: the shared tools map mirrors
  // exactly one PUBLISHED generation, never a partial in-flight discovery —
  // and a superseded build's registrations die with its buffer instead of
  // lingering in the map (its stop's unregisters are fenced, so nothing else
  // would ever remove them). After publication, this registry's own
  // lifecycle (crash-restart, disable/enable) mutates the shared map
  // directly through the same generation-fenced callbacks.
  let published = false;
  const buffered = new Map<string, DiscoveredTool>();
  const registry = createMcpRegistry({
    config: deepFreeze({
      servers: resolved,
      // The operator's `tools.mcp` overrides over the module's own defaults
      // (the config file is the override source, the module owns the
      // defaults), with the protocol version the harness speaks.
      defaults: deepFreeze({ ...defaults, protocolVersion: ROOT_POLICY.contracts.mcpProtocolVersion }),
      limits: deepFreeze({
        maxServers: ROOT_POLICY.tools.limits.maximumMcpServers,
        maxToolsPerServer: ROOT_POLICY.tools.limits.maximumEnabledTools,
      }),
    }),
    ...mcpClientFactoryOptions(defaults),
    clientFactory: mcpServerClient,
    registerTool: (_tool, registration) => {
      // The tools map mirrors the CURRENT generation's PUBLISHED discovery
      // only: a superseded build's registration must never reach the shared
      // map, and an in-flight build's partial discovery is buffered, not
      // published.
      if (state.generation !== generation) return;
      // The registry minted the name and hands back the pair it resolves to;
      // it never re-registers an unchanged tool (it unregisters first on
      // stop/restart), so an insert here is always the truth.
      const entry = deepFreeze({
        id: registration.name,
        serverId: registration.serverId,
        name: registration.tool.name,
        manifest: registration.manifest,
      });
      (published ? state.tools : buffered).set(registration.name, entry);
    },
    unregisterTool: (toolId) => {
      // A superseded registry's stop must not strip the CURRENT
      // generation's entries.
      if (state.generation !== generation) return;
      (published ? state.tools : buffered).delete(toolId);
    },
  });

  const outcome = await registry.start();
  for (const err of outcome.errors) {
    // A failed server is a first-class, visible fact — never a silent skip —
    // logged with its typed code (a refused confinement carries the owner's).
    webWarn("mcp-runtime", "MCP server failed to connect", () => ({ serverId: err.serverId, error: err.message, code: err.code }));
  }
  return {
    registry,
    /** Fence-checked wholesale swap of this build's discovery into the
     * shared tools map. Returns false when this build's generation is no
     * longer current — the buffer is discarded and nothing is published. */
    publish: (): boolean => {
      if (state.generation !== generation) return false;
      state.tools.clear();
      for (const [id, entry] of buffered) state.tools.set(id, entry);
      published = true;
      return true;
    },
  };
}

/**
 * The single door: every consumer (status route, manifest, executor) asks
 * for the started registry through here. Memoised on the config fingerprint
 * so a config edit tears down + rebuilds, and so the first caller pays the
 * connect cost once for every concurrent caller behind it.
 */
export async function ensureMcpRuntimeStarted(): Promise<McpRegistry> {
  // The final-shutdown fence: the runtime was deliberately, permanently torn
  // down for process exit. A lazy start here would resurrect stdio children
  // behind the shutdown sequence, so the refusal is typed and immediate.
  if (state.shutDown) {
    throw new McpError(
      "the MCP runtime was shut down for server exit and cannot restart",
      "mcp_runtime_shut_down",
      false,
    );
  }
  const fingerprint = configFingerprint();
  if (state.registry !== undefined && state.fingerprint === fingerprint) {
    return state.registry;
  }
  if (state.starting !== undefined && state.fingerprint === fingerprint) {
    return state.starting;
  }
  // Stamp BEFORE the first await: from this line the WHOLE transition —
  // stopping the previous registry AND building the replacement — is one
  // memoised, fenced promise in `state.starting`. A teardown
  // (`stopAllMcpConnections`) can never slip between the old stop and the
  // stamp: it always fences and drains this exact promise, so no registry
  // from a pre-teardown world can materialise after teardown has returned.
  const generation = ++state.generation;
  const epoch = state.fenceEpoch;
  state.fingerprint = fingerprint;
  const old = state.registry;
  state.registry = undefined;
  state.starting = undefined;
  state.tools.clear();
  const chain = (async (): ReturnType<typeof buildAndStartRegistry> => {
    // A config change invalidates the running registry: stop it before the
    // rebuild. The stop is best-effort (a dead client is already closed).
    if (old !== undefined) {
      await old.stopAll().catch((err: unknown) => {
        webWarn("mcp-runtime", "stopAll during config rebuild failed", () => mcpWarnErrorPayload(err));
      });
    }
    return buildAndStartRegistry(generation);
  })()
    .then((built): McpRegistry | Promise<McpRegistry> => {
      if (built.publish()) {
        state.registry = built.registry;
        state.starting = undefined;
        return built.registry;
      }
      // This build lost the fence: a newer config build or a teardown
      // superseded it while it was in flight. NEVER publish it — stop it so
      // its stdio children cannot leak, then hand the awaiter the CURRENT
      // lifecycle's registry (or an honest refusal after a teardown).
      return built.registry.stopAll()
        .catch((err: unknown) => {
          webWarn("mcp-runtime", "stopAll on a superseded registry failed", () => mcpWarnErrorPayload(err));
        })
        .then((): Promise<McpRegistry> => {
          // Adopt the CURRENT lifecycle when one exists IN THIS WORLD:
          // supersession by a newer config build hands this awaiter that
          // build's registry — the intended shape (the awaiter asked for the
          // runtime, and the current world has it). A start from AFTER a
          // fence is a different world: this awaiter asked for a runtime that
          // was deliberately torn down, so the answer is the typed refusal —
          // never a cross-fence ride (which would make a teardown's drain
          // transitively wait on the new world's build).
          if (state.starting !== undefined && state.startingEpoch === epoch) return state.starting;
          if (epoch === state.fenceEpoch && state.registry !== undefined) return Promise.resolve(state.registry);
          throw new McpError(
            "the MCP runtime start was superseded before it could publish",
            "mcp_start_superseded",
            false,
          );
        });
    })
    .catch((err: unknown) => {
      // Only the current generation may clear its own start slot: a stale
      // build's failure must not unset a newer build's memoised promise.
      if (state.generation === generation) state.starting = undefined;
      throw err;
    });
  state.starting = chain;
  state.startingEpoch = epoch;
  // Track the chain until it settles — teardown drains the SET, never just
  // the slot: a superseded chain carries its own stop, so draining it is the
  // only way its stdio children are guaranteed gone before teardown returns.
  // The removal handler observes both settlement shapes so it never produces
  // a rejection of its own.
  state.outstanding.add(chain);
  const forget = (): void => { state.outstanding.delete(chain); };
  void chain.then(forget, forget);
  return chain;
}

/**
 * Typed: an MCP runtime start was discarded because a newer config build or
 * a teardown superseded it before it could publish. Fire-and-forget
 * starters (status surface, manifest build) treat this as a non-event —
 * the current lifecycle already carries the answer they wanted.
 */
export function isMcpStartSupersededError(err: unknown): boolean {
  return err instanceof McpError && err.code === "mcp_start_superseded";
}

/**
 * Typed: the MCP runtime was sealed by the final shutdown. Asking for a
 * start behind the seal is the fence working, never a failure — the fire-
 * and-forget starters swallow it without logging (same treatment as
 * supersession).
 */
export function isMcpRuntimeShutDownError(err: unknown): boolean {
  return err instanceof McpError && err.code === "mcp_runtime_shut_down";
}

/**
 * The discovered MCP tools, in registration order. Empty until the runtime
 * is started; a server that failed to connect contributes nothing (deny-by-
 * default). Read by the manifest owner at manifest-build time.
 */
export function getDiscoveredMcpTools(): readonly DiscoveredTool[] {
  return [...state.tools.values()];
}

/**
 * Typed: the MCP tool did not run because it is missing, unconfigured,
 * disabled, superseded, or its runtime was sealed (server not connected /
 * not registered / tool disabled / start discarded by a newer lifecycle /
 * final shutdown). A superseded start is a transient-lifecycle refusal,
 * never a broken tool: the current lifecycle owns the runtime, so the
 * honest handling is the same as any other not-yet-callable state — the
 * event-feed investigation pauses-and-asks rather than treating the
 * refusal as an installed-tool silent switch. A connected server whose
 * tool simply failed is NOT unavailable.
 *
 * The taxonomy itself is owned by the engine
 * (`engine/src/mcp/unavailability.ts`); this is the boolean projection of
 * the same decode, so the classification can never drift from the reason
 * keys the pause text consumes.
 */
export function isMcpUnavailableError(err: unknown): boolean {
  return mcpUnavailableReason(err) !== null;
}

/**
 * Which configured server, and which of its tools, a harness name means — the
 * registry's ONE reverse lookup of the names it minted at registration, never
 * a parse or a re-mint. When no connected server registered the name, the
 * configured server whose head (`mcp__<id>__`, from the naming owner; heads
 * are prefix-free) starts it is named for the refusal only — an id the owner
 * cannot mint for (an older config's `_` or `.`) is skipped, never thrown on.
 */
function locateMcpTool(registry: McpRegistry, name: string): Readonly<{ serverId: string; toolName?: string }> | undefined {
  const resolved = registry.resolveToolName(name);
  if (resolved !== undefined) return resolved;
  const serverId = registry.getServerIds().find((id) => isMcpServerId(id) && name.startsWith(mcpToolNameHead(id)));
  return serverId === undefined ? undefined : { serverId };
}

/**
 * Dispatch a call to an MCP tool by its harness name. Returns the text
 * content of the MCP result; throws (typed McpError) when the tool's server
 * is not configured or not connected, the tool is disabled, the call fails,
 * or the tool ran and reported `isError`. The executor maps the throw into
 * its standard tool-error result, so a completed MCP error cannot be
 * recorded as success.
 */
export async function callMcpTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<string> {
  const registry = await ensureMcpRuntimeStarted();
  const target = locateMcpTool(registry, name);
  if (target === undefined) {
    throw new McpError(`MCP tool '${name}' is not provided by any configured MCP server`, "mcp_server_not_registered", false, {});
  }
  const { serverId, toolName } = target;
  if (toolName === undefined) {
    // The server is configured but offers no such tool right now — it has
    // not connected (or dropped), so its tools are unknown: a connectivity
    // refusal, never "go and configure it".
    throw new McpError(`MCP tool '${name}' is not available: its server '${serverId}' is not connected`, "mcp_not_connected", false, { serverId }, true);
  }
  let result: Awaited<ReturnType<typeof registry.callTool>>;
  try {
    result = await registry.callTool(serverId, toolName, args, signal);
  } catch (error) {
    // The client door masked the server's words already; the call's names are added.
    if (error instanceof McpError) throw new McpError(error.message, error.code, error.retryable, { serverId, toolName }, error.transportLevel);
    throw error;
  }
  const textParts = result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!);
  const text = textParts.length > 0
    ? textParts.join("\n")
    : JSON.stringify(result.structuredContent ?? result.content);
  if (result.isError) {
    throw new McpError(text, "mcp_call_tool_failed", false, { serverId, toolName });
  }
  return text;
}

/**
 * Live status for `/api/mcp/servers`: config metadata joined with the
 * registry's measured signals. A server the runtime has not attempted yet
 * (runtime not started) reports `status: "stopped"` honestly.
 */
export async function getLiveMcpServerSignals(): Promise<readonly McpServerLiveSignals[]> {
  // Asking for live status IS a use — it triggers the start. But the status
  // read must not PAY the start: the first consumer of a fresh server is the
  // settings surface's status paint, and blocking it on the full connect
  // (measured ~530ms with the configured servers) froze first paint. The
  // start is triggered in the background; the read answers with the signals
  // that exist at this instant — "stopped" before the first connect
  // completes, which is the honest snapshot — and the next read carries the
  // live state. Concurrent callers still share ONE start through the
  // memoised promise in `ensureMcpRuntimeStarted`.
  if (state.registry === undefined) {
    ensureMcpRuntimeStarted().catch((err: unknown) => {
      // A superseded start is the fence working (a newer build or a teardown
      // replaced it) — never a failure to report. A shut-down refusal is the
      // final seal working — the process is exiting, no runtime to report.
      if (isMcpStartSupersededError(err) || isMcpRuntimeShutDownError(err)) return;
      webWarn("mcp-runtime", "MCP runtime start for status read failed", () => mcpWarnErrorPayload(err));
    });
  }
  return (state.registry?.getAllServerSignals() ?? []).map((signals) => {
    const placed = signals.transport === "stdio" ? confinementByServer.get(signals.id) : { confinement: "remote" as const, confinementReason: null };
    return deepFreeze({ ...signals, confinement: placed?.confinement ?? null, confinementReason: placed?.confinementReason ?? null });
  });
}

/** Is a registry published right now? Read by the manifest owner (to decide
 * whether to kick a start) and by prevention tests asserting laziness. */
export function mcpRuntimeStarted(): boolean {
  return state.registry !== undefined;
}

/**
 * Close every MCP client. Called from `server/index.ts` `shutdown()` so a
 * stdio child never outlives the server. Idempotent; safe to call when the
 * runtime was never started.
 *
 * `final: true` is the process-exit form: it seals the lazy-start door
 * BEFORE the drain, so a consumer racing the shutdown (a status poll, a
 * manifest build) is refused with `mcp_runtime_shut_down` instead of
 * resurrecting the runtime behind the teardown. A plain drain (tests, an
 * in-process reset) leaves the door open — the next lifecycle is legal.
 */
export async function stopAllMcpConnections(options?: Readonly<{ final?: boolean }>): Promise<void> {
  if (options?.final === true) state.shutDown = true;
  // Fence FIRST: a start still in flight is now a stale generation — its
  // late settlement discards + stops its own registry instead of publishing
  // into the torn-down state. The fence also seals the epoch: a pre-fence
  // start refuses its awaiters with the typed supersession rather than
  // adopting this teardown's (or a future world's) lifecycle.
  state.generation += 1;
  state.fenceEpoch += 1;
  // Snapshot every chain in flight AT THE FENCE — not only the chain in the
  // `starting` slot. Generation stamps alone leave a superseded build's OWN
  // stop (it stops itself when it loses the fence, inside its chain)
  // unsettled when teardown returns: three overlapping generations (config
  // edit → config edit → teardown) would leak the middle build's stdio
  // children for a window. Chains stamped AFTER the fence belong to the
  // post-teardown world: they are never fenced and never awaited here — a
  // resurrected runtime owes the shutdown nothing.
  const drained = [...state.outstanding];
  const registry = state.registry;
  state.registry = undefined;
  state.starting = undefined;
  state.tools.clear();
  state.fingerprint = undefined;
  // Drain: teardown is not complete until every pre-fence start has SETTLED.
  // A settling chain's superseded arm stops the registry it built, so no
  // stdio child outlives the shutdown. Supersession is the fence, not a
  // failure; a real build failure was already delivered to the start's own
  // awaiters — teardown only drains.
  await Promise.all(drained.map((chain) => chain.catch((err: unknown) => {
    if (!isMcpStartSupersededError(err)) {
      webWarn("mcp-runtime", "drained an in-flight MCP start during teardown", () => mcpWarnErrorPayload(err));
    }
  })));
  if (registry !== undefined) {
    await registry.stopAll().catch((err: unknown) => {
      webWarn("mcp-runtime", "stopAll on shutdown failed", () => mcpWarnErrorPayload(err));
    });
  }
}

/** Test-only seam: reset the whole owner (vitest isolation contract).
 * Callers MUST `await stopAllMcpConnections()` first (every existing caller
 * does): reset fences off any in-flight start so its late settlement is
 * discarded, but the DRAIN (waiting for that settlement, closing its stdio
 * children) belongs to `stopAllMcpConnections`. The outstanding set is kept
 * — a stopAll that comes later can still drain what this reset fenced.
 * The final-shutdown seal is lifted: a fresh test world may start again. */
export function resetMcpRuntimeForTests(): void {
  state.generation += 1;
  state.fenceEpoch += 1;
  state.registry = undefined;
  state.starting = undefined;
  state.tools.clear();
  state.fingerprint = undefined;
  state.shutDown = false;
}
