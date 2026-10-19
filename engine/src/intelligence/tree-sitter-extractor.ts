/**
 * Tree-sitter-backed symbol extractor for non-JS/TS languages.
 *
 * Produces the SAME `ExtractionResult` shape as the JS/TS
 * `symbol-extractor.ts`, so `repository-map.ts` / `symbol-search.ts` /
 * `reuse-discovery.ts` consume ONE unified symbol stream regardless of
 * the source language.
 *
 * Design:
 * - Per-language definition node-types + field names come from the
 * canonical `language-registry.ts` (ONE source of truth — no
 * hardcoded node-type strings in this module).
 * - The tree-sitter WASM backend (`tree-sitter-backend.ts`) handles
 * init/parse; this module walks the tree.
 * - `extractSymbolsTreeSitter` is SYNC and requires
 * `await initTreeSitterBackend([languageId])` to have been awaited
 * for the file's language. If the language is not ready, it THROWS
 * (`tree_sitter_language_not_initialized`) — an unready parser cannot
 * succeed as an empty map.
 *
 * Imports for non-JS/TS languages are extracted by the companion
 * `multi-import-extractor.ts` (regex-based, language-specific patterns for
 * Python/Rust/Go/Java/C/C++/Ruby/PHP/Kotlin/Scala/etc.). Exports remain
 * empty (the JS/TS export concept does not apply; symbol visibility is
 * captured per-symbol via `exported: false` from tree-sitter). This fills
 * the gap that previously left non-JS/TS repos with NO dependency edges —
 * the graph showed only isolated nodes (Task 1: code graph MAJOR REWRITE).
 */

import { deepFreeze } from "../kernel/integrity.ts";
import {
  getLanguageByExtension,
  type DefinitionNodeSpec,
  type LanguageSpec,
} from "./language-registry.ts";
import {
  isLanguageReady,
  parseSync,
  TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
  type TreeSitterNode,
} from "./tree-sitter-backend.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";
import type {
  ExportInfo,
  ImportInfo,
  SymbolInfo,
  SymbolKind,
} from "./intelligence-types.ts";
import { extractMultiLanguageImports } from "./multi-import-extractor.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { InputError } from "../kernel/errors.ts";

/** Walk a tree-sitter tree and emit `SymbolInfo` for each definition node. */
export function extractSymbolsTreeSitter(filePath: string, source: string): ExtractionResult {
  const spec = getLanguageByExtension(filePath);
  if (spec === undefined) {
    return emptyResult(source);
  }
  if (!spec.treeSitter) {
    return emptyResult(source);
  }
  if (!isLanguageReady(spec.id)) {
    throw new InputError(
      `tree-sitter language '${spec.id}' not loaded. Call await initTreeSitterForExtract(['${spec.id}']) first.`,
      TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
    );
  }
  let handle;
  try {
    handle = parseSync(spec.id, source);
  } catch (e) {
    handleError(e, { module: "intelligence-tree-sitter-extractor", operation: "parseSync" });
    return emptyResult(source);
  }
  if (handle === null) {
    return emptyResult(source);
  }
  try {
    const symbols = collectDefinitions(handle.root, spec, filePath);
    const lineCount = countLines(source);
    // Extract imports via the multi-language regex extractor so non-JS/TS
    // repos get dependency edges (Task 1). The JS/TS path is handled by the
    // tokenizer in symbol-extractor.ts; this path serves the other 19
    // registered languages.
    const imports = extractMultiLanguageImports(filePath, source);
    return deepFreeze({
      symbols,
      imports: deepFreeze(imports),
      exports: deepFreeze([] as readonly ExportInfo[]),
      lineCount,
    });
  } finally {
    handle.done();
  }
}

function collectDefinitions(root: TreeSitterNode, spec: LanguageSpec, filePath: string): readonly SymbolInfo[] {
  const out: SymbolInfo[] = [];
  // Group definition specs by node type, then use tree-sitter's NATIVE
  // `descendantsOfType` (a C-side walk — no JS recursion, no `.text` on
  // non-matching nodes). This is the fix for the stack-overflow + WASM-OOM
  // crashes on large real files: we never recursively walk the whole tree
  // in JS, and we only access `.text` on the small name-field node.
  const nodeTypeToSpecs = new Map<string, readonly DefinitionNodeSpec[]>();
  for (const def of spec.definitions) {
    const list = nodeTypeToSpecs.get(def.nodeType);
    if (list === undefined) nodeTypeToSpecs.set(def.nodeType, [def]);
    else nodeTypeToSpecs.set(def.nodeType, [...list, def]);
  }
  const nodeTypes = [...nodeTypeToSpecs.keys()];
  const matches = root.descendantsOfType(nodeTypes);
  for (const node of matches) {
    const defs = nodeTypeToSpecs.get(node.type);
    if (defs === undefined) continue;
    for (const def of defs) {
      const emitted = emitSymbol(node, def, filePath);
      if (emitted !== null) out.push(emitted);
    }
  }
  return deepFreeze(out);
}

function emitSymbol(node: TreeSitterNode, def: DefinitionNodeSpec, filePath: string): SymbolInfo | null {
  if (def.headKeywordFilter !== undefined && def.headKeywordFilter.length > 0) {
    const head = firstNamedChildText(node);
    if (head === null || !def.headKeywordFilter.includes(head)) return null;
  }
  const name = extractName(node, def);
  if (name === null || name === "") return null;
  const kind = resolveKind(node, def);
  const pos = node.startPosition;
  const parameterCount = countParameters(node);
  const exported = isUnderExport(node);
  const async =
    hasNamedChildType(node, "async") ||
    node.text.trimStart().startsWith("async ") ||
    /\basync\s*(?:\(|function)/.test(node.text);
  const generator = node.type.includes("generator") || hasStarGenerator(node);
  const modifiers: string[] = [];
  if (async) modifiers.push("async");
  if (generator) modifiers.push("generator");
  if (exported) modifiers.push("exported");
  return deepFreeze({
    name,
    kind,
    visibility: exported ? "exported" : "local",
    location: { filePath, line: pos.row + 1, column: pos.column },
    exported,
    async,
    generator,
    parameterCount,
    modifiers: deepFreeze(modifiers),
  });
}

function isUnderExport(node: TreeSitterNode): boolean {
  let p = node.parent;
  for (let i = 0; i < 6 && p !== null; i += 1) {
    if (p.type === "export_statement" || p.type === "export_declaration") return true;
    p = p.parent;
  }
  return false;
}

function hasNamedChildType(node: TreeSitterNode, type: string): boolean {
  return node.namedChildren.some((c) => c.type === type);
}

function hasStarGenerator(node: TreeSitterNode): boolean {
  return node.namedChildren.some((c) => c.type === "*" || c.text === "*");
}

function resolveKind(node: TreeSitterNode, def: DefinitionNodeSpec): SymbolKind {
  if (def.headKeywordFilter !== undefined && def.kindByKeyword !== undefined) {
    const head = firstNamedChildText(node);
    if (head !== null && def.kindByKeyword[head] !== undefined) {
      return def.kindByKeyword[head] as SymbolKind;
    }
  }
  return def.kind as SymbolKind;
}

function extractName(node: TreeSitterNode, def: DefinitionNodeSpec): string | null {
  if (def.nameField !== null) {
    const fieldNode = node.childForFieldName(def.nameField);
    if (fieldNode !== null) {
      const direct = stripIdentifier(fieldNode);
      if (direct !== null) return direct;
      return firstIdentifierText(fieldNode);
    }
    // The named field is missing (some grammars, e.g. Kotlin, expose NO
    // field names at all). Fall through to a leaf descent rather than
    // returning null — otherwise every Kotlin/Rust-declarator definition
    // would be dropped.
  }
  return firstIdentifierOrKeywordText(node, def);
}

function stripIdentifier(node: TreeSitterNode): string | null {
  // A name is a LEAF token (no named children) whose text is identifier-like.
  // This is language-agnostic: across grammars the name lives in different
  // node types — `identifier` (JS/Python/Ruby), `name` (PHP), `simple_identifier`
  // (Kotlin), `type_identifier` (TS/Java), `value_name`/`value_pattern` (OCaml),
  // `value_identifier` (ReScript), `function_declaration_left` (Elm). Rather
  // than enumerate every grammar's name node-type, we accept any leaf token
  // (namedChildren.length === 0) whose text matches an identifier pattern
  // and is short (<= 128 chars, to avoid matching string-literal bodies).
  if (node.namedChildren.length !== 0) return null;
  const text = node.text;
  if (text.length === 0 || text.length > 128) return null;
  // Identifier-like: letters, digits, underscore, $, @,:,.,:: (covers
  // PHP `$var`, Ruby `@var`, Rust `Self::method`, Haskell `Map.lookup`).
  if (/^[A-Za-z_$@][A-Za-z0-9_$@:.-]*$/.test(text)) return text;
  // OCaml/Elm operator-name functions: `(+)`, `(**)`, etc.
  if (/^\([^A-Za-z]*\)$/.test(text) && text.length <= 8) return text;
  return null;
}

function firstIdentifierText(node: TreeSitterNode): string | null {
  for (const child of node.namedChildren) {
    const direct = stripIdentifier(child);
    if (direct !== null) return direct;
  }
  return null;
}

function firstNamedChildText(node: TreeSitterNode): string | null {
  const children = node.namedChildren;
  if (children.length === 0) return null;
  return children[0]!.text;
}

function firstIdentifierOrKeywordText(node: TreeSitterNode, def: DefinitionNodeSpec): string | null {
  if (def.headKeywordFilter !== undefined && def.headKeywordFilter.length > 0) {
    const head = firstNamedChildText(node);
    if (head === null) return null;
    if (def.headKeywordFilter.includes(head)) {
      const second = node.namedChildren.length > 1 ? node.namedChildren[1]!.text : null;
      if (second !== null) return second;
      return null;
    }
    return null;
  }
  const id = firstIdentifierText(node);
  if (id !== null) return id;
  // Name nested below the definition (Elm `value_declaration` ->
  // `function_declaration_left` -> `lower_case_identifier`; OCaml
  // `value_definition` -> `let_binding` -> `value_name`; Bash
  // `function_definition` -> `command_name`). Descend the leftmost-named-
  // child chain (bounded depth 4) to the first identifier-like leaf.
  return firstLeafIdentifier(node, 4);
}

/**
 * Bounded leftmost descent to the first identifier-like leaf. Avoids full
 * tree walks (no stack-overflow / WASM-OOM risk): at most `maxDepth` node
 * accesses, following only the first named child at each level.
 */
function firstLeafIdentifier(node: TreeSitterNode, maxDepth: number): string | null {
  let cur: TreeSitterNode | null = node;
  for (let depth = 0; depth < maxDepth && cur !== null; depth += 1) {
    const direct = stripIdentifier(cur);
    if (direct !== null) return direct;
    const children: readonly TreeSitterNode[] = cur.namedChildren;
    if (children.length === 0) {
      // Leaf but not identifier-like (e.g. a string/number) — stop.
      return null;
    }
    cur = children[0]!;
  }
  return null;
}

function countParameters(node: TreeSitterNode): number {
  const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter_list") ?? node.childForFieldName("parameters");
  if (params !== null) {
    return params.namedChildren.filter((p) => p.type !== "comment").length;
  }
  return 0;
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function emptyResult(source: string): ExtractionResult {
  return deepFreeze({
    symbols: deepFreeze([] as readonly SymbolInfo[]),
    imports: deepFreeze([] as readonly ImportInfo[]),
    exports: deepFreeze([] as readonly ExportInfo[]),
    lineCount: countLines(source),
  });
}
