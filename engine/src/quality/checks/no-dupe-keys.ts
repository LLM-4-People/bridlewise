/**
 * no-dupe-keys check (EXP462 — ESLint no-dupe-keys).
 *
 * Flags duplicate keys in object literals: `{ a: 1, a: 2 }`. The second
 * value silently overwrites the first — almost always a bug. The check
 * tracks object-brace depth and collects keys per object. JS-family +
 * Python dicts. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsOnly, isJsFamily } from "./shared.ts";

const KEY_RE = /(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*:/g;

export function checkNoDupeKeys(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const js = isJsFamily(f.path, f.language);
    if (!js && f.language !== "python") continue;
    const lines = f.content.split("\n");
    // Stack of { keys: Set, depth } — one entry per open object/dict.
    const objStack: { keys: Set<string>; depth: number }[] = [];
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsOnly(lines[i] ?? "");
      // First pass: track brace depth + push/pop object stack.
      // We need the stack state at each key position, so we interleave.
      let j = 0;
      while (j < code.length) {
        const c = code[j]!;
        if (c === "{" || (!js && c === "(")) {
          depth += 1;
          // Push a new object context.
          objStack.push({ keys: new Set(), depth });
        } else if (c === "}" || (!js && c === ")")) {
          depth -= 1;
          if (objStack.length > 0 && depth < objStack[objStack.length - 1]!.depth - 1) {
            objStack.pop();
          } else if (objStack.length > 0 && c === "}") {
            objStack.pop();
          }
        }
        j += 1;
      }
      // Second pass: detect keys on this line. We use the current (post-line)
      // stack state; for one-liners this is slightly imprecise but works for
      // the common case.
      KEY_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      const localKeys = new Set<string>();
      while ((m = KEY_RE.exec(code)) !== null) {
        const key = m[1] ?? m[2] ?? m[3] ?? m[4] ?? null;
        if (!key) continue;
        const inner = objStack[objStack.length - 1];
        if (inner) {
          if (inner.keys.has(key) || localKeys.has(key)) {
            findings.push({
              checkId: "no-dupe-keys", severity: "warning", filePath: f.path,
              line: i + 1, column: m.index + 1, symbol: key,
              message: `Duplicate key '${key}' — later value overwrites the earlier`,
              extra: { file: f.path, key },
            });
          }
          localKeys.add(key);
          inner.keys.add(key);
        }
      }
    }
  }
  return findings;
}
