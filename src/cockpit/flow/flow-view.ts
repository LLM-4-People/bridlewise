/**
 * PER-WORKSPACE FLOW VIEW — where each tab was reading, kept apart.
 *
 * `state/workspaces.ts` split "what am I working on" (per workspace) from
 * "how do I like the cockpit" (shared) and published `workspaceScopedKey` for
 * the modules owning the first kind. `shell/workspace-view.ts` is the shell's
 * half of that contract (the open room, the open desk). This is the FLOW's
 * half: WHERE IN THE CONVERSATION you were.
 *
 * Four values, and all four are per workspace for the same reason:
 *
 *   scrollTop   — the reading position. One Flow serves every workspace, so
 *                 a shared scrollTop means clicking tab B drops you at tab
 *                 A's pixel offset in a different conversation.
 *   focusedId   — a beat id, and beat ids belong to ONE conversation. Shared,
 *                 the focus either names nothing (dead ↑↓, dead ⏎) or, worse,
 *                 names a beat that happens to exist in both.
 *   expanded    — which cards you opened. Yours, per conversation.
 *   follow      — whether the flow chases the tail. A tab you left scrolled
 *                 back must not be at the bottom when you return.
 *
 * THE SAME SHAPE AS THE SHELL'S, DELIBERATELY. In-memory `Map` is the truth
 * and lives exactly as long as the page; `workspaceScopedKey` is the reload
 * MIRROR. A second pattern for the same problem would be a second place to
 * look when a tab comes back wrong.
 *
 * WHAT IS MIRRORED AND WHAT IS NOT. Scroll, expansion and focus are written
 * through to `sessionStorage`, so a reload of the browser tab puts every
 * workspace back where it was. `follow` is NOT: it is recomputed from the
 * restored scroll position the first time the flow scrolls, and a mirrored
 * `follow: true` racing a restored scrollTop would fight it — one of the two
 * would win per reload, which is the definition of a value that should have
 * one owner.
 *
 * @see src/state/workspaces.ts — the unit, and `workspaceScopedKey`
 * @see src/cockpit/shell/workspace-view.ts — the shell's half, same contract
 */

import { activeWorkspaceId, workspaces, workspaceScopedKey, workspaceScopedKeyFor } from "../../state/workspaces.ts";
import { persistTabOnlyGet, persistTabOnlySet } from "../../state/persistence.ts";
import { registerReset } from "../../state/store-registry.ts";

/** The flow-level view state that belongs to ONE workspace. */
export type FlowView = Readonly<{
  scrollTop: number;
  focusedId: string | null;
  expanded: Readonly<Record<string, boolean>>;
  /** Chase the tail of the log. Not mirrored — see the header. */
  follow: boolean;
}>;

export const FLOW_VIEW_DEFAULT: FlowView = Object.freeze({
  scrollTop: 0,
  focusedId: null,
  expanded: Object.freeze({}),
  follow: true,
});

/** The three reload-mirror suffixes, named once. */
export const SCROLL_KEY = "flow:scroll";
export const EXPANDED_KEY = "flow:expanded";
export const FOCUS_KEY = "flow:focus";

/** id → where that workspace was reading. Page-lifetime. */
const views = new Map<string, FlowView>();

/**
 * Record what the ACTIVE workspace is reading.
 *
 * Called while that workspace is still the active one, which is the only
 * moment `workspaceScopedKey` can name its keys — the same discipline as
 * `noteShellView`.
 */
export function noteFlowView(view: FlowView): void {
  const id = activeWorkspaceId.get();
  if (id === null) return;
  views.set(id, Object.freeze({ ...view, expanded: Object.freeze({ ...view.expanded }) }));
  // A browser that refuses sessionStorage loses the reload mirror and nothing
  // else: the map above still carries every switch this page makes.
  const scroll = workspaceScopedKey(SCROLL_KEY);
  if (scroll !== null) persistTabOnlySet(scroll, String(Math.round(view.scrollTop)));
  const expanded = workspaceScopedKey(EXPANDED_KEY);
  if (expanded !== null) {
    // Only the OPEN ones: a map of `false`s is the default written out long-
    // hand, and it grows without bound across a long session.
    const open = Object.keys(view.expanded).filter((k) => view.expanded[k] === true);
    persistTabOnlySet(expanded, JSON.stringify(open));
  }
  const focus = workspaceScopedKey(FOCUS_KEY);
  if (focus !== null) persistTabOnlySet(focus, view.focusedId);
}

/** What the ACTIVE workspace was reading, or null if it has no record. */
export function flowViewForActive(): FlowView | null {
  const id = activeWorkspaceId.get();
  if (id === null) return null;
  const held = views.get(id);
  if (held !== undefined) return held;
  return readMirror();
}

/**
 * The reload mirror for the ACTIVE workspace, or null when it holds nothing.
 *
 * A partial mirror is honoured part by part rather than discarded: a stored
 * scroll offset with no stored focus is a true fact about where you were, and
 * refusing it because its neighbour is missing would lose real state.
 */
function readMirror(): FlowView | null {
  const scrollKey = workspaceScopedKey(SCROLL_KEY);
  const expandedKey = workspaceScopedKey(EXPANDED_KEY);
  const focusKey = workspaceScopedKey(FOCUS_KEY);
  if (scrollKey === null || expandedKey === null || focusKey === null) return null;
  const rawScroll = persistTabOnlyGet(scrollKey);
  const rawExpanded = persistTabOnlyGet(expandedKey);
  const rawFocus = persistTabOnlyGet(focusKey);
  if (rawScroll === null && rawExpanded === null && rawFocus === null) return null;
  const scroll = rawScroll === null ? 0 : Number.parseFloat(rawScroll);
  return Object.freeze({
    scrollTop: Number.isFinite(scroll) && scroll >= 0 ? scroll : 0,
    focusedId: rawFocus,
    expanded: parseExpanded(rawExpanded),
    // Restored from a reload, the flow is where you left it, not at the tail.
    follow: rawScroll === null,
  });
}

function parseExpanded(raw: string | null): Readonly<Record<string, boolean>> {
  if (raw === null) return FLOW_VIEW_DEFAULT.expanded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return FLOW_VIEW_DEFAULT.expanded;
  }
  if (!Array.isArray(parsed)) return FLOW_VIEW_DEFAULT.expanded;
  const out: Record<string, boolean> = {};
  for (const id of parsed) if (typeof id === "string") out[id] = true;
  return Object.freeze(out);
}

/**
 * Apply the incoming workspace's view on every ACTIVATION.
 *
 * The first notification is the page's own boot and is skipped, exactly as
 * the shell's binder skips it: the flow opens where the mirror (or the
 * default) already put it, and re-applying on the boot notification would
 * fight the restore.
 *
 * `record` is called with the OUTGOING workspace's id BEFORE the incoming
 * view is applied. The recording cannot go through `noteFlowView` at that
 * point — `activeWorkspaceId` has already moved, so `workspaceScopedKey`
 * would name the incoming tab's slot and one tab would inherit the other's
 * scroll offset. This is the same trap the workspace-selection sync solves
 * with its `syncing` flag, one level down.
 *
 * Returns the unsubscribe.
 */
export function bindFlowView(
  apply: (view: FlowView) => void,
  record: (outgoingId: string) => FlowView,
): () => void {
  let seen = false;
  let lastId: string | null = null;
  return activeWorkspaceId.subscribe((id) => {
    if (!seen) {
      seen = true;
      lastId = id;
      return;
    }
    if (id === lastId) return;
    const outgoing = lastId;
    lastId = id;
    if (outgoing !== null) {
      const view = record(outgoing);
      views.set(outgoing, Object.freeze({ ...view, expanded: Object.freeze({ ...view.expanded }) }));
      writeMirrorFor(outgoing, view);
    }
    apply(flowViewForActive() ?? FLOW_VIEW_DEFAULT);
  });
}

/**
 * The mirror write for a NAMED workspace (the outgoing one on a switch).
 *
 * The key comes from the owner's named-id door, not the active-id one: by
 * the time this runs, `activeWorkspaceId` already names the incoming tab,
 * so `workspaceScopedKey` would file the outgoing workspace's view under
 * the incoming tab's slot — the trap the binder's docblock above records.
 */
function writeMirrorFor(workspaceId: string, view: FlowView): void {
  persistTabOnlySet(workspaceScopedKeyFor(workspaceId, SCROLL_KEY), String(Math.round(view.scrollTop)));
  const open = Object.keys(view.expanded).filter((k) => view.expanded[k] === true);
  persistTabOnlySet(workspaceScopedKeyFor(workspaceId, EXPANDED_KEY), JSON.stringify(open));
  persistTabOnlySet(workspaceScopedKeyFor(workspaceId, FOCUS_KEY), view.focusedId);
}

/**
 * Watch for CLOSED tabs and hand their ids to `forget`.
 *
 * A closed workspace is not a backgrounded one: nothing will ever ask for its
 * beats, its cursors or its measured heights again, so they are released
 * outright rather than left for the eviction budget to notice. Without this,
 * a session that opens and closes tabs all day accumulates one dead log per
 * tab — the leak the budget was written to prevent, arriving through the door
 * the budget does not watch.
 *
 * Returns the unsubscribe.
 */
export function bindClosedWorkspaces(forget: (workspaceId: string) => void): () => void {
  let known = new Set(workspaces.get().map((w) => w.id));
  return workspaces.subscribe((list) => {
    const next = new Set(list.map((w) => w.id));
    for (const id of known) {
      if (!next.has(id)) {
        views.delete(id);
        forget(id);
      }
    }
    known = next;
  });
}

/**
 * Sign-out forgets where every workspace was reading — registered with the
 * one reset owner rather than left for a caller to remember, exactly as the
 * shell's views are. A signed-out session that came back scrolled to someone
 * else's beat would be a leak of what they had been reading.
 */
registerReset("cockpit-flow-views", () => views.clear());
