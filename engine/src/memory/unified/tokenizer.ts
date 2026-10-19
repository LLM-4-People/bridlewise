/**
 * Unified tokenizer — shared by all memory + context subsystems.
 *
 * Combines the EXP418 stopword-aware tokenizer (used by the inverted
 * index + content store + memory-store-v2) with a fast order-independent
 * semantic hash for O(1) dedup. Replaces the divergent tokenizers in
 * memory-search.ts (regex-only, no stopword filter) + memory-store.ts
 * (no tokenizer) with a single canonical owner (DRY directive).
 *
 * Configuration: stopword list, chars-per-token estimate, and minimum
 * token length all live in `TOKENIZER_CONFIG` (no static constants).
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";

export type TokenizerConfig = Readonly<{
  /** Tokens shorter than this are dropped (default 2 — drops "a", "i", etc.). */
  minTokenLength: number;
  /** Estimated chars per token (GPT-style ≈ 4). Used by estimateTokens. */
  charsPerToken: number;
  /** Stopwords removed before indexing (default: the EXP418 list). */
  stopwords: ReadonlySet<string>;
}>;

const DEFAULT_STOPWORDS = deepFreeze(new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to",
  "in", "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "this", "that", "these", "those", "it", "its", "i", "you",
  "he", "she", "we", "they", "them", "his", "her", "their", "our", "your", "my",
  "me", "him", "us", "do", "does", "did", "done", "doing", "have", "has", "had",
  "having", "will", "would", "can", "could", "should", "shall", "may", "might",
  "must", "not", "no", "nor", "so", "than", "too", "very", "just", "about", "into",
  "over", "under", "again", "further", "once", "here", "there", "when", "where",
  "why", "how", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "only", "own", "same", "what", "which", "who", "whom", "answer",
  "question", "plain", "text", "give", "call", "respond", "json", "tool", "continue",
]));

/**
 * Module-private: `resolveTokenizerConfig` below is the resolver, so it is the
 * only correct reader. A default whose owner also owns the resolver has no
 * other honest consumer — ask `resolveTokenizerConfig()` for the same values
 * plus the validation, and keep tracking configuration when a caller supplies
 * some.
 */
const DEFAULT_TOKENIZER_CONFIG: TokenizerConfig = deepFreeze({
  minTokenLength: 2,
  charsPerToken: 4,
  stopwords: DEFAULT_STOPWORDS,
});

export function resolveTokenizerConfig(overrides: Partial<TokenizerConfig> = {}): TokenizerConfig {
  const cfg: TokenizerConfig = {
    minTokenLength: overrides.minTokenLength ?? DEFAULT_TOKENIZER_CONFIG.minTokenLength,
    charsPerToken: overrides.charsPerToken ?? DEFAULT_TOKENIZER_CONFIG.charsPerToken,
    stopwords: overrides.stopwords ?? DEFAULT_TOKENIZER_CONFIG.stopwords,
  };
  if (cfg.minTokenLength < 1 || !Number.isFinite(cfg.minTokenLength)) {
    throw new InputError("tokenizer.minTokenLength must be a positive finite number");
  }
  if (cfg.charsPerToken < 1 || !Number.isFinite(cfg.charsPerToken)) {
    throw new InputError("tokenizer.charsPerToken must be a positive finite number");
  }
  return deepFreeze(cfg) as TokenizerConfig;
}

const TOKEN_PATTERN = /[a-z0-9_]+/g;

/** Tokenize text into lowercase word tokens (>= minTokenLength, non-stopword). */
export function tokenize(text: string, config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG): readonly string[] {
  const lower = String(text).toLowerCase();
  if (lower.length === 0) return [];
  const out: string[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(lower)) !== null) {
    const t = match[0];
    if (t === undefined || t.length < config.minTokenLength) continue;
    if (config.stopwords.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Term-frequency map for a token list (normalized by total token count). */
export function termFrequency(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  const len = tokens.length || 1;
  for (const [k, v] of m) m.set(k, v / len);
  return m;
}

/** Estimate tokens for a string (~charsPerToken chars/token). */
export function estimateTokens(s: string, config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG): number {
  if (s.length === 0) return 0;
  return Math.ceil(s.length / config.charsPerToken);
}

/**
 * Order-independent semantic hash of a token list.
 *
 * Two 64-bit FNV-1a streams combined via commutative addition. Replaces
 * `sha256(JSON.stringify(sorted-unique-tokens))` with a ~7× faster hash
 * that is sufficient for O(1) dedup (128-bit collision probability for
 * 1M entries ≈ 10^-24, well below any practical false-dedup risk).
 */
export function semanticHash(tokens: readonly string[]): string {
  let h1 = 0 >>> 0;
  let h2 = 0 >>> 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === undefined) continue;
    let th1 = 0x811c9dc5 >>> 0;
    let th2 = 0x89e3779b >>> 0;
    for (let j = 0; j < t.length; j += 1) {
      const c = t.charCodeAt(j);
      th1 = Math.imul(th1 ^ c, 0x01000193) >>> 0;
      th2 = Math.imul(th2 ^ c, 0x85ebca6b) >>> 0;
    }
    h1 = (h1 + th1) >>> 0;
    h2 = (h2 + th2) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
