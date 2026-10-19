/**
 * Filesystem access gate — the SINGLE owner of filesystem access control
 * for the web UI server (Single-Party-Owner ).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default"): FILESYSTEM access (read, write, edit, delete, tree, search)
 * must have ONE owner module. ALL project-scoped filesystem operations go
 * through this gate — no route or bridge accesses the filesystem for a
 * project path without going through it. The gate enforces three
 * independent gates at the LOWEST possible level (the choke point where
 * every filesystem path converges), so a route or bridge that forgets a
 * check cannot leak:
 *
 * 1. PROJECT-OWNERSHIP (deny-by-default): the authenticated user MUST
 * own a project at the supplied path. Verified via
 * `db.getProjectByPath(path, userId)` (the DB-layer ownership probe).
 * Without this, User B could pass User A's project path and
 * read/write/edit/delete A's files + query A's git/graph/awareness/
 * quality — a CRITICAL cross-user filesystem + intelligence leak.
 * This gate was previously in each route (`requireProjectByPath`,
 * ); moves it to the BRIDGE (the lowest level) so a
 * route that forgets to pass the gate cannot leak (the bridge
 * enforces it when the gate is provided).
 *
 * 2. PATH-TRAVERSAL prevention (CWE-22): a file path is resolved to
 * absolute form and verified to be within the project root. No `..`
 * escape, no null bytes, no absolute path outside the root. This
 * consolidates the three previously-scattered path-traversal
 * helpers (`isWithinRoot` in project-context.ts, `safeResolve` in
 * tool-executor.ts, the inline `resolve` + `startsWith` in
 * file-tree.ts) into ONE owner (No Scattered Helpers).
 *
 * 3. ALLOWED-ROOTS (deny-by-default): for the folder picker (browsing
 * the server filesystem BEFORE a project exists), a path must be
 * within the configured `allowedProjectRoots`. When no roots are
 * configured (default dev), browsing is unrestricted. This
 * consolidates `isWithinAllowedRoots` from routes/filesystem.ts.
 *
 * The gate is OPT-IN per call (`gate?: FsGate`). Routes that accept a
 * USER-SUPPLIED project path MUST pass the gate (the mechanical test
 * `tests/prevention/filesystem-owner.test.ts` verifies every such route
 * passes it). Callers that use a SERVER-VERIFIED path (the run route
 * binds `projectPath` from `db.getProject(id, userId)` at run-start; the
 * tool-executor inherits it) MAY omit the gate — ownership is already
 * enforced at the authoritative binding point (run-start), which is the
 * lowest level for THAT path. This keeps the gate at the choke point for
 * untrusted (user-supplied) paths without forcing a redundant DB query on
 * every LLM file-tool call (the project is verified once at run-start).
 *
 * Web research (Kagi — -07-23): OWASP A01:2025 "Broken Access
 * Control" — "Except for public resources, deny by default. Implement
 * access control mechanisms once and reuse them throughout the
 * application." OWASP Path Traversal (CWE-22) — resolve + verify within
 * the allowed root. This module IS that single reuse point.
 *
 * No new deps (node:path + node:fs only). No `throw new Error`
 *.
 */
import { resolve, isAbsolute } from "node:path";
import { statSync } from "node:fs";
// The harness owns every question about where a path really points; asking it
// here is what keeps this gate and the sandbox from disagreeing about a link.
import { ROOT_POLICY, resolveLocation, pathHasSecondName, identityOverlapIndex, type KeepOutQuestions, type KeepOutVerdict } from "../kernel/canonical.ts";
import { serverKeepOutPolicy } from "../safety/host-facts.ts";

import { ForbiddenError, PathTraversalError, BadRequestError, WebError, ProjectPathError } from "../kernel/errors.ts";
import { serverConfig } from "../kernel/config.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { ProjectRow } from "../db/schema.ts";

/** Admit an existing project directory before a bridge consults a cache or
 * starts a scan. Shared by intelligence and awareness; ownership is checked
 * by the caller first, so filesystem errors cannot disclose another user's
 * project. The scan still owns failures that occur after this admission. */
export function assertValidProjectPath(projectPath: string): void {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new ProjectPathError("Project path is empty. Re-create the project with a valid folder.", "project_path_empty");
  }
  if (projectPath.startsWith("enc:")) {
    throw new ProjectPathError(
      "Project path is a stale encrypted value (enc:…) from a previous server session. Re-create the project with the correct folder path.",
      "project_path_stale_encrypted",
    );
  }
  let isDirectory: boolean;
  try {
    isDirectory = statSync(projectPath).isDirectory();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ProjectPathError(
        `Project path does not exist on disk: ${projectPath}. Re-create the project with a valid folder.`,
        "project_path_missing",
      );
    }
    throw new ProjectPathError(
      `Project path is not accessible: ${projectPath} (${err instanceof Error ? err.message : String(err)}).`,
      "project_path_inaccessible",
    );
  }
  if (!isDirectory) {
    throw new ProjectPathError(
      `Project path is not a directory: ${projectPath}. Re-create the project with a folder path.`,
      "project_path_not_directory",
    );
  }
}

/**
 * The filesystem gate context — the authenticated user plus the ownership
 * decisions ALREADY RESOLVED for this request.
 *
 * ── Why the gate carries decisions and not a database ──
 *
 * It used to carry a synchronous database client, and `assertProjectPathOwnership`
 * issued `getProjectByPath` from inside whichever bridge was running. That is
 * the shape DESIGN-PERFORMANCE §2/L1 forbids: a decrypting query on the
 * request thread, executed one to three times per request, several call
 * frames below the route that could have asked once.
 *
 * So the DB read moved to the REQUEST BOUNDARY, where it can be awaited on the
 * read pool, and the gate carries what came back. The 51 guard call sites in
 * the bridges did not change at all — `assertProjectPathOwnership(path, gate)`
 * is still the single ownership gate, still synchronous, still throws the same
 * `ForbiddenError` with the same code. What changed is that it now consults a
 * decision instead of making one.
 *
 * ── The three states, and why "absent" is not "denied" ──
 *
 * A path maps to a row (owned), to `null` (resolved, NOT owned → 403), or it
 * is ABSENT, which means this request never resolved it. Absent is a
 * PROGRAMMING error — a bridge asked about a path the route did not prime —
 * and it is reported as one (500, `gate_path_undecided`) rather than folded
 * into the 403. Folding it in would turn "I never asked" into "you do not own
 * it", which is a fabricated answer of exactly the kind L3 exists to refuse:
 * it would look like a working access-control decision while being no decision
 * at all, and it would hide the bug behind a plausible denial.
 */
export type FsGate = Readonly<{
  readonly userId: string;
  /**
   * Ownership decisions for this request, keyed by the path EXACTLY as the
   * caller names it (the bridges pass through the caller's string, so the key
   * a bridge looks up is the key the route primed).
   */
  readonly decisions: ReadonlyMap<string, ProjectRow | null>;
}>;

/**
 * The root a filesystem request MEANS, given the root it named.
 *
 * The single owner of the "no explicit root" fallback. `editor-bridge`'s
 * `resolveAndCheckGate` gates against the RESOLVED root rather than the
 * supplied one — that is deliberate and load-bearing (omitting `root` used to
 * skip ownership entirely, letting any authenticated user read the server's
 * working directory). A caller that omits the root therefore makes the bridge
 * ask about a path the caller never named, so `makeFsGate` ALWAYS resolves
 * this one too. Both sides derive the string here, once, so they cannot
 * drift, and the fallback is never an undecided path.
 */
export function effectiveProjectRoot(projectRoot?: string): string {
  return projectRoot ?? serverConfig.projectRoot;
}

/**
 * Verify the authenticated user owns a project at `projectPath`. The
 * SINGLE ownership gate at the lowest level (the bridge choke point).
 * Throws `ForbiddenError` (HTTP 403, code `project_path_not_owned`) when
 * the path is not a project owned by the caller — the identical contract
 * the route-level `requireProjectByPath` used, now enforced at the
 * bridge so a route that forgets to pass the gate cannot leak. Returns
 * the owned project row for the bridge's use.
 *
 * Null-byte injection is rejected (defense-in-depth — the route's zod
 * schema + `requirePathQuery` already reject null bytes, but the gate is
 * the choke point so it does not assume the caller remembered).
 */
export function assertProjectPathOwnership(projectPath: string, gate: FsGate): ProjectRow {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new BadRequestError("Project path is required", "missing_path");
  }
  if (projectPath.includes("\0")) {
    throw new BadRequestError("Path contains invalid characters", "invalid_path");
  }
  if (!gate.decisions.has(projectPath)) {
    throw new WebError(
      `No ownership decision was resolved for project path '${projectPath}' on this ` +
        "request. The gate carries decisions, not a database: the route must name " +
        "every path it will ask about when it builds the gate (makeFsGate). " +
        "Refusing to answer rather than reporting a denial nobody checked.",
      "gate_path_undecided",
      false,
    );
  }
  const project = gate.decisions.get(projectPath) ?? null;
  if (project === null) {
    throw new ForbiddenError(
      `Project path '${projectPath}' is not available. Only projects you own are accessible.`,
      "project_path_not_owned",
    );
  }
  return project;
}

/**
 * Resolve `filePath` against `projectRoot` and verify it is within the
 * root (path-traversal prevention — CWE-22). Returns the absolute path.
 * Throws `PathTraversalError` (HTTP 403, code `path_traversal`) when the
 * resolved path escapes the root. The SINGLE owner of the
 * "resolve + within-root" check — replaces the scattered `isWithinRoot`
 * (project-context.ts), `safeResolve` (tool-executor.ts), and the inline
 * `resolve` + `startsWith` in file-tree.ts (No Scattered Helpers).
 *
 * Handles both relative (resolved against `projectRoot`) and absolute
 * paths. Null bytes are rejected at the choke point.
 */
export function resolveWithinProject(
  filePath: string,
  projectRoot: string,
  /** The keep-out questions of the caller's operation (a search walk asks per entry); absent: this call's own. */
  keepOut: KeepOutQuestions = projectKeepOut(projectRoot),
): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new BadRequestError("File path is required", "missing_path");
  }
  if (filePath.includes("\0")) {
    throw new BadRequestError("Path contains invalid characters", "invalid_path");
  }
  // ── RESOLVED, NOT SPELLED, AND THIS WAS A PROVEN ESCAPE ────────────────
  //
  // `resolve` is pure string arithmetic: it collapses `.`, `..` and repeated
  // separators and stops. It does not follow a symbolic link, so a link INSIDE
  // the project pointing outside it produced a path that is lexically under
  // the root and really is not. Driven end to end: a CONFINED command created
  // `<project>/out -> /etc` (the kernel permits creating it — Landlock does
  // not inspect a link's target, only what is opened through it), the sandbox
  // could not follow it, and then this UNCONFINED server followed it on the
  // model's behalf and returned the bytes. Two tool calls, both reporting
  // success, no unconfined help at any point.
  //
  // The same defect, in the same words, as the one that let a link at the
  // project's scratch folder widen an allow-rule: a decision made about a
  // SPELLING rather than about a LOCATION. It is answered the same way, by the
  // harness's own resolver — which follows links AND handles a path that does
  // not exist yet, because a write to a new file must still be gated.
  //
  // BOTH SIDES ARE RESOLVED. Resolving only the candidate would refuse every
  // path in a project whose own root is reached through a link (`/home/me/work
  // -> /data/work` is an ordinary layout), so the root goes through the same
  // resolver and the comparison is between two locations.
  const root = resolveLocation(resolve(projectRoot), "project root");
  const requested = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const abs = resolveLocation(requested, "file path");
  // INSIDE THE ROOT BY IDENTITY, not by spelling: a bind-mount alias names
  // the same place by another string (`path-identity.ts`), and the root `/`
  // needs no special case.
  if (!identityOverlapIndex().atOrUnder(abs, root)) {
    throw new PathTraversalError(
      `Path '${filePath}' is outside the project root`,
      "path_traversal",
    );
  }
  // ── THE OTHER WAY OUT, WHICH RESOLVING CANNOT SEE ──────────────────────
  //
  // Everything above compares LOCATIONS, and that is the right comparison for
  // a symbolic link because a link has a target to follow. A HARD LINK has no
  // target: it is a second directory entry for the same inode, so `realpath`
  // on it returns the hard link and every location comparison above says
  // "inside the project", truthfully. The bytes are still outside it.
  //
  // Measured before this line existed: a file outside the project, a hard link
  // to it inside, and the editor bridge returned the outside file's contents —
  // while the SYMBOLIC-link form of the identical attack was refused three
  // lines up. The harness's repository reader had refused this since it was
  // written; this gate is where the two disagreed, and one question with two
  // answers is the defect rather than the missing check.
  //
  // The verdict is the shared owner's, not a copy of it, and it applies to
  // regular files only: a directory always has two or more names, and a path
  // that does not exist yet has none, so a write to a new file is gated here
  // rather than refused.
  //
  // UNCONDITIONAL, AND THAT IS THE POINT. The owner also offers a
  // policy-gated form, and this gate used to ask that one — which meant the
  // harness's `HARNESS_REJECT_HARDLINKS` opt-out, whose subject is the
  // harness's own `cp -rl`-seeded source tree, silently answered this
  // question too. Measured: with that variable set to `0`, this gate ADMITTED
  // a hard link to a file outside the project. Whether the harness protects
  // its own bytes and whether a user's path may reach outside the user's
  // project are two invariants, and one switch must not answer both.
  if (pathHasSecondName(abs)) {
    throw new PathTraversalError(
      `Path '${filePath}' cannot be used: the file it names is also reachable from outside the project, so reading or writing it here would reach outside the project.`,
      "path_second_name",
    );
  }
  // NOTHING ON THE KEEP-OUT LIST IS PROJECT CONTENT (cred-audit CRED-F11):
  // the same list every confined spawn is held to — a harness database, a key
  // (the key home), a registered harness store of any checkout, this server's
  // own files, the credential stores of every home. Asked for EVERY file, so
  // a project registered before the project door refused such folders (one
  // at `$HOME`, one over another checkout) still never serves them.
  // A folder that merely CONTAINS an entry is still project content (its
  // listing names files; opening one of them is refused here).
  const keptOut = keepOut.verdict(abs);
  if (keptOut?.relation === "under") throw keptOutFileError(filePath, keptOut);
  return abs;
}

/**
 * The keep-out questions for ONE operation over `projectRoot`'s files (a
 * search walk, a tree listing): pass them to every {@link resolveWithinProject}
 * of the operation, so the folders it meets are measured once. A home-shaped
 * folder INSIDE the project is its content (sec-e-design M1).
 */
export function projectKeepOut(projectRoot: string): KeepOutQuestions {
  return serverKeepOutPolicy().operation({ servedProject: projectRoot });
}

/** A kept-out file, in its reader's words: the harness's own state, or someone's credentials. */
function keptOutFileError(filePath: string, verdict: KeepOutVerdict): PathTraversalError {
  const source = verdict.entry.source;
  if (source === "home" || source === "operator") {
    return new PathTraversalError(
      `Path '${filePath}' is inside a folder that holds credentials or keys (${verdict.entry.path}), which is never read or written as project content.`,
      "path_credential_store",
    );
  }
  return new PathTraversalError(
    `Path '${filePath}' is part of the harness's own state or code (a database, a key, a ledger or its program), which is never read or written as project content.`,
    "path_harness_state",
  );
}

/**
 * Verify an absolute path is within the configured allowed project roots
 * (deny-by-default). Throws `PathTraversalError` (HTTP 403, code
 * `path_outside_roots`) when the path is outside every configured root.
 * Used by the folder picker (browsing the server filesystem BEFORE a
 * project exists — no project ownership to verify yet). When no roots are
 * configured (default dev), every absolute path is allowed (preserves the
 * existing browsing behavior).
 *
 * The SINGLE owner of the allowed-roots check — replaces
 * `isWithinAllowedRoots` from routes/filesystem.ts (No Scattered Helpers).
 * Compared by identity (`path-identity.ts`): a link inside an allowed root
 * that points outside it is outside (a spelling comparison admitted it), and
 * the resolved target is never shown to the caller.
 */
export function assertWithinAllowedRoots(absPath: string): void {
  if (!isWithinAllowedRoots(absPath)) {
    throw new PathTraversalError(
      `Path is outside the allowed browsing roots: ${absPath}`,
      "path_outside_roots",
    );
  }
}

/**
 * Boolean form of `assertWithinAllowedRoots` — returns true when the path
 * is within the configured allowed roots (or when no roots are configured,
 * the default-dev case). Kept as a separate exported helper so existing
 * callers + tests that need the boolean (not the throw) can use it. The
 * throwing form (`assertWithinAllowedRoots`) delegates here.
 */
export function isWithinAllowedRoots(absPath: string): boolean {
  const roots = serverConfig.allowedProjectRoots;
  if (roots.length === 0) return true; // no confinement configured (default dev)
  if (!isAbsolute(absPath)) return false;
  // By identity (`path-identity.ts`): an alias of an allowed root is that root.
  const identity = identityOverlapIndex();
  const place = resolveLocation(absPath, "a project path");
  return roots.some((root) => identity.atOrUnder(place, resolveLocation(resolve(root), "an allowed project root")));
}

/**
 * Why a folder cannot be a project — ONE question for the folder picker (which
 * marks such folders) and the project door (which refuses them, so a POST that
 * bypasses the picker is still refused). Build it once per request and ask it
 * per folder. Both answers are by identity (`path-identity.ts`), in both
 * directions:
 *
 *   - SYSTEM FOLDERS (`ROOT_POLICY.selfProtection.systemFolders`): never a
 *     project, whatever they are spelled as (a link to `/etc` is `/etc`).
 *   - THE HARNESS: a project root that IS this repository, sits inside it or
 *     CONTAINS it cannot be confined (an allow-rule would overlap the harness's
 *     protected code in one direction or the other).
 *   - THE ONE KEEP-OUT LIST (`keep-out.ts`, cred-audit CRED-F11): the harness's
 *     code, the credential/key/browser/history stores of every home (so a home
 *     folder, or a Windows profile on WSL, is refused: it contains them), the
 *     key home and every registered harness store of any checkout, this
 *     server's own files and the operator's additions. The server's own
 *     (unconfined) readers serve a project's files, so a project over one of
 *     these would hand it to the model without a confined process being asked.
 *
 * Returns the sentence to show, or null when the folder is usable. An
 * unresolvable path returns null — the caller already refused it at
 * `resolveLocation`.
 */
export function projectRootRefusals(): (resolvedPath: string) => string | null {
  const harness = resolveLocation(serverConfig.projectRoot, "harness root");
  const identity = identityOverlapIndex();
  // One operation for the whole listing: a folder about to become a project
  // must also not CONTAIN an install keeping its key beside its database.
  const keepOut = serverKeepOutPolicy().operation();
  const systemFolders = ROOT_POLICY.selfProtection.systemFolders.map((folder) => resolveLocation(folder, "a system folder"));
  return (resolvedPath: string): string | null => {
    let candidate;
    try {
      candidate = resolveLocation(resolvedPath, "project path");
    } catch {
      return null;
    }
    const system = systemFolders.find((folder) => identity.atOrUnder(candidate, folder));
    if (system !== undefined) {
      return `Path '${resolvedPath}' is inside ${system}, a system folder that is never a project — choose a project folder of your own.`;
    }
    if (identity.atOrUnder(candidate, harness)) {
      return `Path '${resolvedPath}' is the harness itself or a folder inside it. Landlock cannot confine a run here — choose a folder that is not the harness.`;
    }
    if (identity.atOrUnder(harness, candidate)) {
      return `Path '${resolvedPath}' contains the harness. Landlock cannot confine a run here — choose a folder that does not contain the harness.`;
    }
    const verdict = keepOut.grantVerdict(candidate);
    if (verdict === undefined) return null;
    const where = verdict.relation === "under" ? "lies inside" : "contains";
    if (verdict.entry.source === "home" || verdict.entry.source === "operator") {
      return `Path '${resolvedPath}' ${where} ${verdict.entry.path}, which holds credentials or keys — choose a folder that neither contains it nor lies inside it.`;
    }
    return `Path '${resolvedPath}' ${where} ${verdict.entry.path}, which is the harness's own state or code (a database, a key or its program) — choose a folder that neither contains it nor lies inside it.`;
  };
}

/**
 * What the server's filesystem says about a project's folder right now —
 * measured at read time, never remembered. The project record is durable;
 * the folder it points at is not (a scratch directory under /tmp does not
 * survive a reboot), so the answer is re-derived on every read rather than
 * stored beside the row, where it would go stale in exactly the case it
 * exists to report.
 */
export type ProjectFolderPresence =
  | "present"    // a readable directory
  | "missing"    // nothing is there
  | "unreadable" // something is there but it is not a directory this process can read
  ;

/**
 * The measured presence of a project folder. A stat that cannot settle the
 * question (a genuine I/O error, as opposed to the expected ENOENT/EACCES
 * the states above exist to name) reports "unreadable" — the honest answer
 * a caller can surface is "we could not read it", never a guessed absence.
 */
export function projectFolderPresence(path: string): ProjectFolderPresence {
  try {
    const st = statSync(path);
    return st.isDirectory() ? "present" : "unreadable";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unreadable";
  }
}

/**
 * Build a gate by RESOLVING, once and off the request thread, whether this
 * user owns a project at each path this request will touch.
 *
 * Routes call it after `requireUserContext`, naming the path(s) they are about
 * to hand to a bridge:
 * `const gate = await makeFsGate(user.userId, db, projectPath)`.
 *
 * Naming the paths is the price of the gate no longer holding a database, and
 * it is a price worth paying twice over: the ownership query is
 * `getProjectByPath`, which lists and decrypts the user's projects, and a
 * single request used to pay for it up to three times on the event loop.
 * Duplicate and empty paths are dropped, so priming the same root twice costs
 * one query.
 */
export async function makeFsGate(
  userId: string,
  db: AsyncDbClient,
  ...paths: readonly (string | undefined)[]
): Promise<FsGate> {
  // Empty and null-byte paths are NOT primed: `assertProjectPathOwnership`
  // rejects both before it ever consults a decision, and priming them would
  // send a path the gate already refuses into a DB query.
  //
  // The DEFAULT project root is always resolved, whether or not the caller
  // named it, because a bridge asked for a file with no explicit root gates
  // against it (see `effectiveProjectRoot`). Without this, omitting the root
  // would turn a 403 into a 500 — refusing for the wrong reason, which is
  // still a refusal but is no longer an access-control answer.
  const wanted = [
    ...new Set(
      [...paths, effectiveProjectRoot()].filter(
        (p): p is string => typeof p === "string" && p.length > 0 && !p.includes("\0"),
      ),
    ),
  ];
  const resolved = await Promise.all(
    wanted.map(async (path) => [path, await db.getProjectByPath(path, userId)] as const),
  );
  return { userId, decisions: new Map(resolved) };
}
