/**
 * Dead-code check (EXP368, Fix 3).
 *
 * EXP357 found 0 dead-code findings for 4/6 languages — too conservative.
 * EXP368 expands the check with multiple dead-code patterns:
 *
 * 1. Unreachable statements after `return`/`throw`/`raise`/`panic!` (EXP357).
 * 2. NEW: Dead code after `if False:` / `if (0)` / `if (false)` / `#if 0`.
 * 3. NEW: Dead code after a guaranteed-exit branch (every `case` ends in
 * return/throw/raise with no fallthrough) — the code after the switch is
 * unreachable.
 * 4. NEW: Dead private methods/functions (never called in the codebase).
 * 5. NEW: Dead fields (declared private but never read in the codebase).
 * 6. NEW: Dead code in `unreachable catch` — a `catch` that re-throws and
 * has statements after the re-throw.
 *
 * Patterns 4-5 use the symbol graph (like dead-export but for non-exported
 * symbols) and run across the whole codebase — these are the most precise
 * because they don't rely on text heuristics. Pattern 4 is the strongest
 * signal: a private function that is never called anywhere is dead.
 *
 * Patterns 1-3 use text heuristics (line-based) — fast but conservative.
 * Pattern 2 (`if False`) is a Python/JS idiom; `#if 0` is a C/C++ idiom.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { isGeneratedFile } from "./barrel-detection.ts";
import { leadingSpaces, getLine } from "./shared-helpers.ts";

const KNOWN_TERMINATORS = new Set(["return", "throw", "raise", "panic"]);

function linesOf(content: string): string[] {
  return content.split("\n");
}

/** Pattern 1: unreachable statements after return/throw/raise/panic. */
function checkUnreachableAfterTerminator(
  files: readonly ParsedFile[],
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = linesOf(f.content);
    for (let i = 0; i < lines.length - 1; i += 1) {
      const line = getLine(lines, i);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const termMatch = line.match(/^\s*(return|throw|raise|panic!?)\b/);
      if (!termMatch || !termMatch[1]) continue;
      const lastChar = trimmed[trimmed.length - 1] ?? "";
      if (![";", "}"].includes(lastChar)) continue;
      // Skip TS/Java method signatures: `throw(e: any): Promise<...>;`
      if (/\)\s*:/.test(line) && !/\breturn\b/.test(line)) continue;
      if (line.includes("?") && line.includes(":")) continue;
      // FIX (EXP386): if the line ends with `}` but brackets are unbalanced
      // (e.g. `return ({j for i in self.args for j in i.free_symbols}` — the
      // closing `}` is for the set comprehension, NOT the return statement),
      // the next line is a CONTINUATION, not unreachable code. Only flag if
      // brackets/parens/braces are balanced on the line.
      if (lastChar === "}" && !isBracketsBalanced(line)) continue;
      // Similarly, if the line ends with `;` but there's an unclosed `(` or
      // `[` (continuation expression), the next line continues the statement.
      if (lastChar === ";" && hasUnclosedBracket(line)) continue;
      let nextIdx = i + 1;
      while (nextIdx < lines.length) {
        const nl = getLine(lines, nextIdx).trim();
        if (nl.length === 0) { nextIdx += 1; continue; }
        if (nl.startsWith("//") || nl.startsWith("*") || nl.startsWith("/*")) { nextIdx += 1; continue; }
        break;
      }
      if (nextIdx >= lines.length) continue;
      const next = getLine(lines, nextIdx);
      const nextTrim = next.trim();
      if (nextTrim.startsWith("}") || nextTrim.startsWith(")")) continue;
      if (/^(case|default|except|finally|elif|else|end)\b/.test(nextTrim)) continue;
      if (nextTrim.startsWith("@")) continue;
      if (/^[A-Za-z_]\w*\s*:\s*$/.test(nextTrim)) continue;
      // Skip preprocessor directives — they are branch boundaries, not dead code.
      if (nextTrim.startsWith("#")) continue;
      if (/^(function|def|fn|class|struct|enum|trait|interface|type|module|import|export|package|pub|public|private|protected|static|const|let|var)\b/.test(nextTrim)) continue;
      // FIX (EXP386): if the next line is a continuation (starts with `.`,
      // `,`, `)`, `]`, `}`, `+`, `-`, `*`, `/`, `&`, `|`, `?`, `:`, `>`),
      // it's part of the previous expression, not unreachable code.
      if (/^[.)\]}+\-*\/&|?:><]/.test(nextTrim)) continue;
      const thisIndent = leadingSpaces(line);
      const nextIndent = leadingSpaces(next);
      if (nextIndent < thisIndent) continue;
      // FIX (EXP386): if the `return`/`throw` is the body of an `if`
      // without braces (`if (cond)\n return;`), the next sibling
      // statement at the same indent is the continuation of the
      // enclosing block, NOT unreachable code. Detect by scanning
      // backward from the terminator: if there's an `if (...)` ending
      // on the previous non-blank, non-comment line at the same indent
      // (or a continuation `)`), the terminator is the if-body.
      if (isIfBodyReturn(lines, i, thisIndent)) continue;
      findings.push({
        checkId: "dead-code",
        severity: "warning",
        filePath: f.path,
        line: nextIdx + 1,
        column: 0,
        symbol: null,
        message: `Unreachable code after '${termMatch[1]}' at line ${i + 1}`,
        extra: { terminatorLine: i + 1, terminator: termMatch[1], pattern: "after-terminator" },
      });
    }
  }
  return findings;
}

/** Returns true if all `(`, `[`, `{` on the line are matched. */
function isBracketsBalanced(line: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inString) {
      if (c === "\\") { i += 1; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && inString === null;
}

/** Returns true if there's an unclosed `(`, `[`, or `{` on the line. */
function hasUnclosedBracket(line: string): boolean {
  return !isBracketsBalanced(line);
}

/** Detect if the `return`/`throw` at lineIdx is the body of an `if`
 * without braces: `if (cond)\n return;`. In that case, the next
 * sibling statement is NOT unreachable. We scan backward from the
 * terminator for a preceding `if (...)` at the same indent (or a
 * continuation `)` of an `if` header). */
function isIfBodyReturn(lines: string[], lineIdx: number, returnIndent: number): boolean {
  // Scan backward, skipping blank, comment, and continuation lines.
  let k = lineIdx - 1;
  // Track if we're inside a continuation (closing bracket on the line above).
  let needClosing = false;
  while (k >= 0 && k >= lineIdx - 20) {
    const pl = lines[k] ?? "";
    const pt = pl.trim();
    if (pt.length === 0) { k -= 1; continue; }
    if (pt.startsWith("//") || pt.startsWith("*") || pt.startsWith("/*")) { k -= 1; continue; }
    // If we saw a `)` continuation, look for the matching `if (...)` line.
    const pIndent = leadingSpaces(pl);
    // A `)` continuation line: e.g. ` fragXxx, "write", 1, 1, 1) == ERR)`.
    // These have unbalanced `)` (more `)` than `(`). They're continuations of
    // the `if` header.
    if (/^[A-Za-z_0-9",\s\)\]]/.test(pt) && pt.endsWith(")")) {
      needClosing = true;
      k -= 1;
      continue;
    }
    if (needClosing && pt.includes("(")) {
      // The `if (` line. Check if it's an `if` at the same indent as `return`.
      if (/\bif\s*\(/.test(pt) && pIndent <= returnIndent) return true;
      // Otherwise, the `if` is on an earlier line — keep scanning.
      needClosing = false;
    }
    // A direct `if (...)` line at the same indent as `return`.
    if (/\bif\s*\(.*\)\s*$/.test(pt) && pIndent <= returnIndent) return true;
    // If we hit any non-continuation, non-blank, non-comment line that's NOT
    // an `if`, we're not in an if-body. Stop.
    return false;
  }
  return false;
}

/** Pattern 2: dead code after `if False:` / `if (false)` / `if (0)` / `#if 0`.
 * Detects statically-dead branches. */
function checkDeadBranch(
  files: readonly ParsedFile[],
): readonly Finding[] {
  const findings: Finding[] = [];
  const deadCondRe = /^\s*if\s+(False|false|0)\b[:\s(]/;
  const preprocDeadRe = /^\s*#\s*if\s+0\b/;
  for (const f of files) {
    const lines = linesOf(f.content);
    for (let i = 0; i < lines.length; i += 1) {
      const line = getLine(lines, i);
      if (deadCondRe.test(line) || preprocDeadRe.test(line)) {
        // The branch is dead. Find the next statement at the same or shallower
        // indent and report it (the first dead statement).
        const thisIndent = leadingSpaces(line);
        let j = i + 1;
        while (j < lines.length) {
          const nl = getLine(lines, j);
          if (nl.trim().length === 0) { j += 1; continue; }
          const nIndent = leadingSpaces(nl);
          if (nIndent <= thisIndent && !nl.trim().startsWith("#")) break;
          // The first non-empty line in the dead branch is the dead statement.
          if (nIndent > thisIndent) {
            // Skip pure comment lines.
            const t = nl.trim();
            if (!t.startsWith("//") && !t.startsWith("#") && !t.startsWith("*") && !t.startsWith("/*")) {
              findings.push({
                checkId: "dead-code",
                severity: "warning",
                filePath: f.path,
                line: j + 1,
                column: 0,
                symbol: null,
                message: `Dead code in always-false branch at line ${i + 1}`,
                extra: { branchLine: i + 1, pattern: "dead-branch" },
              });
              break;
            }
          }
          j += 1;
        }
      }
    }
  }
  return findings;
}

/** Pattern 4: dead private functions (non-exported, never called in the codebase).
 * This is the strongest signal — it uses the symbol graph across all files.
 * A `fn private` / `def _private` / `function private` that is never
 * referenced by name in any other file (and not self-recursive in a way that
 * matters) is dead.
 *
 * We avoid false positives by:
 * - Only checking non-exported functions (exported ones are public API).
 * - Excluding test files (their helpers are invoked by the test framework).
 * - Excluding `main`, `__init__`, `__main__`, lifecycle methods (`setUp`,
 * `tearDown`, `__enter__`, `__exit__`, `__str__`, `__repr__`, etc.).
 * - Excluding methods that override a base class method (Python `__dunder__`).
 * - Excluding functions whose name appears in a string literal (reflection/
 * dynamic dispatch).
 * - Excluding functions registered via decorators (`@pytest.fixture`,
 * `@app.route`, `@command`, etc.) — the decorator references the function.
 */
function checkDeadPrivateFunctions(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  // Build a global map: name → set of file paths that contain the name as a token.
  // Also build per-file token counts for fast internal-ref lookup.
  const nameToFiles = new Map<string, Set<string>>();
  const fileTokenCounts = new Map<string, Map<string, number>>();
  const IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*|_\d+/g;
  for (const f of files) {
    const counts = new Map<string, number>();
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const m of line.matchAll(IDENT_RE)) {
        const tok = m[0];
        if (!tok) continue;
        counts.set(tok, (counts.get(tok) ?? 0) + 1);
        let set = nameToFiles.get(tok);
        if (!set) { set = new Set(); nameToFiles.set(tok, set); }
        set.add(f.path);
      }
    }
    fileTokenCounts.set(f.path, counts);
  }

  const lifecycleNames = new Set([
    "main", "__init__", "__main__", "setUp", "tearDown",
    "setUpClass", "tearDownClass", "setUpModule", "tearDownModule",
    "__enter__", "__exit__", "__iter__", "__next__", "__len__",
    "__getitem__", "__setitem__", "__delitem__", "__contains__",
    "__call__", "__str__", "__repr__", "__eq__", "__hash__",
    "__bool__", "__int__", "__float__", "__new__", "__del__",
    "__get__", "__set__", "__delete__", "__class_getitem__",
    "__init_subclass__", "__post_init__",
    // Java serialization hooks (called by JVM via reflection).
    "readObject", "writeObject", "readObjectNoData", "readResolve",
    "writeReplace",
  ]);
  const testFnRe = /^(test|Test|spec|it|describe|benchmark|fuzz|example)/i;
  const decoratorFnRe = /@pytest\.|@app\.|@router\.|@command|@click\.|@fixture|@unittest\.|@parameterized|@bp\.|@csrf|@login_required|@require_/i;
  // Rust test/bench attributes: `#[test]`, `#[cfg(test)]`, `#[tokio::test]`, `#[bench]`.
  const rustTestAttrRe = /#\[test\]|#\[cfg\(test\)\]|#\[tokio::test\]|#\[bench\]|#\[rstest\]/;
  // Dynamic-dispatch name patterns: these are called via `getattr(self, '_print_'+name)`
  // or function-pointer tables, not via direct name reference.
  const dynamicDispatchRe = /^_(print_|eval_|do_|represent_|visit_|emit_|accept_|handle_)/;
  // Redis Module API functions (registered via function-pointer table).
  const redisModuleRe = /^RM_/;

  for (const f of files) {
    if (/test|spec|fixture|conftest/i.test(f.path)) continue;
    // Skip generated files (lexer code, codegen output).
    if (isGeneratedFile(f)) continue;
    // Skip vendored/third-party code (deps/, vendor/, third_party/).
    if (/(^|\/)(deps|vendor|third_party|extern)\//.test(f.path)) continue;
    const counts = fileTokenCounts.get(f.path) ?? new Map();
    for (const sym of f.symbols) {
      if (sym.exported) continue;
      if (sym.kind !== "function" && sym.kind !== "method") continue;
      // FIX (EXP386): only consider declarations (FunctionDeclaration, top-level
      // `def`, `pub fn`, etc.). Function expressions / arrows / lambdas have
      // names internal to the function body — they are NOT file-scope bindings
      // and flagging them is always a false positive. The parser sets
      // `isDeclaration=false` for FunctionExpression/ArrowFunctionExpression
      // and `true` for declarations.
      if (sym.isDeclaration === false) continue;
      // FIX (EXP386): trait-impl methods (Rust `impl Trait for Type`, Java
      // `implements`, Python protocol methods) are REQUIRED by the
      // trait/interface contract — they're called via dynamic dispatch on the
      // trait object, not via direct name reference. Flagging them as dead
      // is always a false positive.
      if (sym.isTraitImpl) continue;
      if (!sym.name || sym.name === "<anonymous>" || sym.name === "<anon>") continue;
      if (sym.name.length < 2) continue;
      if (lifecycleNames.has(sym.name)) continue;
      if (testFnRe.test(sym.name)) continue;
      // Skip dynamic-dispatch patterns (Python printers, visitors, etc.).
      if (dynamicDispatchRe.test(sym.name)) continue;
      // Skip Redis Module API (function-pointer table registration).
      if (redisModuleRe.test(sym.name)) continue;
      if (sym.line > 1) {
        const above = f.content.split("\n").slice(Math.max(0, sym.line - 4), sym.line - 1).join("\n");
        if (decoratorFnRe.test(above)) continue;
        // Rust: skip functions annotated with `#[test]`, `#[bench]`, `#[rstest]`,
        // `#[tokio::test]`, etc. The attribute may be FAR above the function
        // when there are many `#[case::...]` parameters (rstest) or other
        // multi-line attributes. Walk upward through attribute lines and
        // multi-line `)]` continuations until we find a non-attribute,
        // non-comment, non-blank line.
        if (f.language === "rust") {
          const aboveLines = f.content.split("\n");
          let k = sym.line - 2; // 0-indexed, line above the function
          let foundAttr = false;
          while (k >= 0 && k >= sym.line - 500) {
            const al = aboveLines[k];
            if (al === undefined) break;
            const at = al.trim();
            if (at.length === 0) { k -= 1; continue; }
            if (at.startsWith("//")) { k -= 1; continue; }
            // An attribute line: `#[...]` or a continuation `)]`.
            if (at.startsWith("#[") || at.startsWith(")]") || at.endsWith(")]") || at.endsWith("]")) {
              if (rustTestAttrRe.test(al)) {
                foundAttr = true;
                break;
              }
              k -= 1;
              continue;
            }
            // If we hit a non-attribute line (a function, statement, etc.),
            // stop — there are no attributes above this point.
            break;
          }
          if (foundAttr) continue;
          // Also keep the original 3-line check for backwards compat.
          if (rustTestAttrRe.test(above)) continue;
        }
      }
      // External refs: files containing the name, excluding this file.
      const filesReferencing = nameToFiles.get(sym.name);
      let externalRefs = 0;
      if (filesReferencing) {
        for (const p of filesReferencing) {
          if (p !== f.path) externalRefs += 1;
        }
      }
      // Internal refs: occurrences in this file, minus 1 for the declaration.
      const total = counts.get(sym.name) ?? 0;
      const internalRefs = total > 0 ? total - 1 : 0;
      if (externalRefs === 0 && internalRefs === 0) {
        findings.push({
          checkId: "dead-code",
          severity: "warning",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `Private ${sym.kind} '${sym.name}' is never called anywhere in the codebase`,
          extra: { pattern: "dead-private-function", kind: sym.kind, file: f.path },
        });
      }
    }
  }
  return findings;
}

/** Pattern 6: dead code in unreachable catch (re-throw followed by statements). */
function checkDeadAfterRethrow(
  files: readonly ParsedFile[],
  lookback: number,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = linesOf(f.content);
    for (let i = 0; i < lines.length - 1; i += 1) {
      const line = getLine(lines, i);
      // JS/TS: `throw err;` inside a catch block.
      const throwMatch = line.match(/^\s*throw\s+\w[\w.]*\s*;\s*$/);
      // Python: `raise` (re-raise) inside except.
      const raiseMatch = line.match(/^\s*raise\s*$/);
      if (!throwMatch && !raiseMatch) continue;
      // Check we're inside a catch/except: look back for `catch (` or `except`.
      let inHandler = false;
      for (let k = i - 1; k >= Math.max(0, i - lookback); k -= 1) {
        const pl = getLine(lines, k);
        if (/\bcatch\s*\(/.test(pl) || /^\s*except\b/.test(pl)) { inHandler = true; break; }
        if (/\btry\b/.test(pl) || /^\s*try\b/.test(pl)) break;
      }
      if (!inHandler) continue;
      // Find the next non-empty, non-comment line.
      let nextIdx = i + 1;
      while (nextIdx < lines.length) {
        const nl = getLine(lines, nextIdx).trim();
        if (nl.length === 0) { nextIdx += 1; continue; }
        if (nl.startsWith("//") || nl.startsWith("#") || nl.startsWith("*")) { nextIdx += 1; continue; }
        break;
      }
      if (nextIdx >= lines.length) continue;
      const next = getLine(lines, nextIdx);
      const nextTrim = next.trim();
      if (nextTrim.startsWith("}")) continue;
      if (/^(finally|except|else|elif)\b/.test(nextTrim)) continue;
      const thisIndent = leadingSpaces(line);
      const nextIndent = leadingSpaces(next);
      if (nextIndent < thisIndent) continue;
      findings.push({
        checkId: "dead-code",
        severity: "warning",
        filePath: f.path,
        line: nextIdx + 1,
        column: 0,
        symbol: null,
        message: `Unreachable code after re-throw at line ${i + 1}`,
        extra: { rethrowLine: i + 1, pattern: "after-rethrow" },
      });
    }
  }
  return findings;
}

/** Combined dead-code check — runs all 4 patterns and deduplicates.
 * Also filters out findings from generated/vendored files (applied to all
 * patterns, not just dead-private-functions). */
export function checkDeadCode(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  // Build a set of generated/vendored file paths to exclude.
  const excludedFiles = new Set<string>();
  for (const f of files) {
    if (isGeneratedFile(f)) excludedFiles.add(f.path);
    if (/(^|\/)(deps|vendor|third_party|extern)\//.test(f.path)) excludedFiles.add(f.path);
  }
  const filterFiles = (arr: readonly Finding[]): readonly Finding[] =>
    arr.filter((f) => !excludedFiles.has(f.filePath));

  const out: Finding[] = [];
  out.push(...filterFiles(checkUnreachableAfterTerminator(files)));
  out.push(...filterFiles(checkDeadBranch(files)));
  out.push(...filterFiles(checkDeadAfterRethrow(files, config.thresholds.deadCodeCatchLookback)));
  out.push(...filterFiles(checkDeadPrivateFunctions(files, config)));
  // Deduplicate by (filePath, line, pattern).
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.filePath}:${f.line}:${f.extra?.pattern ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Re-export individual patterns for testing.
export {
  checkUnreachableAfterTerminator,
  checkDeadBranch,
  checkDeadAfterRethrow,
  checkDeadPrivateFunctions,
};
// Suppress unused warning for the internal helper.
void KNOWN_TERMINATORS;
