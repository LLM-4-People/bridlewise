/**
 * PER-WORKSPACE SHELL VIEW — what each tab was looking at, kept apart.
 *
 * `state/workspaces.ts` split "what am I working on" (per workspace) from
 * "how do I like the cockpit" (shared), and published `workspaceScopedKey`
 * for the modules that own the first kind. This is the shell's half of that
 * contract: the OPEN ROOM and the OPEN DESK belong to one workspace and to
 * no other.
 *
 * WHY IT MATTERS MORE THAN IT SOUNDS. Without it, switching tabs would keep
 * the previous tab's room on screen — you would leave tab A in Custody,
 * click tab B, and land in Custody looking at B's files, having asked for
 * neither. That is not a cosmetic difference: the room is the whole screen.
 * A tab strip whose tabs share one view is a strip that only pretends to
 * hold several things.
 *
 * A SWITCH PATCHES, IT DOES NOT REMOUNT. Rooms are kept alive (RoomHost) and
 * the flow keeps its own state under them, so restoring a workspace's room
 * is one assignment: the room that was already mounted becomes visible
 * again, at its scroll offset, with its measured values on screen. Nothing
 * unmounts, nothing reloads, nothing blanks.
 *
 * IN MEMORY IS THE TRUTH; STORAGE IS THE MIRROR. Switching happens against
 * the map below, which lives exactly as long as the page. The mirror through
 * `workspaceScopedKey` is what survives a reload — and on the reload itself
 * a previously-open room is deliberately NOT restored from storage: the
 * one-reveal law (§10.3) says nothing may mount after the reveal frame
 * except from a user action. The landing surface (the Switch, the project
 * room) is loaded BEFORE the reveal and mounted IN that frame, so first
 * paint is already the project room rather than a late summon. A reload
 * restores your tabs and your desk, and lands you in the project room.
 *
 * @see src/state/workspaces.ts — the unit, and `workspaceScopedKey`
 * @see src/cockpit/shell/room-visibility.ts — what "on screen" means
 */

import { activeWorkspaceId, workspaceScopedKey, workspaces } from "../../state/workspaces.ts";
import { persistTabOnlyGet, persistTabOnlySet } from "../../state/persistence.ts";
import { registerReset } from "../../state/store-registry.ts";
import type { RoomId } from "./contract.ts";
import { INSPECTOR_GROUP_IDS, type InspectorGroupId } from "../../../shared/routes.ts";

/** The shell-level view state that belongs to ONE workspace. */
export type ShellView = Readonly<{
  /** The room on screen, or null for the flow. */
  room: RoomId | null;
  /** The one inspector's selected view, or null when closed. */
  inspector: InspectorGroupId | null;
}>;

export const FLOW_VIEW: ShellView = Object.freeze({
  room: null,
  inspector: null,
});

/** The suffix every workspace's shell view is stored under. */
export const VIEW_KEY = "shell-view";

/** id → the view that workspace was last showing. Page-lifetime. */
const views = new Map<string, ShellView>();

// Explicit disclosure choices belong to the workspace's view. Keep them
// across menu unmounts; the tab mirror also survives a reload. Defaults are
// never written, so arriving data cannot replace an intentional choice.
const choices = new Map<string | null, Map<string, boolean | number | string>>();

function readChoice(id: string): boolean | number | string | undefined {
  const held = choices.get(activeWorkspaceId.get())?.get(id);
  if (held !== undefined) return held;
  const key = workspaceScopedKey(id);
  if (key === null) return undefined;
  const raw = persistTabOnlyGet(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === null || raw.length === 0) return undefined;
  if (raw.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(raw); return typeof parsed === "string" ? parsed : undefined; }
    catch { return undefined; }
  }
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 0 ? page : undefined;
}

function writeChoice(id: string, value: boolean | number | string | undefined, mirror = true): void {
  const workspace = activeWorkspaceId.get();
  let held = choices.get(workspace);
  if (held === undefined) { held = new Map(); choices.set(workspace, held); }
  if (value === undefined) held.delete(id); else held.set(id, value);
  if (!mirror) return;
  const key = workspaceScopedKey(id);
  if (key !== null) persistTabOnlySet(key, value === undefined ? null : JSON.stringify(value));
}

export function disclosureChoice(id: string): boolean | undefined {
  const value = readChoice(`disclosure:${id}`);
  return typeof value === "boolean" ? value : undefined;
}

export function noteDisclosureChoice(id: string, open: boolean): void {
  writeChoice(`disclosure:${id}`, open);
}

/** Undefined follows the newest page; a manual page remains where selected. */
export function inspectorPage(id: string): number | undefined {
  const value = readChoice(`inspector-page:${id}`);
  return typeof value === "number" ? value : undefined;
}
export function noteInspectorPage(id: string, page: number | undefined): void {
  writeChoice(`inspector-page:${id}`, page);
}

/** Reading position is page-lifetime state: no synchronous storage writes
 * on scroll. Workspace changes and menu remounts reuse the existing map. */
export function noteInspectorScroll(top: number, id = "scroll"): void {
  writeChoice(`inspector-page:${id}`, top, false);
}

/** Unsaved inspector input uses the same workspace lifetime and tab mirror
 * as manual view choices, independently of whether a body is mounted. */
export function inspectorDraft(id: string): string | undefined {
  const value = readChoice(`inspector-draft:${id}`);
  return typeof value === "string" ? value : undefined;
}
export function noteInspectorDraft(id: string, draft: string): void {
  writeChoice(`inspector-draft:${id}`, draft);
}

// Closing a workspace releases its in-memory view as well as the storage
// mirror the workspace owner already removes.
workspaces.listen(list => {
  const live = new Set(list.map(workspace => workspace.id));
  for (const id of views.keys()) if (!live.has(id)) views.delete(id);
  for (const id of choices.keys()) if (id === null || !live.has(id)) choices.delete(id);
});

function parse(raw: string | null): ShellView | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  if (v.room !== null && typeof v.room !== "string") return null;
  // `rightMenuOpen` defaults to closed for a view recorded before the
  // single menu existed (a stored view is a mirror, and the default state
  // of a surface nobody opened is closed — deny-by-default).
  return Object.freeze({
    room: (v.room as RoomId | null) ?? null,
    inspector: typeof v.inspector === "string" && INSPECTOR_GROUP_IDS.includes(v.inspector as InspectorGroupId)
      ? v.inspector as InspectorGroupId : null,
  });
}

/**
 * What to RECORD as the active workspace's view, given what is on screen.
 *
 * One rule, and it earns its own function because it is the only place the
 * recorded view differs from the rendered one: an ARMED Switch (the `+` on
 * the tab strip) is an excursion on behalf of a tab that does not exist yet.
 * You did not ask to leave THIS tab sitting in the picker, so coming back to
 * it must not drop you into the picker having chosen nothing.
 */
export function viewToRecord(
  room: RoomId | null,
  armedForNewTab: boolean,
  inspector: InspectorGroupId | null = null,
): ShellView {
  return Object.freeze({
    room: armedForNewTab && room === "switch" ? null : room,
    inspector,
  });
}

/**
 * Record what the ACTIVE workspace is showing. The shell calls this whenever
 * the room or the desk changes, so the record is written while that
 * workspace is still the active one — which is the only moment
 * `workspaceScopedKey` can name its key.
 */
export function noteShellView(view: ShellView): void {
  const id = activeWorkspaceId.get();
  if (id === null) return;
  views.set(id, view);
  const key = workspaceScopedKey(VIEW_KEY);
  // A browser that refuses sessionStorage loses the reload mirror and
  // nothing else: the map above still carries every switch this page makes.
  if (key !== null) persistTabOnlySet(key, JSON.stringify(view));
}

/** What the ACTIVE workspace was showing, or null if it has no record. */
export function shellViewForActive(): ShellView | null {
  const id = activeWorkspaceId.get();
  if (id === null) return null;
  const held = views.get(id);
  if (held !== undefined) return held;
  const key = workspaceScopedKey(VIEW_KEY);
  return key === null ? null : parse(persistTabOnlyGet(key));
}

/**
 * Apply the incoming workspace's view on every ACTIVATION.
 *
 * The first notification is the page's own boot, and it is skipped on
 * purpose (see the one-reveal note in the header): the cockpit lands in
 * the project room from the reveal frame itself, and the shell's own
 * write-through immediately re-records that as this workspace's view.
 * Every notification after it is a real switch.
 *
 * Returns the unsubscribe.
 */
export function bindWorkspaceView(apply: (view: ShellView) => void): () => void {
  let seen = false;
  let lastId: string | null = null;
  return activeWorkspaceId.subscribe((id) => {
    if (!seen) {
      seen = true;
      lastId = id;
      return;
    }
    if (id === lastId) return;
    lastId = id;
    apply(shellViewForActive() ?? FLOW_VIEW);
  });
}

/**
 * Sign-out forgets every workspace's remembered view — registered with the
 * one reset owner rather than left for a caller to remember. A signed-out
 * session that came back to someone else's open room would be a leak of
 * where they had been.
 */
registerReset("cockpit-shell-views", () => {
  views.clear();
  choices.clear();
});
