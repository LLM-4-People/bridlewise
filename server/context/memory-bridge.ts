/**
 * Memory bridge — the SINGLE server-side owner of harness memory access
 * (SPO). ALL memory store/retrieve/inject goes through this
 * module — no route, service, or tool accesses the canonical memory store
 * directly. The bridge enforces the gates at the LOWEST level (the choke
 * point where every memory path converges):
 *
 * 1. userId gate — EVERY read/write requires a non-empty, server-resolved
 * userId. A missing/empty userId throws ForbiddenError (deny-by-
 * default). The user filter is EXCLUSIVE: only the caller's OWN
 * entries are returned (entries with `userId === null` are denied —
 * no legacy/shared leak).
 * 2. saveToMemory gate — automatic tool-result storage goes through
 * `storeToolResultMemory`, which checks BOTH the manifest owner's opt-
 * in list (`isSaveToMemoryTool` from tools-bridge.ts) AND the result's
 * success. A caller that bypasses this function and calls
 * `storeProvenance` directly skips the gate — the mechanical test
 * verifies the run route uses `storeToolResultMemory` for tool results.
 * 3. encryption gate — content is encrypted at the bridge (same persisted
 * key as web.db) before it reaches the canonical store; decrypted on
 * read. The store's timeline document holds ciphertext.
 * 4. PII gate — the bridge returns raw decrypted content to authorized
 * callers (the user's own memory panel); the LLM-facing path
 * (`fetch_memory` tool) redacts via the PII owner (redaction.ts).
 *
 * The canonical timeline store remains the durable backend (no parallel
 * system); the bridge encrypts on store and decrypts on read. The store's
 * built-in text search operates on ciphertext, so the bridge does
 * decrypt-then-search (load all, decrypt, filter) — feasible for the web
 * UI's memory volume.
 *
 * Session binding (v12→): the owning user's id is stored in entry
 * metadata and used to scope list/search/get so User B never sees User A's
 * memories. The userId is the SERVER-RESOLVED authenticated user (never a
 * client-supplied value) — the memory route resolves it from the session
 * cookie via requireUserContext, and the run route threads it from
 * `active.userId`. The `fetch_memory` tool receives it via the
 * `ToolExecutionContext` (fix — previously it called searchMemory
 * WITHOUT userId, leaking every user's memories to the LLM).
 */

import { createRequire } from "node:module";
import { getTimelineStore } from "../observability/timeline-bridge.ts";
import { createMemoryStore, isMemoryTier, memberOf, type MemoryStore, type MemoryTier } from "../kernel/canonical.ts";
import { getDatabaseKey } from "../db/bootstrap-key.ts";
import { createDbCryptoFromKey, memoryBinding, UNBOUND, type DbCrypto, type FieldBinding } from "../db/db-crypto.ts";
import { generateId, OWNER_SEAL_METADATA_KEY } from "../kernel/canonical.ts";
import { getMemorySearchDefaultLimit, getMemorySearchMaxLimit } from "../kernel/harness-config.ts";
import { getResolvedMemoryConfig } from "./context-bridge.ts";
import { ForbiddenError } from "../kernel/errors.ts";

// ── Lazy-load the tool manifest owner (tools-bridge.ts) ──────────────────
// SPO: the saveToMemory gate (only tools with `saveToMemory: true`
// in the manifest owner) is enforced HERE — at the memory owner — not in
// the run route. tools-bridge.ts owns the opt-in list; the memory owner
// queries it via `isSaveToMemoryTool`. Lazy-loaded (the createRequire
// pattern from tool-executor.ts) so the canonical exposure + debug chain
// (tools-bridge → canonical → built-in-tools → integrity → createHash
// during init) is only triggered at first use, after the server has booted
// and the chain is already cached. In the running server tools-bridge.ts
// is loaded at boot (run.ts + routes/tools.ts import it), so this is a
// cheap cache hit.
const moduleRequire = createRequire(import.meta.url);
type ToolsBridge = typeof import("../tools/tools-bridge.ts");
let _tools: ToolsBridge | undefined;
function tools(): ToolsBridge {
  if (_tools === undefined) _tools = moduleRequire("../tools/tools-bridge.ts") as ToolsBridge;
  return _tools;
}

// ── userId gate (SPO lowest-level enforcement + deny-by-default) ──────────
// EVERY memory read/write goes through this gate. The userId is the
// SERVER-RESOLVED authenticated user (never a client-supplied value). A
// missing/empty userId means the caller bypassed the auth gate — deny
// (throw ForbiddenError) rather than silently returning unscoped data.
// This is the choke point: a route/tool/agent that forgets to thread
// userId cannot leak another user's memories (the function throws).
function requireUserId(userId: string, fn: string): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ForbiddenError(
      `${fn}: memory access requires an authenticated user (userId missing/empty)`,
      "memory_user_required",
    );
  }
  return userId;
}

// ── Provenance types (the rich tagging the user requested) ──
//
// SPO: `MemorySource` + `MEMORY_SOURCES` + `MemoryEntryView` are now
// owned by `shared/wire-types.ts` (the single wire-shape owner, imported
// by both server + client). Re-exported here so existing
// `import { MEMORY_SOURCES, type MemoryEntryView } from "./memory-bridge.ts"`
// paths are unchanged. `MemoryProvenance` stays server-only (it carries the
// MANDATORY userId gate — a server-side concern, not a wire shape).

import type { MemorySource, MemoryEntryView, MemoryTier as WireMemoryTier } from "../../shared/wire-types.ts";
import { MEMORY_SOURCES } from "../../shared/wire-types.ts";
export type { MemorySource, MemoryEntryView };
export { MEMORY_SOURCES };

export type MemoryProvenance = Readonly<{
  /** Origin of the memory: a tool call, a conversation, the LLM, or the user. */
  readonly source: MemorySource;
  /** The tool that produced/saved it (when source === "tool"). */
  readonly toolName?: string;
  /** What triggered the storage (the original request/prompt/action). */
  readonly originalRequest?: string;
  /** Which conversation (chat id) it belongs to, if any. */
  readonly chatId?: string;
  /** Which run produced it, if any — the key a REWIND withdraws by (see
   * `MemoryEntryView.runId`). */
  readonly runId?: string;
  /** How it was saved: automatic (harness-derived) or manual (user-pinned). */
  readonly how?: "automatic" | "manual";
  /**
   * The owning user id — MANDATORY (SPO). The server-resolved
   * authenticated user; every memory entry is scoped to this user. The
   * `storeProvenance` gate enforces non-empty at runtime (defense-in-depth
   * against a caller that casts), and the type enforces presence at
   * compile time. A memory without an owning user is denied-by-default.
   */
  readonly userId: string;
}>;

// `MemoryEntryView` is owned by `shared/wire-types.ts` (imported above).
// `MemoryProvenance` above is server-only (it stays here).

// ── Crypto (same persisted key as web.db) ──
// Database, memory and timeline use the same admitted process capability.

let cryptoSingleton: DbCrypto | undefined;
function getMemoryCrypto(): DbCrypto {
  if (cryptoSingleton !== undefined) return cryptoSingleton;
  cryptoSingleton = createDbCryptoFromKey(getDatabaseKey());
  return cryptoSingleton;
}

// ── Store singleton ──

let store: MemoryStore | undefined;

function getMemoryStore(): MemoryStore {
  if (store !== undefined) return store;
  // The configured memory settings, not the built-in defaults. This store was
  // created with no config at all, so every value under `memory` in the config
  // document — how many short-term turns are kept, how many long-term facts,
  // how large an entry may be, which search engine answers — was validated on
  // write, shown in the settings surface, and then ignored by the only memory
  // store the server actually runs.
  store = createMemoryStore({ store: getTimelineStore(), config: getResolvedMemoryConfig() });
  return store;
}

/**
 * THE TIER VOCABULARY, AND WHY THIS FILE IS WHERE THE TWO SPELLINGS MEET.
 *
 * `TIER_SET` was `new Set<string>(["present", "short-term", "long-term"])` —
 * a THIRD hand-written copy of the tier list, sitting one line above a
 * `SOURCE_SET` that was already derived from its owner. Typed `Set<string>`,
 * it had no type relationship to `MemoryTier` at all, so a tier added
 * upstream would have been accepted by the store, accepted by the route's
 * zod enum (which derives from the harness owner), and then silently dropped
 * by this file's `?tier=` filter — the one place that still believed there
 * were three.
 *
 * It is now built from the CANONICAL owner, which is the same list the route
 * schemas derive from.
 *
 * AND THE WIRE MIRROR IS HELD TO IT AT COMPILE TIME. The client cannot import
 * the canonical harness (it would pull it into the browser bundle), so
 * `shared/wire-types.ts` carries a mirror. A mirror nothing checks is two
 * sources of truth wearing one name, so the two are asserted EQUAL here — the
 * one module that legitimately sees both. `toView` already assigns a canonical
 * tier into the wire field, which proves canonical ⊆ wire; the assertion below
 * adds the direction that assignment cannot see (a wire tier the store has
 * never heard of) and makes both a type error rather than a support ticket.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type MemoryTierWireParity = Assert<MutuallyAssignable<MemoryTier, WireMemoryTier>>;

// THE TIER FILTER IS THE HARNESS OWNER'S OWN PREDICATE, NOT A SET BUILT FROM
// IT. `const TIER_SET = new Set<string>(MEMORY_TIERS)` was derived from the
// owner and could still disagree with it: `new Set<string>` erases the element
// type, and a `Set` is mutable, so `TIER_SET.delete("long-term")` typechecks,
// leaves every tier suite green, and drops `?tier=long-term` here — the exact
// defect deriving from the owner was supposed to close. Driven. `isMemoryTier`
// keeps its members in a closure nothing can name, so there is no expression
// that makes this filter disagree with the store it filters.
const isMemorySource = memberOf(MEMORY_SOURCES);

// ── Provenance encoding (tags + metadata) ──
//
// The canonical store supports `tags` (string[]) and `metadata`
// (Record<string,string>). Provenance is split:
// - tags: [source, `tool:${toolName}`] — searchable + filterable by the store.
// - metadata: { originalRequest, chatId, how, userId } — plaintext, used
// for filtering + display. (metadata values are strings per the store API.)
//
// The content (what was saved) is ENCRYPTED before it reaches the store, so
// the timeline document holds ciphertext. The bridge decrypts on read.

function encodeProvenance(p: MemoryProvenance): {
  tags: readonly string[];
  metadata: Readonly<Record<string, string>>;
} {
  const tags: string[] = [p.source];
  if (p.toolName !== undefined) tags.push(`tool:${p.toolName}`);
  const metadata: Record<string, string> = {};
  if (p.originalRequest !== undefined) metadata["originalRequest"] = p.originalRequest;
  if (p.chatId !== undefined) metadata["chatId"] = p.chatId;
  if (p.runId !== undefined) metadata["runId"] = p.runId;
  metadata["how"] = p.how ?? "automatic";
  // SPO: userId is mandatory (the type enforces it); always set
  // it so the entry is scoped at encode time (no dead conditional).
  metadata["userId"] = p.userId;
  return { tags, metadata };
}

/**
 * What an entry's content is sealed under: its owner and seal id (every
 * entry written since binding), or unbound for an entry written before
 * (no seal id — the append-only ledger cannot re-seal it).
 */
function contentBinding(metadata: Readonly<Record<string, string>>): FieldBinding {
  const seal = metadata[OWNER_SEAL_METADATA_KEY];
  return seal === undefined ? UNBOUND : memoryBinding(metadata["userId"] ?? "", seal);
}

function decodeProvenance(entry: { tags: readonly string[]; metadata: Readonly<Record<string, string>>; agentId: string | null }): {
  source: MemorySource;
  toolName: string | null;
  originalRequest: string | null;
  chatId: string | null;
  runId: string | null;
  how: "automatic" | "manual";
  userId: string | null;
} {
  const sourceTag = entry.tags.find(isMemorySource);
  const source: MemorySource = sourceTag ?? "conversation";
  const toolTag = entry.tags.find((t) => t.startsWith("tool:"));
  const toolName = toolTag !== undefined ? toolTag.slice("tool:".length) : null;
  return {
    source,
    toolName,
    originalRequest: entry.metadata["originalRequest"] ?? null,
    chatId: entry.metadata["chatId"] ?? null,
    runId: entry.metadata["runId"] ?? null,
    how: entry.metadata["how"] === "manual" ? "manual" : "automatic",
    userId: entry.metadata["userId"] ?? null,
  };
}

function toView(entry: ReturnType<MemoryStore["all"]>[number]): MemoryEntryView {
  const prov = decodeProvenance(entry);
  // Decrypt the content (the store holds ciphertext) under its seal.
  const content = getMemoryCrypto().decryptField(entry.content, contentBinding(entry.metadata)) ?? entry.content;
  return Object.freeze({
    id: entry.id,
    content,
    tier: entry.tier,
    topic: entry.topic,
    tags: entry.tags,
    agentId: entry.agentId,
    timestamp: entry.timestamp,
    source: prov.source,
    toolName: prov.toolName,
    originalRequest: prov.originalRequest,
    chatId: prov.chatId,
    runId: prov.runId,
    how: prov.how,
    userId: prov.userId,
  });
}

// ── Public API ──

/**
 * Store a memory entry with full provenance. The content is encrypted at
 * rest (same persisted key as web.db). Returns the stored entry id.
 * SPO: `provenance.userId` is MANDATORY — the gate throws
 * ForbiddenError if missing/empty. No memory can be stored without an
 * owning user (deny-by-default: a caller that forgets to thread userId
 * cannot store a memory that would be visible to no one / everyone).
 */
export function storeProvenance(
  content: string,
  provenance: MemoryProvenance,
  tier: MemoryTier = "short-term",
  extraTags: readonly string[] = [],
): string {
  if (provenance.userId === undefined || provenance.userId.length === 0) {
    throw new ForbiddenError(
      "storeProvenance: memory store requires an authenticated user (provenance.userId missing/empty)",
      "memory_user_required",
    );
  }
  const encoded = encodeProvenance(provenance);
  const allTags = [...encoded.tags, ...extraTags];
  // Encrypt the content before it reaches the canonical store — the
  // timeline document holds ciphertext, protected by the persisted key and
  // BOUND to its owner and a seal minted with it (the seal id is metadata).
  const metadata = { ...encoded.metadata, [OWNER_SEAL_METADATA_KEY]: generateId("seal") };
  const encContent = getMemoryCrypto().encryptField(content, contentBinding(metadata)) ?? content;
  const s = getMemoryStore();
  const entry = tier === "long-term"
    ? s.addLongTerm(encContent, { tags: allTags, metadata })
    : tier === "present"
      ? s.addPresent(encContent, { tags: allTags, metadata })
      : s.addShortTerm(encContent, { tags: allTags, metadata });
  return entry.id;
}

/**
 * Search memory with decrypt-then-filter. The store's built-in text search
 * operates on ciphertext (won't match plaintext queries), so the bridge
 * loads all entries, decrypts, and filters by text + provenance + user.
 * SPO: userId is MANDATORY — the gate throws ForbiddenError if
 * missing/empty (deny-by-default). The user filter is EXCLUSIVE: only
 * entries whose userId EXACTLY matches the caller's userId are returned.
 * Entries with `userId === null` (legacy/pre-v12 or unscoped) are NEVER
 * returned — deny-by-default (: "access DENIED unless EXPLICITLY
 * granted"; a null userId is NOT the caller's, so it is denied). This
 * closes the cross-user leak where the LLM's `fetch_memory` tool (which
 * previously called searchMemory WITHOUT userId) could read every user's
 * memories.
 */
export function searchMemory(
  query: Readonly<Record<string, unknown>>,
  userId: string,
): readonly MemoryEntryView[] {
  const scopedUserId = requireUserId(userId, "searchMemory");
  const s = getMemoryStore();
  const all = s.all().map(toView);
  const text = typeof query.text === "string" && query.text.length > 0 ? query.text.toLowerCase() : null;
  const source = isMemorySource(query.source) ? query.source : null;
  const toolName = typeof query.toolName === "string" && query.toolName.length > 0 ? query.toolName : null;
  const chatId = typeof query.chatId === "string" && query.chatId.length > 0 ? query.chatId : null;
  const tierRaw = isMemoryTier(query.tier) ? query.tier : null;
  const tags = Array.isArray(query.tags) ? (query.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  const fromTime = typeof query.fromTime === "string" ? query.fromTime : null;
  const toTime = typeof query.toTime === "string" ? query.toTime : null;
  const limit = Math.min(typeof query.limit === "number" && Number.isInteger(query.limit) && query.limit > 0 ? query.limit : getMemorySearchDefaultLimit(), getMemorySearchMaxLimit());
  let results = all;
  if (text !== null) {
    results = results.filter((e) =>
      e.content.toLowerCase().includes(text) ||
      (e.topic ?? "").toLowerCase().includes(text) ||
      (e.originalRequest ?? "").toLowerCase().includes(text) ||
      (e.toolName ?? "").toLowerCase().includes(text),
    );
  }
  if (source !== null) results = results.filter((e) => e.source === source);
  if (toolName !== null) results = results.filter((e) => e.toolName === toolName);
  if (chatId !== null) results = results.filter((e) => e.chatId === chatId);
  if (tierRaw !== null) results = results.filter((e) => e.tier === tierRaw);
  if (tags.length > 0) results = results.filter((e) => tags.every((t) => e.tags.includes(t)));
  if (fromTime !== null) results = results.filter((e) => e.timestamp >= fromTime);
  if (toTime !== null) results = results.filter((e) => e.timestamp <= toTime);
  // SPO: EXCLUSIVE user scoping (deny-by-default). Only the
  // caller's OWN entries are returned. A null userId on an entry (legacy
  // or unscoped) is NOT the caller's → denied. User B never sees User A's
  // memories, and no one sees unscoped legacy entries.
  results = results.filter((e) => e.userId === scopedUserId);
  return results.slice(0, limit);
}

/**
 * Get a single memory entry by id, scoped to the caller's user. Returns
 * null if the entry does not exist OR belongs to another user (deny-by-
 * default — no cross-user read by id, no null/shared leak).
 */
export function getMemoryEntry(id: string, userId: string): MemoryEntryView | null {
  const scopedUserId = requireUserId(userId, "getMemoryEntry");
  const entry = getMemoryStore().get(id);
  if (entry === null) return null;
  const view = toView(entry);
  if (view.userId !== scopedUserId) {
    // Deny-by-default: an entry with a different userId (or null/legacy)
    // is NOT the caller's → denied (returns null, hiding existence).
    return null;
  }
  return view;
}

/**
 * WHICH RUN PRODUCED EACH OF THESE MEMORIES — one read for the whole set.
 *
 * The context desk asks this of every memory it is about to send, to drop
 * the ones belonging to a withdrawn run (`server/blocks/compose.ts`). It
 * used to ask through `getMemoryEntry` once per item, and that is two
 * separate costs, not one: a lookup per id, and — the expensive half — a
 * full AES decryption of each entry's CONTENT to build a view, when the
 * only field wanted is `runId`, which lives in unencrypted provenance
 * metadata. The desk is on the reply's hot path, so it paid the decryption
 * of every recalled memory on every composition read.
 *
 * Returns a map from id to the owning run (null when the memory records no
 * run). An id that does not exist, or belongs to another user, is simply
 * ABSENT — the same deny-by-default silence `getMemoryEntry` keeps, so a
 * caller cannot learn from the answer's shape that someone else's memory
 * exists.
 */
export function memoryRunIds(
  ids: readonly string[],
  userId: string,
): ReadonlyMap<string, string | null> {
  const scopedUserId = requireUserId(userId, "memoryRunIds");
  const runIds = new Map<string, string | null>();
  if (ids.length === 0) return runIds;
  const store = getMemoryStore();
  for (const id of new Set(ids)) {
    const entry = store.get(id);
    if (entry === null) continue;
    const prov = decodeProvenance(entry);
    if (prov.userId !== scopedUserId) continue;
    runIds.set(id, prov.runId);
  }
  return runIds;
}

/**
 * List memory entries, optionally filtered by tier + user. Decrypted on
 * read. SPO: userId is MANDATORY; the filter is EXCLUSIVE (only
 * the caller's own entries; null/legacy entries are denied).
 */
export function listMemoryEntries(tier: string | undefined, userId: string): readonly MemoryEntryView[] {
  const scopedUserId = requireUserId(userId, "listMemoryEntries");
  const s = getMemoryStore();
  let entries: ReturnType<MemoryStore["all"]>[number][];
  if (tier === "present") entries = [...s.present()];
  else if (tier === "short-term") entries = [...s.shortTerm()];
  else if (tier === "long-term") entries = [...s.longTerm()];
  else entries = [...s.all()];
  // Deny-by-default: only the caller's own entries.
  return entries.map(toView).filter((e) => e.userId === scopedUserId);
}

export function memoryCount(userId: string): number {
  requireUserId(userId, "memoryCount");
  return listMemoryEntries(undefined, userId).length;
}

/**
 * Store a chat interaction as a short-term memory entry.
 * Tagged with the runId + chatId so it can be filtered later. The content is
 * encrypted at rest. SPO: `options.userId` is MANDATORY. Returns
 * the stored entry id.
 */
export function storeInteraction(
  content: string,
  options: Readonly<{ runId?: string; chatId?: string; topic?: string; tags?: readonly string[]; userId: string }>,
): string {
  return storeProvenance(
    content,
    {
      source: "conversation",
      ...(options.topic !== undefined ? { originalRequest: options.topic } : {}),
      ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
      // THE RUN IS RECORDED, and it is what a rewind withdraws by. It was
      // accepted as an option and then dropped on the floor, so an interaction
      // memory could be traced to its conversation but never to the TURN — and
      // a rewound turn's answer kept being recalled into later prompts because
      // nothing could tell it apart from its replacement.
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      how: "automatic",
      userId: options.userId,
    },
    "short-term",
    options.tags ?? [],
  );
}

/**
 * Store a tool RESULT as a memory entry — the SINGLE entry point for
 * automatic tool-result memory storage (SPO). Enforces BOTH
 * gates at the memory owner (the choke point), NOT in the run route:
 * 1. saveToMemory gate: only tools with `saveToMemory: true` in the
 * manifest owner (tools-bridge.ts `isSaveToMemoryTool`) are stored.
 * A tool that did not opt in is silently skipped (returns null).
 * 2. success gate: only SUCCESSFUL tool results are stored. A failed
 * result is silently skipped (returns null) — the user saw error
 * results polluting memory (exp519).
 * 3. userId gate: `provenance.userId` is MANDATORY (throws
 * ForbiddenError if missing — deny-by-default).
 *
 * Before this round, both gates lived in the run route (`if
 * (saveToMemoryTools.has(toolName) && toolResult.success)`). A caller
 * that bypassed the route (a future agent, an MCP, a direct bridge call)
 * and called `storeProvenance` with `source: "tool"` would skip the gate.
 * Now the gate is at the memory owner: the route calls this function, and
 * a bypass is impossible (the gate is enforced here, not at each call site).
 *
 * Returns the stored entry id, or null if the tool did not opt in OR the
 * result failed (the gate denied the store). The caller MUST treat null
 * as "not stored" (not an error — the gate legitimately skips).
 */
export function storeToolResultMemory(
  toolName: string,
  success: boolean,
  content: string,
  provenance: Readonly<{ originalRequest?: string; chatId?: string; userId: string }>,
  tier: MemoryTier = "short-term",
): string | null {
  // Gate 2: success gate — failed results are never saved.
  if (!success) return null;
  // Gate 1: saveToMemory gate — only opt-in tools (manifest owner).
  if (!tools().isSaveToMemoryTool(toolName)) return null;
  // Gate 3: userId gate — enforced by storeProvenance (throws if missing).
  return storeProvenance(
    content,
    {
      source: "tool",
      toolName,
      ...(provenance.originalRequest !== undefined ? { originalRequest: provenance.originalRequest } : {}),
      ...(provenance.chatId !== undefined ? { chatId: provenance.chatId } : {}),
      how: "automatic",
      userId: provenance.userId,
    },
    tier,
  );
}

/**
 * Retrieve relevant memories for a prompt. Decrypt-then-search: the store's content is ciphertext, so the
 * bridge loads all entries, decrypts, and lexical-matches against the prompt.
 * SPO: userId is MANDATORY — scoped to the caller's user so User
 * B's run never recalls User A's memories. Returns the matching entries'
 * decrypted content, ranked by a simple token overlap score. The caller
 * injects these into the system prompt (via the context manager owner —
 * context-bridge.ts `injectMemoriesIntoPrompt`, which redacts PII before
 * the LLM sees them).
 */
export function retrieveRelevantMemories(
  prompt: string,
  limit: number,
  userId: string,
): readonly { id: string; content: string; tier: string; timestamp: string; score: number }[] {
  requireUserId(userId, "retrieveRelevantMemories");
  if (prompt.length === 0) return [];
  const views = listMemoryEntries(undefined, userId);
  const promptTokens = new Set(prompt.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const scored = views
    .map((e) => {
      const contentTokens = new Set(e.content.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
      let overlap = 0;
      for (const t of promptTokens) if (contentTokens.has(t)) overlap += 1;
      return { id: e.id, content: e.content, tier: e.tier, timestamp: e.timestamp, score: overlap };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}
