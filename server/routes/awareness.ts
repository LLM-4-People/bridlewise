/**
 * Awareness routes — codebase awareness signals (complexity, clones,
 * drift, entropy, hotspots, risk, etc.) computed over a real project.
 *
 * Routes:
 * GET /api/awareness?path=<project> — awareness summary
 * GET /api/awareness/full?path=<project> — full awareness snapshot
 * POST /api/awareness/invalidate — invalidate cache
 *
 * (filesystem access owner): project-ownership is enforced at the
 * BRIDGE (awareness-bridge.ts via server/fs-gate.ts), NOT in the route.
 * The route resolves the authenticated user + passes the `FsGate` to the
 * bridge; the bridge calls `assertProjectPathOwnership` at the choke
 * point. The per-route `requireProjectByPath` is removed.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { getAwarenessSummary, getAwarenessSnapshot, invalidateAwarenessCache } from "../awareness/awareness-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate } from "../filesystem/fs-gate.ts";
import { requirePathQuery } from "../router/validate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerAwarenessRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/awareness", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const summary = getAwarenessSummary(projectPath, gate);
    sendJson(ctx.res, summary);
  });

  router.get("/api/awareness/full", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const snapshot = getAwarenessSnapshot(projectPath, gate);
    sendJson(ctx.res, snapshot);
  });

  router.post("/api/awareness/invalidate", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    invalidateAwarenessCache(projectPath, gate);
    sendJson(ctx.res, { ok: true, path: projectPath });
  });
}
