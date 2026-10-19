/**
 * File tree routes — list files (not just directories) in a project.
 * Extends the filesystem route which only lists directories for the
 * folder picker. This route lists files with metadata for a navigable
 * file tree.
 *
 * Routes:
 * GET /api/filesystem/tree?path=<project>&depth=<n>&limit=<n>&dir=<subdir>&withLineCount=1
 * 200 → { root, entries: [{name, path, relativePath, type, size, extension, lineCount}] }
 * 400 → path missing / not a directory / null bytes
 * 404 → path not found
 *
 * exp519 fixes:
 * ASYNC I/O (fs/promises): the previous synchronous readdirSync/statSync/
 * readFileSync blocked the event loop and froze the UI on large repos.
 * countLines (readFileSync of every file) was the primary freeze cause.
 * Line counting is now OPT-IN (`withLineCount=1`): the bulk tree walk only
 * stats files (fast); line counts are fetched on demand when a file is
 * opened, not for every file in the tree.
 * Depth + entry caps are configurable (serverConfig.fileTreeMaxDepth /
 * fileTreeMaxEntries) with higher defaults (10 / 2000) so the explorer is
 * not capped at 4 levels.
 * `dir` param: when set, lists the DIRECT children of that subdirectory
 * only (depth 1) — enabling lazy expansion (the client fetches children
 * on demand instead of pre-loading the whole tree).
 */

import { readdir, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, extname } from "node:path";

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { MAX_FILE_NAME_LENGTH } from "../../shared/constants.ts";
import { serverConfig } from "../kernel/config.ts";
import { FileSystemError, BadRequestError, NotFoundError, PathTraversalError } from "../kernel/errors.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate, assertProjectPathOwnership, resolveWithinProject } from "../filesystem/fs-gate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { webWarn } from "../observability/debug-bridge.ts";

type TreeEntry = Readonly<{
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
  extension: string | null;
  lineCount: number | null;
}>;

const CODE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".swift", ".kt", ".css", ".scss", ".html", ".vue", ".svelte"]);

// (No Scattered Helpers): renamed from `countLines` to `countFileLines`
// to avoid the name collision with editor-bridge's `countLines(content:
// string)` (which counts lines in a STRING, not a file). The two functions
// have different signatures + semantics — they are not the same helper, so
// the descriptive rename (not an extraction) is the correct fix.
async function countFileLines(filePath: string): Promise<number | null> {
  try {
    // Guard against OOM on huge files: stat the size BEFORE reading. A
    // large file (e.g. a minified bundle, a data file, or a compiled
    // binary with a code extension) would otherwise be read entirely
    // into memory, hanging the request or exhausting the process. The
    // `maxFileReadBytes` config (the single owner of the file-read size
    // cap, reused from the editor bridge) bounds the read; files above
    // the cap skip line counting — the tree shows the entry without a
    // line count rather than wedging the server.
    const st = await stat(filePath);
    if (st.size > serverConfig.maxFileReadBytes) return null;
    const content = await readFile(filePath, "utf8");
    return content.split("\n").length;
  } catch (err) {
    // EHC-12: a read failure (permission/ENOENT) is surfaced via the
    // centralized debug bridge — returning null is the "couldn't
    // count" signal, but the reason should be visible when debug is on.
    webWarn("file-tree", "countFileLines read failed (returning null)", () => ({ filePath, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", ".cache",
  "target", "__pycache__", ".venv", "venv", "vendor", "bin", "obj",
]);

/**
 * Walk a directory tree asynchronously (non-blocking — yields to the
 * event loop between readdir/stat calls so the server stays responsive).
 * When `dir` is provided, lists only the direct children of `dir` (one
 * level). Otherwise walks from `root` up to `maxDepth` levels deep.
 */
async function buildTree(
  root: string,
  maxDepth: number,
  maxEntries: number,
  withLineCount: boolean,
  subdir?: string,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const rootResolved = resolve(root);
  const startDir = subdir !== undefined ? resolve(root, subdir) : rootResolved;

  async function walk(dir: string, depth: number): Promise<void> {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // EHC-13: a readdir failure (permission/EACCES) is surfaced via the
      // centralized debug bridge — silently skipping the dir is
      // the graceful behavior, but the reason should be visible when debug
      // is on (not a silent swallow).
      webWarn("file-tree", "readdir failed (skipping dir)", () => ({ dir, error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    names = names
      .filter((d) => {
        if (d.name.startsWith(".") && d.name.length > 1) return false;
        if (d.isDirectory() && EXCLUDED_DIRS.has(d.name)) return false;
        if (d.name.length > MAX_FILE_NAME_LENGTH) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    for (const d of names) {
      if (entries.length >= maxEntries) return;
      const fullPath = resolve(dir, d.name);
      const rel = relative(rootResolved, fullPath);
      try {
        const st = await stat(fullPath);
        if (st.isDirectory()) {
          entries.push({ name: d.name, path: fullPath, relativePath: rel, type: "directory", size: st.size, extension: null, lineCount: null });
          // Only recurse when walking the full tree (no subdir filter).
          // Guard against symlink escape: `stat` follows symlinks, so a
          // symlinked directory in the project pointing OUTSIDE the root
          // (e.g. `proj/link -> /usr/lib`) would cause the walk to list
          // files OUTSIDE the project root through the link. The Dirent
          // from `readdir` reports the entry type WITHOUT following the
          // link (`d.isSymbolicLink()`), so skip recursion for symlinks —
          // the entry is still listed (one level), but not expanded, so a
          // symlink to an external directory does not leak its contents.
          if (subdir === undefined && !d.isSymbolicLink()) {
            await walk(fullPath, depth + 1);
          }
        } else {
          const ext = extname(d.name).toLowerCase();
          const lc = withLineCount && CODE_EXTS.has(ext) ? await countFileLines(fullPath) : null;
          entries.push({ name: d.name, path: fullPath, relativePath: rel, type: "file", size: st.size, extension: ext.length > 0 ? ext : null, lineCount: lc });
        }
      } catch (err) {
        // EHC-14: a stat/read failure on an entry is surfaced via the
        // centralized debug bridge. We still push a zero-size
        // fallback entry (graceful), but the reason is visible when debug
        // is on (not a silent swallow).
        webWarn("file-tree", "entry stat/read failed (pushing zero-size fallback)", () => ({ name: d.name, fullPath, error: err instanceof Error ? err.message : String(err) }));
        entries.push({ name: d.name, path: fullPath, relativePath: rel, type: "file", size: 0, extension: null, lineCount: null });
      }
    }
  }

  await walk(startDir, 1);
  return entries;
}

export function registerFileTreeRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/filesystem/tree", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const rawPath = ctx.query.get("path");
    if (rawPath === null || rawPath.length === 0) {
      throw new BadRequestError("Path is required", "missing_path");
    }
    if (rawPath.includes("\0")) {
      throw new BadRequestError("Path contains invalid characters", "invalid_path");
    }
    const gate = await makeFsGate(user.userId, db, rawPath);
    // (filesystem access owner): project-ownership is enforced at
    // the choke point via the fs-gate (NOT the route-level
    // requireProjectByPath). The gate carries the ownership decision the
    // request resolved on the read pool — deny-by-default. User B cannot
    // browse User A's project tree.
    assertProjectPathOwnership(rawPath, gate);
    const depthRaw = ctx.query.get("depth");
    const limitRaw = ctx.query.get("limit");
    const dirRaw = ctx.query.get("dir");
    const withLineCount = ctx.query.get("withLineCount") === "1";
    // Configurable caps: no hardcoded literals. The server
    // config is the single source of truth; the query params may lower them
    // but never exceed the configured ceiling.
    const maxDepth = depthRaw !== null
      ? Math.min(Math.max(1, parseInt(depthRaw, 10) || serverConfig.fileTreeMaxDepth), serverConfig.fileTreeMaxDepth)
      : serverConfig.fileTreeMaxDepth;
    const maxEntries = limitRaw !== null
      ? Math.min(Math.max(1, parseInt(limitRaw, 10) || serverConfig.fileTreeMaxEntries), serverConfig.fileTreeMaxEntries)
      : serverConfig.fileTreeMaxEntries;

    const abs = resolve(rawPath);
    if (!existsSync(abs)) {
      throw new NotFoundError(`Path not found: ${abs}`, "not_found");
    }
    let absStat: import("node:fs").Stats;
    try {
      absStat = await stat(abs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FileSystemError(`Cannot stat ${abs}: ${message}`);
    }
    if (!absStat.isDirectory()) {
      throw new BadRequestError(`Path is not a directory: ${abs}`, "not_a_directory");
    }
    // BUG FIX: the `dir` query param was resolved against the
    // root WITHOUT a traversal check — a caller could pass dir=../../etc
    // and list files OUTSIDE the project root. Now resolved through the
    // fs-gate's resolveWithinProject which throws PathTraversalError on
    // escape. The verified relative path is passed to buildTree.
    let verifiedSubdir: string | undefined;
    if (dirRaw !== null && dirRaw.length > 0) {
      if (dirRaw.includes("\0")) {
        throw new BadRequestError("Path contains invalid characters", "invalid_path");
      }
      // resolveWithinProject throws PathTraversalError on escape.
      resolveWithinProject(dirRaw, abs);
      verifiedSubdir = dirRaw;
    }
    try {
      const entries = await buildTree(abs, maxDepth, maxEntries, withLineCount, verifiedSubdir);
      sendJson(ctx.res, { root: abs, entryCount: entries.length, entries });
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new FileSystemError(`Cannot build tree for ${abs}: ${message}`);
    }
  });
}
