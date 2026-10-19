/**
 * MCP routes — the settings room's door to the configured tool servers.
 *
 * Routes:
 * GET /api/mcp/servers — configured MCP servers (the registration facts,
 *   never credential values) joined with live registry-measured status.
 * PUT /api/mcp/servers — add or edit one server registration (upsert by
 *   id). GLOBAL harness state: admin-only, the same rule the settings
 *   customizations are held to (a regular user must not change what every
 *   run connects to). The write lands through the ONE config gate
 *   (`writeConfigRaw`) after the engine's own validators had their say.
 * DELETE /api/mcp/servers/:id — remove one registration (admin-only).
 * POST /api/mcp/servers/:id/test — one real connect + tools/list against
 *   the saved registration, so a broken address or command is found before
 *   a run depends on it (the provider test precedent).
 * GET /api/mcp/info — MCP config info (defaults, limits, counts)
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { assertValidBody } from "../router/validate.ts";
import {
  listMcpServers,
  getMcpConfigInfo,
  upsertMcpServer,
  removeMcpServer,
  testMcpServer,
  MCP_SERVER_WRITE_SCHEMA,
} from "../integrations/mcp-bridge.ts";
import { requireUserContext, requireAdminContext } from "../auth/user-context.ts";
import { BadRequestError } from "../kernel/errors.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerMcpRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/mcp/servers", async (ctx) => {
    await requireUserContext(ctx, db);
    const servers = await listMcpServers();
    sendJson(ctx.res, { count: servers.length, servers });
  });

  router.get("/api/mcp/info", async (ctx) => {
    await requireUserContext(ctx, db);
    const info = getMcpConfigInfo();
    sendJson(ctx.res, info);
  });

  router.put("/api/mcp/servers", async (ctx) => {
    await requireAdminContext(ctx, db);
    // A malformed or undeclared field refuses HERE, with the field named
    // (the strict body schema lists every field the door can write).
    const body = assertValidBody(MCP_SERVER_WRITE_SCHEMA, ctx.body, "invalid_mcp_server");
    const server = upsertMcpServer(body);
    sendJson(ctx.res, { ok: true, server });
  });

  router.delete("/api/mcp/servers/:id", async (ctx) => {
    await requireAdminContext(ctx, db);
    const id = ctx.params.id;
    if (!id) {
      throw new BadRequestError("Missing server id", "missing_server_id");
    }
    removeMcpServer(id);
    sendJson(ctx.res, { ok: true, removed: id });
  });

  router.post("/api/mcp/servers/:id/test", async (ctx) => {
    await requireUserContext(ctx, db);
    const id = ctx.params.id;
    if (!id) {
      throw new BadRequestError("Missing server id", "missing_server_id");
    }
    const result = await testMcpServer(id);
    sendJson(ctx.res, result);
  });
}
