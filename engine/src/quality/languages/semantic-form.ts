/**
 * THE SEMANTIC FORM OF A SOURCE FILE — what a change to it means once its
 * comments and its layout are set aside (the FLAKE-REPRO
 * decision). Two versions of a file whose forms are equal differ only by
 * comments, whitespace, line breaks or quoting: a cosmetic edit. A fix that
 * only does that has fixed nothing, so it can never explain a flaky test.
 *
 * EVERY KIND OF FILE IS READ BY THE PARSER THAT ALREADY OWNS IT. There is no
 * second reader:
 *
 * - JavaScript and TypeScript: the one Babel owner
 *   (`parseSourceModule`, src/quality-packs/prevention/ast-helpers.ts, the
 *   parser of the test inventory, the architecture analyzer and the quality
 *   packs). The form is the program's node tree without positions, parser
 *   extras (raw spellings, parentheses) or comment arrays, AND WITHOUT ITS
 *   TYPES (design NH-C, correctness F-L2): a type annotation, a type
 *   argument, an interface, a type alias, a type-only import or export, an
 *   `as`/`satisfies`/`!` wrapper, and the TYPE-ONLY MODIFIERS (an optional
 *   `?` on a parameter or a member, `private`/`protected`/`public`,
 *   `readonly`, `override`, a definite `!`) are erased before
 *   the program runs, so an edit of them alone changes nothing that runs and
 *   is not semantic.
 * - C: the one tree-sitter owner (`parseWithTreeSitter`,
 *   src/quality/languages/shared/tree-sitter-loader.ts, the quality C reader).
 *   The form is the syntax tree without `comment` nodes; layout is not in it.
 * - JSON: the one canonical serializer of the parsed value (`canonicalJson`).
 * - Markdown: NEVER a semantic change (design NH-C): prose runs nothing,
 *   so no edit of it can fix a flaky test. It is unjudged, by name.
 *
 * Any other kind is NOT JUDGED, and it is said by name: it never counts as a
 * semantic change. A file that does not parse is refused by name; it is
 * never compared as text.
 */
import { extname } from "node:path";

import { canonicalJson } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../shared/source-extensions.ts";
import { parseSourceModule } from "../../quality-packs/prevention/ast-helpers.ts";
import { parseWithTreeSitter, type TreeNode } from "./shared/tree-sitter-loader.ts";

/** The semantic form of one file's text, or why its kind has none. */
export type SemanticForm = Readonly<{ form: string }> | Readonly<{ unjudged: string }>;

/** The Babel keys that carry layout, spelling or comments, never meaning. */
const BABEL_LAYOUT_KEYS: ReadonlySet<string> = new Set([
  "start", "end", "loc", "range", "extra", "comments", "leadingComments", "trailingComments", "innerComments", "tokens",
]);

const C_EXTENSIONS: ReadonlySet<string> = new Set([".c", ".h"]);

/** The Babel keys that hold only types: erased before the program runs. */
const BABEL_TYPE_KEYS: ReadonlySet<string> = new Set([
  "typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters", "implements", "predicate",
]);

/** Flags that only TypeScript reads (the emitted program is the same with or without them). */
const BABEL_TYPE_ONLY_FLAGS: ReadonlySet<string> = new Set(["accessibility", "readonly", "override", "definite"]);

/** The nodes whose `optional` is the TypeScript `?` (on a member expression or a call it is `?.`, which runs). */
const BABEL_TYPE_OPTIONAL_HOLDERS: ReadonlySet<string> = new Set([
  "Identifier", "ObjectPattern", "ArrayPattern", "RestElement", "AssignmentPattern",
  "ClassProperty", "ClassPrivateProperty", "ClassMethod", "ClassPrivateMethod", "ClassAccessorProperty", "TSParameterProperty",
]);

/** Statements that are only types (they emit nothing). */
const BABEL_TYPE_ONLY_STATEMENTS: ReadonlySet<string> = new Set([
  "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction",
]);

/** Expression wrappers that only assert a type: the form is their expression. */
const BABEL_TYPE_WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression",
]);

/** Whether a node is erased whole: a type-only statement, a type-only import or export, a type-only specifier, a `declare`d member. */
function erased(node: Readonly<Record<string, unknown>>): boolean {
  const type = node["type"];
  if (typeof type !== "string") return false;
  if (BABEL_TYPE_ONLY_STATEMENTS.has(type)) return true;
  if ((type === "ImportDeclaration" || type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") && node["exportKind"] === "type") return true;
  if (type === "ImportDeclaration" && node["importKind"] === "type") return true;
  if ((type === "ImportSpecifier" || type === "ExportSpecifier") && (node["importKind"] === "type" || node["exportKind"] === "type")) return true;
  if (node["declare"] === true) return true;
  // An `export` of a type-only declaration.
  const declaration = node["declaration"];
  return type === "ExportNamedDeclaration" && declaration !== null && typeof declaration === "object" && erased(declaration as Record<string, unknown>);
}

function babelForm(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.filter((item) => !(item !== null && typeof item === "object" && erased(item as Record<string, unknown>))).map(babelForm).join(",")}]`;
  }
  // A BigInt literal's value (`10n`) is meaning JSON has no spelling for: written as its digits and an `n`.
  if (typeof value === "bigint") return `${value.toString(10)}n`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  const node = value as Record<string, unknown>;
  if (typeof node["type"] === "string" && BABEL_TYPE_WRAPPERS.has(node["type"])) return babelForm(node["expression"]);
  const optionalIsType = typeof node["type"] === "string" && BABEL_TYPE_OPTIONAL_HOLDERS.has(node["type"]);
  const entries = Object.entries(node)
    // The import/export kind is a type-only flag; a value import reads "value" or nothing, and is the same either way.
    .filter(([key]) => !BABEL_LAYOUT_KEYS.has(key) && !BABEL_TYPE_KEYS.has(key) && key !== "importKind" && key !== "exportKind"
      && !BABEL_TYPE_ONLY_FLAGS.has(key) && !(optionalIsType && key === "optional"))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${babelForm(child)}`).join(",")}}`;
}

function treeSitterForm(node: TreeNode): string {
  if (node.childCount === 0) return JSON.stringify([node.type, node.text]);
  const children = node.children.filter((child) => child.type !== "comment").map(treeSitterForm);
  return `(${node.type} ${children.join(" ")})`;
}

/** Walks a tree-sitter tree for a syntax error (an `ERROR` or missing node). */
function treeSitterError(node: TreeNode): boolean {
  if (node.type === "ERROR" || (node as TreeNode & { isMissing?: boolean }).isMissing === true) return true;
  return node.children.some(treeSitterError);
}

/**
 * The semantic form of `text`, the content of repository path `path` (its
 * kind is its extension). A file of a judged kind that does not parse is
 * refused (`semantic_form_unparsed`).
 */
export async function semanticForm(path: string, text: string): Promise<SemanticForm> {
  const extension = extname(path);
  if ((ARCHITECTURE_SOURCE_EXTENSIONS as readonly string[]).includes(extension)) {
    let program: unknown;
    try {
      program = parseSourceModule(path, text);
    } catch (error) {
      throw new InputError(`${(error as Error).message}`, "semantic_form_unparsed", { sourcePath: path });
    }
    return { form: babelForm(program) };
  }
  if (C_EXTENSIONS.has(extension)) {
    const root = await parseWithTreeSitter(text, "c");
    if (treeSitterError(root)) throw new InputError(`${path}: does not parse as C`, "semantic_form_unparsed", { sourcePath: path });
    return { form: treeSitterForm(root) };
  }
  if (extension === ".json") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new InputError(`${path}: does not parse as JSON (${(error as Error).message})`, "semantic_form_unparsed", { sourcePath: path });
    }
    return { form: canonicalJson(value) };
  }
  if (extension === ".md") return { unjudged: "Markdown runs nothing: no edit of it is a semantic change" };
  return { unjudged: `no reader of this repository judges a ${extension === "" ? "file without an extension" : `${extension} file`}'s meaning` };
}
