/**
 * Python adapter — line + regex based. Python's grammar is mostly
 * line-oriented (def/class/import at column 0, indented blocks), so a
 * careful line scanner captures functions, type annotations, complexity,
 * imports, exports, and code-health without a full AST dependency.
 *
 * This is intentionally approximate. It is good enough for the awareness
 * signals (function counts, complexity distribution, type-annotation
 * fraction, clone tokens, health counts); it is NOT a Python type
 * checker.
 */
import type { FileAnalysis } from "../types.ts";
import { computeTypedFraction, stripComment, tokenizeBody } from "../language-helpers.ts";

type RawFn = { filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean };

const DEF_RE = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(->\s*[^:]+)?\s*:/;
const CLASS_RE = /^class\s+(\w+)\s*(\(([^)]*)\))?\s*:/;
const IMPORT_RE = /^\s*from\s+(\S+)\s+import\s+(.*)/;
const PLAIN_IMPORT_RE = /^\s*import\s+(\S+)/;
const TODO_RE = /#.*(TODO|FIXME|HACK|XXX|BUG)/i;
const MAGIC_RE = /\b0x[0-9a-fA-F]+\b|\b0b[01]+\b|\b0o[0-7]+\b|\b-?\d+(?:\.\d+)?\b/g;
const ALLOW_NUM = new Set<number>([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5]);

/** Compute indentation level (count leading spaces; tabs = 8 spaces). */
function indentOf(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === " ") n += 1;
    else if (c === "\t") n += 8;
    else break;
  }
  return n;
}

/** Cyclomatic complexity from a body of lines (1 + decision points). */
function bodyComplexity(lines: readonly string[]): number {
  let c = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i] ?? "").trim();
    if (!line) continue;
    if (/\b(if|elif|for|while|and|or|except|with|finally)\b/.test(line)) c += 1;
    // Ternary.
    if (/\b.+\s+if\s+.+\s+else\s+/.test(line)) c += 1;
  }
  return c;
}

const KEYWORDS = new Set<string>(["def", "class", "return", "import", "from", "as", "if", "elif", "else", "for", "while", "try", "except", "finally", "with", "lambda", "yield", "await", "async", "in", "is", "not", "and", "or", "None", "True", "False", "pass", "break", "continue", "raise", "del", "global", "nonlocal", "assert"]);

/** Main entry. */
export function analyzePython(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  const lines = source.split("\n");
  const lineCount = lines.length;
  const fns: RawFn[] = [];
  const imports: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  const exports: Array<{ filePath: string; name: string; isDefault: boolean }> = [];
  let todo = 0;
  let emptyCatch = 0;
  let magicNumber = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();

    // Health: TODO comments.
    if (TODO_RE.test(raw)) todo += 1;

    // Health: magic numbers.
    if (!stripped.startsWith("#")) {
      let m: RegExpExecArray | null;
      MAGIC_RE.lastIndex = 0;
      const noStr = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
      while ((m = MAGIC_RE.exec(noStr)) !== null) {
        const v = Number(m[0]);
        if (Number.isFinite(v) && !ALLOW_NUM.has(v)) magicNumber += 1;
      }
    }

    // Imports.
    let mi = IMPORT_RE.exec(stripped);
    if (mi) {
      const spec = mi[1]!;
      const names = mi[2]!.split(",").map(n => n.trim().split(" as ")[0]!.trim()).filter(n => n && !n.startsWith("("));
      imports.push({ filePath, specifier: spec, importedNames: names, resolvedPath: null });
      continue;
    }
    mi = PLAIN_IMPORT_RE.exec(stripped);
    if (mi) {
      imports.push({ filePath, specifier: mi[1]!, importedNames: [], resolvedPath: null });
      continue;
    }

    // Def.
    const di = DEF_RE.exec(stripped);
    if (di) {
      const name = di[2]!;
      const paramsStr = di[3] ?? "";
      const hasReturn = !!di[4];
      // Count typed parameters.
      let typed = 0;
      let total = 0;
      if (paramsStr.trim() && paramsStr.trim() !== "self" && paramsStr.trim() !== "cls") {
        const paramList = paramsStr.split(",").map(p => p.trim()).filter(p => p);
        for (const p of paramList) {
          total += 1;
          if (/^\*?\*?\w+\s*:/.test(p)) typed += 1;
        }
      }
      // Find body — subsequent lines with indent > def's indent.
      const defIndent = indentOf(raw);
      let end = i + 1;
      while (end < lines.length) {
        const nextLine = lines[end] ?? "";
        if (nextLine.trim() === "") { end += 1; continue; }
        if (indentOf(nextLine) <= defIndent) break;
        end += 1;
      }
      const bodyLines = lines.slice(i + 1, end);
      const bodyChars = bodyLines.reduce((a, b) => a + b.length, 0);
      fns.push({
        filePath, name, line: i + 1,
        bodyLines: bodyLines.length, bodyChars,
        tokens: tokenizeBody(bodyLines, KEYWORDS),
        complexity: bodyComplexity(bodyLines),
        typedParameters: typed, parameterCount: total,
        hasReturnAnnotation: hasReturn,
      });
      continue;
    }

    // Empty except.
    if (/^\s*except.*:\s*$/.test(raw) || /^\s*except\s*:\s*$/.test(raw)) {
      // Look ahead for an empty body (only `pass` or a comment).
      const exceptIndent = indentOf(raw);
      let nextNonEmpty = i + 1;
      while (nextNonEmpty < lines.length) {
        const next = lines[nextNonEmpty] ?? "";
        if (next.trim() === "") { nextNonEmpty += 1; continue; }
        break;
      }
      const nextLine = lines[nextNonEmpty] ?? "";
      if (nextLine.trim() === "pass" || nextLine.trim().startsWith("#") || indentOf(nextLine) <= exceptIndent) {
        emptyCatch += 1;
      }
    }
  }

  // Has type annotations?
  const hasType = fns.some(f => f.typedParameters > 0 || f.hasReturnAnnotation) || /:\s*[A-Z]\w/.test(source);
  const typedFraction = computeTypedFraction(fns);

  // Exports: Python has no formal exports; consider names defined at module
  // scope (indent 0) that are not prefixed with `_` as the "exports".
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? "";
    if (indentOf(l) !== 0) continue;
    const stripped = l.trim();
    const di = DEF_RE.exec(stripped);
    if (di) {
      const name = di[2]!;
      if (!name.startsWith("_")) exports.push({ filePath, name, isDefault: false });
    }
    const ci = CLASS_RE.exec(stripped);
    if (ci) {
      const name = ci[1]!;
      if (!name.startsWith("_")) exports.push({ filePath, name, isDefault: false });
    }
  }

  // Token stream for entropy: tokenize the whole file.
  const tokenStream = tokenizeBody(lines, KEYWORDS);

  return {
    lineCount,
    hasTypeAnnotations: hasType,
    typedParameterFraction: typedFraction,
    functions: fns,
    imports,
    exports,
    health: { todo, emptyCatch, magicNumber, deadCode: 0, missingDefault: 0, parseError: 0 },
    tokenStream,
  };
}
