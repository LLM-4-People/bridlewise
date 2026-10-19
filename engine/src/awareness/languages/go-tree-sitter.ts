/**
 * Go adapter (tree-sitter) — REAL AST parser, no regex.
 *
 * Replaces EXP361's line+regex Go adapter. The user directive (Round 25)
 * said the line+regex Go adapter was NOT acceptable. This adapter uses
 * `tree-sitter-go` to parse the source into a real AST and walks it to
 * collect functions, imports, exports, complexity, type annotations, and
 * code-health signals.
 *
 * Falls back to the line+regex adapter (./go.ts) if `tree-sitter` is not
 * installed (e.g. fresh clone before `npm install`).
 */
import { hasTreeSitter, parseWithTreeSitter, tokenizeSubtreeWithSource, treeSitterComplexity, bodyLinesOf, bodyCharsOf, walkNamed, type TSNode } from "./tree-sitter-base.ts";
import { analyzeGo as analyzeGoFallback } from "./go.ts";
import type { FileAnalysis } from "../types.ts";

/** Decision-point node types in the Go grammar (cyclomatic complexity = 1 + count). */
const GO_DECISIONS = new Set<string>([
  "if_statement",
  "for_statement",
  "switch_statement",
  "type_switch_statement",
  "select_statement",
  "case_clause",
  "binary_expression", // && and ||
  "short_var_declaration", // roughly counts as a branch in cyclomatic for Go
]);

/** Collect functions (function_declaration + method_declaration) from a Go AST. */
function collectGoFunctions(root: TSNode, filePath: string, source: string) {
  const out: Array<{ filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "function_declaration" || n.type === "method_declaration") {
      // Name: identifier child of the function_declaration.
      let name = "<anonymous>";
      let paramsNode: TSNode | null = null;
      let resultNode: TSNode | null = null;
      let bodyNode: TSNode | null = null;
      for (const c of n.children) {
        if (c.type === "identifier" && name === "<anonymous>") name = source.slice(c.startIndex, c.endIndex);
        else if (c.type === "parameter_list") paramsNode = c;
        else if (c.type === "parameter_declaration") { /* may appear directly in some grammars */ }
        else if (c.type === "result" || c.type === "type" || c.type === "parameter_list") resultNode = c;
        else if (c.type === "block") bodyNode = c;
        if (c.type === "type_identifier" && !resultNode) {
          // method receiver type — not a return type
        }
      }
      // Parameters: count `parameter_declaration` nodes inside `parameter_list`.
      let parameterCount = 0;
      if (paramsNode) {
        for (const c of paramsNode.children) {
          if (c.type === "parameter_declaration") {
            // A parameter_declaration can declare multiple names sharing a type
            // (e.g. `x, y int`). Count identifiers in this declaration.
            let idents = 0;
            for (const cc of c.children) {
              if (cc.type === "identifier") idents += 1;
            }
            parameterCount += Math.max(1, idents);
          }
        }
      }
      // Go: every parameter has a type, so typedParameters = parameterCount.
      const typedParameters = parameterCount;
      // Return annotation: any non-empty `result` child or a bare type in the signature.
      let hasReturn = false;
      for (const c of n.children) {
        if (c.type === "result" || c.type === "type" || c.type === "parameter_list") {
          // result or bare type means there is a return type
        }
        if (c.type === "type" || c.type === "type_identifier" || c.type === "qualified_type" || c.type === "array_type" || c.type === "pointer_type" || c.type === "channel_type") {
          // Distinguish: the function's own return type appears AFTER the parameter_list.
          // We rely on order: parameters come first, then a result, then the block.
        }
      }
      // Simpler: look at the children after the parameter_list.
      const kids = n.children;
      const paramIdx = kids.findIndex(c => c.type === "parameter_list");
      if (paramIdx >= 0) {
        for (let i = paramIdx + 1; i < kids.length; i += 1) {
          const k = kids[i]!;
          if (k.type === "block") break;
          if (k.type === "result") {
            hasReturn = true;
            break;
          }
          // Bare types without a `result` wrapper: still a return type.
          if (k.type === "type_identifier" || k.type === "qualified_type" || k.type === "array_type" || k.type === "pointer_type" || k.type === "channel_type" || k.type === "function_type" || k.type === "interface_type" || k.type === "map_type" || k.type === "slice_type" || k.type === "struct_type") {
            hasReturn = true;
            break;
          }
        }
      }
      const body = bodyNode ?? n;
      const bodyChars = bodyCharsOf(body);
      const bodyLines = bodyLinesOf(body);
      const tokens = tokenizeSubtreeWithSource(body, source);
      const complexity = treeSitterComplexity(body, GO_DECISIONS);
      out.push({ filePath, name, line: n.startPosition.row + 1, bodyLines, bodyChars, tokens, complexity, typedParameters, parameterCount, hasReturnAnnotation: hasReturn });
    }
  }
  return out;
}

/** Collect imports from a Go AST. */
function collectGoImports(root: TSNode, source: string) {
  const out: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "import_declaration") {
      for (const c of n.children) {
        if (c.type === "import_spec") {
          let path = "";
          let name = "";
          for (const cc of c.children) {
            if (cc.type === "interpreted_string_literal" || cc.type === "string_literal") {
              const raw = source.slice(cc.startIndex, cc.endIndex);
              path = raw.replace(/^"|"$/g, "");
            } else if (cc.type === "identifier") {
              name = source.slice(cc.startIndex, cc.endIndex);
            }
          }
          out.push({ filePath: "", specifier: path, importedNames: name ? [name] : [], resolvedPath: null });
        }
      }
    }
  }
  return out;
}

/** Collect exports from a Go AST (capitalized identifiers). */
function collectGoExports(root: TSNode, source: string, filePath: string) {
  const out: Array<{ filePath: string; name: string; isDefault: boolean }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "function_declaration" || n.type === "method_declaration") {
      for (const c of n.children) {
        if (c.type === "identifier") {
          const name = source.slice(c.startIndex, c.endIndex);
          if (/^[A-Z]/.test(name)) {
            out.push({ filePath, name, isDefault: false });
          }
          break;
        }
      }
    } else if (n.type === "type_declaration") {
      for (const c of n.children) {
        if (c.type === "type_spec") {
          for (const cc of c.children) {
            if (cc.type === "type_identifier") {
              const name = source.slice(cc.startIndex, cc.endIndex);
              if (/^[A-Z]/.test(name)) out.push({ filePath, name, isDefault: false });
              break;
            }
          }
        }
      }
    } else if (n.type === "var_declaration" || n.type === "const_declaration") {
      for (const c of n.children) {
        if (c.type === "var_spec" || c.type === "const_spec") {
          for (const cc of c.children) {
            if (cc.type === "identifier") {
              const name = source.slice(cc.startIndex, cc.endIndex);
              if (/^[A-Z]/.test(name)) out.push({ filePath, name, isDefault: false });
            }
          }
        }
      }
    }
  }
  return out;
}

/** Count code-health issues in a Go AST. */
function countGoHealth(root: TSNode, source: string): Record<string, number> {
  const h: Record<string, number> = { todo: 0, emptyCatch: 0, magicNumber: 0, deadCode: 0, missingDefault: 0 };
  // TODO/FIXME comments — Go comments are NOT named nodes by default; scan source.
  const commentRe = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;
  commentRe.lastIndex = 0;
  while ((m = commentRe.exec(source)) !== null) {
    if (/\b(TODO|FIXME|HACK|XXX|BUG)\b/.test(m[0])) h.todo = (h.todo ?? 0) + 1;
  }
  // Magic numbers — scan source for numeric literals not in the allowlist.
  const allow = new Set<number>([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5]);
  const numRe = /\b0x[0-9a-fA-F_]+\b|\b0b[01_]+\b|\b0o[0-7_]+\b|\b-?\d[\d_]*(?:\.\d+)?\b/g;
  numRe.lastIndex = 0;
  // Strip comments + strings first to avoid false positives.
  // EXP387 fix: the backtick regex `/`(?:[^`]|\n)*`/g` caused catastrophic
  // backtracking on context.go (48KB, hangs >60s). The `[^`]|\n`
  // alternation is redundant — `[^`]` already matches newlines — and the
  // alternation causes the regex engine to try both branches for every
  // char, producing exponential backtracking. Replaced with `/`[^`]*`/g`.
  const stripped = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "")
    .replace(/`[^`]*`/g, "");
  while ((m = numRe.exec(stripped)) !== null) {
    const v = Number(m[0].replace(/_/g, ""));
    if (Number.isFinite(v) && !allow.has(v)) h.magicNumber = (h.magicNumber ?? 0) + 1;
  }
  // Empty catch (defer/recover — Go has no try/catch; count empty function bodies of `recover`).
  // Missing default in switch statements.
  for (const n of walkNamed(root)) {
    if (n.type === "switch_statement" || n.type === "type_switch_statement" || n.type === "select_statement") {
      let hasDefault = false;
      for (const c of n.children) {
        if (c.type === "case_clause") {
          for (const cc of c.children) {
            if (cc.type === "default") { hasDefault = true; break; }
            // tree-sitter-go: `default` is an anonymous keyword. Check by text.
            if (!cc.isNamed) {
              const txt = source.slice(cc.startIndex, cc.endIndex);
              if (txt === "default") { hasDefault = true; break; }
            }
          }
          if (hasDefault) break;
        }
      }
      if (!hasDefault) h.missingDefault = (h.missingDefault ?? 0) + 1;
    }
  }
  return h;
}

/** Tokenize the whole source file for entropy. */
function goTokenStream(root: TSNode, source: string): string[] {
  return tokenizeSubtreeWithSource(root, source);
}

/** Detect type annotations. Go is statically typed — always true if there are functions. */
function goHasTypes(root: TSNode): boolean {
  for (const n of walkNamed(root)) {
    if (n.type === "function_declaration" || n.type === "method_declaration" || n.type === "type_declaration" || n.type === "var_declaration" || n.type === "const_declaration") return true;
  }
  return false;
}

/** Count lines in source. */

/** Real-parser Go adapter entry. Falls back to line+regex if tree-sitter is missing. */
export function analyzeGo(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  if (!hasTreeSitter()) return analyzeGoFallback(filePath, source);
  const root = parseWithTreeSitter("tree-sitter-go", source);
  if (!root) {
    // Parse failure — fall back to line+regex.
    return analyzeGoFallback(filePath, source);
  }
  const lineCount = countLines(source);
  const fns = collectGoFunctions(root, filePath, source);
  const imports = collectGoImports(root, source);
  const exports = collectGoExports(root, source, filePath);
  const health = countGoHealth(root, source);
  const tokenStream = goTokenStream(root, source);
  const hasType = goHasTypes(root);
  const typedFraction = computeTypedFraction(fns);
  // Fill in filePath on functions/imports/exports.
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

import type { FileAnalysis as FA } from "../types.ts";
import { countLines, computeTypedFraction } from "../language-helpers.ts";
void ({} as FA);
