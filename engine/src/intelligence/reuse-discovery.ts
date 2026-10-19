import { deepFreeze } from "../kernel/integrity.ts";
import type {
  DuplicateGroup,
  ModuleInfo,
  ReuseCandidate,
  ReuseQuery,
  RepositoryMap,
  SymbolInfo,
  SymbolKind,
} from "./intelligence-types.ts";
import { fuzzyMatch } from "./symbol-search.ts";

/**
 * Reuse discovery engine.
 *
 * Implements the mandatory pre-modification reuse gate (delivery-map item 7,
 * REQ-005): before any modification, search for existing logic that could be
 * reused or adapted.
 *
 * Three discovery modes:
 *
 * 1. **Find reuse candidates**: given a query (name, kind, signature), find
 * existing symbols that are similar enough to reuse or adapt. Similarity is
 * scored by name fuzzy match, kind match, parameter-count match, and
 * directory proximity.
 *
 * 2. **Find duplicates**: detect symbols with the same name and kind across
 * multiple files. These are potential duplication candidates that should
 * be consolidated under one canonical owner.
 *
 * 3. **Suggest canonical owner**: given a concept name, suggest which module
 * should own it based on the architecture manifest's layer/realm/owner
 * metadata. Lower layers (trusted-kernel, domain) are preferred over
 * higher layers (interface, verification).
 *
 * Per the root policy invariant `retrievalScoreAsTruthAllowed: false`, reuse
 * candidates are discovery evidence only.
 */

export function findReuseCandidates(
  map: RepositoryMap,
  query: ReuseQuery,
): readonly ReuseCandidate[] {
  const candidates: ReuseCandidate[] = [];
  for (const module of map.modules) {
    if (query.directory !== null && !module.path.startsWith(query.directory)) continue;
    for (const symbol of module.symbols) {
      const result = scoreReuseCandidate(module, symbol, query);
      if (result !== null) candidates.push(result);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return deepFreeze(candidates.slice(0, query.limit));
}

function scoreReuseCandidate(
  module: ModuleInfo,
  symbol: SymbolInfo,
  query: ReuseQuery,
): ReuseCandidate | null {
  if (query.kind !== null && symbol.kind !== query.kind) return null;
  const reasons: string[] = [];
  let score = 0;
  if (query.name !== null) {
    const fuzzy = fuzzyMatch(symbol.name.toLowerCase(), query.name.toLowerCase());
    if (fuzzy === null) return null;
    score += fuzzy;
    if (fuzzy > 0.5) reasons.push("name-similar");
  }
  if (query.kind !== null && symbol.kind === query.kind) {
    score += 0.2;
    reasons.push("kind-match");
  }
  if (query.signature !== null) {
    const sigScore = matchSignature(symbol, query.signature);
    if (sigScore > 0) {
      score += sigScore;
      reasons.push("signature-match");
    }
  }
  if (symbol.exported) {
    score += 0.05;
    reasons.push("exported");
  }
  if (module.architectureLayer !== null) {
    const layerBonus = layerReuseBonus(module.architectureLayer);
    if (layerBonus > 0) {
      score += layerBonus;
      reasons.push(`layer:${module.architectureLayer}`);
    }
  }
  return {
    symbol,
    filePath: module.path,
    score,
    reasons: deepFreeze(reasons),
  };
}

function matchSignature(symbol: SymbolInfo, signature: string): number {
  const paramMatch = signature.match(/(\d+)\s*params?/i);
  if (paramMatch && symbol.parameterCount === parseInt(paramMatch[1]!, 10)) {
    return 0.15;
  }
  if (signature === "async" && symbol.async) return 0.1;
  if (signature === "exported" && symbol.exported) return 0.1;
  return 0;
}

function layerReuseBonus(layer: string): number {
  const bonuses: Readonly<Record<string, number>> = {
    "trusted-kernel": 0.15,
    "domain": 0.12,
    "ports": 0.10,
    "infrastructure": 0.08,
    "application": 0.05,
    "interface": 0.03,
    "verification": 0.02,
  };
  return bonuses[layer] ?? 0;
}

export function findDuplicates(
  map: RepositoryMap,
  options: Readonly<{ minCount?: number; kinds?: readonly SymbolKind[] }> = {},
): readonly DuplicateGroup[] {
  const minCount = options.minCount ?? 2;
  const kindFilter = options.kinds ? new Set(options.kinds) : null;
  const groups = new Map<string, SymbolInfo[]>();
  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      if (kindFilter !== null && !kindFilter.has(symbol.kind)) continue;
      if (!symbol.exported) continue;
      const key = `${symbol.name}:${symbol.kind}`;
      const list = groups.get(key);
      if (list === undefined) {
        groups.set(key, [symbol]);
      } else {
        list.push(symbol);
      }
    }
  }
  const duplicates: DuplicateGroup[] = [];
  for (const [key, symbols] of groups) {
    if (symbols.length < minCount) continue;
    const [name, kind] = key.split(":");
    const locations = symbols.map((s) => s.location);
    duplicates.push({
      name: name!,
      kind: kind as SymbolKind,
      locations: deepFreeze(locations),
      count: symbols.length,
    });
  }
  return deepFreeze(duplicates.sort((a, b) => b.count - a.count));
}

export type OwnerSuggestion = Readonly<{
  concept: string;
  suggestedPath: string | null;
  suggestedOwner: string | null;
  suggestedLayer: string | null;
  candidates: readonly Readonly<{
    filePath: string;
    owner: string | null;
    layer: string | null;
    score: number;
  }>[];
}>;

export function suggestCanonicalOwner(
  map: RepositoryMap,
  concept: string,
): OwnerSuggestion {
  const lowerConcept = concept.toLowerCase();
  const candidates: Readonly<{
    filePath: string;
    owner: string | null;
    layer: string | null;
    score: number;
  }>[] = [];
  for (const module of map.modules) {
    let bestScore = 0;
    for (const symbol of module.symbols) {
      const fuzzy = fuzzyMatch(symbol.name.toLowerCase(), lowerConcept);
      if (fuzzy === null) continue;
      const layerBonus = module.architectureLayer ? layerReuseBonus(module.architectureLayer) : 0;
      const totalScore = fuzzy + layerBonus + (symbol.exported ? 0.05 : 0);
      bestScore = Math.max(bestScore, totalScore);
    }
    if (bestScore > 0) {
      candidates.push(Object.freeze({
        filePath: module.path,
        owner: module.architectureOwner,
        layer: module.architectureLayer,
        score: bestScore,
      }));
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0] ?? null;
  return deepFreeze({
    concept,
    suggestedPath: top?.filePath ?? null,
    suggestedOwner: top?.owner ?? null,
    suggestedLayer: top?.layer ?? null,
    candidates: deepFreeze(candidates.slice(0, 10)),
  });
}

export function findSimilarByBehavior(
  map: RepositoryMap,
  referenceSymbol: SymbolInfo,
  limit: number = 20,
): readonly ReuseCandidate[] {
  const candidates: ReuseCandidate[] = [];
  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      if (symbol === referenceSymbol) continue;
      if (symbol.name === referenceSymbol.name && symbol.kind === referenceSymbol.kind) continue;
      let score = 0;
      const reasons: string[] = [];
      if (symbol.kind === referenceSymbol.kind) {
        score += 0.2;
        reasons.push("same-kind");
      }
      if (symbol.parameterCount === referenceSymbol.parameterCount && referenceSymbol.parameterCount > 0) {
        score += 0.15;
        reasons.push("same-arity");
      }
      if (symbol.async === referenceSymbol.async && referenceSymbol.async) {
        score += 0.1;
        reasons.push("both-async");
      }
      const fuzzy = fuzzyMatch(symbol.name.toLowerCase(), referenceSymbol.name.toLowerCase());
      if (fuzzy !== null && fuzzy > 0.3) {
        score += fuzzy;
        reasons.push("name-similar");
      }
      if (score > 0.3) {
        candidates.push({ symbol, filePath: module.path, score, reasons: deepFreeze(reasons) });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return deepFreeze(candidates.slice(0, limit));
}

export function findExportedByName(
  map: RepositoryMap,
  name: string,
): readonly Readonly<{ symbol: SymbolInfo; filePath: string }>[] {
  const lowerName = name.toLowerCase();
  const results: Readonly<{ symbol: SymbolInfo; filePath: string }>[] = [];
  for (const module of map.modules) {
    for (const exp of module.exports) {
      if (exp.name.toLowerCase() === lowerName) {
        const symbol = module.symbols.find((s) => s.name === exp.localName && s.exported);
        if (symbol) {
          results.push(Object.freeze({ symbol, filePath: module.path }));
        }
      }
    }
  }
  return deepFreeze(results);
}
