/**
 * no-inner-declarations check (EXP462 — ESLint no-inner-declarations).
 *
 * Flags `function` declarations inside a block (`{... }`) that is not
 * the top level of a function or module. In JS sloppy mode, function
 * declarations inside blocks have inconsistent hoisting across engines.
 * ES6+ block-scoped function declarations are well-defined, but the
 * pattern is still a code smell — use a const arrow function instead.
 * JS-family only. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const FN_DECL_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;

export function checkNoInnerDeclarations(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    let depth = 0;
    let fnStartDepth: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      // Track function-entry depth: when we see `function name(`, the body
      // opens at depth+1. Declarations INSIDE that body are OK (they're at
      // the top level of the function). Declarations INSIDE a nested block
      // (depth > fnStartDepth+1) are flagged.
      const m = FN_DECL_RE.exec(code);
      if (m && fnStartDepth !== null && depth > fnStartDepth + 1) {
        const name = m[1] ?? null;
        findings.push({
          checkId: "no-inner-declarations", severity: "info", filePath: f.path,
          line: i + 1, column: 1, symbol: name,
          message: `Function '${name}' declared inside a nested block — hoist to the top level or use a const arrow`,
          extra: { file: f.path, name },
        });
      }
      for (let j = 0; j < code.length; j += 1) {
        if (code[j] === "{") depth += 1;
        else if (code[j] === "}") depth -= 1;
      }
      if (m) { fnStartDepth = depth; depth += 1; }
    }
  }
  return findings;
}
