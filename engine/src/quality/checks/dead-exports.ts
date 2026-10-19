/**
 * Dead-export check (EXP368, Fix 4).
 *
 * An exported symbol that is never imported by ANY other file in the
 * codebase. Reuses the same import-graph-accurate algorithm as EXP349's
 * `codebase-quality-pack.ts`, but language-agnostic.
 *
 * FIX vs EXP357 (40-80% FP for generated/barrel files):
 * - Detects BARREL files (only re-exports, no logic) via `barrel-detection.ts`
 * and excludes their exports (their exports are public API surface).
 * - Detects GENERATED files (`auto-generated`, `do not edit`, `@generated`)
 * and excludes their exports.
 * - Python `__init__.py` files are conventionally barrels — excluded.
 * - JS/TS `index.{ts,js}` files at package roots with re-exports are excluded.
 *
 * Language semantics:
 * - JS/TS: re-exports / `export` declarations
 * - Python: module-level `def`/`class` or names in `__all__`
 * - Rust: `pub fn`/`pub struct`/etc.
 * - Go: capitalized names
 * - Java: `public`/`protected`/package-private members
 * - C: symbols in `.h` files (or `extern`)
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { shouldExcludeFromDeadExport, type BarrelDetectionConfig } from "./barrel-detection.ts";

export function checkDeadExports(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const importedNames = new Set<string>();
  // For C/C++: build a set of header basenames that are #include'd anywhere.
  const includedHeaders = new Set<string>();
  for (const f of files) {
    for (const imp of f.imports) {
      for (const n of imp.names) {
        importedNames.add(n);
      }
      if (imp.sideEffectImport) {
        const seg = imp.source.split("/").pop() ?? imp.source;
        includedHeaders.add(seg);
      }
    }
  }
  // Build a global map: name → set of file paths that contain the name as a
  // token. This catches dynamic dispatch, reflection, string references, and
  // public API references in docs — reducing FPs where an export is "dead
  // within the import graph" but actually used via other means.
  const nameToFiles = new Map<string, Set<string>>();
  const IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*|_\d+/g;
  for (const f of files) {
    for (const m of f.content.matchAll(IDENT_RE)) {
      const tok = m[0];
      if (!tok) continue;
      let set = nameToFiles.get(tok);
      if (!set) { set = new Set(); nameToFiles.set(tok, set); }
      set.add(f.path);
    }
  }

  const testFileRe = /(^|\/)(test|tests|__tests__|spec|specs|conftest|fixtures|t)\b/i;
  const testSuffixRe = /[_\.](test|spec)\.(go|py|ts|js|java|rs|c|cpp)$|_test\.(go|py|c)$/i;
  const declFileRe = /\.d\.(ts|cts|mts|cts)$/;
  const barrelCfg: BarrelDetectionConfig = {
    maxNonExportedSymbols: config.thresholds.barrelMaxNonExportedSymbols,
    minExports: config.thresholds.barrelMinExports,
  };

  for (const f of files) {
    if (config.entryPoints.has(f.path)) continue;
    if (testFileRe.test(f.path) || testSuffixRe.test(f.path)) continue;
    if (declFileRe.test(f.path)) continue;
    if (shouldExcludeFromDeadExport(f, barrelCfg)) continue;
    const isCHeader = /\.(h|hpp|hxx|hh)$/.test(f.path.toLowerCase());
    if (isCHeader) {
      const headerSeg = f.path.split("/").pop() ?? f.path;
      if (includedHeaders.has(headerSeg)) continue;
    }
    if (/(^|\/)(deps|vendor|third_party|extern)\//.test(f.path)) continue;
    for (const exp of f.exports) {
      if (exp.name === "default" || exp.kind === "module") continue;
      if (exp.kind === "method") continue;
      if (/^(Test|Benchmark|Example|Fuzz)/.test(exp.name)) continue;
      if (exp.name.startsWith("__") && exp.name.endsWith("__")) continue;
      // Skip very short names (likely operators or partial tokens).
      if (exp.name.length < 2) continue;
      if (!importedNames.has(exp.name)) {
        // Secondary check: is the name referenced as a token in any OTHER
        // file (not just the declaring file)? If yes, it's likely public API
        // or dynamically dispatched — NOT dead.
        const refFiles = nameToFiles.get(exp.name);
        let referencedElsewhere = false;
        if (refFiles) {
          for (const p of refFiles) {
            if (p !== f.path) { referencedElsewhere = true; break; }
          }
        }
        if (referencedElsewhere) continue;
        findings.push({
          checkId: "dead-export",
          severity: "warning",
          filePath: f.path,
          line: exp.line,
          column: 0,
          symbol: exp.name,
          message: `Exported '${exp.name}' (${exp.kind}) is never imported by any other file`,
          extra: { kind: exp.kind, file: f.path },
        });
      }
    }
  }
  return findings;
}
