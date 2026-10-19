/**
 * unnecessary-type-assertion check (EXP462 — TS no-unnecessary-type-assertion).
 *
 * Flags `x as Type` where the `as` is redundant: `const x = obj as any`
 * on a value that's already `any`, or `const x = foo as Foo` when `foo`
 * is already typed `Foo`. The check uses a heuristic: if the assertion
 * type matches the declared type, it's redundant. Without a full type
 * system, this flags the common redundant cases:
 * - `const x = 1 as number` (literal → same primitive).
 * - `foo as any as Foo` (double assertion where the first is `any`).
 * TS-only. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const DOUBLE_ASSERT_RE = /\bas\s+any\s+as\s+/;
const LITERAL_AS_PRIMITIVE_RE = /\b(\d+)\s+as\s+number\b|\b(true|false)\s+as\s+boolean\b|["'`].*["'`]\s+as\s+string\b/;

export function checkUnnecessaryTypeAssertion(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.language !== "typescript") continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (DOUBLE_ASSERT_RE.test(code)) {
        findings.push({
          checkId: "unnecessary-type-assertion", severity: "info", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "Double assertion `as any as Foo` — the `as any` is redundant if the source is assignable",
          extra: { file: f.path },
        });
      }
      if (LITERAL_AS_PRIMITIVE_RE.test(code)) {
        findings.push({
          checkId: "unnecessary-type-assertion", severity: "info", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "Redundant type assertion — the literal is already of that primitive type",
          extra: { file: f.path },
        });
      }
    }
  }
  return findings;
}
