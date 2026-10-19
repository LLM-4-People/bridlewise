/**
 * Empty-function check (EXP386).
 *
 * Flags function/method bodies that are empty or contain only a single
 * trivial statement (`pass`, `{}`, `return;`, `return None;`, `//...`).
 * Empty function bodies are usually placeholders, stubs, or accidentally
 * cleared code. In production code they're a smell — the function promises
 * behavior but does nothing.
 *
 * Uses the per-symbol `bodyLines` already computed by the parsers plus a
 * text scan of the body for trivial statements. Language-agnostic.
 *
 * False-positive avoidance:
 * - Skip methods whose name begins with `test`/`spec`/`benchmark` (test
 * stubs are intentional).
 * - Skip functions annotated with `@abstractmethod`, `abstract`, or in an
 * `interface`/`trait`/`protocol` declaration (interface methods are
 * declarations, not implementations).
 * - Skip `__init__`, `__del__`, `setUp`, `tearDown` (lifecycle hooks that
 * are sometimes intentionally empty).
 * - Skip `main` (the entry point may be intentionally empty when
 * behavior is inlined in setup).
 * - Skip dunder methods (`__X__`) generally — they often have legitimate
 * no-op implementations.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

const TRIVIAL_RE = /^\s*(pass|;|\{\s*\}|return\s*;|return\s+None\s*;?|return\s+null\s*;?|return\s+Nil\s*;?|return\s+()\s*;?|\/\/.*|\/\*.*\*\/|#.*|_\s*=>\s*\{\s*\})\s*$/;

const LIFECYCLE_NAMES = new Set([
  "main", "__init__", "__del__", "__new__",
  "setUp", "tearDown", "setUpClass", "tearDownClass",
  "__enter__", "__exit__", "__post_init__",
]);

const TEST_NAME_RE = /^(test|Test|spec|it|describe|benchmark|fuzz|example)/i;

function isAbstractOrInterface(file: ParsedFile, sym: { line: number; name: string }): boolean {
  // Look above the symbol for `abstract`, `@abstractmethod`, or a
  // `trait`/`interface`/`protocol` opening line.
  const lines = file.content.split("\n");
  for (let k = sym.line - 2; k >= Math.max(0, sym.line - 10); k -= 1) {
    const line = lines[k] ?? "";
    if (/abstract|@abstractmethod|@abc\.|virtual\s*=\s*0|trait\b|interface\b|protocol\b|@objc/.test(line)) {
      return true;
    }
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("#") && !trimmed.startsWith("*") && !trimmed.startsWith("@")) break;
  }
  return false;
}

export function checkEmptyFunctions(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.kind !== "function" && sym.kind !== "method") continue;
      // FIX (EXP386): skip arrow functions / lambdas / anonymous function
      // expressions. The parser marks these with `isDeclaration: false`
      // (FunctionExpression, ArrowFunctionExpression, lambdas). They are
      // often single-line callbacks like `res => formatCode(res.code)` —
      // the body extraction logic doesn't handle expression-body arrows
      // (no `{`/`}` to slice between), so they get mis-flagged as empty.
      // Only check declared functions/methods (FunctionDeclaration, top-
      // level `def`, `pub fn`, etc.).
      if (!sym.isDeclaration) continue;
      // Skip anonymous functions (no name to act on).
      if (sym.name === "<anonymous>" || sym.name === "<anon>" || sym.name === "<lambda>") continue;
      if (TEST_NAME_RE.test(sym.name)) continue;
      if (LIFECYCLE_NAMES.has(sym.name)) continue;
      if (isAbstractOrInterface(f, sym)) continue;
      // Extract the body text. For single-line functions (`function f {}`
      // or `fn f {}`), endLine == line, so slice from the function line
      // and extract the body between `{` and `}` on that line.
      const lines = f.content.split("\n");
      let bodyLines: string[];
      if (sym.endLine <= sym.line) {
        // Single-line function — extract the text between `{` and `}` on
        // the same line as the signature.
        const lineText = lines[sym.line - 1] ?? "";
        const openBrace = lineText.indexOf("{");
        const closeBrace = lineText.lastIndexOf("}");
        if (openBrace >= 0 && closeBrace > openBrace) {
          bodyLines = [lineText.slice(openBrace + 1, closeBrace)];
        } else {
          bodyLines = [];
        }
      } else {
        bodyLines = lines.slice(sym.line, sym.endLine).map((l) => l ?? "");
      }
      // Strip leading/trailing whitespace + braces.
      const cleaned = bodyLines
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l !== "{" && l !== "}" && l !== "};");
      if (cleaned.length === 0) {
        findings.push({
          checkId: "empty-function",
          severity: "info",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `${sym.kind === "method" ? "Method" : "Function"} '${sym.name}' has an empty body`,
          extra: { bodyLines: sym.bodyLines, file: f.path },
        });
        continue;
      }
      // If the body is one trivial statement, also flag.
      if (cleaned.length <= 2 && cleaned.every((l) => TRIVIAL_RE.test(l))) {
        findings.push({
          checkId: "empty-function",
          severity: "info",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `${sym.kind === "method" ? "Method" : "Function"} '${sym.name}' has a trivial body (only ${cleaned.join(" ")})`,
          extra: { bodyLines: sym.bodyLines, trivial: cleaned.join(" "), file: f.path },
        });
      }
    }
  }
  return findings;
}
