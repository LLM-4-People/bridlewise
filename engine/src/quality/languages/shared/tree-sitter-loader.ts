/**
 * Shared tree-sitter WASM loader (EXP368).
 *
 * ONE canonical owner for tree-sitter initialization, language-wasm loading,
 * and parser pooling. All tree-sitter-based language parsers consume this
 * loader; no per-language init logic is duplicated.
 *
 * Uses `web-tree-sitter` (WASM-based) + `tree-sitter-wasms` (prebuilt language
 * WASMs). WASM avoids the native-build fragility of `tree-sitter` 0.25+ on
 * newer Node runtimes while providing the same real-AST output.
 *
 * Performance: language wams are loaded once and cached; parsers are reused.
 * A single `Parser.init` is shared across all languages.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HarnessError } from "../../../kernel/errors.ts";
import { bestEffort } from "../../../shared/best-effort.ts";

type TreeSitterModule = typeof import("web-tree-sitter");

const TS_REQUIRE_PATH = "web-tree-sitter";
const WASMS_REQUIRE_PATH = "tree-sitter-wasms/package.json";

/** Languages supported by tree-sitter in this pack. */
export type TreeSitterLanguageName =
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "javascript"
  | "typescript";

interface ParserLike {
  setLanguage(language: unknown): void;
  parse(input: string): { rootNode: TreeNode };
  delete(): void;
}

interface TreeNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly startIndex: number;
  readonly endIndex: number;
  readonly childCount: number;
  readonly parent: TreeNode | null;
  readonly children: readonly TreeNode[];
  readonly namedChildren: readonly TreeNode[];
  childForFieldName(name: string): TreeNode | null;
  childOfType(type: string): TreeNode | null;
  fieldNameForChild(child: TreeNode): string | null;
  walk(): unknown;
}

interface TreeSitterCtor {
  new (): ParserLike;
  init(options?: { locateFile?: (file: string) => string }): Promise<void>;
  /**
   * Optional on web-tree-sitter ≥ 0.25 (where `Language` is a separate
   * top-level export, not a static on `Parser`). `loadLanguage` uses
   * the module-level `languageCtor` instead, so this is kept only for the
   * (currently dead) `getTreeSitterParser` export + 0.22.x compatibility.
   */
  Language?: { load(bytes: Uint8Array): Promise<unknown> };
}

let modulePromise: Promise<TreeSitterCtor> | null = null;
// web-tree-sitter ≥ 0.25 split `Language` into a separate top-level
// export (it is no longer a static on `Parser`). The loader resolves it at
// init time and stores it here so `loadLanguage` doesn't depend on
// `ParserCtor.Language` (which is undefined on the new API).
let languageCtor: { load(bytes: Uint8Array): Promise<unknown> } | null = null;
const loadedLanguages = new Map<TreeSitterLanguageName, Promise<unknown>>();
let wasmDir: string | null = null;

function resolveWasmDir(): string {
  if (wasmDir) return wasmDir;
  const require = createRequire(import.meta.url);
  const wasmsPkg = require.resolve(WASMS_REQUIRE_PATH);
  wasmDir = join(dirname(wasmsPkg), "out");
  return wasmDir;
}

/**
 * R47: resolve the `web-tree-sitter` package directory robustly across
 * versions. Resolves the main entry (always exported via `.`) and walks up
 * to the first `package.json` — the package root. This avoids the version-
 * specific `exports` subpaths (`.wasm` on ≥ 0.25, `./package.json` on 0.22)
 * AND avoids swallowed try/catch fallback chains. If the package
 * is not installed, `require.resolve` throws a typed ESM error (genuine).
 */
function resolveWtsDir(require: NodeRequire): string {
  const mainPath = require.resolve(TS_REQUIRE_PATH);
  let dir = dirname(mainPath);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return dirname(mainPath);
}

function getTreeSitter(): Promise<TreeSitterCtor> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const require = createRequire(import.meta.url);
    const mod = require(TS_REQUIRE_PATH) as TreeSitterModule;
    // R47: handle both web-tree-sitter API shapes:
    // - 0.22.x: the default export IS the Parser class (with static `init`
    // and static `Language`); `new`-able directly.
    // - ≥ 0.25 (installed: 0.26.11): the default export is a NAMESPACE
    // exposing `Parser` and `Language` as separate top-level exports.
    // `Parser.init` is static, `Language.load` is static, and `Parser`
    // is `new`-able (only after `init`).
    const ns = (mod as unknown as { default?: unknown }).default ?? mod;
    const nsRecord = ns as Record<string, unknown>;
    const ParserCtor = (nsRecord.Parser as TreeSitterCtor | undefined) ?? (ns as TreeSitterCtor);
    if (typeof (ParserCtor as { init?: unknown }).init !== "function") {
      throw new HarnessError("web-tree-sitter: Parser.init is not available (unexpected API shape)", "tree_sitter_init_unavailable");
    }
    // R47: resolve the web-tree-sitter package directory robustly across
    // versions. web-tree-sitter's `exports` map varies by major version:
    // - ≥ 0.25: exposes `./web-tree-sitter.wasm` but NOT `./package.json`.
    // - 0.22.x: exposes `./package.json` but NOT the `.wasm` subpath.
    // - some builds: no `exports` field at all.
    // Try each strategy in order; the final walk-up fallback finds the
    // package root from the resolved main entry (works for any layout).
    const wtsDir = resolveWtsDir(require);
    await ParserCtor.init({ locateFile: (file) => join(wtsDir, file) });
    // R47: resolve the Language class AFTER init. web-tree-sitter 0.22.x
    // attaches `Language` to the Parser class only once `init` completes;
    // ≥ 0.25 exposes `Language` as a top-level namespace export (available
    // before init). Checking post-init covers both shapes.
    const Language = (nsRecord.Language as { load(bytes: Uint8Array): Promise<unknown> } | undefined)
      ?? (ParserCtor.Language as { load(bytes: Uint8Array): Promise<unknown> } | undefined)
      ?? null;
    languageCtor = Language;
    return ParserCtor;
  })();
  return modulePromise;
}

/** Load (and cache) a tree-sitter language wasm by name. */
export async function loadLanguage(name: TreeSitterLanguageName): Promise<unknown> {
  const cached = loadedLanguages.get(name);
  if (cached) return cached;
  const promise = (async () => {
    // R47: `getTreeSitter` resolves the language class into the module-level
    // `languageCtor` (web-tree-sitter ≥ 0.25 exposes `Language` as a separate
    // top-level export, not a static on `Parser`).
    await getTreeSitter();
    const lang = languageCtor;
    if (lang === null) {
      throw new HarnessError("web-tree-sitter: Language export unavailable (unexpected API shape)", "tree_sitter_language_unavailable");
    }
    const dir = resolveWasmDir();
    const wasmPath = join(dir, `tree-sitter-${name}.wasm`);
    const bytes = readFileSync(wasmPath);
    return lang.load(bytes);
  })();
  loadedLanguages.set(name, promise);
  return promise;
}

/** Parse code with a tree-sitter language. Returns the root node.
 *
 * IMPORTANT: the returned node is only valid as long as the underlying
 * tree is alive. We do NOT call `parser.delete` or `tree.delete` here
 * the caller must finish walking the tree before this function is
 * called again for a new file. The WASM memory is reclaimed on the next
 * `parseWithTreeSitter` call (we delete the previous tree then).
 *
 * To avoid concurrency issues with the WASM runtime, callers should parse
 * files SEQUENTIALLY (not in parallel via Promise.all). */
let previousTree: { delete(): void } | null = null;

export async function parseWithTreeSitter(
  code: string,
  languageName: TreeSitterLanguageName,
): Promise<TreeNode> {
  const language = await loadLanguage(languageName);
  const ParserCtor = await getTreeSitter();
  // Delete the previous tree to free WASM memory (the caller is done with it).
  if (previousTree) {
    const tree = previousTree;
    bestEffort(() => tree.delete());
    previousTree = null;
  }
  const parser = new ParserCtor();
  parser.setLanguage(language);
  const tree = parser.parse(code);
  previousTree = tree as unknown as { delete(): void };
  return tree.rootNode as TreeNode;
}

/** Synchronous access to the raw tree-sitter Parser constructor.
 * Useful when a parser wants to batch-parse many files. */
export async function getTreeSitterParser(): Promise<TreeSitterCtor> {
  return getTreeSitter();
}

/** Read a wasm language file as bytes (for advanced callers). */
export function readLanguageWasm(name: TreeSitterLanguageName): Uint8Array {
  const dir = resolveWasmDir();
  return readFileSync(join(dir, `tree-sitter-${name}.wasm`));
}

export type { TreeNode };
