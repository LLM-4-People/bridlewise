/**
 * no-throw-literal check (EXP462 — ESLint no-throw-literal).
 *
 * Flags `throw "string"`, `throw 42`, `throw null` — throwing a non-Error
 * value loses the stack trace and breaks `catch (e) { e.message }`
 * patterns. Only `throw new...Error(...)` is safe. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsOnly } from "./shared.ts";

const THROW_LITERAL_RE = /\bthrow\s+(?!new\b)(["'`]|[0-9]|\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|\{|\[)/;

export function checkNoThrowLiteral(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsOnly(lines[i] ?? "");
      if (!THROW_LITERAL_RE.test(code)) continue;
      findings.push({
        checkId: "no-throw-literal", severity: "warning", filePath: f.path,
        line: i + 1, column: 1, symbol: null,
        message: "Throw a new Error(...) — a string/number literal loses the stack trace",
        extra: { file: f.path },
      });
    }
  }
  return findings;
}
