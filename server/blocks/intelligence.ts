/**
 * Code-intelligence blocks.
 *
 * The HARD end of the pilot pair (`checks.auto` was the trivial end): these
 * handlers carry real logic — degree-capped node selection, direction
 * validation, ownership through the fs-gate — so converting them proves the
 * contract holds for more than thin passthroughs.
 *
 * DUAL-MOUNTED during migration. The handler bodies live HERE and the legacy
 * routes in `server/routes/intelligence.ts` delegate to them, so there is
 * exactly one implementation while there are temporarily two doors. Deleting a
 * legacy route is then a one-line change with no logic to move.
 *
 * Ownership is unchanged: every handler resolves the user and builds an
 * `FsGate`, exactly as the routes did. The gate is the choke point that
 * enforces project ownership, and blocks inherit it rather than re-implement
 * it.
 */

import { z } from "zod";

import {
  getRepositoryMapSummary,
  getRepositoryMapAsync,
  invalidateProjectCache,
  getDependencyGraph,
  getImpactAnalysis,
  getForwardDeps,
  getReverseDeps,
  searchCodeSymbols,
  findCodeSymbolUsage,
  findReuse,
  findCodeDuplicates,
  getProjectAutoHealReport,
  getDependencyPath,
} from "../intelligence/intelligence-bridge.ts";
import { getGraphMaxNodes } from "../kernel/harness-config.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate, type FsGate } from "../filesystem/fs-gate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { RouteContext } from "../router/router.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

/** Every intelligence read is scoped to a project path. */
const ProjectScope = z.object({ path: z.string().min(1) });

const FileScope = ProjectScope.extend({ file: z.string().min(1) });

const DepsScope = FileScope.extend({
  // Deny-by-default: an unknown direction is a 400, not a silent forward
  // default. The route previously accepted any value and returned forward deps
  // labelled with whatever was asked for — a response that lied about itself.
  dir: z.enum(["forward", "reverse"]).default("forward"),
});

const QueryScope = ProjectScope.extend({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const SymbolScope = ProjectScope.extend({ symbol: z.string().min(1) });

/** Two project-relative files for the load-path query. Deny-by-default:
 * both endpoints are required, non-empty — a missing endpoint is a 400,
 * never a silent "whole graph" fallback. */
const PathQueryScope = ProjectScope.extend({
  from: z.string().min(1),
  to: z.string().min(1),
});

/**
 * Resolve the caller and their filesystem gate — the ownership choke point.
 *
 * The path is named here because the gate now CARRIES the ownership decision
 * rather than a database: it is resolved once, on the read pool, instead of
 * once per bridge call on the request thread.
 */
async function gateFor(
  ctx: RouteContext,
  db: AsyncDbClient,
  projectPath: string,
): Promise<FsGate> {
  const user = await requireUserContext(ctx, db);
  return makeFsGate(user.userId, db, projectPath);
}

/**
 * The dependency-graph projection.
 *
 * Exported so the legacy route delegates rather than duplicating ~40 lines of
 * degree-capping. This is the single implementation.
 */
export function projectDependencyGraph(projectPath: string, gate: FsGate) {
  const { graph, stats, cycles, modulePaths } = getDependencyGraph(projectPath, gate);
  const density =
    graph.nodeCount > 1 ? graph.edgeCount / (graph.nodeCount * (graph.nodeCount - 1)) : 0;
  const allEdges = graph.edges.map((e) => ({ from: e.from, to: e.to }));
  // Seed from the FULL module list so isolated modules (no import edges) are
  // still nodes; the adjacency maps are edge-derived and would omit them.
  const degreeMap = new Map<string, number>();
  for (const path of modulePaths) degreeMap.set(path, 0);
  for (const e of allEdges) {
    degreeMap.set(e.from, (degreeMap.get(e.from) ?? 0) + 1);
    degreeMap.set(e.to, (degreeMap.get(e.to) ?? 0) + 1);
  }
  const nodesByDegree = [...degreeMap.entries()].sort((a, b) => b[1] - a[1]);
  const maxNodes = getGraphMaxNodes();
  const topNodeSet = new Set(nodesByDegree.slice(0, maxNodes).map((n) => n[0]));
  const edges = allEdges.filter((e) => topNodeSet.has(e.from) && topNodeSet.has(e.to));
  const nodes = nodesByDegree.slice(0, maxNodes).map(([id, degree]) => ({ id, degree }));
  return {
    stats: { ...stats, density },
    cycles,
    edgeCount: graph.edgeCount,
    nodeCount: graph.nodeCount,
    edges,
    nodes,
  };
}

/** Register the code-intelligence blocks. */
export function defineIntelligenceBlocks(db: AsyncDbClient): void {
  const passthrough = z.unknown();

  defineBlock({
    id: "code.graph",
    title: "Dependency graph",
    description:
      "Module dependency graph with per-node degree, cycle list and density, capped to the most-connected modules for rendering.",
    read: {
      input: ProjectScope,
      output: passthrough,
      ttlMs: 60_000,
      invalidateOn: ["index:ready"],
      handler: async (input, { ctx }: BlockHandlerContext) =>
        projectDependencyGraph(input.path, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.map",
    title: "Repository map",
    description: "Summary of the indexed repository: module count, file count and language mix.",
    read: {
      input: ProjectScope,
      output: passthrough,
      ttlMs: 60_000,
      invalidateOn: ["index:ready"],
      handler: async (input, { ctx }: BlockHandlerContext) => {
        const summary = getRepositoryMapSummary(input.path, await gateFor(ctx, db, input.path));
        return { summary, moduleCount: summary.moduleCount, fileCount: summary.fileCount };
      },
    },
    actions: {
      /**
       * "Re-read the code now." The REAL entry is the two-step the bridge
       * exposes: `invalidateProjectCache` (drops the stored map, graph and
       * slice indexes — synchronous, so by the time this responds the old
       * reading is provably gone) followed by kicking the worker rebuild.
       * The rebuild is NOT awaited: a large project takes a while and holding
       * the request open would turn a verb into a hang. The consequence
       * sentence states that timing plainly; the header's existing reindex
       * button never dropped the server cache at all, so its "force" happily
       * re-served a warm 60s-old map — this action is the honest version.
       */
      reindex: {
        input: ProjectScope,
        title: "Re-read the code",
        consequence:
          "Discards the stored reading of this project's code and starts reading it again from the files as they are now; readings refresh as the re-read finishes.",
        invalidates: ["index:ready"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const gate = await gateFor(ctx, db, input.path);
          // Ownership is enforced inside the bridge at both calls (fs-gate).
          invalidateProjectCache(input.path, gate);
          // Fire-and-forget: the worker pool dedupes an in-flight build, so a
          // second press joins the first rather than doubling the work. A
          // build failure is reported by the next read (MapNotReady → error),
          // not swallowed silently — the warn keeps it visible server-side.
          void getRepositoryMapAsync(input.path, gate).catch((err: unknown) => {
            webWarn("blocks", "reindex rebuild failed", () => ({
              path: input.path,
              error: err instanceof Error ? err.message : String(err),
            }));
          });
          return { cleared: true, rebuilding: true };
        },
      },
    },
  });

  defineBlock({
    id: "code.impact",
    title: "Impact analysis",
    // DIRECTION made explicit: the analysis walks REVERSE dependencies
    // (files that import this one), not what this file imports. "What a
    // change can reach" read plausibly in either direction.
    description:
      "Files that could be affected if this file changes: everything that imports it, directly or through a chain of imports.",
    read: {
      input: FileScope,
      output: passthrough,
      ttlMs: 30_000,
      handler: async (input, { ctx }: BlockHandlerContext) =>
        getImpactAnalysis(input.path, input.file, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.path",
    title: "Import path between two files",
    // Direction semantics, stated for a first-time user: the import
    // direction ("from" imports "to", possibly through intermediate files)
    // is searched first; when that finds nothing the opposite direction is
    // searched too, and the answer says which direction connected. "No path"
    // is a plain-language answer, not an error. The result carries its own
    // `basis` field because the graph omits dynamic imports and unresolved
    // specifiers — a "no path" is only as strong as what it was computed from.
    description:
      "How two files are connected through imports. Looks for a chain of import statements from the first file to the second (the first file imports the second, possibly through files in between); if none exists, the opposite direction is checked too, and the answer says which direction connected. Each step shows the import text that links one file to the next. When nothing connects the files in either direction, it says so plainly. Based only on imports recorded at indexing time — dynamic imports and imports that could not be resolved are not searched.",
    read: {
      input: PathQueryScope,
      output: passthrough,
      ttlMs: 30_000,
      handler: async (input, { ctx }: BlockHandlerContext) =>
        getDependencyPath(input.path, input.from, input.to, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.deps",
    title: "Dependencies",
    description: "Forward or reverse dependencies of one file.",
    read: {
      input: DepsScope,
      output: passthrough,
      ttlMs: 30_000,
      handler: async (input, { ctx }: BlockHandlerContext) => {
        const gate = await gateFor(ctx, db, input.path);
        const deps =
          input.dir === "reverse"
            ? getReverseDeps(input.path, input.file, gate)
            : getForwardDeps(input.path, input.file, gate);
        return { file: input.file, direction: input.dir, count: deps.length, dependencies: deps };
      },
    },
  });

  defineBlock({
    id: "code.search",
    title: "Symbol search",
    description: "Search indexed symbols by name across the project.",
    read: {
      input: QueryScope,
      output: passthrough,
      ttlMs: 15_000,
      handler: async (input, { ctx }: BlockHandlerContext) =>
        searchCodeSymbols(input.path, input.q, input.limit, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.usage",
    title: "Symbol importers",
    // HONESTY: findSymbolUsage (harness symbol-search.ts) scans IMPORT
    // statements for the name — it does not find call sites or any other
    // reference. "Where a symbol is referenced" overstated that.
    description:
      "Files that import a symbol by the given name. Found by scanning import statements only — uses of the symbol that are not imports (calls inside the defining file, dynamic lookups) are not counted.",
    read: {
      input: SymbolScope,
      output: passthrough,
      ttlMs: 15_000,
      handler: async (input, { ctx }: BlockHandlerContext) =>
        findCodeSymbolUsage(input.path, input.symbol, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.reuse",
    title: "Reuse candidates",
    // HONESTY: the bridge passes the query as a NAME for fuzzy matching
    // (findReuseCandidates scores name similarity + kind/export/layer
    // bonuses). "Code that could serve a described need" implied semantic
    // understanding of what the code does; it is name similarity.
    description:
      "Existing symbols whose names are similar to your search — candidates to reuse instead of writing something new. Matched by name similarity (plus small bonuses for exported symbols), not by what the code actually does.",
    read: {
      input: QueryScope,
      output: passthrough,
      ttlMs: 30_000,
      handler: async (input, { ctx }: BlockHandlerContext) =>
        findReuse(input.path, input.q, input.limit, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.duplicates",
    title: "Duplicate symbol names",
    // HONESTY: the analysis (findDuplicates in reuse-discovery.ts) groups
    // EXPORTED symbols by name + kind. It never reads or compares code
    // bodies, and it is not limited to functions. The previous description
    // ("functions with near-identical bodies") claimed a body-similarity
    // analysis that does not exist — the same defect class as fabricated
    // data. If real body comparison is ever added, update this AND the
    // claim-word ratchet in tests/prevention/block-description-honesty.test.ts.
    description:
      "Exported symbols (functions, classes, and others) that share the same name and kind in more than one place. Matched by name only — the code inside is not compared, so two entries may be unrelated code that happens to share a name.",
    read: {
      input: ProjectScope,
      output: passthrough,
      ttlMs: 60_000,
      invalidateOn: ["index:ready"],
      handler: async (input, { ctx }: BlockHandlerContext) =>
        findCodeDuplicates(input.path, await gateFor(ctx, db, input.path)),
    },
  });

  defineBlock({
    id: "code.autoHeal",
    title: "Code-index health",
    // HONESTY: the report (buildAutoHealReport in server/auto-heal.ts) carries
    // staleness (files changed/vanished since indexing) and broken edges as
    // `{from, specifier, kind}` — the file, the import text, and the import
    // kind. There is NO proposed correction anywhere in the shape, and what
    // "heals" is the INDEX (it rebuilds itself when stale), never the user's
    // imports. The previous description promised "the proposed correction for
    // each" — a capability that does not exist. If real fix proposals are ever
    // added, update this AND the claim-word ratchet in
    // tests/prevention/block-description-honesty.test.ts.
    description:
      "Health of the code index: whether indexed files have changed on disk since indexing (the index rebuilds itself when stale), plus a list of import statements that point at files that could not be found. Each broken import shows the file it is in, the import text as written, and the import kind — it does not suggest a fix.",
    read: {
      input: ProjectScope,
      output: passthrough,
      ttlMs: 30_000,
      invalidateOn: ["index:ready"],
      handler: async (input, { ctx }: BlockHandlerContext) =>
        getProjectAutoHealReport(input.path, await gateFor(ctx, db, input.path)),
    },
  });
}
