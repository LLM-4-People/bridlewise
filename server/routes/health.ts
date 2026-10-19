/**
 * Health check route — reports server liveness and harness readiness.
 *
 * `harnessReady` stays false until the full runtime is admitted.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { timelineReadiness } from "../observability/timeline-bridge.ts";

export function registerHealthRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/health", (ctx) => {
    // LIVENESS is this answer; READINESS is per component (SCALE-CR1 C10):
    // the ledger may still be migrating while the server answers.
    // And WHOSE database this server serves (UD-S15): a test suite refuses to
    // drive a server whose database is the product's (`assertServerIsNotReal`).
    sendJson(ctx.res, { status: "ok", harnessReady: false, ledger: timelineReadiness().state, database: db.provenance });
  });
}
