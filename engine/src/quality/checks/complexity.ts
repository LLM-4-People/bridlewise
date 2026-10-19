/**
 * Complexity & long-function checks (EXP357).
 *
 * Cyclomatic complexity per function (already computed by parsers via
 * `countBranchPoints`), and a long-function check (body lines ≥ threshold).
 *
 * EXP324 found complexity carries the highest Fisher information among
 * quality signals; we report both raw complexity and length distribution.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

export function checkComplexityHotspots(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const threshold = config.thresholds.complexityHotspot;
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.cyclomaticComplexity >= threshold) {
        findings.push({
          checkId: "complexity-hotspot",
          severity: sym.cyclomaticComplexity >= threshold * 2 ? "error" : "warning",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `Function '${sym.name}' has cyclomatic complexity ${sym.cyclomaticComplexity} (≥ ${threshold})`,
          extra: {
            complexity: sym.cyclomaticComplexity,
            nesting: sym.maxNestingDepth,
            params: sym.paramCount,
            bodyLines: sym.bodyLines,
          },
        });
      }
    }
  }
  return findings;
}

export function checkLongFunctions(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const threshold = config.thresholds.longFunction;
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.bodyLines >= threshold) {
        findings.push({
          checkId: "long-function",
          severity: "info",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `Function '${sym.name}' spans ${sym.bodyLines} lines (≥ ${threshold})`,
          extra: { bodyLines: sym.bodyLines, complexity: sym.cyclomaticComplexity },
        });
      }
    }
  }
  return findings;
}

export function checkHighNesting(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  // Reuse complexity threshold as a nesting proxy: nesting ≥ complexityThreshold/3 is suspicious.
  const threshold = Math.max(config.thresholds.nestingThresholdFloor, Math.floor(config.thresholds.complexityHotspot / 3));
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.maxNestingDepth >= threshold) {
        findings.push({
          checkId: "complexity-hotspot",
          severity: "info",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `Function '${sym.name}' nests ${sym.maxNestingDepth} levels deep (≥ ${threshold})`,
          extra: { nesting: sym.maxNestingDepth, complexity: sym.cyclomaticComplexity },
        });
      }
    }
  }
  return findings;
}
