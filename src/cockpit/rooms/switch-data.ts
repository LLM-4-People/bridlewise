/**
 * THE SWITCH — pure river helpers (DESIGN-COCKPIT-V2 §5.2).
 *
 * One recency river: reels (conversations) grouped under project caps,
 * newest activity first, latest 3 per project + "n more" expandable in
 * place — never a 90-row wall. Two laws hold here:
 *
 *   - SPATIAL STABILITY: ordering is recency but grouping is stable — cap
 *     positions are computed ONCE per session (`stableCapOrder`) and held.
 *     Later activity never reorders the caps; only a project the session
 *     has not seen yet enters (at the top: it exists because the user just
 *     created it — a user action, not a data twitch).
 *
 *   - HONESTY: every timestamp rendered comes from the stores' real
 *     `updatedAt`/`createdAt`; nothing here invents a time, a count, or a
 *     conversation. Absence of loaded conversations is a STATE the caller
 *     renders in words, never an empty-but-confident grid.
 *
 * Pure module: no DOM, no Svelte, no fetch, no Date.now() — `nowMs` is an
 * input everywhere it matters, so every function is deterministic and the
 * <50ms filter budget (§5.2, CI-enforced) is measurable in isolation.
 */

import type { ProjectSummary } from "../../state/projects.ts";
import type { ChatSummary } from "../../state/chats.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS, RELATIVE_DATE_CUTOFF_DAYS } from "./switch-config.ts";

/** How many reels a collapsed cap shows (§5.2: "latest 3 per project"). */
export const REELS_PER_CAP = 3;

/** One conversation, projected to what a reel renders + searches. */
export type Reel = Readonly<{
  chat: ChatSummary;
  /** Precomputed lowercase title — the <50ms filter runs on this. */
  search: string;
  /** Epoch ms of the chat's real `updatedAt` (0 when unparseable). */
  updatedMs: number;
}>;

export type ChatsLoadState = "pending" | "loaded" | "failed";

/** One project cap and its reels, recency-desc. */
export type ProjectCap = Readonly<{
  project: ProjectSummary;
  /** Lowercase project name — filter input. */
  search: string;
  /** ALL reels for the project, newest first. */
  reels: readonly Reel[];
  /** Reels to render under the cap (latest 3, all when expanded, or the
   * matches when filtering). */
  visible: readonly Reel[];
  /** How many reels the collapsed cap is holding back ("n more"). */
  moreCount: number;
  /** Whether "n more" is currently expanded in place. */
  expanded: boolean;
  /** Newest real activity in the group, epoch ms (chats' updatedAt, else
   * the project's own updatedAt). */
  lastActivityMs: number;
  /** Whether this project's conversations are actually in memory. */
  chatsState: ChatsLoadState;
}>;

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Newest real activity for a project: its chats' updatedAt when loaded,
 * else the project row's own updatedAt. Both are recorded fields. */
function activityMs(
  project: ProjectSummary,
  projectChats: readonly ChatSummary[],
): number {
  let latest = toMs(project.updatedAt);
  for (const c of projectChats) {
    const ms = toMs(c.updatedAt);
    if (ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Session-stable cap order (§5.2 spatial stability).
 *
 * First call (`prev` empty): projects ranked by real recency, newest first.
 * Later calls: ids already ordered KEEP their relative positions (deleted
 * projects drop out); ids the session has never seen (a project created
 * during the session) enter at the TOP — creation is a user gesture, and
 * the newest thing the user made belongs at top-left.
 */
export function stableCapOrder(
  prev: readonly string[],
  projects: readonly ProjectSummary[],
  chatsByProject: Readonly<Record<string, readonly ChatSummary[]>> | ((id: string) => readonly ChatSummary[]),
): readonly string[] {
  const existing = new Set(projects.map((p) => p.id));
  const kept = prev.filter((id) => existing.has(id));
  const seen = new Set(kept);
  const fresh = projects
    .filter((p) => !seen.has(p.id))
    .map((p) => ({ id: p.id, at: activityMs(p, typeof chatsByProject === "function" ? chatsByProject(p.id) : chatsByProject[p.id] ?? []) }))
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
  // First fill: everything is fresh and the sort IS the recency river.
  // Session inserts: fresh ids (just-created projects) enter at the top.
  return [...fresh, ...kept];
}

/**
 * Build the river: caps in the session-stable order, reels recency-desc
 * under each, latest-3 + moreCount unless expanded.
 */
export function buildRiver(
  projects: readonly ProjectSummary[],
  chatsByProject: Readonly<Record<string, readonly ChatSummary[]>>,
  capOrder: readonly string[],
  expandedIds: ReadonlySet<string>,
  chatsStateOf: (projectId: string) => ChatsLoadState,
): readonly ProjectCap[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const caps: ProjectCap[] = [];
  for (const id of capOrder) {
    const project = byId.get(id);
    if (project === undefined) continue;
    const projectChats = chatsByProject[id] ?? [];
    caps.push(buildProjectCap(project, projectChats, expandedIds.has(id), chatsStateOf(id)));
  }
  return caps;
}

/** The projection owner for one answer as well as a whole initial river. */
function buildProjectCap(
  project: ProjectSummary,
  projectChats: readonly ChatSummary[],
  expanded: boolean,
  chatsState: ChatsLoadState,
): ProjectCap {
  const reels = projectChats.map(chat => ({
    chat, search: chat.title.toLowerCase(), updatedMs: toMs(chat.updatedAt),
  })).sort((a, b) => b.updatedMs - a.updatedMs);
  const visible = expanded ? reels : reels.slice(0, REELS_PER_CAP);
  return {
    project, search: project.name.toLowerCase(), reels, visible,
    moreCount: Math.max(0, reels.length - visible.length), expanded,
    lastActivityMs: Math.max(toMs(project.updatedAt), reels[0]?.updatedMs ?? Number.NEGATIVE_INFINITY), chatsState,
  };
}

/**
 * Type-to-filter (§5.2): instant, in-memory, across project AND
 * conversation names. Empty query returns the river untouched.
 *
 * Match semantics: a reel matches when its title contains the query; a cap
 * whose NAME matches keeps its normal latest-3/expanded visibility; a cap
 * with matching reels shows ALL of them (every match visible — a filter
 * that hides its own hits behind "n more" would be lying about results).
 * Caps with no match anywhere disappear.
 */
export function filterRiver(
  caps: readonly ProjectCap[],
  query: string,
): readonly ProjectCap[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return caps;
  const out: ProjectCap[] = [];
  for (const cap of caps) {
    const reelMatches = cap.reels.filter((r) => r.search.includes(q));
    if (reelMatches.length > 0) {
      out.push({ ...cap, visible: reelMatches, moreCount: 0, expanded: true });
    } else if (cap.search.includes(q)) {
      out.push(cap);
    }
  }
  return out;
}

/**
 * The unfiltered river, partitioned for legibility (§5.2). Conversation-
 * holding caps come first so the real reels are not walled off. Empty
 * caps follow as compact headers (name + "+ conversation") — the empty
 * state's one action, not a counted fold the user must search to find.
 * Loading and failed stay counted: the user cannot start a conversation
 * on a list that has not arrived.
 *
 * Caps that HOLD conversations come first (the work). Caps measured
 * empty follow as compact headers — the project's name plus its one
 * verb, "+ conversation", beside it. Loading and failed lists stay
 * COUNTED on one line: the user cannot act on them yet. A filter still
 * shows whatever it matches.
 */
export type RiverPartition = Readonly<{
  /** Caps with at least one conversation, in river order. */
  active: readonly ProjectCap[];
  /** Caps measured to hold zero conversations, in river order. */
  empty: readonly ProjectCap[];
  /** Projects whose conversations are still loading (none known yet). */
  loadingCount: number;
  /** Projects whose conversation list could not be loaded. */
  failedCount: number;
  /** Projects measured to hold zero conversations (`empty.length`). */
  emptyCount: number;
}>;

export function partitionRiver(caps: readonly ProjectCap[]): RiverPartition {
  const active: ProjectCap[] = [];
  const empty: ProjectCap[] = [];
  let loadingCount = 0;
  let failedCount = 0;
  for (const cap of caps) {
    if (cap.reels.length > 0) active.push(cap);
    else if (cap.chatsState === "pending") loadingCount += 1;
    else if (cap.chatsState === "failed") failedCount += 1;
    else empty.push(cap);
  }
  return { active, empty, loadingCount, failedCount, emptyCount: empty.length };
}

/** The visible reels in river order — the roving-focus sequence. */
export function flattenVisible(caps: readonly ProjectCap[]): readonly Reel[] {
  const out: Reel[] = [];
  for (const cap of caps) out.push(...cap.visible);
  return out;
}

/** Total conversations currently in memory across the river. */
export function countReels(caps: readonly ProjectCap[]): number {
  let n = 0;
  for (const cap of caps) n += cap.reels.length;
  return n;
}

// ── Incremental river ────────────────────────────────────────────────────
// Flow's positional HeightIndex cannot move a cap without rebuilding all
// positions. This ordered cap model instead keeps height, match and focus
// counts on an AVL tree. Rotations update only the affected ancestors. Its
// surface is about caps/reels, not a second general-purpose virtualizer.
type CapNode = {
  cap: ProjectCap;
  chats: readonly ChatSummary[];
  shown: ProjectCap | null;
  rank: number;
  tie: number;
  left: CapNode | null;
  right: CapNode | null;
  height: number;
  header: number | null;
  columns: number;
  pixels: number;
  activeGrid: ColumnExtent;
  emptyGrid: ColumnExtent;
  filterGrid: ColumnExtent;
  activeReels: number;
  filterReels: number;
  matchedCaps: number;
  loading: number;
  failed: number;
  unsettled: number;
  unavailable: number;
  conversations: number;
  visibleIds: ReadonlyMap<string, number>;
  replayCount: number;
  replays: number;
};
type RiverMode = "active" | "empty" | "filter";
/** The existing ordered tree sums project heights independently in each
 * responsive column. A subtree starts in column zero; concatenation rotates
 * its sums by the preceding project count. No positional cache is needed. */
type ColumnExtent = Readonly<{ count: number; heights: readonly number[] }>;
function appendExtent(left: ColumnExtent, right: ColumnExtent): ColumnExtent {
  const heights = [...left.heights], columns = heights.length;
  for (let i = 0; i < columns; i++) heights[(left.count + i) % columns]! += right.heights[i]!;
  return { count: left.count + right.count, heights };
}
function gridExtent(node: CapNode | null, mode: RiverMode, columns: number): ColumnExtent {
  return node === null ? { count: 0, heights: Array<number>(columns).fill(0) }
    : mode === "active" ? node.activeGrid : mode === "empty" ? node.emptyGrid : node.filterGrid;
}
function extentHeight(extent: ColumnExtent): number { return Math.max(...extent.heights); }
export type RiverGeometry = Readonly<{
  columns: number;
  /** Equal conversation tracks inside each project when few groups fill the room. */
  reelColumns?: number;
  reelHeight: number;
  reelGap: number;
  capGap: number;
  headerEstimate: number;
  /** Width invalidates wrapped project headers within one column count. */
  contentWidth?: number;
}>;
export type RiverWindowCap = Readonly<{
  cap: ProjectCap;
  offset: number;
  column: number;
  reels: readonly Reel[];
  firstReel: number;
  lastReel: number;
  reelStart: number;
  reelOffset: number;
  gridHeight: number;
  rows: readonly Readonly<{ index: number; reels: readonly Reel[] }>[];
}>;

function capCompare(a: CapNode, b: CapNode): number {
  return a.rank - b.rank || a.tie - b.tie;
}
function capReels(node: CapNode | null, mode: RiverMode): number {
  return node === null || mode === "empty" ? 0 : mode === "active" ? node.activeReels : node.filterReels;
}
function ownCap(node: CapNode, mode: RiverMode): ProjectCap | null {
  if (mode === "filter") return node.shown;
  if (mode === "active") return node.cap.reels.length > 0 ? node.cap : null;
  return node.cap.reels.length === 0 && node.cap.chatsState === "loaded" ? node.cap : null;
}
function refreshCap(node: CapNode): CapNode {
  const { left, right, cap } = node;
  node.height = 1 + Math.max(left?.height ?? 0, right?.height ?? 0);
  const active = cap.reels.length > 0;
  const empty = !active && cap.chatsState === "loaded";
  const summarize = (mode: RiverMode, included: boolean): ColumnExtent => {
    const l = left === null ? null : gridExtent(left, mode, node.columns);
    const r = right === null ? null : gridExtent(right, mode, node.columns);
    const preceding = (l?.count ?? 0) + (included ? 1 : 0);
    const heights = Array<number>(node.columns).fill(0);
    for (let i = 0; i < node.columns; i++) {
      heights[i]! += l?.heights[i] ?? 0;
      heights[(preceding + i) % node.columns]! += r?.heights[i] ?? 0;
    }
    if (included) heights[(l?.count ?? 0) % node.columns]! += node.pixels;
    return { count: preceding + (r?.count ?? 0), heights };
  };
  node.activeGrid = summarize("active", active);
  node.emptyGrid = summarize("empty", empty);
  node.filterGrid = summarize("filter", node.shown !== null);
  node.activeReels = (left?.activeReels ?? 0) + cap.visible.length + (right?.activeReels ?? 0);
  node.filterReels = (left?.filterReels ?? 0) + (node.shown?.visible.length ?? 0) + (right?.filterReels ?? 0);
  node.matchedCaps = (left?.matchedCaps ?? 0) + (node.shown === null ? 0 : 1) + (right?.matchedCaps ?? 0);
  node.loading = (left?.loading ?? 0) + (!active && cap.chatsState === "pending" ? 1 : 0) + (right?.loading ?? 0);
  node.failed = (left?.failed ?? 0) + (!active && cap.chatsState === "failed" ? 1 : 0) + (right?.failed ?? 0);
  node.unsettled = (left?.unsettled ?? 0) + (cap.chatsState === "pending" ? 1 : 0) + (right?.unsettled ?? 0);
  node.unavailable = (left?.unavailable ?? 0) + (cap.chatsState === "failed" ? 1 : 0) + (right?.unavailable ?? 0);
  node.conversations = (left?.conversations ?? 0) + cap.reels.length + (right?.conversations ?? 0);
  node.replays = (left?.replays ?? 0) + node.replayCount + (right?.replays ?? 0);
  return node;
}
function rotateCapLeft(node: CapNode): CapNode {
  const next = node.right!;
  node.right = next.left;
  next.left = refreshCap(node);
  return refreshCap(next);
}
function rotateCapRight(node: CapNode): CapNode {
  const next = node.left!;
  node.left = next.right;
  next.right = refreshCap(node);
  return refreshCap(next);
}
function balanceCap(node: CapNode): CapNode {
  refreshCap(node);
  const balance = (node.left?.height ?? 0) - (node.right?.height ?? 0);
  if (balance > 1) {
    if ((node.left!.left?.height ?? 0) < (node.left!.right?.height ?? 0)) node.left = rotateCapLeft(node.left!);
    return rotateCapRight(node);
  }
  if (balance < -1) {
    if ((node.right!.right?.height ?? 0) < (node.right!.left?.height ?? 0)) node.right = rotateCapRight(node.right!);
    return rotateCapLeft(node);
  }
  return node;
}
function insertCap(root: CapNode | null, node: CapNode): CapNode {
  if (root === null) return refreshCap(node);
  if (capCompare(node, root) < 0) root.left = insertCap(root.left, node);
  else root.right = insertCap(root.right, node);
  return balanceCap(root);
}
function removeCap(root: CapNode | null, node: CapNode): CapNode | null {
  if (root === null) return null;
  const cmp = capCompare(node, root);
  if (cmp < 0) root.left = removeCap(root.left, node);
  else if (cmp > 0) root.right = removeCap(root.right, node);
  else {
    if (root.left === null) return root.right;
    if (root.right === null) return root.left;
    let next = root.right;
    while (next.left !== null) next = next.left;
    const right = removeCap(root.right, next);
    next.left = root.left;
    next.right = right;
    return balanceCap(next);
  }
  return balanceCap(root);
}

export class SwitchRiver {
  private root: CapNode | null = null;
  private readonly nodes = new Map<string, CapNode>();
  private readonly expanded = new Set<string>();
  private readonly replayIds = new Set<string>();
  private query = "";
  private settled: boolean;
  private geometry: RiverGeometry;
  private readonly chatsFor: (id: string) => readonly ChatSummary[];
  private readonly stateFor: (id: string) => ChatsLoadState;

  constructor(
    projects: readonly ProjectSummary[],
    chatsFor: (id: string) => readonly ChatSummary[],
    stateFor: (id: string) => ChatsLoadState,
    geometry: RiverGeometry,
    previousOrder: readonly string[] = [],
  ) {
    this.geometry = geometry;
    this.chatsFor = chatsFor;
    this.stateFor = stateFor;
    this.settled = previousOrder.length > 0;
    this.replaceProjects(projects, previousOrder);
  }

  /** Membership/metadata changes are population operations. Completions use
   * updateProject and never enter this rebuild. */
  replaceProjects(projects: readonly ProjectSummary[], previousOrder?: readonly string[]): void {
    const order = this.settled
      ? stableCapOrder(previousOrder ?? this.order(), projects, this.chatsFor)
      : [];
    const positions = new Map(order.map((id, index) => [id, index]));
    this.root = null;
    this.nodes.clear();
    for (let index = 0; index < projects.length; index++) {
      const project = projects[index]!;
      const chats = this.chatsFor(project.id);
      const cap = buildProjectCap(project, chats, this.expanded.has(project.id), this.stateFor(project.id));
      const node: CapNode = {
        cap, chats, shown: null, rank: this.settled ? positions.get(project.id)! : -cap.lastActivityMs,
        tie: index, left: null, right: null, height: 1,
        header: null, columns: this.geometry.columns, pixels: 0,
        activeGrid: {count:0,heights:[]}, emptyGrid: {count:0,heights:[]}, filterGrid: {count:0,heights:[]},
        activeReels: 0, filterReels: 0, matchedCaps: 0, loading: 0, failed: 0,
        unsettled: 0, unavailable: 0, conversations: 0, visibleIds: new Map(), replayCount: 0, replays: 0,
      };
      this.projectVisibility(node);
      this.nodes.set(project.id, node);
      this.root = insertCap(this.root, node);
    }
  }

  private gridHeight(node: CapNode): number {
    const reels = node.shown?.visible.length ?? 0;
    return reels === 0 ? 0 : Math.ceil(reels / (this.geometry.reelColumns ?? 1)) * (this.geometry.reelHeight + this.geometry.reelGap) - this.geometry.reelGap;
  }
  private projectVisibility(node: CapNode): void {
    node.shown = this.query.length === 0 ? node.cap : filterRiver([node.cap], this.query)[0] ?? null;
    const visible = this.query.length === 0 ? node.cap.visible : node.shown?.visible ?? [];
    const ids = new Map<string, number>();
    let replays = 0;
    for (const reel of visible) {
      ids.set(reel.chat.id, ids.size);
      if (this.replayIds.has(reel.chat.id)) replays++;
    }
    node.visibleIds = ids;
    node.replayCount = replays;
    this.projectPixels(node);
  }
  private projectPixels(node: CapNode): void {
    const cap = node.shown;
    const header = node.header ?? this.geometry.headerEstimate;
    const grid = this.gridHeight(node);
    node.pixels = header + grid + this.geometry.capGap;
    if (cap !== null && cap.visible.length === 0 && cap.chatsState !== "loaded") node.pixels += this.geometry.headerEstimate;
  }
  private change(node: CapNode, apply: () => void): void {
    const rank = node.rank;
    apply();
    if (node.rank === rank) {
      // Metadata, replay, expansion and measurements keep their key. Only
      // ancestor summaries changed; rotations/deletion buy nothing here.
      const refresh = (root: CapNode | null): void => {
        if (root === null) return;
        const compared = capCompare(node, root);
        if (compared < 0) refresh(root.left);
        else if (compared > 0) refresh(root.right);
        refreshCap(root);
      };
      refresh(this.root);
      return;
    }
    const nextRank = node.rank;
    node.rank = rank;
    this.root = removeCap(this.root, node);
    node.left = null;
    node.right = null;
    node.rank = nextRank;
    this.root = insertCap(this.root, node);
  }

  updateProject(id: string): void {
    const node = this.nodes.get(id);
    if (node === undefined) return;
    const chats = this.chatsFor(id);
    const state = this.stateFor(id);
    if (chats === node.chats && state === node.cap.chatsState) return;
    this.change(node, () => {
      if (chats === node.chats) {
        const previous = node.cap;
        node.cap = { ...previous, chatsState: state };
        if (node.shown === previous) node.shown = node.cap;
        else if (node.shown !== null) node.shown = { ...node.shown, chatsState: state };
        this.projectPixels(node);
      } else {
        node.cap = buildProjectCap(node.cap.project, chats, this.expanded.has(id), state);
        node.chats = chats;
        if (!this.settled) node.rank = -node.cap.lastActivityMs;
        this.projectVisibility(node);
      }
    });
  }

  /** Called AFTER all changed projects have been ingested, including the
   * final answer's recency. Later activity retains these positions. */
  settle(): boolean {
    if (this.settled || this.nodes.size === 0 || (this.root?.unsettled ?? 0) > 0) return false;
    this.settled = true;
    return true;
  }

  setQuery(query: string): void {
    const next = query.trim().toLowerCase();
    if (next === this.query) return;
    this.query = next;
    this.reproject(this.root, true);
  }
  setGeometry(geometry: RiverGeometry): boolean {
    const previous = this.geometry;
    if (geometry.columns === previous.columns && (geometry.reelColumns ?? 1) === (previous.reelColumns ?? 1) && geometry.reelHeight === previous.reelHeight
      && geometry.reelGap === previous.reelGap && geometry.capGap === previous.capGap
      && geometry.headerEstimate === previous.headerEstimate && geometry.contentWidth === previous.contentWidth) return false;
    this.geometry = geometry;
    this.reproject(this.root, false);
    return true;
  }
  private reproject(node: CapNode | null, filterChanged: boolean): void {
    if (node === null) return;
    this.reproject(node.left, filterChanged);
    this.reproject(node.right, filterChanged);
    // A projection changes membership/grid tokens, not the measured DOM
    // header. Unmeasured caps derive the current estimate; mounted caps are
    // corrected only by their observer when their actual border box changes.
    if (filterChanged) this.projectVisibility(node);
    else { node.header = null; node.columns = this.geometry.columns; this.projectPixels(node); }
    refreshCap(node);
  }
  toggleExpanded(id: string): void {
    const node = this.nodes.get(id);
    if (node === undefined) return;
    this.change(node, () => {
      const expanded = !this.expanded.has(id);
      if (expanded) this.expanded.add(id); else this.expanded.delete(id);
      const visible = expanded ? node.cap.reels : node.cap.reels.slice(0, REELS_PER_CAP);
      node.cap = { ...node.cap, expanded, visible, moreCount: node.cap.reels.length - visible.length };
      this.projectVisibility(node);
    });
  }

  setReplay(chatId: string, projectId: string, available: boolean): boolean {
    if (this.replayIds.has(chatId) === available) return false;
    if (available) this.replayIds.add(chatId); else this.replayIds.delete(chatId);
    const node = this.nodes.get(projectId);
    if (node !== undefined && node.visibleIds.has(chatId)) {
      this.change(node, () => { node.replayCount += available ? 1 : -1; });
      return true;
    }
    return false;
  }

  /** An observer must name the immutable cap whose header it measured. */
  measureHeader(cap: ProjectCap, height: number): boolean {
    const node = this.nodes.get(cap.project.id);
    if (node === undefined || node.shown !== cap || !Number.isFinite(height) || height <= 0) return false;
    const previous = node.header ?? this.geometry.headerEstimate;
    if (Math.abs(previous - height) < 0.5) {
      // An observation equal to the estimate is still measured knowledge.
      node.header = previous;
      return false;
    }
    this.change(node, () => { node.header = height; this.projectPixels(node); });
    return true;
  }

  /** Explicit sorting is a user action. Later activity keeps these positions. */
  sortBy(sort: "recent" | "name"): void {
    const nodes = [...this.nodes.values()];
    nodes.sort(sort === "name"
      ? (a, b) => a.cap.project.name.localeCompare(b.cap.project.name) || capCompare(a, b)
      : (a, b) => b.cap.lastActivityMs - a.cap.lastActivityMs || capCompare(a, b));
    // Sorting already supplies the order. Wire the existing nodes once;
    // refresh the same aggregate owner from leaves to root.
    const build = (start: number, end: number): CapNode | null => {
      if (start >= end) return null;
      const mid = (start + end) >>> 1;
      const node = nodes[mid]!; node.rank = mid;
      node.left = build(start, mid); node.right = build(mid + 1, end);
      return refreshCap(node);
    };
    this.root = build(0, nodes.length);
    this.settled = true;
  }

  indexOf(chatId: string, projectId: string): number | undefined {
    const target = this.nodes.get(projectId);
    const local = target?.visibleIds.get(chatId);
    if (target === undefined || local === undefined) return undefined;
    const mode = this.query.length === 0 ? "active" : "filter";
    let node = this.root, start = 0;
    while (node !== null) {
      const compare = capCompare(target, node);
      if (compare < 0) { node = node.left; continue; }
      start += capReels(node.left, mode);
      if (compare === 0) return start + local;
      start += ownCap(node, mode)?.visible.length ?? 0;
      node = node.right;
    }
    return undefined;
  }

  /** Project columns keep their own vertical stack. Vertical travel stays
   * in that column; horizontal travel chooses the closest actual tile in
   * the neighboring column, rather than using a global flat-index stride. */
  moveVertical(index: number, direction: -1 | 1): number | undefined {
    const located = this.reelAt(index);
    if (located === undefined) return undefined;
    const node = this.nodes.get(located.reel.chat.projectId)!;
    const local = node.visibleIds.get(located.reel.chat.id)!;
    const tracks = this.geometry.reelColumns ?? 1;
    const next = local + direction * tracks;
    if (next >= 0 && next < node.shown!.visible.length) return index + direction * tracks;
    // A partial final row still has a real destination in this project.
    if (direction > 0 && Math.floor(local / tracks) < Math.ceil(node.shown!.visible.length / tracks) - 1) return index - local + node.shown!.visible.length - 1;
    return this.nearestInColumn(located.column, located.offset + direction * (this.geometry.reelHeight + this.geometry.reelGap), direction);
  }
  moveHorizontal(index: number, direction: -1 | 1): number | undefined {
    const located = this.reelAt(index);
    if (located === undefined) return undefined;
    const column = located.column + direction;
    if (column < 0 || column >= this.geometry.columns * (this.geometry.reelColumns ?? 1)) return index;
    return this.nearestInColumn(column, located.offset, 0) ?? index;
  }
  private nearestInColumn(column: number, y: number, direction: -1 | 0 | 1): number | undefined {
    const mode = this.query.length === 0 ? "active" : "filter";
    const tracks = this.geometry.reelColumns ?? 1, projectColumn = Math.floor(column / tracks), tileColumn = column % tracks;
    let answer: number | undefined, distance = Infinity;
    const visit = (node: CapNode | null, prefix: ColumnExtent, reelStart: number): void => {
      if (node === null) return;
      const end = appendExtent(prefix, gridExtent(node, mode, this.geometry.columns));
      const low = prefix.heights[projectColumn]!, high = end.heights[projectColumn]!;
      if (high <= low || (direction < 0 && low > y) || (direction > 0 && high < y)
        || (y < low && low - y > distance) || (y > high && y - high > distance)) return;
      const left = gridExtent(node.left, mode, this.geometry.columns);
      const before = appendExtent(prefix, left);
      const cap = ownCap(node, mode), col = before.count % this.geometry.columns;
      const start = reelStart + capReels(node.left, mode);
      if (cap !== null && cap.visible.length > 0 && col === projectColumn) {
        const stride = this.geometry.reelHeight + this.geometry.reelGap;
        const top = before.heights[col]! + (node.header ?? this.geometry.headerEstimate);
        const relative = (y - top) / stride;
        const row = Math.max(0, Math.min(Math.ceil(cap.visible.length / tracks) - 1, direction < 0 ? Math.floor(relative) : direction > 0 ? Math.ceil(relative) : Math.round(relative)));
        const at = top + row * stride;
        if ((direction === 0 || direction < 0 && at <= y || direction > 0 && at >= y) && Math.abs(at-y) < distance) { distance = Math.abs(at-y); answer = start + Math.min(cap.visible.length - 1, row * tracks + tileColumn); }
      }
      const after = cap === null ? before : this.afterProject(before, node.pixels);
      // Visit the side containing the requested height first to bound the
      // other traversal by an actual nearest tile, including very tall groups.
      if (y < before.heights[projectColumn]!) {
        visit(node.left, prefix, reelStart); visit(node.right, after, start + (cap?.visible.length ?? 0));
      } else {
        visit(node.right, after, start + (cap?.visible.length ?? 0)); visit(node.left, prefix, reelStart);
      }
    };
    visit(this.root, gridExtent(null, mode, this.geometry.columns), 0);
    return answer;
  }
  private afterProject(before: ColumnExtent, pixels: number): ColumnExtent {
    const heights = [...before.heights]; heights[before.count % this.geometry.columns]! += pixels;
    return { count: before.count + 1, heights };
  }

  get counts(): Readonly<{ loading: number; failed: number; pending: number; unavailable: number; conversations: number; matches: number; reels: number; replay: boolean }> {
    const root = this.root;
    return {
      loading: root?.loading ?? 0, failed: root?.failed ?? 0, pending: root?.unsettled ?? 0, unavailable: root?.unavailable ?? 0,
      conversations: root?.conversations ?? 0, matches: root?.matchedCaps ?? 0,
      reels: capReels(root, this.query.length === 0 ? "active" : "filter"), replay: (root?.replays ?? 0) > 0,
    };
  }
  get totalHeight(): number {
    return this.query.length === 0 ? extentHeight(gridExtent(this.root, "active", this.geometry.columns)) + extentHeight(gridExtent(this.root, "empty", this.geometry.columns)) : extentHeight(gridExtent(this.root, "filter", this.geometry.columns));
  }
  order(): readonly string[] {
    const ids: string[] = [];
    const walk = (node: CapNode | null): void => {
      if (node === null) return;
      walk(node.left); ids.push(node.cap.project.id); walk(node.right);
    };
    walk(this.root);
    return ids;
  }

  window(top: number, bottom: number): readonly RiverWindowCap[] {
    const result: RiverWindowCap[] = [], columns = this.geometry.columns, tracks = this.geometry.reelColumns ?? 1;
    const visit = (node: CapNode | null, mode: RiverMode, prefix: ColumnExtent, reelStart: number): void => {
      if (node === null) return;
      const extent = gridExtent(node, mode, columns);
      if (extent.count === 0) return;
      const end = appendExtent(prefix, extent);
      if (end.heights.every((height, i) => height <= top || prefix.heights[i]! >= bottom || height === prefix.heights[i])) return;
      const before = appendExtent(prefix, gridExtent(node.left, mode, columns));
      const leftReels = capReels(node.left, mode), cap = ownCap(node, mode);
      visit(node.left, mode, prefix, reelStart);
      const column = before.count % columns, offset = before.heights[column]!;
      if (cap !== null && offset < bottom && offset + node.pixels > top) {
        const stride = this.geometry.reelHeight + this.geometry.reelGap;
        const header = node.header ?? this.geometry.headerEstimate;
        const first = Math.min(cap.visible.length, Math.max(0, Math.floor((top-offset-header)/stride)) * tracks);
        const last = Math.min(cap.visible.length, Math.max(first, Math.ceil((bottom-offset-header)/stride) * tracks));
        result.push({ cap, offset, column, reels: cap.visible.slice(first,last), firstReel:first, lastReel:last,
          reelStart:reelStart+leftReels, reelOffset:Math.floor(first/tracks)*stride, gridHeight:this.gridHeight(node),
          rows:Array.from({length:Math.ceil((last-first)/tracks)},(_,i)=>({index:first+i*tracks,reels:cap.visible.slice(first+i*tracks,Math.min(last,first+(i+1)*tracks))})) });
      }
      visit(node.right, mode, cap === null ? before : this.afterProject(before,node.pixels), reelStart+leftReels+(cap?.visible.length??0));
    };
    if (this.query.length > 0) visit(this.root,"filter",gridExtent(null,"filter",columns),0);
    else {
      visit(this.root,"active",gridExtent(null,"active",columns),0);
      const start = extentHeight(gridExtent(this.root,"active",columns));
      visit(this.root,"empty",{count:0,heights:Array<number>(columns).fill(start)},capReels(this.root,"active"));
    }
    return result;
  }

  reelAt(index: number): Readonly<{ reel: Reel; offset: number; column: number }> | undefined {
    if (index < 0) return undefined;
    const mode = this.query.length === 0 ? "active" : "filter";
    let node=this.root, prefix=gridExtent(null,mode,this.geometry.columns);
    while(node!==null) {
      const left=capReels(node.left,mode);
      if(index<left) {node=node.left;continue;}
      prefix=appendExtent(prefix,gridExtent(node.left,mode,this.geometry.columns)); index-=left;
      const cap=ownCap(node,mode),column=prefix.count%this.geometry.columns;
      const tracks=this.geometry.reelColumns??1;
      if(cap!==null&&index<cap.visible.length) return {reel:cap.visible[index]!,column:column*tracks+index%tracks,
        offset:prefix.heights[column]!+(node.header??this.geometry.headerEstimate)+Math.floor(index/tracks)*(this.geometry.reelHeight+this.geometry.reelGap)};
      index-=cap?.visible.length??0;
      if(cap!==null)prefix=this.afterProject(prefix,node.pixels);
      node=node.right;
    }
    return undefined;
  }

}

/**
 * The name a new project wears once a folder is chosen: the folder's own
 * name plus the calendar day of the choice. `atMs` is an input — this
 * module never reads the clock. The date grain is the ISO day of that
 * instant, so two folders chosen on the same day stay distinguishable by
 * name and two choices of the same folder on different days do not collide.
 */
export function projectNameFromFolder(path: string, atMs: number): string {
  const parts = path.split("/").filter((s) => s.length > 0);
  const base = parts.at(-1) ?? path;
  const date = new Date(atMs).toISOString().split("T")[0];
  return `${base} ${date}`;
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * Relative time in plain words, from a REAL recorded instant. `nowMs` is a
 * parameter — this module never reads the clock. A future timestamp (clock
 * skew) renders as "just now" rather than a fabricated negative age.
 */
export function relativeTime(ms: number, nowMs: number): string {
  if (ms <= 0) return "time not recorded";
  const age = nowMs - ms;
  if (age < MINUTE_MS) return "just now";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`;
  if (age < RELATIVE_DATE_CUTOFF_DAYS * DAY_MS) return `${Math.floor(age / DAY_MS)}d ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  const stamp = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return sameYear ? stamp : `${stamp} ${d.getFullYear()}`;
}

/**
 * ── SAME NAME, DIFFERENT PROJECT: the path says which is which ────────────
 *
 * Checkouts of one repository under different roots produce caps whose
 * NAMES are identical to the byte (observed live: three caps all reading
 * the same truncated name), and a reader picking a conversation has no way
 * to tell whose it is. The disambiguator is the projects' own recorded
 * paths: for each group of caps sharing a name, the SHORTEST trailing run
 * of path segments that is unique within the group. Unique names get no
 * hint — a hint nothing distinguishes is noise.
 *
 * Pure and clock-free like everything else here; the room renders the hint
 * in quiet ink beside the cap name, with the full path on the title.
 */
export function capPathHints(
  projects: readonly Pick<ProjectSummary, "id" | "name" | "path">[],
): Readonly<Record<string, string>> {
  const byName = new Map<string, typeof projects[number][]>();
  for (const p of projects) {
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }
  const hints: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const segs = group.map((p) => p.path.split("/").filter((s) => s.length > 0));
    type Suffix = { count: number; children: Map<string, Suffix> };
    const root: Suffix = { count: 0, children: new Map() };
    // Segment keys stay small. Unique basenames stop at the first node even
    // when two other paths share a deep tail; no repeated whole-suffix hashes.
    for (const path of segs) {
      let node = root;
      for (let at = path.length - 1; at >= 0; at--) {
        const segment = path[at]!;
        let child = node.children.get(segment);
        if (child === undefined) { child = { count: 0, children: new Map() }; node.children.set(segment, child); }
        child.count++; node = child;
      }
    }
    for (let index = 0; index < group.length; index++) {
      const own = segs[index]!;
      let node = root, take = 0;
      while (take < own.length) {
        node = node.children.get(own[own.length - 1 - take]!)!;
        take++;
        if (node.count === 1) break;
      }
      hints[group[index]!.id] = own.slice(own.length - take).join("/");
    }
  }
  return hints;
}

/**
 * The last two path segments — enough to recognise the folder without
 * the home-directory sentence. The full path stays on the element's title.
 */
export function folderTail(path: string): string {
  const parts = path.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return path;
  if (parts.length === 1) return parts[0]!;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}
