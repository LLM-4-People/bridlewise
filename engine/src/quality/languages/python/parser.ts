/**
 * Python parser — tree-sitter real AST (EXP368).
 *
 * Replaces EXP357's regex+indentation tokenizer with tree-sitter's real
 * Python grammar. Extracts:
 * - `def`/`async def` functions (with decorator awareness)
 * - `class` definitions (with bases)
 * - `import X` and `from X import a, b` statements
 * - module-level `__all__` exports
 * - complexity per function (branch-point counting over the body text)
 *
 * Python has no language-level export control; exportedness is by convention:
 * - Module-level names NOT starting with single `_` are "exported"
 * - `__all__` (if present) overrides — only listed names are exported
 * - Methods (indented inside a class) are NEVER exported
 *
 * NOTE: uses `firstNamedChildOfType` (not `childForFieldName`) because
 * web-tree-sitter 0.22.x does not expose field names for the Python grammar.
 */

import type { ParsedFile, SymbolDef, ImportDef, ExportDef, CommentDef, SymbolKind } from "../../base.ts";
import { parseWithTreeSitter, type TreeNode } from "../shared/tree-sitter-loader.ts";
import { countBranchPoints, countLines, endLine as endLineOf, firstNamedChildOfType, maxNestingDepth, startLine, walkDescendants } from "../shared/tree-sitter-walker.ts";

function isModuleLevel(node: TreeNode): boolean {
  let n: TreeNode | null = node.parent;
  while (n !== null) {
    if (n.type === "function_definition" || n.type === "class_definition") return false;
    n = n.parent;
  }
  return true;
}

function extractFunctionName(node: TreeNode): string | null {
  // function_definition has `identifier` (the name) and `block` (the body).
  // In tree-sitter-python, the first `identifier` child is the name.
  for (const c of node.namedChildren) {
    if (c.type === "identifier") return c.text;
  }
  return null;
}

function extractParams(node: TreeNode): number {
  // `parameters` node has `identifier`, `default_parameter`, `typed_parameter`, etc.
  const params = firstNamedChildOfType(node, "parameters");
  if (!params) return 0;
  let count = 0;
  for (const c of params.namedChildren) {
    if (c.type === "identifier" || c.type === "default_parameter" || c.type === "typed_parameter" || c.type === "typed_default_parameter" || c.type === "list_splat_pattern" || c.type === "dictionary_splat_pattern" || c.type === "keyword_separator") {
      count += 1;
    }
  }
  return count;
}

function isDunder(name: string): boolean {
  return name.startsWith("__") && name.endsWith("__");
}

function isPrivate(name: string): boolean {
  return name.startsWith("_") && !name.startsWith("__");
}

/** Extract the dotted-name text from an `import_statement`'s `dotted_name`
 * or `aliased_name` child. Returns { source, importedName } where
 * importedName is the alias (if `as`) or the first segment of the dotted name. */
function extractImportStatement(n: TreeNode): { source: string; importedName: string } {
  // `import a.b.c` → first `dotted_name` child.
  // `import a.b.c as x` → `aliased_name` wraps the dotted name.
  const aliased = firstNamedChildOfType(n, "aliased_name");
  if (aliased) {
    // aliased_name has children: `dotted_name` + `as` + `identifier`. Get the dotted name (source) and the last identifier (alias).
    const dotted = firstNamedChildOfType(aliased, "dotted_name");
    const source = dotted ? dotted.text : "";
    const idents = aliased.namedChildren.filter((c) => c.type === "identifier");
    const importedName = idents[idents.length - 1]?.text ?? source.split(".").pop() ?? source;
    return { source, importedName };
  }
  const dotted = firstNamedChildOfType(n, "dotted_name");
  const source = dotted ? dotted.text : "";
  const importedName = source.split(".")[0] ?? source;
  return { source, importedName };
}

export async function parsePython(path: string, content: string): Promise<ParsedFile> {
  const root = await parseWithTreeSitter(content, "python");
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const exports: ExportDef[] = [];
  const comments: CommentDef[] = [];
  const parseErrors: { filePath: string; line: number; message: string }[] = [];

  // Comments (tree-sitter-python exposes comments as `comment` nodes).
  walkDescendants(root, (n) => {
    if (n.type === "comment") {
      comments.push({
        filePath: path,
        line: startLine(n),
        text: n.text.replace(/^#/, "").trim(),
        kind: "line",
      });
    }
  });

  // First pass: detect `__all__` if present (overrides exportedness).
  const allExports = new Set<string>();
  walkDescendants(root, (n) => {
    if (n.type !== "assignment") return;
    const lhs = n.namedChildren[0];
    if (!lhs || lhs.type !== "identifier" || lhs.text !== "__all__") return;
    const rhs = n.namedChildren.find((x) => x.type === "list" || x.type === "tuple");
    if (!rhs) return;
    for (const s of rhs.namedChildren) {
      if (s.type === "string") {
        const txt = s.text.replace(/^['"]|['"]$/g, "");
        if (txt) allExports.add(txt);
      }
    }
  });

  // Second pass: extract function/class/import definitions.
  walkDescendants(root, (n) => {
    if (n.type === "import_statement") {
      const { source, importedName } = extractImportStatement(n);
      imports.push({
        filePath: path,
        line: startLine(n),
        names: [importedName],
        source,
        isRelative: source.startsWith("."),
        sideEffectImport: source === "__future__",
      });
      return;
    }
    if (n.type === "import_from_statement") {
      // `from X import a, b` — the module is the first `dotted_name`; the
      // imported names are the remaining `dotted_name`/`aliased_name` children.
      const modNode = firstNamedChildOfType(n, "dotted_name");
      const src = modNode ? modNode.text : "";
      const names: string[] = [];
      for (const c of n.namedChildren) {
        if (c.type === "dotted_name") {
          if (c === modNode) continue; // skip the module name
          const last = c.namedChildren.length > 0 ? c.namedChildren[c.namedChildren.length - 1] : null;
          names.push(last && last.type === "identifier" ? last.text : c.text.split(".").pop() ?? c.text);
        } else if (c.type === "aliased_name") {
          const idents = c.namedChildren.filter((x) => x.type === "identifier");
          names.push(idents[idents.length - 1]?.text ?? "");
        } else if (c.type === "wildcard_import") {
          names.push("*");
        }
      }
      imports.push({
        filePath: path,
        line: startLine(n),
        names: names.filter((x) => x.length > 0),
        source: src,
        isRelative: src.startsWith("."),
        sideEffectImport: src === "__future__",
      });
      return;
    }
    if (n.type === "function_definition") {
      const name = extractFunctionName(n);
      if (!name) return;
      const moduleLevel = isModuleLevel(n);
      const privateName = isPrivate(name);
      const dunder = isDunder(name);
      const exported = allExports.size > 0
        ? allExports.has(name) && moduleLevel
        : moduleLevel && !privateName && !dunder;
      const bodyNode = firstNamedChildOfType(n, "block");
      const bodyText = bodyNode ? bodyNode.text : "";
      const end = endLineOf(n);
      const kind: SymbolKind = moduleLevel ? "function" : "method";
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
        paramCount: extractParams(n),
        bodyLines: end - startLine(n),
      });
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind });
      return;
    }
    if (n.type === "class_definition") {
      const name = extractFunctionName(n);
      if (!name) return;
      const moduleLevel = isModuleLevel(n);
      const privateName = isPrivate(name);
      const exported = allExports.size > 0
        ? allExports.has(name) && moduleLevel
        : moduleLevel && !privateName;
      const bodyNode = firstNamedChildOfType(n, "block");
      const end = bodyNode ? endLineOf(bodyNode) : endLineOf(n);
      symbols.push({
        name,
        kind: "class",
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
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind: "class" });
      return;
    }
  });

  return {
    path,
    language: "python",
    content,
    loc: countLines(content),
    symbols,
    imports,
    exports,
    comments,
    parseErrors,
  };
}
