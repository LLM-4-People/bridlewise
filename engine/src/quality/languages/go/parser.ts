/**
 * Go parser — tree-sitter real AST (EXP368).
 *
 * Replaces EXP357's regex+brace tokenizer with tree-sitter's real Go grammar.
 * Extracts:
 * - `func` declarations (top-level and methods)
 * - `type`/`struct`/`interface`/alias declarations
 * - `import` blocks and single imports (with alias handling)
 * - complexity per function
 *
 * Exportedness in Go is by capitalization (identifier starts with uppercase).
 *
 * NOTE: uses `firstNamedChildOfType` (not `childForFieldName`) because
 * web-tree-sitter 0.22.x does not expose field names for the Go grammar.
 */

import type { ParsedFile, SymbolDef, ImportDef, ExportDef, CommentDef, SymbolKind } from "../../base.ts";
import { parseWithTreeSitter, type TreeNode } from "../shared/tree-sitter-loader.ts";
import { countBranchPoints, countLines, endLine as endLineOf, firstNamedChildOfType, maxNestingDepth, startLine, walkDescendants } from "../shared/tree-sitter-walker.ts";
import { lastSeg } from "../shared-helpers.ts";

function isExportedName(name: string): boolean {
  return name.length > 0 && name.charCodeAt(0) >= 65 && name.charCodeAt(0) <= 90;
}

function extractGoImports(root: TreeNode, push: (imp: ImportDef) => void, path: string): void {
  walkDescendants(root, (n) => {
    if (n.type !== "import_declaration") return;
    // An import_declaration may have an `import_spec_list` (block) or a single `import_spec`.
    for (const child of n.namedChildren) {
      if (child.type === "import_spec_list") {
        for (const spec of child.namedChildren) {
          if (spec.type === "import_spec") handleSpec(spec);
        }
      } else if (child.type === "import_spec") {
        handleSpec(child);
      }
    }
  });

  function handleSpec(spec: TreeNode) {
    // The path is the `interpreted_string_literal` child of `import_spec`.
    const pathNode = firstNamedChildOfType(spec, "interpreted_string_literal");
    if (!pathNode) return;
    const rawPath = pathNode.text.replace(/^"|"$/g, "");
    let name = "";
    let isBlank = false;
    let isDot = false;
    // The first named child (if not the string) is the alias: identifier, package_identifier, dot, or blank_identifier.
    for (const c of spec.namedChildren) {
      if (c === pathNode) continue;
      if (c.type === "package_identifier" || c.type === "identifier") {
        name = c.text;
      } else if (c.type === "dot") {
        name = ".";
        isDot = true;
      } else if (c.type === "blank_identifier") {
        name = "_";
        isBlank = true;
      }
      break; // only the first non-path child matters
    }
    if (!name) {
      let seg = lastSeg(rawPath, "/");
      if (/^v\d+/.test(seg)) {
        const parts = rawPath.split("/");
        name = parts[parts.length - 2] ?? seg;
      } else {
        name = seg;
      }
    }
    if (isBlank || isDot) {
      push({
        filePath: path,
        line: startLine(spec),
        names: [name],
        source: rawPath,
        isRelative: rawPath.startsWith("./") || rawPath.startsWith("../"),
        sideEffectImport: true,
      });
      return;
    }
    push({
      filePath: path,
      line: startLine(spec),
      names: [name],
      source: rawPath,
      isRelative: rawPath.startsWith("./") || rawPath.startsWith("../"),
      sideEffectImport: false,
    });
  }
}

export async function parseGo(path: string, content: string): Promise<ParsedFile> {
  const root = await parseWithTreeSitter(content, "go");
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const exports: ExportDef[] = [];
  const comments: CommentDef[] = [];
  const parseErrors: { filePath: string; line: number; message: string }[] = [];

  walkDescendants(root, (n) => {
    if (n.type === "comment") {
      comments.push({ filePath: path, line: startLine(n), text: n.text.replace(/^\/\//, "").trim(), kind: "line" });
    }
  });

  // Package declaration.
  walkDescendants(root, (n) => {
    if (n.type === "package_clause") {
      const pkg = firstNamedChildOfType(n, "package_identifier") ?? firstNamedChildOfType(n, "identifier");
      if (pkg) exports.push({ filePath: path, line: startLine(n), name: pkg.text, kind: "module" });
    }
  });

  extractGoImports(root, (imp) => imports.push(imp), path);

  walkDescendants(root, (n) => {
    if (n.type === "function_declaration" || n.type === "method_declaration") {
      // For functions, name is `identifier`; for methods, `field_identifier`.
      const nameNode = firstNamedChildOfType(n, "identifier") ?? firstNamedChildOfType(n, "field_identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const isMethod = n.type === "method_declaration";
      const bodyNode = firstNamedChildOfType(n, "block");
      const bodyText = bodyNode ? bodyNode.text : "";
      const end = endLineOf(n);
      const exported = isExportedName(name);
      // Go functions have one or two `parameter_list` nodes (receiver + params for methods).
      const paramLists = n.namedChildren.filter((c) => c.type === "parameter_list");
      let paramCount = 0;
      const paramsList = isMethod ? paramLists[1] : paramLists[0];
      if (paramsList) {
        for (const c of paramsList.namedChildren) {
          if (c.type === "parameter_declaration") paramCount += 1;
        }
      }
      const kind: SymbolKind = isMethod ? "method" : "function";
      symbols.push({
        name,
        kind,
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported,
        isDeclaration: true,
        isTraitImpl: false,
        cyclomaticComplexity: countBranchPoints(bodyText),
        maxNestingDepth: maxNestingDepth(bodyText),
        paramCount,
        bodyLines: end - startLine(n),
      });
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind });
      return;
    }
    if (n.type === "type_spec") {
      const nameNode = firstNamedChildOfType(n, "type_identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const typeNode = firstNamedChildOfType(n, "struct_type") ?? firstNamedChildOfType(n, "interface_type");
      let kind: SymbolKind = "type";
      if (typeNode) {
        if (typeNode.type === "struct_type") kind = "struct";
        else if (typeNode.type === "interface_type") kind = "interface";
      }
      const exported = isExportedName(name);
      const end = endLineOf(n);
      symbols.push({
        name,
        kind,
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported,
        isDeclaration: true,
        isTraitImpl: false,
        cyclomaticComplexity: 1,
        maxNestingDepth: 0,
        paramCount: 0,
        bodyLines: end - startLine(n),
      });
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind });
      return;
    }
    if (n.type === "type_alias") {
      const nameNode = firstNamedChildOfType(n, "type_identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const exported = isExportedName(name);
      const end = endLineOf(n);
      symbols.push({
        name,
        kind: "type",
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported,
        isDeclaration: true,
        isTraitImpl: false,
        cyclomaticComplexity: 1,
        maxNestingDepth: 0,
        paramCount: 0,
        bodyLines: end - startLine(n),
      });
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind: "type" });
      return;
    }
  });

  return {
    path,
    language: "go",
    content,
    loc: countLines(content),
    symbols,
    imports,
    exports,
    comments,
    parseErrors,
  };
}
