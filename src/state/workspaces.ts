/**
 * WORKSPACES — what the cockpit is working on, of which a page may hold
 * several.
 *
 * THE UNIT, AND WHY IT IS NOT "A BROWSER TAB". The first fix for two browser
 * tabs fighting over one conversation was to make the conversation per browser
 * tab. That is right but too small: a person wants several projects open at
 * once WITHIN one page, the way a terminal holds several tabs. So the unit is
 * a WORKSPACE — one project, one conversation, and the view state that belongs
 * to that pair — and a browser tab holds an ordered list of them with one
 * active. Browser-tab independence then falls out for free: two browser tabs
 * are two lists, and nothing about the split changes.
 *
 * THE SPLIT, STATED ONCE. Every persisted value answers one of two questions:
 *
 *   "What am I working on?"  → PER WORKSPACE. The project, the conversation,
 *      the open room, scroll positions, what this view has already shown you.
 *      Two workspaces disagreeing about these is the entire point of having
 *      two, so they must never converge and must never share a slot.
 *
 *   "How do I like the cockpit?" → SHARED, everywhere. Theme, density, pins,
 *      marks, armed triggers, the learned room order. These describe the
 *      operator, so a second workspace or a second browser tab showing a stale
 *      one is simply wrong. `cross-tab.ts` converges them.
 *
 * WHERE THE LIST LIVES. `sessionStorage`, which is per browser tab by
 * definition, survives a RELOAD of that tab, and is discarded when it closes —
 * the same lifetime as "the tabs I have open here". A brand-new browser tab
 * has none, so it opens ONE workspace seeded from the shared localStorage
 * value, which is both the existing single-tab behaviour and the entire
 * migration path: someone with a kept conversation today gets it as their
 * first workspace and sees no change. Nothing is copied, cleared or rewritten
 * on upgrade, and a browser that refuses sessionStorage degrades to exactly
 * today's behaviour rather than to no workspace at all.
 *
 * WHAT THIS MODULE DOES NOT DO. It holds no view state of its own beyond the
 * pair. Per-workspace room/scroll/seen state is claimed through
 * `workspaceScopedKey` by the module that owns it, so this file does not
 * become a second owner of everything. And it renders nothing: the tab strip
 * is a separate surface built against this API.
 *
 * @see src/state/cross-tab.ts — the other half: what deliberately DOES converge
 * @see src/state/persistence.ts — `persistTabGet`/`persistTabSet`, the storage door
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import {
  persistTabGet,
  persistTabOnlyGet,
  persistTabOnlyRemovePrefixed,
  persistTabOnlySet,
} from "./persistence";
import { registerReset } from "./store-registry";
import { currentProjectId, selectProject } from "./projects";
import { currentChatId, selectChat } from "./chats";
import { clientWarn } from "../client-debug";

const WORKSPACES_KEY = "workspaces";
const ACTIVE_KEY = "workspaces:active";

/**
 * One workspace: a project, a conversation, and the identity that per-view
 * state hangs off.
 *
 * `projectId`/`chatId` are nullable because a workspace legitimately exists
 * before either is chosen (a fresh `+` with the Switch open). A null is an
 * honest "nothing chosen here yet", never a placeholder for something we
 * failed to load.
 */
export type Workspace = Readonly<{
  id: string;
  projectId: string | null;
  chatId: string | null;
  /** Epoch-ms this workspace was opened. A real instant, used for ordering. */
  openedAtMs: number;
}>;

export const workspaces = atom<readonly Workspace[]>([]);
export const activeWorkspaceId = atom<string | null>(null);

export const activeWorkspace: ReadableAtom<Workspace | null> = computed(
  [workspaces, activeWorkspaceId],
  (list, id) => list.find((w) => w.id === id) ?? null,
);

export const workspaceCount: ReadableAtom<number> = computed(workspaces, (l) => l.length);

/**
 * The logical key PREFIX every value scoped to ONE workspace hangs under —
 * the single owner of the shape, and the only file that spells it. Stored
 * names are BUILT from it (`workspaceScopedKey` for the active workspace,
 * `workspaceScopedKeyFor` for a named one), read back by the same spelling
 * (`workspaceIdOfScopedKey`), and swept by it (the close/sign-out/boot
 * paths), so a per-view owner added tomorrow is written and cleaned up
 * through the owner's doors, never a second spelling. The workspace split
 * suite's source-shape arm enforces that claim mechanically: any `ws:` in
 * a string or template outside this file reds, so "single owner" is a
 * tested fact, not an aspiration.
 */
function workspaceScopePrefix(id: string): string {
  return `ws:${id}:`;
}

/**
 * The workspace id a scoped logical key names, or null when the key is not
 * workspace-scoped — the read half of the shape `workspaceScopePrefix`
 * writes, so the boot sweep judges ids by the same spelling the keys were
 * stored under.
 */
function workspaceIdOfScopedKey(logicalKey: string): string | null {
  if (!logicalKey.startsWith("ws:")) return null;
  const id = logicalKey.slice("ws:".length).split(":")[0];
  return id !== undefined && id.length > 0 ? id : null;
}

/**
 * The key a per-workspace value is stored under.
 *
 * Any module holding state that belongs to ONE workspace (which room is open,
 * where a list is scrolled, what this view has already shown) stores it under
 * this key instead of a bare one. That is what stops a second workspace
 * inheriting the first's view — the same bug as two browser tabs sharing a
 * conversation, one level down.
 *
 * Returns `null` when there is no active workspace: the caller then stores
 * nothing rather than storing under a guessed id.
 */
export function workspaceScopedKey(key: string): string | null {
  const id = activeWorkspaceId.get();
  return id === null ? null : `${workspaceScopePrefix(id)}${key}`;
}

/**
 * The key a per-workspace value is stored under, for a NAMED workspace.
 *
 * `workspaceScopedKey` can only name the ACTIVE workspace's slot, and the
 * one legitimate moment it cannot serve is real: a binder that records the
 * OUTGOING workspace's view on a switch runs exactly when the active id has
 * already moved, so the honest record has to name a workspace the atom no
 * longer points at. Consumers therefore hand the id + the LOGICAL key here
 * and never see the prefix — the shape stays this module's alone.
 */
export function workspaceScopedKeyFor(workspaceId: string, key: string): string {
  return `${workspaceScopePrefix(workspaceId)}${key}`;
}

let seq = 0;

function newId(): string {
  seq += 1;
  return `ws-${Date.now().toString(36)}-${seq}`;
}

// ── Selection sync ────────────────────────────────────────────────────────
//
// `currentProjectId`/`currentChatId` remain the atoms every existing consumer
// reads — fifty call sites do not need to learn about workspaces to keep
// working. They are now a PROJECTION of the active workspace, kept in step in
// both directions:
//
//   activate a workspace   → the atoms take that workspace's pair
//   the user selects       → the active workspace records the new pair
//
// `syncing` breaks the loop between the two. Without it, activating a
// workspace would write the atoms, whose listeners would write back into the
// workspace, and a mid-flight activation could record the OUTGOING pair onto
// the INCOMING workspace — silently swapping two workspaces' conversations,
// which is a worse version of the bug being fixed.

let syncing = false;

function withSync(fn: () => void): void {
  if (syncing) return;
  syncing = true;
  try {
    fn();
  } finally {
    syncing = false;
  }
}

function replace(id: string, patch: Partial<Workspace>): void {
  workspaces.set(workspaces.get().map((w) => (w.id === id ? Object.freeze({ ...w, ...patch }) : w)));
}

/**
 * Open a new workspace and make it active — the `+`.
 *
 * The new workspace does NOT inherit the active one's conversation. A `+` that
 * opened a copy of what you were already looking at would give two tabs
 * claiming the same work, which is the divergence this whole design removes.
 * It opens empty and the Switch chooses.
 */
export function openWorkspace(
  init: Readonly<{ projectId?: string | null; chatId?: string | null }> = {},
): Workspace {
  const ws: Workspace = Object.freeze({
    id: newId(),
    projectId: init.projectId ?? null,
    chatId: init.chatId ?? null,
    openedAtMs: Date.now(),
  });
  workspaces.set([...workspaces.get(), ws]);
  activateWorkspace(ws.id);
  return ws;
}

/**
 * Make a workspace active. The projection follows; the workspace list does
 * not change order (a tab strip that reordered itself on every click would
 * move the tab you are aiming at).
 *
 * Unknown ids are refused rather than clearing the active workspace: a stale
 * id from a restored list must not blank the screen.
 */
export function activateWorkspace(id: string): boolean {
  const ws = workspaces.get().find((w) => w.id === id);
  if (ws === undefined) {
    clientWarn("workspaces", "refused activate of unknown workspace:", id);
    return false;
  }
  activeWorkspaceId.set(id);
  withSync(() => {
    selectProject(ws.projectId);
    selectChat(ws.chatId);
  });
  return true;
}

/**
 * Move a workspace to a new position in the list — the tab strip's drag.
 *
 * The ORDER lives in this atom and nowhere else, so a reorder is a set of
 * the same list re-arranged: the write-through listener below persists it
 * exactly like an open or a close, and every reader (the strip, the fit,
 * the close-neighbour rule) sees one truth. The ACTIVE workspace is
 * untouched — dragging a tab moves it, never switches to it.
 *
 * Unknown ids and out-of-range positions are refused rather than clamped:
 * a drag hands in indices it derived from this same list one frame ago, so
 * anything else is a caller bug better surfaced than absorbed.
 */
export function moveWorkspace(id: string, toIndex: number): boolean {
  const list = workspaces.get();
  const from = list.findIndex((w) => w.id === id);
  if (from === -1) {
    clientWarn("workspaces", "refused move of unknown workspace:", id);
    return false;
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= list.length) {
    clientWarn("workspaces", "refused move to out-of-range position:", toIndex);
    return false;
  }
  if (toIndex === from) return true;
  const next = list.filter((w) => w.id !== id);
  next.splice(toIndex, 0, list[from]!);
  workspaces.set(next);
  return true;
}

/**
 * Close a workspace. Closing the ACTIVE one activates its neighbour — the one
 * to its left, or the first remaining — which is what a terminal does and what
 * keeps the screen showing something real instead of blanking.
 *
 * Closing the LAST workspace is refused. A cockpit with no workspace has
 * nothing to render and no way back except a `+` that would itself have to be
 * hosted somewhere; refusing is simpler and cannot strand anyone.
 */
export function closeWorkspace(id: string): boolean {
  const list = workspaces.get();
  if (list.length <= 1) return false;
  const index = list.findIndex((w) => w.id === id);
  if (index === -1) return false;
  const next = list.filter((w) => w.id !== id);
  workspaces.set(next);
  if (activeWorkspaceId.get() === id) {
    const neighbour = next[Math.max(0, index - 1)] ?? next[0]!;
    activateWorkspace(neighbour.id);
  }
  // THE CLOSE IS TERMINAL FOR THE WORKSPACE'S SCOPED KEYS. The id is gone
  // from the list and is never minted again, so nothing will ever read its
  // mirrors — leaving them in the tab's session storage would be the store
  // claiming per-view state exists for a workspace the strip no longer
  // names. The sweep runs LAST, after the activation above: handing the
  // screen to the neighbour makes the view binders record the OUTGOING
  // workspace's last view, and sweeping before that would just be re-dirtied
  // a tick later. By PREFIX, not by a list of key names, so every per-view
  // owner is cleaned up, including ones added after this line was written.
  persistTabOnlyRemovePrefixed(workspaceScopePrefix(id));
  return true;
}

/**
 * Restore the workspace list for THIS browser tab.
 *
 * Runs at module load so the list exists before the boot probes read the kept
 * selection. Order of preference: this tab's own list (a reload), else one
 * workspace seeded from the shared last-chosen pair (a new browser tab, or a
 * first run after this change), else one empty workspace.
 *
 * A malformed stored list degrades to the seed rather than to a crash or to a
 * partially-adopted list — half a restored set of tabs would be worse than a
 * clean one, because it would look complete.
 */
export function restoreWorkspaces(): void {
  const parsed = parseWorkspaces(persistTabOnlyGet(WORKSPACES_KEY));
  if (parsed !== null && parsed.length > 0) {
    workspaces.set(parsed);
    const keptActive = persistTabOnlyGet(ACTIVE_KEY);
    const active = parsed.find((w) => w.id === keptActive) ?? parsed[0]!;
    activateWorkspace(active.id);
    // DEAD-ID RESIDUE: a ws-scoped key whose id is not in the restored list
    // can never be named again — the list is the only thing that names ids.
    // These are the orphans earlier closes left behind (before the close
    // path swept), and they would otherwise ride this tab's session store
    // forever, claiming per-view state for workspaces no strip will show.
    // Swept by the same terminal-for-the-id rule, at the one moment the
    // full set of live ids is known.
    const liveIds = new Set(parsed.map((w) => w.id));
    persistTabOnlyRemovePrefixed("ws:", (logicalKey) => {
      const id = workspaceIdOfScopedKey(logicalKey);
      return id !== null && liveIds.has(id);
    });
    return;
  }
  // The stored list is unusable or absent, so the ids it named can never be
  // named again — every workspace-scoped mirror this tab still holds is a
  // dead key claiming per-view state for a workspace that will not restore.
  // Sweep them rather than carry them; a tab with no list (brand-new) holds
  // none, so this costs nothing there. A VALID list returns above and keeps
  // every listed workspace's keys — the reload-restore contract.
  persistTabOnlyRemovePrefixed("ws:");
  // Seed: the shared last-chosen pair. `persistTabGet` falls back to the
  // localStorage value a pre-workspace install left behind, which is what
  // makes the upgrade invisible.
  const ws: Workspace = Object.freeze({
    id: newId(),
    projectId: persistTabGet("currentProjectId"),
    chatId: persistTabGet("currentChatId"),
    openedAtMs: Date.now(),
  });
  workspaces.set([ws]);
  activateWorkspace(ws.id);
}

function isWorkspace(v: unknown): v is Workspace {
  if (v === null || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    w.id.length > 0 &&
    (w.projectId === null || typeof w.projectId === "string") &&
    (w.chatId === null || typeof w.chatId === "string") &&
    typeof w.openedAtMs === "number" &&
    Number.isFinite(w.openedAtMs)
  );
}

/** Parse a stored list, or `null` when it is not usable. Exported for tests. */
export function parseWorkspaces(raw: string | null): readonly Workspace[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every(isWorkspace)) return null;
  return Object.freeze(parsed.map((w) => Object.freeze({ ...w })));
}

// ── Write-through (per browser tab) ───────────────────────────────────────

// Private mode or quota make these fail. The in-memory list stays the truth
// for this page's life; only reload-restoration is lost, and the storage owner
// reports the refusal rather than swallowing it.
workspaces.listen((list) => persistTabOnlySet(WORKSPACES_KEY, JSON.stringify(list)));
activeWorkspaceId.listen((id) => persistTabOnlySet(ACTIVE_KEY, id));

// The other direction: a selection made anywhere lands on the active
// workspace. Registered once, at module load, so no caller has to remember.
currentProjectId.listen((projectId) => {
  const id = activeWorkspaceId.get();
  if (id === null) return;
  withSync(() => replace(id, { projectId }));
});

currentChatId.listen((chatId) => {
  const id = activeWorkspaceId.get();
  if (id === null) return;
  withSync(() => replace(id, { chatId }));
});

/**
 * A workspace's name, for a tab that has to say what it is.
 *
 * Zero-knowledge: no ids, ever — a tab reading `ws-mf3k-2` teaches nothing.
 * Absence is stated in plain words rather than left blank, because a blank tab
 * is indistinguishable from a broken one. The caller supplies the lookups so
 * this module does not become a second owner of project and chat names.
 */
export function workspaceLabel(
  ws: Workspace,
  projectName: (id: string) => string | null,
  chatTitle: (id: string) => string | null,
): string {
  const project = ws.projectId === null ? null : projectName(ws.projectId);
  const chat = ws.chatId === null ? null : chatTitle(ws.chatId);
  if (project === null) return "nothing open yet";
  return `${project} ▸ ${chat ?? "no conversation open"}`;
}

/** Reset to a single empty workspace (sign-out). */
export function resetWorkspaces(): void {
  // Sign-out closes every open workspace at once, and each close is as
  // terminal as the strip's own: the old ids can never be named again. The
  // sweep runs AFTER the reset below, because handing the screen to the
  // fresh workspace makes the view binders record the OUTGOING active one's
  // last view — sweeping first would just be re-dirtied a tick later.
  const closing = workspaces.get();
  const ws: Workspace = Object.freeze({
    id: newId(),
    projectId: null,
    chatId: null,
    openedAtMs: Date.now(),
  });
  workspaces.set([ws]);
  activeWorkspaceId.set(ws.id);
  // The projection follows the reset, so the atoms and the workspace record
  // cannot come out of a sign-out disagreeing about what is open. Inside
  // `withSync` because this IS the sync — the selection listeners must not
  // then write the cleared pair back onto the fresh workspace.
  withSync(() => {
    selectProject(null);
    selectChat(null);
  });
  for (const closed of closing) {
    persistTabOnlyRemovePrefixed(workspaceScopePrefix(closed.id));
  }
}

registerReset("workspaces", resetWorkspaces);

restoreWorkspaces();
