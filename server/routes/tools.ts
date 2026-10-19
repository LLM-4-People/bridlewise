/**
 * Tools route — returns the tool manifest (built-in + MCP, tagged with
 * category) and allows toggling tool enable/disable.
 *
 * Routes:
 * GET /api/tools — WebToolEntry[] (full manifest, all categories)
 * GET /api/tools/settings — per-session tool settings
 * POST /api/tools/:name/toggle — enable/disable a built-in tool
 * (writes the per-session override
 * to the DB — tools per user)
 *
 * all tools exposed through ONE API endpoint. 
 * 38: everything configurable from the web — tool enable/disable is persisted
 * per session so each user has their own tool set, like
 * projects/chats. The global config's `tools.enabled` list remains the
 * DEFAULT; per-session DB rows are OVERRIDES (a user disabling a tool does
 * not affect other users).
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { effectiveEnabledToolNames, getToolManifest, invalidateToolManifestCache } from "../tools/tools-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { NotFoundError } from "../kernel/errors.ts";

export function registerToolRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/tools", async (ctx) => {
    await requireUserContext(ctx, db);
    const manifest = getToolManifest();
    sendJson(ctx.res, manifest);
  });

  // ── Per-user tool settings (v12: tools per user) ──
  // Returns the user's tool overrides (enabled/disabled per tool) AND the
  // effective enabled list, merged HERE by the one merge owner
  // (`effectiveEnabledToolNames`): the browser used to recompute it and
  // ignored the global `tools.enabled` list (CFG-0 B1). Loaded on page boot
  // so the Tools panel reflects the user's saved preferences.
  router.get("/api/tools/settings", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const rows = await db.listToolSettings(user.userId);
    sendJson(ctx.res, {
      // A compact { toolName, enabled, config } shape for the client.
      settings: rows.map((r) => ({ toolName: r.tool_name, enabled: r.enabled, config: r.config })),
      enabledList: effectiveEnabledToolNames(new Map(rows.map((r) => [r.tool_name, r.enabled] as const))),
    });
  });

  // ── Tool enable/disable (writes the per-user override to the DB) ──
  // v12: the toggle persists per-user (one user disabling a tool does not
  // affect other users). The global config's `tools.enabled` list remains
  // the default; this DB row is the override. The manifest cache is
  // invalidated so the next run reflects the new state immediately.
  router.post("/api/tools/:name/toggle", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const toolName = ctx.params["name"]!;
    const manifest = getToolManifest();
    // The tool must exist in the manifest (no toggling unknown tools).
    const exists = manifest.some((t) => t.name === toolName);
    if (!exists) {
      throw new NotFoundError(`Tool '${toolName}' not found in manifest`);
    }
    // Every real manifest entry is per-account switchable — built-in and
    // live MCP alike. The run's tool decisions honor per-session overrides
    // for ANY category (the same merge rule the manifest filter applies),
    // so a toggle that stopped at the built-in boundary would leave the
    // MCP half of the surface unwritable while the gate kept gating it.
    // Resolve the CURRENT effective enabled state for this user: start
    // from the global default, then apply the per-user override (if any).
    const userRows = await db.listToolSettings(user.userId);
    const userMap = new Map(userRows.map((r) => [r.tool_name, r.enabled] as const));
    const wasEnabled = effectiveEnabledToolNames(userMap).includes(toolName);
    // Toggle: write the OPPOSITE to the per-user DB row. The userId is a
    // separate server-controlled param (the authenticated user), not part of
    // the input object — the ownership gate is at the DB method.
    await db.upsertToolSetting(
      {
        tool_name: toolName,
        enabled: !wasEnabled,
      },
      user.userId,
    );
    invalidateToolManifestCache();
    // Return the full effective enabled list for the client store (the
    // manifest names that are effectively enabled for this user). This
    // keeps the client's enabledTools store in sync without a separate fetch.
    // Reuse the per-user override map already built above (userMap) — the
    // prior code re-fetched await db.listToolSettings(user.userId) for EVERY tool
    // in the manifest (an N+1 query: N tools × 1 DB read each, on top of the
    // single read already done above). The map is stale-safe because the
    // upsert above mutated the DB but the in-memory userMap was refreshed by
    // re-reading right after — instead, re-read ONCE here (after the write)
    // and reuse the fresh map for every tool.
    const freshRows = await db.listToolSettings(user.userId);
    const freshMap = new Map(freshRows.map((r) => [r.tool_name, r.enabled] as const));
    const newEnabled = effectiveEnabledToolNames(freshMap);
    sendJson(ctx.res, { ok: true, tool: toolName, enabled: !wasEnabled, enabledList: newEnabled });
  });
}
