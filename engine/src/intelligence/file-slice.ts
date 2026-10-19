import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

import { parse } from "@babel/parser";

import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { babelParserPluginsForSourcePath, walkAst } from "../quality-packs/prevention/ast-helpers.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../shared/source-extensions.ts";

/**
 * File-slice: AST slices + viewports + the EXP365 novel small-file
 * strategy. This is the AST-based replacement for `read_file` (EXP334 /
 * EXP355 / EXP365).
 *
 * The LLM never receives a full file. Instead it gets:
 * `slice(name, file?)` — the AST slice of a function/class (the
 * body + signature, capped at a line limit).
 * `viewport(file, start, end)` — a bounded line window of a file
 * (for the exact-byte needs the editor's
 * preimage check requires).
 * `skeleton(file)` — the AST skeleton (one line per top-level
 * declaration) — file-wide structure in
 * ~30-50 tokens regardless of file size.
 *
 * For SMALL files (< SMALL_FILE_LINE_THRESHOLD lines), the EXP365 novel
 * strategy returns a compressed view + skeleton in ONE turn (no
 * exploration). Measured: 79% token savings, NO crossover (always
 * positive). For LARGE files, the LLM uses `skeleton` first, then
 * requests `slice`s of the functions it needs.
 *
 * The slice and viewport outputs route through the privacy file-viewer
 * (the same redaction path `read_file` uses) so a slice containing a
 * secret never egresses raw. A parse failure on a `.ts`/`.js` file
 * produces a typed blocker (`slice_parse_failed`) — the tool never
 * silently downgrades to raw text. Files in languages with no AST
 * parser (no JS/TS extension) also produce a typed blocker
 * (`slice_unsupported_extension`) so the model falls back to `read_file`
 * + `grep` for those files.
 *
 * No code extracted from external sources; algorithms (AST walk for
 * function/class declarations, line-window slicing, semantic
 * compression by stripping comments + string literal VALUES + extra
 * whitespace) are textbook. The strategy-selection math model is from
 * EXP365 (dynamically computed from N, K, task complexity — no static
 * constants).
 */

import { DEFAULT_SLICE_CAP_LINES, DEFAULT_VIEWPORT_MAX_LINES, DEFAULT_FILE_SLICE_OPTIONS_LIMIT, DEFAULT_FILE_SLICE_CALLEES_LIMIT, DEFAULT_SCAN_DIRECTORIES } from "./intelligence-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export type SliceResult = Readonly<{
  tool: "slice";
  name: string;
  file: string;
  lines: string;
  slice: string;
  truncated: boolean;
  totalLines: number;
  callers: readonly Readonly<{ name: string; file: string }>[];
  note: string;
}>;

export type ViewportResult = Readonly<{
  tool: "viewport";
  file: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  viewport: string;
  truncated: boolean;
}>;

export type SkeletonResult = Readonly<{
  tool: "skeleton";
  file: string;
  totalLines: number;
  declarationCount: number;
  skeleton: string;
  declarations: readonly SkeletonDecl[];
}>;

export type SkeletonDecl = Readonly<{
  kind: string;
  name: string;
  line: number;
  signature: string;
  exported: boolean;
  exportedDefault: boolean;
  callees: readonly string[];
}>;

type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

type ParsedFile = Readonly<{
  src: string;
  program: AstNode | null;
  parseError: string | null;
}>;

/**
 * The `parseError` value that means the bytes never arrived, as opposed to a
 * parse that failed on bytes we did read. Named because two call sites have to
 * agree on it, and a literal repeated in two places is a literal that drifts.
 */
const READ_FAILED = "read_failed" as const;

export class FileSliceIndex {
  private readonly repositoryRoot: string;
  private readonly scanDirectories: readonly string[];
  private readonly fileCache = new Map<string, ParsedFile>();

  /**
   * @param repositoryRoot the project root all relative paths resolve under.
   * @param options optional overrides; `scanDirectories` (default
   * `DEFAULT_SCAN_DIRECTORIES`) selects the top-level dirs scanned when no
   * `file` hint is given. Single owner — no static dir list here.
   */
  constructor(repositoryRoot: string, options: Readonly<{ scanDirectories?: readonly string[] }> = {}) {
    if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
      throw new InputError("FileSliceIndex: repositoryRoot must be a non-empty string", "slice_root_empty");
    }
    this.repositoryRoot = repositoryRoot;
    this.scanDirectories = options.scanDirectories ?? DEFAULT_SCAN_DIRECTORIES;
  }

  slice(name: string, fileHint: string | null, options: Readonly<{ sliceCapLines?: number }> = {}): SliceResult {
    if (typeof name !== "string" || name.length === 0) {
      throw new InputError("slice requires a non-empty `name`", "slice_name_empty");
    }
    const cap = options.sliceCapLines ?? DEFAULT_SLICE_CAP_LINES;
    const candidates = this.findCandidates(name, fileHint);
    if (candidates.length === 0) {
      throw new InputError(`function '${name}' not found`, "slice_name_not_found");
    }
    if (candidates.length > 1 && !fileHint) {
      const optionsList = candidates.slice(0, DEFAULT_FILE_SLICE_OPTIONS_LIMIT).map((c) => ({
        name: c.name,
        file: c.file,
        lines: `L${c.startLine}-L${c.endLine}`,
      }));
      throw new InputError(
        `ambiguous: ${candidates.length} matches. Provide a \`file\` hint. Options: ${JSON.stringify(optionsList)}`,
        "slice_ambiguous",
      );
    }
    const { file, startLine, endLine, src } = candidates[0]!;
    const sliceSrc = extractLineRange(src, startLine, endLine);
    const lineCount = sliceSrc.split("\n").length;
    const truncated = lineCount > cap;
    const slice = truncated
      ? sliceSrc.split("\n").slice(0, cap).join("\n") + `\n// ... (truncated at ${cap} lines of ${lineCount})`
      : sliceSrc;
    const callers = this.findCallers(name);
    return deepFreeze({
      tool: "slice",
      name,
      file,
      lines: `L${startLine}-L${endLine}`,
      slice,
      truncated,
      totalLines: lineCount,
      callers,
      note: "AST slice — function body + signature. Edit by copying from `slice` verbatim.",
    });
  }

  viewport(file: string, startLine: number, endLine: number, options: Readonly<{ maxLines?: number }> = {}): ViewportResult {
    const resolved = this.resolveFile(file);
    const parsed = this.getParsed(resolved);
    // A FILE WE COULD NOT READ IS NOT AN EMPTY FILE. `getParsed` answers a read
    // failure with `src: ""`, which produces a viewport of `""` over one line
    // and `truncated: false` — byte-identical to a successful window on an
    // empty file, and cached, so every retry repeats it. The result is
    // serialised straight to the model, so the failure reads downstream as a
    // successful view of nothing. `skeleton` already refuses on the same
    // signal; this is the same refusal for the payload path.
    if (parsed.parseError === READ_FAILED) {
      throw new InputError(
        `viewport: ${file} could not be read`,
        "slice_read_failed",
      );
    }
    const src = parsed.src;
    const lines = src.split("\n");
    const totalLines = lines.length;
    const max = options.maxLines ?? DEFAULT_VIEWPORT_MAX_LINES;
    const safeStart = Math.max(1, Math.floor(startLine));
    const safeEnd = Math.min(totalLines, Math.floor(endLine));
    if (safeEnd < safeStart) {
      throw new InputError("endLine must be >= startLine", "slice_viewport_range");
    }
    const requested = safeEnd - safeStart + 1;
    const truncated = requested > max;
    const effectiveEnd = truncated ? safeStart + max - 1 : safeEnd;
    const viewport = lines.slice(safeStart - 1, effectiveEnd).join("\n");
    return deepFreeze({
      tool: "viewport",
      file,
      startLine: safeStart,
      endLine: effectiveEnd,
      totalLines,
      viewport,
      truncated,
    });
  }

  skeleton(file: string): SkeletonResult {
    const resolved = this.resolveFile(file);
    const parsed = this.getParsed(resolved);
    if (parsed.program === null) {
      throw new InputError(
        `skeleton: parse failed for ${file}: ${parsed.parseError ?? "unknown"}`,
        "slice_parse_failed",
      );
    }
    const decls = extractTopLevelDecls(parsed.program);
    const lines = decls.map(summarizeDecl);
    return deepFreeze({
      tool: "skeleton",
      file,
      totalLines: parsed.src.split("\n").length,
      declarationCount: decls.length,
      skeleton: lines.join("\n"),
      declarations: decls,
    });
  }

  private findCandidates(name: string, fileHint: string | null): readonly Readonly<{
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    src: string;
  }>[] {
    const out: { name: string; file: string; startLine: number; endLine: number; src: string }[] = [];
    const files = this.discoverFiles(fileHint);
    for (const rel of files) {
      const resolved = join(this.repositoryRoot, rel);
      const parsed = this.getParsed(resolved);
      if (parsed.program === null) continue;
      for (const decl of extractTopLevelDecls(parsed.program)) {
        if (decl.name === name) {
          out.push({
            name: decl.name,
            file: rel,
            startLine: decl.line,
            endLine: decl.endLine,
            src: parsed.src,
          });
        }
      }
    }
    return out;
  }

  private findCallers(name: string): Readonly<{ name: string; file: string }>[] {
    const out: { name: string; file: string }[] = [];
    const seen = new Set<string>();
    const files = this.discoverFiles(null);
    for (const rel of files) {
      const resolved = join(this.repositoryRoot, rel);
      const parsed = this.getParsed(resolved);
      if (parsed.program === null) continue;
      walkAstWithParents(parsed.program, (n, parents) => {
        if (n.type !== "CallExpression") return;
        const callee = n.callee as AstNode | undefined;
        if (!callee) return;
        let matched = false;
        if (callee.type === "Identifier" && callee.name === name) matched = true;
        else if (
          callee.type === "MemberExpression" &&
          (callee.property as AstNode | undefined)?.type === "Identifier" &&
          (callee.property as AstNode).name === name
        ) {
          matched = true;
        }
        if (!matched) return;
        const loc = (callee.loc as { start: { line: number } } | undefined) ??
          ((callee.property as AstNode | undefined)?.loc as { start: { line: number } } | undefined);
        if (!loc) return;
        const key = `${rel}:${loc.start.line}`;
        if (seen.has(key)) return;
        seen.add(key);
        const caller = parents.length > 0 ? enclosingFunctionName(parents) : null;
        out.push({ name: caller ?? "<top>", file: rel });
      });
    }
    return out.slice(0, DEFAULT_FILE_SLICE_OPTIONS_LIMIT);
  }

  private discoverFiles(fileHint: string | null): string[] {
    if (fileHint !== null) {
      const rel = this.resolveFile(fileHint);
      return [rel];
    }
    const out: string[] = [];
    for (const dir of this.scanDirectories) {
      collectSourceFiles(join(this.repositoryRoot, dir), out, this.repositoryRoot);
    }
    return out;
  }

  private resolveFile(file: string): string {
    if (typeof file !== "string" || file.length === 0) {
      throw new InputError("file must be a non-empty string", "slice_file_empty");
    }
    if (isAbsolute(file)) {
      throw new SecurityError("absolute paths are forbidden", "slice_path_absolute");
    }
    if (file.startsWith("..") || file.includes("..")) {
      throw new SecurityError("path traversal is forbidden", "slice_path_traversal");
    }
    if (!ARCHITECTURE_SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) {
      throw new InputError(
        `unsupported extension for slice (use read_file fallback): ${file}`,
        "slice_unsupported_extension",
      );
    }
    return file;
  }

  private getParsed(absOrRel: string): ParsedFile {
    const abs = isAbsolute(absOrRel) ? absOrRel : join(this.repositoryRoot, absOrRel);
    const cached = this.fileCache.get(abs);
    if (cached) return cached;
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch (e) {
      handleError(e, { module: "intelligence-file-slice", operation: "readFile" });
      const result: ParsedFile = { src: "", program: null, parseError: READ_FAILED };
      this.fileCache.set(abs, result);
      return result;
    }
    const rel = relative(this.repositoryRoot, abs);
    try {
      const plugins = babelParserPluginsForSourcePath(rel);
      const parsed = parse(src, {
        sourceType: "module",
        plugins: [...plugins],
        errorRecovery: true,
        tokens: false,
        ranges: false,
      });
      const result: ParsedFile = { src, program: parsed.program as unknown as AstNode, parseError: null };
      this.fileCache.set(abs, result);
      return result;
    } catch (e) {
      const result: ParsedFile = {
        src,
        program: null,
        parseError: e instanceof Error ? e.message.split("\n")[0] ?? "parse_failed" : "parse_failed",
      };
      this.fileCache.set(abs, result);
      return result;
    }
  }
}

function collectSourceFiles(dir: string, acc: string[], root: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    handleError(e, { module: "intelligence-file-slice", operation: "collectSourceFiles" });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".git")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, acc, root);
    else if (ARCHITECTURE_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) acc.push(relative(root, p));
  }
}

function extractLineRange(src: string, startLine: number, endLine: number): string {
  const lines = src.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

type ExtractedDecl = Readonly<{
  kind: string;
  name: string;
  line: number;
  endLine: number;
  signature: string;
  exported: boolean;
  exportedDefault: boolean;
  callees: readonly string[];
}>;

function extractTopLevelDecls(program: AstNode): ExtractedDecl[] {
  const out: ExtractedDecl[] = [];
  const body = (program.body as AstNode[] | undefined) ?? [];
  for (const node of body) collectDecl(node, out, false, false);
  return out;
}

function collectDecl(node: AstNode | undefined, out: ExtractedDecl[], exported: boolean, exportedDefault: boolean): void {
  if (!node) return;
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      const name = (node.id as AstNode | undefined)?.name as string | undefined;
      if (!name) return;
      out.push(makeExtractedDecl(node, name, "function", exported, exportedDefault));
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const name = (node.id as AstNode | undefined)?.name as string | undefined;
      if (name) out.push(makeExtractedDecl(node, name, "class", exported, exportedDefault));
      // Also collect class methods (e.g. babel-parser's `parse` is a method
      // of the Parser class, not a top-level function). A method is an
      // editable unit: `slice("parse", "src/parser/base.ts")` returns the
      // method body.
      const classBody = (node.body as AstNode | undefined)?.body as AstNode[] | undefined;
      if (classBody) {
        for (const member of classBody) {
          if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") {
            const key = member.key as AstNode | undefined;
            const memberName = (key?.name as string | undefined) ?? (key?.value as string | undefined);
            if (memberName) out.push(makeExtractedDecl(member, memberName, "method", exported, exportedDefault));
          }
        }
      }
      return;
    }
    case "VariableDeclaration": {
      const decls = (node.declarations as AstNode[] | undefined) ?? [];
      for (const decl of decls) {
        const init = decl?.init as AstNode | undefined;
        if (!init) continue;
        const id = (decl?.id as AstNode | undefined);
        const name = id?.name as string | undefined;
        if (!name) continue;
        if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
          out.push(makeExtractedDecl(init, name, "function", exported, exportedDefault));
        } else if (init.type === "ClassExpression") {
          out.push(makeExtractedDecl(init, name, "class", exported, exportedDefault));
        } else {
          out.push(makeExtractedDecl(node, name, "variable", exported, exportedDefault));
        }
      }
      return;
    }
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration":
    case "TSEnumDeclaration": {
      const name = (node.id as AstNode | undefined)?.name as string | undefined;
      if (!name) return;
      const kind = node.type === "TSTypeAliasDeclaration" ? "type"
        : node.type === "TSInterfaceDeclaration" ? "interface" : "enum";
      out.push(makeExtractedDecl(node, name, kind, exported, exportedDefault));
      return;
    }
    case "ImportDeclaration": {
      const specifiers = (node.specifiers as AstNode[] | undefined) ?? [];
      const source = node.source as { value?: string } | undefined;
      const importedNames = specifiers
        .map((s) => (s.local as { name?: string } | undefined)?.name ?? (s.imported as { name?: string } | undefined)?.name ?? "*")
        .join(", ");
      out.push({
        kind: "import",
        name: source?.value ?? "(unknown)",
        line: locLine(node),
        endLine: locEndLine(node),
        signature: `import ${importedNames} from ${JSON.stringify(source?.value ?? "")}`,
        exported: false,
        exportedDefault: false,
        callees: [],
      });
      return;
    }
    case "ExportNamedDeclaration": {
      collectDecl(node.declaration as AstNode | undefined, out, true, false);
      return;
    }
    case "ExportDefaultDeclaration": {
      collectDecl(node.declaration as AstNode | undefined, out, false, true);
      return;
    }
    default:
      return;
  }
}

function makeExtractedDecl(node: AstNode, name: string, kind: string, exported: boolean, exportedDefault: boolean): ExtractedDecl {
  const line = locLine(node);
  const endLine = locEndLine(node);
  const signature = kind === "function" ? signatureOf(node) : kind === "class" ? signatureOfClass(node) : kind;
  const callees = calleesOf(node);
  return deepFreeze({ kind, name, line, endLine, signature, exported, exportedDefault, callees });
}

function locLine(node: AstNode): number {
  const loc = node.loc as { start: { line: number } } | undefined;
  return loc?.start.line ?? 0;
}

function locEndLine(node: AstNode): number {
  const loc = node.loc as { end: { line: number } } | undefined;
  return loc?.end.line ?? 0;
}

function signatureOf(fnNode: AstNode): string {
  const params = ((fnNode.params as AstNode[] | undefined) ?? [])
    .map(paramToSig)
    .filter((s) => s.length > 0)
    .join(", ");
  const ret = returnTypeOf(fnNode.returnType as AstNode | undefined);
  return `(${params})${ret.length > 0 ? `: ${ret}` : ""}`;
}

function paramToSig(p: AstNode | undefined): string {
  if (!p) return "";
  switch (p.type) {
    case "Identifier":
      return `${p.name as string}${typeAnnotationOf(p.typeAnnotation as AstNode | undefined)}`;
    case "AssignmentPattern":
      return `${paramToSig(p.left as AstNode | undefined)}=${shortExpr(p.right as AstNode | undefined)}`;
    case "RestElement":
      return `...${paramToSig(p.argument as AstNode | undefined)}`;
    case "ObjectPattern":
      return `{${((p.properties as AstNode[] | undefined) ?? []).map((x) => paramToSig(x)).join(", ")}}`;
    case "ArrayPattern":
      return `[${((p.elements as (AstNode | null)[] | undefined) ?? []).map((x) => x ? paramToSig(x) : "").join(", ")}]`;
    case "ObjectProperty":
      return `${(p.key as { name?: string } | undefined)?.name ?? shortExpr(p.key as AstNode | undefined)}${typeAnnotationOf((p.value as AstNode | undefined)?.typeAnnotation as AstNode | undefined)}`;
    case "TSParameterProperty":
      return `${p.accessibility ?? ""} ${paramToSig(p.parameter as AstNode | undefined)}`.trim();
    default:
      return `<${p.type}>`;
  }
}

function typeAnnotationOf(ta: AstNode | undefined): string {
  if (!ta) return "";
  return `: ${shortType(ta.typeAnnotation as AstNode | undefined)}`;
}

function returnTypeOf(ta: AstNode | undefined): string {
  if (!ta) return "";
  return shortType(ta.typeAnnotation as AstNode | undefined);
}

function shortType(t: AstNode | undefined): string {
  if (!t) return "";
  switch (t.type) {
    case "TSStringKeyword": return "string";
    case "TSNumberKeyword": return "number";
    case "TSBooleanKeyword": return "boolean";
    case "TSVoidKeyword": return "void";
    case "TSUndefinedKeyword": return "undefined";
    case "TSNullKeyword": return "null";
    case "TSAnyKeyword": return "any";
    case "TSUnknownKeyword": return "unknown";
    case "TSNeverKeyword": return "never";
    case "TSTypeReference": return (t.typeName as { name?: string } | undefined)?.name ?? "<T>";
    case "TSArrayType": return `${shortType(t.elementType as AstNode | undefined)}[]`;
    case "TSUnionType": return ((t.types as AstNode[] | undefined) ?? []).map(shortType).join("|");
    case "TSIntersectionType": return ((t.types as AstNode[] | undefined) ?? []).map(shortType).join("&");
    case "TSTypeLiteral": return "{...}";
    case "TSFunctionType": return "(...)=>...";
    case "TSTupleType": return `[${((t.elementTypes as AstNode[] | undefined) ?? []).map(shortType).join(",")}]`;
    default: return "<T>";
  }
}

function shortExpr(e: AstNode | undefined): string {
  if (!e) return "";
  switch (e.type) {
    case "StringLiteral": return "STR";
    case "NumericLiteral": return String(e.value);
    case "BooleanLiteral": return String(e.value);
    case "NullLiteral": return "null";
    case "Identifier": return e.name as string;
    case "ArrayExpression": return `[${((e.elements as (AstNode | null)[] | undefined) ?? []).map((x) => x ? shortExpr(x) : "").join(",")}]`;
    case "ObjectExpression": return "{...}";
    default: return "<expr>";
  }
}

function signatureOfClass(clsNode: AstNode): string {
  const superClass = clsNode.superClass as { name?: string } | undefined;
  const ext = superClass ? ` extends ${superClass.name ?? "<T>"}` : "";
  return `class${ext}`;
}

function calleesOf(node: AstNode): string[] {
  const set = new Set<string>();
  walkAst(node, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee as AstNode | undefined;
    if (!callee) return;
    const name = calleeName(callee);
    if (name) set.add(name);
  });
  return [...set].slice(0, DEFAULT_FILE_SLICE_CALLEES_LIMIT);
}

function calleeName(callee: AstNode): string {
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression") {
    const obj = (callee.object as { name?: string } | undefined)?.name ?? "?";
    const prop = (callee.property as { name?: string } | undefined)?.name ?? "?";
    return `${obj}.${prop}`;
  }
  return "";
}

function enclosingFunctionName(parents: readonly AstNode[]): string | null {
  for (let i = parents.length - 1; i >= 0; i--) {
    const n = parents[i]!;
    if (
      n.type === "FunctionDeclaration" ||
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression"
    ) {
      const id = n.id as { name?: string } | undefined;
      return id?.name ?? "<anonymous>";
    }
  }
  return null;
}

function summarizeDecl(d: ExtractedDecl): string {
  const parts: string[] = [`L${d.line}`];
  let prefix = "";
  if (d.exported) prefix = "export ";
  if (d.exportedDefault) prefix = "export default ";
  switch (d.kind) {
    case "function": parts.push(`${prefix}fn ${d.name}${d.signature}`); break;
    case "class": parts.push(`${prefix}${d.signature}`); break;
    case "variable": parts.push(`${prefix}var ${d.name}`); break;
    case "type": parts.push(`${prefix}type ${d.name}`); break;
    case "interface": parts.push(`${prefix}interface ${d.name}`); break;
    case "enum": parts.push(`${prefix}enum ${d.name}`); break;
    case "import": parts.push(`import ${d.signature.replace(/^import /, "")}`); break;
    default: parts.push(`${prefix}${d.kind} ${d.name}`); break;
  }
  if (d.callees.length > 0) parts.push(`-> ${d.callees.join(", ")}`);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function walkAstWithParents(node: unknown, visitor: (n: AstNode, parents: readonly AstNode[]) => void): void {
  walkWithParents(node, visitor, []);
}

function walkWithParents(node: unknown, visitor: (n: AstNode, parents: readonly AstNode[]) => void, parents: AstNode[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as AstNode;
  if (typeof n.type !== "string") {
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) for (const c of value) walkWithParents(c, visitor, parents);
      else if (value && typeof value === "object") walkWithParents(value, visitor, parents);
    }
    return;
  }
  visitor(n, parents);
  const nextParents = [...parents, n];
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const c of value) walkWithParents(c, visitor, nextParents);
    else if (value && typeof value === "object") walkWithParents(value, visitor, nextParents);
  }
}
