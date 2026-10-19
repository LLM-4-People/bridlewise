/**
 * THE FOLDER PICKER — pure state machine, no DOM and no fetch.
 *
 * The picker's model is a FLAT LIST of visible rows derived from three
 * things: which path the listing is anchored at, which directories are
 * expanded, and what each directory's read returned. Deriving the visible
 * list from state (rather than mutating a nested tree of nodes) is what
 * makes keyboard navigation, expansion, and re-reads all testable as pure
 * functions — and it is the same derivation shape the editor's file tree
 * uses (`src/cockpit/editor/tree.ts`), so the two trees in the product
 * behave alike.
 *
 * WHAT IS NEVER INVENTED. A directory that has not been read contributes
 * only itself; a directory that could not be read (gone, refused, outside
 * the allowed roots) carries the refusal's own words; the only paths the
 * machine can ever name are paths a server answer carried. The state
 * machine cannot spell a path the server did not say.
 */

/** One child directory, as the list route reports it. */
export type PickerEntry = Readonly<{
  readonly name: string;
  readonly path: string;
  readonly accessible: boolean;
  /** Why this folder cannot be a project, when Landlock would refuse it. */
  readonly restriction?: string;
}>;

/** What one directory's read came back as. */
export type PickerListing = Readonly<{
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly PickerEntry[];
  readonly accessible: boolean;
  /** Why the folder the picker is standing on cannot be a project. */
  readonly restriction?: string;
}>;

/**
 * What one directory's read IS — known good, known refused, or in flight.
 * A refused read keeps the refusal's words so the surface can say them;
 * it is never silently folded into "empty".
 */
export type PickerDir =
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "read"; listing: PickerListing }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * The whole of what the picker knows. `roots` is the picker's opening view
 * (the top-level choices the server allows); once the user steps into a
 * root the anchor moves and the root row set is no longer shown.
 */
export type PickerState = Readonly<{
  /** The directory whose children anchor the listing; null = the roots view. */
  readonly at: string | null;
  readonly roots: readonly PickerEntry[];
  readonly dirs: Readonly<Record<string, PickerDir>>;
  readonly expanded: ReadonlySet<string>;
  /** The folder the picker currently stands on as its answer. */
  readonly selected: string | null;
  /** Where the keyboard is, as a path; null = nothing focused yet. */
  readonly focus: string | null;
}>;

export type PickerRow =
  | Readonly<{ kind: "up"; path: string }>
  | Readonly<{
      kind: "dir";
      entry: PickerEntry;
      depth: number;
      expanded: boolean;
      state: PickerDir | null;
      /**
       * The row whose expansion listed this row, or null for a top-level
       * row. Kept ON the row so the keyboard's "step to my parent" is a
       * read, not a string prefix guess over flattened paths.
       */
      readonly parentPath: string | null;
    }>;

export function initialPickerState(roots: readonly PickerEntry[]): PickerState {
  return {
    at: null,
    roots,
    dirs: {},
    expanded: new Set<string>(),
    selected: null,
    focus: null,
  };
}

/** The row the keyboard/click walked INTO (roots view → that root). */
export function enterDirectory(state: PickerState, path: string): PickerState {
  return { ...state, at: path, focus: path };
}

/** One level up from the anchor; at a root's top this returns to the roots view. */
export function stepUp(state: PickerState): PickerState {
  const at = state.at;
  if (at === null) return state;
  const dir = state.dirs[at];
  const parent = dir !== undefined && dir.kind === "read" ? dir.listing.parent : null;
  if (parent === null || parent === at) {
    // No parent above the anchor — back to the roots view.
    return { ...state, at: null, focus: at };
  }
  return { ...state, at: parent, focus: at };
}

/** Mark a directory's read as in flight (idempotent). */
export function markReading(state: PickerState, path: string): PickerState {
  const current = state.dirs[path];
  if (current !== undefined && current.kind === "reading") return state;
  return { ...state, dirs: { ...state.dirs, [path]: { kind: "reading" } } };
}

/** A directory's read came back good. */
export function applyListing(state: PickerState, listing: PickerListing): PickerState {
  return {
    ...state,
    dirs: { ...state.dirs, [listing.path]: { kind: "read", listing } },
  };
}

/** A directory's read was refused — kept, with the refusal's own words. */
export function applyRefusal(state: PickerState, path: string, reason: string): PickerState {
  return { ...state, dirs: { ...state.dirs, [path]: { kind: "refused", reason } } };
}

/** Open or close a directory's children inline. */
export function toggleExpanded(state: PickerState, path: string): PickerState {
  const next = new Set(state.expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return { ...state, expanded: next };
}

/** Choose the folder the picker stands on as its answer. */
export function selectPath(state: PickerState, path: string): PickerState {
  return { ...state, selected: path, focus: path };
}

/** Move the keyboard focus onto a row (clamped to what is visible). */
export function focusPath(state: PickerState, path: string | null): PickerState {
  return { ...state, focus: path };
}

/**
 * Does this directory's read need to be asked for? True while the machine
 * holds no answer for it — the surface's effect keys off this so a read is
 * requested exactly once per directory per open picker (and re-asked only
 * when the answer was a refusal the user re-opened).
 */
export function needsRead(state: PickerState, path: string): boolean {
  return state.dirs[path] === undefined;
}

/**
 * The visible rows, derived. Row order is depth-first: a directory's
 * expanded children render immediately under it, and a directory with no
 * readable children (an honest refusal, an unreadable folder) shows itself
 * with its state rather than a guessed child list.
 */
export function visibleRows(state: PickerState): readonly PickerRow[] {
  const rows: PickerRow[] = [];
  if (state.at === null) {
    // The roots view: the server's allowed starting points, one row each.
    for (const entry of state.roots) {
      rows.push({ kind: "dir", entry, depth: 0, expanded: state.expanded.has(entry.path), state: state.dirs[entry.path] ?? null, parentPath: null });
      if (state.expanded.has(entry.path)) walkChildren(state, entry.path, 1, rows);
    }
    return rows;
  }
  const anchor = state.dirs[state.at];
  const anchorListing = anchor !== undefined && anchor.kind === "read" ? anchor.listing : null;
  if (anchorListing !== null && anchorListing.parent !== null) {
    rows.push({ kind: "up", path: anchorListing.parent });
  }
  if (anchorListing !== null) {
    for (const entry of anchorListing.entries) {
      rows.push({ kind: "dir", entry, depth: 0, expanded: state.expanded.has(entry.path), state: state.dirs[entry.path] ?? null, parentPath: null });
      if (state.expanded.has(entry.path)) walkChildren(state, entry.path, 1, rows);
    }
  }
  return rows;
}

function walkChildren(state: PickerState, dir: string, depth: number, rows: PickerRow[]): void {
  const d = state.dirs[dir];
  if (d === undefined || d.kind !== "read") return;
  for (const entry of d.listing.entries) {
    rows.push({ kind: "dir", entry, depth, expanded: state.expanded.has(entry.path), state: state.dirs[entry.path] ?? null, parentPath: dir });
    if (state.expanded.has(entry.path)) walkChildren(state, entry.path, depth + 1, rows);
  }
}

/**
 * The keyboard's walk — the path of the row `delta` steps from the focus,
 * clamped to the ends. Only directory rows are walkable; the up-row is a
 * verb, not a position.
 */
export function moveFocus(state: PickerState, delta: number): PickerState {
  const dirs = visibleRows(state).filter((r): r is Extract<PickerRow, { kind: "dir" }> => r.kind === "dir");
  if (dirs.length === 0) return state;
  const idx = dirs.findIndex((r) => r.entry.path === state.focus);
  const next = idx === -1 ? (delta >= 0 ? 0 : dirs.length - 1) : Math.max(0, Math.min(dirs.length - 1, idx + delta));
  return { ...state, focus: dirs[next]!.entry.path };
}

/**
 * A name for a new folder is honest only if it names ONE folder, below the
 * directory it is created in. Anything with a separator, a dot-segment or
 * an empty body is refused here, before the server is asked — and the
 * server refuses the same shapes again at its own door.
 */
export function newFolderNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "a name is needed";
  if (name === "." || name === "..") return "that name means this folder itself, not a new one";
  if (name.includes("/") || name.includes("\\")) return "a folder name cannot contain path separators";
  if (name.includes("\0")) return "a folder name cannot contain that character";
  return null;
}
