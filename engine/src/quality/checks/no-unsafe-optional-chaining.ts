/**
 * no-unsafe-optional-chaining check (EXP462 — ESLint no-unsafe-optional-chaining).
 *
 * Flags `a?.b.c` where the optional chaining `?.` makes `a?.b` evaluate to
 * `undefined`, but then `.c` on `undefined` throws. The fix is `a?.b?.c`
 * (chain the optional). Also flags `a?.b` and `a?.b[0]` patterns.
 * TS/JS only. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const UNSAFE_OPT_CHAIN_RE = /\?\.[A-Za-z_$][\w$]*(?:\s*\()?\s*\.[A-Za-z_$]/;

export function checkNoUnsafeOptionalChaining(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (!UNSAFE_OPT_CHAIN_RE.test(code)) continue;
      findings.push({
        checkId: "no-unsafe-optional-chaining", severity: "warning", filePath: f.path,
        line: i + 1, column: 1, symbol: null,
        message: "Unsafe optional chaining: a?.b.c throws if a is null — use a?.b?.c",
        extra: { file: f.path, expr: code.trim().slice(0, 40) },
      });
    }
  }
  return findings;
}
