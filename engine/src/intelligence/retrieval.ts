import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type {
  DependencyGraph,
  ModuleInfo,
  RepositoryMap,
} from "./intelligence-types.ts";
import { fuzzyMatch } from "./symbol-search.ts";
import { resolveImportSpecifier } from "./dependency-graph.ts";
import { DEFAULT_EXP474_LEXICAL_OVERLAP_CAP, DEFAULT_EXP474_LEXICAL_PER_WORD, DEFAULT_EXP474_SINGULAR_MIN_LENGTH, DEFAULT_EXP474_CLASS_MATCH_MIN_LENGTH } from "./intelligence-config.ts";

/**
 * Language-agnostic codebase-file retrieval — phrase n-gram matching,
 * slot allocation (replaces Reciprocal Rank Fusion), method-level extraction,
 * and package/directory co-occurrence.
 *
 * The ranking reserves fixed "slots" for import-connected files instead of
 * applying additive RRF boosts, which guarantees representation for
 * structurally-relevant files that a pure semantic ranking buries.
 *
 * Production adaptations (no new runtime deps;
 * reuse the existing RepositoryMap + DependencyGraph):
 *
 * **Semantic score → lexical score.** An embedding model would add a runtime
 * dependency, so the semantic score is replaced by a
 * language-agnostic lexical score: the max `fuzzyMatch` of the query against
 * every symbol name in a module, plus a query-word / symbol-word overlap
 * bonus. Slot allocation works on any ranking, so substituting a lexical
 * rank for an embedding rank preserves the slot-allocation guarantee.
 * **Method-level extraction.** `module.symbols` (extracted by the
 * tree-sitter / regex symbol extractor across every registered language)
 * feeds the phrase n-grams directly — no re-parsing of `def`/`class`
 * declarations from source.
 * **Import graph.** `buildDependencyGraph(map)` (resolved file-path
 * adjacency, language-agnostic via `resolveImportSpecifier`) already handles
 * relative specifiers, extension inference, and index files.
 * **Package/directory co-occurrence.** Files in a directory (or parent
 * directory) where 2+ stage-1 files live are co-occurring — filesystem-based,
 * not language-specific.
 *
 * Per the root policy invariant `retrievalScoreAsTruthAllowed: false`, results
 * are discovery evidence only.
 *
 * Configurables: every user-facing ranking knob (boost, slot count, and
 * length threshold) is an `Exp474RetrievalOptions` field, defaulted and
 * validated by `resolveExp474RetrievalConfig` below — the single owner.
 * Callers (including the web `harness-config.ts` reader) pass what the
 * operator set and take the rest from here, so an unset knob has one answer
 * rather than one per reader. The internal lexical-scoring weights (overlap
 * cap, per-word weight, singularization length, class-match minimum) are owned
 * by `intelligence-config.ts` (the single intelligence-defaults owner). This
 * module carries NO hardcoded configurables of its own.
 */

export type Exp474RetrievalOptions = Readonly<{
  /** Boost added to a file's stage-1 score when a query class-name matches. */
  readonly classBoost: number;
  /** Boost when the query matches a file's basename (e.g. `basic.py`). */
  readonly basenameBoost: number;
  /** Boost when the query matches a path segment of the file. */
  readonly pathSegBoost: number;
  /** Boost when a query phrase n-gram matches a file's symbol n-grams. */
  readonly phraseBoost: number;
  /** Stage-1 top-K: how many files the lexical+boost ranking keeps. */
  readonly stage1K: number;
  /** Final result cap (total files returned). */
  readonly finalK: number;
  /** Slots reserved for import-expanded files (files imported by stage-1 core). */
  readonly importSlots: number;
  /** Slots reserved for reverse-import-expanded files (files that import stage-1 core). */
  readonly reverseSlots: number;
  /** Slots reserved for package/directory co-occurrence files. */
  readonly packageSlots: number;
  /** Number of stage-1 core files (the seed for import/reverse expansion). */
  readonly stage1CoreK: number;
  /** A phrase n-gram matches only if <= this many files share it (specificity cap). */
  readonly phraseMaxFiles: number;
  /** A basename matches only if <= this many files share it (specificity cap). */
  readonly basenameMaxFiles: number;
  /** A path segment matches only if <= this many files share it (specificity cap). */
  readonly pathSegMaxFiles: number;
  /** Minimum basename length to index (short basenames are too generic). */
  readonly minBasenameLength: number;
  /** Minimum path-segment length to index. */
  readonly minPathSegLength: number;
  /** Minimum query-word length to contribute to matching. */
  readonly minQueryWordLength: number;
  /** Minimum co-occurrence directory hit count for a package to qualify. */
  readonly packageMinDirHits: number;
  /** Semantic relevance floor for import/reverse candidates (filters utility files). */
  readonly importSemanticFloor: number;
  /** Per-class multiplier applied to the importer score (classes are stronger signals). */
  readonly importClassMultiplier: number;
}>;

/**
 * The frozen defaults for every ranking knob above.
 *
 * These nineteen numbers used to live as literals in the web server's config
 * reader, which the comment above this type described as "the single owner" —
 * and it was, for a value the harness also has to be able to resolve. A
 * default belongs with the thing it is a default FOR, because a default kept
 * anywhere else is a second answer to "what happens when this is unset", and
 * the two answers only have to agree until someone edits one of them.
 */
const DEFAULT_EXP474_RETRIEVAL_CONFIG: Exp474RetrievalOptions = deepFreeze({
  classBoost: 0.15,
  basenameBoost: 0.1,
  pathSegBoost: 0.1,
  phraseBoost: 0.25,
  stage1K: 8,
  finalK: 15,
  importSlots: 4,
  reverseSlots: 1,
  packageSlots: 2,
  stage1CoreK: 4,
  phraseMaxFiles: 5,
  basenameMaxFiles: 3,
  pathSegMaxFiles: 10,
  minBasenameLength: 4,
  minPathSegLength: 5,
  minQueryWordLength: 3,
  packageMinDirHits: 2,
  importSemanticFloor: 0.3,
  importClassMultiplier: 0.5,
});

/**
 * Every knob name this layer answers to, derived from the defaults so the
 * list cannot fall behind them. The config document's schema asks for this
 * so a misspelled knob is refused at the write gate instead of being
 * accepted, dropped by the reader, and never applied.
 */
export const EXP474_RETRIEVAL_SETTING_NAMES: readonly string[] =
  deepFreeze(Object.keys(DEFAULT_EXP474_RETRIEVAL_CONFIG).sort());

/**
 * What an operator set, as it appears in the configuration document: the
 * shared `codeIntelligence.retrieval` numeric map. Shared, because two layers
 * answer to names in it — these retrieval knobs and the symbol-ranking knobs
 * owned by `intelligence-config.ts`.
 */
export type Exp474RetrievalOverrides = Readonly<Record<string, number>>;

/**
 * Resolve the retrieval knobs by merging what the operator set onto the frozen
 * defaults, validating each value.
 *
 * Names belonging to the SIBLING layer are passed over rather than refused,
 * because "unknown to this resolver" is not the same statement as "unknown".
 * The name that is genuinely unrecognised is refused one level up, by the
 * config document's schema, which is the only place that sees both layers'
 * vocabularies at once — and which refuses it before a byte reaches disk,
 * rather than at whichever read site happens to run first.
 */
export function resolveExp474RetrievalConfig(
  overrides: Exp474RetrievalOverrides = {},
): Exp474RetrievalOptions {
  const resolved: Record<string, number> = { ...DEFAULT_EXP474_RETRIEVAL_CONFIG };
  for (const key of EXP474_RETRIEVAL_SETTING_NAMES) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new InputError(
        `${key} must be a finite non-negative number`,
        "exp474_retrieval_config_invalid",
      );
    }
    resolved[key] = value;
  }
  return deepFreeze(resolved) as unknown as Exp474RetrievalOptions;
}

export type Exp474RetrievalHit = Readonly<{
  readonly path: string;
  readonly score: number;
  readonly stage: "stage1" | "import" | "reverse-import" | "package-cooccurrence" | "stage1-fill";
  readonly reasons: readonly string[];
}>;

export type Exp474RetrievalResult = Readonly<{
  readonly query: string;
  readonly files: readonly Exp474RetrievalHit[];
  readonly debug: readonly string[];
}>;

// ── Identifier splitting + n-grams (ported from run-v16.mts) ──
// Language-agnostic: works on camelCase, snake_case, kebab-case, PascalCase,
// and SCREAMING_SNAKE identifiers by splitting on word boundaries then
// singularizing each token.

function splitIdent(name: string): string[] {
  return name
    .replace(/__/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function singular(word: string): string {
  return word.length > DEFAULT_EXP474_SINGULAR_MIN_LENGTH && word.endsWith("s") ? word.slice(0, -1) : word;
}

function ngrams(words: string[], n: number): string[] {
  const result: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    result.push(words.slice(i, i + n).map((w) => singular(w.toLowerCase())).join(" "));
  }
  return result;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function basenameNoExt(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return (dot === -1 ? file : file.slice(0, dot)).toLowerCase();
}

function looksLikeClassName(name: string): boolean {
  return name.length > 0 && name[0] === name[0]!.toUpperCase() && name[0] !== name[0]!.toLowerCase();
}

// ── Index (built once per call from the RepositoryMap) ──

interface Exp474Index {
  readonly modules: readonly ModuleInfo[];
  readonly classToFile: ReadonlyMap<string, string>;
  readonly basenameToFiles: ReadonlyMap<string, readonly string[]>;
  readonly pathSegToFiles: ReadonlyMap<string, readonly string[]>;
  readonly phraseToFiles: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dirToFiles: ReadonlyMap<string, readonly string[]>;
}

function buildIndex(map: RepositoryMap, options: Exp474RetrievalOptions): Exp474Index {
  const classToFile = new Map<string, string>();
  const basenameToFiles = new Map<string, string[]>();
  const pathSegToFiles = new Map<string, string[]>();
  const phraseToFiles = new Map<string, Set<string>>();
  const dirToFiles = new Map<string, string[]>();

  function addPhrase(phrase: string, file: string): void {
    const set = phraseToFiles.get(phrase);
    if (set === undefined) phraseToFiles.set(phrase, new Set([file]));
    else set.add(file);
  }

  for (const mod of map.modules) {
    const dir = dirname(mod.path);
    if (dir.length > 0) {
      const list = dirToFiles.get(dir);
      if (list === undefined) dirToFiles.set(dir, [mod.path]);
      else list.push(mod.path);
    }
    const bname = basenameNoExt(mod.path);
    if (bname.length >= options.minBasenameLength) {
      const list = basenameToFiles.get(bname);
      if (list === undefined) basenameToFiles.set(bname, [mod.path]);
      else list.push(mod.path);
    }
    for (const seg of mod.path.split("/")) {
      const segLower = seg.replace(/\.[^/.]+$/, "").toLowerCase();
      if (segLower.length >= options.minPathSegLength) {
        const list = pathSegToFiles.get(segLower);
        if (list === undefined) pathSegToFiles.set(segLower, [mod.path]);
        else list.push(mod.path);
      }
    }
    for (const sym of mod.symbols) {
      if (sym.kind === "class" && !sym.name.startsWith("__")) {
        classToFile.set(sym.name, mod.path);
      }
      // Method-level extraction: symbol names (functions, methods, classes,
      // etc.) feed the phrase n-grams. Names starting with __ are private
      // dunder hooks — too generic to index.
      if (sym.name.startsWith("__")) continue;
      const words = splitIdent(sym.name);
      for (const ng of ngrams(words, 2)) addPhrase(ng, mod.path);
      for (const ng of ngrams(words, 3)) addPhrase(ng, mod.path);
    }
  }

  return {
    modules: map.modules,
    classToFile,
    basenameToFiles,
    pathSegToFiles,
    phraseToFiles,
    dirToFiles,
  };
}

// ── Lexical semantic score (replaces embedding cosine similarity) ──
// Language-agnostic, no deps. Returns a score in [0, ~1.3]: the max fuzzy
// match of the full query against any symbol name in the module, plus a
// query-word / symbol-word overlap bonus. This is the ranking slot allocation
// operates on; it does not need to be a calibrated probability.

function queryWords(query: string, options: Exp474RetrievalOptions): string[] {
  return query
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9_]/g, ""))
    .filter((w) => w.length >= options.minQueryWordLength);
}

function lexicalScore(
  mod: ModuleInfo,
  query: string,
  queryWordList: readonly string[],
): number {
  let best = 0;
  for (const sym of mod.symbols) {
    if (sym.name.startsWith("__")) continue;
    const fuzzy = fuzzyMatch(sym.name.toLowerCase(), query.toLowerCase());
    if (fuzzy !== null && fuzzy > best) best = fuzzy;
  }
  if (queryWordList.length === 0) return best;
  const qset = new Set(queryWordList.map((w) => singular(w.toLowerCase())));
  let overlap = 0;
  for (const sym of mod.symbols) {
    if (sym.name.startsWith("__")) continue;
    for (const w of splitIdent(sym.name)) {
      if (qset.has(singular(w.toLowerCase()))) overlap += 1;
    }
  }
  // Overlap bonus decays so a file with many generic words can't drown out a
  // precise fuzzy match. Capped contribution owned by intelligence-config.ts
  // (DEFAULT_EXP474_LEXICAL_OVERLAP_CAP / DEFAULT_EXP474_LEXICAL_PER_WORD)
  // so this module carries NO hardcoded configurables of its own.
  return best + Math.min(DEFAULT_EXP474_LEXICAL_OVERLAP_CAP, overlap * DEFAULT_EXP474_LEXICAL_PER_WORD);
}

// ── Match helpers (ported from run-v16.mts, adapted to the index) ──

function classMatch(query: string, index: Exp474Index): Set<string> {
  const matched = new Set<string>();
  for (const word of query.split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9_]/g, ""))) {
    if (word.length >= DEFAULT_EXP474_CLASS_MATCH_MIN_LENGTH) {
      const file = index.classToFile.get(word);
      if (file !== undefined) matched.add(file);
    }
  }
  return matched;
}

function basenameMatch(query: string, index: Exp474Index, options: Exp474RetrievalOptions): Set<string> {
  const matched = new Set<string>();
  for (const word of query.split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9_]/g, "").toLowerCase())) {
    if (word.length < options.minBasenameLength) continue;
    for (const cand of [word, word + "s", word.endsWith("s") ? word.slice(0, -1) : word]) {
      const files = index.basenameToFiles.get(cand);
      if (files !== undefined && files.length <= options.basenameMaxFiles) {
        for (const f of files) matched.add(f);
      }
    }
  }
  return matched;
}

function pathSegMatch(query: string, index: Exp474Index, options: Exp474RetrievalOptions): Set<string> {
  const matched = new Set<string>();
  for (const word of query.split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9_]/g, "").toLowerCase())) {
    if (word.length < options.minPathSegLength) continue;
    for (const cand of [word, word + "s", word.endsWith("s") ? word.slice(0, -1) : word]) {
      const files = index.pathSegToFiles.get(cand);
      if (files !== undefined && files.length <= options.pathSegMaxFiles) {
        for (const f of files) matched.add(f);
      }
    }
  }
  return matched;
}

function phraseMatch(query: string, index: Exp474Index, options: Exp474RetrievalOptions): Set<string> {
  const matchedFiles = new Set<string>();
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9_]/g, "").toLowerCase())
    .filter((w) => w.length > 0);
  for (const ng of ngrams(words, 2)) {
    const files = index.phraseToFiles.get(ng);
    if (files !== undefined && files.size <= options.phraseMaxFiles) {
      for (const f of files) matchedFiles.add(f);
    }
  }
  for (const ng of ngrams(words, 3)) {
    const files = index.phraseToFiles.get(ng);
    if (files !== undefined && files.size <= options.phraseMaxFiles) {
      for (const f of files) matchedFiles.add(f);
    }
  }
  return matchedFiles;
}

// ── Import-edge detail: count classes vs functions imported from a target ──
// Reuses the experiment's heuristic (an imported name whose first char is
// uppercase is a class) so import expansion can weight class-heavy edges
// higher. The symbol extractor leaves `ImportInfo.resolvedPath` null, so the
// importer→target edge is resolved via the shared `resolveImportSpecifier`
// (reused from dependency-graph.ts; TS/JS specifiers, the same
// resolver the dependency graph uses, so class-weighting is consistent with
// the import graph the expansion stages operate on).
//
// Exported so the class-weighting regression guard can assert it counts
// classes directly (the bug: matching on resolvedPath always returned 0).

export function importClassCount(
  mod: ModuleInfo,
  targetPath: string,
  knownPaths: ReadonlySet<string>,
): number {
  let classes = 0;
  for (const imp of mod.imports) {
    if (imp.kind === "dynamic-import") continue;
    const resolved = resolveImportSpecifier(mod.path, imp.specifier, knownPaths);
    if (resolved !== targetPath) continue;
    for (const name of imp.importedNames) {
      if (looksLikeClassName(name)) classes += 1;
    }
  }
  return classes;
}

function dirParents(dir: string): string[] {
  const parts = dir.split("/");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// ── Public entry point: slot-allocation retrieval ──

export function retrieveRelevantFiles(
  map: RepositoryMap,
  graph: DependencyGraph,
  query: string,
  options: Exp474RetrievalOptions,
): Exp474RetrievalResult {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new InputError("Query is required", "intelligence_exp474_query_missing");
  }
  if (map.modules.length === 0) {
    return deepFreeze({ query, files: deepFreeze([]), debug: deepFreeze(["empty map"]) });
  }
  const debug: string[] = [];
  const index = buildIndex(map, options);
  const qWords = queryWords(query, options);
  const clsFiles = classMatch(query, index);
  const basenameFiles = basenameMatch(query, index, options);
  const pathSegFiles = pathSegMatch(query, index, options);
  const phraseFiles = phraseMatch(query, index, options);

  // Stage 1: lexical + boosts → top-K.
  const scored: { file: string; total: number; reasons: string[] }[] = [];
  for (const mod of index.modules) {
    const sem = lexicalScore(mod, query, qWords);
    let boost = 0;
    const reasons: string[] = [];
    if (clsFiles.has(mod.path)) { boost += options.classBoost; reasons.push("class-name"); }
    if (basenameFiles.has(mod.path)) { boost += options.basenameBoost; reasons.push("basename"); }
    if (pathSegFiles.has(mod.path)) { boost += options.pathSegBoost; reasons.push("path-seg"); }
    if (phraseFiles.has(mod.path)) { boost += options.phraseBoost; reasons.push("phrase-ngram"); }
    const total = sem + boost;
    if (total > 0) scored.push({ file: mod.path, total, reasons });
  }
  scored.sort((a, b) => b.total - a.total);
  const stage1 = scored.slice(0, options.stage1K).map((s) => s.file);
  if (stage1.length === 0) {
    return deepFreeze({ query, files: deepFreeze([]), debug: deepFreeze(["no stage1 hits"]) });
  }
  debug.push(`stage1: [${stage1.map((f) => f.split("/").pop()).join(", ")}]`);

  const stage1Core = stage1.slice(0, options.stage1CoreK);
  const stage1ScoreMap = new Map<string, number>();
  for (let i = 0; i < stage1Core.length; i++) {
    stage1ScoreMap.set(stage1Core[i]!, scored[i]!.total);
  }
  const stage1ReasonMap = new Map<string, string[]>();
  for (let i = 0; i < stage1.length; i++) {
    stage1ReasonMap.set(stage1[i]!, scored[i]!.reasons);
  }

  // Stage 2: import expansion — files imported by stage1 core, scored by
  // MAX importer score × (1 + classCount × multiplier), then × (floor + sem).
  const importCandidates = new Map<string, number>();
  const modByPath = new Map<string, ModuleInfo>();
  for (const mod of index.modules) modByPath.set(mod.path, mod);
  const knownPaths = new Set<string>(modByPath.keys());
  for (const f of stage1Core) {
    const fScore = stage1ScoreMap.get(f) ?? 0;
    const importer = modByPath.get(f);
    const forward = graph.forwardAdjacency.get(f);
    if (forward === undefined) continue;
    for (const imp of forward) {
      const classCount = importer !== undefined ? importClassCount(importer, imp, knownPaths) : 0;
      const classMultiplier = 1 + classCount * options.importClassMultiplier;
      const candidate = fScore * classMultiplier;
      importCandidates.set(imp, Math.max(importCandidates.get(imp) ?? 0, candidate));
    }
  }
  const importRanked = [...importCandidates.entries()]
    .filter(([f]) => !stage1.includes(f))
    .map(([f, impScore]) => {
      const mod = modByPath.get(f);
      const sem = mod !== undefined ? lexicalScore(mod, query, qWords) : 0;
      return { file: f, score: impScore * (options.importSemanticFloor + sem), impScore, sem };
    })
    .sort((a, b) => b.score - a.score);
  const importSlots = importRanked.slice(0, options.importSlots).map((s) => s.file);
  debug.push(`import: [${importRanked.slice(0, options.importSlots + 1).map((s) => `${s.file.split("/").pop()}(${s.score.toFixed(2)})`).join(", ")}]`);

  // Stage 3: reverse import expansion — files that import stage1 core.
  const reverseCandidates = new Map<string, number>();
  for (const f of stage1Core) {
    const fScore = stage1ScoreMap.get(f) ?? 0;
    const reverse = graph.reverseAdjacency.get(f);
    if (reverse === undefined) continue;
    for (const imp of reverse) {
      reverseCandidates.set(imp, Math.max(reverseCandidates.get(imp) ?? 0, fScore));
    }
  }
  const reverseRanked = [...reverseCandidates.entries()]
    .filter(([f]) => !stage1.includes(f) && !importSlots.includes(f))
    .map(([f, impScore]) => {
      const mod = modByPath.get(f);
      const sem = mod !== undefined ? lexicalScore(mod, query, qWords) : 0;
      return { file: f, score: impScore * (options.importSemanticFloor + sem), impScore, sem };
    })
    .sort((a, b) => b.score - a.score);
  const reverseSlots = reverseRanked.slice(0, options.reverseSlots).map((s) => s.file);
  debug.push(`reverse: [${reverseRanked.slice(0, options.reverseSlots + 1).map((s) => `${s.file.split("/").pop()}(${s.score.toFixed(2)})`).join(", ")}]`);

  // Stage 4: package/directory co-occurrence — files in a directory (or
  // parent directory) where >= packageMinDirHits stage1 files live.
  const dirCount = new Map<string, number>();
  for (const f of stage1) {
    for (const parent of dirParents(dirname(f))) {
      dirCount.set(parent, (dirCount.get(parent) ?? 0) + 1);
    }
  }
  const packageDirs = new Set<string>();
  for (const [dir, count] of dirCount) {
    if (count >= options.packageMinDirHits) packageDirs.add(dir);
  }
  const packageCandidates = index.modules
    .filter((m) => !stage1.includes(m.path) && !importSlots.includes(m.path) && !reverseSlots.includes(m.path))
    .filter((m) => packageDirs.has(dirname(m.path)))
    .map((m) => ({ file: m.path, score: lexicalScore(m, query, qWords) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const packageSlots = packageCandidates.slice(0, options.packageSlots).map((s) => s.file);
  debug.push(`package: [${packageCandidates.slice(0, options.packageSlots + 1).map((s) => `${s.file.split("/").pop()}(${s.score.toFixed(2)})`).join(", ")}]`);

  // Combine: stage1 core + import slots + reverse slots + package slots +
  // stage1 fill, deduped, capped at finalK.
  const seen = new Set<string>();
  const files: Exp474RetrievalHit[] = [];

  function add(file: string, stage: Exp474RetrievalHit["stage"], baseReasons: readonly string[]): void {
    if (seen.has(file)) return;
    if (files.length >= options.finalK) return;
    seen.add(file);
    const score = scored.find((s) => s.file === file)?.total ?? 0;
    const reasons = baseReasons.length > 0 ? baseReasons : stage1ReasonMap.get(file) ?? deepFreeze([]);
    files.push(deepFreeze({ path: file, score, stage, reasons: deepFreeze([...reasons]) }));
  }

  for (const f of stage1.slice(0, Math.min(options.stage1CoreK, stage1.length))) {
    add(f, "stage1", stage1ReasonMap.get(f) ?? deepFreeze([]));
  }
  for (const f of importSlots) add(f, "import", deepFreeze(["import-expansion"]));
  for (const f of reverseSlots) add(f, "reverse-import", deepFreeze(["reverse-import-expansion"]));
  for (const f of packageSlots) add(f, "package-cooccurrence", deepFreeze(["package-cooccurrence"]));
  for (const f of stage1.slice(options.stage1CoreK)) add(f, "stage1-fill", stage1ReasonMap.get(f) ?? deepFreeze([]));

  debug.push(`final: [${files.map((f) => f.path.split("/").pop()).join(", ")}]`);
  return deepFreeze({ query, files: deepFreeze(files), debug: deepFreeze(debug) });
}
