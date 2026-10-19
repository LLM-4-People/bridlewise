/**
 * Quality routes — codebase quality indicator and recommendations.
 *
 * Routes:
 * GET /api/quality?path=<project> — quality indicator (score, grade, issues, recommendations)
 *
 * (filesystem access owner): project-ownership is enforced at the
 * BRIDGE (quality-bridge.ts via server/fs-gate.ts), NOT in the route.
 * The route resolves the authenticated user + passes the `FsGate` to the
 * bridge; the bridge calls `assertProjectPathOwnership` at the choke
 * point. The per-route `requireProjectByPath` is removed.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { getQualityIndicatorAsync } from "../awareness/quality-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate } from "../filesystem/fs-gate.ts";
import { requirePathQuery } from "../router/validate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerQualityRoutes(router: Router, db: AsyncDbClient): void {
  // Async handler (the router awaits it): the quality compute (awareness
  // engine + repo map) runs in worker threads OFF the event loop; awaiting
  // them yields the event loop so HTTP requests stay served (502 wedge
  // fix — the previous sync `engine.compute` wedged the server on a
  // large codebase).
  router.get("/api/quality", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const indicator = await getQualityIndicatorAsync(projectPath, gate);
    sendJson(ctx.res, indicator);
  });
}
