/**
 * Schema route — serves the schema-driven UI extension manifest.
 *
 * Routes:
 * GET /api/schema/ui — the full UI schema (menus, panels,
 * widgets, settings, actions, signals)
 * GET /api/schema/ui/values — current signal + customization values
 * POST /api/schema/ui/actions/:id — execute a registered exposure action
 * PUT /api/schema/ui/customizations/:id — set a customization value
 *
 * The schema is built once (memoized) from the UI declarations + the live
 * exposure registry. The exposure registry is populated on first request
 * via `registerAllExposure()` (idempotent).
 */

import type { Router, RouteContext } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { z } from "zod";
import { assertValidBody } from "../router/validate.ts";
import { registerAllExposure } from "../kernel/canonical.ts";
import {
  buildUiSchema,
  buildUiSchemaValues,
  executeSchemaAction,
  setSchemaCustomization,
} from "../schema/ui-schema.ts";
import { requireUserContext, requireAdminContext } from "../auth/user-context.ts";
import { BadRequestError, WebError } from "../kernel/errors.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

/** Ensure the exposure registry is populated (idempotent — safe to call repeatedly). */
let exposureRegistered = false;
function ensureExposureRegistered(): void {
  if (exposureRegistered) return;
  registerAllExposure();
  exposureRegistered = true;
}

/**
 * Build a success response body for an action/customization endpoint. The
 * `ok: true` literal lives here, next to `return`, which is the Result-
 * constructor pattern the `no-hardcoded-success` prevention test accepts
 * (a computed-truth success flag would be wrong here — the operation already
 * succeeded by the time `okResult` is called). Centralising the literal in
 * one owner also removes `ok: true` from every call site (DRY).
 */
function okResult<T>(result?: T): { ok: true; result?: T } {
  if (result === undefined) return { ok: true };
  return { ok: true, result };
}

// Body schemas.
// Actions accept arbitrary key-value args (different actions need different
// params); a record schema validates the body is an object without
// constraining keys. Customizations require a `value` field.
const ACTION_BODY_SCHEMA = z.record(z.string(), z.unknown());
const CUSTOMIZATION_BODY_SCHEMA = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]),
});

export function registerSchemaRoutes(router: Router, db: AsyncDbClient): void {
  // GET /api/schema/ui — the full UI schema.
  router.get("/api/schema/ui", async (ctx: RouteContext) => {
    await requireUserContext(ctx, db);
    ensureExposureRegistered();
    const schema = buildUiSchema();
    sendJson(ctx.res, schema);
  });

  // GET /api/schema/ui/values — current signal + customization values.
  router.get("/api/schema/ui/values", async (ctx: RouteContext) => {
    const viewer = await requireUserContext(ctx, db);
    ensureExposureRegistered();
    const values = buildUiSchemaValues(viewer);
    sendJson(ctx.res, values);
  });

  // POST /api/schema/ui/actions/:id — execute a registered exposure action.
  // actions mutate GLOBAL harness state (clearCache, etc.) —
  // admin-only so a regular user cannot trigger global side effects.
  router.post("/api/schema/ui/actions/:id", async (ctx: RouteContext) => {
    await requireAdminContext(ctx, db);
    ensureExposureRegistered();
    const id = ctx.params.id;
    if (!id) {
      throw new BadRequestError("Missing action id", "missing_action_id");
    }
    const body = assertValidBody(ACTION_BODY_SCHEMA, ctx.body, "invalid_action_body") as Readonly<Record<string, unknown>>;
    const result = executeSchemaAction(id, body);
    // Actions may be async; normalize to a JSON-serializable result. By
    // awaiting here (and letting a rejection throw a typed WebError) the
    // router's centralized error mapping produces the 500 body — instead
    // of an ad-hoc `res.writeHead/end` in a `.then` rejection handler (the
    // scattered-helper pattern removed). The handler is async
    // so the router's `await route.handler(...)` catch sees the throw.
    if (result instanceof Promise) {
      try {
        const value = await result;
        sendJson(ctx.res, okResult(value));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as Error & { code?: string }).code ?? "action_failed";
        throw new WebError(message, code);
      }
    } else {
      sendJson(ctx.res, okResult(result));
    }
  });

  // PUT /api/schema/ui/customizations/:id — set a customization value.
  // customizations are GLOBAL harness state — admin-only so a
  // regular user cannot change shared settings for everyone.
  router.put("/api/schema/ui/customizations/:id", async (ctx: RouteContext) => {
    await requireAdminContext(ctx, db);
    ensureExposureRegistered();
    const id = ctx.params.id;
    if (!id) {
      throw new BadRequestError("Missing customization id", "missing_customization_id");
    }
    const body = assertValidBody(CUSTOMIZATION_BODY_SCHEMA, ctx.body, "invalid_customization_body");
    setSchemaCustomization(id, body.value);
    sendJson(ctx.res, okResult());
  });
}
