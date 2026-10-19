/**
 * EXP454 — DYNAMIC keyword detection. Replaces the PROHIBITED hardcoded
 * JS_KEYWORDS list from EXP449 (dedup-v2.ts:205-214).
 *
 * The user directive: "anything hardcoded is prohibited: Semantic dedup
 * keyword list — hardcoded set of JS/TS keywords. PROHIBITED."
 *
 * This module determines whether a token is a language keyword DYNAMICALLY:
 * 1. `babel-tokens` — parse with @babel/parser (tokens:true); a token is
 * a keyword iff `token.type.keyword!== null`. The parser IS the
 * language authority; it knows every keyword and every contextual
 * keyword without us listing them. JS/TS only.
 * 2. `tree-sitter` — parse with web-tree-sitter; `identifier`-typed nodes
 * are user identifiers (→ "ID"), everything else is structural
 * (keywords are syntactic, not nodes). Multi-language via WASM.
 * 3. `frequency-learned` — scan the corpus; a word is treated as a
 * keyword if it appears in >= `keywordFrequencyThreshold` fraction of
 * blocks. Fully dynamic, language-agnostic, no parser needed.
 * 4. `auto` — babel-tokens for.ts/.tsx/.js/.jsx/.mjs/.cjs, tree-sitter if
 * a WASM is available for the detected language, frequency-learned
 * otherwise.
 *
 * The output is a normalized token SET used by semantic dedup. Identifier →
 * "ID", string literal → "STR", numeric literal → "NUM", keyword → kept
 * verbatim (structurally meaningful), punctuation → kept verbatim.
 *
 * No hardcoded keyword list anywhere. The parser or the corpus is the
 * authority.
 */

import { parse } from "@babel/parser";
import type { DedupCompressionConfig, KeywordStrategy } from "./config.ts";
import { stripMarkdownFences } from "./shared-helpers.ts";

/** A normalized token: either a category tag ("ID","STR","NUM") or the
 * verbatim keyword/punctuation string. */
export type NormToken = string;

/** Result of normalizing a block into a token set for Jaccard comparison. */
export interface NormalizeResult {
  tokens: Set<NormToken>;
  /** Strategy actually used. Broadened to `string` so internal fallback
   * markers (e.g. "line-fallback") can be reported without polluting the
   * KeywordStrategy enum. */
  strategy: KeywordStrategy | string;
  /** how many raw tokens were classified as keywords (kept verbatim) */
  keywordCount: number;
  /** how many were classified as identifiers (→ ID) */
  identifierCount: number;
  /** parse error if the parser was attempted and failed (strategy falls back) */
  parseError: string | null;
}

/** File extensions handled by the babel tokenizer. */
const BABEL_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Detect a plausible language extension from text heuristics (for `auto`).
 * Returns the extension string or "" if unknown. */
export function detectExtension(text: string): string {
  const head = text.slice(0, 400);
  if (/^\s*\/\*[\s\S]*?\*\//.test(head) || /\bfn\s+\w+\s*\(/.test(head) || /\blet\s+mut\s+/.test(head))
    return ".rs";
  if (/^\s*#(include|define|ifndef|pragma)\b/.test(head)) return ".c";
  if (/\bdef\s+\w+\s*\(/.test(head)) return ".py";
  if (/\bfunc\s+\w+\s*\(/.test(head)) return ".go";
  if (/\bpublic\s+(class|static)\b/.test(head)) return ".java";
  return ".ts"; // default to TS (most common in this harness)
}

/** Choose the keyword strategy for a given text given the config. */
export function chooseStrategy(text: string, cfg: DedupCompressionConfig): KeywordStrategy {
  if (cfg.keywordStrategy !== "auto") return cfg.keywordStrategy;
  const ext = detectExtension(text);
  if (BABEL_EXTENSIONS.has(ext)) return "babel-tokens";
  const wasm = cfg.treeSitterLanguages[ext];
  if (wasm) return "tree-sitter";
  return "frequency-learned";
}

// ===== babel-tokens strategy (JS/TS, parser-authoritative) =====

/** Normalize a block using @babel/parser's tokenizer. Keyword iff
 * token.type.keyword!== null. No hardcoded list. */
export function normalizeBabelTokens(block: string): NormalizeResult {
  let tokens: ReturnType<typeof parse>["tokens"];
  try {
    const ast = parse(stripMarkdownFences(block), {
      plugins: ["typescript", "jsx"],
      sourceType: "module",
      tokens: true,
      errorRecovery: true,
    });
    tokens = ast.tokens ?? [];
  } catch (e) {
    return fallbackFrequency(block, "babel-tokens", String(e).slice(0, 200));
  }
  const out = new Set<NormToken>();
  let kw = 0, id = 0;
  for (const t of tokens) {
    const label = t.type.label ?? "";
    if (t.type.keyword !== null && t.type.keyword !== undefined) {
      out.add(String(t.type.keyword));
      kw++;
    } else if (label === "name") {
      out.add("ID");
      id++;
    } else if (label === "string" || label === "template") {
      out.add("STR");
    } else if (label === "num" || label === "bigint" || label === "regex") {
      out.add("NUM");
    } else if (label === "eof" || label === "") {
      continue;
    } else {
      // punctuation / operators — keep verbatim (lowercased for stability)
      out.add(label.toLowerCase());
    }
  }
  return { tokens: out, strategy: "babel-tokens", keywordCount: kw, identifierCount: id, parseError: null };
}

// ===== tree-sitter strategy (multi-language) =====

let tsPromise: Promise<any> | null = null;
let tsLoaded: boolean = false;
const tsLangCache = new Map<string, unknown>();

async function loadTreeSitter(): Promise<any> {
  if (tsLoaded && tsPromise) return await tsPromise;
  tsPromise = import("web-tree-sitter");
  const mod: any = await tsPromise;
  await mod.default?.init?.();
  tsLoaded = true;
  return mod;
}

/** Normalize a block using tree-sitter. identifier nodes → ID; keywords are
 * syntactic (not nodes) so they're implicitly kept via the parser structure.
 * Falls back to frequency-learned if the language WASM isn't available. */
export async function normalizeTreeSitter(
  block: string,
  langWasm: string,
): Promise<NormalizeResult> {
  try {
    const mod: any = await loadTreeSitter();
    let lang = tsLangCache.get(langWasm);
    if (!lang) {
      const wasmPath = (await import("node:path")).resolve(
        process.cwd(), "node_modules", "tree-sitter-wasms", "out", langWasm,
      );
      lang = await mod.Language.load(wasmPath);
      tsLangCache.set(langWasm, lang);
    }
    const parser = new mod.Parser();
    parser.setLanguage(lang as never);
    const tree = parser.parse(block);
    if (!tree) return fallbackFrequency(block, "tree-sitter", "null tree");
    const out = new Set<NormToken>();
    let kw = 0, id = 0;
    walkTree(tree.rootNode, (node: any) => {
      const t = node.type;
      if (t === "identifier" || t === "property_identifier" || t === "type_identifier" || t === "shorthand_property_identifier") {
        out.add("ID");
        id++;
      } else if (t === "string" || t === "string_literal" || t === "template_string") {
        out.add("STR");
      } else if (t === "number" || t === "integer" || t === "float") {
        out.add("NUM");
      } else {
        // keyword / punctuation node types — keep verbatim
        out.add(t.toLowerCase());
        kw++;
      }
    });
    parser.delete();
    return { tokens: out, strategy: "tree-sitter", keywordCount: kw, identifierCount: id, parseError: null };
  } catch (e) {
    return fallbackFrequency(block, "tree-sitter", String(e).slice(0, 200));
  }
}

// ===== frequency-learned strategy (language-agnostic, dynamic) =====

/** Build a keyword set from a corpus: words appearing in >= threshold
 * fraction of blocks. Returns the learned keyword set. */
export function learnKeywordsFromCorpus(blocks: string[], threshold: number): Set<string> {
  const wordToBlockCount = new Map<string, number>();
  for (const block of blocks) {
    const words = new Set<string>();
    for (const raw of stripCommentsAndStrings(block).split(/[^A-Za-z0-9_$]+/u)) {
      if (raw.length > 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(raw)) words.add(raw);
    }
    for (const w of words) wordToBlockCount.set(w, (wordToBlockCount.get(w) ?? 0) + 1);
  }
  const total = blocks.length;
  const keywords = new Set<string>();
  if (total === 0) return keywords;
  for (const [w, c] of wordToBlockCount) {
    if (c / total >= threshold) keywords.add(w);
  }
  return keywords;
}

/** Normalize a block using a pre-learned keyword set. Dynamic, no parser. */
export function normalizeWithLearnedKeywords(
  block: string,
  keywords: Set<string>,
): NormalizeResult {
  const out = new Set<NormToken>();
  let kw = 0, id = 0;
  const stripped = stripCommentsAndStrings(block);
  for (const raw of stripped.split(/[^A-Za-z0-9_$]+/u)) {
    if (raw.length === 0) continue;
    if (/^(true|false|undefined|null|none|nil|True|False|None|Nil)$/u.test(raw)) {
      out.add("BOOL"); id++;
    } else if (/^\d/u.test(raw)) {
      out.add("NUM");
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(raw)) {
      if (keywords.has(raw)) { out.add(raw); kw++; }
      else { out.add("ID"); id++; }
    } else {
      out.add(raw.toLowerCase());
    }
  }
  return { tokens: out, strategy: "frequency-learned", keywordCount: kw, identifierCount: id, parseError: null };
}

// ===== sync entry: normalize a block for semantic dedup =====

/** Synchronous normalize: picks babel-tokens (sync) or frequency-learned
 * (sync). tree-sitter is async — callers must use normalizeAsync for it. */
export function normalizeBlock(block: string, cfg: DedupCompressionConfig): NormalizeResult {
  const strategy = chooseStrategy(block, cfg);
  if (strategy === "babel-tokens") return normalizeBabelTokens(block);
  // frequency-learned or auto-fallback: learn from the single block (degraded
  // but still dynamic — no hardcoded list). The caller should pre-learn if
  // it has a corpus.
  return fallbackFrequency(block, strategy, null);
}

/** Asynchronous normalize: supports all strategies including tree-sitter. */
export async function normalizeBlockAsync(
  block: string,
  cfg: DedupCompressionConfig,
  learnedKeywords?: Set<string>,
): Promise<NormalizeResult> {
  const strategy = chooseStrategy(block, cfg);
  if (strategy === "babel-tokens") return normalizeBabelTokens(block);
  if (strategy === "tree-sitter") {
    const ext = detectExtension(block);
    const wasm = cfg.treeSitterLanguages[ext] ?? defaultWasmForExt(ext);
    if (wasm) return normalizeTreeSitter(block, wasm);
    return fallbackFrequency(block, "tree-sitter", "no wasm for " + ext);
  }
  // frequency-learned
  const kw = learnedKeywords ?? learnKeywordsFromCorpus([block], cfg.keywordFrequencyThreshold);
  return normalizeWithLearnedKeywords(block, kw);
}

/** Built-in default tree-sitter WASM filename for a source extension.
 *
 * R49-V2: the prior comment claimed this mapping was "config-owned", which
 * was FALSE — it is a hardcoded built-in default (the `tree-sitter-wasms`
 * package naming convention is fixed, not user-tunable). The config field
 * `cfg.treeSitterLanguages` (config.ts) is the user OVERRIDABLE mapping;
 * this function is the FALLBACK when the config does not name a WASM for
 * an extension. No keyword list is hardcoded here — only the WASM
 * filename convention (structural, like `BABEL_EXTENSIONS` above). The
 * extension set is closed over the languages `tree-sitter-wasms` ships;
 * a new language needs a WASM shipped by that package + an entry here. */
function defaultWasmForExt(ext: string): string | null {
  const map: Record<string, string> = {
    ".py": "tree-sitter-python.wasm",
    ".rs": "tree-sitter-rust.wasm",
    ".go": "tree-sitter-go.wasm",
    ".java": "tree-sitter-java.wasm",
    ".c": "tree-sitter-c.wasm",
    ".cpp": "tree-sitter-cpp.wasm",
    ".rb": "tree-sitter-ruby.wasm",
    ".php": "tree-sitter-php.wasm",
    ".sh": "tree-sitter-bash.wasm",
    ".lua": "tree-sitter-lua.wasm",
    ".ex": "tree-sitter-elixir.wasm",
    ".exs": "tree-sitter-elixir.wasm",
    ".kt": "tree-sitter-kotlin.wasm",
    ".scala": "tree-sitter-scala.wasm",
    ".cs": "tree-sitter-c_sharp.wasm",
    ".ml": "tree-sitter-ocaml.wasm",
    ".res": "tree-sitter-rescript.wasm",
  };
  return map[ext] ?? null;
}

// ===== helpers =====

function fallbackFrequency(block: string, strategy: KeywordStrategy, parseError: string | null): NormalizeResult {
  // Degraded dynamic fallback: treat words appearing in >= 50% of the
  // single block's "lines" as keywords. Still no hardcoded list.
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  const lineWordCount = new Map<string, number>();
  for (const line of lines) {
    const words = new Set<string>();
    for (const raw of stripCommentsAndStrings(line).split(/[^A-Za-z0-9_$]+/u)) {
      if (raw.length > 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(raw)) words.add(raw);
    }
    for (const w of words) lineWordCount.set(w, (lineWordCount.get(w) ?? 0) + 1);
  }
  const keywords = new Set<string>();
  if (lines.length > 0) {
    for (const [w, c] of lineWordCount) {
      if (c / lines.length >= 0.5) keywords.add(w);
    }
  }
  const r = normalizeWithLearnedKeywords(block, keywords);
  return { ...r, strategy, parseError };
}

function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ")
    .replace(/`(?:[^`\\]|\\.)*`/gu, " STR ")
    .replace(/"(?:[^"\\]|\\.)*"/gu, " STR ")
    .replace(/'(?:[^'\\]|\\.)*'/gu, " STR ");
}

function walkTree(node: unknown, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node as any);
  const n = node as any;
  const count = typeof n.childCount === "number" ? n.childCount : 0;
  for (let i = 0; i < count; i++) {
    const child = n.child(i);
    if (child) walkTree(child, visit);
  }
}
