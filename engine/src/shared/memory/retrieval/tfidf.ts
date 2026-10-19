// src/shared/memory/retrieval/tfidf.ts
// CANONICAL TF-IDF. Single owner of the TF-IDF index + query. Replaces:
// 1. memory/tool-result-retrieval.ts `buildTfidfIndex`/`tfidfQuery`/`termFrequency`
// 2. shared/tf-idf.ts `tf`/`idf`/`bm25Idf` (BM25 idf kept here too — search consumes it)
// Uses the canonical `tokenize` + `termFrequency` from text-utils.ts (no
// duplicate tokenization).

import { deepFreeze } from "../../../kernel/integrity.ts";
import { termFrequency, tokenize, type TextTokenizerConfig } from "./text-utils.ts";
import { cosineMaps } from "./cosine.ts";

export type TfidfIndex = Readonly<{
  readonly docVectors: readonly ReadonlyMap<string, number>[];
  readonly idf: ReadonlyMap<string, number>;
  readonly docCount: number;
}>;

/** Build a TF-IDF index over a set of documents (strings). */
export function buildTfidfIndex(docs: readonly string[], tokenizer: TextTokenizerConfig): TfidfIndex {
  const docTokens = docs.map((d) => tokenize(d, tokenizer));
  const docVectors = docTokens.map((toks) => termFrequency(toks));
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    const seen = new Set<string>();
    for (const t of toks) {
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  const N = docs.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    // Smoothed IDF (standard form, same as the old impl): ln((N+1)/(df+1)) + 1.
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
  return deepFreeze({ docVectors, idf, docCount: N }) as TfidfIndex;
}

/** Build a TF-IDF weighted vector for a single document against an index. */
export function tfidfWeightVector(tokens: readonly string[], index: TfidfIndex): Map<string, number> {
  const tf = termFrequency(tokens);
  const vec = new Map<string, number>();
  for (const [term, freq] of tf) {
    const w = freq * (index.idf.get(term) ?? 0);
    if (w > 0) vec.set(term, w);
  }
  return vec;
}

export type TfidfHit = Readonly<{ docIndex: number; score: number }>;

/** Score a query against a TF-IDF index (cosine on weighted vectors). */
export function tfidfQuery(query: string, index: TfidfIndex, tokenizer: TextTokenizerConfig): readonly TfidfHit[] {
  const qTokens = tokenize(query, tokenizer);
  if (qTokens.length === 0) return [];
  const qVec = tfidfWeightVector(qTokens, index);
  if (qVec.size === 0) return [];
  const hits: TfidfHit[] = [];
  for (let i = 0; i < index.docVectors.length; i += 1) {
    const dv = index.docVectors[i];
    if (!dv || dv.size === 0) continue;
    const score = cosineMaps(qVec, dv);
    if (score > 0) hits.push({ docIndex: i, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** BM25 IDF (Robertson-Sparck Jones). Single owner — search consumes this. */
export function bm25Idf(df: number, n: number): number {
  if (df === 0 || n === 0) return 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export function bm25Score(tfVal: number, df: number, n: number, docLen: number, avgdl: number, k1: number, b: number): number {
  const idfVal = bm25Idf(df, n);
  const denom = tfVal + k1 * (1 - b + b * (docLen / (avgdl || 1)));
  return (idfVal * (tfVal * (k1 + 1))) / (denom || 1);
}
