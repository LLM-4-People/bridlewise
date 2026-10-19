/**
 * no-unsafe-finally check (EXP462 — ESLint no-unsafe-finally).
 *
 * Flags `return`, `throw`, `break`, `continue` inside a `finally` block.
 * These statements swallow the exception or return value from the
 * try/catch — the finally's control flow overrides the try block's,
 * usually unintentionally. The check scans for the `finally` keyword and
 * checks control-flow statements ONLY in the finally block (not the
 * try/catch). Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const CONTROL_RE = /\b(return|throw|break|continue)\b/;

export function checkNoUnsafeFinally(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    let inFinally = false;
    let finallyDepth = -1;
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      // Process character by character so we know EXACTLY when we enter
      // the finally block and at what depth.
      let j = 0;
      const lineLen = code.length;
      while (j < lineLen) {
        // Detect `finally {` at this position.
        if (!inFinally && code.startsWith("finally", j) && /\s/.test(code[j + 7] ?? "{")) {
          // Find the opening brace.
          let k = j + 7;
          while (k < lineLen && /\s/.test(code[k]!)) k += 1;
          if (code[k] === "{") {
            inFinally = true;
            finallyDepth = depth;
            depth += 1;
            j = k + 1;
            continue;
          }
        }
        if (code[j] === "{") depth += 1;
        else if (code[j] === "}") {
          depth -= 1;
          if (inFinally && depth < finallyDepth) { inFinally = false; finallyDepth = -1; }
        }
        j += 1;
      }
      // If we're in the finally block, check for control-flow statements
      // in the portion of this line that's inside the finally.
      if (inFinally) {
        // Extract the part of the line after the finally block opened.
        let finallyPart = code;
        const finIdx = finallyPart.indexOf("finally");
        if (finIdx >= 0 && finallyDepth >= 0) {
          // Find the { after finally.
          let k = finIdx + 7;
          while (k < finallyPart.length && /\s/.test(finallyPart[k]!)) k += 1;
          if (finallyPart[k] === "{") finallyPart = finallyPart.slice(k + 1);
        }
        if (CONTROL_RE.test(finallyPart)) {
          findings.push({
            checkId: "no-unsafe-finally", severity: "warning", filePath: f.path,
            line: i + 1, column: 1, symbol: null,
            message: "return/throw/break/continue inside finally overrides the try block's outcome",
            extra: { file: f.path },
          });
        }
      }
    }
  }
  return findings;
}
