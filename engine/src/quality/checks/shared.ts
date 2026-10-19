/**
 * Shared check helpers (EXP462).
 *
 * DRY extraction: `stripCommentsAndStrings` was duplicated in
 * `security-hotspot.ts` and `complex-condition.ts`. EXP462 extracts it
 * here so the 25 new lint checks can reuse it without re-implementing.
 * Per the binding directive "Duplicate or similar logics prohibited".
 */

/**
 * Strip ONLY comments (not strings) from a line. Used by checks that need
 * to detect STRING-LITERAL patterns (no-implied-eval, no-throw-literal) —
 * `stripCommentsAndStrings` would remove the very string the check needs
 * to see.
 */
export function stripCommentsOnly(line: string): string {
  let out = "";
  let inStr: string | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") { out += line[i + 1] ?? ""; i += 2; continue; }
      if (c === inStr) { inStr = null; i += 1; continue; }
      i += 1; continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; out += c; i += 1; continue; }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "#") break;
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Strip string literals and comments from a line so pattern-matching only
 * sees actual code. Otherwise patterns like `\bSHA1\b` match `SHA1`
 * mentioned in a comment or string literal, producing 100% FPs on
 * codebases that discuss cryptography. Handles single/double/backtick
 * quotes with escape sequences and line-comments (`//`, `#`). Block
 * comments (`/*... *\/`) are approximated by dropping from `/*` to the
 * closing `*\/` on the same line, or to end of line if no close is found
 * (multi-line block comments are handled per-line by the caller via a
 * stateful scanner when needed).
 *
 * EXP467 fix (EXP462 #5): this is now the SINGLE owner of the comment/string
 * stripper. Previously `security-hotspot.ts` carried a local copy that also
 * handled single-line block comments (`/*... *\/`); that handling is now
 * merged here so security-hotspot.ts can import without behavior change.
 */
export function stripCommentsAndStrings(line: string): string {
  let out = "";
  let inStr: string | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === inStr) { inStr = null; i += 1; continue; }
      i += 1; continue;
    }
    // Line comment start — drop the rest of the line.
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "#") break; // Python / shell comment
    // Block comment start — drop to the closing `*/` on the same line,
    // or to end of line if no close is found (single-line heuristic).
    if (c === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      i = close >= 0 ? close + 2 : line.length;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Heuristic: is this a test file? Checks for common test path/file
 * conventions across languages. Used by checks that should skip test
 * files (e.g. no-eval — tests legitimately use eval).
 */
export function isTestFile(filePath: string): boolean {
  return /(^|[\/\\])(test|tests|__tests__|spec|specs|__specs__)([\/\\]|\.)/.test(filePath)
    || /\.(test|spec)\.[a-z]+$/.test(filePath)
    || /[\/\\]__tests__[\/\\]/.test(filePath);
}

/**
 * Heuristic: is this a JS/TS file? Used by checks that only apply to
 * JS-family languages (no-var, prefer-const, no-inner-declarations).
 */
export function isJsFamily(filePath: string, language?: string): boolean {
  if (language) return language === "javascript" || language === "typescript";
  return /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(filePath);
}
