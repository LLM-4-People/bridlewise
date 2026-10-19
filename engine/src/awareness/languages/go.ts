/**
 * Go adapter — line + regex based. Captures `func`, `import`, `package`,
 * type annotations (Go is statically typed; every `func` has parameter
 * types and a return type, so a Go file is always "typed"), complexity
 * (decision points), and code health (TODO/empty-switch-default/magic
 * numbers).
 *
 * Approximate, but good enough for the awareness signals.
 */
import type { FileAnalysis } from "../types.ts";
import { computeTypedFraction, stripComment } from "../language-helpers.ts";

type RawFn = { filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean };

// EXP387 fix: the backtick regex `` `(?:[^`]|\n)*` `` caused catastrophic
// backtracking (the `[^`]|\n` alternation is redundant — `[^`]` already
// matches newlines). Replaced with `` `[^`]*` `` which is equivalent and fast.
const STR_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const FUNC_RE = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:(\([^)]*\)\s*)?([^{]+)?)?\s*\{/;
const IMPORT_SINGLE_RE = /^\s*import\s+"([^"]+)"/;
const IMPORT_MULTI_RE = /^\s*import\s*\(/;
const TODO_RE = /\/\/.*(TODO|FIXME|HACK|XXX|BUG)/i;
const MAGIC_RE = /\b0x[0-9a-fA-F_]+\b|\b0b[01_]+\b|\b0o[0-7_]+\b|\b-?\d[\d_]*(?:\.\d+)?\b/g;
const ALLOW_NUM = new Set<number>([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5]);

const KEYWORDS = new Set<string>(["func", "var", "const", "type", "struct", "interface", "package", "import", "if", "else", "for", "range", "switch", "case", "default", "defer", "go", "chan", "select", "return", "break", "continue", "fallthrough", "map", "make", "new", "nil", "true", "false", "iota"]);

function tokenizeBody(lines: readonly string[]): string[] {
  const out: string[] = [];
  const idRe = /\b[A-Za-z_]\w*\b/g;
  const numRe = /\b\d+(?:\.\d+)?\b/g;
  const strRe = STR_RE;  // EXP387 fix: use the shared (fixed) STR_RE.
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i] ?? "");
    let m: RegExpExecArray | null;
    strRe.lastIndex = 0;
    while ((m = strRe.exec(line)) !== null) out.push("lit_str");
    numRe.lastIndex = 0;
    while ((m = numRe.exec(line)) !== null) out.push("lit_num");
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      const w = m[0];
      if (!KEYWORDS.has(w)) out.push(w.toLowerCase());
    }
  }
  return out;
}

function bodyComplexity(lines: readonly string[]): number {
  let c = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i] ?? "").trim();
    if (!line) continue;
    if (/\b(if|else|for|range|switch|case|select|&&|\|\|)\b/.test(line)) c += 1;
    if (/<-|->/.test(line)) c += 1;
  }
  return c;
}

function findBlockEnd(lines: readonly string[], start: number, startCol: number = 0): number {
  // EXP387 fix: startCol points AFTER the function's opening `{` (the caller
  // matched `func... {` and passed matchEnd as startCol). So we already
  // passed ONE `{` — initialize depth = 1, not 0. Without this, a single-
  // line function like `func foo { return 1 }` would have its `}` make
  // depth = -1 (not 0), and findBlockEnd would never return — causing the
  // adapter to skip all subsequent functions in the file.
  let depth = 1;
  let inStr: '"' | "'" | "`" | null = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const begin = i === start ? startCol : 0;
    for (let j = begin; j < line.length; j += 1) {
      const c = line[j];
      if (inStr) {
        if (c === inStr && (inStr !== "`" || line[j - 1] !== "\\")) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c as '"' | "'" | "`"; continue; }
      if (c === "/" && line[j + 1] === "/") break;
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

export function analyzeGo(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  const lines = source.split("\n");
  const lineCount = lines.length;
  const fns: RawFn[] = [];
  const imports: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  const exports: Array<{ filePath: string; name: string; isDefault: boolean }> = [];
  let todo = 0;
  let missingDefault = 0;
  let magicNumber = 0;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();

    if (TODO_RE.test(raw)) todo += 1;

    if (!stripped.startsWith("//")) {
      let m: RegExpExecArray | null;
      MAGIC_RE.lastIndex = 0;
      const noStr = raw.replace(STR_RE, "");  // EXP387 fix: use the shared (fixed) STR_RE.
      while ((m = MAGIC_RE.exec(noStr)) !== null) {
        const v = Number(m[0].replace(/_/g, ""));
        if (Number.isFinite(v) && !ALLOW_NUM.has(v)) magicNumber += 1;
      }
    }

    // Imports.
    const isMulti = IMPORT_MULTI_RE.test(stripped);
    if (isMulti) {
      // Multi-line import block.
      let j = i + 1;
      while (j < lines.length) {
        const jLine = (lines[j] ?? "").trim();
        if (jLine === ")") break;
        const match = /^\s*"([^"]+)"/.exec(jLine);
        if (match) imports.push({ filePath, specifier: match[1]!, importedNames: [], resolvedPath: null });
        j += 1;
      }
      i = j;
      continue;
    }
    const singleMatch = IMPORT_SINGLE_RE.exec(stripped);
    if (singleMatch) {
      imports.push({ filePath, specifier: singleMatch[1]!, importedNames: [], resolvedPath: null });
      i += 1;
      continue;
    }

    // Functions.
    const fi = FUNC_RE.exec(stripped);
    if (fi) {
      const name = fi[1]!;
      const paramsStr = fi[2] ?? "";
      const hasReturn = !!(fi[3] || fi[4]);
      // Go params always have types. Count them.
      const paramList = paramsStr.split(",").map(p => p.trim()).filter(p => p);
      const total = paramList.length;
      const typed = total; // Go requires types.
      // Compute the column of the function's opening `{` on the start line.
      // The regex ends with `\{`, so the match's end index is the column AFTER the `{`.
      // We pass startCol = matchEnd so findBlockEnd skips any `{` in the signature
      // (e.g. `func Done <-chan struct{} {` has `struct{}` before the function's `{`).
      const matchEnd = (fi.index ?? 0) + fi[0].length;
      // The match was against `stripped` (trimmed line), so adjust to the raw line's coordinates.
      const leadingWhitespace = raw.length - raw.trimStart().length;
      const rawMatchEnd = matchEnd + leadingWhitespace;
      const blockEnd = findBlockEnd(lines, i, rawMatchEnd);
      const bodyLines = lines.slice(i + 1, blockEnd);
      const bodyChars = bodyLines.reduce((a, b) => a + b.length, 0);
      fns.push({
        filePath, name, line: i + 1,
        bodyLines: bodyLines.length, bodyChars,
        tokens: tokenizeBody(bodyLines),
        complexity: bodyComplexity(bodyLines),
        typedParameters: typed, parameterCount: total,
        hasReturnAnnotation: hasReturn,
      });
      // Go: capitalized = exported.
      if (/^[A-Z]/.test(name)) exports.push({ filePath, name, isDefault: false });
      // Missing default in switch.
      const bodyText = bodyLines.map(l => stripComment(l)).join("\n");
      const switchMatches = bodyText.match(/switch\s[^{]*\{/g);
      if (switchMatches) {
        for (let s = 0; s < switchMatches.length; s += 1) {
          // Find the matching `}` for this switch and check for `default`.
          const switchStart = bodyText.indexOf(switchMatches[s]!, s);
          let depth = 1;
          let k = switchStart + switchMatches[s]!.length;
          let hasDefault = false;
          while (k < bodyText.length && depth > 0) {
            if (bodyText[k] === "{") depth += 1;
            else if (bodyText[k] === "}") depth -= 1;
            if (depth > 0 && bodyText.slice(k, k + 7) === "default") hasDefault = true;
            k += 1;
          }
          if (!hasDefault) missingDefault += 1;
        }
      }
      // Always advance past the function (blockEnd can equal i for single-line
      // functions like `func foo { }` — without `+1` we'd infinite-loop).
      i = blockEnd + 1;
      continue;
    }
    i += 1;
  }

  const tokenStream = tokenizeBody(lines);
  const hasType = fns.length > 0 || /:\s*[A-Z]\w/.test(source);
  const typedFraction = computeTypedFraction(fns);

  return {
    lineCount,
    hasTypeAnnotations: hasType,
    typedParameterFraction: typedFraction,
    functions: fns,
    imports,
    exports,
    health: { todo, emptyCatch: 0, magicNumber, deadCode: 0, missingDefault, parseError: 0 },
    tokenStream,
  };
}
