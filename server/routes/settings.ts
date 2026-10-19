/**
 * Settings routes — per-user preferences stored encrypted in the DB.
 *
 * "System prompt configurable from web — tone, sentence case,
 * emoji, icons." The system-prompt preferences (custom override text +
 * tone / sentence-case / emoji / icon toggles) are stored PER-USER in the
 * encrypted `user_prompt_prefs` table (following the `user_model_prefs`
 * pattern — reuse the existing encrypted-per-session pattern).
 * The config file's `runtime.userPreferences` + `runtime.systemPromptOverride`
 * are the GLOBAL DEFAULT seed; the per-user DB override wins field-by-field
 * (see `resolvePromptPrefs` in project-context.ts — the single merge point).
 *
 * Routes:
 * GET /api/settings/prompt-prefs — the caller's prompt prefs (or the
 * config defaults when no DB row exists, so the UI always shows
 * resolved values, never an empty form).
 * PUT /api/settings/prompt-prefs — upsert the caller's prompt prefs
 * (encrypted at rest). The body is the full prefs shape (replaces any
 * prior row for this session).
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { z } from "zod";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import {
  buildDefaultPromptPrefs,
  coercePromptPrefs,
  resolvePromptPrefs,
  type PromptPrefs,
} from "../context/project-context.ts";

// ── Input validation ──

const PROMPT_PREFS_INPUT = z.strictObject({
  systemPromptOverride: z.string().max(16_384).default(""),
  tone: z.enum(["concise", "detailed", "friendly"]).default("concise"),
  sentenceCase: z.enum(["normal", "title", "upper"]).default("normal"),
  emoji: z.boolean().default(false),
  icons: z.boolean().default(true),
});

// ── Route registration ──

export function registerSettingsRoutes(router: Router, db: AsyncDbClient): void {
  // GET /api/settings/prompt-prefs — the caller's resolved prompt prefs.
  // When no DB row exists, the config-file defaults are returned (so the
  // Settings form shows the effective values, not an empty form). The
  // `source` field tells the UI whether the values came from the DB
  // ("user") or the config defaults ("default") — used to show a
  // "reset to defaults" affordance only when a user override exists.
  router.get("/api/settings/prompt-prefs", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const configDefaults = buildDefaultPromptPrefs();
    const stored = await db.getUserPromptPrefs(user.userId);
    if (stored === null) {
      sendJson(ctx.res, { prefs: configDefaults, source: "default" });
      return;
    }
    const resolved = resolvePromptPrefs(configDefaults, stored);
    sendJson(ctx.res, { prefs: resolved, source: "user" });
  });

  // PUT /api/settings/prompt-prefs — upsert the caller's prompt prefs
  // (encrypted at rest). The body is the full prefs shape; absent optional
  // fields fall back to the defaults via the Zod `.default(...)` schema.
  // Let ZodError propagate — the router maps it to 400 `validation_failed`
  // with the SPECIFIC issue message (consistent with register/login;
  // ZodError is a typed error, never `throw new Error`).
  router.put("/api/settings/prompt-prefs", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const parsed: unknown = PROMPT_PREFS_INPUT.parse(ctx.body);
    // Re-coerce through the canonical resolver so the stored blob is the
    // exact effective shape (no extra keys, defaults applied). This is
    // the single normalization point — the GET and the run route read the
    // same shape back without re-normalizing.
    const defaults = buildDefaultPromptPrefs();
    const normalized = coercePromptPrefs(parsed, defaults);
    await db.upsertUserPromptPrefs(user.userId, normalized);
    sendJson(ctx.res, { ok: true, prefs: normalized, source: "user" });
  });

  // DELETE /api/settings/prompt-prefs — remove the caller's per-user prompt
  // prefs override so the config-file defaults re-emerge (source "default").
  // This is the real "reset to defaults": deleting the override row, NOT
  // writing the frontend's hardcoded defaults as a new user override (the
  // old reset wrote a row with hardcoded values → source stayed "user" AND
  // went stale if the config defaults changed). SPO fix. Returns ok; the
  // UI reloads via GET to render the now-default values.
  router.delete("/api/settings/prompt-prefs", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    await db.deleteUserPromptPrefs(user.userId);
    sendJson(ctx.res, { ok: true });
  });
}

export type { PromptPrefs };
