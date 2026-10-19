// src/intelligence/next-edit-prefetch.ts
//
// AL1 GoL next-edit prediction (prefetch) — EXP442/EXP455 POSITIVE finding.
//
// When a function is edited, its GoL (Game-of-Life) neighbours — the
// callers and callees from the call graph — are the most likely NEXT
// edits. Pre-fetching their files saves ~77% of read_file calls
// (EXP442 measurement on 50 babel refactors: reads 291→67, tool calls
// 582→358, time 11640→2680ms).
//
// The neighbours are computed DYNAMICALLY from the call graph (no
// static list — per "everything dynamically computed"). The
// call graph is sourced from the existing `RepositoryMap` (callers +
// callees), so this module is a thin adapter over `repository-map.ts`
// and `quick-view.ts`.
//
// Research sources:
// - EXP442 (`novel-principles`): GoL applied to call-graph neighbours.
// 5.10× lift over a no-prefetch baseline on 50 babel refactors.
// - EXP224 (GoL recall 88.9%): the antecedent GoL-on-call-graph work.
// - EXP455 merge manifest: AL1 marked as ENHANCEMENT to editor
// awareness (`src/runtime/interactive-session.ts` + `src/editor/
// transactional-editor.ts`).
//
// Public API:
// - `predictNextEdits({ map, editedFile, editedSymbol })` → a list of
// (file, symbol, reason, kind) tuples ranked by GoL proximity.
// - `pickPrefetchFiles(predictions, maxFiles)` → the deduped file
// list (for the editor's prefetch hint).
//
// No code extracted from external sources; the GoL-neighbour rule is
// "callers ∪ callees of the just-edited symbol", a textbook graph
// operation. The richness is in the ranking + reason strings (so the
// LLM/UI can explain why each file was pre-fetched).

import { deepFreeze } from "../kernel/integrity.ts";
import type { RepositoryMap, ModuleInfo, SymbolInfo } from "./intelligence-types.ts";
import { DEFAULT_NEXT_EDIT_MAX_PREDICTIONS, DEFAULT_NEXT_EDIT_MAX_FILES } from "./intelligence-config.ts";

export type NextEditPrediction = Readonly<{
  /** File to pre-fetch. */
  filePath: string;
  /** Symbol name in that file (the caller or callee). */
  symbol: string;
  /** Why this file is a likely next edit ("caller of X", "callee of X"). */
  reason: string;
  /** Kind: "caller" (this file calls X) or "callee" (X calls this file). */
  kind: "caller" | "callee" | "same-file-neighbour";
  /** GoL proximity: 1 = direct neighbour, 2 = neighbour-of-neighbour. */
  proximity: number;
}>;

export type NextEditOptions = Readonly<{
  /** Include 2-hop neighbours (default false — 1-hop only). */
  includeSecondHop?: boolean;
  /** Maximum predictions to return (default per `DEFAULT_NEXT_EDIT_MAX_PREDICTIONS`). */
  maxPredictions?: number;
}>;

/**
 * Predict the next likely edits after a function is edited. The
 * predictions are the GoL neighbours of the just-edited symbol: callers
 * (files that invoke it) and callees (files it invokes).
 *
 * The function is pure: it reads `map` and returns a frozen list. No
 * I/O, no side effects. Callers (the editor, the awareness block) are
 * responsible for actually pre-fetching the predicted files.
 */
export function predictNextEdits(
  map: RepositoryMap,
  edited: Readonly<{ filePath: string; symbol: string }>,
  options: NextEditOptions = {},
): readonly NextEditPrediction[] {
  const includeSecondHop = options.includeSecondHop ?? false;
  const maxPredictions = options.maxPredictions ?? DEFAULT_NEXT_EDIT_MAX_PREDICTIONS;

  const callers = findCallers(map, edited);
  const callees = findCallees(map, edited);
  const sameFile = findSameFileNeighbours(map, edited);

  const predictions: NextEditPrediction[] = [
    ...callers.map((c) => ({
      filePath: c.filePath,
      symbol: c.symbol,
      reason: `caller of ${edited.symbol} (likely to need the same edit)`,
      kind: "caller" as const,
      proximity: 1,
    })),
    ...callees.map((c) => ({
      filePath: c.filePath,
      symbol: c.symbol,
      reason: `callee of ${edited.symbol} (downstream of the edit)`,
      kind: "callee" as const,
      proximity: 1,
    })),
    ...sameFile.map((c) => ({
      filePath: c.filePath,
      symbol: c.symbol,
      reason: `co-located with ${edited.symbol} (often edited together)`,
      kind: "same-file-neighbour" as const,
      proximity: 1,
    })),
  ];

  if (includeSecondHop) {
    const firstHopSymbols = new Set<string>([
      ...callers.map((c) => c.symbol),
      ...callees.map((c) => c.symbol),
    ]);
    for (const firstHop of firstHopSymbols) {
      const firstHopFile = findSymbolFile(map, firstHop);
      if (firstHopFile === null) continue;
      const secondHopCallers = findCallers(map, { filePath: firstHopFile, symbol: firstHop });
      const secondHopCallees = findCallees(map, { filePath: firstHopFile, symbol: firstHop });
      for (const c of secondHopCallers) {
        predictions.push({
          filePath: c.filePath,
          symbol: c.symbol,
          reason: `caller of ${firstHop} (2-hop from ${edited.symbol})`,
          kind: "caller",
          proximity: 2,
        });
      }
      for (const c of secondHopCallees) {
        predictions.push({
          filePath: c.filePath,
          symbol: c.symbol,
          reason: `callee of ${firstHop} (2-hop from ${edited.symbol})`,
          kind: "callee",
          proximity: 2,
        });
      }
    }
  }

  // De-dup by (file, symbol, kind), keeping the highest proximity (lowest
  // number = nearest). Then sort by proximity asc, then by file path.
  const seen = new Set<string>();
  const deduped: NextEditPrediction[] = [];
  for (const p of predictions) {
    const key = `${p.filePath}::${p.symbol}::${p.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  deduped.sort((a, b) => {
    if (a.proximity !== b.proximity) return a.proximity - b.proximity;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });
  return deepFreeze(deduped.slice(0, maxPredictions));
}

/**
 * Pick the deduped file list from a set of predictions. This is the
 * list the editor passes to its prefetch hint.
 */
export function pickPrefetchFiles(
  predictions: readonly NextEditPrediction[],
  maxFiles: number = DEFAULT_NEXT_EDIT_MAX_FILES,
): readonly string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const p of predictions) {
    if (seen.has(p.filePath)) continue;
    seen.add(p.filePath);
    files.push(p.filePath);
    if (files.length >= maxFiles) break;
  }
  return deepFreeze(files);
}

// --- internals ------------------------------------------------------------

/** Find files that import the edited symbol's module (callers). */
function findCallers(
  map: RepositoryMap,
  edited: Readonly<{ filePath: string; symbol: string }>,
): readonly { filePath: string; symbol: string }[] {
  const out: Array<{ filePath: string; symbol: string }> = [];
  // The edited file's exported symbol name is what callers import. We
  // find callers by walking the import graph: any module that imports
  // from `edited.filePath` is a caller of every symbol it imports.
  for (const module of map.modules) {
    if (module.path === edited.filePath) continue;
    for (const imp of module.imports) {
      if (imp.resolvedPath !== edited.filePath) continue;
      for (const name of imp.importedNames) {
        if (name === edited.symbol || name === "default") {
          // Find the calling symbol in this module — the function that
          // uses the imported name. We approximate by emitting the
          // module's largest function (the likely entry point).
          const caller = pickLikelyCaller(module);
          if (caller !== null) {
            out.push({ filePath: module.path, symbol: caller });
          }
        }
      }
    }
  }
  return out;
}

/** Find files that the edited symbol's module imports (callees). */
function findCallees(
  map: RepositoryMap,
  edited: Readonly<{ filePath: string; symbol: string }>,
): readonly { filePath: string; symbol: string }[] {
  const out: Array<{ filePath: string; symbol: string }> = [];
  const editedModule = map.modules.find((m) => m.path === edited.filePath);
  if (editedModule === undefined) return out;
  for (const imp of editedModule.imports) {
    if (imp.resolvedPath === null) continue;
    for (const name of imp.importedNames) {
      out.push({ filePath: imp.resolvedPath, symbol: name });
    }
  }
  return out;
}

/** Find other functions in the same file (co-located — often edited together). */
function findSameFileNeighbours(
  map: RepositoryMap,
  edited: Readonly<{ filePath: string; symbol: string }>,
): readonly { filePath: string; symbol: string }[] {
  const out: Array<{ filePath: string; symbol: string }> = [];
  const editedModule = map.modules.find((m) => m.path === edited.filePath);
  if (editedModule === undefined) return out;
  for (const sym of editedModule.symbols) {
    if (sym.name === edited.symbol) continue;
    out.push({ filePath: edited.filePath, symbol: sym.name });
  }
  return out;
}

/** Find the file path of a symbol by name (first match). */
function findSymbolFile(map: RepositoryMap, symbol: string): string | null {
  for (const m of map.modules) {
    for (const s of m.symbols) {
      if (s.name === symbol) return m.path;
    }
  }
  return null;
}

/** Pick the largest symbol in a module as the likely caller (entry point). */
function pickLikelyCaller(module: ModuleInfo): string | null {
  // Use the largest exported symbol (a heuristic from EXP442: the
  // largest function is the most likely to call the imported symbol).
  // SymbolInfo doesn't carry a body-size field; we use parameterCount
  // as a proxy (functions with more parameters tend to be larger and
  // more central — the "entry point" of the module). The heuristic
  // degrades gracefully: ties resolve to the first declared symbol.
  let best: SymbolInfo | null = null;
  let bestScore = -1;
  for (const s of module.symbols) {
    if (!s.exported) continue;
    const score = s.parameterCount + 1;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  if (best !== null) return best.name;
  // No exported symbol — fall back to the first symbol of any kind.
  return module.symbols[0]?.name ?? null;
}
