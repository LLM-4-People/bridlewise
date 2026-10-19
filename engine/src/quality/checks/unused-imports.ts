/**
 * Unused-import check (EXP368, Fix 2).
 *
 * An imported name that is never referenced in the importing file's body.
 * We approximate "referenced" by word-boundary search for the name outside
 * the import line itself. Language-agnostic.
 *
 * FIX vs EXP357 (which had 100% FP for C/C++ and 40-60% for Go/Python):
 * - C/C++ `#include` is a SIDE-EFFECT import — it pastes the whole header,
 * not named symbols. Marked via `import.sideEffectImport = true` by the
 * parser; this check skips those entirely. (Separate `unused-header`
 * check is a future enhancement — see `unused-header-symbols`.)
 * - Python `__future__` imports are also side-effect (parser marks them).
 * - Go blank imports (`_ "pkg"`) and dot imports (`. "pkg"`) are side-effect.
 * - JS side-effect imports (`import "./x"`) are side-effect.
 *
 * The unused-header check (separate concern) detects headers that are never
 * `#include`'d anywhere in the codebase — not handled here.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

function countWordOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    i = haystack.indexOf(needle, i);
    if (i < 0) break;
    const before = i > 0 ? haystack[i - 1] ?? " " : " ";
    const after = haystack[i + needle.length] ?? " ";
    const isWord = !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
    if (isWord) count += 1;
    i += needle.length;
  }
  return count;
}

export function checkUnusedImports(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    // __init__.py files conventionally re-export — skip them.
    if (f.path.endsWith("/__init__.py") || f.path === "__init__.py") continue;
    // Skip files in test/fixture DIRECTORIES (not files named test.*).
    // Test fixtures intentionally have unused imports (testing the
    // transform plugin's ability to remove them).
    if (/(^|\/)(test|tests|__tests__|spec|specs|fixtures|conftest)\//i.test(f.path)) continue;
    for (const imp of f.imports) {
      // Skip side-effect imports (C/C++ #include, __future__, Go blank/dot,
      // JS `import "./x"`). These have no named symbols to reference.
      if (imp.sideEffectImport) continue;
      for (const name of imp.names) {
        if (!name) continue;
        // Skip underscore-only imports (Go uses `_` for side-effect imports).
        if (name === "_") continue;
        // Skip glob imports (`*`) — they import everything, not a specific name.
        if (name === "*") continue;
        // Skip Go imports where the extracted name contains a hyphen or dot
        // (the actual package name differs from the path segment — e.g.,
        // `github.com/x/go-conntrack` has package name `conntrack`, not
        // `go-conntrack`). We can't know the real package name without
        // reading the imported file, so skip these to avoid FPs.
        if (f.language === "go" && /[.-]/.test(name) && !name.startsWith("v")) continue;
        // Rust: skip trait imports. Rust traits are imported with `use` to
        // bring their methods into scope, but the trait name itself is never
        // referenced. Without type info, we can't distinguish traits from
        // types. Heuristic: if the name is a single Capitalized identifier
        // (PascalCase) and the file has method-call chains (`.method(`),
        // treat it as a likely trait import and skip. The Rust compiler's
        // own `unused_imports` lint is authoritative for Rust.
        if (f.language === "rust" && /^[A-Z][a-zA-Z0-9]*$/.test(name)) {
          if (/\.\w+\s*\(/.test(f.content)) continue;
        }
        // Count occurrences in the file body excluding the import line itself.
        const lines = f.content.split("\n");
        let uses = 0;
        for (let i = 0; i < lines.length; i += 1) {
          if (i + 1 === imp.line) continue; // skip the import line itself
          uses += countWordOccurrences(lines[i] ?? "", name);
        }
        if (uses === 0) {
          findings.push({
            checkId: "unused-import",
            severity: "warning",
            filePath: f.path,
            line: imp.line,
            column: 0,
            symbol: name,
            message: `Imported '${name}' is never referenced in the file body`,
            extra: { source: imp.source, file: f.path },
          });
        }
      }
    }
  }
  return findings;
}

/** Unused-header check (separate from unused-import). Detects C/C++ header
 * files (`.h`/`.hpp`) that are NEVER `#include`'d by any `.c`/`.cpp`/`.cc`
 * file in the codebase. This is the correct way to find "dead" C/C++ headers
 * — not by checking if the header name is referenced as a word. */
export function checkUnusedHeaders(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const includedHeaders = new Set<string>();
  for (const f of files) {
    for (const imp of f.imports) {
      if (!imp.sideEffectImport) continue; // only #include imports are side-effect
      // Normalize the header basename.
      const seg = imp.source.split("/").pop() ?? imp.source;
      includedHeaders.add(seg);
    }
  }
  for (const f of files) {
    // Only header files can be "unused headers".
    if (!/\.(h|hpp|hxx|hh)$/.test(f.path.toLowerCase())) continue;
    const seg = f.path.split("/").pop() ?? f.path;
    // Skip test/fixture headers.
    if (/test|fixture|spec/i.test(f.path)) continue;
    if (!includedHeaders.has(seg)) {
      findings.push({
        checkId: "unused-import",
        severity: "info",
        filePath: f.path,
        line: 1,
        column: 0,
        symbol: seg,
        message: `Header '${seg}' is never #include'd by any source file in the codebase`,
        extra: { file: f.path, kind: "unused-header" },
      });
    }
  }
  return findings;
}
