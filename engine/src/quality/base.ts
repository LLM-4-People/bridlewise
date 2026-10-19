/**
 * Multi-language quality pack — base types (EXP357).
 *
 * Language-agnostic types shared by parsers, checks, signals, and the
 * aggregator. The core owns the normalized schema; language parsers and
 * checks register against it. Adding a language = adding a parser adapter,
 * not changing the core (per delivery map item 9).
 *
 * All thresholds live in `config.ts`. No hardcoded values in checks.
 */

export type LanguageId =
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "unknown";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "interface"
  | "enum"
  | "type"
  | "module"
  | "variable"
  | "constant";

export interface SymbolDef {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly filePath: string;
  readonly line: number;
  readonly endLine: number;
  /** Visible outside the declaring file (pub fn, def, export, public, etc.). */
  readonly exported: boolean;
  /** True for declarations that bind a name in the enclosing scope
   * (FunctionDeclaration, ClassDeclaration, top-level `def`, `pub fn`,
   * `fn`, Java method, C function definition). False for expressions
   * (FunctionExpression, ArrowFunctionExpression, ClassExpression, lambdas,
   * anonymous functions assigned to a property). The dead-private-function
   * check only considers declarations; flagging an expression is always a
   * false positive (its name is internal to the function body). */
  readonly isDeclaration: boolean;
  /** True for methods that are part of a trait impl (Rust `impl Trait for Type`)
   * or an interface implementation (Java `implements`, Python duck-typed
   * methods that match a protocol). These methods are REQUIRED by the
   * trait/interface contract — they're called via dynamic dispatch on the
   * trait object, not via direct name reference. The dead-private-function
   * check skips them (flagging them is always a false positive). */
  readonly isTraitImpl: boolean;
  readonly cyclomaticComplexity: number;
  readonly maxNestingDepth: number;
  readonly paramCount: number;
  readonly bodyLines: number;
}

export interface ImportDef {
  readonly filePath: string;
  readonly line: number;
  readonly names: readonly string[];
  /** Raw module/source specifier as written. */
  readonly source: string;
  /** True for relative specifiers (`./`, `../`, `/`). */
  readonly isRelative: boolean;
  /** True for side-effect imports where `names` is NOT a list of symbols that
   * must be referenced in the file body. Examples: C/C++ `#include` (pastes
   * the whole header), Python `__future__` (changes parser behavior),
   * Go blank imports (`_ "pkg"`), JS side-effect imports (`import "./x"`).
   * The unused-import check skips these. */
  readonly sideEffectImport: boolean;
}

export interface ExportDef {
  readonly filePath: string;
  readonly line: number;
  readonly name: string;
  readonly kind: SymbolKind;
}

export interface CommentDef {
  readonly filePath: string;
  readonly line: number;
  readonly text: string;
  readonly kind: "line" | "block" | "doc";
}

export interface ParseErrorDef {
  readonly filePath: string;
  readonly line: number;
  readonly message: string;
}

export interface ParsedFile {
  readonly path: string;
  readonly language: LanguageId;
  readonly content: string;
  readonly loc: number;
  readonly symbols: readonly SymbolDef[];
  readonly imports: readonly ImportDef[];
  readonly exports: readonly ExportDef[];
  readonly comments: readonly CommentDef[];
  readonly parseErrors: readonly ParseErrorDef[];
}

export type Severity = "error" | "warning" | "info";

export type CheckId =
  | "dead-export"
  | "unused-import"
  | "dead-code"
  | "complexity-hotspot"
  | "duplicate-body"
  | "circular-dependency"
  | "todo-comment"
  | "empty-catch"
  | "magic-number"
  | "missing-default-case"
  | "shadowed-declaration"
  | "unused-local"
  | "parse-error"
  | "long-function"
  | "long-parameter-list"
  | "long-line"
  | "complex-condition"
  | "duplicate-import"
  | "duplicate-string"
  | "empty-function"
  | "race-condition"
  | "security-hotspot"
  | "performance-anti-pattern"
  | "unreachable-catch"
  | "code-health"
  // EXP462: 25 new ESLint-style lint checks (10× harder).
  | "unused-type-parameter"
  | "unnecessary-type-assertion"
  | "prefer-const"
  | "no-var"
  | "no-eval"
  | "no-implied-eval"
  | "no-throw-literal"
  | "no-unsafe-finally"
  | "no-unsafe-optional-chaining"
  | "no-unreachable-code"
  | "no-unused-labels"
  | "no-unused-expressions"
  | "no-loss-of-precision"
  | "no-irregular-whitespace"
  | "no-dupe-keys"
  | "no-dupe-args"
  | "no-dupe-class-members"
  | "no-cond-assign"
  | "no-constant-condition"
  | "no-control-regex"
  | "no-empty"
  | "no-extra-boolean-cast"
  | "no-extra-semi"
  | "no-fallthrough"
  | "no-inner-declarations";

export interface Finding {
  readonly checkId: CheckId;
  readonly severity: Severity;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly symbol: string | null;
  readonly message: string;
  readonly extra: Readonly<Record<string, string | number | string[] | null>>;
}

export type SignalId =
  | "codebase-type-level"
  | "quality-indication"
  | "drift"
  | "architecture"
  | "entropy"
  | "clone-stats"
  | "code-health"
  | "complexity-distribution";

export type SignalValue = Readonly<{
  id: SignalId;
  name: string;
  value: number | string | boolean | readonly (number | string)[];
  unit: string | null;
  description: string;
}>;

export interface QualityReport {
  readonly codebasePath: string;
  readonly language: LanguageId;
  readonly generatedAt: string;
  readonly files: Readonly<{
    scanned: number;
    parsed: number;
    parseErrors: number;
    loc: number;
  }>;
  readonly findings: readonly Finding[];
  readonly signals: readonly SignalValue[];
  readonly byCheck: Readonly<Record<string, number>>;
  readonly durationMs: number;
}

export interface QualityConfig {
  readonly thresholds: Readonly<{
    complexityHotspot: number;
    longFunction: number;
    duplicateMinTokens: number;
    duplicateJaccard: number;
    magicNumberAllowlist: readonly number[];
    maxImportDepthForCycle: number;
    /** Barrel detection: max non-exported symbols a barrel file may have. */
    readonly barrelMaxNonExportedSymbols: number;
    /** Barrel detection: min exports a barrel file must have. */
    readonly barrelMinExports: number;
    /** Long-parameter-list: flag functions with ≥ this many params. */
    readonly longParameterList: number;
    /** Long-line: flag lines ≥ this many columns. */
    readonly longLine: number;
    /** Complex-condition: flag conditions with ≥ this many boolean operators. */
    readonly complexCondition: number;
    /** Duplicate-string: flag string literals appearing ≥ this many times. */
    readonly duplicateStringMin: number;
    /** Duplicate-string: only flag strings ≥ this many characters. */
    readonly duplicateStringMinLen: number;
    /** codebase-type-level signal — typed-file fraction ≥ this → "typed"
     * (and symmetric for untyped). Was a hardcoded 0.7 in signals.ts. */
    readonly codebaseTypeLevelFraction: number;
    /** architecture signal — number of top hub modules to report. Was
     * a hardcoded 5 in signals.ts. */
    readonly topHubModuleCount: number;
    /** race-condition check — how many lines to look back from a mutation
     * site to find an enclosing synchronized/Mutex/RLock block (the
     * "is this mutation protected?" heuristic). Was a hardcoded 50. */
    readonly raceConditionSyncBlockLookback: number;
    /** dead-code check — how many lines to look back from a throw/raise to
     * find an enclosing catch/except handler (the "is this throw inside a
     * handler?" heuristic). Was a hardcoded 30. */
    readonly deadCodeCatchLookback: number;
    /** complexity-hotspot check — the minimum nesting depth that's
     * suspicious (a floor so a very low complexityHotspot threshold does
     * not flag shallow nesting). Was a hardcoded 4. */
    readonly nestingThresholdFloor: number;
  }>;
  readonly enabledChecks: ReadonlySet<CheckId>;
  readonly enabledSignals: ReadonlySet<SignalId>;
  readonly enabledLanguages: ReadonlySet<LanguageId>;
  /** Patterns to exclude from analysis (substring match). */
  readonly excludeSubstrings: readonly string[];
  /** Patterns to include (path prefix match). Empty = all. */
  readonly includePrefixes: readonly string[];
  /** Repository-relative paths considered entry points (exports never dead). */
  readonly entryPoints: ReadonlySet<string>;
  /** Skip duplicate detection (expensive on huge codebases). */
  readonly skipDuplicates: boolean;
  /** Skip signals that require a full graph pass. */
  readonly skipGraphSignals: boolean;
  /** Sample limit (max files to scan). 0 = no limit. */
  readonly maxFiles: number;
  /**
   * Scoring configuration (EXP462). The single owner of severity penalties,
   * per-category caps, and per-check precision. Per the binding directive
   * "no static constants other than configurables", these are all
   * overridable via config — `scoring.ts` reads ONLY from here.
   */
  readonly scoring: Readonly<{
    /** Severity → score penalty per finding (before KLOC normalization). */
    readonly severityPenalty: Readonly<Record<string, number>>;
    /** Per-category cap on the total penalty (prevents domination). */
    readonly categoryCap: Readonly<Record<string, number>>;
    /** Check id → quality category. */
    readonly categoryMap: Readonly<Record<string, string>>;
    /**
     * Check id → precision class. EXP462 Fix 3: high-recall / low-precision
     * checks (race-condition, security-hotspot) are "review requests", not
     * confirmed bugs — their penalty is scaled by `precisionWeight.low`
     * so they don't dominate the score. This makes the score honest:
     * a codebase with 100 security-hotspot findings (each a request for
     * human review) shouldn't score as low as one with 100 confirmed
     * dead-code findings.
     */
    readonly checkPrecision: Readonly<Record<string, "high" | "medium" | "low">>;
    /** Penalty multiplier per precision class (high=1.0, medium=0.6, low=0.3). */
    readonly precisionWeight: Readonly<{ high: number; medium: number; low: number }>;
    /**
     * Letter-grade boundaries (R47 — moved out of scoring.ts so the
     * "no static constants" claim is truthful). The 4 inclusive lower
     * bounds for A/B/C/D (anything below the D bound is F), descending.
     * The single owner is {@link buildQualityConfig} in config.ts.
     */
    readonly gradeBoundaries: Readonly<{ a: number; b: number; c: number; d: number }>;
    /**
     * Fallback per-category cap when a finding maps to a category NOT
     * listed in {@link categoryCap} (R47 — previously a hardcoded `20`
     * in scoring.ts, violating the "no static constants" claim).
     */
    readonly defaultCategoryCap: number;
  }>;
  /** Skip the code-health aggregate meta-check (sub-checks still run if
   * individually enabled). EXP446. */
  readonly skipCodeHealthAggregate: boolean;
  /** Override the unreachable-catch supertype map. When null/absent, the
   * check uses its built-in default. EXP446. The default constant is an
   * initializer (not a runtime constant) so this config knob satisfies the
   * "no static constants" binding directive — every supertype relation is
   * runtime-overridable. */
  readonly unreachableCatchSupertypes: Readonly<Record<string, readonly string[]>> | null;
}

export type CheckFn = (files: readonly ParsedFile[], config: QualityConfig) => readonly Finding[];
export type SignalFn = (
  files: readonly ParsedFile[],
  config: QualityConfig,
  findings: readonly Finding[],
) => readonly SignalValue[];
