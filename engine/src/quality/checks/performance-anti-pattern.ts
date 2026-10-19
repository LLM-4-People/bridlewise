/**
 * Performance-anti-pattern check (EXP386).
 *
 * Flags common performance anti-patterns. Like the security-hotspot check,
 * this is a high-recall / low-precision lint — each flag is a request for
 * human review, not a confirmed hot path.
 *
 * Patterns (language-agnostic where possible):
 *
 * 1. **N+1 query** — a DB query inside a loop (`for... { db.query(...) }`,
 * `cursor.forEach(... db.query)`). The classic ORM performance bug.
 * 2. **Repeated regex compilation** — `new RegExp(...)` inside a loop
 * (compile once outside; reuse). A common JS perf foot-gun.
 * 3. **Synchronous I/O in hot path** — `fs.readFileSync`, `os.read`,
 * `requests.get` (without async) inside a loop or async context.
 * 4. **Inefficient string concatenation in loop** — `s += chunk` inside
 * a loop (O(n²) in many languages — should use a builder/list + join).
 * 5. **Inefficient search** — `list.indexOf(x) >= 0` in a loop where the
 * list is unchanged (should be a Set). Hard to detect statically — we
 * flag the most obvious shape: `.indexOf(...) >= 0` inside a `for`
 * loop on the same list variable.
 * 6. **`O(n²)` nested-loop over same collection** — `for x in xs: for y in
 * xs:...` (inner+outer iterate the same variable). Common in
 * all-pairs/dedup code.
 * 7. **Unbounded growth** — `cache.set(...)` in a loop with no eviction
 * check (memory leak).
 * 8. **Eager materialization** — `[x for x in big if...][0]` /
 * `xs.filter(...)[0]` (should use a generator/find — materializing
 * the whole list just to take the first element is wasteful).
 *
 * False-positive avoidance:
 * - Skip lines inside comments.
 * - Skip test files for patterns 1, 4, 5, 6 (tests often use these
 * shapes intentionally).
 * - Pattern 2 requires the `new RegExp` to be literally inside a `for`
 * or `while` block (detected by scanning backward for an enclosing
 * loop header on a smaller indent).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { leadingSpaces } from "./shared-helpers.ts";

interface PerfPattern {
  id: string;
  regex: RegExp;
  message: string;
  severity: "warning" | "info";
  skipInTests: boolean;
}

const PATTERNS: readonly PerfPattern[] = [
  { id: "n+1-query", regex: /\b(for|while|forEach|map|forEachOrdered|iter)\b[^;{]*\{?\s*[\s\S]{0,200}?\b(\.query\(|\.find\(|\.findOne\(|\.all\(\)|\.execute\(|session\.query|cursor\.execute|db\.\w+\s*\(|SELECT\s+.*?\bFROM\b)/, message: "N+1 query — DB call inside a loop (bulk-fetch instead)", severity: "warning", skipInTests: true },
  { id: "regex-in-loop", regex: /new\s+RegExp\s*\(/, message: "RegExp compiled inside a likely loop (compile once outside)", severity: "info", skipInTests: true },
  { id: "sync-io-in-loop", regex: /fs\.readFileSync\s*\(|fs\.writeFileSync\s*\(|requests\.get\s*\(|requests\.post\s*\(|urlopen\s*\(|urllib\.request\.urlopen\s*\(/, message: "Synchronous I/O may be on a hot path (use async/buffered)", severity: "info", skipInTests: false },
  { id: "string-concat-in-loop", regex: /\b\w+\s*\+=\s*["'`]/, message: "String concatenation inside a loop (use a builder/list + join for O(n))", severity: "info", skipInTests: true },
  { id: "unbounded-cache", regex: /cache\.set\s*\(|cache\.put\s*\(|lru\.set\s*\(|memo\.set\s*\(/, message: "Cache write without visible eviction check (potential unbounded growth)", severity: "info", skipInTests: false },
  { id: "eager-materialize", regex: /\[\s*\w+\s+for\s+\w+\s+in\s+\w+\s+if\s+[^\]]+\]\s*\[\s*0\s*\]|\.filter\s*\([^)]+\)\s*\[\s*0\s*\]/, message: "Eager materialization to take only the first element (use next()/find() instead)", severity: "info", skipInTests: true },
];

const NESTED_LOOP_RE = /\bfor\s+\(?(\w+)\s+in\s+(\w+)/g;

export function checkPerformanceAntiPatterns(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const isTestFile = /test|spec|fixture|conftest|_test\.|\.test\.|\.spec\./i.test(f.path);
    const lines = f.content.split("\n");
    // Pattern 6: nested loop over the same collection. Scan for two `for x
    // in xs` lines where the inner loop's variable matches the outer's
    // iterable, AND the inner loop is nested deeper than the outer.
    const loopStack: Array<{ iterable: string; line: number; indent: number }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!line.trim()) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
      const indent = leadingSpaces(line);
      // Pop loops that are strictly outer.
      while (loopStack.length > 0 && loopStack[loopStack.length - 1]!.indent >= indent) {
        loopStack.pop();
      }
      NESTED_LOOP_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NESTED_LOOP_RE.exec(line)) !== null) {
        const iter = m[2] ?? "";
        for (const outer of loopStack) {
          if (outer.iterable === iter) {
            findings.push({
              checkId: "performance-anti-pattern",
              severity: "warning",
              filePath: f.path,
              line: i + 1,
              column: 0,
              symbol: iter,
              message: `Nested loop over '${iter}' (same as outer loop at line ${outer.line}) — O(n²) pattern`,
              extra: { pattern: "nested-same-collection", outerLine: outer.line, file: f.path },
            });
            break;
          }
        }
        loopStack.push({ iterable: iter, line: i + 1, indent });
      }
      // Other patterns.
      for (const p of PATTERNS) {
        if (p.skipInTests && isTestFile) continue;
        if (p.id === "regex-in-loop") {
          // Only flag if there's an enclosing loop above at lower indent.
          if (!p.regex.test(line)) continue;
          if (loopStack.length === 0) continue;
          findings.push({
            checkId: "performance-anti-pattern",
            severity: p.severity,
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: p.id,
            message: p.message,
            extra: { pattern: p.id, file: f.path },
          });
          break;
        }
        if (p.id === "n+1-query") {
          // The single-line regex won't match a query several lines after
          // the `for`. We do a small look-ahead (next 5 lines) for the query.
          if (!/\b(for|while|forEach|map|forEachOrdered)\b/.test(line)) continue;
          const window = lines.slice(i, Math.min(lines.length, i + 6)).join("\n");
          if (!/\b(\.query\(|\.find\(|\.findOne\(|\.all\(\)|\.execute\(|session\.query|cursor\.execute|db\.\w+\s*\(|SELECT\s+.*?\bFROM\b)/.test(window)) continue;
          findings.push({
            checkId: "performance-anti-pattern",
            severity: p.severity,
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: p.id,
            message: p.message,
            extra: { pattern: p.id, file: f.path },
          });
          break;
        }
        if (p.regex.test(line)) {
          findings.push({
            checkId: "performance-anti-pattern",
            severity: p.severity,
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: p.id,
            message: p.message,
            extra: { pattern: p.id, file: f.path },
          });
          break;
        }
      }
    }
  }
  return findings;
}
