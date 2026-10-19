/**
 * Config route — reads the REAL harness config (not a fixture) and allows
 * editing config values via PUT.
 *
 * Routes:
 * GET /api/config — redacted config snapshot (real config file), ADMIN ONLY
 * PUT /api/config — update a config value (path + value), ADMIN ONLY
 *
 * Security:
 * The global document is shared by every user and is an admin's to read, as
 * it is an admin's to write: it names every server, path and limit of this
 * installation (cfg-audit: any logged-in user received it, key-name
 * redaction only). A user's own settings are served by the settings
 * registry's per-user routes, never by this document.
 * API keys are NEVER returned (redacted to [redacted])
 * PUT is admin-only, rejects sensitive KEY names outright, and refuses
 * prototype-polluting path segments.
 * Only known config paths are accepted (no arbitrary JSON injection) —
 * enforced at the WRITE choke point (`writeConfigRaw` in
 * harness-config.ts), which validates the whole candidate document
 * against the harness's strict `getConfigDocumentSchema()`. An unrecognised
 * path, a wrong-typed value or an out-of-range number is rejected with
 * `invalid_config_document` (400) and nothing is written. The allowlist
 * is DERIVED from that schema, not restated here, so it cannot drift
 * from the config contract.
 *
 * This comment previously claimed the allowlist while no such check
 * existed anywhere in the request path — the endpoint accepted arbitrary
 * new JSON paths. The claim is now true.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { z } from "zod";
import { assertValidBody } from "../router/validate.ts";
import { serverConfig } from "../kernel/config.ts";
import { getSettingsStoreState, readConfigRaw, readSettingsDocument, modifyConfigRaw } from "../kernel/harness-config.ts";
import { ForbiddenError, WebError, BadRequestError } from "../kernel/errors.ts";
import { requireAdminContext } from "../auth/user-context.ts";
import { invalidateToolManifestCache } from "../tools/tools-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
// SPO: the config-snapshot key-based redaction is owned by the single
// redaction owner (server/redaction.ts). This route imports it — it does
// not redefine the key patterns or the deep walker (No Scattered Helpers).
// `redactBySensitiveKeys` masks values under sensitive KEY names
// (apiKey/secret/password/token/credential/auth); `isSensitiveKey` is reused
// for the PUT validation (reject writes to sensitive keys). The REST
// egress choke point (`sendJson` in server/router.ts) additionally applies
// the value-pattern `redactForUserDisplay` to every REST response, so a
// secret that escapes the key-based pass (e.g. a value containing a
// credential assignment under a non-sensitive key) is still caught —
// defense-in-depth at the egress choke point.
import { redactBySensitiveKeys, isSensitiveKey } from "../llm/redaction.ts";
import { concealMcpServersIn } from "../integrations/mcp-bridge.ts";
import { carriesKeepMark } from "../../engine/src/privacy/secret-parts.ts";

// Property names that reach the prototype chain via ordinary assignment —
// rejecting them prevents prototype pollution (`__proto__.polluted = true` or
// `constructor.prototype.polluted = true` would set Object.prototype). The
// guard runs at the lowest level (setByPath) so no caller can bypass it.
const DANGEROUS_PROP_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  for (const part of parts) {
    if (DANGEROUS_PROP_NAMES.has(part)) {
      throw new ForbiddenError(
        `Config path segment '${part}' is not allowed (prototype-pollution guard)`,
        "forbidden_config_path",
      );
    }
  }
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = current[part];
    if (existing === undefined || existing === null) {
      current[part] = {};
    } else if (typeof existing !== "object" || Array.isArray(existing)) {
      // Refuse to silently overwrite a non-object leaf (a number, string,
      // boolean, or array) with an object — that would destroy the existing
      // value. The caller must use a path that does not traverse through a
      // scalar leaf. A client error (the admin sent a bad path) — use the
      // typed BadRequestError (carries statusCode=400) so the hierarchy is
      // consistent with the other client-error throws.
      throw new BadRequestError(
        `Config path segment '${part}' is a ${Array.isArray(existing) ? "array" : typeof existing} value, not an object — cannot traverse into it`,
        "config_path_traverses_scalar",
      );
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

// (No Scattered Helpers): the ad-hoc `sendError(res, status, code,
// message)` helper that lived here AND in routes/models.ts is GONE. Routes
// now THROW typed errors and the router's centralized error mapping
// (statusForError + errorBody in server/router.ts) produces the
// `{ error, message }` body with the right status. Single-Party-Owner:
// error mapping has one owner (the router), not a per-route copy.

const CONFIG_UPDATE_SCHEMA = z.strictObject({
  path: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.]+$/, "Config path must be dot-separated alphanumeric"),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export function registerConfigRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/config", async (ctx) => {
    await requireAdminContext(ctx, db);
    // THE SETTINGS IN FORCE, never the file's bytes: while the store is
    // refused (a hand edit a posture door turned away) or unreadable, the
    // last good document is what every run obeys, so it is what is shown,
    // beside the store's state — showing the refused bytes told the operator
    // a weakened setting was in force when it was not (wf1b2-correctness).
    const storeState = getSettingsStoreState();
    const config = storeState.state === "absent" ? {} : readSettingsDocument();
    const redacted = redactBySensitiveKeys(concealMcpServersIn(config as Record<string, unknown>)) as Record<string, unknown>;
    sendJson(ctx.res, {
      config: redacted,
      configPath: serverConfig.harnessConfigPath,
      editable: storeState.state !== "unreadable",
      storeState: { state: storeState.state, ...(storeState.reason === undefined ? {} : { reason: storeState.reason }) },
    });
  });

  router.put("/api/config", async (ctx) => {
    // the global config is shared across ALL users — mutating it
    // requires admin privileges (a regular user must not change the LLM
    // provider/limits/safety settings for everyone). The auth gate
    // (requireAdminContext) throws ForbiddenError (403) for non-admins.
    await requireAdminContext(ctx, db);
    const body = assertValidBody(CONFIG_UPDATE_SCHEMA, ctx.body, "invalid_config_update");
    const { path: configPath, value } = body;
    if (isSensitiveKey(configPath)) {
      throw new ForbiddenError(
        "Cannot update sensitive configuration keys via API",
        "sensitive_key",
      );
    }
    // A keep mark is how a hidden credential is SERVED, never a value: it is
    // kept (in its place) only by the MCP servers' own write
    // (`PUT /api/mcp/servers`), which knows what it stands for.
    if (typeof value === "string" && carriesKeepMark(value)) {
      throw new BadRequestError("The value carries a hidden credential's keep mark; edit that server in the MCP servers settings, or type the value itself.", "config_keep_mark_refused");
    }
    try {
      // The read, the path assignment and the gated write are ONE locked
      // cycle: a parallel writer's config change cannot land between this
      // route's read and its write and be silently composed away.
      modifyConfigRaw((doc) => {
        setByPath(doc, configPath, value);
        return doc;
      });
      // The tool manifest caches config-derived values (tool `maximum` caps
      // + description prose). A config edit can change those values, so the
      // cache must be invalidated or the manifest serves stale limits to the
      // LLM. `readHarnessConfig` checks current bytes on every call, so a
      // rebuild picks up the fresh values.
      invalidateToolManifestCache();
      const newConfig = readConfigRaw();
      const redacted = redactBySensitiveKeys(concealMcpServersIn(newConfig));
      sendJson(ctx.res, { ok: true, path: configPath, value, config: redacted });
    } catch (err) {
      // Re-throw as a typed WebError so the router maps it to a 500
      // `{ error: code, message }` body. The default code preserves the
      // prior "config_update_failed" fallback when the underlying error
      // carries no code. Never `throw new Error(...)`.
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as Error & { code?: string }).code ?? "config_update_failed";
      throw new WebError(message, code);
    }
  });
}
