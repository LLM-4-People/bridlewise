// src/shared/memory/retrieval/inverted-index.ts
// Inverted index for fast lexical retrieval. A classic posting-list index
// (single owner — there was no prior inverted-index impl in the candidate;
// this is a benchmark alternative to TF-IDF). Research: inverted indexes
// are the standard O(1)-lookup structure for keyword retrieval (Brin/Page
// PageRank-era IR).

import type { TextTokenizerConfig } from "./text-utils.ts";
import { tokenize } from "./text-utils.ts";

export type InvertedIndex = Readonly<{
  /** term -> sorted doc indices that contain it. */
  readonly postings: ReadonlyMap<string, readonly number[]>;
  readonly docCount: number;
  /** docIndex -> term count (for length normalization + ranking). */
  readonly docLengths: readonly number[];
}>;

export function buildInvertedIndex(docs: readonly string[], tokenizer: TextTokenizerConfig): InvertedIndex {
  const postings = new Map<string, number[]>();
  const docLengths: number[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    const toks = tokenize(docs[i] ?? "", tokenizer);
    docLengths.push(toks.length);
    const seen = new Set<string>();
    for (const t of toks) {
      if (seen.has(t)) continue;
      seen.add(t);
      const list = postings.get(t);
      if (list) list.push(i);
      else postings.set(t, [i]);
    }
  }
  const frozenPostings = new Map<string, readonly number[]>();
  for (const [k, v] of postings) frozenPostings.set(k, v);
  return { postings: frozenPostings, docCount: docs.length, docLengths };
}

export type InvertedHit = Readonly<{ docIndex: number; score: number }>;

/** Query the inverted index. Score = matched-query-terms / total-query-terms
 * (a coverage ratio, length-normalized lightly). Returns ranked hits. */
export function invertedQuery(query: string, index: InvertedIndex, tokenizer: TextTokenizerConfig): readonly InvertedHit[] {
  const qTerms = tokenize(query, tokenizer);
  if (qTerms.length === 0) return [];
  const qSet = new Set(qTerms);
  const candidateScores = new Map<number, number>();
  for (const term of qSet) {
    const list = index.postings.get(term);
    if (!list) continue;
    for (const docIndex of list) {
      candidateScores.set(docIndex, (candidateScores.get(docIndex) ?? 0) + 1);
    }
  }
  const hits: InvertedHit[] = [];
  const totalQ = qSet.size;
  const avgdl = index.docLengths.reduce((s, l) => s + l, 0) / (index.docCount || 1) || 1;
  for (const [docIndex, matched] of candidateScores) {
    const dl = index.docLengths[docIndex] ?? 1;
    const coverage = matched / totalQ;
    const lenNorm = avgdl / (dl || 1);
    hits.push({ docIndex, score: coverage * Math.min(lenNorm, 2) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}
