/**
 * no-control-regex check (EXP462 — ESLint no-control-regex).
 *
 * Flags regular expressions containing control characters (U+0000–U+001F),
 * e.g. `/\x00/`, `/\u0000/`, or a literal control char. Control characters
 * in regexes are almost always a mistake (copy-paste from a binary
 * source) and hard to spot. JS-family. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const REGEX_RE = /\/(?:[^/\\\n]|\\.)+\//g;
const CONTROL_CHAR_RE = /\\x[0-9a-fA-F]{2}|\\u0000|\\u00[01][0-9a-fA-F]|[\x00-\x1f]/;

export function checkNoControlRegex(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      REGEX_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = REGEX_RE.exec(code)) !== null) {
        const regex = m[0];
        if (!CONTROL_CHAR_RE.test(regex)) continue;
        // Check if the control char reference is a low control (U+0000-U+001F).
        if (/\\x[0-9a-fA-F]{1,2}/.test(regex) || /\\u00[01][0-9a-fA-F]/.test(regex) || /[\x00-\x1f]/.test(regex)) {
          findings.push({
            checkId: "no-control-regex", severity: "warning", filePath: f.path,
            line: i + 1, column: m.index + 1, symbol: null,
            message: "Regex contains a control character (U+0000–U+001F) — likely a copy-paste error",
            extra: { file: f.path, regex: regex.slice(0, 40) },
          });
        }
      }
    }
  }
  return findings;
}
