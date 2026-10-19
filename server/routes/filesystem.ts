/**
 * Filesystem routes — SERVER-SIDE directory browsing.
 *
 * The web UI runs server-side: folder selection must operate on the
 * SERVER's filesystem, not the browser's. This route lists directories at
 * a given absolute path so the client can render a navigable folder
 * picker (no `<input type="file" webkitdirectory>` — that opens the
 * browser's native picker and yields only the folder NAME, not a real
 * server path).
 *
 * Routes:
 * GET /api/filesystem/list?path=<abs> — list child directories at <abs>
 * 200 → { path, parent, entries: [{name, path, accessible, childrenCount?}] }
 * 400 → path missing / not a directory / contains null bytes
 * 404 → path does not exist
 * 500 → unexpected I/O error
 * GET /api/filesystem/roots — the default browsing roots
 * 200 → { roots: [{label, path}] }
 *
 * Security:
 * The server binds to 127.0.0.1 ONLY (enforced in server/index.ts), so
 * only local users can browse.
 * Paths are resolved to absolute form; null bytes are rejected.
 * Permission errors (EACCES) return the directory with empty entries +
 * an `accessible: false` flag rather than crashing the request.
 * Only directories are listed (files are omitted) to minimize
 * information exposure.
 */

import { readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { z } from "zod";

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { serverConfig } from "../kernel/config.ts";
import { FileSystemError, BadRequestError, NotFoundError, ConflictError } from "../kernel/errors.ts";
import { assertValidBody } from "../router/validate.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { recordEffect } from "../kernel/canonical.ts";
import { assertWithinAllowedRoots, isWithinAllowedRoots, projectRootRefusals } from "../filesystem/fs-gate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { MAX_PATH_LENGTH } from "../../shared/constants.ts";

// (filesystem access owner): the allowed-roots gate is now owned
// by `server/fs-gate.ts` (the single filesystem access owner). This route
// re-exports `isWithinAllowedRoots` for backward compatibility + uses
// `assertWithinAllowedRoots` (the throwing form) for the actual gate. The
// boolean helper + the throwing helper are the SAME owner (fs-gate.ts) —
// no scattered logic.
export { isWithinAllowedRoots };

// ── Response types ──

type DirEntry = Readonly<{
  readonly name: string;
  readonly path: string;
  readonly accessible: boolean;
  /** Why this folder cannot be a project, when Landlock would refuse it. */
  readonly restriction?: string;
}>;

type ListResponse = Readonly<{
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly DirEntry[];
  readonly accessible: boolean;
  /** Why the folder the picker is standing on cannot be a project. */
  readonly restriction?: string;
}>;

type RootEntry = Readonly<{
  readonly label: string;
  readonly path: string;
  readonly restriction?: string;
}>;

type RootsResponse = Readonly<{ readonly roots: readonly RootEntry[] }>;

// ── Helpers ──

/** Resolve and validate a path query parameter into an absolute path. */
function resolveQueryPath(rawPath: string | undefined): string | null {
  if (rawPath === undefined || rawPath === "") {
    return serverConfig.projectRoot;
  }
  if (rawPath.includes("\0")) return null; // null-byte injection guard
  try {
    const absolute = resolve(rawPath);
    return absolute;
  } catch {
    return null;
  }
}

/** Safely stat a path; returns null on permission/ENOENT errors. */
function safeStat(absPath: string): { isDir: boolean; accessible: boolean } | null {
  try {
    const st = statSync(absPath);
    return { isDir: st.isDirectory(), accessible: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    // EACCES / EPERM — exists but unreadable.
    return { isDir: true, accessible: false };
  }
}

/** Build the default browsing roots (home + server CWD). */
function buildRoots(): readonly RootEntry[] {
  const roots: RootEntry[] = [];
  const home = homedir();
  if (home.length > 0) roots.push({ label: "Home", path: home });
  roots.push({ label: "Server root", path: serverConfig.projectRoot });
  // De-duplicate by path (home == projectRoot is common in dev).
  const seen = new Set<string>();
  const refusal = projectRootRefusals();
  return roots
    .filter((r) => {
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    })
    .map((r) => {
      const restriction = refusal(r.path) ?? undefined;
      return restriction !== undefined ? { ...r, restriction } : r;
    });
}

// ── Route registration ──

export function registerFilesystemRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/filesystem/list", async (ctx) => {
    await requireUserContext(ctx, db);
    const rawPath = ctx.query.get("path");
    const abs = resolveQueryPath(rawPath ?? undefined);
    if (abs === null) {
      throw new BadRequestError("Path contains invalid characters", "invalid_path");
    }
    // Gate FIRST (deny-by-default): verify the path is within the allowed
    // browsing roots BEFORE touching the filesystem. The prior order (stat
    // then gate) leaked existence information for paths outside the roots
    // (a caller could distinguish "exists but forbidden" from "absent" via
    // the error response). The gate is the choke point — it must run before
    // any filesystem probe.
    assertWithinAllowedRoots(abs);

    const stat = safeStat(abs);
    if (stat === null) {
      throw new NotFoundError(`Path not found: ${abs}`, "not_found");
    }
    if (!stat.isDir) {
      throw new BadRequestError(`Path is not a directory: ${abs}`, "not_a_directory");
    }
    if (!stat.accessible) {
      // The directory exists but the server process cannot read it.
      const parentPath = dirname(abs);
      const parent = parentPath !== abs ? parentPath : null;
      sendJson(ctx.res, {
        path: abs,
        parent,
        entries: [],
        accessible: false,
      } satisfies ListResponse);
      return;
    }

    let names: readonly string[];
    try {
      names = readdirSync(abs, { withFileTypes: true })
        .filter((d) => {
          // Skip hidden entries (dotfiles) and only keep directories or
          // symlinks (resolved below) to minimize exposure.
          if (d.name.startsWith(".")) return false;
          return d.isDirectory();
        })
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") {
        sendJson(ctx.res, {
          path: abs,
          parent: dirname(abs) !== abs ? dirname(abs) : null,
          entries: [],
          accessible: false,
        } satisfies ListResponse);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new FileSystemError(`Cannot read directory ${abs}: ${message}`);
    }

    // Asked once per listing: the policy's paths are resolved once, then each folder.
    const refusal = projectRootRefusals();
    const entries: DirEntry[] = names.map((name) => {
      const childPath = resolve(abs, name);
      const childStat = safeStat(childPath);
      const accessible = childStat?.accessible ?? false;
      const restriction = refusal(childPath) ?? undefined;
      return restriction !== undefined
        ? { name, path: childPath, accessible, restriction }
        : { name, path: childPath, accessible };
    });

    const parentPath = dirname(abs);
    const parent = parentPath !== abs ? parentPath : null;
    const restriction = refusal(abs) ?? undefined;

    sendJson(ctx.res, {
      path: abs,
      parent,
      entries,
      accessible: true,
      ...(restriction !== undefined ? { restriction } : {}),
    } satisfies ListResponse);
  });

  router.get("/api/filesystem/roots", async (ctx) => {
    await requireUserContext(ctx, db);
    sendJson(ctx.res, { roots: buildRoots() } satisfies RootsResponse);
  });

  // ── Create a directory (easy folder creation) ──
  // The user can type a folder name in the picker and create it on the
  // server, then add it as a project. Validates the parent exists + is a
  // directory; rejects null bytes, traversal outside the parent, and
  // over-long paths. Creates with `recursive: true` so nested names work.
  const MKDIR_SCHEMA = z.strictObject({
    parent: z.string().min(1).max(MAX_PATH_LENGTH),
    name: z.string().min(1).max(128).regex(/^[^\0]+$/, "Name contains invalid characters"),
  });

  router.post("/api/filesystem/mkdir", async (ctx) => {
    await requireUserContext(ctx, db);
    const input = assertValidBody(MKDIR_SCHEMA, ctx.body, "invalid_mkdir_input");
    if (input.name.includes("/") || input.name.includes("\\") || input.name === "." || input.name === "..") {
      throw new BadRequestError("Folder name must not contain path separators.", "invalid_name");
    }
    const parentAbs = resolve(input.parent);
    // Gate FIRST (deny-by-default): verify the parent is within the allowed
    // browsing roots BEFORE touching the filesystem. The prior order (stat
    // then gate) leaked existence information for paths outside the roots.
    assertWithinAllowedRoots(parentAbs);
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
      throw new NotFoundError(`Parent directory does not exist: ${parentAbs}`, "parent_not_found");
    }
    const target = join(parentAbs, input.name);
    assertWithinAllowedRoots(target);
    if (existsSync(target)) {
      throw new ConflictError(`Folder already exists: ${target}`, "already_exists");
    }
    try {
      // RECORDING CHOKE POINT for the `filesystem` effect kind: this mkdir
      // is the one NON-PROJECT filesystem mutation the server performs (the
      // folder picker creates a directory BEFORE any project exists, so the
      // editor bridge's file-effect recording cannot attribute it to a
      // project — see the documented exemption in
      // tests/prevention/file-effect-recording.test.ts). Recording wraps the
      // mutation itself: a thrown mkdir failure records a FAILED effect and
      // rethrows unchanged into the route's error handling below.
      recordEffect("filesystem", "mkdir", () => {
        mkdirSync(target, { recursive: true });
      });
      sendJson(ctx.res, { ok: true, path: target, name: input.name });
    } catch (err) {
      // The route pre-checks all client-error cases (parent exists, name
      // valid, target absent, within roots). Reaching the catch is a genuine
      // server-side I/O failure (disk full, permission issue, race). The
      // raw OS errno is kept in the message for the operator; the code is the
      // closed harness-owned constant (no raw OS errno leaks into the typed
      // code set — the typed error codes are a closed set owned by
      // errors.ts). Mapped to 500 via CODE_STATUS_MAP (exhaustive).
      const message = err instanceof Error ? err.message : String(err);
      throw new FileSystemError(`Cannot create directory ${target}: ${message}`, "mkdir_failed");
    }
  });
}
