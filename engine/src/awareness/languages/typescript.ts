/**
 * TypeScript/JavaScript adapter — the only adapter that uses a real
 * parser (@babel/parser, already a dependency). It walks the AST to
 * collect functions, imports, exports, complexity, type annotations,
 * and code-health signals.
 *
 * The adapter returns the per-file fields that `FileAnalysis` requires
 * minus `filePath`/`languageId`/`contentHash` (the engine fills those).
 */
import { parse } from "@babel/parser";
import { handleError } from "../../shared/debug/debug-system.ts";

/** Normalize a token: lowercase identifiers, drop pure-punctuation. */
// (unused — kept for future use; see tokenizeForEntropy / tokenizeForBody)
// function normalizeToken(kind: string, value: string): string | null {... }

/** Tokenize for entropy/clones — walk AST node types + identifier names. */
function tokenizeForEntropy(ast: import("@babel/types").File): string[] {
  const out: string[] = [];
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== "object" || typeof node.type !== "string") continue;
    out.push(node.type.toLowerCase());
    if (node.type === "Identifier" && typeof node.name === "string") out.push(node.name.toLowerCase());
    if (node.type === "StringLiteral" && typeof node.value === "string") out.push("lit_str");
    if (node.type === "NumericLiteral" && typeof node.value === "number") out.push("lit_num");
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type" || key === "range" || key === "errors" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") stack.push(v);
    }
  }
  return out;
}

/** Cyclomatic complexity from AST: 1 + number of decision points. */
function cyclomaticComplexity(node: import("@babel/types").Node): number {
  let c = 1;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const n = stack.pop() as Record<string, unknown> | null;
    if (!n || typeof n !== "object" || typeof n.type !== "string") continue;
    switch (n.type) {
      case "IfStatement": case "ConditionalExpression": case "ForStatement": case "ForInStatement":
      case "ForOfStatement": case "WhileStatement": case "DoWhileStatement": case "SwitchCase":
      case "LogicalExpression": case "CatchClause": case "OptionalCallExpression": case "OptionalMemberExpression":
        c += 1; break;
      case "ArrayPattern":
        // rest element in destructuring adds a branch
        break;
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type" || key === "range" || key === "errors" || key === "comments") continue;
      const v = n[key];
      if (Array.isArray(v)) for (const c2 of v) stack.push(c2);
      else if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") stack.push(v);
    }
  }
  return c;
}

/** Collect function-like nodes from the AST. */
function collectFunctions(ast: import("@babel/types").File) {
  const out: Array<{ filePath: string; name: string; line: number; bodyLines: number; bodyChars: number; tokens: string[]; complexity: number; typedParameters: number; parameterCount: number; hasReturnAnnotation: boolean }> = [];
  const visit = (node: unknown, parentName: string | null) => {
    if (!node || typeof node !== "object" || typeof (node as { type?: unknown }).type !== "string") return;
    const n = node as Record<string, unknown>;
    let name: string | null = null;
    let params: unknown[] | null = null;
    let returnType: unknown | null = null;
    let body: unknown | null = null;
    let loc: unknown = null;
    let isFunction = false;
    switch (n.type) {
      case "FunctionDeclaration":
      case "FunctionExpression": {
        const id = n.id as { name?: string } | null | undefined;
        name = id?.name ?? parentName ?? "<anonymous>";
        params = n.params as unknown[] | null;
        returnType = n.returnType ?? null;
        body = n.body ?? null;
        loc = n.loc ?? null;
        isFunction = true;
        break;
      }
      case "ArrowFunctionExpression": {
        name = parentName ?? "<anonymous>";
        params = n.params as unknown[] | null;
        returnType = n.returnType ?? null;
        body = n.body ?? null;
        loc = n.loc ?? null;
        isFunction = true;
        break;
      }
      case "ClassMethod":
      case "ObjectMethod": {
        const key = n.key as { name?: string; value?: string } | null | undefined;
        name = (key?.name ?? (key?.value !== undefined ? String(key.value) : null)) ?? parentName ?? "<anonymous>";
        params = n.params as unknown[] | null;
        returnType = n.returnType ?? null;
        body = n.body ?? null;
        loc = n.loc ?? null;
        isFunction = true;
        break;
      }
    }
    if (isFunction && body && loc) {
      const l = loc as { start: { line: number; column: number }; end: { line: number; column: number } };
      const bodyLoc = (body as { loc?: { start: { line: number }; end: { line: number } } }).loc;
      const bodyNode = body as { start?: number; end?: number };
      const bodyLines = bodyLoc ? Math.max(0, bodyLoc.end.line - bodyLoc.start.line) : 0;
      // bodyChars: prefer byte offsets (always present from @babel/parser) over the
      // buggy column-difference formula, which returned 0 for every multi-line body
      // and made clones=0 on babel/typescript (EXP361's bug). This matches the D3
      // detector's bodySize = content.slice(start, end).length semantics.
      const bodyStartOff = typeof bodyNode.start === "number" ? bodyNode.start : 0;
      const bodyEndOff = typeof bodyNode.end === "number" ? bodyNode.end : bodyStartOff;
      const bodyChars = Math.max(0, bodyEndOff - bodyStartOff);
      let typedParameters = 0;
      let parameterCount = 0;
      if (Array.isArray(params)) {
        for (const p of params) {
          parameterCount += 1;
          if (p && typeof p === "object" && typeof (p as { typeAnnotation?: unknown }).typeAnnotation !== "undefined") typedParameters += 1;
        }
      }
      const complexity = cyclomaticComplexity(body as import("@babel/types").Node);
      // Tokens for the function body (normalized) — used for clone detection + entropy.
      const tokens = tokenizeForBody(body as import("@babel/types").Node);
      out.push({ filePath: "", name: name ?? "<anonymous>", line: l.start.line, bodyLines, bodyChars, tokens, complexity, typedParameters, parameterCount, hasReturnAnnotation: returnType !== null && returnType !== undefined });
    }
    // Recurse into children.
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type" || key === "range" || key === "errors" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const v = n[key];
      if (Array.isArray(v)) for (const c2 of v) visit(c2, name ?? null);
      else if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") visit(v, name ?? null);
    }
  };
  visit(ast, null);
  return out;
}

/** Tokenize a function body for clone detection (normalized identifiers + literals). */
function tokenizeForBody(body: import("@babel/types").Node): string[] {
  const out: string[] = [];
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== "object" || typeof node.type !== "string") continue;
    const t = node.type;
    if (t === "Identifier" && typeof node.name === "string") out.push(node.name.toLowerCase());
    else if (t === "StringLiteral") out.push("lit_str");
    else if (t === "NumericLiteral") out.push("lit_num");
    else if (t === "TemplateLiteral") out.push("lit_str");
    else if (t === "BooleanLiteral") out.push(node.value === true ? "lit_true" : "lit_false");
    else if (t === "NullLiteral") out.push("lit_null");
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type" || key === "range" || key === "errors" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") stack.push(v);
    }
  }
  return out;
}

/** Collect imports. */
function collectImports(ast: import("@babel/types").File) {
  const out: Array<{ filePath: string; specifier: string; importedNames: string[]; resolvedPath: string | null }> = [];
  for (const n of ast.program.body) {
    if (n.type === "ImportDeclaration" && typeof n.source.value === "string") {
      const names: string[] = [];
      for (const s of n.specifiers) {
        if (s.type === "ImportDefaultSpecifier" && s.local?.name) names.push(s.local.name);
        else if (s.type === "ImportNamespaceSpecifier" && s.local?.name) names.push(s.local.name);
        else if (s.type === "ImportSpecifier" && s.local?.name) names.push(s.local.name);
      }
      out.push({ filePath: "", specifier: n.source.value, importedNames: names, resolvedPath: null });
    } else if (n.type === "ExportNamedDeclaration" && n.source && typeof n.source.value === "string") {
      const names: string[] = [];
      for (const s of n.specifiers ?? []) {
        if (s.type === "ExportSpecifier" && s.local?.name) names.push(s.local.name);
      }
      out.push({ filePath: "", specifier: n.source.value, importedNames: names, resolvedPath: null });
    }
  }
  return out;
}

/** Collect exports. */
function collectExports(ast: import("@babel/types").File) {
  const out: Array<{ filePath: string; name: string; isDefault: boolean }> = [];
  for (const n of ast.program.body) {
    if (n.type === "ExportDefaultDeclaration") {
      const declName = (n.declaration as { name?: string } | null | undefined)?.name ?? "default";
      out.push({ filePath: "", name: declName, isDefault: true });
    } else if (n.type === "ExportNamedDeclaration") {
      if (n.declaration) {
        const d = n.declaration as { type?: string; id?: { name?: string } | null; declarations?: Array<{ id?: { name?: string } }> };
        if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration" || d.type === "TypeAlias" || d.type === "InterfaceDeclaration" || d.type === "EnumDeclaration") {
          if (d.id?.name) out.push({ filePath: "", name: d.id.name, isDefault: false });
        } else if (d.type === "VariableDeclaration" && Array.isArray(d.declarations)) {
          for (const dd of d.declarations) if (dd.id?.name) out.push({ filePath: "", name: dd.id.name, isDefault: false });
        }
      }
      for (const s of n.specifiers ?? []) {
        if (s.type === "ExportSpecifier" && s.local?.name) out.push({ filePath: "", name: s.local.name, isDefault: false });
      }
    }
  }
  return out;
}

/** Count code-health issues. */
function countHealth(ast: import("@babel/types").File, source: string, commentPrefixes: readonly string[]): Record<string, number> {
  const h: Record<string, number> = {
    todo: 0, emptyCatch: 0, magicNumber: 0, deadCode: 0, missingDefault: 0,
  };
  // TODO/FIXME comments — scan comments (Babel attaches them).
  const comments = (ast.comments ?? []).concat(ast.program.innerComments ?? []);
  for (const c of comments) {
    const text = c.value;
    if (/\b(TODO|FIXME|HACK|XXX|BUG)\b/.test(text)) h.todo = (h.todo ?? 0) + 1;
  }
  // Empty catch blocks.
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== "object" || typeof node.type !== "string") continue;
    if (node.type === "CatchClause") {
      const body = node.body as { body?: unknown[] } | null | undefined;
      if (body && Array.isArray(body.body) && body.body.length === 0) h.emptyCatch = (h.emptyCatch ?? 0) + 1;
    }
    if (node.type === "SwitchStatement") {
      const cases = node.cases as Array<{ test?: unknown }> | null | undefined;
      if (Array.isArray(cases) && cases.length > 1) {
        const hasDefault = cases.some(c => c.test === null);
        if (!hasDefault) h.missingDefault = (h.missingDefault ?? 0) + 1;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type" || key === "range" || key === "errors" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") stack.push(v);
    }
  }
  // Magic numbers (approximation — scan tokens).
  const allow = new Set<number>([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5]);
  const lines = source.split("\n");
  const numRe = /\b0x[0-9a-fA-F]+\b|\b0b[01]+\b|\b0o[0-7]+\b|-?\b\d+(?:\.\d+)?\b/g;
  for (const line of lines) {
    if (commentPrefixes.some(p => line.trim().startsWith(p))) continue;
    let m: RegExpExecArray | null;
    numRe.lastIndex = 0;
    while ((m = numRe.exec(line)) !== null) {
      const v = Number(m[0]);
      if (Number.isFinite(v) && !allow.has(v)) h.magicNumber = (h.magicNumber ?? 0) + 1;
    }
  }
  return h;
}

/** Count lines. */

/** Detect type annotations in source (rough — counts `: Type` patterns, type/interface declarations, and `as Type` assertions). */
function hasTypeAnnotations(source: string): boolean {
  // TS interface/type declarations.
  if (/^\s*(export\s+)?(declare\s+)?(type|interface)\s+\w/m.test(source)) return true;
  // Parameter or variable annotations: `: <identifier>` (any case — `: number`, `: string`, `: MyType`, `: Array<...>`).
  if (/:\s*[A-Za-z_$]/.test(source)) return true;
  // Return-type annotations: `: <identifier>` is already covered above; this catches `): Type {` and `): Type =>`.
  if (/\)\s*:\s*[A-Za-z_$]/.test(source)) return true;
  // `as Type` / `satisfies Type` assertions.
  if (/\b(as|satisfies)\s+[A-Z]\w/m.test(source)) return true;
  return false;
}

/** Compute typedParameterFraction from a file's functions. */
function typedParameterFraction(fns: ReturnType<typeof collectFunctions>): number {
  let total = 0;
  let typed = 0;
  for (const f of fns) {
    total += f.parameterCount;
    typed += f.typedParameters;
  }
  if (total === 0) return 0;
  return typed / total;
}

/** Main entry. */
export function analyzeTypeScript(filePath: string, source: string): Omit<FileAnalysis, "filePath" | "languageId" | "contentHash"> {
  let ast: import("@babel/types").File | null = null;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript", "decorators-legacy", "jsx"], errorRecovery: true });
  } catch (e) {
    // Parse failure — route through the debug owner (visible when debug on)
    // and return a minimal analysis (R48 — was a bare `catch {}`).
    handleError(e, { module: "awareness-typescript", operation: "parse" });
    return {
      lineCount: countLines(source),
      hasTypeAnnotations: false,
      typedParameterFraction: 0,
      functions: [],
      imports: [],
      exports: [],
      health: { todo: 0, emptyCatch: 0, magicNumber: 0, deadCode: 0, missingDefault: 0, parseError: 1 },
      tokenStream: [],
    };
  }
  const fns = collectFunctions(ast);
  const imports = collectImports(ast);
  const exports = collectExports(ast);
  const health = countHealth(ast, source, ["//", "/*", "*"]);
  const tokenStream = tokenizeForEntropy(ast);
  const lineCount = countLines(source);
  const hasType = hasTypeAnnotations(source);
  const typedFraction = typedParameterFraction(fns);
  // Fill in filePath on functions/imports/exports.
  for (const f of fns) f.filePath = filePath;
  for (const i of imports) i.filePath = filePath;
  for (const e of exports) e.filePath = filePath;
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

// FileAnalysis is imported via the type import above; we re-export it for ergonomics.
import type { FileAnalysis } from "../types.ts";
import { countLines } from "../language-helpers.ts";
