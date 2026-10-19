/**
 * Tree-sitter WASM backend — async-init, sync-parse.
 *
 * Reuses the EXP402 proven pattern (`experiments/exp402-search-coverage/
 * scripts/exp369/tree-sitter-collector.mjs`): one `Parser` instance, cached
 * `Language` objects (WASM compile is the expensive part), and sync
 * `parse` after a single `await initTreeSitterBackend([...])`.
 *
 * Why a separate backend module (not inlined in the extractor): the
 * editor's syntax validator ALSO needs tree-sitter parsing for
 * multi-language syntax checks. ONE backend serves both consumers
 * (DRY: single WASM-cache + single init lifecycle).
 *
 * WASM resolution walks up from the workspace root looking for
 * `node_modules/tree-sitter-wasms/out/`. The `tree-sitter-wasms` and
 * `web-tree-sitter` packages are already in the candidate's
 * `node_modules` (added by EXP402); this module does NOT add a new
 * runtime dependency, it consumes an existing one.
 *
 * Memory: each loaded grammar costs ~1-3 MB of WASM/heap. Loading all
 * 21 tree-sitter languages in one process is fine (~50-75 MB RSS total
 * — measured). Loading 23+ in a tight loop can OOM on constrained
 * shells; consumers should load only the languages they need via
 * `initTreeSitterBackend(["python","rust","go"])`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { bestEffortAsync } from "../shared/best-effort.ts";
import { getTreeSitterLanguages, LANGUAGE_SPECS as LANGUAGE_SPECS_INTERNAL } from "./language-registry.ts";

/** Typed blocker when a tree-sitter grammar is reachable but not loaded. */
export const TREE_SITTER_LANGUAGE_NOT_INITIALIZED = "tree_sitter_language_not_initialized";
// The backend-level blocker code is internal to this module (every consumer
// that needs it reaches it through this module's own errors), so it stays
// module-private rather than a dead cross-file export.
const TREE_SITTER_BACKEND_NOT_INITIALIZED = "tree_sitter_backend_not_initialized";

export type TreeSitterNode = Readonly<{
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: Readonly<{ row: number; column: number }>;
  hasError: boolean;
  namedChildren: readonly TreeSitterNode[];
  descendantsOfType(types: readonly string[]): readonly TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
  text: string;
  parent: TreeSitterNode | null;
}>;

/** Handle returned by `parseSync`: the root node plus a `done` closer. */
export type TreeSitterParseHandle = Readonly<{
  root: TreeSitterNode;
  /** Free the WASM tree. MUST be called exactly once after the walk. */
  done(): void;
}>;

type ParserCtor = { new (): ParserInstance; init(): Promise<void>; Language: LanguageCtor };
type LanguageCtor = { load(bytes: Uint8Array): Promise<LanguageInstance> };
type ParserInstance = {
  setLanguage(language: LanguageInstance | null): void;
  parse(source: string): TreeRoot | null;
};
type TreeRoot = {
  rootNode: TreeSitterNode;
  delete(): void;
};
type LanguageInstance = { types: readonly string[]; fields: readonly (string | null)[] };

let _parserCtor: ParserCtor | null = null;
let _parser: ParserInstance | null = null;
const _languages = new Map<string, LanguageInstance>();
let _wasmDir: string | null = null;
const _initInflight = new Map<string, Promise<void>>();
const _initDone = new Set<string>();

async function resolveWasmDir(): Promise<string> {
  if (_wasmDir !== null) return _wasmDir;
  const candidates: string[] = [];
  let cwd = process.cwd();
  for (let i = 0; i < 25; i += 1) {
    candidates.push(path.join(cwd, "node_modules", "tree-sitter-wasms", "out"));
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 25; i += 1) {
    candidates.push(path.join(dir, "node_modules", "tree-sitter-wasms", "out"));
    candidates.push(path.join(dir, "..", "node_modules", "tree-sitter-wasms", "out"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // (The package's own `package.json` is not an export: resolving it threw
  // on every call — another "no" reported as a failure. The two ancestor
  // walks above are where node itself looks.)
  // "Is the wasm there?" is a QUESTION whose "no" is an answer, never a
  // failure: probed as a failed best-effort operation, every absent candidate
  // (dozens per resolve, one resolve per farm child) printed the debug
  // system's terminal fallback in the unconfigured extract workers — 156
  // "[debug] diagnostic unavailable" lines per project registration
  // (wf1b-correctness §1f).
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "tree-sitter-python.wasm")));
  if (found !== undefined) {
    _wasmDir = found;
    return found;
  }
  throw new InputError(
    "tree-sitter-wasms/out not found. Install `tree-sitter-wasms` or set the wasm directory.",
    "tree_sitter_wasm_dir_not_found",
  );
}

async function ensureParserCtor(): Promise<ParserCtor> {
  if (_parserCtor !== null) return _parserCtor;
  const mod = await import("web-tree-sitter");
  const ctor = (mod as unknown as { default?: ParserCtor }).default;
  if (ctor === undefined || typeof ctor.init !== "function") {
    throw new InputError("web-tree-sitter: Parser constructor not found", "tree_sitter_parser_missing");
  }
  await ctor.init();
  _parserCtor = ctor;
  return ctor;
}

async function ensureLanguage(languageId: string, wasmFile: string): Promise<LanguageInstance> {
  const cached = _languages.get(languageId);
  if (cached !== undefined) return cached;
  const ctor = await ensureParserCtor();
  const LanguageCtor = ctor.Language;
  if (LanguageCtor === undefined || typeof LanguageCtor.load !== "function") {
    throw new InputError("web-tree-sitter: Language constructor not found", "tree_sitter_language_missing");
  }
  const dir = await resolveWasmDir();
  const bytes = await readFile(path.join(dir, wasmFile));
  const language = await LanguageCtor.load(bytes);
  _languages.set(languageId, language);
  void ctor;
  return language;
}

/**
 * Preload one or more tree-sitter languages. MUST be awaited before any
 * sync `parseSync` call for those languages. Idempotent per language.
 */
export async function initTreeSitterBackend(languageIds: readonly string[]): Promise<void> {
  const dir = await resolveWasmDir();
  for (const id of languageIds) {
    if (_initDone.has(id) && _languages.has(id)) continue;
    const inflight = _initInflight.get(id);
    if (inflight !== undefined) {
      await inflight;
      continue;
    }
    const spec = LANGUAGE_WASM_BY_ID.get(id);
    if (spec === undefined) continue;
    // A language whose wasm is not shipped is simply not available (an
    // answer); only a PRESENT wasm that fails to load is a failure.
    if (!existsSync(path.join(dir, spec))) continue;
    const pending = (async () => {
      await bestEffortAsync(async () => {
        await ensureLanguage(id, spec);
        _initDone.add(id);
      });
    })();
    _initInflight.set(id, pending);
    try {
      await pending;
    } finally {
      _initInflight.delete(id);
    }
  }
  if (_parser === null) {
    const ctor = await ensureParserCtor();
    _parser = new ctor();
  }
}

/** True if a language's grammar is loaded and ready for sync parsing. */
export function isLanguageReady(languageId: string): boolean {
  return _languages.has(languageId);
}

export function isTreeSitterUnreadyError(error: unknown): boolean {
  return error instanceof HarnessError && (
    error.code === TREE_SITTER_LANGUAGE_NOT_INITIALIZED ||
    error.code === TREE_SITTER_BACKEND_NOT_INITIALIZED
  );
}

/**
 * Fail-closed: every requested tree-sitter language must already be loaded.
 * `generateRepositoryMap` is sync and cannot await init; this is the door
 * so an unready grammar cannot become a skipped module / empty map.
 *
 * Rung 4 (runtime choke). Rung 1 is the native engine (lab §5 — no async
 * init). Rung 3 is in-process entries awaiting `initTreeSitterForExtract`
 * at module load. This assertion is why the sync map cannot swallow unready.
 */
export function assertTreeSitterLanguagesReady(languageIds: readonly string[]): void {
  const treeSitterIds = new Set<string>(getTreeSitterLanguages().map((spec) => spec.id));
  const missing = [...new Set(languageIds)].filter(
    (id) => treeSitterIds.has(id) && !isLanguageReady(id),
  );
  if (missing.length === 0) return;
  throw new InputError(
    `tree-sitter language(s) not loaded: ${missing.join(", ")}. Call await initTreeSitterForExtract() first.`,
    TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
  );
}

/**
 * Extract/parse process-spawn init. Loads the requested tree-sitter
 * grammars (all registered ones when omitted) and then fail-closes if
 * any requested grammar is still unready. `initTreeSitterBackend` is
 * best-effort per language; this owner is the one that refuses a silent
 * empty success.
 *
 * Do not top-level-await this from `farm-child.ts` / `symbol-extractor.ts`:
 * the child's `process.on("message")` listener must register before WASM
 * load so the parent `init` IPC is not lost.
 */
export async function initTreeSitterForExtract(languageIds?: readonly string[]): Promise<void> {
  const registered = new Set<string>(getTreeSitterLanguages().map((spec) => spec.id));
  const requested = languageIds !== undefined && languageIds.length > 0
    ? languageIds.filter((id) => registered.has(id))
    : [...registered];
  await initTreeSitterBackend(requested);
  assertTreeSitterLanguagesReady(requested);
}

/** Sync parse — requires `await initTreeSitterBackend([languageId])` first. */
export function parseSync(languageId: string, source: string): TreeSitterParseHandle | null {
  const language = _languages.get(languageId);
  if (language === undefined) {
    throw new InputError(
      `tree-sitter language '${languageId}' not loaded. Call await initTreeSitterForExtract(['${languageId}']) first.`,
      TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
    );
  }
  if (_parser === null) {
    // Rebuild a fresh parser if a previous WASM trap nulled it. The
    // constructor is synchronous once `_parserCtor` is loaded.
    if (_parserCtor === null) {
      throw new InputError(
        "tree-sitter backend not initialized. Call await initTreeSitterForExtract() first.",
        TREE_SITTER_BACKEND_NOT_INITIALIZED,
      );
    }
    _parser = new _parserCtor();
  }
  _parser.setLanguage(language);
  let tree: TreeRoot | null;
  try {
    tree = _parser.parse(source);
  } catch (error) {
    // A WASM trap (memory access out of bounds / stack overflow) corrupts
    // the shared parser instance: every subsequent parse would also fail.
    // Null it so the next call rebuilds from the cached constructor.
    _parser = null;
    throw error;
  }
  if (tree === null) return null;
  const root = tree.rootNode;
  // Return a handle that keeps the tree alive until the caller is done
  // walking. The node is only valid while the tree is alive; freeing
  // before the walk would be a use-after-free ("memory access out of
  // bounds"). The caller MUST call `done` after walking to bound WASM
  // memory (200-file runs OOM the V8 heap otherwise).
  return { root, done: () => tree?.delete() };
}

const LANGUAGE_WASM_BY_ID: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const spec of LANGUAGE_SPECS_INTERNAL) {
    if (spec.treeSitterWasm !== null) map.set(spec.id, spec.treeSitterWasm);
  }
  return map;
})();
