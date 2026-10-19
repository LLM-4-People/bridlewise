/**
 * Multi-language quality pack — central config (EXP357).
 *
 * ONE canonical owner for all thresholds and toggles. No check or signal
 * hardcodes a value — every threshold comes from here. The config is built
 * from a plain JSON-shaped input so it can be projected from the harness
 * central configuration contract.
 */

import type { CheckId, LanguageId, QualityConfig, SignalId } from "./base.ts";

/**
 * Default check list. The pack runs every check unless the caller narrows it.
 * `parse-error` is always on (it's free — byproducts of parsing).
 *
 * Module-private because `buildQualityConfig` below resolves it into
 * `enabledChecks`. A default whose owner also owns the resolver has exactly
 * one correct reader — the resolver — and every other read is a value that
 * silently stops tracking configuration the moment a caller narrows the list.
 * Ask `buildQualityConfig({}).enabledChecks` for the resolved answer.
 *
 * DELIBERATE SUBSET: 50 of 50 — it names every check there is today, and that
 * has to stay a DECISION rather than an accident. A check added to `CheckId`
 * is off by default until someone adds it here and moves this count, which is
 * the question worth forcing: should the new check run for everybody?
 */
const DEFAULT_CHECKS: readonly CheckId[] = [
  "dead-export",
  "unused-import",
  "dead-code",
  "complexity-hotspot",
  "duplicate-body",
  "circular-dependency",
  "todo-comment",
  "empty-catch",
  "magic-number",
  "missing-default-case",
  "shadowed-declaration",
  "unused-local",
  "long-function",
  "long-parameter-list",
  "long-line",
  "complex-condition",
  "duplicate-import",
  "duplicate-string",
  "empty-function",
  "race-condition",
  "security-hotspot",
  "performance-anti-pattern",
  "unreachable-catch",
  "code-health",
  "parse-error",
  // EXP462: 25 new ESLint-style lint checks (10× harder). Each is a
  // high-precision pattern check (regex-based, language-agnostic where
  // possible). Severity is "warning" (they're style/correctness lints,
  // not security). Precision is "high" except where noted.
  "unused-type-parameter",
  "unnecessary-type-assertion",
  "prefer-const",
  "no-var",
  "no-eval",
  "no-implied-eval",
  "no-throw-literal",
  "no-unsafe-finally",
  "no-unsafe-optional-chaining",
  "no-unreachable-code",
  "no-unused-labels",
  "no-unused-expressions",
  "no-loss-of-precision",
  "no-irregular-whitespace",
  "no-dupe-keys",
  "no-dupe-args",
  "no-dupe-class-members",
  "no-cond-assign",
  "no-constant-condition",
  "no-control-regex",
  "no-empty",
  "no-extra-boolean-cast",
  "no-extra-semi",
  "no-fallthrough",
  "no-inner-declarations",
];

/**
 * Which signals run when nobody has said.
 *
 * DELIBERATE SUBSET: 8 of 8 — this is a policy about what is ON by default, not a
 * census of what exists. It happens to name all eight signals today, and that
 * coincidence is exactly why it has to be said out loud — a ninth signal must
 * be a decision to enable, not an automatic consequence of being declared.
 * `buildQualityConfig` resolves this into `enabledSignals`, so that field is
 * the answer and this list is only its input.
 */
const DEFAULT_SIGNALS: readonly SignalId[] = [
  "codebase-type-level",
  "quality-indication",
  "drift",
  "architecture",
  "entropy",
  "clone-stats",
  "code-health",
  "complexity-distribution",
];

/**
 * Module-private for the same reason as `DEFAULT_CHECKS`: `buildQualityConfig`
 * resolves it into `enabledLanguages`, so that field is the answer and this
 * list is only its input.
 *
 * DELIBERATE SUBSET: 8 of 9 `LanguageId` members. `unknown` is the
 * ninth and is the classifier's "I could not tell" answer — enabling quality
 * checks for it would run every language's checks over files of no known
 * language. A tenth language is a decision to enable, not an automatic
 * consequence of the parser learning to recognise it.
 */
const DEFAULT_QUALITY_LANGUAGES: readonly LanguageId[] = [
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
];

/**
 * Magic-number allowlist. The numbers most commonly used as legitimate
 * constants (0, ±1, ±2, common time/size magnitudes). Threshold-driven, not
 * hardcoded inside a check.
 */
const DEFAULT_MAGIC_NUMBER_ALLOWLIST: readonly number[] = [
  -2, -1, 0, 1, 2, 3, 10, 16, 60, 100, 1000, 1024, 3600, 0.5, 0.25, 1e3, 1e6,
];

/**
 * THE quality thresholds' defaults — one frozen table, the single owner
 * (a2-design H2: the builder restated each default inline and five checks
 * restated theirs a second time behind an optional type).
 */
const DEFAULT_QUALITY_THRESHOLDS: QualityConfig["thresholds"] = Object.freeze({
  complexityHotspot: 15,
  longFunction: 80,
  duplicateMinTokens: 40,
  duplicateJaccard: 0.85,
  magicNumberAllowlist: DEFAULT_MAGIC_NUMBER_ALLOWLIST,
  maxImportDepthForCycle: 200,
  barrelMaxNonExportedSymbols: 2,
  barrelMinExports: 3,
  longParameterList: 5,
  longLine: 120,
  complexCondition: 4,
  duplicateStringMin: 3,
  duplicateStringMinLen: 10,
  codebaseTypeLevelFraction: 0.7,
  topHubModuleCount: 5,
  raceConditionSyncBlockLookback: 50,
  deadCodeCatchLookback: 30,
  nestingThresholdFloor: 4,
});

export interface QualityConfigInput {
  readonly thresholds?: Partial<QualityConfig["thresholds"]>;
  readonly enabledChecks?: readonly CheckId[];
  readonly enabledSignals?: readonly SignalId[];
  readonly enabledLanguages?: readonly LanguageId[];
  readonly excludeSubstrings?: readonly string[];
  readonly includePrefixes?: readonly string[];
  readonly entryPoints?: readonly string[];
  readonly skipDuplicates?: boolean;
  readonly skipGraphSignals?: boolean;
  readonly maxFiles?: number;
  /** EXP446: skip the code-health aggregate meta-check. */
  readonly skipCodeHealthAggregate?: boolean;
  /** EXP446: override the unreachable-catch supertype map. */
  readonly unreachableCatchSupertypes?: Readonly<Record<string, readonly string[]>> | null;
  /** EXP462: override scoring severity penalties. */
  readonly scoringSeverityPenalty?: Readonly<Record<string, number>>;
  /** EXP462: override scoring per-category caps. */
  readonly scoringCategoryCap?: Readonly<Record<string, number>>;
  /** EXP462: override scoring check→category map. */
  readonly scoringCategoryMap?: Readonly<Record<string, string>>;
  /** EXP462: override scoring check→precision map. */
  readonly scoringCheckPrecision?: Readonly<Record<string, "high" | "medium" | "low">>;
  /** EXP462: override scoring precision multipliers. */
  readonly scoringPrecisionWeight?: Readonly<{ high: number; medium: number; low: number }>;
  /** R47: override letter-grade boundaries (inclusive lower bounds for A/B/C/D). */
  readonly scoringGradeBoundaries?: Readonly<{ a: number; b: number; c: number; d: number }>;
  /** R47: override the fallback per-category cap for unmapped categories. */
  readonly scoringDefaultCategoryCap?: number;
}

/**
 * Default severity penalties (EXP462 — moved out of scoring.ts to satisfy
 * the "no static constants other than configurables" binding directive).
 * These are INITIAL values, overridable via `QualityConfigInput.scoring*`.
 */
const DEFAULT_SEVERITY_PENALTY: Readonly<Record<string, number>> = {
  error: 4,
  warning: 1.5,
  info: 0.5,
};

/**
 * Default per-category caps (EXP462 — moved from scoring.ts).
 */
const DEFAULT_CATEGORY_CAP: Readonly<Record<string, number>> = {
  correctness: 40,
  complexity: 25,
  maintainability: 15,
  safety: 20,
  security: 30,
  performance: 15,
  dependencies: 15,
  style: 10,
};

/**
 * Default check→category map (EXP462 — moved from scoring.ts). The 25 new
 * EXP462 checks map to the category that best fits their lint semantics.
 */
const DEFAULT_CATEGORY_MAP: Readonly<Record<string, string>> = {
  "parse-error": "correctness",
  "dead-code": "correctness",
  "dead-export": "correctness",
  "duplicate-body": "correctness",
  "complexity-hotspot": "complexity",
  "long-function": "complexity",
  "long-parameter-list": "complexity",
  "complex-condition": "complexity",
  "todo-comment": "maintainability",
  "shadowed-declaration": "maintainability",
  "unused-local": "maintainability",
  "duplicate-import": "maintainability",
  "duplicate-string": "maintainability",
  "empty-function": "maintainability",
  "empty-catch": "safety",
  "missing-default-case": "safety",
  "race-condition": "safety",
  "security-hotspot": "security",
  "performance-anti-pattern": "performance",
  "unused-import": "dependencies",
  "circular-dependency": "dependencies",
  "magic-number": "style",
  "long-line": "style",
  // EXP446.
  "unreachable-catch": "correctness",
  "code-health": "maintainability",
  // EXP462: 25 new checks. Correctness/style/safety lints.
  "unused-type-parameter": "maintainability",
  "unnecessary-type-assertion": "style",
  "prefer-const": "maintainability",
  "no-var": "maintainability",
  "no-eval": "security",
  "no-implied-eval": "security",
  "no-throw-literal": "safety",
  "no-unsafe-finally": "safety",
  "no-unsafe-optional-chaining": "correctness",
  "no-unreachable-code": "correctness",
  "no-unused-labels": "style",
  "no-unused-expressions": "maintainability",
  "no-loss-of-precision": "correctness",
  "no-irregular-whitespace": "style",
  "no-dupe-keys": "correctness",
  "no-dupe-args": "correctness",
  "no-dupe-class-members": "correctness",
  "no-cond-assign": "correctness",
  "no-constant-condition": "correctness",
  "no-control-regex": "correctness",
  "no-empty": "maintainability",
  "no-extra-boolean-cast": "style",
  "no-extra-semi": "style",
  "no-fallthrough": "safety",
  "no-inner-declarations": "maintainability",
};

/**
 * Default check→precision map (EXP462 Fix 3). High-precision checks flag
 * confirmed bugs. Medium-precision checks flag likely bugs with rare FPs.
 * Low-precision checks are high-recall "review requests" (race-condition,
 * security-hotspot) — they're parser-based pattern matchers, not
 * definitive correctness proofs. The scoring formula scales their penalty
 * by `precisionWeight.low` so they don't dominate the score.
 */
const DEFAULT_CHECK_PRECISION: Readonly<Record<string, "high" | "medium" | "low">> = {
  // High-precision confirmed bugs.
  "parse-error": "high",
  "dead-code": "high",
  "dead-export": "high",
  "duplicate-body": "high",
  "unused-import": "high",
  "unused-local": "high",
  "circular-dependency": "high",
  "no-unreachable-code": "high",
  "no-dupe-keys": "high",
  "no-dupe-args": "high",
  "no-dupe-class-members": "high",
  "no-loss-of-precision": "high",
  "no-throw-literal": "high",
  "no-unsafe-finally": "high",
  "no-unsafe-optional-chaining": "high",
  "no-var": "high",
  "no-extra-semi": "high",
  "unused-type-parameter": "high",
  // Medium-precision (likely bugs, rare FPs).
  "complexity-hotspot": "medium",
  "long-function": "medium",
  "long-parameter-list": "medium",
  "complex-condition": "medium",
  "missing-default-case": "medium",
  "empty-catch": "medium",
  "empty-function": "medium",
  "shadowed-declaration": "medium",
  "duplicate-import": "medium",
  "duplicate-string": "medium",
  "no-eval": "medium",
  "no-implied-eval": "medium",
  "no-cond-assign": "medium",
  "no-constant-condition": "medium",
  "no-control-regex": "medium",
  "no-fallthrough": "medium",
  "no-inner-declarations": "medium",
  "no-empty": "medium",
  "no-unused-expressions": "medium",
  "prefer-const": "medium",
  "no-unused-labels": "medium",
  "unnecessary-type-assertion": "medium",
  "no-irregular-whitespace": "medium",
  "no-extra-boolean-cast": "medium",
  "magic-number": "medium",
  "long-line": "medium",
  "todo-comment": "medium",
  "unreachable-catch": "medium",
  "code-health": "medium",
  "performance-anti-pattern": "medium",
  // Low-precision (high-recall review requests — NOT confirmed bugs).
  // EXP446 documented these as "high-recall / low-precision by design".
  // EXP462 Fix 3 makes this machine-readable so the score reflects it.
  "race-condition": "low",
  "security-hotspot": "low",
};

/**
 * Default precision multipliers (EXP462 Fix 3). A low-precision finding
 * contributes 0.3× the penalty of a high-precision finding at the same
 * severity — it's a review request, not a confirmed defect.
 */
const DEFAULT_PRECISION_WEIGHT: Readonly<{ high: number; medium: number; low: number }> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

/**
 * Default letter-grade boundaries (R47 — moved out of scoring.ts `gradeOf`).
 * Inclusive lower bounds: score ≥ a → "A", ≥ b → "B", etc.; below d → "F".
 * The single owner of these boundaries is {@link buildQualityConfig}.
 */
const DEFAULT_GRADE_BOUNDARIES: Readonly<{ a: number; b: number; c: number; d: number }> = {
  a: 90,
  b: 80,
  c: 70,
  d: 60,
};

/**
 * Default fallback per-category cap (R47 — was a hardcoded `20` in
 * scoring.ts). Used only when a finding maps to a category that is NOT
 * present in {@link DEFAULT_CATEGORY_CAP}. The single owner is
 * {@link buildQualityConfig}.
 */
const DEFAULT_CATEGORY_CAP_FALLBACK = 20;

export function buildQualityConfig(input: QualityConfigInput = {}): QualityConfig {
  // An override given as `undefined` means "not given" (the defaults' `??` semantics).
  const overrides = Object.fromEntries(Object.entries(input.thresholds ?? {}).filter(([, value]) => value !== undefined));
  return {
    thresholds: { ...DEFAULT_QUALITY_THRESHOLDS, ...overrides },
    enabledChecks: new Set(input.enabledChecks ?? DEFAULT_CHECKS),
    enabledSignals: new Set(input.enabledSignals ?? DEFAULT_SIGNALS),
    enabledLanguages: new Set(input.enabledLanguages ?? DEFAULT_QUALITY_LANGUAGES),
    excludeSubstrings: input.excludeSubstrings ?? [
      "/node_modules/",
      "/.git/",
      "/dist/",
      "/build/",
      "/target/",
      "/__pycache__/",
      "/vendor/",
    ],
    includePrefixes: input.includePrefixes ?? [],
    entryPoints: new Set(input.entryPoints ?? []),
    skipDuplicates: input.skipDuplicates ?? false,
    skipGraphSignals: input.skipGraphSignals ?? false,
    maxFiles: input.maxFiles ?? 0,
    skipCodeHealthAggregate: input.skipCodeHealthAggregate ?? false,
    unreachableCatchSupertypes: input.unreachableCatchSupertypes ?? null,
    scoring: {
      severityPenalty: input.scoringSeverityPenalty ?? DEFAULT_SEVERITY_PENALTY,
      categoryCap: input.scoringCategoryCap ?? DEFAULT_CATEGORY_CAP,
      categoryMap: input.scoringCategoryMap ?? DEFAULT_CATEGORY_MAP,
      checkPrecision: input.scoringCheckPrecision ?? DEFAULT_CHECK_PRECISION,
      precisionWeight: input.scoringPrecisionWeight ?? DEFAULT_PRECISION_WEIGHT,
      gradeBoundaries: input.scoringGradeBoundaries ?? DEFAULT_GRADE_BOUNDARIES,
      defaultCategoryCap: input.scoringDefaultCategoryCap ?? DEFAULT_CATEGORY_CAP_FALLBACK,
    },
  };
}

const LANGUAGE_EXTENSIONS: Readonly<Record<string, LanguageId>> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
};

export function detectLanguage(filePath: string): LanguageId {
  const lower = filePath.toLowerCase();
  let lastDot = lower.lastIndexOf(".");
  if (lastDot <= 0) return "unknown";
  const ext = lower.slice(lastDot);
  return LANGUAGE_EXTENSIONS[ext] ?? "unknown";
}

export function isSourceLanguage(language: LanguageId): boolean {
  return language !== "unknown";
}
