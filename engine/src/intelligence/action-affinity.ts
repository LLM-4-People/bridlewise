// src/intelligence/action-affinity.ts
//
// Action-affinity class system for symbol search re-ranking — EXP473
// fix for the EXP460 H6/H7 findings:
// - H6: "Vague ranking (60.9%) — wrong function picked within the
// right module (same-verb bonus over-favors literal match)"
// - H7: "Findall representative (58.1%) — wrong top-1 in quick-view
// (action-affinity boost doesn't discriminate within class)"
//
// The fix (per EXP460's EXPERIMENT.md): a verb-class system that maps
// query verbs + function verbs to action classes. When the query verb
// and the function verb are SAME-CLASS but DIFFERENT verbs, treat as
// EQUAL (no same-verb bonus — fixes H6). When the query verb and
// function verb are the SAME verb, give a same-verb bonus (preserves
// the disambiguation power for findall — fixes H7).
//
// Research sources:
// - EXP460 (`search-10x`): the action-affinity class system, applied
// at ranking time after the BM25 / fuzzy name match. The fix
// narrows the same-verb bonus to literal verb matches only.
// - EXP455 merge manifest: H6/H7 documented as accuracy limitations
// requiring tuning changes; EXP460 identified the exact fix.
//
// Public API:
// - `actionClassFor(verb)` → the action class ("parse", "read", etc.)
// - `rankWithActionAffinity(results, query)` → re-ranked results
// - `ACTION_CLASS_VERBS` → the canonical class → verbs mapping
//
// No code extracted from external sources; the verb→class mapping is
// the EXP460 design (a small, hand-curated mapping of common JS/TS
// verbs to action classes). Per "no static constants other
// than configurables": the mapping is a frozen canonical constant
// here (the single owner); future extensions add a `customClasses`
// option to `ActionAffinityOptions`.

import { deepFreeze } from "../kernel/integrity.ts";
import type { SymbolSearchResult } from "./intelligence-types.ts";
import { resolveActionAffinityConfig } from "./action-affinity-config.ts";

/** Action classes — the canonical set per EXP460. */
export type ActionClass =
  | "parse" // parse, read, scan, lex, tokenize
  | "write" // write, save, persist, store, set, update
  | "search" // search, find, lookup, query, locate
  | "compute" // compute, calculate, evaluate, process, transform
  | "validate" // validate, check, verify, assert, ensure
  | "render" // render, display, show, paint, draw
  | "lifecycle" // init, create, destroy, dispose, close, open
  | "communicate" // send, receive, emit, listen, broadcast, notify
  | "control" // run, execute, start, stop, pause, resume
  | "unknown"; // fallback for unrecognized verbs

/** The canonical verb → action-class mapping (single owner). */
const ACTION_CLASS_VERBS: Readonly<Record<ActionClass, readonly string[]>> = deepFreeze({
  parse: ["parse", "read", "scan", "lex", "tokenize", "consume", "deserialize", "decode", "extract"],
  write: ["write", "save", "persist", "store", "set", "update", "create", "build", "add", "insert", "put", "commit", "encode"],
  search: ["search", "find", "lookup", "query", "locate", "get", "fetch", "resolve", "discover", "identify"],
  compute: ["compute", "calculate", "evaluate", "process", "transform", "convert", "map", "reduce", "filter", "aggregate", "fold"],
  validate: ["validate", "check", "verify", "assert", "ensure", "guard", "test", "validate"],
  render: ["render", "display", "show", "paint", "draw", "format", "stringify", "print"],
  lifecycle: ["init", "create", "destroy", "dispose", "close", "open", "reset", "teardown", "setup", "boot", "shutdown"],
  communicate: ["send", "receive", "emit", "listen", "broadcast", "notify", "publish", "subscribe", "request", "respond"],
  control: ["run", "execute", "start", "stop", "pause", "resume", "schedule", "dispatch", "trigger", "invoke"],
  unknown: [],
});

/** Reverse map: verb → action class (computed once at module load). */
const VERB_TO_CLASS: ReadonlyMap<string, ActionClass> = (() => {
  const m = new Map<string, ActionClass>();
  for (const cls of Object.keys(ACTION_CLASS_VERBS) as ActionClass[]) {
    for (const v of ACTION_CLASS_VERBS[cls]) {
      m.set(v.toLowerCase(), cls);
    }
  }
  return deepFreezeMap(m);
})();

function deepFreezeMap<K, V>(m: Map<K, V>): ReadonlyMap<K, V> {
  return m as ReadonlyMap<K, V>;
}

/**
 * Look up the action class for a verb. Returns "unknown" if the verb
 * is not in the canonical mapping.
 */
export function actionClassFor(verb: string): ActionClass {
  return VERB_TO_CLASS.get(verb.toLowerCase()) ?? "unknown";
}

/**
 * Extract the leading verb from a function name or query string.
 * camelCase: `parseStringLiteral` → `parse`
 * snake_case: `parse_string_literal` → `parse`
 * kebab-case: `parse-string-literal` → `parse`
 * single word: `parse` → `parse`
 *
 * Returns the lowercase leading verb, or "" if the input is empty.
 */
export function extractVerb(name: string): string {
  if (name.length === 0) return "";
  // Split on the first non-alpha character or case boundary.
  const match = name.match(/^([a-z]+|[A-Z][a-z]+)/);
  if (match === null) return "";
  return match[1]!.toLowerCase();
}

export type ActionAffinityOptions = Readonly<{
  /**
   * Bonus for a same-verb match (query verb === function verb). Default
   * 0.15 — high enough to disambiguate within the same class, low enough
   * not to dominate name/fuzzy match. Per EXP460 H6 fix: this bonus is
   * NOT given for same-class-different-verb (only for the literal same
   * verb), so it stops over-favoring literal matches in vague queries.
   */
  sameVerbBonus?: number;
  /**
   * Bonus for a same-class match (query verb and function verb in the
   * same action class). Default 0.05 — smaller than the same-verb
   * bonus so the disambiguation within a class still favors the
   * literal verb match.
   */
  sameClassBonus?: number;
  /** Verb extracted from the query (overrides `extractVerb(query)`). */
  queryVerb?: string;
}>;

// R44: the tunable defaults are resolved through the canonical
// `resolveActionAffinityConfig` owner (validates bounds at the trust
// boundary). The local aliases keep the existing call-site
// shape while making the resolver USED (not a dead export).
const ACTION_AFFINITY_DEFAULT_SAME_VERB_BONUS = resolveActionAffinityConfig().sameVerbBonus;
const ACTION_AFFINITY_DEFAULT_SAME_CLASS_BONUS = resolveActionAffinityConfig().sameClassBonus;

/**
 * Re-rank symbol search results by action affinity. The re-ranking is
 * a STABLE sort: results with the same action-affinity score keep
 * their original BM25/fuzzy order.
 *
 * The re-ranking is additive: the original `score` field is preserved;
 * the action-affinity bonus is added to it. The caller can compare the
 * pre- and post-re-ranking order to see the effect.
 *
 * Per the EXP460 H6 fix: the same-verb bonus is given ONLY when the
 * query verb EXACTLY matches the function verb (both lowercase). A
 * same-class-different-verb match gets the smaller `sameClassBonus`,
 * NOT the full `sameVerbBonus`. This stops the same-verb bonus from
 * over-favoring literal matches in vague queries (the H6 root cause).
 *
 * Per the EXP460 H7 fix: the same-verb bonus DOES discriminate within
 * a class (the `sameVerbBonus` is bigger than the `sameClassBonus`),
 * so a function whose verb literally matches the query verb ranks
 * above a function whose verb is merely in the same class. This
 * gives the findall representative selection the disambiguation
 * power it needs (the H7 root cause was the absence of within-class
 * discrimination).
 */
export function rankWithActionAffinity(
  results: readonly SymbolSearchResult[],
  query: string,
  options: ActionAffinityOptions = {},
): readonly SymbolSearchResult[] {
  const sameVerbBonus = options.sameVerbBonus ?? ACTION_AFFINITY_DEFAULT_SAME_VERB_BONUS;
  const sameClassBonus = options.sameClassBonus ?? ACTION_AFFINITY_DEFAULT_SAME_CLASS_BONUS;
  const queryVerb = (options.queryVerb ?? extractVerb(query)).toLowerCase();
  const queryClass = actionClassFor(queryVerb);

  if (queryVerb.length === 0 || queryClass === "unknown") {
    // No query verb or unknown class — no re-ranking. Return as-is.
    return results;
  }

  // Compute the action-affinity bonus for each result.
  const withBonus = results.map((r) => {
    const fnVerb = extractVerb(r.symbol.name).toLowerCase();
    if (fnVerb.length === 0) {
      return { result: r, bonus: 0 };
    }
    const fnClass = actionClassFor(fnVerb);
    if (fnVerb === queryVerb) {
      return { result: r, bonus: sameVerbBonus };
    }
    if (fnClass === queryClass) {
      return { result: r, bonus: sameClassBonus };
    }
    return { result: r, bonus: 0 };
  });

  // Stable sort by score desc (the bonus is added to the existing score).
  // Stable: a.sort is NOT stable in modern engines; we use a decorated
  // sort with the original index to preserve order for ties.
  const indexed = withBonus.map((w, i) => ({ ...w, originalIndex: i }));
  indexed.sort((a, b) => {
    const aScore = a.result.score + a.bonus;
    const bScore = b.result.score + b.bonus;
    if (aScore !== bScore) return bScore - aScore;
    return a.originalIndex - b.originalIndex;
  });

  // The bonus is carried into the score that comes back, so the order the
  // caller sees is explained by the numbers the caller sees. Returning the
  // pre-bonus score sorted by the post-bonus one produced a list that looked
  // mis-sorted to anyone who read it — and `matchedFields` records that
  // affinity is why, rather than leaving the reader to infer it.
  return deepFreeze(
    indexed.map((w) =>
      w.bonus === 0
        ? w.result
        : {
            ...w.result,
            score: w.result.score + w.bonus,
            matchedFields: deepFreeze([...w.result.matchedFields, "action-affinity"]),
          },
    ),
  );
}

/**
 * Pick the best representative from a set of search results — the EXP473
 * fix for the EXP460 H7 finding. The representative is the top-1 after
 * action-affinity re-ranking. The "subject keywords" tiebreaker
 * (per EXP460's H7 fix suggestion) prefers the function whose name
 * contains MORE of the query's subject keywords.
 *
 * The subject keywords are the non-verb tokens in the query, lowercased.
 * For example, for "read JSX tokens" the subject keywords are "jsx"
 * and "token" (after removing the verb "read"). A function named
 * `jsxReadToken` contains BOTH keywords; a function named `jsxReadString`
 * contains only "jsx" — so `jsxReadToken` wins.
 */
export function pickRepresentative(
  results: readonly SymbolSearchResult[],
  query: string,
  options: ActionAffinityOptions = {},
): SymbolSearchResult | null {
  if (results.length === 0) return null;
  const reRanked = rankWithActionAffinity(results, query, options);
  if (reRanked.length === 0) return null;
  // Subject-keyword tiebreaker: extract non-verb tokens from the query
  // and count how many appear in each candidate's name (lowercase).
  const subjectKeywordBonus = resolveActionAffinityConfig().subjectKeywordBonus;
  const subjectKeywords = extractSubjectKeywords(query);
  if (subjectKeywords.length === 0) {
    return reRanked[0] ?? null;
  }
  // Re-sort with the subject-keyword count as a tiebreaker.
  const withSubject = reRanked.map((r) => {
    const fnLower = r.symbol.name.toLowerCase();
    let count = 0;
    for (const kw of subjectKeywords) {
      if (nameContainsKeyword(fnLower, kw)) count += 1;
    }
    return { result: r, subjectCount: count };
  });
  withSubject.sort((a, b) => {
    // First: action-affinity-adjusted score (already in `result.score`
    // since rankWithActionAffinity is called first... but the bonus is
    // additive to the original score, so we use the original score +
    // subject count as the comparator).
    const aScore = a.result.score + a.subjectCount * subjectKeywordBonus;
    const bScore = b.result.score + b.subjectCount * subjectKeywordBonus;
    return bScore - aScore;
  });
  return withSubject[0]?.result ?? null;
}

/** Extract non-verb subject keywords from a query. */
function extractSubjectKeywords(query: string): readonly string[] {
  if (query.length === 0) return [];
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  // Remove the leading verb (if it's a recognized verb).
  if (tokens.length > 0) {
    const firstVerb = tokens[0]!;
    if (VERB_TO_CLASS.has(firstVerb)) {
      return tokens.slice(1);
    }
  }
  return tokens;
}

/**
 * Check whether a function name contains a subject keyword (with
 * naive plural/singular stemming — "tokens" matches "token" and
 * vice versa). Pure function.
 */
function nameContainsKeyword(functionNameLower: string, keyword: string): boolean {
  if (functionNameLower.includes(keyword)) return true;
  // Plural ↔ singular stemming (drop a trailing "s" from either side).
  if (keyword.endsWith("s") && functionNameLower.includes(keyword.slice(0, -1))) return true;
  if (functionNameLower.includes(`${keyword}s`)) return true;
  return false;
}
