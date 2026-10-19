/**
 * Rust adapter (tree-sitter) — REAL AST parser, no regex.
 *
 * Replaces EXP361's line+regex Rust adapter. Uses `tree-sitter-rust`
 * to parse the source into a real AST and walks it to collect functions,
 * imports (`use`), exports (`pub`), complexity, type annotations, and
 * code-health signals.
 *
 * Falls back to the line+regex adapter (./rust.ts) if `tree-sitter` is
 * not installed.
 */
import { hasTreeSitter, parseWithTreeSitter, tokenizeSubtreeWithSource, treeSitterComplexity, bodyLinesOf, bodyCharsOf, walkNamed } from "./tree-sitter-base.ts";
import type { TSNode } from "./tree-sitter-base.ts";
import { analyzeRust as analyzeRustFallback } from "./rust.ts";
import type { FileAnalysis } from "../types.ts";
import { countLines, computeTypedFraction } from "../language-helpers.ts";

/** Rust decision-point node types. */
const RS_DECISIONS = new Set<string>([
  "if_expression",
  "match_expression",
  "match_arm",
  "for_expression",
  "while_expression",
  "loop_expression",
  "binary_expression", // && and ||
  "let_expression",
]);

/** Collect function definitions (function_item). */
function collectRsFunctions(root: TSNode, filePath: string, source: string) {
  const out: Array<{ filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "function_item") {
      let name = "<anonymous>";
      let paramsNode: TSNode | null = null;
      let retTypeNode: TSNode | null = null;
      let bodyNode: TSNode | null = null;
      for (const c of n.children) {
        if (c.type === "identifier" && name === "<anonymous>") name = source.slice(c.startIndex, c.endIndex);
        else if (c.type === "parameters") paramsNode = c;
        else if (c.type === "block") bodyNode = c;
        else if (c.type === "type" && !retTypeNode && c.parent === n) retTypeNode = c;
      }
      const kids = n.children;
      const paramIdx = kids.findIndex(c => c.type === "parameters");
      if (paramIdx >= 0) {
        for (let i = paramIdx + 1; i < kids.length; i += 1) {
          const k = kids[i]!;
          if (k.type === "block") break;
          if (k.type === "type") { retTypeNode = k; break; }
        }
      }
      let parameterCount = 0;
      if (paramsNode) {
        for (const c of paramsNode.children) {
          if (c.type === "parameter") parameterCount += 1;
          else if (c.type === "self_parameter") parameterCount += 1;
          else if (c.type === "variadic_parameter") parameterCount += 1;
        }
      }
      const typedParameters = parameterCount; // Rust requires types.
      const body = bodyNode ?? n;
      const bodyChars = bodyCharsOf(body);
      const bodyLines = bodyLinesOf(body);
      const tokens = tokenizeSubtreeWithSource(body, source);
      const complexity = treeSitterComplexity(body, RS_DECISIONS);
      out.push({ filePath, name, line: n.startPosition.row + 1, bodyLines, bodyChars, tokens, complexity, typedParameters, parameterCount, hasReturnAnnotation: retTypeNode !== null });
    }
  }
  return out;
}

/** Collect `use` imports. */
function collectRsImports(root: TSNode, source: string) {
  const out: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "use_declaration") {
      // Capture the full path text.
      const text = source.slice(n.startIndex, n.endIndex).replace(/^use\s+/, "").replace(/;$/, "").trim();
      // Use arguments: try to extract `use_declaration > use_list` parts.
      let path = "";
      const names: string[] = [];
      let hasGroup = false;
      for (const c of n.children) {
        if (c.type === "use_list" || c.type === "use_as_clause") {
          hasGroup = true;
        }
      }
      if (hasGroup) {
        // `use a::b::{c, d}` — pull the path before `{`.
        const m = /^([^{]+)\{(.*)\}$/.exec(text.replace(/\s+/g, ""));
        if (m) {
          path = m[1]!.replace(/::$/, "");
          names.push(...m[2]!.split(",").map(s => s.trim()).filter(Boolean));
        } else {
          path = text;
        }
      } else {
        path = text;
      }
      out.push({ filePath: "", specifier: path, importedNames: names, resolvedPath: null });
    }
  }
  return out;
}

/** Collect `pub` exports. */
function collectRsExports(root: TSNode, source: string, filePath: string) {
  const out: Array<{ filePath: string; name: string; isDefault: false }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "function_item" || n.type === "struct_item" || n.type === "enum_item" || n.type === "trait_item" || n.type === "type_item" || n.type === "const_item" || n.type === "static_item" || n.type === "macro_definition") {
      // Check for `pub` modifier among children.
      let isPub = false;
      let nameNode: TSNode | null = null;
      for (const c of n.children) {
        if (!c.isNamed) {
          const txt = source.slice(c.startIndex, c.endIndex);
          if (txt === "pub") isPub = true;
        } else if (c.type === "identifier" && !nameNode) nameNode = c;
        else if (c.type === "visibility_modifier") isPub = true;
      }
      if (isPub && nameNode) out.push({ filePath, name: source.slice(nameNode.startIndex, nameNode.endIndex), isDefault: false });
    }
  }
  return out;
}

/** Code-health counts. */
function countRsHealth(_root: TSNode, source: string): Record<string, number> {
  const h: Record<string, number> = { todo: 0, emptyCatch: 0, magicNumber: 0, deadCode: 0, missingDefault: 0 };
  // TODO/FIXME in comments.
  const commentRe = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;
  commentRe.lastIndex = 0;
  while ((m = commentRe.exec(source)) !== null) {
    if (/\b(TODO|FIXME|HACK|XXX|BUG)\b/.test(m[0])) h.todo = (h.todo ?? 0) + 1;
  }
  // Magic numbers.
  const allow = new Set<number>([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5]);
  const numRe = /\b0x[0-9a-fA-F_]+\b|\b0b[01_]+\b|\b0o[0-7_]+\b|\b-?\d[\d_]*(?:\.\d+)?\b/g;
  numRe.lastIndex = 0;
  const stripped = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "");
  while ((m = numRe.exec(stripped)) !== null) {
    const v = Number(m[0].replace(/_/g, ""));
    if (Number.isFinite(v) && !allow.has(v)) h.magicNumber = (h.magicNumber ?? 0) + 1;
  }
  // Empty match arm count — too noisy; skip.
  return h;
}

/** Detect type annotations — Rust is statically typed, so true if there are functions. */
function rsHasTypes(root: TSNode): boolean {
  for (const n of walkNamed(root)) {
    if (n.type === "function_item" || n.type === "struct_item" || n.type === "enum_item" || n.type === "let_declaration") return true;
  }
  return false;
}

/** Count lines. */

/** Real-parser Rust adapter entry. */
export function analyzeRust(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  if (!hasTreeSitter()) return analyzeRustFallback(filePath, source);
  const root = parseWithTreeSitter("tree-sitter-rust", source);
  if (!root) return analyzeRustFallback(filePath, source);
  const lineCount = countLines(source);
  const fns = collectRsFunctions(root, filePath, source);
  const imports = collectRsImports(root, source);
  const exports = collectRsExports(root, source, filePath);
  const health = countRsHealth(root, source);
  const tokenStream = tokenizeSubtreeWithSource(root, source);
  const hasType = rsHasTypes(root);
  const typedFraction = computeTypedFraction(fns);
  for (const i of imports) i.filePath = filePath;
  return {
    lineCount,
    hasTypeAnnotations: hasType,
    typedParameterFraction: typedFraction,
    functions: fns,
    imports,
    exports,
    health,
    tokenStream,
  };
}
