/**
 * no-dupe-class-members check (EXP462 — ESLint no-dupe-class-members).
 *
 * Flags duplicate member names in a class: `class { foo {} foo {} }`
 * or `class { bar = 1; bar {} }`. The second silently overwrites the
 * first. JS-family only. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)\b/;
// Match method/field declarations inside a class: `name(`, `name =`, `name;`.
const MEMBER_RE = /(?:^|[\s{;])(?:static\s+|get\s+|set\s+|async\s+|public\s+|private\s+|protected\s+|readonly\s+)*\s*([A-Za-z_$][\w$]*)\s*[(<:=;]/;

export function checkNoDupeClassMembers(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    let inClass = false;
    let classDepth = -1;
    let depth = 0;
    let members = new Map<string, number>();
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      // Detect class declaration.
      const cls = CLASS_RE.exec(code);
      if (cls && !inClass) {
        inClass = true;
        members = new Map();
        // Find the opening brace.
        const braceIdx = code.indexOf("{");
        if (braceIdx >= 0) { classDepth = depth + 1; depth += 1; }
      }
      if (!inClass) {
        for (let j = 0; j < code.length; j += 1) {
          if (code[j] === "{") depth += 1;
          else if (code[j] === "}") depth -= 1;
        }
        continue;
      }
      // Inside class — detect members.
      const mm = MEMBER_RE.exec(code);
      if (mm) {
        const name = mm[1]!;
        if (name !== "constructor" && name !== "extends" && name !== "class" && name !== "new") {
          if (members.has(name)) {
            findings.push({
              checkId: "no-dupe-class-members", severity: "warning", filePath: f.path,
              line: i + 1, column: 1, symbol: name,
              message: `Duplicate class member '${name}' — later definition overwrites the earlier`,
              extra: { file: f.path, member: name, firstLine: members.get(name)! + 1 },
            });
          }
          members.set(name, i);
        }
      }
      // Track depth to detect class close.
      for (let j = 0; j < code.length; j += 1) {
        if (code[j] === "{") depth += 1;
        else if (code[j] === "}") {
          depth -= 1;
          if (inClass && depth < classDepth) {
            inClass = false;
            members.clear();
          }
        }
      }
    }
  }
  return findings;
}
