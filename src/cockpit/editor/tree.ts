/**
 * THE FOLDER STRUCTURE — pure data.
 *
 * Decoding and arithmetic over `/api/filesystem/tree`'s wire shape: no
 * fetching, no stores, no DOM, so the whole of "what the tree shows and in
 * what order" is testable in Node.
 *
 * The wire is decoded DEFENSIVELY — a malformed payload becomes `null`, which
 * the room renders as an honest absence. A partially-guessed list of file
 * names would be fabricated data about the user's own disk, which is exactly
 * the kind of lie this product exists to not tell.
 *
 * LAZY BY DIRECTORY. The route lists the direct children of one directory when
 * asked (`dir=`), so the room holds one load per directory rather than one
 * walk of the whole repository. A tree that pre-walked a large project would
 * either freeze the server or silently truncate — and a silently truncated
 * tree is a tree that lies about what is on disk.
 */

export type TreeEntry = Readonly<{
  name: string;
  /** Absolute path — the identity the editor API is called with. */
  path: string;
  /** Path relative to the project root — the tree's own identity. */
  relativePath: string;
  type: "file" | "directory";
  size: number;
  extension: string | null;
  lineCount: number | null;
}>;

export type TreeWire = Readonly<{
  root: string;
  entryCount: number;
  entries: readonly TreeEntry[];
}>;

/** Decode a tree payload, or `null` when the shape is not honest. */
export function decodeTree(wire: unknown): TreeWire | null {
  if (wire === null || typeof wire !== "object") return null;
  const w = wire as Record<string, unknown>;
  if (typeof w.root !== "string" || !Array.isArray(w.entries)) return null;
  for (const e of w.entries) {
    if (e === null || typeof e !== "object") return null;
    const entry = e as Record<string, unknown>;
    if (typeof entry.name !== "string") return null;
    if (typeof entry.path !== "string" || typeof entry.relativePath !== "string") return null;
    if (entry.type !== "file" && entry.type !== "directory") return null;
    if (typeof entry.size !== "number") return null;
  }
  return wire as TreeWire;
}

/**
 * Reading order for one directory's children: folders first, then files, each
 * group by name, case-insensitively.
 *
 * The server sorts by name across both kinds, which interleaves them — a
 * folder called `zebra` lands below a file called `app.ts` and the shape of
 * the directory is no longer visible at a glance. Kind-then-name is the order
 * every file manager uses because it matches how a directory is actually read.
 */
export function sortEntries(entries: readonly TreeEntry[]): readonly TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** How deep a relative path sits (the root's own children are depth 0). */
export function depthOf(relativePath: string): number {
  if (relativePath.length === 0) return -1;
  return relativePath.split("/").length - 1;
}

/** The directory a relative path lives in (`""` for a root-level entry). */
export function parentOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut === -1 ? "" : relativePath.slice(0, cut);
}

/** Every ancestor directory of a relative path, outermost first. Used to open
 * the tree down to a file the room was asked to reveal. */
export function ancestorsOf(relativePath: string): readonly string[] {
  const parts = relativePath.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("/"));
  return out;
}

// ── What one directory's load is ─────────────────────────────────────────

export type DirLoad =
  | Readonly<{ kind: "unread" }>
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "read"; entries: readonly TreeEntry[]; truncated: boolean }>
  | Readonly<{ kind: "absent"; reason: string }>;

/**
 * THE ROWS ON SCREEN — the flattened, ordered list the tree renders.
 *
 * Derived from the loads plus the open set, so what is visible is a pure
 * function of what has been measured and what the user opened. Nothing in the
 * list is invented: a directory that has not been read contributes only itself
 * (with its own honest state), never a guessed child.
 */
export type TreeRow = Readonly<{
  entry: TreeEntry;
  depth: number;
  open: boolean;
  /** For a directory: the state of ITS OWN children load. */
  load: DirLoad;
}>;

export function buildRows(
  loads: ReadonlyMap<string, DirLoad>,
  open: ReadonlySet<string>,
): readonly TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const load = loads.get(dir);
    if (load === undefined || load.kind !== "read") return;
    for (const entry of sortEntries(load.entries)) {
      const isOpen = entry.type === "directory" && open.has(entry.relativePath);
      out.push({
        entry,
        depth,
        open: isOpen,
        load: loads.get(entry.relativePath) ?? { kind: "unread" },
      });
      if (isOpen) walk(entry.relativePath, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/**
 * The honest sentence for a directory that was read and held nothing.
 *
 * The tree route hides dotfiles and a fixed set of build directories, so
 * "empty" and "empty apart from what this room does not list" are different
 * facts and only one of them is ours to claim. The sentence states the rule
 * rather than asserting the directory is bare.
 */
export const EMPTY_DIR_SENTENCE =
  "this folder is empty — nothing in it apart from hidden entries and build folders, which this tree does not list";

/** The count line under a directory's rows, from measured numbers only. */
export function dirSummary(entries: readonly TreeEntry[]): string {
  const folders = entries.filter((e) => e.type === "directory").length;
  const files = entries.length - folders;
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
