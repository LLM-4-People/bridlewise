/**
 * MCP bridge — the settings room's door to the configured MCP servers.
 *
 * Uses the centralized `harness-config.ts` reader (the ONE owner of
 * `bridlewise.config.json` access) so MCP servers and built-in tools read the
 * same bytes. This fixes a prior bug: the bridge read the non-existent
 * top-level `mcp.servers` path, so every configured MCP server (which lives
 * at `tools.mcpServers`) was silently invisible.
 *
 * READ side: the server list is the config's `tools.mcpServers` joined with
 * the LIVE connection state owned by `mcp-runtime-bridge.ts` (the single
 * process-scoped MCP runtime host). Credential-bearing values — environment
 * VALUES, header VALUES, the auth token — are STRUCTURALLY ABSENT from the
 * served view: a name stands in for each saved credential, exactly like the
 * provider list's `hasApiKey`, so a read can never echo a secret back.
 *
 * WRITE side (add / edit / remove): the ONE config write gate. Every mutation
 * reads the current document, changes only the `tools.mcpServers` list, and
 * persists through `writeConfigRaw` — the same single write entry point the
 * settings customizations' store uses (`server/index.ts` installs
 * `writeDocument: writeConfigRaw`). There is no second write path: the
 * config file stays the single source of truth and the whole candidate
 * document is re-validated by the config document schema before a byte
 * reaches the disk.
 *
 * Deny-by-default, in order:
 *   1. the wire body is a `z.strictObject` — an undeclared field refuses at
 *      the route with the field named;
 *   2. the merged registration is validated against the config document's OWN
 *      per-server schema (`getMcpServerConfigSchema()` — the same instance the
 *      write gate splices into `tools.mcpServers`, so the wire contract
 *      cannot drift from the persisted one);
 *   3. the ENGINE's runtime validator (`validateMcpServerEntry` +
 *      `validateMcpModuleConfig`) is the authority — the door cannot write a
 *      registration the engine would reject at connect time (duplicate ids
 *      and the server-count bound live here, where the engine keeps them);
 *   4. `writeConfigRaw` re-validates the whole document (the final gate).
 *
 * The live registry picks a config edit up HOT: `ensureMcpRuntimeStarted`
 * fingerprints the whole server list (mcp-runtime-bridge.ts `configFingerprint`)
 * and rebuilds on the next use — no restart needed.
 */

import { z } from "zod";
import { getMcpServers, readSettingsDocument, modifyConfigRaw } from "../kernel/harness-config.ts";
import {
  normalizeMcpModuleConfig,
  validateMcpServerEntry,
  validateMcpModuleConfig,
  getMcpServerConfigSchema,
  MCP_AUTH_TOKEN_MAX,
  MCP_SERVER_ID_MAX_CHARACTERS,
  MCP_SERVER_ID_PATTERN,
  ROOT_POLICY,
  type McpServerEntry,
} from "../kernel/canonical.ts";
import {
  ensureMcpRuntimeStarted,
  isMcpStartSupersededError,
  isMcpRuntimeShutDownError,
  mcpWarnErrorPayload,
  getLiveMcpServerSignals,
  mcpClientFactoryOptions,
  mcpServerClient,
  resolveConfiguredMcpServers,
} from "./mcp-runtime-bridge.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { NotFoundError, ValidationError } from "../kernel/errors.ts";
import { extractErrorMessage, InputError } from "../../engine/src/kernel/errors.ts";
import { McpError } from "../../engine/src/mcp/errors.ts";
import { sameOrderedValues } from "../../engine/src/kernel/ordered.ts";
import { concealArguments, concealUrl, keepScalar, restoreArguments, restoreUrl, type KeptValue, type Restored } from "../../engine/src/privacy/secret-parts.ts";
import { invalidateToolManifestCache } from "../tools/tools-bridge.ts";
import { mcpServerPlacementRefusal, removeMcpServerHomeDir } from "../safety/landlock-runner.ts";
import { MCP_TRANSPORT_IDS, type McpServerView, type McpServerTestResult } from "../../shared/wire-types.ts";

/**
 * The fully-defaulted MCP module config, asked of the harness resolver rather
 * than read from its default constant. The default is module-private to its
 * owner on purpose: a default is an input to resolution, and a reader of the
 * default stops tracking configuration the moment any is supplied.
 */
const DEFAULTED_MCP_CONFIG = normalizeMcpModuleConfig({});

// The per-field bounds are the SAME policy facts the config document schema
// derives its own constraints from — one owner (ROOT_POLICY), restated here
// only because a zod schema cannot be cloned-with-a-tweak. The route suite
// round-trips a registration the engine accepts and refuses ones it refuses,
// so a bound that drifted from the config schema fails a test on one side or
// the other.
const MCP_ID_MAX = ROOT_POLICY.tools.limits.maximumMcpServerIdCharacters;
const MCP_TEXT_MAX = ROOT_POLICY.runtime.limits.maximumBaseUrlCharacters;
const MCP_LIST_MAX = ROOT_POLICY.tools.limits.maximumEnabledTools;
const MCP_TIMEOUT_MAX = ROOT_POLICY.tools.limits.maximumToolTimeoutMs;

/**
 * The wire body for add and edit — ONE shape, because add and edit are the
 * same write (upsert by id). Credential-bearing fields carry the
 * write-only-with-blank-keeps contract: an env/header name present with an
 * empty value keeps the saved value for that name; an absent `auth` keeps the
 * saved auth; `auth: null` REMOVES it; an auth object with an empty `token`
 * keeps the saved token. Everything else replaces what the body states, and a
 * field the body leaves out falls to the module's own default (the
 * omit-on-default honesty the config file itself is written with).
 */
export const MCP_SERVER_WRITE_SCHEMA = z.strictObject({
  id: z.string().min(1).max(MCP_SERVER_ID_MAX_CHARACTERS).regex(MCP_SERVER_ID_PATTERN),
  transport: z.enum(MCP_TRANSPORT_IDS),
  enabled: z.boolean().optional(),
  command: z.string().min(1).max(MCP_TEXT_MAX).optional(),
  args: z.array(z.string().min(1).max(MCP_TEXT_MAX)).max(MCP_LIST_MAX).optional(),
  readPaths: z.array(z.string().min(1).max(MCP_TEXT_MAX)).max(MCP_LIST_MAX).optional(),
  env: z.record(z.string().min(1).max(MCP_ID_MAX), z.string()).optional(),
  url: z.string().min(1).max(MCP_TEXT_MAX).optional(),
  headers: z.record(z.string().min(1).max(MCP_ID_MAX), z.string()).optional(),
  subprotocol: z.string().min(1).max(MCP_ID_MAX).optional(),
  retry: z.strictObject({
    count: z.number().int().positive().max(20),
    backoffMs: z.number().finite().nonnegative().max(60_000),
  }).nullable().optional(),
  auth: z.union([
    z.strictObject({
      type: z.literal("api-key"),
      token: z.string().max(MCP_AUTH_TOKEN_MAX),
      header: z.string().min(1).max(MCP_ID_MAX).optional(),
      envName: z.string().min(1).max(MCP_ID_MAX).optional(),
    }),
    z.strictObject({
      type: z.literal("bearer"),
      token: z.string().max(MCP_AUTH_TOKEN_MAX),
      envName: z.string().min(1).max(MCP_ID_MAX).optional(),
    }),
    z.strictObject({
      type: z.literal("oauth"),
      token: z.string().max(MCP_AUTH_TOKEN_MAX),
    }),
  ]).nullable().optional(),
  timeoutMs: z.number().int().positive().max(MCP_TIMEOUT_MAX).nullable().optional(),
});

/**
 * The write body's shape as the zod schema infers it. The zod schema OWNS
 * the gate; the WIRE type the client posts against lives in
 * `shared/wire-types.ts` (`McpServerWrite`), and the frontend-contracts
 * drift guard asserts the two declare the same fields — this local name is
 * deliberately not the consolidated one.
 */
type McpServerWriteBody = z.infer<typeof MCP_SERVER_WRITE_SCHEMA>;

/** Refuse with the field named — the shape every schema refusal below uses. */
function refuseField(where: string, message: string): never {
  throw new ValidationError(`${where}: ${message}`, "invalid_mcp_server");
}

/** The config list as a mutable array of raw entries, extracted from a
 *  document the caller already holds — pure, so the locked cycles read
 *  the doc the lock gave them rather than re-reading the file. */
function serverListOf(doc: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const tools = doc["tools"];
  const rawList = tools !== null && typeof tools === "object" && !Array.isArray(tools)
    ? (tools as Record<string, unknown>)["mcpServers"]
    : undefined;
  return Array.isArray(rawList) ? [...rawList] : [];
}

/** The saved list as read-only entries, from the RESOLVED SNAPSHOT (the read paths' base; never the file). */
function readServerList(): { doc: Readonly<Record<string, unknown>>; list: Record<string, unknown>[] } {
  const doc = readSettingsDocument();
  return { doc, list: serverListOf(doc) };
}

/** Compose the doc with the mutated list — pure, so the locked cycle below
 *  can build its candidate without writing anything until the gate accepts
 *  it. */
function withServerListDoc(doc: Record<string, unknown>, list: readonly Record<string, unknown>[]): Record<string, unknown> {
  const tools = doc["tools"];
  const toolsObj = tools !== null && typeof tools === "object" && !Array.isArray(tools)
    ? { ...(tools as Record<string, unknown>) }
    : {};
  toolsObj["mcpServers"] = [...list];
  doc["tools"] = toolsObj;
  return doc;
}

/** What every accepted server-list write owes AFTER the locked cycle
 *  releases: the manifest cache invalidation (the manifest caches
 *  config-derived values), then make the write HOT: the runtime owner's
 *  fingerprint covers the whole server list, and a published registry is
 *  only rebuilt by a consumer that walks `ensureMcpRuntimeStarted` — the
 *  status read and the manifest build deliberately do not while a registry
 *  stands (first-paint cost), so without this kick a just-added server
 *  would sit inert until some unrelated MCP tool call happened to force the
 *  rebuild. The kick is fire-and-forget: the write has already landed, the
 *  rebuild connects the new registration in the background, and the next
 *  status read or manifest build answers with the live state. */
function kickAfterServerListWrite(): void {
  invalidateToolManifestCache();
  ensureMcpRuntimeStarted().catch((err: unknown) => {
    // A superseded start or a shut-down seal is the lifecycle working (a
    // newer build or the final teardown owns the runtime) — never a failed
    // write: the config change is already on disk.
    if (isMcpStartSupersededError(err) || isMcpRuntimeShutDownError(err)) return;
    webWarn("mcp-bridge", "MCP runtime rebuild after a settings write failed", () => mcpWarnErrorPayload(err));
  });
}

/**
 * Merge a write body into the saved entry's credential-bearing maps through
 * the ONE write-only primitive (`engine/src/privacy/secret-parts.ts`): the
 * body carries the FULL name set (a name absent is removed), and a name
 * present with an empty value keeps the saved value for that name — while
 * what receives it is unchanged (the context rule of the primitive: the same
 * transport, the same command, every argument and read path, or the same
 * whole URL — origin, path and query; SECD-C4, sec-e H-2). A NEW
 * name with an empty value refuses: an empty credential is not storable.
 */
function mergeCredentialMap(
  label: string,
  saved: Readonly<Record<string, string>> | undefined,
  body: Readonly<Record<string, string>> | undefined,
  contextUnchanged: boolean,
): Record<string, string> | undefined {
  if (body === undefined) {
    if (saved !== undefined && Object.keys(saved).length > 0 && !contextUnchanged) {
      refuseField(label, "was saved for the server's previous address, command or arguments — send every credential again for the new one");
    }
    return saved === undefined ? undefined : { ...saved };
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) out[name] = keptOrRefused(`${label} "${name}"`, keepScalar(value, saved?.[name], contextUnchanged));
  return out;
}

/** A kept scalar, or the field's refusal in the writer's words. */
function keptOrRefused(label: string, kept: KeptValue): string {
  if (kept.ok) return kept.value;
  return refuseField(label, kept.reason === "context-changed"
    ? "was saved for the server's previous address, command or arguments — type it again for the new one (a saved credential never follows a server somewhere else)"
    : "needs a value — an empty field only keeps an already-saved one");
}

/** A restored composite value (with its context verdict), or the field's refusal in the writer's words. */
function restoredOrRefused<T>(label: string, restored: Restored<T>): Readonly<{ value: T; contextUnchanged: boolean }> {
  if (restored.ok) return restored;
  return refuseField(label, restored.reason === "context-changed"
    ? "keeps a hidden part saved for the server's previous address, command or arguments — type it again for the new one (any edit of the value is a new one)"
    : restored.reason === "moved-mark"
      ? "carries a hidden part somewhere other than where it was saved — a hidden part is kept only in its own place; type the value again"
      : "carries a hidden part that stands for nothing saved — type the value again");
}

/**
 * Build the final registration from the body and the saved entry. The final
 * shape carries ONLY the fields the engine uses for the chosen transport, so a
 * transport switch cannot leave a stale field behind (a stdio entry cannot
 * keep a url it no longer uses). `protocolVersion` is filled from the root
 * policy: the config schema pins it to the contract literal, so it is not a
 * user choice and the form never asks.
 */
function mergeServerEntry(saved: Record<string, unknown> | undefined, body: McpServerWriteBody): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    id: body.id,
    transport: body.transport,
    protocolVersion: ROOT_POLICY.contracts.mcpProtocolVersion,
  };
  if (body.enabled !== undefined) merged["enabled"] = body.enabled;
  const savedTransport = typeof saved?.["transport"] === "string" ? saved["transport"] : undefined;
  // THE CONTEXT a saved credential was given for: the same transport, and
  // the same command, every argument and the same read paths (stdio) or the
  // same whole URL — origin, path and query — (remote); the primitive decides
  // the composite value's part. Anything else must be given every credential
  // again (a saved secret never follows a server to other code or another
  // tenant).
  let contextUnchanged: boolean;
  if (body.transport === "stdio") {
    const savedCommand = typeof saved?.["command"] === "string" ? saved["command"] : undefined;
    const command = body.command ?? savedCommand;
    if (command !== undefined) merged["command"] = command;
    const readPaths = body.readPaths ?? [];
    const sameReadPaths = sameOrderedValues([...readPaths].sort(), [...stringList(saved?.["readPaths"])].sort());
    const savedArgs = stringList(saved?.["args"]);
    // The list serves arguments with their secret parts as keep marks; a mark
    // sent back keeps that part, in its own place, in an unchanged context.
    const args = restoredOrRefused(`the arguments of "${body.id}"`,
      restoreArguments(body.args ?? concealArguments(savedArgs), savedArgs, savedTransport === "stdio" && command === savedCommand && sameReadPaths));
    contextUnchanged = args.contextUnchanged;
    merged["args"] = [...args.value];
    if (readPaths.length > 0) merged["readPaths"] = [...readPaths];
    const env = mergeCredentialMap(`the environment for "${body.id}"`, saved?.["env"] as Record<string, string> | undefined, body.env, contextUnchanged);
    if (env !== undefined) merged["env"] = env;
  } else {
    const savedUrl = typeof saved?.["url"] === "string" ? saved["url"] : undefined;
    const sent = body.url ?? (savedUrl === undefined ? undefined : concealUrl(savedUrl));
    const url = sent === undefined ? undefined : restoredOrRefused(`the URL of "${body.id}"`, restoreUrl(sent, savedUrl, savedTransport === body.transport));
    contextUnchanged = url?.contextUnchanged ?? false;
    if (url !== undefined) merged["url"] = url.value;
    if (body.subprotocol !== undefined) merged["subprotocol"] = body.subprotocol;
    const headers = mergeCredentialMap(`the headers for "${body.id}"`, saved?.["headers"] as Record<string, string> | undefined, body.headers, contextUnchanged);
    if (headers !== undefined) merged["headers"] = headers;
  }
  if (body.retry !== undefined && body.retry !== null) merged["retry"] = { ...body.retry };
  if (body.timeoutMs !== undefined && body.timeoutMs !== null) merged["timeoutMs"] = body.timeoutMs;
  if (body.auth !== undefined && body.auth !== null) {
    const authBody = body.auth;
    const savedAuth = saved?.["auth"] as { token?: unknown } | undefined;
    const token = keptOrRefused("the authentication token", keepScalar(authBody.token, typeof savedAuth?.["token"] === "string" ? savedAuth["token"] : undefined, contextUnchanged));
    merged["auth"] = { type: authBody.type, token, ...("header" in authBody && authBody.header !== undefined ? { header: authBody.header } : {}), ...("envName" in authBody && authBody.envName !== undefined ? { envName: authBody.envName } : {}) };
  }
  return merged;
}

/**
 * THE CONFIG DOCUMENT AS AN ADMIN READS IT (`GET /api/config`): every MCP
 * server's URL and arguments with their secret parts as keep marks — the
 * same primitive the server list serves (headers, env and tokens are masked
 * by key name upstream). Credentials are write-only for everyone, admins
 * included: an admin re-types a secret, never reads it back.
 */
export function concealMcpServersIn(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const tools = document["tools"];
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return { ...document };
  const servers = (tools as Record<string, unknown>)["mcpServers"];
  if (!Array.isArray(servers)) return { ...document };
  return {
    ...document,
    tools: {
      ...(tools as Record<string, unknown>),
      mcpServers: servers.map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const server = { ...(entry as Record<string, unknown>) };
        if (typeof server["url"] === "string") server["url"] = concealUrl(server["url"]);
        if (Array.isArray(server["args"])) server["args"] = concealArguments(stringList(server["args"]));
        return server;
      }),
    },
  };
}

/** Validate a candidate registration against the config document's OWN
 * per-server schema, refusing with the field named (the same instance the
 * whole-document write gate splices into `tools.mcpServers`). */
function assertConfigShape(entry: Record<string, unknown>): void {
  const result = getMcpServerConfigSchema().safeParse(entry);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "the registration";
    refuseField(where, issue?.message ?? "failed the config schema");
  }
}

/** Read one saved entry by id (the write/test paths' lookup). */
function savedEntryById(id: string): Record<string, unknown> | undefined {
  const { list } = readServerList();
  return list.find((e) => e !== null && typeof e === "object" && (e as Record<string, unknown>)["id"] === id);
}

/** The served view of one raw entry, joined with its live signal. */
function toServerView(raw: Record<string, unknown>, live: { status?: string; toolCount?: number; callCount?: number; errorCount?: number; lastError?: string | null; lastErrorCode?: string | null; confinement?: McpServerView["confinement"]; confinementReason?: string | null } | undefined): McpServerView {
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  const rawTransport = raw["transport"];
  const transport = MCP_TRANSPORT_IDS.includes(rawTransport as never)
    ? (rawTransport as McpServerView["transport"])
    : (rawTransport as string);
  const strOr = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const names = (v: unknown): readonly string[] =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>) : [];
  const rawRetry = raw["retry"];
  const retry = rawRetry !== null && typeof rawRetry === "object" && !Array.isArray(rawRetry)
    ? {
        count: Number((rawRetry as Record<string, unknown>)["count"] ?? 0),
        backoffMs: Number((rawRetry as Record<string, unknown>)["backoffMs"] ?? 0),
      }
    : null;
  const rawAuth = raw["auth"];
  const auth = rawAuth !== null && typeof rawAuth === "object" && !Array.isArray(rawAuth)
    ? {
        type: (rawAuth as Record<string, unknown>)["type"] as "api-key" | "bearer" | "oauth",
        header: strOr((rawAuth as Record<string, unknown>)["header"]),
        envName: strOr((rawAuth as Record<string, unknown>)["envName"]),
        // The token's presence is the fact; its value never crosses.
        hasToken: true,
      }
    : null;
  let enabled = true;
  try {
    // validateMcpServerEntry checks the canonical shape (transport must
    // be a known type, etc.). A config entry that fails validation is
    // reported as disabled (honest, not a silent pass).
    validateMcpServerEntry(raw as unknown as McpServerEntry);
    enabled = raw["enabled"] !== false;
  } catch (err) {
    // EHC-19: a malformed MCP server config is a real config issue —
    // surface it via the centralized debug bridge instead of silently
    // disabling the server with no signal. The server is still listed
    // (with its fields as they read) so it can be edited or removed.
    webWarn("mcp-bridge", "MCP server entry validation failed (marking disabled)", () => ({ id, error: err instanceof Error ? err.message : String(err) }));
    enabled = false;
  }
  // Credentials in a URL or an argument never cross: the list serves their
  // concealed form (a writer that gets it back keeps the saved value).
  const args = concealArguments(stringList(raw["args"]));
  const url = strOr(raw["url"]);
  return {
    id,
    // Normally one of the closed vocabulary; a hand-edited file that bypassed
    // the write gate can hold anything, and the list serves what is actually
    // there rather than inventing a transport.
    transport,
    enabled,
    command: strOr(raw["command"]),
    args,
    readPaths: stringList(raw["readPaths"]),
    url: url === null ? null : concealUrl(url),
    subprotocol: strOr(raw["subprotocol"]),
    envNames: names(raw["env"]),
    headerNames: names(raw["headers"]),
    auth,
    retry,
    timeoutMs: typeof raw["timeoutMs"] === "number" ? raw["timeoutMs"] : null,
    protocolVersion: strOr(raw["protocolVersion"]) ?? ROOT_POLICY.contracts.mcpProtocolVersion,
    status: (live?.status as McpServerView["status"]) ?? "stopped",
    toolCount: live?.toolCount ?? 0,
    callCount: live?.callCount ?? 0,
    errorCount: live?.errorCount ?? 0,
    lastError: live?.lastError ?? null,
    lastErrorCode: live?.lastErrorCode ?? null,
    confinement: live?.confinement ?? null,
    confinementReason: live?.confinementReason ?? null,
  };
}

export async function listMcpServers(): Promise<readonly McpServerView[]> {
  const servers = getMcpServers();
  if (servers.length === 0) return [];
  // Join config metadata with the live registry signals. The runtime is
  // started lazily; asking for status IS a use, so it triggers the start in
  // the background — the read answers with the signals that exist now and
  // the next read carries the live state (the settings surface's first
  // paint must not pay the connect cost).
  const signals = new Map((await getLiveMcpServerSignals()).map((s) => [s.id, s] as const));
  return servers.map((s) => toServerView(s as unknown as Record<string, unknown>, signals.get(s.id)));
}

/** The strings of a config list value (anything else in it is not a path or an argument). */
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Add or edit one server registration (upsert by id — the same write, like the
 * provider merge-by-name). Refuses — naming the field — everything the config
 * schema, the engine validator, or the whole-list authority rejects. The
 * config list picks the change up hot: the runtime fingerprint moves and the
 * next use rebuilds the registry.
 */
export function upsertMcpServer(body: McpServerWriteBody): McpServerView {
  let merged: Record<string, unknown> | undefined;
  // The read, the merge and the gated write are ONE locked cycle: a
  // parallel writer's config change cannot land between this verb's read
  // and its write and be silently composed away.
  modifyConfigRaw((doc) => {
    const list = serverListOf(doc);
    const index = list.findIndex((e) => e !== null && typeof e === "object" && (e as Record<string, unknown>)["id"] === body.id);
    const saved = index >= 0 ? (list[index] as Record<string, unknown>) : undefined;
    merged = mergeServerEntry(saved, body);
    // The authorities, in order: the config document's own per-server shape,
    // then the engine's whole-list law (unique ids + the server-count bound)
    // via its runtime validator — a duplicate id or an over-bound list refuses
    // here, before a byte reaches the disk. The engine's refusals are its own
    // error class (no HTTP status); this bridge is the boundary adapter, so
    // they cross as the server's 400-class client refusal with the engine's
    // own sentence — never a raw 500 for a designed refusal.
    assertConfigShape(merged);
    // A local server's placement is refused NOW when its spawn would be: the
    // confinement floor's one refused-paths policy and W^X, asked through
    // the same compile the spawn performs.
    if (merged["transport"] === "stdio") {
      const refusal = mcpServerPlacementRefusal({
        id: body.id,
        command: typeof merged["command"] === "string" ? merged["command"] : "",
        readPaths: stringList(merged["readPaths"]),
      });
      if (refusal !== undefined) throw new ValidationError(refusal.message, refusal.code);
    }
    const candidateList = [...list];
    if (index >= 0) candidateList[index] = merged;
    else candidateList.push(merged);
    try {
      validateMcpModuleConfig(normalizeMcpModuleConfig({ servers: candidateList as unknown as McpServerEntry[] }));
    } catch (err) {
      if (err instanceof InputError || err instanceof McpError) {
        throw new ValidationError(extractErrorMessage(err), "invalid_mcp_server");
      }
      throw err;
    }
    return withServerListDoc(doc, candidateList);
  });
  kickAfterServerListWrite();
  return toServerView(merged as Record<string, unknown>, undefined);
}

/**
 * Remove one server registration. Removing something that was never there is
 * REPORTED (the provider-delete precedent), not silently accepted.
 */
export function removeMcpServer(id: string): void {
  // Same locked cycle as the upsert: read, filter, write inside one hold.
  // Removing something that was never there refuses INSIDE the cycle, so
  // the refusal happens before a byte reaches the disk — the reported 404
  // never writes the file it reports about.
  modifyConfigRaw((doc) => {
    const list = serverListOf(doc);
    const next = list.filter((e) => !(e !== null && typeof e === "object" && (e as Record<string, unknown>)["id"] === id));
    if (next.length === list.length) {
      throw new NotFoundError(`No MCP server named "${id}" is configured`, "mcp_server_unknown");
    }
    return withServerListDoc(doc, next);
  });
  // The server's harness-owned home goes with its registration.
  removeMcpServerHomeDir(id);
  kickAfterServerListWrite();
}

/**
 * Ask one saved server whether it actually answers — ONE real connect +
 * tools/list against the saved registration (the provider test precedent's
 * MCP equivalent). Resolves the entry exactly the way a live connect does
 * (`resolveMcpServerConfigs` + `resolveServerSecrets`), so the probe proves
 * the registration a run would use. A failed connect with a named reason is
 * a valid observation: what the test proves is that the registration was
 * tried, never that the server is up. The probe uses its own throwaway client
 * — built through the runtime's one client door (`mcpServerClient`: the same
 * credential resolution, the same home, the same confinement) — and does not
 * touch the running registry.
 */
export async function testMcpServer(id: string): Promise<McpServerTestResult & { serverId: string }> {
  const saved = savedEntryById(id);
  if (saved === undefined) {
    throw new NotFoundError(`No MCP server named "${id}" is configured`, "mcp_server_unknown");
  }
  const resolved = resolveConfiguredMcpServers([saved as unknown as McpServerEntry])[0];
  if (resolved === undefined) {
    throw new NotFoundError(`No MCP server named "${id}" is configured`, "mcp_server_unknown");
  }
  const start = Date.now();
  let client: ReturnType<typeof mcpServerClient> | undefined;
  try {
    // The runtime's own options: the probe connects exactly as the runtime does.
    client = mcpServerClient(resolved, mcpClientFactoryOptions());
    await client.connect();
    const tools = await client.listTools();
    return {
      serverId: id,
      ok: true,
      toolNames: tools.map((t) => t.name),
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    return {
      serverId: id,
      ok: false,
      // The connect + tools/list phases ARE "asking the server to answer":
      // every failure they raise — a typed MCP refusal, a fetch that never
      // reached the address, a command that never spawned — is the same
      // honest class from the seat of the person testing. Only a rejection
      // that is not even an error object escapes the classification.
      failureKind: err instanceof Error ? "no-answer" : "unexpected",
      detail: extractErrorMessage(err),
      elapsedMs: Date.now() - start,
    };
  } finally {
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
}

export function getMcpConfigInfo(): Readonly<{
  serverCount: number;
  enabledCount: number;
  defaults: Readonly<{ retry: Readonly<{ count: number; backoffMs: number }>; timeoutMs: number; protocolVersion: string }>;
  limits: Readonly<{ maxServers: number; maxToolsPerServer: number }>;
}> {
  const servers = getMcpServers();
  const enabled = servers.filter((s) => s.enabled !== false);
  return {
    serverCount: servers.length,
    enabledCount: enabled.length,
    defaults: DEFAULTED_MCP_CONFIG.defaults,
    limits: DEFAULTED_MCP_CONFIG.limits,
  };
}
