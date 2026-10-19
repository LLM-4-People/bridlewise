/**
 * Route registry — the SINGLE owner of route registration (
 * Single-Party-Owner: route registry).
 *
 * ("Routes: a single route registry module. Adding
 * a route = register it once; the registry handles auth middleware, CSRF,
 * rate limiting, input validation, error mapping — NOT each route file").
 *
 * This module is the one place that knows the full set of route modules and
 * the public-path set. `server/index.ts` calls ONLY `registerAllRoutes` —
 * it does not import or call any individual `register*Routes` itself. A
 * newly added route file is wired by adding ONE line here (the import + the
 * call inside `registerAllRoutes`); the mechanical test
 * (tests/prevention/route-registry.test.ts) verifies every `register*Routes`
 * export is called here and every call resolves to a real import + export.
 *
 * The public-path set (`PUBLIC_PATH_PREFIXES` + `isPublicPath`) is the
 * single owner of which routes are exempt from the auth gate. Previously
 * this lived as a hardcoded allowlist inside the auth middleware in
 * index.ts (`path === "/api/health" || path.startsWith("/api/auth/")`) — a
 * config-outside-config smell + an allowlist. It now
 * lives here, next to the route modules that declare public routes (auth +
 * health), so the gate's exemptions are visible at the registration site.
 *
 * The router (`server/router.ts`) owns the auth + CSRF + rate-limit +
 * error-mapping MIDDLEWARE LOGIC; this module owns the DATA (which routes
 * exist, which are public). `index.ts` wires them: it creates the router
 * with `{ db, isPublicPath }` and calls `registerAllRoutes(router, db)`.
 *
 * The `db` every module here receives is the ASYNC FACADE. The synchronous
 * synchronous client does not reach past `server/db/` any more.
 */

import type { Router } from "../router/router.ts";
import { LIVE_STREAM_PATH } from "../../shared/constants.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

import { clearBlocks, mountBlockRoutes } from "../blocks/define.ts";
import { defineChecksBlocks } from "../blocks/checks.ts";
import { defineIntelligenceBlocks } from "../blocks/intelligence.ts";
import { defineProvenanceBlocks } from "../blocks/provenance.ts";
import { defineCoverageBlocks } from "../blocks/coverage.ts";
import { defineToolsBlocks } from "../blocks/tools.ts";
import { defineSettingsBlocks } from "../blocks/settings.ts";
import { defineSynthesisBlocks } from "../blocks/synthesis.ts";
import { defineComposeBlocks } from "../blocks/compose.ts";
import { defineBreakerBlocks } from "../blocks/breaker.ts";
import { defineSpectrumBlocks } from "../blocks/spectrum.ts";
import { defineArmBlocks } from "../blocks/arm.ts";
import { defineCustodyBlocks } from "../blocks/custody.ts";
import { defineEditorBlocks } from "../blocks/editor.ts";
import { defineAnatomyBlocks } from "../blocks/anatomy.ts";
// CLIENT TELEMETRY — the browser's back-channel into the ledger (the one
// harness component that produced no observability of its own). A block
// action, not a hand-written route: ingestion is a POST with side effects,
// and the block door is the sanctioned shape for a new write capability.
import { defineClientTelemetryBlocks } from "../blocks/client-telemetry.ts";
import { registerAuthRoutes } from "./auth.ts";
import { registerHealthRoutes } from "./health.ts";
import { registerLiveRoutes } from "./live.ts";
import { registerProjectRoutes } from "./projects.ts";
import { registerChatRoutes } from "./chats.ts";
import { registerAutoCheckRoutes } from "./auto-checks.ts";
import { registerConfigRoutes } from "./config.ts";
import { registerToolRoutes } from "./tools.ts";
import { registerTimelineRoutes } from "./timeline.ts";
import { registerMetricsRoutes } from "./metrics.ts";
import { registerAgentRoutes } from "./agents.ts";
import { registerRunRoutes } from "./run.ts";
// The run's SUBSCRIBER is a separate module from the run's CONTROL routes,
// and the separation is enforcement rather than tidiness: the subscriber's
// import cone reaches neither the LLM bridge nor the tool executor, so a GET
// cannot execute a run even by accident.
import { registerRunStreamRoutes } from "./run-stream.ts";
// The run's one status read is a third GET module under the same rule: it
// answers liveness from the registry alone and reaches no executor.
import { registerRunStatusRoutes } from "./run-status.ts";
import { registerMemoryRoutes } from "./memory.ts";
import { registerSchemaRoutes } from "./schema.ts";
import { registerFilesystemRoutes } from "./filesystem.ts";
import { registerModelRoutes } from "./models.ts";
import { registerIntelligenceRoutes } from "./intelligence.ts";
import { registerQualityRoutes } from "./quality.ts";
import { registerAwarenessRoutes } from "./awareness.ts";
import { registerGitOpsRoutes } from "./git-ops.ts";
import { registerEditorRoutes } from "./editor.ts";
import { registerMcpRoutes } from "./mcp.ts";
import { registerExtensionRoutes } from "./extensions.ts";
import { registerFileTreeRoutes } from "./file-tree.ts";
import { registerSafetyRoutes } from "./safety.ts";
import { registerSettingsRoutes } from "./settings.ts";

/**
 * Path prefixes for PUBLIC routes (exempt from the auth gate). A path is
 * public when it equals a prefix OR starts with `prefix + "/"` (so
 * `/api/health` matches only `/api/health`, and `/api/auth/` matches
 * `/api/auth/status`, `/api/auth/login`, …). The auth routes are public
 * (register/login/logout/change-password manage the session themselves);
 * the health route is public (liveness probe).
 *
 * Single owner of the public-route exemption set.
 */
export const PUBLIC_PATH_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/health",
  // THE STANDING LIVENESS STREAM. "Is the server there" needs no session,
  // and the boot needs it answered BEFORE one exists — a reader stuck at a
  // blocked sign-in screen has the same right to know the server is down as
  // one who is signed in. It carries a process start timestamp and an empty
  // beat, and nothing else. See `server/routes/live.ts`.
  LIVE_STREAM_PATH,
];

/**
 * Whether a request path is public (exempt from the auth gate). The single
 * owner of the public-path determination — the router's auth middleware
 * calls this. A path is public when it equals a prefix exactly OR starts
 * with `prefix + "/"` (the trailing-slash rule keeps `/api/health` from
 * also matching a hypothetical `/api/health-check`).
 */
export function isPublicPath(path: string): boolean {
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (path === prefix) return true;
    const boundary = prefix.endsWith("/") ? prefix : prefix + "/";
    if (path.startsWith(boundary)) return true;
  }
  return false;
}

/**
 * Register EVERY route module on the router. This is the single registration
 * point — `server/index.ts` calls only this. Each `register*Routes` defines
 * its route handlers (and only its handlers — no middleware, no error
 * mapping, no auth checking; the router owns those cross-cutting concerns).
 *
 * The order does not matter (routes are matched by method + pattern, not by
 * registration order; the router rejects path-pattern ambiguity at
 * registration time would be a future hardening — current patterns are
 * disjoint).
 */
export function registerAllRoutes(router: Router, db: AsyncDbClient): void {
  registerAuthRoutes(router, db);
  registerHealthRoutes(router, db);
  registerLiveRoutes(router, db);
  registerProjectRoutes(router, db);
  registerChatRoutes(router, db);
  registerAutoCheckRoutes(router, db);
  registerConfigRoutes(router, db);
  registerToolRoutes(router, db);
  registerTimelineRoutes(router, db);
  registerMetricsRoutes(router, db);
  registerAgentRoutes(router, db);
  registerMemoryRoutes(router, db);
  registerRunRoutes(router, db);
  registerRunStreamRoutes(router, db);
  registerRunStatusRoutes(router, db);
  registerSchemaRoutes(router, db);
  registerFilesystemRoutes(router, db);
  registerModelRoutes(router, db);
  registerIntelligenceRoutes(router, db);
  registerQualityRoutes(router, db);
  registerAwarenessRoutes(router, db);
  registerGitOpsRoutes(router, db);
  registerEditorRoutes(router, db);
  registerMcpRoutes(router, db);
  registerExtensionRoutes(router, db);
  registerFileTreeRoutes(router, db);
  registerSafetyRoutes(router, db);
  registerSettingsRoutes(router, db);

  // ── Generated block routes ──
  // Declared capabilities are mounted LAST so that during migration a
  // hand-written legacy route keeps priority over a dual-mounted block. The
  // block surface grows as the LEGACY_ROUTES ratchet drains; when a legacy
  // route is deleted its block becomes the only door, with no ordering
  // change needed here.
  //
  // `clearBlocks()` first so repeated registration in tests (which construct
  // a fresh router per case) does not trip the duplicate-id guard.
  clearBlocks();
  defineChecksBlocks(db);
  defineIntelligenceBlocks(db);
  // LENS. Without this call both provenance blocks are declared and unmounted,
  // so lens.ancestry and lens.recorder 404 — the instrument would report that
  // nothing can be explained, which is indistinguishable from the truth it is
  // meant to measure. Registration is the one step that must not be forgotten.
  defineProvenanceBlocks(db);
  // DARKFIELD + ANNUNCIATOR — the system-level self-knowledge instruments.
  defineCoverageBlocks(db);
  // SYNTHESIS — the computed findings: conversation pulse, echoes, forecast.
  defineSynthesisBlocks(db);
  // ACTION FABRIC — the first declared verbs: the per-user tool switch and
  // the generic validated setting write.
  defineToolsBlocks(db);
  defineSettingsBlocks(db);
  // COCKPIT SPINE + FLIGHT RECORDER (DESIGN-COCKPIT-V2.md §3.4/§3.5/§6.6):
  // the next-turn composition desk, the tool breaker panel, the sweep's
  // density spectrum, and the ledger-backed ARM flags.
  defineComposeBlocks(db);
  defineBreakerBlocks(db);
  defineSpectrumBlocks(db);
  defineArmBlocks(db);
  // CUSTODY (DESIGN-COCKPIT-V2.md §7): current work × producing-conversation
  // join, the keep/undo verbs (real commit / real restore, recorded), and
  // the saved-work history join.
  defineCustodyBlocks(db);
  // The edit tool's read/action surface (preview, history, rollback) — the
  // model-facing tool stays a tool; these are the block-shaped reads around it.
  defineEditorBlocks(db);
  // ANATOMY — the harness anatomy read (process census + component
  // registry), the same owners `scripts/trace.ts anatomy` consumes.
  defineAnatomyBlocks(db);
  // CLIENT TELEMETRY — the browser's facts (uncaught errors, long tasks,
  // feed-ingest lag) recorded into the ledger through the verified,
  // redacting, rate-bounded ingestion door.
  defineClientTelemetryBlocks(db);
  mountBlockRoutes(router);
}
