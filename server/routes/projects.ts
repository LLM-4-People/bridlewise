/**
 * Project routes — backed by the SQLite projection (server/db).
 *
 * Routes:
 * GET /api/projects — list all projects
 * POST /api/projects — create a project (201)
 * GET /api/projects/:id — get a project by id (404 if missing)
 * DELETE /api/projects/:id — delete a project (200) (404 if missing)
 *
 * The DB is the durable record; the in-memory Map is gone. The route
 * handler converts DB rows to client views via `./views.ts` before
 * sending. Validation is enforced by the database layer (Zod input schemas).
 */

import { resolve } from "node:path";

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { PROJECT_CREATE_SCHEMA, PROJECT_UPDATE_SCHEMA } from "../../shared/input-schemas.ts";
import { assertValidBody } from "../router/validate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { chatToView, projectToView } from "./views.ts";
import { serverConfig } from "../kernel/config.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { NotFoundError, BadRequestError } from "../kernel/errors.ts";
import { isWithinAllowedRoots, makeFsGate, projectFolderPresence, projectRootRefusals } from "../filesystem/fs-gate.ts";
// The harness owns every question about where a path really points.
import { resolveLocation } from "../kernel/canonical.ts";
import { invalidateProjectCache, beginIndexingIfConfigured } from "../intelligence/intelligence-bridge.ts";
import { invalidateAwarenessCache } from "../awareness/awareness-bridge.ts";
import { recordRemoval } from "../observability/timeline-bridge.ts";

// `PROJECT_CREATE_SCHEMA` is the single wire-input owner (shared/input-
// schemas.ts); the route imports it for request-body validation. The
// prior local `z.strictObject({...})` copy is removed (a drift class — a
// field added in one place without the other would silently break the
// wire). `PROJECT_UPDATE_SCHEMA` (the PATCH body: name, path, or both)
// lives beside it in the same owner.

// ── Path validation ──

/** Validate a project path: normalize, reject forbidden dirs, enforce allowed roots. */
function validateProjectPath(rawPath: string): { valid: true; resolved: string } | { valid: false; error: string } {
  // Reject null bytes (injection guard).
  if (rawPath.includes("\0")) {
    return { valid: false, error: "Path contains invalid characters (null bytes)." };
  }
  // RESOLVED, NOT MERELY NORMALISED, and resolved by the harness's own
  // resolver rather than by a second implementation here.
  //
  // `resolve` is pure string arithmetic: it collapses `.` and `..` and stops.
  // So `/tmp/link` where `link` points at `/etc` walked past the list below
  // entirely — the same spelling-versus-location defect the guardian floor was
  // fixed for, still live in the code that decides which directory becomes the
  // project. `resolveLocation` follows the links, and it resolves the DEEPEST
  // EXISTING ANCESTOR so a path that does not exist yet is still answered: a
  // project directory may legitimately be registered before it is created, and
  // a missing tail cannot contain a link because it does not exist.
  let resolved: string;
  try {
    resolved = resolveLocation(resolve(rawPath), "project path");
  } catch (err) {
    return { valid: false, error: `Path '${rawPath}' cannot be used as a project folder: ${err instanceof Error ? err.message : String(err)}` };
  }
  // If allowed roots are configured, the path must be under one of them.
  // The allowed-roots check has ONE owner (`isWithinAllowedRoots` in
  // fs-gate.ts) — the route delegates to it instead of re-implementing the
  // lexical root check (No Scattered Helpers). When no roots are configured
  // (default dev), `isWithinAllowedRoots` returns true for every absolute
  // path, so the gate is a no-op.
  if (!isWithinAllowedRoots(resolved)) {
    return { valid: false, error: `Path '${resolved}' is not under any allowed root. Allowed roots: ${serverConfig.allowedProjectRoots.join(", ")}` };
  }
  // System folders, the harness, and the ONE keep-out list (credential
  // stores of every home, keys, registered harness stores, the server's own
  // files) — by identity. The picker already marks these folders; this is the
  // write door so a POST that bypasses the picker is still refused.
  const refusal = projectRootRefusals()(resolved);
  if (refusal !== null) {
    return { valid: false, error: refusal };
  }
  return { valid: true, resolved };
}

// ── Route registration ──

export function registerProjectRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/projects", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const rows = await db.listProjects(user.userId);
    // The list view does NOT fetch per-project git status. The prior code
    // called `getProjectGitStatus(row.path, gate)` for every project — a
    // git subprocess per project — which made `GET /api/projects` scale as
    // O(n) subprocess spawns (~600ms for 87 projects). The client-side
    // `ProjectSummary` type has no `git` field, so the work was entirely
    // discarded at the boundary. Git status is fetched on demand by the
    // Git tab via the dedicated `GET /api/git/status` endpoint (one
    // project, one subprocess, only when the user opens Git). The
    // `projectToViewWithGit` mapper + the `ProjectView.git` field remain
    // available for any future consumer that wants the augmented view.
    const views = rows.map((row) => projectToView(row));
    sendJson(ctx.res, views);
  });

  router.post("/api/projects", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const input = assertValidBody(PROJECT_CREATE_SCHEMA, ctx.body, "invalid_project_input");
    // FIX: validate the project path — reject system directories,
    // null bytes, and paths outside configured allowed roots.
    const pathCheck = validateProjectPath(input.path);
    if (!pathCheck.valid) {
      throw new BadRequestError(pathCheck.error, "invalid_path");
    }
    const row = await db.createProject({ name: input.name, path: pathCheck.resolved }, user.userId);
    const indexGate = await makeFsGate(user.userId, db, pathCheck.resolved);
    beginIndexingIfConfigured(pathCheck.resolved, indexGate);
    sendJson(ctx.res, projectToView(row), 201);
  });

  router.get("/api/projects/:id", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const id = ctx.params["id"]!;
    // v12 + Single-Party-Owner: getProject(id, userId) enforces the scoping
    // at the DB layer — User B cannot GET User A's project by ID (null → 404).
    const row = await db.getProject(id, user.userId);
    if (row === null) {
      throw new NotFoundError(`Project ${id} not found`);
    }
    const indexGate = await makeFsGate(user.userId, db, row.path);
    beginIndexingIfConfigured(row.path, indexGate);
    sendJson(ctx.res, projectToView(row));
  });

  router.patch("/api/projects/:id", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const id = ctx.params["id"]!;
    const input = assertValidBody(PROJECT_UPDATE_SCHEMA, ctx.body, "invalid_project_input");
    // A path update RE-LINKS the project to another folder — the way out of
    // a wiped project folder. It goes through the same validation as
    // creation (one owner: `validateProjectPath`), plus one rule creation
    // cannot have: the folder must actually be there and readable. Re-pointing
    // a project at a folder that does not exist would re-create the exact
    // state this verb exists to end.
    let resolvedPath: string | undefined;
    if (input.path !== undefined) {
      const pathCheck = validateProjectPath(input.path);
      if (!pathCheck.valid) {
        throw new BadRequestError(pathCheck.error, "invalid_path");
      }
      const presence = projectFolderPresence(pathCheck.resolved);
      if (presence !== "present") {
        throw new BadRequestError(
          presence === "missing"
            ? `There is no folder at '${pathCheck.resolved}' on this machine.`
            : `The folder at '${pathCheck.resolved}' is not readable.`,
          "invalid_path",
        );
      }
      resolvedPath = pathCheck.resolved;
    }
    // Multi-user isolation: updateProject(id, …, userId) scopes the
    // UPDATE by user_id — a non-owned update affects 0 rows → null → 404.
    const row = await db.updateProject(
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
      },
      user.userId,
    );
    if (row === null) {
      throw new NotFoundError(`Project ${id} not found`);
    }
    // The path is a cache key for the in-memory intelligence/awareness maps
    // (keyed by project path). A re-link leaves the OLD path's entries
    // answering for a project that no longer lives there — same staleness the
    // delete path invalidates for, reached through a different verb.
    if (resolvedPath !== undefined) {
      const cacheGate = await makeFsGate(user.userId, db, resolvedPath);
      invalidateProjectCache(resolvedPath, cacheGate);
      invalidateAwarenessCache(resolvedPath, cacheGate);
      beginIndexingIfConfigured(resolvedPath, cacheGate);
    }
    sendJson(ctx.res, projectToView(row));
  });

  router.delete("/api/projects/:id", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const id = ctx.params["id"]!;
    // Resolve the project path BEFORE trashing so the in-memory caches
    // (intelligence mapCache, awareness snapshotCache) keyed by project
    // path can be invalidated after live lists hide the row. Without this,
    // a binned project's cached intelligence/awareness data lingers — a
    // new project created at the same path would see stale data until the
    // mtime-based staleness check fires. Restore rebuilds them.
    const project = await db.getProject(id, user.userId);
    // Both reads are scoped by `user.userId`, so a project this user does not
    // own is already indistinguishable from one that does not exist. Answering
    // that here rather than after the trash write is the same 404 by the same
    // route, and it lets the ownership gate below be built while the live row
    // is still visible to getProject.
    if (project === null) {
      throw new NotFoundError(`Project ${id} not found`);
    }
    // THE GATE IS BUILT WHILE THE LIVE ROW IS STILL VISIBLE. After
    // `trashed_at` is set, getProjectByPath no longer sees this project
    // (listProjects hides it), so `makeFsGate` would deny. A gate holds
    // the decisions it resolved at construction, so building it here carries
    // the ownership fact past the hide.
    const cacheGate = await makeFsGate(user.userId, db, project.path);
    // v12 + Single-Party-Owner: deleteProject(id, userId) scopes the trash
    // write by user_id — User B cannot bin User A's project (0 rows → 404).
    const existed = await db.deleteProject(id, user.userId);
    if (!existed) {
      throw new NotFoundError(`Project ${id} not found`);
    }
    // The row stays. Conversations stay with it, hidden because the project
    // is. This records that the user moved it to the recycle bin — not that
    // the conversation record was destroyed.
    recordRemoval("project", { id });
    // Invalidate the in-memory caches for the binned project's path so a
    // new project at the same path does not inherit stale intelligence or
    // awareness data. The caches are keyed by the resolved project path.
    invalidateProjectCache(project.path, cacheGate);
    invalidateAwarenessCache(project.path, cacheGate);
    sendJson(ctx.res, { deleted: true, id });
  });

  router.post("/api/projects/:id/restore", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const id = ctx.params["id"]!;
    const row = await db.restoreProject(id, user.userId);
    if (row === null) throw new NotFoundError(`Project ${id} not found`);
    const indexGate = await makeFsGate(user.userId, db, row.path);
    beginIndexingIfConfigured(row.path, indexGate);
    sendJson(ctx.res, projectToView(row));
  });

  router.get("/api/trash", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const trash = await db.listTrash(user.userId);
    sendJson(ctx.res, {
      projects: trash.projects.map(projectToView),
      chats: trash.chats.map(chatToView),
    });
  });
}
