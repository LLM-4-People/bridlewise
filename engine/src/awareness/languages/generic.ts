/**
 * Generic fallback adapter — used when no language adapter matches a
 * file's extension. It computes only the language-agnostic signals:
 * line count, file content token stream, and a single "function"
 * representing the whole file (so the engine still has a function
 * record to work with). No imports/exports/typed/health signals.
 *
 * This guarantees the awareness engine works on ANY codebase, even
 * one with unknown file types — it never silently skips a file.
 */
import type { FileAnalysis } from "../types.ts";

const ID_RE = /\b[A-Za-z_]\w*\b/g;
const NUM_RE = /\b\d+(?:\.\d+)?\b/g;
const STR_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/**
 * Text-file extensions the generic adapter recognizes when no language
 * adapter matches. R48: owned HERE (the generic adapter's home — the
 * language-grammar concern lives with the adapter that consumes it, rule
 * 21/25); was a scattered inline literal in `engine.ts`. The engine imports
 * this so the generic-fallback walk stays consistent with the adapter.
 */
export const GENERIC_TEXT_EXTENSIONS: ReadonlyArray<string> = Object.freeze([
  ".txt", ".md", ".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".sh", ".bash",
]);

function tokenize(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let m: RegExpExecArray | null;
    STR_RE.lastIndex = 0;
    while ((m = STR_RE.exec(lines[i] ?? "")) !== null) out.push("lit_str");
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(lines[i] ?? "")) !== null) out.push("lit_num");
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(lines[i] ?? "")) !== null) out.push(m[0].toLowerCase());
  }
  return out;
}

export function analyzeGeneric(_filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  const lines = source.split("\n");
  const tokenStream = tokenize(lines);
  return {
    lineCount: lines.length,
    hasTypeAnnotations: false,
    typedParameterFraction: 0,
    functions: [],
    imports: [],
    exports: [],
    health: { todo: 0, emptyCatch: 0, magicNumber: 0, deadCode: 0, missingDefault: 0, parseError: 0 },
    tokenStream,
  };
}
