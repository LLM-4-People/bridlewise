/**
 * Metrics route — returns a combined metrics payload: the canonical
 * per-function snapshot (call/error/cancellation counts + duration
 * histograms) PLUS system resource metrics (CPU, memory, event-loop,
 * uptime) and token throughput (tokens/s).
 *
 * Route:
 * GET /api/metrics — CombinedMetrics
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { getCombinedMetrics } from "../observability/metrics-bridge.ts";
import { getMetricsSnapshot } from "../observability/metrics-bridge.ts";
import { computeSelfImprovementSuggestions } from "../observability/self-improving.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerMetricsRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/metrics", async (ctx) => {
    await requireUserContext(ctx, db);
    const metrics = getCombinedMetrics();
    sendJson(ctx.res, metrics);
  });

  // self-improving — the analyzer reads the live metrics snapshot
  // (response times, error rates, tool success rates — already tracked by
  // the canonical collector) and returns typed improvement suggestions for
  // the Metrics dashboard. Thresholds come from the config owner
  // (webUi.selfImproving). Pure analyzer, no extra recording.
  router.get("/api/metrics/self-improving", async (ctx) => {
    await requireUserContext(ctx, db);
    const suggestions = computeSelfImprovementSuggestions(getMetricsSnapshot());
    sendJson(ctx.res, { suggestions, count: suggestions.length });
  });
}
