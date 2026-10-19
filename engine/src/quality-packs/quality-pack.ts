import { deepFreeze } from "../kernel/integrity.ts";
import { extractErrorMessage, InputError } from "../kernel/errors.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Reusable multi-language quality pack framework.
 *
 * Implements delivery map item 9 and REQ-015: "Create and maintain
 * project-agnostic multi-language quality modules that catch dead/undefined/
 * unreachable/inconsistent code and project-specific faults before
 * model/manual acceptance."
 *
 * The core owns orchestration and a normalized diagnostic/result schema;
 * language/tool details stay behind pack interfaces (REQ-015 line 68).
 *
 * A pack declares language/runtime detection, supported file/project markers,
 * capability categories, and deterministic required/not-applicable status.
 * A capability that applies to a supported changed artifact is required;
 * unavailable required capability blocks and asks the user.
 *
 * Per the canonical requirements (line 69): "A pack declares language/runtime
 * detection, supported file/project markers, capability categories, latest-
 * stable tool resolution, prerequisites, commands, configuration discovery,
 * output parsers, safe-fix policy, timeouts/resources, cache/freshness
 * inputs, and deterministic required/not-applicable status."
 */

export const QUALITY_PACK_SCHEMA_VERSION = schemaId("quality-pack", 1);

/**
 * Maximum bytes of a source file read by any quality pack or quality CLI.
 * One canonical owner for this limit so the runtime tool and the CLI cannot
 * drift (SSOT). Consumed by `quality-tools.ts` and `quality-packs/cli.ts`.
 */
export const QUALITY_MAX_FILE_BYTES = 1_048_576;

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCategory =
  | "syntax"
  | "type"
  | "undefined-symbol"
  | "dead-code"
  | "dead-branch"
  | "unused-export"
  | "duplicate-logic"
  | "schema-drift"
  | "config-outside-contract"
  | "cycle"
  | "architecture"
  | "weak-test"
  | "security"
  | "tool-error";

export const DIAGNOSTIC_CATEGORIES = deepFreeze([
  "syntax", "type", "undefined-symbol", "dead-code", "dead-branch",
  "unused-export", "duplicate-logic", "schema-drift", "config-outside-contract",
  "cycle", "architecture", "weak-test", "security", "tool-error",
] as const);

export type Diagnostic = Readonly<{
  packId: string;
  checkId: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  filePath: string | null;
  line: number;
  column: number;
  symbol: string | null;
  evidence: string | null;
  autoFixable: boolean;
}>;

export type QualityCheckStatus = "pass" | "fail" | "not-applicable" | "tool-error";

export type QualityCheckResult = Readonly<{
  checkId: string;
  status: QualityCheckStatus;
  diagnostics: readonly Diagnostic[];
  duration: number;
  message: string | null;
}>;

export type QualityContext = Readonly<{
  filePath: string | null;
  source: string | null;
  rootPath: string | null;
  files: Readonly<Record<string, string>>;
  config: Readonly<Record<string, unknown>>;
}>;

export type QualityCheck = Readonly<{
  id: string;
  description: string;
  category: DiagnosticCategory;
  defaultSeverity: DiagnosticSeverity;
  run(context: QualityContext): readonly Diagnostic[];
}>;

export type QualityPack = Readonly<{
  id: string;
  language: string;
  version: string;
  checks: readonly QualityCheck[];
  detect(files: Readonly<Record<string, string>>): boolean;
}>;

export type QualityResult = Readonly<{
  packId: string;
  schemaVersion: typeof QUALITY_PACK_SCHEMA_VERSION;
  checkResults: readonly QualityCheckResult[];
  summary: Readonly<{
    totalChecks: number;
    passed: number;
    failed: number;
    notApplicable: number;
    toolErrors: number;
    totalDiagnostics: number;
    errors: number;
    warnings: number;
    infos: number;
  }>;
  exitCode: 0 | 1;
}>;

export type QualityPackRegistry = Readonly<{
  register(pack: QualityPack): void;
  resolve(language: string): QualityPack | null;
  resolveForFiles(files: Readonly<Record<string, string>>): readonly QualityPack[];
  list(): readonly QualityPack[];
  has(language: string): boolean;
}>;

export function createQualityPackRegistry(): QualityPackRegistry {
  const packs = new Map<string, QualityPack>();
  return deepFreeze({
    register(pack: QualityPack): void {
      if (typeof pack.id !== "string" || pack.id.length === 0) {
        throw new InputError("Quality pack id is required", "quality_pack_id_missing");
      }
      if (typeof pack.language !== "string" || pack.language.length === 0) {
        throw new InputError("Quality pack language is required", "quality_pack_language_missing");
      }
      if (packs.has(pack.language)) {
        throw new InputError(
          `Quality pack already registered for language: ${pack.language}`,
          "quality_pack_duplicate",
        );
      }
      if (!Array.isArray(pack.checks) || pack.checks.length === 0) {
        throw new InputError("Quality pack must have at least one check", "quality_pack_no_checks");
      }
      const checkIds = new Set<string>();
      for (const check of pack.checks) {
        if (checkIds.has(check.id)) {
          throw new InputError(
            `Duplicate check id '${check.id}' in pack '${pack.id}'`,
            "quality_pack_duplicate_check",
          );
        }
        checkIds.add(check.id);
      }
      packs.set(pack.language, pack);
    },
    resolve(language: string): QualityPack | null {
      return packs.get(language) ?? null;
    },
    resolveForFiles(files: Readonly<Record<string, string>>): readonly QualityPack[] {
      const applicable: QualityPack[] = [];
      for (const pack of packs.values()) {
        if (pack.detect(files)) applicable.push(pack);
      }
      return deepFreeze(applicable);
    },
    list(): readonly QualityPack[] {
      return deepFreeze([...packs.values()].sort((a, b) => a.language < b.language ? -1 : 1));
    },
    has(language: string): boolean {
      return packs.has(language);
    },
  });
}

export function createDiagnostic(input: {
  packId: string;
  checkId: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  filePath?: string | null;
  line?: number;
  column?: number;
  symbol?: string | null;
  evidence?: string | null;
  autoFixable?: boolean;
}): Diagnostic {
  return deepFreeze({
    packId: input.packId,
    checkId: input.checkId,
    category: input.category,
    severity: input.severity,
    code: input.code,
    message: input.message,
    filePath: input.filePath ?? null,
    line: input.line ?? 0,
    column: input.column ?? 0,
    symbol: input.symbol ?? null,
    evidence: input.evidence ?? null,
    autoFixable: input.autoFixable ?? false,
  });
}

export function runQualityCheck(
  _pack: QualityPack,
  check: QualityCheck,
  context: QualityContext,
): QualityCheckResult {
  const start = Date.now();
  try {
    const diagnostics = check.run(context);
    const duration = Date.now() - start;
    if (!Array.isArray(diagnostics)) {
      return deepFreeze({
        checkId: check.id,
        status: "tool-error",
        diagnostics: [],
        duration,
        message: `Check '${check.id}' returned non-array diagnostics`,
      });
    }
    const hasErrors = diagnostics.some((d) => d.severity === "error");
    return deepFreeze({
      checkId: check.id,
      status: hasErrors ? "fail" : "pass",
      diagnostics: deepFreeze(diagnostics),
      duration,
      message: null,
    });
  } catch (error) {
    const duration = Date.now() - start;
    const message = extractErrorMessage(error);
    return deepFreeze({
      checkId: check.id,
      status: "tool-error",
      diagnostics: [],
      duration,
      message,
    });
  }
}

export function runQualityPack(
  pack: QualityPack,
  context: QualityContext,
): QualityResult {
  const checkResults: QualityCheckResult[] = [];
  for (const check of pack.checks) {
    checkResults.push(runQualityCheck(pack, check, context));
  }
  return summarizeQualityResult(pack.id, checkResults);
}

export function runQualityPackWithCheckIds(
  pack: QualityPack,
  checkIds: readonly string[],
  context: QualityContext,
): QualityResult {
  const idSet = new Set(checkIds);
  const checkResults: QualityCheckResult[] = [];
  for (const check of pack.checks) {
    if (!idSet.has(check.id)) continue;
    checkResults.push(runQualityCheck(pack, check, context));
  }
  return summarizeQualityResult(pack.id, checkResults);
}

function summarizeQualityResult(
  packId: string,
  checkResults: readonly QualityCheckResult[],
): QualityResult {
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  let toolErrors = 0;
  let totalDiagnostics = 0;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const result of checkResults) {
    switch (result.status) {
      case "pass": passed += 1; break;
      case "fail": failed += 1; break;
      case "not-applicable": notApplicable += 1; break;
      case "tool-error": toolErrors += 1; break;
    }
    totalDiagnostics += result.diagnostics.length;
    for (const diag of result.diagnostics) {
      switch (diag.severity) {
        case "error": errors += 1; break;
        case "warning": warnings += 1; break;
        case "info": infos += 1; break;
      }
    }
  }
  const exitCode: 0 | 1 = (failed > 0 || toolErrors > 0) ? 1 : 0;
  return deepFreeze({
    packId,
    schemaVersion: QUALITY_PACK_SCHEMA_VERSION,
    checkResults: deepFreeze(checkResults),
    summary: deepFreeze({
      totalChecks: checkResults.length,
      passed,
      failed,
      notApplicable,
      toolErrors,
      totalDiagnostics,
      errors,
      warnings,
      infos,
    }),
    exitCode,
  });
}

export function isDiagnosticCategory(value: unknown): value is DiagnosticCategory {
  return typeof value === "string" && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(value);
}

export function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "error" || value === "warning" || value === "info";
}

export function mergeQualityResults(
  packId: string,
  results: readonly QualityResult[],
): QualityResult {
  const allCheckResults: QualityCheckResult[] = [];
  for (const result of results) {
    allCheckResults.push(...result.checkResults);
  }
  return summarizeQualityResult(packId, allCheckResults);
}
