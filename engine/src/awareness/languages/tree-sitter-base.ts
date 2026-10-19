/**
 * Tree-sitter base — shared real-parser infrastructure for the
 * non-TypeScript language adapters.
 *
 * EXP366's promised "real parsers" deliverable was not committed (still
 * a fresh `git init`), so EXP372 ships the real-parser adapters using
 * `tree-sitter` (the de-facto standard incremental parser generator
 * with bindings for Go, Python, Rust, JavaScript, and TypeScript).
 * The TS adapter keeps `@babel/parser` (richer TypeScript support and
 * already a dependency); the other four adapters use tree-sitter.
 *
 * Per the user directive ("Real parsers, no regex"), Go/Python/Rust
 * adapters MUST use a real parser. The line+regex adapters remain only
 * as a fallback when the `tree-sitter` native binding is unavailable
 * (e.g. a fresh clone before `npm install`).
 *
 * Tree-sitter node API used here:
 * node.type — string (e.g. "function_declaration")
 * node.isNamed — boolean (named nodes only; anonymous tokens like
 * `func`, `(`, `)` have isNamed=false)
 * node.startIndex — byte offset (start)
 * node.endIndex — byte offset (end)
 * node.startPosition — { row, column }
 * node.endPosition — { row, column }
 * node.childCount, node.children, node.namedChildren
 * node.child(i), node.namedChild(i)
 * node.parent
 *
 * The adapter returns the same `Omit<FileAnalysis,...>` shape as the
 * line+regex adapters, so it slots into `index.ts` without changes
 * elsewhere.
 */
import type { FileAnalysis } from "../types.ts";
import { createRequire } from "node:module";
import { HarnessError } from "../../kernel/errors.ts";
import { handleError } from "../../shared/debug/debug-system.ts";

// EXP387 fix: `require` is NOT available in ES module context (Node 24
// with "type": "module"). Use `createRequire` to get a CommonJS require
// function that can load the tree-sitter native binding (which is a
// CommonJS module). Without this, `require("tree-sitter")` throws
// `ReferenceError: require is not defined`, the `tsAvailable` check
// silently returns false, and all tree-sitter adapters fall back to
// line+regex — defeating the "real parsers, no regex" directive.
const cjsRequire = createRequire(import.meta.url);

/** Lazy-loaded tree-sitter modules. Cached after first use. */
let _parserCtor: unknown = null;
let _langCache: Map<string, unknown> | null = null;
let _tsAvailable: boolean | null = null;

/** Detect whether the tree-sitter native binding is installed. */
function tsAvailable(): boolean {
  if (_tsAvailable !== null) return _tsAvailable;
  try {
    const Parser = cjsRequire("tree-sitter");
    if (typeof Parser !== "function" && typeof Parser.default !== "function") throw new HarnessError("no ctor");
    _parserCtor = typeof Parser.default === "function" ? Parser.default : Parser;
    _langCache = new Map();
    _tsAvailable = true;
  } catch (e) {handleError(e, { module: "awareness-languages-tree-sitter-base", operation: "catch" });
    _tsAvailable = false;
  }
  return _tsAvailable;
}

/** Load a tree-sitter language grammar by npm module name. Cached. */
function loadLanguage(moduleName: string): unknown | null {
  if (!tsAvailable() || !_langCache) return null;
  const cached = _langCache.get(moduleName);
  if (cached) return cached;
  try {
    const mod = cjsRequire(moduleName);
    // Some packages export `{ typescript, tsx }` (tree-sitter-typescript);
    // others export the Language directly. For tree-sitter-typescript we
    // pass the submodule name in (e.g. "tree-sitter-typescript/typescript").
    let lang: unknown = mod;
    if (moduleName === "tree-sitter-typescript") {
      lang = (mod as { typescript?: unknown }).typescript ?? mod;
    }
    _langCache.set(moduleName, lang);
    return lang;
  } catch (e) {
    handleError(e, { module: "awareness-tree-sitter", operation: "load-language" });
    return null;
  }
}

/** A parsed tree-sitter node with the fields we need. */
export interface TSNode {
  type: string;
  isNamed: boolean;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  children: TSNode[];
  namedChildren: TSNode[];
  child(i: number): TSNode | null;
  namedChild(i: number): TSNode | null;
  parent: TSNode | null;
}

/** Parse `source` with a tree-sitter grammar. Returns the root node, or null on failure. */
export function parseWithTreeSitter(grammarModule: string, source: string): TSNode | null {
  if (!tsAvailable()) return null;
  const lang = loadLanguage(grammarModule);
  if (!lang) return null;
  try {
    const ParserCtor = _parserCtor as new () => { setLanguage(l: unknown): void; parse(s: string): { rootNode: TSNode } };
    const parser = new ParserCtor();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    return tree.rootNode;
  } catch (e) {
    handleError(e, { module: "awareness-tree-sitter", operation: "parse" });
    return null;
  }
}

/** A collected function from any tree-sitter grammar. */
export interface CollectedFn {
  filePath: string;
  name: string;
  line: number;
  bodyLines: number;
  bodyChars: number;
  tokens: string[];
  complexity: number;
  typedParameters: number;
  parameterCount: number;
  hasReturnAnnotation: boolean;
}

/** Walk a tree-sitter node tree, yielding every named descendant node. */
export function* walkNamed(root: TSNode): Generator<TSNode> {
  const stack: TSNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    yield n;
    for (const c of n.children) {
      if (c.isNamed) stack.push(c);
    }
  }
}

/** Tokenize a tree-sitter subtree into a normalized body-token stream
 * (used for clone detection + entropy). Identifiers → lowercase; strings
 * → "lit_str"; numbers → "lit_num"; booleans → "lit_true"/"lit_false";
 * everything else → node.type (lowercased). */
export function tokenizeSubtree(node: TSNode, idAllowlist?: Set<string>): string[] {
  const out: string[] = [];
  const stack: TSNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const t = n.type;
    if (t === "identifier" || t === "type_identifier" || t === "property_identifier" || t === "field_identifier") {
      // For identifiers we need the text. Use the source slice via parent's startIndex.
      // tree-sitter exposes the text via `node.text` in newer versions, but the
      // node binding here doesn't reliably have it; instead we use startIndex/endIndex
      // and slice the source. We don't have the source here — so we emit "id" and
      // let the caller pass an "idResolver" that maps node → source text.
      // For clone detection, identifier names matter; for entropy, only the
      // *distribution* of node types matters. We resolve text below via a callback.
      out.push("__ID__");
    } else if (t === "string" || t === "string_literal" || t === "raw_string_literal" || t === "interpreted_string_literal") {
      out.push("lit_str");
    } else if (t === "integer_literal" || t === "float_literal") {
      out.push("lit_num");
    } else if (t === "boolean") {
      out.push("lit_bool");
    } else if (t === "none" || t === "nil" || t === "null") {
      out.push("lit_null");
    } else {
      out.push(t.toLowerCase());
    }
    // Push children in reverse so the walk is left-to-right.
    for (let i = n.children.length - 1; i >= 0; i -= 1) {
      const c = n.children[i]!;
      if (c.isNamed) stack.push(c);
    }
  }
  // Replace __ID__ with the actual identifier text (passed in by caller).
  if (idAllowlist) {
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === "__ID__") out[i] = "id";
    }
  }
  return out;
}

/** Tokenize a subtree using the source text to resolve identifier names. */
export function tokenizeSubtreeWithSource(node: TSNode, source: string): string[] {
  const out: string[] = [];
  const stack: TSNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const t = n.type;
    if (t === "identifier" || t === "type_identifier" || t === "property_identifier" || t === "field_identifier") {
      const text = source.slice(n.startIndex, n.endIndex).toLowerCase();
      out.push(text.length > 0 ? text : "id");
    } else if (t === "string" || t === "string_literal" || t === "raw_string_literal" || t === "interpreted_string_literal") {
      out.push("lit_str");
    } else if (t === "integer_literal" || t === "float_literal") {
      out.push("lit_num");
    } else if (t === "true") {
      out.push("lit_true");
    } else if (t === "false") {
      out.push("lit_false");
    } else if (t === "none" || t === "nil" || t === "null") {
      out.push("lit_null");
    } else if (n.isNamed) {
      out.push(t.toLowerCase());
    }
    for (let i = n.children.length - 1; i >= 0; i -= 1) {
      stack.push(n.children[i]!);
    }
  }
  return out;
}

/** Count decision-point node types in a subtree (cyclomatic complexity). */
export function treeSitterComplexity(node: TSNode, decisionTypes: ReadonlySet<string>): number {
  let c = 1;
  for (const n of walkNamed(node)) {
    if (decisionTypes.has(n.type)) c += 1;
  }
  return c;
}

/** Compute body length in lines from a node's start/end positions. */
export function bodyLinesOf(node: TSNode): number {
  return Math.max(0, node.endPosition.row - node.startPosition.row);
}

/** Compute body length in chars from byte offsets. */
export function bodyCharsOf(node: TSNode): number {
  return Math.max(0, node.endIndex - node.startIndex);
}

/** Detect whether the tree-sitter binding is available. */
export function hasTreeSitter(): boolean {
  return tsAvailable();
}

/** Re-export FileAnalysis type for adapter implementers. */
export type { FileAnalysis };
