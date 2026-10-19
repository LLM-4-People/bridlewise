import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { buildDependencyGraph, impactAnalysis } from "../intelligence/dependency-graph.ts";
import { generateRepositoryMap } from "../intelligence/repository-map.ts";
import {
  type RepositoryMapCache,
  type RepositoryReadLimits,
  resolveRepositoryReadLimits,
} from "../intelligence/repository-stat-scan.ts";
import { findReuseCandidates } from "../intelligence/reuse-discovery.ts";
import { searchSymbols } from "../intelligence/symbol-search.ts";
import {
  createReuseQuery,
  createSymbolSearchQuery,
  isSymbolKind,
  type RepositoryMap,
  type SymbolKind,
} from "../intelligence/intelligence-types.ts";
import type { RegisteredTool, ToolContext } from "./tool-registry.ts";
import { optionalString, resolveBoolean, resolvePositiveInt } from "./tool-args.ts";
import {
  SYMBOL_SEARCH_DEFAULT_LIMIT,
  SYMBOL_SEARCH_MAX_LIMIT,
  REUSE_SEARCH_DEFAULT_LIMIT,
  REUSE_SEARCH_MAX_LIMIT,
} from "./runtime-config.ts";

/**
 * Intelligence tools for the interactive chat runtime (delivery-map item 7).
 *
 * Exposes whole-codebase intelligence to the model so it can search for
 * reusable logic before modifying files:
 * - search_code: symbol search (exact/prefix/contains/fuzzy)
 * - get_repository_map: repository map summary (files, modules, symbols)
 * - find_reuse: reuse-candidate discovery (name/kind/signature similarity)
 * - get_dependency_graph: dependency graph + impact analysis
 *
 * The repository map is generated lazily on first tool call and cached for
 * the session. Generating it at startup would slow every session (including
 * those that never use an intelligence tool) with a full source-tree scan;
 * lazy initialization pays the cost only when needed.
 *
 * Per root-policy `retrievalScoreAsTruthAllowed: false`, results are
 * discovery evidence only — they never block an edit or approve a change.
 */

export type IntelligenceToolsOptions = Readonly<{
  repositoryRoot: string;
  /**
   * Optional map provider for tests. Production leaves this undefined so
   * the real {@link generateRepositoryMap} is used.
   */
  mapProvider?: (repositoryRoot: string) => Readonly<{ map: RepositoryMap; cache: RepositoryMapCache }>;
  limits?: RepositoryReadLimits;
}>;

const SYMBOL_KINDS = deepFreeze([
  "function", "class", "interface", "type", "const", "let", "var",
  "enum", "namespace", "method", "property", "parameter",
] as const);

const MATCH_MODES = deepFreeze(["exact", "prefix", "contains", "fuzzy"] as const);

function resolveKind(value: unknown): SymbolKind | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isSymbolKind(value)) {
    throw new InputError("kind must be a valid symbol kind", "tool_arguments_invalid");
  }
  return value;
}

function resolveMatchMode(value: unknown): "exact" | "prefix" | "contains" | "fuzzy" {
  if (value === undefined || value === null) return "exact";
  if (typeof value !== "string" || !(MATCH_MODES as readonly string[]).includes(value)) {
    throw new InputError("matchMode must be one of exact, prefix, contains, fuzzy", "tool_arguments_invalid");
  }
  return value as "exact" | "prefix" | "contains" | "fuzzy";
}

export function createIntelligenceTools(options: IntelligenceToolsOptions): readonly RegisteredTool[] {
  const repositoryRoot = options.repositoryRoot;
  const limits = resolveRepositoryReadLimits(options.limits);
  let mapState: Readonly<{ map: RepositoryMap; cache: RepositoryMapCache }> | undefined;

  function getMap(): RepositoryMap {
    if (mapState === undefined) {
      mapState = options.mapProvider !== undefined
        ? options.mapProvider(repositoryRoot)
        : generateRepositoryMap(repositoryRoot, { limits });
    }
    return mapState.map;
  }

  const searchCode: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "search_code",
        description: "Search the repository's symbol index for functions, classes, types, and other symbols by name, kind, file, directory, and match mode. Returns ranked symbol locations. Use this before modifying files to find reusable logic (delivery-map item 7).",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            name: { type: "string", description: "Symbol name to search for (optional; omit to list by kind/directory)" },
            kind: { type: "string", enum: [...SYMBOL_KINDS], description: "Symbol kind filter" },
            matchMode: { type: "string", enum: [...MATCH_MODES], description: "Name match mode (default exact)" },
            directory: { type: "string", description: "Restrict to files under this directory" },
            filePath: { type: "string", description: "Restrict to this file path" },
            exported: { type: "boolean", description: "Filter by exported status" },
            limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum results (default 50)" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const map = getMap();
      const name = optionalString(args, "name");
      const kind = resolveKind(args.kind);
      const filePath = optionalString(args, "filePath");
      const directory = optionalString(args, "directory");
      const exported = args.exported !== undefined && args.exported !== null
        ? resolveBoolean(args, "exported", false)
        : undefined;
      const query = createSymbolSearchQuery({
        ...(name !== undefined ? { name } : {}),
        ...(kind !== null ? { kind } : {}),
        ...(filePath !== undefined ? { filePath } : {}),
        ...(directory !== undefined ? { directory } : {}),
        ...(exported !== undefined ? { exported } : {}),
        limit: resolvePositiveInt(args, "limit", { defaultValue: SYMBOL_SEARCH_DEFAULT_LIMIT, max: SYMBOL_SEARCH_MAX_LIMIT }),
        matchMode: resolveMatchMode(args.matchMode),
      });
      const results = searchSymbols(map, query);
      return JSON.stringify(deepFreeze({
        totalResults: results.length,
        results: results.map((r) => deepFreeze({
          name: r.symbol.name,
          kind: r.symbol.kind,
          filePath: r.filePath,
          line: r.symbol.location.line,
          column: r.symbol.location.column,
          exported: r.symbol.exported,
          async: r.symbol.async,
          parameterCount: r.symbol.parameterCount,
          score: r.score,
          matchedFields: r.matchedFields,
        })),
      }));
    },
  });

  const getRepositoryMap: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "get_repository_map",
        description: "Return a summary of the repository map: file count, module count, total symbols, total dependencies, and the list of source files. Use this to understand codebase structure before edits.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            includeFiles: { type: "boolean", description: "Include the per-file list (default true)" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const map = getMap();
      const includeFiles = resolveBoolean(args, "includeFiles", true);
      return JSON.stringify(deepFreeze({
        schemaVersion: map.schemaVersion,
        rootPath: map.rootPath,
        mapHash: map.mapHash,
        fileCount: map.files.length,
        moduleCount: map.modules.length,
        totalSymbols: map.totalSymbols,
        totalDependencies: map.totalDependencies,
        ...(includeFiles ? { files: map.files.map((f) => deepFreeze({ path: f.path, symbols: f.lineCount, bytes: f.sizeBytes })) } : {}),
      }));
    },
  });

  const findReuse: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "find_reuse",
        description: "Find existing symbols that could be reused or adapted for a new task. Scores by name similarity, kind match, signature match, and architecture layer. Use this before writing new code to avoid duplication (REQ-005).",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            name: { type: "string", description: "Symbol name to match (fuzzy)" },
            kind: { type: "string", enum: [...SYMBOL_KINDS], description: "Symbol kind filter" },
            signature: { type: "string", description: "Signature hint (e.g. '2 params', 'async', 'exported')" },
            directory: { type: "string", description: "Restrict to files under this directory" },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results (default 20)" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const map = getMap();
      const name = optionalString(args, "name");
      const kind = resolveKind(args.kind);
      const signature = optionalString(args, "signature");
      const directory = optionalString(args, "directory");
      const query = createReuseQuery({
        ...(name !== undefined ? { name } : {}),
        ...(kind !== null ? { kind } : {}),
        ...(signature !== undefined ? { signature } : {}),
        ...(directory !== undefined ? { directory } : {}),
        limit: resolvePositiveInt(args, "limit", { defaultValue: REUSE_SEARCH_DEFAULT_LIMIT, max: REUSE_SEARCH_MAX_LIMIT }),
      });
      const candidates = findReuseCandidates(map, query);
      return JSON.stringify(deepFreeze({
        totalCandidates: candidates.length,
        candidates: candidates.map((c) => deepFreeze({
          name: c.symbol.name,
          kind: c.symbol.kind,
          filePath: c.filePath,
          line: c.symbol.location.line,
          exported: c.symbol.exported,
          score: c.score,
          reasons: c.reasons,
        })),
      }));
    },
  });

  const getDependencyGraph: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "get_dependency_graph",
        description: "Return the module dependency graph summary, or the impact set for a specific file if filePath is provided (which modules directly and transitively depend on it). Use this to understand the blast radius of a change.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            filePath: { type: "string", description: "If provided, return the impact analysis for this file instead of the full graph" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const map = getMap();
      const graph = buildDependencyGraph(map);
      const filePath = optionalString(args, "filePath");
      if (filePath !== undefined) {
        const impact = impactAnalysis(graph, filePath);
        return JSON.stringify(deepFreeze({
          filePath,
          directlyAffected: impact.directlyAffected,
          transitivelyAffected: impact.transitivelyAffected,
          totalAffected: impact.totalAffected,
        }));
      }
      return JSON.stringify(deepFreeze({
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
      }));
    },
  });

  return deepFreeze([searchCode, getRepositoryMap, findReuse, getDependencyGraph]);
}
