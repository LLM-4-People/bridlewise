/**
 * Extensions routes — list configured extensions and manifest info.
 *
 * Routes:
 * GET /api/extensions — list extensions
 * GET /api/extensions/types — available extension types
 * GET /api/extensions/info — manifest info (schema version, types, statuses)
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { listExtensions, getExtensionTypes, getExtensionStatuses, getExtensionManifestInfo } from "../integrations/extensions-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerExtensionRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/extensions", async (ctx) => {
    await requireUserContext(ctx, db);
    const extensions = listExtensions();
    sendJson(ctx.res, { count: extensions.length, extensions });
  });

  router.get("/api/extensions/types", async (ctx) => {
    await requireUserContext(ctx, db);
    const types = getExtensionTypes();
    const statuses = getExtensionStatuses();
    sendJson(ctx.res, { types, statuses });
  });

  router.get("/api/extensions/info", async (ctx) => {
    await requireUserContext(ctx, db);
    const info = getExtensionManifestInfo();
    sendJson(ctx.res, info);
  });
}
