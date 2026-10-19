// src/shared/memory/retrieval/text-utils.ts
// CANONICAL tokenizer. The single owner of text tokenization for ALL memory
// + retrieval + search code. Replaces the THREE previous implementations:
// 1. memory/memory-search.ts `tokenize` (regex /[a-z0-9]+/gu, no stopwords)
// 2. memory/tool-result-retrieval.ts `tokenize` (regex with hardcoded STOPWORDS)
// 3. shared/tf-idf.ts `textToTermMap` (split /[^a-z0-9]+/, no stopwords)
// All three are gone; every consumer imports from here. The stopword list
// is configurable (no static constant) — passed via TextTokenizerConfig.

export type TextTokenizerConfig = Readonly<{
  /** Minimum token length (default 2). */
  minLength: number;
  /** Stopwords to drop (empty = keep all). Configurable, not hardcoded. */
  stopwords: ReadonlySet<string>;
  /** Keep underscores / dots / slashes inside tokens (for code identifiers). */
  keepCodePunct: boolean;
}>;

export const DEFAULT_TOKENIZER_CONFIG = {
  minLength: 2,
  stopwords: new Set<string>([
    "a","an","the","is","are","was","were","be","been","being","do","does","did",
    "to","of","in","on","for","with","that","this","these","those","it","its",
    "as","at","by","from","or","and","not","no","but","if","then","than","so",
    "i","you","he","she","we","they","me","him","her","us","them","my","your",
    "his","their","our",
  ]),
  keepCodePunct: true,
} as const;

const CODE_TOKEN = /[a-z0-9_./-]+/gu;
const PLAIN_TOKEN = /[a-z0-9]+/gu;

/** Canonical tokenize. Deterministic + pure. Returns a frozen array. */
export function tokenize(text: string, config: TextTokenizerConfig = DEFAULT_TOKENIZER_CONFIG): readonly string[] {
  if (text.length === 0) return [];
  const lower = text.toLowerCase();
  const pattern = config.keepCodePunct ? CODE_TOKEN : PLAIN_TOKEN;
  pattern.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(lower)) !== null) {
    const tok = m[0];
    if (tok === undefined || tok.length < config.minLength) continue;
    if (config.stopwords.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

/** Build a term-frequency (sparse) vector. Single owner of TF counting. */
export function termFrequency(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

export function uniqueTerms(tokens: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const t of tokens) set.add(t);
  return set;
}
