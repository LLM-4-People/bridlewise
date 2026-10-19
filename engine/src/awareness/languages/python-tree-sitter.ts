/**
 * Python adapter (tree-sitter) — REAL AST parser, no regex.
 *
 * Replaces EXP361's line+regex Python adapter. Uses `tree-sitter-python`
 * to parse the source into a real AST and walks it to collect functions,
 * imports, exports, complexity, type annotations, and code-health signals.
 *
 * Falls back to the line+regex adapter (./python.ts) if `tree-sitter` is
 * not installed.
 */
import { hasTreeSitter, parseWithTreeSitter, tokenizeSubtreeWithSource, treeSitterComplexity, bodyLinesOf, bodyCharsOf, walkNamed } from "./tree-sitter-base.ts";
import { analyzePython as analyzePythonFallback } from "./python.ts";
import type { FileAnalysis } from "../types.ts";

/** Python decision-point node types. */
const PY_DECISIONS = new Set<string>([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "with_statement",
  "try_statement",
  "except_clause",
  "boolean_op", // and/or
  "conditional_expression", // x if c else y
  "match_statement", // Python 3.10+
  "case_clause",
]);

/** Collect function definitions (def + async def) and methods. */
function collectPyFunctions(root: TSNode, filePath: string, source: string) {
  const out: Array<{ filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "function_definition") {
      let name = "<anonymous>";
      let paramsNode: TSNode | null = null;
      let returnNode: TSNode | null = null;
      let bodyNode: TSNode | null = null;
      for (const c of n.children) {
        if (c.type === "identifier" && name === "<anonymous>") name = source.slice(c.startIndex, c.endIndex);
        else if (c.type === "parameters") paramsNode = c;
        else if (c.type === "block") bodyNode = c;
        else if (c.type === "type" && !returnNode && c.parent === n) returnNode = c;
      }
      // The return type appears as a `type` child after `parameters`.
      // Check the children order: def, name, parameters, ->, type,:, block.
      const kids = n.children;
      const paramIdx = kids.findIndex(c => c.type === "parameters");
      if (paramIdx >= 0) {
        for (let i = paramIdx + 1; i < kids.length; i += 1) {
          const k = kids[i]!;
          if (k.type === "block") break;
          if (k.type === "type") { returnNode = k; break; }
        }
      }
      // Parameters: count children of `parameters` node.
      let parameterCount = 0;
      let typedParameters = 0;
      if (paramsNode) {
        for (const c of paramsNode.children) {
          if (c.type === "identifier" || c.type === "typed_parameter" || c.type === "default_parameter" || c.type === "typed_default_parameter" || c.type === "list_splat_pattern" || c.type === "dictionary_splat_pattern" || c.type === "keyword_separator" || c.type === "positional_separator") {
            parameterCount += 1;
            if (c.type === "typed_parameter" || c.type === "typed_default_parameter") typedParameters += 1;
            // `default_parameter` (`x = 1`) without a type — not typed.
            // Check children: a `default_parameter` might have a `type` inside.
            if (c.type === "default_parameter") {
              for (const cc of c.children) {
                if (cc.type === "type") { typedParameters += 1; break; }
              }
            }
          }
        }
      }
      const body = bodyNode ?? n;
      const bodyChars = bodyCharsOf(body);
      const bodyLines = bodyLinesOf(body);
      const tokens = tokenizeSubtreeWithSource(body, source);
      const complexity = treeSitterComplexity(body, PY_DECISIONS);
      out.push({ filePath, name, line: n.startPosition.row + 1, bodyLines, bodyChars, tokens, complexity, typedParameters, parameterCount, hasReturnAnnotation: returnNode !== null });
    }
  }
  return out;
}

/** Collect imports. */
function collectPyImports(root: TSNode, source: string) {
  const out: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  for (const n of walkNamed(root)) {
    if (n.type === "import_statement") {
      // `import a.b.c` or `import a.b.c as d`
      for (const c of n.children) {
        if (c.type === "dotted_name") {
          const name = source.slice(c.startIndex, c.endIndex);
          out.push({ filePath: "", specifier: name, importedNames: [], resolvedPath: null });
        } else if (c.type === "dotted_name" || c.type === "aliased_import") {
          // handle aliased_import separately below
        }
        if (c.type === "aliased_import") {
          let realName = "";
          let alias = "";
          for (const cc of c.children) {
            if (cc.type === "dotted_name") realName = source.slice(cc.startIndex, cc.endIndex);
            else if (cc.type === "identifier") alias = source.slice(cc.startIndex, cc.endIndex);
          }
          out.push({ filePath: "", specifier: realName, importedNames: alias ? [alias] : [], resolvedPath: null });
        }
      }
    } else if (n.type === "import_from_statement") {
      // `from x.y import a, b as c`
      let module = "";
      const names: string[] = [];
      const kids = n.children;
      for (let i = 0; i < kids.length; i += 1) {
        const c = kids[i]!;
        if (c.type === "dotted_name" || c.type === "relative_import") {
          if (c.type === "dotted_name") module = source.slice(c.startIndex, c.endIndex);
          else module = source.slice(c.startIndex, c.endIndex); // leading dots
        }
        if (c.type === "identifier" && i > 0 && kids[i - 1]!.type === "import") {
          names.push(source.slice(c.startIndex, c.endIndex));
        }
        if (c.type === "aliased_import") {
          for (const cc of c.children) {
            if (cc.type === "identifier") names.push(source.slice(cc.startIndex, cc.endIndex));
          }
        }
        if (c.type === "dotted_name" && i > 0 && kids[i - 1]!.type === "import") {
          names.push(source.slice(c.startIndex, c.endIndex));
        }
        if (c.type === "wildcard_import") names.push("*");
      }
      out.push({ filePath: "", specifier: module, importedNames: names, resolvedPath: null });
    }
  }
  return out;
}

/** Exports in Python — top-level (col 0) functions and classes, plus __all__. */
function collectPyExports(root: TSNode, source: string, filePath: string) {
  const out: Array<{ filePath: string; name: string; isDefault: false }> = [];
  for (const child of root.children) {
    if (!child.isNamed) continue;
    if (child.type === "function_definition" || child.type === "class_definition") {
      for (const c of child.children) {
        if (c.type === "identifier") {
          out.push({ filePath, name: source.slice(c.startIndex, c.endIndex), isDefault: false });
          break;
        }
      }
    } else if (child.type === "expression_statement") {
      // Look for __all__ = [...]
      for (const c of child.children) {
        if (c.type === "assignment") {
          let isAll = false;
          let listNode: TSNode | null = null;
          for (const cc of c.children) {
            if (cc.type === "identifier" && source.slice(cc.startIndex, cc.endIndex) === "__all__") isAll = true;
            if (cc.type === "list" || cc.type === "tuple") listNode = cc;
          }
          if (isAll && listNode) {
            for (const li of listNode.children) {
              if (li.type === "string") {
                const raw = source.slice(li.startIndex, li.endIndex);
                out.push({ filePath, name: raw.replace(/^['"]|['"]$/g, ""), isDefault: false });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** Code-health counts. */
function countPyHealth(root: TSNode, source: string): Record<string, number> {
  const h: Record<string, number> = { todo: 0, emptyCatch: 0, magicNumber: 0, deadCode: 0, missingDefault: 0 };
  // Comments.
  const commentRe = /#[^\n]*/g;
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
    .replace(/#[^\n]*/g, "")
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/'''[\s\S]*?'''/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "");
  while ((m = numRe.exec(stripped)) !== null) {
    const v = Number(m[0].replace(/_/g, ""));
    if (Number.isFinite(v) && !allow.has(v)) h.magicNumber = (h.magicNumber ?? 0) + 1;
  }
  // Empty except blocks.
  for (const n of walkNamed(root)) {
    if (n.type === "except_clause") {
      let body: TSNode | null = null;
      for (const c of n.children) {
        if (c.type === "block") { body = c; break; }
      }
      if (body && body.namedChildren.length === 0) h.emptyCatch = (h.emptyCatch ?? 0) + 1;
    }
  }
  return h;
}

/** Detect type annotations in source. */
function pyHasTypes(root: TSNode): boolean {
  for (const n of walkNamed(root)) {
    if (n.type === "typed_parameter" || n.type === "typed_default_parameter" || n.type === "type_annotation" || n.type === "type") return true;
  }
  return false;
}

/** Count lines. */

/** Real-parser Python adapter entry. */
export function analyzePython(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  if (!hasTreeSitter()) return analyzePythonFallback(filePath, source);
  const root = parseWithTreeSitter("tree-sitter-python", source);
  if (!root) return analyzePythonFallback(filePath, source);
  const lineCount = countLines(source);
  const fns = collectPyFunctions(root, filePath, source);
  const imports = collectPyImports(root, source);
  const exports = collectPyExports(root, source, filePath);
  const health = countPyHealth(root, source);
  const tokenStream = tokenizeSubtreeWithSource(root, source);
  const hasType = pyHasTypes(root);
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

import type { TSNode } from "./tree-sitter-base.ts";
import { countLines, computeTypedFraction } from "../language-helpers.ts";
