/**
 * C/C++ parser — tree-sitter real AST (EXP368).
 *
 * Replaces EXP357's regex+brace tokenizer with tree-sitter's real C/C++
 * grammars. Extracts:
 * - function definitions (real `function_definition` nodes)
 * - `struct`/`enum`/`union`/`class`/`typedef` definitions
 * - `#include` directives (marked `sideEffectImport: true` — see EXP368 Fix 2)
 * - complexity per function
 *
 * C/C++ has no language-level export control; exportedness is approximated
 * by "declared in a header file (.h/.hpp/.hxx/.hh)" → symbols in headers are
 * exported. `static` makes a function file-local (NOT exported).
 *
 * CRITICAL FIX (EXP357 100% FP): `#include` is a SIDE-EFFECT import. The
 * `unused-import` check skips these via `import.sideEffectImport = true`.
 * A separate `unused-header` check detects headers never `#include`'d.
 *
 * NOTE: uses `firstNamedChildOfType` (not `childForFieldName`) because
 * web-tree-sitter 0.22.x does not expose field names for the C/C++ grammars.
 */

import type { ParsedFile, SymbolDef, ImportDef, ExportDef, CommentDef, SymbolKind } from "../../base.ts";
import { parseWithTreeSitter, type TreeNode } from "../shared/tree-sitter-loader.ts";
import { countBranchPoints, countLines, endLine as endLineOf, firstNamedChildOfType, maxNestingDepth, startLine, walkDescendants } from "../shared/tree-sitter-walker.ts";

function isHeaderFile(path: string): boolean {
  return /\.(h|hpp|hxx|hh)$/.test(path.toLowerCase());
}

function lastSeg(p: string, sep: string): string {
  const idx = p.lastIndexOf(sep);
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function extractFunctionName(fnNode: TreeNode): string | null {
  // function_definition has a `function_declarator` child (the declarator).
  const decl = firstNamedChildOfType(fnNode, "function_declarator");
  if (!decl) {
    // Some C++ templates have the declarator inline. Fall back to first `identifier`.
    const id = firstNamedChildOfType(fnNode, "identifier");
    return id ? id.text : null;
  }
  // function_declarator's declarator is an `identifier` (or `scoped_identifier` for C++).
  const id = firstNamedChildOfType(decl, "identifier") ?? firstNamedChildOfType(decl, "scoped_identifier");
  return id ? id.text : null;
}

function extractParams(fnNode: TreeNode): number {
  const decl = firstNamedChildOfType(fnNode, "function_declarator");
  if (!decl) return 0;
  const params = firstNamedChildOfType(decl, "parameter_list");
  if (!params) return 0;
  let count = 0;
  for (const c of params.namedChildren) {
    if (c.type === "parameter_declaration") count += 1;
  }
  // `void` as the only parameter means zero parameters.
  if (count === 1) {
    const only = params.namedChildren[0];
    if (only && only.namedChildren.length === 1) {
      const t = only.namedChildren[0];
      if (t && t.type === "primitive_type" && t.text === "void") return 0;
    }
  }
  return count;
}

function hasStorageClassStatic(fnNode: TreeNode): boolean {
  // Check the function_definition's direct children for `storage_class_specifier` containing `static`.
  for (const c of fnNode.children) {
    if (c.type === "storage_class_specifier" && c.text.includes("static")) return true;
  }
  return false;
}

function isCppPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hxx") || lower.endsWith(".hh");
}

export async function parseC(path: string, content: string): Promise<ParsedFile> {
  const language = isCppPath(path) ? "cpp" : "c";
  const root = await parseWithTreeSitter(content, language);
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const exports: ExportDef[] = [];
  const comments: CommentDef[] = [];
  const parseErrors: { filePath: string; line: number; message: string }[] = [];

  const header = isHeaderFile(path);

  walkDescendants(root, (n) => {
    if (n.type === "comment") {
      comments.push({ filePath: path, line: startLine(n), text: n.text.replace(/^\/\//, "").trim(), kind: "line" });
    } else if (n.type === "raw_string_literal" || n.type === "comment") {
      // already handled
    }
  });
  // Block comments (tree-sitter-c uses `comment` for both; C++ may have `raw_string_literal`).
  walkDescendants(root, (n) => {
    if (n.type === "comment" && n.text.startsWith("/*")) {
      // Already added above as a line comment — replace it with block.
      const last = comments[comments.length - 1];
      if (last && last.line === startLine(n)) {
        comments.pop();
      }
      comments.push({ filePath: path, line: startLine(n), text: n.text.replace(/^\/\*/, "").replace(/\*\/$/, "").trim(), kind: "block" });
    }
  });

  // #include directives — SIDE-EFFECT imports.
  walkDescendants(root, (n) => {
    if (n.type !== "preproc_include") return;
    // The path is `system_lib_string` (for `<...>`) or `string_literal` (for `"..."`).
    const pathNode = firstNamedChildOfType(n, "system_lib_string") ?? firstNamedChildOfType(n, "string_literal");
    if (!pathNode) return;
    const raw = pathNode.text.replace(/[<>"]/g, "");
    if (!raw) return;
    const seg = lastSeg(raw, "/");
    imports.push({
      filePath: path,
      line: startLine(n),
      names: [seg],
      source: raw,
      isRelative: pathNode.text.startsWith('"'),
      sideEffectImport: true,
    });
  });

  // Functions, structs, enums, unions, typedefs.
  walkDescendants(root, (n) => {
    if (n.type === "function_definition") {
      const name = extractFunctionName(n);
      if (!name) return;
      const skipNames = new Set(["if", "for", "while", "switch", "return", "sizeof", "do", "else"]);
      if (skipNames.has(name)) return;
      const bodyNode = firstNamedChildOfType(n, "compound_statement");
      const bodyText = bodyNode ? bodyNode.text : "";
      const end = endLineOf(n);
      const isStatic = hasStorageClassStatic(n);
      const exported = header && !isStatic;
      symbols.push({
        name,
        kind: "function",
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported,
        isDeclaration: true,
        isTraitImpl: false,
        cyclomaticComplexity: countBranchPoints(bodyText),
        maxNestingDepth: maxNestingDepth(bodyText),
        paramCount: extractParams(n),
        bodyLines: end - startLine(n),
      });
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind: "function" });
      return;
    }
    if (n.type === "struct_specifier" || n.type === "union_specifier" || n.type === "enum_specifier" || n.type === "class_specifier") {
      const nameNode = firstNamedChildOfType(n, "type_identifier") ?? firstNamedChildOfType(n, "identifier");
      const name = nameNode?.text ?? null;
      if (!name) return;
      const kind: SymbolKind = n.type === "class_specifier" ? "class" : n.type === "enum_specifier" ? "enum" : "struct";
      const bodyNode = firstNamedChildOfType(n, "field_declaration_list");
      const end = bodyNode ? endLineOf(bodyNode) : endLineOf(n);
      symbols.push({
        name,
        kind,
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported: header,
        isDeclaration: true,
        isTraitImpl: false,
        cyclomaticComplexity: 1,
        maxNestingDepth: 0,
        paramCount: 0,
        bodyLines: end - startLine(n),
      });
      if (header) exports.push({ filePath: path, line: startLine(n), name, kind });
      return;
    }
    if (n.type === "type_definition") {
      // The name is the last `type_identifier` in the definition.
      let name: string | null = null;
      walkDescendants(n, (c) => {
        if (c.type === "type_identifier") name = c.text;
      });
      if (!name) return;
      const end = endLineOf(n);
      symbols.push({
        name,
        kind: "type",
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported: header,
        isDeclaration: true,
        isTraitImpl: false,
        cyclomaticComplexity: 1,
        maxNestingDepth: 0,
        paramCount: 0,
        bodyLines: end - startLine(n),
      });
      if (header) exports.push({ filePath: path, line: startLine(n), name, kind: "type" });
      return;
    }
  });

  return {
    path,
    language,
    content,
    loc: countLines(content),
    symbols,
    imports,
    exports,
    comments,
    parseErrors,
  };
}
