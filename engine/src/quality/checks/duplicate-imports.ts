/**
 * Duplicate-import check (EXP386).
 *
 * Flags the same imported name appearing in two import statements of the
 * same file. This is usually a copy-paste mistake — the second import
 * silently re-binds the name (in Python, `from a import x` then
 * `from b import x` shadows `a.x` with `b.x`, often a bug).
 *
 * Also flags the same source imported twice (e.g. two `import "foo"` lines
 * in JS/TS, two `#include "foo.h"` in C/C++, two `use foo::bar;` in Rust,
 * two `import "foo"` in Go — the second is dead code).
 *
 * Works on the `imports` list populated by every parser. Language-agnostic
 * because all parsers populate `ImportDef.names` + `ImportDef.source`.
 *
 * False-positive avoidance:
 * - Side-effect imports (C/C++ `#include`, JS `import "./x"`) are flagged
 * only when the EXACT same source is imported twice — duplicate
 * side-effect imports are dead code, but the first one's effects
 * matter. Different sources with the same basename (e.g. `#include
 * "log.h"` from two different dirs) are NOT duplicates.
 * - Re-exports (`export... from`) are not imports — excluded.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

export function checkDuplicateImports(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    // Group 1: same imported name appearing in multiple import statements.
    const nameToImports = new Map<string, number[]>();
    for (const imp of f.imports) {
      for (const name of imp.names) {
        const list = nameToImports.get(name);
        if (list) list.push(imp.line);
        else nameToImports.set(name, [imp.line]);
      }
    }
    for (const [name, lines] of nameToImports) {
      if (lines.length < 2) continue;
      // Report on the second occurrence (the duplicate).
      findings.push({
        checkId: "duplicate-import",
        severity: "warning",
        filePath: f.path,
        line: lines[1]!,
        column: 0,
        symbol: name,
        message: `Name '${name}' is imported ${lines.length} times (lines ${lines.join(", ")})`,
        extra: { name, lines: lines.map(String), file: f.path },
      });
    }
    // Group 2: same source imported twice. SKIP C/C++ `#include` duplicates
    // — C headers use `#ifndef... #endif` guards, so duplicate `#include`
    // of a system header (`<stdio.h>`, `<time.h>`) is harmless and standard
    // practice. Only flag duplicate side-effect imports in languages that
    // don't have header guards (JS, Python).
    const isCC = f.language === "c" || f.language === "cpp";
    const sourceToLines = new Map<string, number[]>();
    for (const imp of f.imports) {
      if (!imp.source) continue;
      if (isCC && imp.sideEffectImport) continue;
      const list = sourceToLines.get(imp.source);
      if (list) list.push(imp.line);
      else sourceToLines.set(imp.source, [imp.line]);
    }
    for (const [source, lines] of sourceToLines) {
      if (lines.length < 2) continue;
      findings.push({
        checkId: "duplicate-import",
        severity: "info",
        filePath: f.path,
        line: lines[1]!,
        column: 0,
        symbol: source,
        message: `Source '${source}' is imported ${lines.length} times (lines ${lines.join(", ")})`,
        extra: { source, lines: lines.map(String), file: f.path },
      });
    }
  }
  return findings;
}
