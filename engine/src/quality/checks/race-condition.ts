/**
 * Race-condition indicator check (EXP386).
 *
 * Flags common concurrency patterns that are likely (but not certainly)
 * race conditions. The check is intentionally conservative — it identifies
 * patterns that *often* introduce races, not patterns that *definitely* do.
 * A static race detector (ThreadSanitizer, Helgrind, Loom) is the
 * authoritative tool; this check is a high-recall / low-precision lint.
 *
 * Patterns (language-agnostic where possible):
 *
 * 1. **Check-then-act on a shared mutable** — `if (x == null) { x =... }`
 * on a field/instance var (not a local). Most common race shape.
 * 2. **Lazy init without sync** — `if (_cache == null) { _cache =... }`
 * on a field named `_cache`, `cache`, `_instance`, `instance`, etc.
 * 3. **Non-atomic read-modify-write** — `x = x + 1`, `x += 1`, `x++`, `++x`,
 * `count = count + 1` on a non-local. The read + write are not atomic.
 * 4. **`setTimeout`/`setInterval` mutation** — a callback that mutates a
 * captured outer variable. Async races are common in JS.
 * 5. **`go func {... }` mutating an outer var** — Go goroutine races.
 * 6. **`thread::spawn(...)` mutating an outer `&mut`** — Rust (the
 * compiler usually catches this, but a `RefCell`/`unsafe` can bypass).
 * 7. **`Thread::new(...)` / `thread.start` mutating a shared field** — Java.
 *
 * False-positive avoidance:
 * - Skip when the variable is declared as a local on the same scope
 * (locals can't race across threads because they're stack-allocated).
 * We use a heuristic: if the line contains `let`/`var`/`const`/`int`
 * declaring the name, it's a local.
 * - Skip when inside a `synchronized`/`Mutex::lock`/`RLock`/`@synchronized`
 * block (the mutation is protected).
 * - Skip test files (test races are intentional fixtures).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { escapeRegex } from "./shared-helpers.ts";

const SHARED_FIELD_RE = /\b([A-Za-z_]\w*)\.(cache|instance|_cache|_instance|state|_state|count|_count|counter|_counter|map|_map|list|_list|queue|_queue|buffer|_buffer)\b/;
const SHARED_PTR_FIELD_RE = /\b([A-Za-z_]\w*)\s*->\s*(cache|instance|_cache|_instance|state|_state|count|_count|counter|_counter|map|_map|list|_list|queue|_queue|buffer|_buffer)\b/;
const CHECK_THEN_ACT_RE = /\bif\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|->[A-Za-z_]\w*)?)\s*(==|!=|<|>|<=|>=)\s*(null|None|nil|0|nullptr)\s*\)\s*\{?\s*\1\s*=/;
/** RMW on a field access: `obj.x++`, `self.x += 1`, `obj->x = obj->x + 1`.
 * We do NOT flag bare-name `x++` because `x` is usually a local (the
 * check is high-recall but bare-name RMW produces ~50% FP on C/Rust loop
 * counters and Java local ints). Only field-access RMW is flagged. */
const FIELD_RMW_RE = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|->[A-Za-z_]\w*))\s*(\+\+|--|\+=|-=|\*=|\/=|%=)/;
const LOCAL_DECL_RE = /\b(let|const|var|int|long|float|double|auto|mut)\s+([A-Za-z_]\w*)\b/;
const SYNC_BLOCK_RE = /\b(synchronized|Mutex::lock|\.lock\(\)|RLock|@synchronized|with\s+.*\.lock|AtomicInteger|AtomicReference|AtomicBoolean|Arc::new|Mutex::new|RefCell::new)/;
/** For-loop increment header — `for (...;...; x++)`. The increment clause
 * is NEVER a race indicator (it's the loop counter, single-threaded). */
const FOR_LOOP_INCREMENT_RE = /\bfor\s*\([^;]*;[^;]*;\s*[A-Za-z_]\w*\s*(\+\+|--|\+=|-=|\*=|\/=|%=)/;

const ASYNC_MUTATION_RES: RegExp[] = [
  /setTimeout\s*\([^,]*,\s*\d+\s*\)\s*$/,
  /setInterval\s*\([^,]*,\s*\d+\s*\)\s*$/,
  /go\s+func\s*\([^)]*\)\s*\{[^}]*\b\w+\s*=[^}]*\}/,
  /thread::spawn\s*\([^)]*move\s*\|[^|]*\|[^}]*\b\w+\s*=[^}]*\}/,
  /Thread::new\s*\([^)]*\)\.start\(\)/,
  /spawn\s*\(\s*\|\|\s*\{[^}]*\b\w+\s*=[^}]*\}/,
];

function isInSyncBlock(lines: string[], lineIdx: number, lookback: number): boolean {
  for (let k = lineIdx - 1; k >= Math.max(0, lineIdx - lookback); k -= 1) {
    const l = lines[k] ?? "";
    if (SYNC_BLOCK_RE.test(l)) return true;
    if (/\bfunc\b|\bdef\b|\bfn\b|\bfunction\b|\bmethod\b/.test(l) && k !== lineIdx) {
      // Reached the start of the enclosing function — no sync block above.
      // (This is a conservative heuristic; doesn't handle nested functions.)
      break;
    }
  }
  return false;
}

/** Replace string literals with empty space so `=` inside strings doesn't
 * trigger mutation detection. */
function strippedStrings(line: string): string {
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inStr) {
      if (c === "\\") { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    out += c;
  }
  return out;
}

export function checkRaceConditions(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const lookback = config.thresholds.raceConditionSyncBlockLookback;
  const findings: Finding[] = [];
  for (const f of files) {
    if (/test|spec|fixture|conftest/i.test(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!line.trim()) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      // Skip lines that are entirely a block comment (single-line `/*... */`).
      if (/^\s*\/\*.*\*\/\s*$/.test(line)) continue;
      if (isInSyncBlock(lines, i, lookback)) continue;

      // Pattern 2: check-then-act on shared field. Only flag field accesses
      // (`obj.field` or `obj->field`) — bare-name `if (x == null) x =...`
      // is usually a local, and locals can't race across threads.
      let m = line.match(CHECK_THEN_ACT_RE);
      if (m && m[1] && (m[1].includes(".") || m[1].includes("->"))) {
        const name = m[1];
        const bareName = name.split(/[.>]/).pop() ?? name;
        const localDeclRe = new RegExp(`\\b(let|const|var|int|long|float|double|auto|mut)\\s+${bareName}\\b`);
        if (!localDeclRe.test(line)) {
          findings.push({
            checkId: "race-condition",
            severity: "warning",
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: name,
            message: `Check-then-act on '${name}' without synchronization (likely race)`,
            extra: { pattern: "check-then-act", file: f.path },
          });
          continue;
        }
      }
      // Skip lines that look like a for-loop header — the increment
      // clause (`for (...;...; x++)`) is never a race indicator.
      if (FOR_LOOP_INCREMENT_RE.test(line)) continue;
      // Pattern 1: shared mutable field access (`.field` or `->field`).
      // Require a real assignment to the FIELD itself, not just any `=` on
      // the line. The `=` must be an assignment operator (=, +=, -=, etc.)
      // AND the LHS must be the field we matched (not a different variable
      // that READS the field, e.g. `dense_total_count += s->count;` — here
      // `s->count` is READ, the mutation is on `dense_total_count`).
      m = line.match(SHARED_FIELD_RE) || line.match(SHARED_PTR_FIELD_RE);
      if (m) {
        const fieldName = m[2]!;
        const objName = m[1]!;
        const access = `${objName}.${fieldName}`;
        const accessPtr = `${objName}->${fieldName}`;
        // Check if the field itself is being WRITTEN (the line has
        // `<field-access> =...` or `<field-access> +=...` etc.).
        const writeRe = new RegExp(
          `${escapeRegex(access)}\\s*(\\+\\+|--|\\+=|-=|\\*=|/=|%=|=[^=])|` +
          `${escapeRegex(accessPtr)}\\s*(\\+\\+|--|\\+=|-=|\\*=|/=|%=|=[^=])`,
        );
        if (writeRe.test(strippedStrings(line)) && !LOCAL_DECL_RE.test(line)) {
          findings.push({
            checkId: "race-condition",
            severity: "info",
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: `${objName}.${fieldName}`,
            message: `Mutation of shared field '${objName}.${fieldName}' without visible synchronization`,
            extra: { pattern: "shared-field-mutation", file: f.path },
          });
          continue;
        }
      }
      // Pattern 3: non-atomic read-modify-write on a FIELD (not a bare name).
      m = line.match(FIELD_RMW_RE);
      if (m && m[1] && !LOCAL_DECL_RE.test(line)) {
        const name = m[1];
        findings.push({
          checkId: "race-condition",
          severity: "info",
          filePath: f.path,
          line: i + 1,
          column: 0,
          symbol: name,
          message: `Non-atomic read-modify-write on '${name}' (${m[2]}) without visible synchronization`,
          extra: { pattern: "rmw", operator: m[2] ?? "", file: f.path },
        });
        continue;
      }
      // Patterns 4-7: async / goroutine / thread mutation.
      for (const re of ASYNC_MUTATION_RES) {
        if (re.test(line)) {
          findings.push({
            checkId: "race-condition",
            severity: "info",
            filePath: f.path,
            line: i + 1,
            column: 0,
            symbol: null,
            message: `Async/goroutine/thread callback mutates captured state (potential race)`,
            extra: { pattern: "async-mutation", file: f.path },
          });
          break;
        }
      }
    }
  }
  return findings;
}
