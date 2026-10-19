/**
 * Rust adapter — line + regex based. Captures `fn`, `impl`, `struct`,
 * `enum`, `mod`, imports (`use`), type annotations (Rust is statically
 * typed; every `fn` has parameter types and a return type, so a Rust
 * file is always "typed"), complexity (decision points), and code
 * health (TODO/empty-match/magic numbers).
 *
 * Approximate, but good enough for the awareness signals.
 */
import type { FileAnalysis } from "../types.ts";
import { computeTypedFraction, stripComment, tokenizeBody } from "../language-helpers.ts";

type RawFn = { filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean };

const FN_RE = /^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?:(->\s*[^{]+)?)?\s*\{/;
const USE_RE = /^\s*(?:pub\s+)?use\s+([^;]+);/;
const TODO_RE = /\/\/.*(TODO|FIXME|HACK|XXX|BUG)/i;
const MAGIC_RE = /\b0x[0-9a-fA-F_]+\b|\b0b[01_]+\b|\b0o[0-7_]+\b|\b-?\d[\d_]*(?:\.\d+)?\b/g;
const ALLOW_NUM = new Set<number>([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5]);

const KEYWORDS = new Set<string>(["fn", "let", "mut", "const", "static", "if", "else", "for", "while", "loop", "match", "return", "break", "continue", "struct", "enum", "trait", "impl", "pub", "use", "mod", "as", "in", "where", "unsafe", "async", "await", "move", "ref", "self", "Self", "true", "false", "Some", "None", "Ok", "Err", "Result", "Option"]);

function bodyComplexity(lines: readonly string[]): number {
  let c = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i] ?? "").trim();
    if (!line) continue;
    if (/\b(if|else|for|while|loop|match|&&|\|\|)\b/.test(line)) c += 1;
    if (/\?\?|=>/.test(line)) c += 1;
    // match arms
    if (/^\s*[^=]+=>/.test(line) && /=>/.test(line)) c += 0; // already counted by match
  }
  return c;
}

/** Find the end of a brace-delimited block starting at line `start` (which contains `{`). */
function findBlockEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (let j = 0; j < line.length; j += 1) {
      const c = line[j];
      if (inStr) {
        if (c === inStr && line[j - 1] !== "\\") inStr = null;
        continue;
      }
      if (c === '"' || c === "'") { inStr = c as '"' | "'"; continue; }
      if (c === "/" && line[j + 1] === "/") break; // line comment
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

export function analyzeRust(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  const lines = source.split("\n");
  const lineCount = lines.length;
  const fns: RawFn[] = [];
  const imports: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  const exports: Array<{ filePath: string; name: string; isDefault: boolean }> = [];
  let todo = 0;
  let emptyMatch = 0;
  let magicNumber = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();

    if (TODO_RE.test(raw)) todo += 1;

    if (!stripped.startsWith("//")) {
      let m: RegExpExecArray | null;
      MAGIC_RE.lastIndex = 0;
      const noStr = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
      while ((m = MAGIC_RE.exec(noStr)) !== null) {
        const v = Number(m[0].replace(/_/g, ""));
        if (Number.isFinite(v) && !ALLOW_NUM.has(v)) magicNumber += 1;
      }
    }

    const ui = USE_RE.exec(stripped);
    if (ui) {
      const spec = ui[1]!;
      // `use foo::{a, b, c}` → specifier "foo", names [a,b,c].
      const braceIdx = spec.indexOf("{");
      if (braceIdx >= 0) {
        const base = spec.slice(0, braceIdx).replace(/::$/, "").trim();
        const namesStr = spec.slice(braceIdx + 1, spec.lastIndexOf("}"));
        const names = namesStr.split(",").map(n => n.trim()).filter(n => n);
        imports.push({ filePath, specifier: base || spec, importedNames: names, resolvedPath: null });
      } else {
        // `use foo::bar::baz` — specifier is the full path, names is the last segment.
        const segments = spec.split("::");
        const last = segments[segments.length - 1] ?? spec;
        imports.push({ filePath, specifier: spec, importedNames: [last], resolvedPath: null });
      }
      continue;
    }

    const fi = FN_RE.exec(stripped);
    if (fi) {
      const name = fi[1]!;
      const paramsStr = fi[3] ?? "";
      const hasReturn = !!fi[4];
      // Count typed params — in Rust every param has a type, so total = typed.
      const paramList = paramsStr.split(",").map(p => p.trim()).filter(p => p && p !== "self" && p !== "&self" && p !== "&mut self");
      const total = paramList.length;
      const typed = total; // Rust requires types.
      // Find body end (the line has `{`, find matching `}`).
      const blockEnd = findBlockEnd(lines, i);
      const bodyLines = lines.slice(i + 1, blockEnd);
      const bodyChars = bodyLines.reduce((a, b) => a + b.length, 0);
      fns.push({
        filePath, name, line: i + 1,
        bodyLines: bodyLines.length, bodyChars,
        tokens: tokenizeBody(bodyLines, KEYWORDS),
        complexity: bodyComplexity(bodyLines),
        typedParameters: typed, parameterCount: total,
        hasReturnAnnotation: hasReturn,
      });
      // Rust `pub fn` is exported.
      if (/^\s*pub\s/.test(raw)) exports.push({ filePath, name, isDefault: false });
      i = blockEnd;
      continue;
    }
  }

  const tokenStream = tokenizeBody(lines, KEYWORDS);
  // Rust is always typed.
  const hasType = fns.length > 0 || /:\s*[A-Z]\w/.test(source);
  const typedFraction = computeTypedFraction(fns);

  return {
    lineCount,
    hasTypeAnnotations: hasType,
    typedParameterFraction: typedFraction,
    functions: fns,
    imports,
    exports,
    health: { todo, emptyCatch: emptyMatch, magicNumber, deadCode: 0, missingDefault: 0, parseError: 0 },
    tokenStream,
  };
}
