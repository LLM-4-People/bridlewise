/**
 * no-fallthrough check (EXP462 — ESLint no-fallthrough).
 *
 * Flags switch-case fallthrough: a case that has statements but no
 * `break`/`return`/`throw` before the next case. Fallthrough is often
 * unintentional and hides bugs. The check skips:
 * - Empty cases (intentional fallthrough to share a body).
 * - Cases ending in `break`, `return`, `throw`, or `// fallthrough`.
 * - The last case (no fallthrough possible).
 * Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsOnly } from "./shared.ts";

const CASE_RE = /\bcase\s+.+?\s*:|\bdefault\s*:/;
const TERMINATOR_RE = /\b(break|return|throw|continue)\b/;

export function checkNoFallthrough(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    let inSwitch = false;
    let switchDepth = -1;
    let depth = 0;
    // Track the current case: its line, whether it has body statements,
    // whether it has a terminator, and whether it's the default.
    let curCase: { line: number; hasBody: boolean; hasTerminator: boolean; isDefault: boolean } | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      const code = stripCommentsOnly(raw);
      if (!inSwitch) {
        if (/\bswitch\s*\(/.test(code)) {
          inSwitch = true;
          switchDepth = depth + (code.includes("{") ? 1 : 0);
        }
        for (let j = 0; j < code.length; j += 1) {
          if (code[j] === "{") depth += 1;
          else if (code[j] === "}") depth -= 1;
        }
        continue;
      }
      // Inside switch.
      const isCase = CASE_RE.test(code);
      if (isCase) {
        // Previous case ended — check for fallthrough.
        if (curCase && curCase.hasBody && !curCase.hasTerminator && !curCase.isDefault) {
          const caseLines = lines.slice(curCase.line, i).join("\n");
          if (!/fall\s*through|falls?\s*through|fallthrough/i.test(caseLines)) {
            findings.push({
              checkId: "no-fallthrough", severity: "warning", filePath: f.path,
              line: curCase.line + 1, column: 1, symbol: null,
              message: "Switch case falls through to the next case — add break/return/throw or a `// fallthrough` comment",
              extra: { file: f.path, caseLine: curCase.line + 1 },
            });
          }
        }
        curCase = {
          line: i,
          hasBody: false,
          hasTerminator: false,
          isDefault: /\bdefault\s*:/.test(code),
        };
        // Check if the case line itself has a terminator after the colon.
        const afterColon = code.split(":").slice(1).join(":").trim();
        if (afterColon && TERMINATOR_RE.test(afterColon)) curCase.hasTerminator = true;
        // If there's any code after the colon (not just a label), it's body.
        if (afterColon && afterColon.length > 0) curCase.hasBody = true;
      } else if (curCase) {
        const trimmed = code.trim();
        if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) {
          // blank/comment — don't change state
        } else if (trimmed.startsWith("}") || (depth < switchDepth && code.includes("}"))) {
          // End of switch — check last case.
          if (curCase.hasBody && !curCase.hasTerminator && !curCase.isDefault) {
            const caseLines = lines.slice(curCase.line, i).join("\n");
            if (!/fall\s*through|falls?\s*through|fallthrough/i.test(caseLines)) {
              findings.push({
                checkId: "no-fallthrough", severity: "warning", filePath: f.path,
                line: curCase.line + 1, column: 1, symbol: null,
                message: "Switch case falls through — add break/return/throw or `// fallthrough`",
                extra: { file: f.path, caseLine: curCase.line + 1 },
              });
            }
          }
          inSwitch = false;
          curCase = null;
        } else {
          if (TERMINATOR_RE.test(code)) curCase.hasTerminator = true;
          curCase.hasBody = true;
        }
      }
      for (let j = 0; j < code.length; j += 1) {
        if (code[j] === "{") depth += 1;
        else if (code[j] === "}") depth -= 1;
      }
    }
    // Handle last case at EOF.
    if (curCase && curCase.hasBody && !curCase.hasTerminator && !curCase.isDefault) {
      const caseLines = lines.slice(curCase.line).join("\n");
      if (!/fall\s*through|falls?\s*through|fallthrough/i.test(caseLines)) {
        findings.push({
          checkId: "no-fallthrough", severity: "warning", filePath: f.path,
          line: curCase.line + 1, column: 1, symbol: null,
          message: "Switch case falls through — add break/return/throw or `// fallthrough`",
          extra: { file: f.path, caseLine: curCase.line + 1 },
        });
      }
    }
  }
  return findings;
}
