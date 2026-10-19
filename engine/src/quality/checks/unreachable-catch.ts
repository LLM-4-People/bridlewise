/**
 * Unreachable-catch check (EXP446).
 *
 * Flags `catch`/`except` clauses that can never be reached because:
 * 1. The corresponding `try` body has no statement that can throw (no
 * `throw`, `await`, function call, method call, `new`, index access).
 * 2. A more general earlier catch already absorbs every exception
 * (Java/Python multi-catch order issue).
 *
 * The unreachable catch is dead code: it adds maintenance burden without
 * ever executing. Detection uses line-level heuristics that are robust
 * across languages; the check is biased toward precision (avoid FPs) by
 * treating ANY call/access as potentially throwing.
 *
 * False-positive avoidance:
 * - Skip try bodies with `await`, function calls, method calls, `new`,
 * property access on `this`, dynamic imports, `yield`, generators.
 * - Skip catch blocks that re-throw (`throw;`, `throw e;`, `raise`).
 * - Skip `finally`-only blocks (no catch clause to flag).
 * - One finding per unreachable catch clause (line = catch line).
 *
 * All thresholds (supertype families) are read from
 * `config.unreachableCatchSupertypes` when present — no static constants.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

const DEFAULT_SUPERTYPES: Readonly<Record<string, readonly string[]>> = {
  // Java/JVM (both qualified and unqualified forms)
  "Throwable": ["Exception", "Error", "RuntimeException", "IOException", "SQLException"],
  "java.lang.Throwable": ["java.lang.Exception", "java.lang.Error"],
  "Exception": [
    // Python subtypes
    "ValueError", "TypeError", "KeyError", "IndexError", "OSError",
    "IOError", "AttributeError", "RuntimeError",
    // Java subtypes (unqualified)
    "IOException", "SQLException", "ClassNotFoundException", "RuntimeException",
  ],
  "java.lang.Exception": ["java.lang.RuntimeException", "java.lang.IOException", "java.sql.SQLException"],
  "java.lang.RuntimeException": [
    "java.lang.NullPointerException",
    "java.lang.IllegalArgumentException",
    "java.lang.IllegalStateException",
  ],
  "RuntimeException": ["NullPointerException", "IllegalArgumentException", "IllegalStateException", "ArithmeticException"],
  // Python
  "BaseException": ["Exception", "SystemExit", "KeyboardInterrupt", "GeneratorExit"],
  "OSError": ["IOError", "FileNotFoundError", "PermissionError", "ConnectionError"],
  // JS/TS (rare, but user-thrown `class X extends Error`)
  "Error": [
    "TypeError", "RangeError", "SyntaxError", "ReferenceError",
    "URIError", "EvalError",
  ],
};

const THROWING_TOKENS: readonly string[] = [
  "throw", "raise", "await", "yield", "import(",
];

const RUST_PANIC_MACROS: readonly string[] = [
  "println!", "eprintln!", "panic!", "unreachable!", "todo!",
  "unimplemented!", "assert!", "assert_eq!", "assert_ne!",
  "debug_assert!", "unwrap()", "expect(", "vec!", "format!",
];

interface CatchClause {
  readonly lineIdx: number;
  readonly type: string | null;
  readonly catchEnd: number;
}

interface TryBlock {
  readonly tryStart: number;
  readonly tryEnd: number;
  readonly catches: readonly CatchClause[];
}

function linesOf(content: string): string[] {
  return content.split("\n");
}

function isRustFile(path: string): boolean {
  return path.endsWith(".rs");
}

/** Returns the captured type for a catch/except line, or null if not a catch. */
function matchCatchLine(line: string): { type: string | null } | null {
  const jsMatch = line.match(/\bcatch\s*(?:\(\s*(\w+)(?:\s*:\s*([\w.]+))?\s*\))?\s*\{/);
  if (jsMatch) {
    return { type: (jsMatch[2] ?? jsMatch[1]) ?? null };
  }
  const pyMatch = line.match(/^\s*except(?:\s+([\w.]+))?(?:\s+as\s+\w+)?\s*:\s*$/);
  if (pyMatch) {
    return { type: pyMatch[1] ?? null };
  }
  const javaMatch = line.match(/\bcatch\s*\(\s*([\w.]+)\s+\w+\s*\)\s*\{/);
  if (javaMatch) {
    return { type: javaMatch[1] ?? null };
  }
  return null;
}

/** Find the matching closing brace for an opening brace at `startIdx`/`openCol`.
 * Returns the { line, col } of the closing brace. */
function findCloseBraceDetailed(lines: readonly string[], startIdx: number, openCol: number): { line: number; col: number } {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i += 1) {
    const slice = i === startIdx ? (lines[i] ?? "").slice(openCol) : (lines[i] ?? "");
    for (let j = 0; j < slice.length; j += 1) {
      const ch = slice[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const realCol = i === startIdx ? openCol + j : j;
          return { line: i, col: realCol };
        }
      }
    }
  }
  return { line: lines.length - 1, col: 0 };
}

/** Detect a re-throw / re-raise in a block. */
function blockRethrows(lines: readonly string[], startIdx: number, endIdx: number): boolean {
  for (let i = startIdx; i <= endIdx && i < lines.length; i += 1) {
    const t = (lines[i] ?? "").trim();
    if (/^(throw|raise)\b/.test(t)) return true;
    if (/^\s*raise\s+\w+/.test(t)) return true;
  }
  return false;
}

/** Detect whether the try body contains a token that can throw. */
function tryBodyCanThrow(
  lines: readonly string[],
  startIdx: number,
  endIdx: number,
  isRust: boolean,
): boolean {
  for (let i = startIdx; i <= endIdx && i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw
      .replace(/\/\/.*$/, "")
      .replace(/"([^"\\]|\\.)*"/g, '""')
      .replace(/'([^'\\]|\\.)*'/g, '""');
    for (const tok of THROWING_TOKENS) {
      if (stripped.includes(tok)) return true;
    }
    // Method/function call: `name(` or `.name(`.
    if (/\.\w+\s*\(/.test(stripped)) return true;
    if (/\w+\s*\(/.test(stripped)) return true;
    // Index access (IndexError/panic): `name[`.
    if (/\w+\s*\[/.test(stripped)) return true;
    // Optional chaining: `name?.`.
    if (/\?\.\w+/.test(stripped)) return true;
    // `new Class(` — JS/TS/Java constructor.
    if (/\bnew\s+\w+\s*\(/.test(stripped)) return true;
    if (isRust) {
      for (const m of RUST_PANIC_MACROS) {
        if (stripped.includes(m)) return true;
      }
      // `name!` macro call.
      if (/\w+!\s*\(/.test(stripped)) return true;
    }
  }
  return false;
}

/** Subsumed-catch detection: a sequence of catch clauses where an earlier
 * one is a supertype of a later one. Returns the indices of the subsumed
 * (unreachable) catches. */
function findSubsumedCatches(
  catches: readonly { lineIdx: number; type: string | null }[],
  supertypes: Readonly<Record<string, readonly string[]>>,
): number[] {
  const subsumed: number[] = [];
  for (let i = 0; i < catches.length; i += 1) {
    const a = catches[i];
    if (!a || !a.type) continue;
    const aType: string = a.type;
    for (let j = i + 1; j < catches.length; j += 1) {
      const b = catches[j];
      if (!b || !b.type) continue;
      const bType: string = b.type;
      const subs: readonly string[] | undefined = supertypes[aType];
      if (subs && subs.includes(bType)) {
        if (!subsumed.includes(j)) subsumed.push(j);
      }
      const subs2: readonly string[] | undefined = supertypes[bType];
      if (subs2 && subs2.includes(aType)) {
        if (!subsumed.includes(i)) subsumed.push(i);
      }
    }
  }
  return subsumed;
}

/** Scan a file's lines for try-block ranges and their catch clauses.
 * Handles `} catch (e) {` on the same line as the try's closing brace. */
function scanTryBlocks(lines: readonly string[]): TryBlock[] {
  const out: TryBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = (lines[i] ?? "").trim();
    const isTry = /^try\b\s*[{:]?/.test(t) && /(^|\s|;|\}|\{)try\b|^try\b/.test(t);
    if (!isTry) {
      i += 1;
      continue;
    }
    const openBrace = t.indexOf("{");
    let tryEndLine: number;
    let tryEndCol: number;
    if (openBrace >= 0) {
      const close = findCloseBraceDetailed(lines, i, openBrace);
      tryEndLine = close.line;
      tryEndCol = close.col;
    } else {
      // Python `try:` — find next `except`/`finally`/`else` at the same
      // indent as the `try` keyword (use the ORIGINAL line's indent, not
      // the trimmed version — otherwise indent is always 0).
      const origLine = lines[i] ?? "";
      const indent = origLine.search(/\S/);
      let j = i + 1;
      while (j < lines.length) {
        const lt = lines[j] ?? "";
        const lIndent = lt.search(/\S/);
        if (lIndent >= 0 && lIndent <= indent && /^\s*(except|finally|else)\b/.test(lt)) {
          break;
        }
        if (lIndent >= 0 && lIndent <= indent) break;
        j += 1;
      }
      tryEndLine = j - 1;
      tryEndCol = 0;
    }
    // Walk forward to find catch/except clauses. For JS/TS/Java (openBrace
    // >= 0), the catch may be on the SAME line as the try's closing `}`
    // (`} catch (e) {`), so we start at tryEndLine with searchFromCol after
    // the `}`. For Python (no openBrace), tryEndLine is the last body line
    // and the `except` is on tryEndLine + 1, so we start there.
    const catches: CatchClause[] = [];
    let j: number;
    let searchFromCol: number;
    if (openBrace >= 0) {
      j = tryEndLine;
      searchFromCol = tryEndCol + 1;
    } else {
      j = tryEndLine + 1;
      searchFromCol = 0;
    }
    while (j < lines.length) {
      // Get the remainder of the current line (from searchFromCol) OR the
      // full line for subsequent lines.
      const lineSlice = j === tryEndLine ? (lines[j] ?? "").slice(searchFromCol) : (lines[j] ?? "");
      // Check if this line slice contains a catch/except clause.
      const cm = matchCatchLine(lineSlice);
      if (cm) {
        const ob = lineSlice.indexOf("{");
        let catchEndLine: number;
        let catchEndCol: number;
        if (ob >= 0) {
          const close = findCloseBraceDetailed(lines, j, searchFromCol + ob);
          catchEndLine = close.line;
          catchEndCol = close.col;
        } else {
          // Python `except...:` — find next dedent.
          const indent = lineSlice.search(/\S/);
          let k = j + 1;
          while (k < lines.length) {
            const lt2 = lines[k] ?? "";
            const lIndent = lt2.search(/\S/);
            if (lIndent >= 0 && lIndent <= indent) break;
            k += 1;
          }
          catchEndLine = k - 1;
          catchEndCol = 0;
        }
        catches.push({ lineIdx: j, type: cm.type, catchEnd: catchEndLine });
        // Continue searching after the catch's closing brace. The closing
        // `}` of one catch may be on the same line as the next `catch`
        // keyword (`} catch (IOException e) {`), so always continue from
        // (catchEndLine, catchEndCol + 1).
        j = catchEndLine;
        searchFromCol = catchEndCol + 1;
        continue;
      }
      // Check for `finally` / `else` (ends the catch chain).
      if (/^\s*finally\b/.test(lineSlice) || /^\s*else\s*:\s*$/.test(lineSlice)) break;
      // If the line is non-empty and not a catch/except, check if there's
      // a catch later on the same line (after `} catch`).
      const catchOnLine = lineSlice.match(/\bcatch\b|\bexcept\b/);
      if (!catchOnLine && lineSlice.trim().length > 0 && !lineSlice.trim().startsWith("}")) {
        break;
      }
      j += 1;
      searchFromCol = 0;
    }
    out.push({ tryStart: i, tryEnd: tryEndLine, catches });
    i = Math.max(j, i + 1);
  }
  return out;
}

export function checkUnreachableCatch(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const supertypes = (config.unreachableCatchSupertypes ?? DEFAULT_SUPERTYPES) as
    Readonly<Record<string, readonly string[]>>;
  for (const f of files) {
    if (f.path.endsWith(".md") || f.path.endsWith(".json")) continue;
    const lines = linesOf(f.content);
    const isRust = isRustFile(f.path);
    const tryBlocks = scanTryBlocks(lines);
    for (const tb of tryBlocks) {
      // Strategy 1: try-without-throw (single catch, try body cannot throw).
      // The try body is BETWEEN the opening `{` (on tryStart) and the
      // closing `}` (on tryEnd). We scan tryStart+1 to tryEnd-1 (exclusive
      // of the `try {` line and the `} catch` line) so that `catch (` on
      // the closing-brace line isn't mistaken for a function call.
      if (tb.catches.length === 1) {
        const c = tb.catches[0];
        if (!c) continue;
        const rethrows = blockRethrows(lines, c.lineIdx, c.catchEnd);
        const bodyStart = tb.tryStart + 1;
        const bodyEnd = Math.max(bodyStart - 1, tb.tryEnd - 1);
        if (!rethrows && !tryBodyCanThrow(lines, bodyStart, bodyEnd, isRust)) {
          findings.push({
            checkId: "unreachable-catch",
            severity: "warning",
            filePath: f.path,
            line: c.lineIdx + 1,
            column: 0,
            symbol: c.type,
            message: "Unreachable catch: try body has no statement that can throw",
            extra: {
              file: f.path,
              tryLine: tb.tryStart + 1,
              type: c.type ?? "",
            },
          });
        }
      }
      // Strategy 2: subsumed catch (multi-catch order issue).
      if (tb.catches.length > 1) {
        const subsumed = findSubsumedCatches(
          tb.catches.map(c => ({ lineIdx: c.lineIdx, type: c.type })),
          supertypes,
        );
        for (const idx of subsumed) {
          const c = tb.catches[idx];
          if (!c) continue;
          findings.push({
            checkId: "unreachable-catch",
            severity: "warning",
            filePath: f.path,
            line: c.lineIdx + 1,
            column: 0,
            symbol: c.type,
            message: "Unreachable catch: subsumed by an earlier catch clause's supertype",
            extra: {
              file: f.path,
              tryLine: tb.tryStart + 1,
              type: c.type ?? "",
            },
          });
        }
      }
    }
  }
  return findings;
}
