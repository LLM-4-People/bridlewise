/**
 * no-unreachable-code check (EXP462 — ESLint no-unreachable-code, enhanced).
 *
 * Flags code after an unconditional `return`, `throw`, `break`, or
 * `continue` statement within the same block. The existing dead-code
 * check catches unused symbols; this check catches unreachable
 * STATEMENTS (which may be used symbols that never execute). Uses a
 * brace-depth scanner to stay within the same block. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const TERMINATOR_RE = /\b(return|throw|break|continue)\b/;

export function checkNoUnreachableCode(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    let depth = 0;
    let terminatorAtDepth: number | null = null;
    let terminatorLine = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      // Check for code after a terminator at the SAME depth.
      if (terminatorAtDepth !== null && depth === terminatorAtDepth) {
        const trimmed = code.trim();
        // Closing brace ends the block — reset.
        if (trimmed.startsWith("}")) {
          // Consume closing braces; if depth drops below terminator, reset.
        } else if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
          findings.push({
            checkId: "no-unreachable-code", severity: "warning", filePath: f.path,
            line: i + 1, column: 1, symbol: null,
            message: `Unreachable code after ${terminatorLine >= 0 ? "line " + (terminatorLine + 1) : "terminator"}`,
            extra: { file: f.path, afterLine: terminatorLine + 1 },
          });
          terminatorAtDepth = null;
        }
      }
      for (let j = 0; j < code.length; j += 1) {
        if (code[j] === "{") depth += 1;
        else if (code[j] === "}") {
          depth -= 1;
          if (terminatorAtDepth !== null && depth < terminatorAtDepth) { terminatorAtDepth = null; }
        }
      }
      if (TERMINATOR_RE.test(code) && !code.includes("//")) {
        terminatorAtDepth = depth;
        terminatorLine = i;
      }
    }
  }
  return findings;
}
