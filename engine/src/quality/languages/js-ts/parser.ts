/**
 * JS/TS parser — uses @babel/parser for a real AST (EXP368, refactored).
 *
 * Reuses the existing D3 ast-helpers (`babelParserPluginsForSourcePath`) so
 * plugin selection stays consistent across the harness. babel is already a
 * real-AST parser, so we keep it (tree-sitter is used for python/rust/go/
 * java/c-cpp). Mirrors EXP349's `codebase-quality-pack.ts` extraction logic
 * but emits the language-agnostic `ParsedFile` shape.
 *
 * NOTE: synchronous (babel is sync). The other language parsers return
 * `Promise<ParsedFile>`; this one returns `ParsedFile`. The language
 * registry wraps it in `Promise.resolve` for a uniform async interface.
 */

import { parse } from "@babel/parser";

import type {
  CommentDef,
  ExportDef,
  ImportDef,
  ParsedFile,
  SymbolDef,
  SymbolKind,
} from "../../base.ts";
import {
  astChildren,
  astNode,
  astNodeArray,
  babelParserPluginsForSourcePath,
  type AstNode,
} from "../../../quality-packs/prevention/ast-helpers.ts";
import { countBranchPoints, countLines, maxNestingDepth } from "../shared/tree-sitter-walker.ts";

function identName(node: AstNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") {
    const name = node.name as unknown;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function locStartLine(node: AstNode): number {
  const loc = node.loc as { start?: { line?: number } } | undefined;
  return loc?.start?.line ?? 1;
}

function locEndLine(node: AstNode): number {
  const loc = node.loc as { end?: { line?: number } } | undefined;
  return loc?.end?.line ?? locStartLine(node);
}

interface FnCtx {
  name: string;
  kind: SymbolKind;
  line: number;
  bodyText: string;
  endLine: number;
  paramCount: number;
  exported: boolean;
  /** True for FunctionDeclaration / ClassDeclaration (a binding in the
   * enclosing scope). False for FunctionExpression / ArrowFunctionExpression
   * / ClassExpression (a value, not a binding — the name is internal to the
   * function body, not the file scope). The dead-private-function check
   * only considers declarations; flagging an expression is always a FP. */
  isDeclaration: boolean;
  /** True for trait-impl methods (Rust `impl Trait for Type`). Always false
   * for JS/TS (no traits). */
  isTraitImpl: boolean;
}

/** Nodes whose direct children are exported (i.e., being inside one of these
 * is what makes a declaration "exported"). `Program` and `File` are NOT in
 * this set — a top-level `function foo` is NOT exported; only
 * `export function foo` or `export { foo }` is. The previous EXP368 code
 * listed `Program` and seeded the initial call with `true`, which caused
 * the dead-private-function check to skip ALL top-level functions even
 * when they were not exported (a false negative). */
const EXPORT_PROPAGATING = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
]);

function collectFunctions(node: AstNode, exported: boolean, lines: string[], out: FnCtx[]): void {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    const id = identName(astNode(node.id));
    const startLine = locStartLine(node);
    const endLine = locEndLine(node);
    const bodyText = lines.slice(startLine - 1, endLine).join("\n");
    const params = astNodeArray(node.params);
    out.push({
      name: id ?? "<anonymous>",
      kind: "function",
      line: startLine,
      bodyText,
      endLine,
      paramCount: params.length,
      exported,
      isDeclaration: node.type === "FunctionDeclaration",
      isTraitImpl: false,
    });
  }
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    const id = identName(astNode(node.id));
    const startLine = locStartLine(node);
    const endLine = locEndLine(node);
    out.push({
      name: id ?? "<anonymous>",
      kind: "class",
      line: startLine,
      bodyText: "",
      endLine,
      paramCount: 0,
      exported,
      isDeclaration: node.type === "ClassDeclaration",
      isTraitImpl: false,
    });
  }
  for (const child of astChildren(node)) {
    const childExported = exported || EXPORT_PROPAGATING.has(node.type);
    collectFunctions(child, childExported, lines, out);
  }
}

export function parseJsTs(path: string, content: string, isTs: boolean): ParsedFile {
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const exports: ExportDef[] = [];
  const comments: CommentDef[] = [];
  const parseErrors: { filePath: string; line: number; message: string }[] = [];

  const lines = content.split("\n");

  let ast: AstNode | null = null;
  try {
    const basePlugins = babelParserPluginsForSourcePath(path);
    const plugins = [...basePlugins, "decorators-legacy", "decoratorAutoAccessors", "importAttributes"];
    ast = parse(content, {
      plugins: plugins as never,
      errorRecovery: true,
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    }) as unknown as AstNode;
  } catch (err) {
    parseErrors.push({
      filePath: path,
      line: 1,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (ast) {
    // EXP386 fix: @babel/parser stores comments on `ast.comments` (a top-
    // level File node field), NOT on `ast.extra.comments`. The previous
    // EXP368 code looked at `ast.extra.comments`, which is always undefined
    // — every comment (including TODOs) was silently dropped, so the
    // todo-comment check never fired on JS/TS code. Also accept
    // `ast.program.comments` as a fallback for older parser versions.
    const astFile = ast as unknown as { comments?: unknown[]; program?: { comments?: unknown[] } };
    const astComments = Array.isArray(astFile.comments)
      ? (astFile.comments as AstNode[])
      : Array.isArray(astFile.program?.comments)
        ? (astFile.program!.comments as AstNode[])
        : [];
    for (const c of astComments) {
      const value = c.value as unknown;
      if (typeof value === "string") {
        comments.push({
          filePath: path,
          line: locStartLine(c),
          text: value.trim(),
          kind: c.type === "CommentLine" ? "line" : "block",
        });
      }
    }

    function walkTopLevel(node: AstNode): void {
      if (node.type === "ImportDeclaration") {
        const specifiers = astNodeArray(node.specifiers);
        const names: string[] = [];
        for (const spec of specifiers) {
          if (spec.type === "ImportSpecifier" || spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
            const local = identName(astNode(spec.local));
            if (local) names.push(local);
          }
        }
        const sourceNode = astNode(node.source);
        const sourceVal = sourceNode ? (sourceNode.value as unknown) : undefined;
        const source = typeof sourceVal === "string" ? sourceVal : "";
        // `import "./x"` with no specifiers is a side-effect import.
        const sideEffectImport = names.length === 0;
        imports.push({
          filePath: path,
          line: locStartLine(node),
          names,
          source,
          isRelative: source.startsWith(".") || source.startsWith("/"),
          sideEffectImport,
        });
        return;
      }
      if (node.type === "ExportNamedDeclaration") {
        const declaration = astNode(node.declaration);
        const line = locStartLine(node);
        if (declaration) {
          if (declaration.type === "FunctionDeclaration") {
            const name = identName(astNode(declaration.id));
            if (name) exports.push({ filePath: path, line, name, kind: "function" });
          } else if (declaration.type === "ClassDeclaration") {
            const name = identName(astNode(declaration.id));
            if (name) exports.push({ filePath: path, line, name, kind: "class" });
          } else if (declaration.type === "VariableDeclaration") {
            for (const decl of astNodeArray(declaration.declarations)) {
              const id = astNode(decl.id);
              const name = identName(id);
              if (name) exports.push({ filePath: path, line, name, kind: "variable" });
            }
          }
        }
        for (const spec of astNodeArray(node.specifiers)) {
          const local = identName(astNode(spec.local));
          if (local) exports.push({ filePath: path, line, name: local, kind: "variable" });
        }
      }
      if (node.type === "ExportDefaultDeclaration") {
        const line = locStartLine(node);
        exports.push({ filePath: path, line, name: "default", kind: "variable" });
      }
      for (const child of astChildren(node)) walkTopLevel(child);
    }
    walkTopLevel(ast);

    const fns: FnCtx[] = [];
    collectFunctions(ast, false, lines, fns);
    for (const fn of fns) {
      symbols.push({
        name: fn.name,
        kind: fn.kind,
        filePath: path,
        line: fn.line,
        endLine: fn.endLine,
        exported: fn.exported,
        isDeclaration: fn.isDeclaration,
        isTraitImpl: fn.isTraitImpl,
        cyclomaticComplexity: countBranchPoints(fn.bodyText),
        maxNestingDepth: maxNestingDepth(fn.bodyText),
        paramCount: fn.paramCount,
        bodyLines: fn.endLine - fn.line,
      });
    }
  }

  return {
    path,
    language: isTs ? "typescript" : "javascript",
    content,
    loc: countLines(content),
    symbols,
    imports,
    exports,
    comments,
    parseErrors,
  };
}
