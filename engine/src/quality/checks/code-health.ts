/**
 * Code-health checks (EXP357).
 *
 * A collection of small, language-agnostic checks operating on parsed files:
 * - todo-comment: TODO/FIXME/HACK/XXX/BUG/NOTE in comments
 * - empty-catch: `catch {}` (JS/TS), `except:` (Python) with no body
 * - magic-number: Numeric literals outside an allowlist (config)
 * - missing-default: switch/match with >1 case and no default/else/_
 * - unused-local: Variables declared but never read (line-text heuristic)
 * - dead-code: Unreachable statements after return/throw/panic
 *
 * These checks use line-text heuristics that are robust across languages.
 * They trade some precision for language-agnosticity; the complexity/dead-
 * export checks above carry the precision weight.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { getLine } from "./shared-helpers.ts";

const TODO_RE = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REFACTOR)\b/;

export function checkTodoComments(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    for (const c of f.comments) {
      const match = c.text.match(TODO_RE);
      if (match) {
        findings.push({
          checkId: "todo-comment",
          severity: "info",
          filePath: f.path,
          line: c.line,
          column: 0,
          symbol: match[1] ?? null,
          message: `${match[1]} comment: ${c.text.slice(0, 80)}`,
          extra: { kind: c.kind, file: f.path },
        });
      }
    }
  }
  return findings;
}

function linesOf(content: string): string[] {
  return content.split("\n");
}

export function checkEmptyCatch(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = linesOf(f.content);
    for (let i = 0; i < lines.length; i += 1) {
      const line = getLine(lines, i);
      // JS/TS: `catch (e) {` followed by `}`
      const jsCatch = line.match(/\bcatch\s*\([^)]*\)\s*\{/);
      if (jsCatch) {
        for (let j = i + 1; j < Math.min(lines.length, i + 10); j += 1) {
          const next = getLine(lines, j).trim();
          if (next.length === 0) continue;
          if (next === "}" || next === "};") {
            findings.push({
              checkId: "empty-catch",
              severity: "warning",
              filePath: f.path,
              line: i + 1,
              column: 0,
              symbol: null,
              message: "Empty catch block silently swallows exceptions",
              extra: { file: f.path },
            });
          }
          break;
        }
        continue;
      }
      // Python: `except:` or `except Exception:` followed by `pass`
      const pyExcept = line.match(/^\s*except(\s+\w+(\.\w+)*(\s+as\s+\w+)?)?\s*:\s*$/);
      if (pyExcept) {
        for (let j = i + 1; j < Math.min(lines.length, i + 20); j += 1) {
          const next = getLine(lines, j);
          if (next.trim().length === 0) continue;
          const passMatch = next.match(/^\s*pass\s*$/);
          if (passMatch) {
            findings.push({
              checkId: "empty-catch",
              severity: "warning",
              filePath: f.path,
              line: i + 1,
              column: 0,
              symbol: null,
              message: "Empty except block (pass) silently swallows exceptions",
              extra: { file: f.path },
            });
          }
          break;
        }
      }
    }
  }
  return findings;
}

export function checkMagicNumbers(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const allow = new Set(config.thresholds.magicNumberAllowlist);
  const allowStrs = new Set(config.thresholds.magicNumberAllowlist.map(String));
  for (const f of files) {
    const lines = linesOf(f.content);
    for (let i = 0; i < lines.length; i += 1) {
      const line = getLine(lines, i);
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
      const matches = line.matchAll(/\b(\d+(?:\.\d+)?)\b/g);
      for (const m of matches) {
        const raw = m[1];
        if (!raw) continue;
        const num = Number(raw);
        if (Number.isNaN(num)) continue;
        if (allow.has(num) || allowStrs.has(raw)) continue;
        const idx = m.index;
        if (idx === undefined) continue;
        // Skip if the number appears in an import line, a version-like pattern, or string literal.
        if (/\b(import|from|use|include|package|module)\b/.test(line.slice(0, idx))) continue;
        if (/\b\d+\.\d+\.\d+/.test(line)) continue;
        const before = line.slice(0, idx);
        const dq = (before.match(/"/g) ?? []).length;
        const sq = (before.match(/'/g) ?? []).length;
        if (dq % 2 === 1 || sq % 2 === 1) continue;
        if (/0x[0-9a-fA-F]+/.test(line.slice(Math.max(0, idx - 2), idx + raw.length + 2))) continue;
        // Only report larger, less-obvious numbers (to keep volume sane).
        if (Math.abs(num) < 100 && num !== 0 && Math.abs(num) !== 1) continue;
        findings.push({
          checkId: "magic-number",
          severity: "info",
          filePath: f.path,
          line: i + 1,
          column: idx + 1,
          symbol: null,
          message: `Magic number ${raw} (not in allowlist)`,
          extra: { value: raw, file: f.path },
        });
        break;
      }
    }
  }
  return findings;
}

export function checkMissingDefault(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = linesOf(f.content);
    for (let i = 0; i < lines.length; i += 1) {
      const line = getLine(lines, i);
      // JS/TS/Java/C: `switch (...) {`... case... no `default:`
      const swMatch = line.match(/\bswitch\s*\(/);
      if (swMatch) {
        let depth = 0;
        let seenCase = false;
        let seenDefault = false;
        let bodyStart = -1;
        for (let j = i; j < Math.min(lines.length, i + 500); j += 1) {
          const l = getLine(lines, j);
          if (l.includes("{")) {
            if (bodyStart < 0) bodyStart = j;
            depth += (l.match(/{/g) ?? []).length;
          }
          if (l.includes("}")) depth -= (l.match(/}/g) ?? []).length;
          if (/\bcase\b/.test(l)) seenCase = true;
          if (/\bdefault\b/.test(l)) seenDefault = true;
          if (depth <= 0 && bodyStart >= 0) break;
        }
        if (seenCase && !seenDefault) {
          findings.push({
            checkId: "missing-default-case",
            severity: "info",
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: null,
            message: "switch statement has cases but no default",
            extra: { file: f.path },
          });
        }
        continue;
      }
      // Rust: `match X {`... no `_ =>` arm
      const rustMatch = line.match(/^\s*match\s+.+\s*\{/);
      if (rustMatch) {
        let depth = 0;
        let seenArm = false;
        let seenWildcard = false;
        let bodyStart = -1;
        for (let j = i; j < Math.min(lines.length, i + 500); j += 1) {
          const l = getLine(lines, j);
          if (l.includes("{")) {
            if (bodyStart < 0) bodyStart = j;
            depth += (l.match(/{/g) ?? []).length;
          }
          if (l.includes("}")) depth -= (l.match(/}/g) ?? []).length;
          if (l.includes("=>")) seenArm = true;
          if (/^\s*_\s*=>/.test(l) || /\b_\s*=>/.test(l)) seenWildcard = true;
          if (depth <= 0 && bodyStart >= 0) break;
        }
        if (seenArm && !seenWildcard) {
          findings.push({
            checkId: "missing-default-case",
            severity: "info",
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: null,
            message: "match statement has arms but no wildcard `_ =>` default",
            extra: { file: f.path },
          });
        }
      }
    }
  }
  return findings;
}

/** Unused-local check: variables declared but never read in the same file. */
export function checkUnusedLocals(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  // Type-keyword set used to filter false positives where the decl regex
  // captures a C/C++/Java type keyword as the "variable name" (e.g.
  // `const char *str` parsed as `const` decl, name=`char`). If the captured
  // name is a type keyword, skip it.
  const TYPE_KEYWORDS = new Set([
    "int", "long", "short", "char", "float", "double", "void", "bool",
    "unsigned", "signed", "auto", "const", "static", "extern", "inline",
    "register", "volatile", "struct", "enum", "class", "union",
    "String", "var", "boolean", "byte", "Object",
  ]);
  for (const f of files) {
    const lines = linesOf(f.content);
    // Build a set of exported names from the parsed file's exports list.
    const exportedNames = new Set<string>();
    for (const ex of f.exports) exportedNames.add(ex.name);
    const declRe = /\b(let|const|var)\s+([A-Za-z_]\w*)\b/g;
    for (let i = 0; i < lines.length; i += 1) {
      const line = getLine(lines, i);
      // Skip lines with `export` — the declaration is exported, not a
      // local. This avoids the major FP class where `export const foo`
      // was flagged as unused (the check didn't see the `export`).
      if (/^\s*export\s+(let|const|var|declare|function|class|enum|interface|type|abstract)\b/.test(line)) continue;
      let m: RegExpExecArray | null;
      declRe.lastIndex = 0;
      while ((m = declRe.exec(line)) !== null) {
        const name = m[2];
        if (!name) continue;
        if (name.startsWith("_")) continue;
        if (TYPE_KEYWORDS.has(name)) continue; // skip type keywords
        if (exportedNames.has(name)) continue; // skip exported names
        let uses = 0;
        for (let j = 0; j < lines.length; j += 1) {
          if (j === i) {
            const before = line.slice(0, m.index);
            const after = line.slice(m.index + m[0].length);
            uses += (before.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
            uses += (after.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
            continue;
          }
          uses += (getLine(lines, j).match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
        }
        if (uses <= 0) {
          findings.push({
            checkId: "unused-local",
            severity: "info",
            filePath: f.path,
            line: i + 1,
            column: (m.index ?? 0) + 1,
            symbol: name,
            message: `Local variable '${name}' is declared but never used`,
            extra: { file: f.path },
          });
        }
      }
    }
  }
  return findings;
}
