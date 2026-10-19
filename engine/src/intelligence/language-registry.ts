/**
 * Canonical multi-language registry — ONE source of truth for the
 * languages the intelligence + editor layers understand.
 *
 * Before this module, language knowledge was scattered:
 * - `intelligence/intelligence-types.ts` hardcoded `SOURCE_EXTENSIONS`
 * to JS/TS only (`.cjs/.cts/.js/.jsx/.mjs/.mts/.ts/.tsx`).
 * - `editor/syntax-validator.ts` registered validators only for
 * JS/TS (Babel) + JSON.
 * - `evaluation/scenarios.ts` duplicated its own JS/TS `SOURCE_EXTENSIONS`.
 * - No module knew about Python/Rust/Go/Ruby/Java/C/C++/PHP/Swift/
 * Kotlin/Scala/Elixir/Lua/Zig/OCaml/Elm/Bash/etc.
 *
 * This registry is the single authoritative owner of:
 * - file-extension → language-id mapping (dynamic, not hardcoded at
 * each call site);
 * - which languages have a tree-sitter grammar WASM available (the
 * `tree-sitter-wasms` package already in `node_modules`);
 * - the definition node-types per language (function/method/class/type)
 * used by the tree-sitter symbol extractor;
 * - the comment-line prefixes per language (for doc-comment text
 * inclusion in symbol bodies — improves BM25/search recall).
 *
 * It is data, not logic: consumers query it; they never duplicate it.
 * Per the binding directive "no static constants app-wide", this is the
 * ONE place the language table lives; every other module imports from
 * here. Adding a language = adding one entry here + its grammar WASM in
 * `tree-sitter-wasms/out/`.
 *
 * Tree-sitter grammar node-types were verified by probing each WASM with
 * real source samples (see `exp437-lang-agnostic/ts-one.mjs` probe +
 * `EXPERIMENT.md`). Node-type names are stable per-grammar contracts
 * (tree-sitter grammars guarantee stable named-node types across
 * compatible versions).
 *
 * JS/TS are tree-sitter primary (lab Finding 1: the tokenizer over-counts
 * params and misses class methods). The tokenizer remains for imports/
 * exports and arrow-const constructs. `treeSitter: true` dispatches
 * extract to `extractSymbolsTreeSitter`. Init is owned at process spawn:
 * farm-child awaits `initTreeSitterForExtract` on the init message;
 * in-process entries (function-manifest, typescript-pack) top-level-await
 * it so JS/TS extract is unreachable until ready. Unready is a typed
 * error, never a silent empty map.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import { extractExtension } from "../shared/path-utils.ts";

/** Stable language id (lowercase, no spaces). */
export type LanguageId =
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "ruby"
  | "java"
  | "c"
  | "cpp"
  | "c_sharp"
  | "lua"
  | "swift"
  | "elixir"
  | "zig"
  | "bash"
  | "php"
  | "kotlin"
  | "scala"
  | "dart"
  | "ocaml"
  | "elm"
  | "rescript";

/** Definition-node categories the extractor reports as `SymbolKind`. */
export type DefinitionCategory =
  | "function"
  | "class"
  | "type"
  | "module"
  | "method"
  | "const"
  | "let"
  | "var"
  | "interface"
  | "enum";

/** One definition node-type entry. */
export type DefinitionNodeSpec = Readonly<{
  /** Tree-sitter named node type, e.g. `"function_definition"`. */
  nodeType: string;
  /** The `SymbolKind` to report for matches. */
  kind: DefinitionCategory;
  /**
   * Field name holding the definition's name, OR `null` when the name
   * must be extracted from the first `identifier`/`string` named child
   * (e.g. Elixir `call` nodes, OCaml `value_definition`).
   */
  nameField: string | null;
  /**
   * Field name holding the body (for body-size + body-text extraction),
   * OR `null` when the node itself is the body (e.g. Bash
   * `function_definition`).
   */
  bodyField: string | null;
  /**
   * Optional: restrict matches to nodes whose first named child's text
   * is in this set (used for Elixir macro calls: `def`/`defp`/`defmacro`/
   * `defmodule`/`defprotocol`).
   */
  headKeywordFilter?: readonly string[];
  /** Optional: the `SymbolKind` to report when `headKeywordFilter` matches. */
  kindByKeyword?: Readonly<Record<string, DefinitionCategory>>;
}>;

/** Per-language metadata. */
export type LanguageSpec = Readonly<{
  /** Stable language id. */
  id: LanguageId;
  /** Human-readable name. */
  name: string;
  /** File extensions (lowercase, dot-prefixed), ordered by precedence. */
  extensions: readonly string[];
  /** Tree-sitter WASM grammar file name in `tree-sitter-wasms/out/`. */
  treeSitterWasm: string | null;
  /**
   * Whether the tree-sitter backend is the primary parser for this
   * language. `true` for JS/TS and every grammar-backed language.
   */
  treeSitter: boolean;
  /** Line-comment prefixes (for doc-comment text extraction). */
  lineCommentPrefixes: readonly string[];
  /** Definition node-types to extract. */
  definitions: readonly DefinitionNodeSpec[];
}>;

const TS_ONLY_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const JS_ONLY_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"] as const;

export const LANGUAGE_SPECS: readonly LanguageSpec[] = deepFreeze([
  {
    id: "javascript",
    name: "JavaScript",
    extensions: JS_ONLY_EXTENSIONS,
    treeSitterWasm: "tree-sitter-javascript.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_declaration", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "lexical_declaration", kind: "const", nameField: "name", bodyField: null },
      { nodeType: "variable_declaration", kind: "var", nameField: "name", bodyField: null },
      { nodeType: "method_definition", kind: "method", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "typescript",
    name: "TypeScript",
    extensions: TS_ONLY_EXTENSIONS,
    treeSitterWasm: "tree-sitter-typescript.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_declaration", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "interface_declaration", kind: "interface", nameField: "name", bodyField: null },
      { nodeType: "type_alias_declaration", kind: "type", nameField: "name", bodyField: null },
      { nodeType: "enum_declaration", kind: "enum", nameField: "name", bodyField: "body" },
      { nodeType: "lexical_declaration", kind: "const", nameField: "name", bodyField: null },
      { nodeType: "method_definition", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "method_signature", kind: "method", nameField: "name", bodyField: null },
    ],
  },
  {
    id: "python",
    name: "Python",
    extensions: [".py", ".pyi"],
    treeSitterWasm: "tree-sitter-python.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["#"],
    definitions: [
      { nodeType: "function_definition", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "class_definition", kind: "class", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "rust",
    name: "Rust",
    extensions: [".rs"],
    treeSitterWasm: "tree-sitter-rust.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//", "///", "//!"],
    definitions: [
      { nodeType: "function_item", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "struct_item", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "enum_item", kind: "enum", nameField: "name", bodyField: "body" },
      { nodeType: "trait_item", kind: "interface", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "go",
    name: "Go",
    extensions: [".go"],
    treeSitterWasm: "tree-sitter-go.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_declaration", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "method_declaration", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "type_declaration", kind: "type", nameField: null, bodyField: null },
    ],
  },
  {
    id: "ruby",
    name: "Ruby",
    extensions: [".rb"],
    treeSitterWasm: "tree-sitter-ruby.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["#"],
    definitions: [
      { nodeType: "method", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "singleton_method", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "class", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "module", kind: "module", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "java",
    name: "Java",
    extensions: [".java"],
    treeSitterWasm: "tree-sitter-java.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "method_declaration", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "constructor_declaration", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "interface_declaration", kind: "interface", nameField: "name", bodyField: "body" },
      { nodeType: "enum_declaration", kind: "enum", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "c",
    name: "C",
    extensions: [".c", ".h"],
    treeSitterWasm: "tree-sitter-c.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_definition", kind: "function", nameField: "declarator", bodyField: "body" },
      { nodeType: "struct_specifier", kind: "class", nameField: null, bodyField: null },
      { nodeType: "enum_specifier", kind: "enum", nameField: null, bodyField: null },
    ],
  },
  {
    id: "cpp",
    name: "C++",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"],
    treeSitterWasm: "tree-sitter-cpp.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_definition", kind: "function", nameField: "declarator", bodyField: "body" },
      { nodeType: "class_specifier", kind: "class", nameField: null, bodyField: "body" },
      { nodeType: "struct_specifier", kind: "class", nameField: null, bodyField: null },
      { nodeType: "namespace_definition", kind: "module", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "c_sharp",
    name: "C#",
    extensions: [".cs"],
    treeSitterWasm: "tree-sitter-c_sharp.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "method_declaration", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "constructor_declaration", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "interface_declaration", kind: "interface", nameField: "name", bodyField: "body" },
      { nodeType: "struct_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "enum_declaration", kind: "enum", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "lua",
    name: "Lua",
    extensions: [".lua"],
    treeSitterWasm: "tree-sitter-lua.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["--"],
    definitions: [
      { nodeType: "function_definition_statement", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "local_function_definition_statement", kind: "function", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "swift",
    name: "Swift",
    extensions: [".swift"],
    treeSitterWasm: "tree-sitter-swift.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_declaration", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "struct_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "enum_declaration", kind: "enum", nameField: "name", bodyField: "body" },
      { nodeType: "protocol_declaration", kind: "interface", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "elixir",
    name: "Elixir",
    extensions: [".ex", ".exs"],
    treeSitterWasm: "tree-sitter-elixir.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["#"],
    definitions: [
      {
        nodeType: "call",
        kind: "function",
        nameField: null,
        bodyField: null,
        headKeywordFilter: ["def", "defp", "defmacro", "defmacrop", "defguard", "defguardp"],
        kindByKeyword: { def: "function", defp: "function", defmacro: "function", defmacrop: "function", defguard: "function", defguardp: "function" },
      },
      {
        nodeType: "call",
        kind: "module",
        nameField: null,
        bodyField: null,
        headKeywordFilter: ["defmodule", "defprotocol", "defimpl"],
        kindByKeyword: { defmodule: "module", defprotocol: "interface", defimpl: "module" },
      },
    ],
  },
  {
    id: "zig",
    name: "Zig",
    extensions: [".zig"],
    treeSitterWasm: "tree-sitter-zig.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_declaration", kind: "function", nameField: null, bodyField: "body" },
      { nodeType: "struct_declaration", kind: "class", nameField: null, bodyField: null },
      { nodeType: "enum_declaration", kind: "enum", nameField: null, bodyField: null },
    ],
  },
  {
    id: "bash",
    name: "Bash",
    extensions: [".sh", ".bash"],
    treeSitterWasm: "tree-sitter-bash.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["#"],
    definitions: [
      { nodeType: "function_definition", kind: "function", nameField: null, bodyField: "body" },
    ],
  },
  {
    id: "php",
    name: "PHP",
    extensions: [".php"],
    treeSitterWasm: "tree-sitter-php.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//", "#"],
    definitions: [
      { nodeType: "function_definition", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "method_declaration", kind: "method", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "interface_declaration", kind: "interface", nameField: "name", bodyField: "body" },
      { nodeType: "trait_declaration", kind: "class", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "kotlin",
    name: "Kotlin",
    extensions: [".kt", ".kts"],
    treeSitterWasm: "tree-sitter-kotlin.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_declaration", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "class_declaration", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "object_declaration", kind: "class", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "scala",
    name: "Scala",
    extensions: [".scala", ".sc"],
    treeSitterWasm: "tree-sitter-scala.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_definition", kind: "function", nameField: "name", bodyField: "body" },
      { nodeType: "function_declaration", kind: "function", nameField: "name", bodyField: null },
      { nodeType: "class_definition", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "object_definition", kind: "class", nameField: "name", bodyField: "body" },
      { nodeType: "trait_definition", kind: "interface", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "dart",
    name: "Dart",
    extensions: [".dart"],
    treeSitterWasm: "tree-sitter-dart.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "function_signature", kind: "function", nameField: "name", bodyField: null },
      { nodeType: "method_signature", kind: "method", nameField: "name", bodyField: null },
      { nodeType: "class_definition", kind: "class", nameField: "name", bodyField: "body" },
    ],
  },
  {
    id: "ocaml",
    name: "OCaml",
    extensions: [".ml", ".mli"],
    treeSitterWasm: "tree-sitter-ocaml.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["(*"],
    definitions: [
      { nodeType: "value_definition", kind: "function", nameField: null, bodyField: null },
      { nodeType: "module_definition", kind: "module", nameField: null, bodyField: null },
      { nodeType: "module_type_definition", kind: "interface", nameField: null, bodyField: null },
    ],
  },
  {
    id: "elm",
    name: "Elm",
    extensions: [".elm"],
    treeSitterWasm: "tree-sitter-elm.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["--"],
    definitions: [
      { nodeType: "value_declaration", kind: "function", nameField: null, bodyField: null },
      { nodeType: "type_declaration", kind: "type", nameField: null, bodyField: null },
      { nodeType: "type_alias_declaration", kind: "type", nameField: null, bodyField: null },
    ],
  },
  {
    id: "rescript",
    name: "ReScript",
    extensions: [".res", ".resi"],
    treeSitterWasm: "tree-sitter-rescript.wasm",
    treeSitter: true,
    lineCommentPrefixes: ["//"],
    definitions: [
      { nodeType: "let_declaration", kind: "function", nameField: null, bodyField: "body" },
      { nodeType: "type_declaration", kind: "type", nameField: null, bodyField: null },
    ],
  },
] as const);

const ALL_EXTENSIONS: readonly string[] = LANGUAGE_SPECS.flatMap((spec) => spec.extensions);

const EXTENSION_TO_LANGUAGE_ID: ReadonlyMap<string, LanguageId> = (() => {
  const map = new Map<string, LanguageId>();
  for (const spec of LANGUAGE_SPECS) {
    for (const ext of spec.extensions) {
      if (!map.has(ext)) map.set(ext, spec.id);
    }
  }
  return map;
})();

const LANGUAGE_BY_ID: ReadonlyMap<string, LanguageSpec> = new Map(
  LANGUAGE_SPECS.map((spec) => [spec.id, spec]),
);

export function getLanguageByExtension(filePath: string): LanguageSpec | undefined {
  const ext = extractExtension(filePath);
  if (ext === "") return undefined;
  const id = EXTENSION_TO_LANGUAGE_ID.get(ext);
  return id === undefined ? undefined : LANGUAGE_BY_ID.get(id);
}

/** All known source extensions (dynamic union across all registered languages). */
export function getAllSourceExtensions(): readonly string[] {
  return ALL_EXTENSIONS;
}

/** Languages whose tree-sitter grammar is the primary parser. */
export function getTreeSitterLanguages(): readonly LanguageSpec[] {
  return LANGUAGE_SPECS.filter((spec) => spec.treeSitter && spec.treeSitterWasm !== null);
}

export function isKnownSourceFile(filePath: string): boolean {
  return getLanguageByExtension(filePath) !== undefined;
}
