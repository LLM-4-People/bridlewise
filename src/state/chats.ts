/**
 * nanostores shared state: chats list + current selection.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts (the sole
 * writer). Components read via $store auto-subscription.
 *
 * Boundary rule: the chats LIST is backend-originating and is fed by
 * client.ts (setChats, addChat, clearChatsForProject). The currentChatId
 * selection is UI-originated shared state: components may call
 * selectChat directly. client.ts also calls selectChat after createChat.
 *
 * The ChatSummary type is the client-side authority for the chat view.
 * The server boundary maps DB rows to this shape via
 * `server/routes/views.ts`.
 */

import { atom } from "nanostores";

import {
  restoreTabStringAtom,
  bindAtomTabPersistence,
  restoreJsonList,
  restoreJsonLists,
  persistJsonList,
  persistRemovePrefixed,
} from "./persistence";
import { registerReset } from "./store-registry";

// ── Types (client-side authority for the chat view) ──

export type ChatSummary = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly modelId: string | null;
  readonly pinned: boolean;
}>;

// `ChatCreateInput` is the WIRE-INPUT contract owned by
// `shared/input-schemas.ts` (the single zod schema + derived type).
// Re-exported here so existing `import { type ChatCreateInput } from
// "./chats"` call sites keep working; the shape is derived from the zod
// schema (a server change auto-propagates to the client type — no
// manual mirror to drift).
export type { ChatCreateInput } from "../../shared/input-schemas.ts";

// ── Indexed storage and targeted changes ───────────────────────────────
// Like the Flow log, the population is plain storage. A completion replaces
// ONE immutable project array and signals its identity. No subscriber has to
// materialize the entire collection to learn which project changed.
const CACHE_PREFIX = "chats:project:";
// Project identity is already in the key. A tuple avoids repeating it and
// six property names for every cached chat, keeping large real populations
// within the browser's storage budget without a second storage backend.
type CachedChat = readonly [string, string, string, string, string | null, boolean];
const EMPTY_CHATS: readonly ChatSummary[] = Object.freeze([]);
const byProject = new Map<string, readonly ChatSummary[]>();
const byId = new Map<string, ChatSummary>();
function restoreChats(): boolean {
  const legacy = restoreJsonList<ChatSummary>("chats:lastKnown");
  const restored = restoreJsonLists<CachedChat>(CACHE_PREFIX);
  let restoredCount = 0;
  const legacyGroups = new Map<string, ChatSummary[]>();
  for (const chat of legacy ?? []) {
    const bucket = legacyGroups.get(chat.projectId);
    if (bucket === undefined) legacyGroups.set(chat.projectId, [chat]);
    else bucket.push(chat);
  }
  for (const [id, list] of legacyGroups) byProject.set(id, list);
  // An empty scoped answer deliberately overrides a populated legacy bucket.
  for (const [projectId, list] of restored) {
    const decoded: ChatSummary[] = [];
    let valid = true;
    for (const row of list) {
      if (!Array.isArray(row) || row.length !== 6 || typeof row[0] !== "string" || typeof row[1] !== "string"
        || typeof row[2] !== "string" || typeof row[3] !== "string"
        || (row[4] !== null && typeof row[4] !== "string") || typeof row[5] !== "boolean") {
        valid = false;
        break;
      }
      const [id, title, createdAt, updatedAt, modelId, pinned] = row;
      decoded.push({ id, projectId, title, createdAt, updatedAt, modelId, pinned });
    }
    if (valid) { byProject.set(projectId, decoded); restoredCount++; }
  }
  for (const list of byProject.values()) for (const chat of list) byId.set(chat.id, chat);
  return legacy !== null || restoredCount > 0;
}
const fromCache = restoreChats();

/** null means a population reset/replacement; otherwise only these projects
 * changed. Listeners consume each synchronous notification, not a deferred
 * "last changed id" that would lose intervening completions. */
export const chatChanges = atom<Readonly<{ projectIds: readonly string[] | null }>>({ projectIds: null });
export const chatsFromCache = atom(fromCache);
export const currentChatId = atom<string | null>(null);
export const chatCount = atom(byId.size);

/** Explicit whole-list view for the developer harness. Ordinary runtime
 * consumers use chatForId/projectChatsFor. A one-time read does not subscribe
 * to changes (Nano computed.get temporarily mounts its dependencies). */
let snapshot: readonly ChatSummary[] | null = null;
export function chatsSnapshot(): readonly ChatSummary[] {
  return snapshot ??= Array.from(byId.values());
}

export function chatForId(id: string): ChatSummary | null {
  return byId.get(id) ?? null;
}

export function projectChatsFor(projectId: string): readonly ChatSummary[] {
  return byProject.get(projectId) ?? EMPTY_CHATS;
}

// Per-tab selection retains the established shared seed and reset owners.
restoreTabStringAtom(currentChatId, "currentChatId");
bindAtomTabPersistence(currentChatId, "currentChatId");
export const currentChat = atom<ChatSummary | null>(chatForId(currentChatId.get() ?? ""));
currentChatId.listen(id => currentChat.set(id === null ? null : chatForId(id)));

let generation = 0;
/** Captured by client.listChats at its actual write gate. */
export function chatsGeneration(): number { return generation; }

function publishChatChanges(projectIds: readonly string[] | null): void {
  snapshot = null;
  chatCount.set(byId.size);
  const selected = currentChatId.get();
  currentChat.set(selected === null ? null : chatForId(selected));
  chatChanges.set({ projectIds });
}

/** The single project write door: update indexes and persist exactly this
 * immutable bucket. Global population writes call it without notifications. */
function commitChats(
  projectId: string,
  snapshot: readonly ChatSummary[],
  indexMode: "retain" | "move" | "populated" = "retain",
): void {
  // Every caller supplies an owner-created array. External list ingestion
  // copies ONCE at the public boundary; map/filter/add already create theirs.
  if (indexMode !== "populated") {
    const previous = projectChatsFor(projectId);
    if (indexMode === "move") {
      for (const chat of previous) byId.delete(chat.id);
    } else {
      const retained = new Set<string>();
      for (const chat of snapshot) retained.add(chat.id);
      for (const chat of previous) if (!retained.has(chat.id)) byId.delete(chat.id);
    }
    for (const chat of snapshot) byId.set(chat.id, chat);
  }
  byProject.set(projectId, snapshot);
  persistJsonList<CachedChat>(CACHE_PREFIX + projectId,
    () => snapshot.map<CachedChat>(chat => [chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.modelId, chat.pinned]));
}

// ── Ingestion (called only by client.ts) ────────────────────────────────
export function setChats(list: readonly ChatSummary[]): void {
  byProject.clear();
  byId.clear();
  persistRemovePrefixed(CACHE_PREFIX);
  // Retain the legacy slot only as an empty migration base. It must not
  // resurrect a project that a later scoped empty answer removed.
  persistJsonList("chats:lastKnown", []);
  const grouped = new Map<string, ChatSummary[]>();
  for (const chat of list) {
    byId.set(chat.id, chat);
    const bucket = grouped.get(chat.projectId);
    if (bucket === undefined) grouped.set(chat.projectId, [chat]);
    else bucket.push(chat);
  }
  for (const [id, bucket] of grouped) commitChats(id, bucket, "populated");
  chatsFromCache.set(false);
  publishChatChanges(null);
}

export function addChat(chat: ChatSummary): void {
  commitChats(chat.projectId, [...projectChatsFor(chat.projectId), chat]);
  publishChatChanges([chat.projectId]);
}

export function updateChatInStore(id: string, updates: Partial<ChatSummary>): void {
  const before = chatForId(id);
  if (before === null) return;
  const next = { ...before, ...updates };
  if (next.projectId !== before.projectId) {
    commitChats(before.projectId, projectChatsFor(before.projectId).filter(chat => chat.id !== id));
    commitChats(next.projectId, [...projectChatsFor(next.projectId), next]);
    publishChatChanges([before.projectId, next.projectId]);
  } else {
    commitChats(before.projectId, projectChatsFor(before.projectId).map(chat => chat.id === id ? next : chat));
    publishChatChanges([before.projectId]);
  }
}

export function removeChat(id: string): void {
  const before = chatForId(id);
  if (before !== null) {
    commitChats(before.projectId, projectChatsFor(before.projectId).filter(chat => chat.id !== id));
    publishChatChanges([before.projectId]);
  }
  if (currentChatId.get() === id) currentChatId.set(null);
}

export function replaceChatsForProject(projectId: string, list: readonly ChatSummary[]): void {
  commitChats(projectId, list.slice(), "move");
  chatsFromCache.set(false);
  publishChatChanges([projectId]);
}

export function removeChatsForProject(projectId: string): void {
  const selected = currentChatId.get();
  const removeSelection = selected !== null && chatForId(selected)?.projectId === projectId;
  commitChats(projectId, EMPTY_CHATS);
  if (removeSelection) currentChatId.set(null);
  publishChatChanges([projectId]);
}

export function selectChat(id: string | null): void { currentChatId.set(id); }

export function resetChats(): void {
  generation += 1;
  byProject.clear();
  byId.clear();
  chatsFromCache.set(false);
  persistRemovePrefixed(CACHE_PREFIX);
  persistJsonList("chats:lastKnown", []);
  currentChatId.set(null);
  publishChatChanges(null);
}

registerReset("chats", resetChats);
