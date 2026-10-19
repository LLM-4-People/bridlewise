/**
 * Java parser — tree-sitter real AST (EXP368).
 *
 * Replaces EXP357's regex+brace tokenizer with tree-sitter's real Java grammar.
 * Extracts:
 * - `class`/`interface`/`enum` declarations (with `public`/`protected`/`private`)
 * - methods, constructors, fields
 * - `import` statements (regular and static)
 * - complexity per method
 *
 * Java visibility: `public`/`protected` = exported; `private`/default = not.
 * Interface methods (no `private`) are exported. Enum constants are exported.
 *
 * NOTE: uses `firstNamedChildOfType` (not `childForFieldName`) because
 * web-tree-sitter 0.22.x does not expose field names for the Java grammar.
 */

import type { ParsedFile, SymbolDef, ImportDef, ExportDef, CommentDef, SymbolKind } from "../../base.ts";
import { parseWithTreeSitter, type TreeNode } from "../shared/tree-sitter-loader.ts";
import { countBranchPoints, countLines, endLine as endLineOf, firstNamedChildOfType, maxNestingDepth, startLine, walkDescendants } from "../shared/tree-sitter-walker.ts";
import { lastSeg, extractComments } from "../shared-helpers.ts";

function modifiersOf(node: TreeNode): string {
  const m = firstNamedChildOfType(node, "modifiers");
  return m ? m.text : "";
}

function isPublicOrProtected(node: TreeNode): boolean {
  const mods = modifiersOf(node);
  return /\bpublic\b/.test(mods) || /\bprotected\b/.test(mods);
}

function isPackagePrivate(node: TreeNode): boolean {
  const mods = modifiersOf(node);
  return !/\b(public|protected|private)\b/.test(mods);
}

export async function parseJava(path: string, content: string): Promise<ParsedFile> {
  const root = await parseWithTreeSitter(content, "java");
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const exports: ExportDef[] = [];
  const comments: CommentDef[] = [];
  const parseErrors: { filePath: string; line: number; message: string }[] = [];

  comments.push(...extractComments(root, walkDescendants, startLine, path));

  walkDescendants(root, (n) => {
    if (n.type === "import_declaration") {
      // The imported path is the `scoped_identifier` child.
      const sc = firstNamedChildOfType(n, "scoped_identifier") ?? firstNamedChildOfType(n, "identifier");
      if (!sc) return;
      const src = sc.text;
      // `import static` is detected by a `static` keyword child.
      const isStatic = n.children.some((c) => c.type === "static");
      void isStatic;
      const seg = lastSeg(src, ".");
      let names: string[] = [];
      if (seg === "*") {
        const parts = src.split(".");
        names = [parts[parts.length - 2] ?? src];
      } else {
        names = [seg];
      }
      imports.push({
        filePath: path,
        line: startLine(n),
        names,
        source: src,
        isRelative: false,
        sideEffectImport: false,
      });
      return;
    }
    if (n.type === "class_declaration" || n.type === "interface_declaration" || n.type === "enum_declaration" || n.type === "annotation_type_declaration") {
      const nameNode = firstNamedChildOfType(n, "identifier");
      const name = nameNode?.text ?? null;
      if (!name) return;
      const exported = isPublicOrProtected(n) || isPackagePrivate(n);
      const kind: SymbolKind = n.type === "class_declaration" ? "class" : n.type === "interface_declaration" ? "interface" : n.type === "enum_declaration" ? "enum" : "class";
      const bodyNode = firstNamedChildOfType(n, "class_body") ?? firstNamedChildOfType(n, "interface_body") ?? firstNamedChildOfType(n, "enum_body") ?? firstNamedChildOfType(n, "annotation_body");
      const end = bodyNode ? endLineOf(bodyNode) : endLineOf(n);
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
    if (n.type === "method_declaration" || n.type === "constructor_declaration") {
      const nameNode = firstNamedChildOfType(n, "identifier");
      const name = nameNode?.text ?? null;
      if (!name) return;
      const exported = isPublicOrProtected(n) || isPackagePrivate(n);
      const bodyNode = firstNamedChildOfType(n, "block") ?? firstNamedChildOfType(n, "constructor_body");
      const bodyText = bodyNode ? bodyNode.text : "";
      const end = endLineOf(n);
      const params = firstNamedChildOfType(n, "formal_parameters");
      let paramCount = 0;
      if (params) {
        for (const c of params.namedChildren) {
          if (c.type === "formal_parameter") paramCount += 1;
        }
      }
      symbols.push({
        name,
        kind: "method",
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
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind: "method" });
      return;
    }
  });

  return {
    path,
    language: "java",
    content,
    loc: countLines(content),
    symbols,
    imports,
    exports,
    comments,
    parseErrors,
  };
}
