/**
 * Aggregator + runner (EXP368, refactored for async tree-sitter parsers).
 *
 * Orchestrates the full multi-language quality analysis:
 * 1. Parse files (language-agnostic, async — tree-sitter WASM loads).
 * 2. Run enabled checks (each a pure function).
 * 3. Compute enabled signals (each a pure function).
 * 4. Emit a `QualityReport` with per-check counts, signals, and timing.
 *
 * The aggregator itself is language-agnostic — adding a check is ONE line in
 * `CHECK_REGISTRY` (plus its import); adding a signal is ONE line in
 * `SIGNAL_REGISTRY` (plus its import). No core `runAnalysis` changes needed
 * for either (R49-V3: signals were previously a bespoke if-chain per
 * signal, contradicting the old "one-line registration" claim).
 */

import type {
  CheckFn,
  Finding,
  LanguageId,
  QualityConfig,
  QualityReport,
  SignalFn,
  SignalId,
  SignalValue,
} from "./base.ts";
import { checkDeadExports } from "./checks/dead-exports.ts";
import { checkUnusedImports } from "./checks/unused-imports.ts";
import { checkComplexityHotspots, checkHighNesting, checkLongFunctions } from "./checks/complexity.ts";
import { checkDuplicateBodies } from "./checks/duplicates.ts";
import { checkCircularDeps } from "./checks/circular-deps.ts";
import { checkDeadCode } from "./checks/dead-code.ts";
import {
  checkEmptyCatch,
  checkMagicNumbers,
  checkMissingDefault,
  checkTodoComments,
  checkUnusedLocals,
} from "./checks/code-health.ts";
import { checkShadowedDeclarations } from "./checks/shadowed-declaration.ts";
import { checkParseErrors } from "./checks/parse-errors.ts";
import { checkLongParameterList } from "./checks/long-params.ts";
import { checkLongLines } from "./checks/long-line.ts";
import { checkComplexCondition } from "./checks/complex-condition.ts";
import { checkDuplicateImports } from "./checks/duplicate-imports.ts";
import { checkDuplicateStrings } from "./checks/duplicate-strings.ts";
import { checkEmptyFunctions } from "./checks/empty-function.ts";
import { checkRaceConditions } from "./checks/race-condition.ts";
import { checkSecurityHotspots } from "./checks/security-hotspot.ts";
import { checkPerformanceAntiPatterns } from "./checks/performance-anti-pattern.ts";
import { checkUnreachableCatch } from "./checks/unreachable-catch.ts";
import { checkCodeHealth } from "./checks/code-health-aggregate.ts";
// EXP462: 25 new ESLint-style lint checks.
import { checkNoEval } from "./checks/no-eval.ts";
import { checkNoImpliedEval } from "./checks/no-implied-eval.ts";
import { checkNoThrowLiteral } from "./checks/no-throw-literal.ts";
import { checkNoUnsafeFinally } from "./checks/no-unsafe-finally.ts";
import { checkNoUnreachableCode } from "./checks/no-unreachable-code.ts";
import { checkNoVar } from "./checks/no-var.ts";
import { checkPreferConst } from "./checks/prefer-const.ts";
import { checkNoCondAssign } from "./checks/no-cond-assign.ts";
import { checkNoConstantCondition } from "./checks/no-constant-condition.ts";
import { checkNoDupeKeys } from "./checks/no-dupe-keys.ts";
import { checkNoDupeArgs } from "./checks/no-dupe-args.ts";
import { checkNoDupeClassMembers } from "./checks/no-dupe-class-members.ts";
import { checkNoEmpty } from "./checks/no-empty.ts";
import { checkNoExtraBooleanCast } from "./checks/no-extra-boolean-cast.ts";
import { checkNoExtraSemi } from "./checks/no-extra-semi.ts";
import { checkNoFallthrough } from "./checks/no-fallthrough.ts";
import { checkNoInnerDeclarations } from "./checks/no-inner-declarations.ts";
import { checkNoUnusedLabels } from "./checks/no-unused-labels.ts";
import { checkNoUnusedExpressions } from "./checks/no-unused-expressions.ts";
import { checkNoIrregularWhitespace } from "./checks/no-irregular-whitespace.ts";
import { checkNoLossOfPrecision } from "./checks/no-loss-of-precision.ts";
import { checkNoControlRegex } from "./checks/no-control-regex.ts";
import { checkNoUnsafeOptionalChaining } from "./checks/no-unsafe-optional-chaining.ts";
import { checkUnusedTypeParameter } from "./checks/unused-type-parameter.ts";
import { checkUnnecessaryTypeAssertion } from "./checks/unnecessary-type-assertion.ts";
import { parseFiles } from "./languages/index.ts";
import {
  signalArchitecture,
  signalCloneStats,
  signalCodeHealth,
  signalCodebaseTypeLevel,
  signalComplexityDistribution,
  signalDrift,
  signalEntropy,
  signalQualityIndication,
} from "./signals.ts";

const CHECK_REGISTRY: Readonly<Record<string, CheckFn>> = {
  "dead-export": checkDeadExports,
  "unused-import": checkUnusedImports,
  "dead-code": checkDeadCode,
  "complexity-hotspot": checkComplexityHotspots,
  "long-function": checkLongFunctions,
  "duplicate-body": checkDuplicateBodies,
  "circular-dependency": checkCircularDeps,
  "todo-comment": checkTodoComments,
  "empty-catch": checkEmptyCatch,
  "magic-number": checkMagicNumbers,
  "missing-default-case": checkMissingDefault,
  "shadowed-declaration": checkShadowedDeclarations,
  "unused-local": checkUnusedLocals,
  "parse-error": checkParseErrors,
  "long-parameter-list": checkLongParameterList,
  "long-line": checkLongLines,
  "complex-condition": checkComplexCondition,
  "duplicate-import": checkDuplicateImports,
  "duplicate-string": checkDuplicateStrings,
  "empty-function": checkEmptyFunctions,
  "race-condition": checkRaceConditions,
  "security-hotspot": checkSecurityHotspots,
  "performance-anti-pattern": checkPerformanceAntiPatterns,
  "unreachable-catch": checkUnreachableCatch,
  "code-health": checkCodeHealth,
  // EXP462: 25 new ESLint-style lint checks.
  "no-eval": checkNoEval,
  "no-implied-eval": checkNoImpliedEval,
  "no-throw-literal": checkNoThrowLiteral,
  "no-unsafe-finally": checkNoUnsafeFinally,
  "no-unreachable-code": checkNoUnreachableCode,
  "no-var": checkNoVar,
  "prefer-const": checkPreferConst,
  "no-cond-assign": checkNoCondAssign,
  "no-constant-condition": checkNoConstantCondition,
  "no-dupe-keys": checkNoDupeKeys,
  "no-dupe-args": checkNoDupeArgs,
  "no-dupe-class-members": checkNoDupeClassMembers,
  "no-empty": checkNoEmpty,
  "no-extra-boolean-cast": checkNoExtraBooleanCast,
  "no-extra-semi": checkNoExtraSemi,
  "no-fallthrough": checkNoFallthrough,
  "no-inner-declarations": checkNoInnerDeclarations,
  "no-unused-labels": checkNoUnusedLabels,
  "no-unused-expressions": checkNoUnusedExpressions,
  "no-irregular-whitespace": checkNoIrregularWhitespace,
  "no-loss-of-precision": checkNoLossOfPrecision,
  "no-control-regex": checkNoControlRegex,
  "no-unsafe-optional-chaining": checkNoUnsafeOptionalChaining,
  "unused-type-parameter": checkUnusedTypeParameter,
  "unnecessary-type-assertion": checkUnnecessaryTypeAssertion,
};

/** "high-nesting" is reported under the complexity-hotspot check id. */
const EXTRA_CHECKS: CheckFn[] = [checkHighNesting];

/**
 * R49-V3: SIGNAL_REGISTRY — auto-registration for signals. Adding a signal
 * is now ONE import + ONE registry entry (the prior if-chain required an
 * import + a bespoke if-block per signal, contradicting the file's "adding
 * a check or signal is a one-line registration, no core changes" claim).
 * Each entry carries the signal id, the function, and an optional guard
 * (e.g. architecture honors `config.skipGraphSignals`). The loop below is
 * the single execution path — a new signal cannot be forgotten because it
 * is wired here once, not scattered as a bespoke if-branch.
 */
interface SignalRegistryEntry {
  id: SignalId;
  fn: SignalFn;
  /** Optional extra predicate (e.g. architecture honors `skipGraphSignals`). */
  guard?: (config: QualityConfig) => boolean;
}

const SIGNAL_REGISTRY: readonly SignalRegistryEntry[] = [
  { id: "codebase-type-level", fn: signalCodebaseTypeLevel },
  { id: "quality-indication", fn: signalQualityIndication },
  { id: "drift", fn: signalDrift },
  { id: "architecture", fn: signalArchitecture, guard: (c) => !c.skipGraphSignals },
  { id: "entropy", fn: signalEntropy },
  { id: "clone-stats", fn: signalCloneStats },
  { id: "code-health", fn: signalCodeHealth },
  { id: "complexity-distribution", fn: signalComplexityDistribution },
];

export interface AnalysisInput {
  codebasePath: string;
  language: LanguageId;
  files: Readonly<Record<string, string>>;
  config: QualityConfig;
}

export async function runAnalysis(input: AnalysisInput): Promise<QualityReport> {
  const start = Date.now();
  const { codebasePath, language, files, config } = input;

  // 1. Parse files for the selected language family.
  const langFilter = new Set<LanguageId>([language]);
  // For C/C++, both.c and.cpp/.h files belong to the same codebase.
  if (language === "c" || language === "cpp") {
    langFilter.add("c");
    langFilter.add("cpp");
  }
  const parsed = await parseFiles(files, langFilter);

  // 2. Run checks.
  const allFindings: Finding[] = [];
  for (const checkId of config.enabledChecks) {
    const fn = CHECK_REGISTRY[checkId];
    if (!fn) continue;
    if (checkId === "duplicate-body" && config.skipDuplicates) continue;
    const findings = fn(parsed, config);
    allFindings.push(...findings);
  }
  // Run extra checks (high-nesting reported under complexity-hotspot id).
  for (const fn of EXTRA_CHECKS) {
    if (!config.enabledChecks.has("complexity-hotspot")) continue;
    const findings = fn(parsed, config);
    allFindings.push(...findings);
  }

  // 3. Compute signals. R49-V3: the registry is the single execution path
  // (auto-registration — a new signal is wired once in SIGNAL_REGISTRY).
  const allSignals: SignalValue[] = [];
  for (const { id, fn, guard } of SIGNAL_REGISTRY) {
    if (!config.enabledSignals.has(id)) continue;
    if (guard && !guard(config)) continue;
    allSignals.push(...fn(parsed, config, allFindings));
  }

  // 4. Summarize.
  const byCheck: Record<string, number> = {};
  for (const f of allFindings) {
    byCheck[f.checkId] = (byCheck[f.checkId] ?? 0) + 1;
  }

  return {
    codebasePath,
    language,
    generatedAt: new Date().toISOString(),
    files: {
      scanned: parsed.length,
      parsed: parsed.length,
      parseErrors: parsed.reduce((s, f) => s + f.parseErrors.length, 0),
      loc: parsed.reduce((s, f) => s + f.loc, 0),
    },
    findings: allFindings,
    signals: allSignals,
    byCheck,
    durationMs: Date.now() - start,
  };
}
