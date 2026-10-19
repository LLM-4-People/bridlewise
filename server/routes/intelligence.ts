/**
 * Intelligence routes — code graph, repository map, symbol search, and
 * reuse discovery over a real project.
 *
 * Routes:
 * GET /api/intelligence/map?path=<project> — repository map summary
 * GET /api/intelligence/graph?path=<project> — dependency graph + stats + cycles
 * GET /api/intelligence/impact?path=<project>&file=<path> — impact analysis
 * GET /api/intelligence/deps?path=<project>&file=<path>&dir=forward — forward/reverse deps
 * GET /api/intelligence/search?path=<project>&q=<query>&limit=<n> — symbol search
 * GET /api/intelligence/usage?path=<project>&symbol=<name> — symbol usage
 * GET /api/intelligence/reuse?path=<project>&q=<query> — reuse candidates
 * GET /api/intelligence/duplicates?path=<project> — duplicate functions
 * POST /api/intelligence/invalidate — invalidate cache
 *
 * (filesystem access owner): project-ownership is enforced at the
 * BRIDGE (intelligence-bridge.ts via server/fs-gate.ts), NOT in the route.
 * The route resolves the authenticated user + passes the `FsGate` to the
 * bridge; the bridge calls `assertProjectPathOwnership` at the choke
 * point. The per-route `requireProjectByPath` is removed.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import {
  getRepositoryMapSummary,
  getImpactAnalysis,
  getForwardDeps,
  getReverseDeps,
  searchCodeSymbols,
  findCodeSymbolUsage,
  findReuse,
  findCodeDuplicates,
  invalidateProjectCache,
  retrieveRelevantFiles,
  getProjectAutoHealReport,
  getProjectBrokenEdges,
} from "../intelligence/intelligence-bridge.ts";
import { toRelativePath } from "../intelligence/auto-heal.ts";
import { projectDependencyGraph } from "../blocks/intelligence.ts";
import { getIntelligenceSearchDefaultLimit, getIntelligenceSearchMaxLimit, getIntelligenceRetrieveDefaultLimit, getIntelligenceRetrieveMaxLimit } from "../kernel/harness-config.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate } from "../filesystem/fs-gate.ts";
import { requirePathQuery } from "../router/validate.ts";
import { BadRequestError } from "../kernel/errors.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerIntelligenceRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/intelligence/map", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    // The summary already carries moduleCount + fileCount (computed from the
    // same cached map). A second getRepositoryMap call would repeat the
    // ownership DB query + path validation statSync for the SAME cached map
    // — a redundant double-call. Reuse the summary's fields (same values).
    const summary = getRepositoryMapSummary(projectPath, gate);
    sendJson(ctx.res, { summary, moduleCount: summary.moduleCount, fileCount: summary.fileCount });
  });

  router.get("/api/intelligence/graph", async (ctx) => {
    // DELEGATES to the block's projection — one implementation, two doors
    // during migration. The ~40 lines of degree-capping that used to live here
    // moved to server/blocks/intelligence.ts; this route disappears when the
    // client repoints to GET /api/b/code.graph.
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    sendJson(ctx.res, projectDependencyGraph(projectPath, gate));
  });

  router.get("/api/intelligence/impact", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const file = ctx.query.get("file");
    if (file === null) throw new BadRequestError("File path is required", "missing_file");
    const result = getImpactAnalysis(projectPath, file, gate);
    sendJson(ctx.res, result);
  });

  router.get("/api/intelligence/deps", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const file = ctx.query.get("file");
    const dir = ctx.query.get("dir") ?? "forward";
    if (file === null) throw new BadRequestError("File path is required", "missing_file");
    // Validate `dir` is one of the supported directions. Previously any
    // non-"reverse" value silently fell through to forward, so `dir=sideways`
    // returned forward deps with `direction: "sideways"` in the response — a
    // type lie (the response label did not match the data). Deny-by-default:
    // an unknown direction is a 400, not a silent forward default.
    if (dir !== "forward" && dir !== "reverse") {
      throw new BadRequestError("Direction must be 'forward' or 'reverse'", "invalid_direction");
    }
    const deps = dir === "reverse" ? getReverseDeps(projectPath, file, gate) : getForwardDeps(projectPath, file, gate);
    sendJson(ctx.res, { file, direction: dir, count: deps.length, dependencies: deps });
  });

  router.get("/api/intelligence/search", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const q = ctx.query.get("q");
    const limitRaw = ctx.query.get("limit");
    const limit = limitRaw !== null ? Math.min(Math.max(1, parseInt(limitRaw, 10) || getIntelligenceSearchDefaultLimit()), getIntelligenceSearchMaxLimit()) : getIntelligenceSearchDefaultLimit();
    if (q === null || q.length === 0) throw new BadRequestError("Search query is required", "missing_query");
    const search = searchCodeSymbols(projectPath, q, limit, gate);
    // Spread the ranking signals alongside the results rather than dropping
    // them: how the query was classified, which weights were applied, whether
    // the top hit stood clear of the rest, and whether the hits all came from
    // one directory are the facts that tell a caller how much to trust the
    // order — withholding them would leave a bare list that looks equally
    // confident whether or not it is.
    sendJson(ctx.res, { query: q, count: search.results.length, ...search });
  });

  router.get("/api/intelligence/usage", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const symbol = ctx.query.get("symbol");
    if (symbol === null) throw new BadRequestError("Symbol name is required", "missing_symbol");
    const result = findCodeSymbolUsage(projectPath, symbol, gate);
    sendJson(ctx.res, result);
  });

  router.get("/api/intelligence/reuse", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const q = ctx.query.get("q");
    if (q === null || q.length === 0) throw new BadRequestError("Query is required", "missing_query");
    const results = findReuse(projectPath, q, undefined, gate);
    sendJson(ctx.res, { query: q, count: results.length, results });
  });

  router.get("/api/intelligence/duplicates", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const results = findCodeDuplicates(projectPath, gate);
    sendJson(ctx.res, { count: results.length, results });
  });

  // EXP474 codebase-file retrieval: phrase n-gram + slot allocation +
  // package/directory co-occurrence. Ranks relevant source files for a
  // natural-language query (used by the LLM retrieve_relevant_files tool +
  // the Intelligence panel "Find relevant files" action).
  router.get("/api/intelligence/retrieve", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const q = ctx.query.get("q");
    const limitRaw = ctx.query.get("limit");
    const limit = limitRaw !== null ? Math.min(Math.max(1, parseInt(limitRaw, 10) || getIntelligenceRetrieveDefaultLimit()), getIntelligenceRetrieveMaxLimit()) : getIntelligenceRetrieveDefaultLimit();
    if (q === null || q.length === 0) throw new BadRequestError("Query is required", "missing_query");
    const result = retrieveRelevantFiles(projectPath, q, limit, gate);
    sendJson(ctx.res, { query: q, count: result.files.length, files: result.files, debug: result.debug });
  });

  router.post("/api/intelligence/invalidate", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    invalidateProjectCache(projectPath, gate);
    sendJson(ctx.res, { ok: true, path: projectPath });
  });

  // ── Auto-heal signals ──
  router.get("/api/intelligence/auto-heal", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const report = getProjectAutoHealReport(projectPath, gate);
    // Report changed/vanished files relative to the project root for
    // compact, portable display (absolute paths leak the server's
    // filesystem layout). Files outside the root are kept absolute.
    const toRel = (abs: string): string => toRelativePath(projectPath, abs);
    sendJson(ctx.res, {
      path: projectPath,
      stale: report.stale.stale,
      staleReason: report.stale.reason,
      staleSampleSize: report.stale.sampleSize,
      changedFiles: report.stale.changedFiles.map(toRel),
      vanishedFiles: report.stale.vanishedFiles.map(toRel),
      brokenEdgeCount: report.brokenEdges.count,
      brokenEdges: report.brokenEdges.brokenEdges,
      lastIndexedAt: report.lastIndexedAt,
    });
  });

  router.get("/api/intelligence/broken-edges", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const report = getProjectBrokenEdges(projectPath, gate);
    sendJson(ctx.res, { path: projectPath, count: report.count, brokenEdges: report.brokenEdges });
  });
}
