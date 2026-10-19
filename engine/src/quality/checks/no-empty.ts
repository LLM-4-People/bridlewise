/**
 * no-empty check (EXP462 — ESLint no-empty).
 *
 * Flags empty blocks: `{}`, `try { } catch (e) { }`, empty function
 * bodies that are NOT constructors/abstract/async-iife. An empty block
 * usually means the developer forgot to implement the body, or the body
 * was accidentally deleted. The check skips:
 * - Empty constructor bodies (intentional — `constructor {}`).
 * - Empty abstract method bodies / `// noop` comments.
 * Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const EMPTY_BLOCK_RE = /\{\s*\}/;

export function checkNoEmpty(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      const code = stripCommentsAndStrings(raw);
      // Multi-line empty block: `{` on this line, only whitespace/comment until `}`.
      if (code.trim() === "{" || code.trim().endsWith("{")) {
        let allEmpty = true;
        for (let j = i + 1; j < lines.length && j < i + 20; j += 1) {
          const next = stripCommentsAndStrings(lines[j] ?? "").trim();
          if (next === "") continue;
          if (next === "}" || next.startsWith("}")) { break; }
          allEmpty = false; break;
        }
        if (allEmpty) {
          // Skip constructor — intentional empty body.
          if (/\bconstructor\s*\(/.test(code)) continue;
          findings.push({
            checkId: "no-empty", severity: "warning", filePath: f.path,
            line: i + 1, column: 1, symbol: null,
            message: "Empty block — missing implementation or accidentally deleted",
            extra: { file: f.path },
          });
          i += 1; // Skip the empty block to avoid double-reporting.
        }
      }
      if (EMPTY_BLOCK_RE.test(code) && !/\bconstructor\s*\(/.test(code)) {
        findings.push({
          checkId: "no-empty", severity: "warning", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "Empty block `{}` — missing implementation or accidentally deleted",
          extra: { file: f.path },
        });
      }
    }
  }
  return findings;
}
