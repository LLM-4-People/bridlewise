/**
 * Auto-checks routes — backed by the SQLite projection.
 *
 * Auto-checks are quality/validation checks runnable per project and
 * per chat. Each check has a name, status (running/passed/failed/
 * warning), and a JSON output payload.
 *
 * Routes:
 * POST /api/projects/:id/auto-checks — run/register an auto-check
 * GET /api/projects/:id/auto-checks — list auto-checks for a project
 * GET /api/chats/:id/auto-checks — list auto-checks for a chat
 *
 * `POST` is intentionally generic: it accepts a check name, optional
 * status (defaults to `running`), and optional output. When the
 * quality-pack runtime is admitted, this endpoint will trigger a real
 * check; for now it persists the registered record so the UI can show
 * the surface and the data flow.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { AUTO_CHECK_CREATE_SCHEMA } from "../../shared/input-schemas.ts";
import { assertValidBody } from "../router/validate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { autoCheckToView } from "./views.ts";
import { isRunnableCheck, runAutoCheck } from "../awareness/auto-check-runner.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { NotFoundError } from "../kernel/errors.ts";

// `AUTO_CHECK_CREATE_SCHEMA` is the single wire-input owner
// (shared/input-schemas.ts); the route imports it for request-body
// validation. The prior local `z.strictObject({...})` copy is removed
// (a drift class).

// (No Scattered Helpers): the ad-hoc `notFound(ctx, what)` helper
// that was duplicated here AND in routes/chats.ts is removed. Routes THROW
// `NotFoundError` and the router's centralized error mapping produces the
// 404 `{ error: "not_found", message }` body. One owner for error mapping
// (server/router.ts), not a copy per route.

// Single-Party-Owner: the caller-gated `projectBelongsToUser` +
// unscoped `getProject`/`getChat` dance is replaced by the scoped DB
// getters `getProject(id, userId)` / `getChat(id, userId)` — null → 404.
// The child methods (`listAutoChecksBy*`, `createAutoCheck`) are ALSO
// scoped by userId, so a forgotten gate returns empty / throws, never
// another user's data.

// ── Route registration ──

export function registerAutoCheckRoutes(router: Router, db: AsyncDbClient): void {
  router.post("/api/projects/:id/auto-checks", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectId = ctx.params["id"]!;
    // v12 + Single-Party-Owner: getProject(id, userId) enforces the scoping
    // — only the project's owner can run checks on it (null → 404).
    const project = await db.getProject(projectId, user.userId);
    if (project === null) throw new NotFoundError(`Project ${projectId} not found`);
    const input = assertValidBody(AUTO_CHECK_CREATE_SCHEMA, ctx.body, "invalid_auto_check_input");
    // when the check name is a runnable built-in (typecheck/lint),
    // execute the REAL check against the project path and persist a
    // COMPLETED record (not a "running" stub that never finishes). The
    // route handler is async (the router awaits it) because lint awaits
    // the off-thread repository-map build (502 wedge fix) before scoring.
    if (isRunnableCheck(input.checkName)) {
      const outcome = await runAutoCheck(input.checkName, project.path);
      const row = await db.createAutoCheck(
        {
          project_id: projectId,
          check_name: input.checkName,
          status: outcome.status,
          output: outcome.output,
          ...(input.chatId !== undefined ? { chat_id: input.chatId } : {}),
        },
        user.userId,
      );
      sendJson(ctx.res, autoCheckToView(row), 201);
      return;
    }
    // Generic path: register the check with the caller-supplied status
    // (used by custom checks the runner does not own).
    const row = await db.createAutoCheck(
      {
        project_id: projectId,
        check_name: input.checkName,
        status: input.status ?? "running",
        output: input.output ?? {},
        ...(input.chatId !== undefined ? { chat_id: input.chatId } : {}),
      },
      user.userId,
    );
    sendJson(ctx.res, autoCheckToView(row), 201);
  });

  router.get("/api/projects/:id/auto-checks", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectId = ctx.params["id"]!;
    if (await db.getProject(projectId, user.userId) === null) throw new NotFoundError(`Project ${projectId} not found`);
    const rows = await db.listAutoChecksByProject(projectId, user.userId);
    sendJson(ctx.res, rows.map(autoCheckToView));
  });

  router.get("/api/chats/:id/auto-checks", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const chatId = ctx.params["id"]!;
    // v12 + Single-Party-Owner: getChat(id, userId) resolves the
    // chat→project→user ownership at the DB layer (null → 404); the child
    // listAutoChecksByChat is ALSO scoped by userId (defense-in-depth).
    if (await db.getChat(chatId, user.userId) === null) throw new NotFoundError(`Chat ${chatId} not found`);
    const rows = await db.listAutoChecksByChat(chatId, user.userId);
    sendJson(ctx.res, rows.map(autoCheckToView));
  });
}
