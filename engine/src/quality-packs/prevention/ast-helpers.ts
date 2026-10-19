import { parse, type ParserOptions } from "@babel/parser";

import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../shared/source-extensions.ts";
import { InputError } from "../../kernel/errors.ts";
export { shingles, jaccard } from "../../shared/similarity.ts";

/**
 * Shared AST walker helpers — THE ONE owner of the Babel child traversal.
 *
 * Consumed by the harness's own prevention detectors, the model-facing
 * quality packs, the architecture analyzer (`scripts/verification/
 * architecture.ts`) and the test inventory parser (`scripts/test-inventory.ts`),
 * which used to carry three more copies of the child walk and its key-skip
 * list. Scripts import this `src/` module (the allowed direction); nothing in
 * `src/` imports the verification layer. `bindingNames` is mirrored from
 * `verification/benchmarks/shared/qualification-authority-inventory.mjs:170-180`
 * and `babelParserPluginsForSourcePath` from `scripts/verification/effect-surface.ts:93`
 * (a `domain` → `verification` import would be a layer violation); both are
 * allowlisted parallels in `test/prevention/duplicate-bodies-allowlist.json`.
 */

export type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

export function astNode(value: unknown): AstNode | undefined {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
    ? value as AstNode
    : undefined;
}

export function astNodeArray(value: unknown): readonly AstNode[] {
  return Array.isArray(value) ? value.map(astNode).filter((entry): entry is AstNode => entry !== undefined) : [];
}

/**
 * The node keys that are metadata, never children: positions, parser extras,
 * the node type, and the comment and error arrays a parse may attach. The ONE
 * list every child traversal skips (the test inventory, the architecture
 * analyzer and the prevention detectors all walk through {@link astChildren}).
 */
const AST_NON_CHILD_KEYS: ReadonlySet<string> = new Set([
  "type", "start", "end", "loc", "range", "extra", "errors", "comments",
  "leadingComments", "trailingComments", "innerComments",
]);

export function astChildren(node: AstNode): readonly AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (AST_NON_CHILD_KEYS.has(key)) continue;
    const child = astNode(value);
    if (child) children.push(child);
    else if (Array.isArray(value)) children.push(...astNodeArray(value));
  }
  return children;
}

export function bindingNames(pattern: AstNode | undefined): readonly string[] {
  if (pattern === undefined) return [];
  if (pattern.type === "Identifier") return [String(pattern.name)];
  if (pattern.type === "RestElement") return bindingNames(astNode(pattern.argument));
  if (pattern.type === "AssignmentPattern") return bindingNames(astNode(pattern.left));
  if (pattern.type === "ArrayPattern") return astNodeArray(pattern.elements).flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") {
    return astNodeArray(pattern.properties).flatMap((property) =>
      property.type === "RestElement"
        ? bindingNames(astNode(property.argument))
        : bindingNames(astNode(property.value)),
    );
  }
  return [];
}

export type BabelParserPlugin = "jsx" | "typescript" | ["typescript", { dts: boolean }];

/**
 * Per-file `@babel/parser` plugin selection. Handles `.ts/.tsx/.cts/.mts/.d.ts/
 *.d.mts/.d.cts/.jsx` (E6: do NOT hardcode the TypeScript plugin). Mirrored
 * from `scripts/verification/effect-surface.ts:93`; uses a typed `InputError`
 * instead of `throw new Error(...)` per the no-generic-errors prevention rule.
 */
export function babelParserPluginsForSourcePath(path: string): readonly BabelParserPlugin[] {
  const extension = ARCHITECTURE_SOURCE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  if (extension === undefined) {
    throw new InputError(`unsupported JavaScript source extension: ${path}`, "prevention_ast_unsupported_extension");
  }
  const declaration = path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
  if (extension === ".tsx") return [["typescript", { dts: declaration }], "jsx"];
  if (extension === ".jsx") return ["jsx"];
  return extension === ".cts" || extension === ".mts" || extension === ".ts"
    ? [["typescript", { dts: declaration }]]
    : [];
}

/**
 * Parses one source FILE as a module with the plugins its extension needs,
 * and NAMES THE FILE when it does not parse. A bare parser error says only
 * "(815:2)", and the typed record a command emits then points at the parser's
 * own frame or at the command's entry point: a syntax error in
 * `src/evaluation/matrix-generator.ts` surfaced from `harness sync` as
 * `src/cli.ts` (wf1a-correctness, other findings 1), and the operator looked
 * in the wrong file. Refuses with `source_syntax_invalid`.
 */
export function parseSourceModule(path: string, source: string, options: Omit<ParserOptions, "sourceType" | "plugins"> = {}): AstNode {
  let parsed: { program?: unknown };
  try {
    parsed = parse(source, { ...options, sourceType: "module", plugins: [...babelParserPluginsForSourcePath(path)] }) as unknown as { program?: unknown };
  } catch (error) {
    const location = (error as { loc?: { line?: number; column?: number } }).loc;
    const where = location?.line === undefined ? "" : `:${String(location.line)}:${String((location.column ?? 0) + 1)}`;
    throw new InputError(`${path}${where}: ${(error as Error).message}`, "source_syntax_invalid", { sourcePath: path });
  }
  const program = astNode(parsed.program);
  if (program?.type !== "Program") throw new InputError(`${path}: did not parse as a module`, "source_syntax_invalid", { sourcePath: path });
  return program;
}

/**
 * Generic recursive AST visitor. Walks every node + child array, skipping
 * the `loc`/`range`/`start`/`end`/comment metadata keys. The single owner
 * of the Babel AST walk pattern — consumed by the D3 duplicate-body
 * detector, the EXP441 quick-view index, and the EXP441 file-slice index
 * (DRY: previously triplicated).
 */
export function walkAst(node: unknown, visitor: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as AstNode;
  if (typeof n.type !== "string") {
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) for (const c of value) walkAst(c, visitor);
      else if (value && typeof value === "object") walkAst(value, visitor);
    }
    return;
  }
  visitor(n);
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const c of value) walkAst(c, visitor);
    else if (value && typeof value === "object") walkAst(value, visitor);
  }
}
