/**
 * Rust parser — tree-sitter real AST (EXP368).
 *
 * Replaces EXP357's regex+brace tokenizer with tree-sitter's real Rust
 * grammar. Extracts:
 * - `fn` functions (with `pub`/visibility detection)
 * - `struct`, `enum`, `trait`, `type` items
 * - `use` imports (single, scoped, grouped, aliased)
 * - complexity per function
 *
 * Exportedness in Rust = `pub` visibility modifier.
 */

import type { ParsedFile, SymbolDef, ImportDef, ExportDef, CommentDef, SymbolKind } from "../../base.ts";
import { parseWithTreeSitter, type TreeNode } from "../shared/tree-sitter-loader.ts";
import { countBranchPoints, countLines, endLine as endLineOf, firstNamedChildOfType, maxNestingDepth, startLine, walkDescendants } from "../shared/tree-sitter-walker.ts";
import { extractComments } from "../shared-helpers.ts";

function visibilityText(node: TreeNode): string | null {
  const v = firstNamedChildOfType(node, "visibility_modifier");
  return v ? v.text : null;
}

function isExported(node: TreeNode): boolean {
  return visibilityText(node)?.startsWith("pub") ?? false;
}

/** Detect trait-impl methods: `impl Trait for Type { fn method {} }`.
 * The impl_item has a `trait_type` (or `generic_type` wrapping a trait) when
 * it's a trait impl. Inherent impls (`impl Type {... }`) don't have a
 * `trait_type`. We check for the presence of `for` in the impl's text AND
 * the absence of a `visibility_modifier` (which would be unusual for trait
 * impls). The robust test: a `trait_type` named child = trait impl. */
function isTraitImplMethod(implNode: TreeNode): boolean {
  // impl_item children for `impl Trait for Type`: `trait_type`, `for_clause`,
  // `type_identifier` (or `generic_type`). For `impl Type`: just `type`.
  // Look for `trait_type` named child OR `for_clause`.
  const traitType = firstNamedChildOfType(implNode, "trait_type");
  if (traitType) return true;
  // tree-sitter-rust may name it differently; fall back to text scan.
  const txt = implNode.text;
  // The first 80 chars of `impl Trait for Type` contain `for ` after the
  // trait name. Inherent impls don't have `for` (just `impl Type {`).
  const head = txt.slice(0, 200);
  // Match `impl <something> for <Type>`. Avoid matching `for` inside a path
  // like `impl<a, b> Type` (generic params) — that doesn't have `for ` as a
  // keyword.
  return /\bimpl\b[^{]*\bfor\b[^{]*\{/.test(head);
}

/** Recursively collect names from a Rust `use` declaration.
 * Handles: `use a::b::c;`, `use a::b as d;`, `use a::{b, c};`, `use a::{b, c::{d, e}};`,
 * `use crate::Foo;`, `use self::bar;`. */
function collectUseNames(useNode: TreeNode): { names: string[]; source: string } {
  const names: string[] = [];
  let source = "";

  function handleScopedUseList(node: TreeNode, pathPrefix: string): void {
    // scoped_use_list = <path>::<use_list>
    // The path is the first named child that is NOT a use_list (e.g., `crate`,
    // `identifier`, `scoped_identifier`).
    let path = "";
    let useList: TreeNode | null = null;
    for (const c of node.namedChildren) {
      if (c.type === "use_list") { useList = c; continue; }
      // The path: `crate`, `identifier`, `scoped_identifier`, `self`, `super`.
      if (!path) {
        path = c.text;
      }
    }
    const fullPath = pathPrefix ? `${pathPrefix}::${path}` : path;
    if (!source) source = fullPath;
    if (!useList) return;
    for (const item of useList.namedChildren) {
      if (item.type === "identifier") {
        names.push(item.text);
      } else if (item.type === "use_as_clause") {
        // `a as b` — last identifier is the alias.
        const idents = item.namedChildren.filter((x) => x.type === "identifier");
        if (idents.length > 0) names.push(idents[idents.length - 1]!.text);
      } else if (item.type === "scoped_use_list") {
        // Nested: `values::{...}` — recurse with the path prefix.
        handleScopedUseList(item, fullPath);
      } else if (item.type === "scoped_identifier") {
        // `a::b` inside a use_list — push the last segment.
        const seg = item.text.split("::").pop() ?? "";
        if (seg) names.push(seg);
      } else if (item.type === "wildcard_import") {
        names.push("*");
      }
    }
  }

  for (const c of useNode.namedChildren) {
    if (c.type === "scoped_use_list") {
      handleScopedUseList(c, "");
    } else if (c.type === "use_as_clause") {
      // `a::b as c` — last identifier is the alias.
      const idents = c.namedChildren.filter((x) => x.type === "identifier" || x.type === "scoped_identifier");
      if (idents.length > 0) {
        const before = idents[0];
        if (before && !source) source = before.text;
        const last = idents[idents.length - 1];
        if (last) names.push(last.text);
      }
    } else if (c.type === "scoped_identifier") {
      // `use a::b::c;` — single path, last segment is the name.
      source = c.text;
      const seg = c.text.split("::").pop() ?? "";
      if (seg) names.push(seg);
    } else if (c.type === "identifier") {
      source = c.text;
      names.push(c.text);
    } else if (c.type === "wildcard_import") {
      names.push("*");
    } else if (c.type === "use_list") {
      // `use {a, b};` (rare, no path) — extract names directly.
      for (const item of c.namedChildren) {
        if (item.type === "identifier") names.push(item.text);
        else if (item.type === "use_as_clause") {
          const idents = item.namedChildren.filter((x) => x.type === "identifier");
          if (idents.length > 0) names.push(idents[idents.length - 1]!.text);
        }
      }
    }
  }
  return { names: names.filter((n) => n.length > 0 && n !== "*" && n !== "self" && n !== "crate" && n !== "super"), source };
}

export async function parseRust(path: string, content: string): Promise<ParsedFile> {
  const root = await parseWithTreeSitter(content, "rust");
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const exports: ExportDef[] = [];
  const comments: CommentDef[] = [];
  const parseErrors: { filePath: string; line: number; message: string }[] = [];

  comments.push(...extractComments(root, walkDescendants, startLine, path));

  walkDescendants(root, (n) => {
    if (n.type === "use_declaration") {
      const { names, source } = collectUseNames(n);
      // `pub use` is a re-export — the imported name is immediately made
      // public. It's NOT a "used import" (the name isn't referenced in the
      // file body); it's an API surface. Mark as side-effect so the
      // unused-import check skips it.
      const isPubUse = visibilityText(n)?.startsWith("pub") ?? false;
      imports.push({
        filePath: path,
        line: startLine(n),
        names,
        source,
        isRelative: source.startsWith("crate::") || source.startsWith("self::") || source.startsWith("super::"),
        sideEffectImport: isPubUse,
      });
      return;
    }
    if (n.type === "function_item" || n.type === "function_signature_item") {
      const nameNode = firstNamedChildOfType(n, "identifier");
      const name = nameNode?.text ?? null;
      if (!name) return;
      const exported = isExported(n);
      const bodyNode = firstNamedChildOfType(n, "block") ?? firstNamedChildOfType(n, "compound_statement");
      const bodyText = bodyNode ? bodyNode.text : "";
      const end = endLineOf(n);
      // Method detection: parent is an `impl_item`.
      const parent = n.parent;
      const implNode = parent?.type === "declaration_list" ? parent.parent : null;
      const isMethod = implNode?.type === "impl_item";
      const kind: SymbolKind = isMethod ? "method" : "function";
      // Trait-impl method detection: `impl Trait for Type { fn method {} }`.
      // The impl_item has a `trait_type` child (or `generic_type` wrapping a
      // trait). Methods of a trait impl are REQUIRED by the trait contract —
      // they are called via dynamic dispatch on the trait object, not via
      // direct name reference. Marking them `exported=true` would skip them
      // from dead-export (incorrect) but skip from dead-private (correct).
      // Use a separate `traitImpl` flag — the dead-private check skips these.
      const isTraitImpl = isMethod ? isTraitImplMethod(implNode!) : false;
      const params = firstNamedChildOfType(n, "parameters") ?? firstNamedChildOfType(n, "parameter_list");
      let paramCount = 0;
      if (params) {
        for (const c of params.namedChildren) {
          if (c.type === "parameter" || c.type === "self_parameter" || c.type === "variadic_parameter") paramCount += 1;
        }
      }
      symbols.push({
        name,
        kind,
        filePath: path,
        line: startLine(n),
        endLine: end,
        exported,
        isDeclaration: true,
        isTraitImpl,
        cyclomaticComplexity: countBranchPoints(bodyText),
        maxNestingDepth: maxNestingDepth(bodyText),
        paramCount,
        bodyLines: end - startLine(n),
      });
      if (exported) exports.push({ filePath: path, line: startLine(n), name, kind });
      return;
    }
    if (n.type === "struct_item" || n.type === "enum_item" || n.type === "trait_item" || n.type === "type_item" || n.type === "union_item") {
      const nameNode = firstNamedChildOfType(n, "type_identifier") ?? firstNamedChildOfType(n, "identifier");
      const name = nameNode?.text ?? null;
      if (!name) return;
      const exported = isExported(n);
      const kind: SymbolKind = n.type === "struct_item" ? "struct" : n.type === "enum_item" ? "enum" : n.type === "trait_item" ? "interface" : "type";
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
  });

  return {
    path,
    language: "rust",
    content,
    loc: countLines(content),
    symbols,
    imports,
    exports,
    comments,
    parseErrors,
  };
}
