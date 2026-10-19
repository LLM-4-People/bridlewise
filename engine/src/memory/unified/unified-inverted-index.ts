import { InputError } from "../../kernel/errors.ts";
/**
 * Inverted index for TF-IDF retrieval (from EXP418).
 *
 * Replaces the per-entry `tfidf: Map<string, number>` (the primary
 * memory hog at 1M+ entries — ~3.5GB for 1M entries × 70 unique tokens
 * × ~50 bytes/Map.entry) with a compact term → postings representation
 * using typed arrays.
 *
 * Design:
 * - `postings` maps term → { ids, tfs } where `ids` is a Uint32Array
 * of entry IDs and `tfs` is a Float32Array of normalized term
 * frequencies. Permanent (never overwritten).
 * - During `finalize`, compute `idfCache` (term → IDF) and `norms`
 * (entry → L2 norm). Weights are computed on the fly during
 * `query` as `weight = tf * idf / norm`. Saves 4 bytes/posting.
 * - `query` iterates only the postings for query terms — O(sum of
 * postings list lengths) instead of O(n × d) brute force.
 *
 * Memory: ~8 bytes per posting. For 1M × 70 unique tokens = 70M postings
 * → ~560MB.
 */
interface PostingBucket {
  ids: number[] | Uint32Array;
  tfs: number[] | Float32Array;
}

const NULL_INDEX = 0xffffffff;

export interface InvertedQueryResult {
  /** Per-entry scores (Float64Array, length = nEntries). */
  scores: Float64Array;
  /** Entry IDs with non-zero score. */
  candidates: number[];
}

export class InvertedIndex {
  private readonly postings = new Map<string, PostingBucket>();
  private idfCache = new Map<string, number>();
  private norms: Float64Array;
  private scoreBuffer: Float64Array;
  private nEntries = 0;
  private finalized = false;

  constructor(initialCapacity: number) {
    if (initialCapacity < 1 || !Number.isFinite(initialCapacity)) {
      throw new InputError(`InvertedIndex: initialCapacity must be a positive finite number, got ${initialCapacity}`);
    }
    this.norms = new Float64Array(initialCapacity);
    this.scoreBuffer = new Float64Array(initialCapacity);
  }

  ensureCapacity(n: number): void {
    if (n <= this.norms.length) return;
    let cap = this.norms.length;
    while (cap < n) cap *= 2;
    const grown = new Float64Array(cap);
    grown.set(this.norms);
    this.norms = grown;
    this.scoreBuffer = new Float64Array(cap);
  }

  add(entryId: number, tf: ReadonlyMap<string, number>): void {
    for (const [term, tfVal] of tf) {
      let bucket = this.postings.get(term);
      if (!bucket) {
        bucket = { ids: [], tfs: [] };
        this.postings.set(term, bucket);
      } else if (bucket.ids instanceof Uint32Array) {
        bucket.ids = Array.from(bucket.ids);
        bucket.tfs = Array.from(bucket.tfs as Float32Array);
      }
      (bucket.ids as number[]).push(entryId);
      (bucket.tfs as number[]).push(tfVal);
    }
    if (this.finalized) this.finalized = false;
    if (entryId + 1 > this.nEntries) this.nEntries = entryId + 1;
  }

  addFromTokens(entryId: number, tokens: readonly string[]): number {
    if (tokens.length === 0) return 0;
    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === undefined) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const len = counts.size || 1;
    for (const [term, count] of counts) {
      let bucket = this.postings.get(term);
      if (!bucket) {
        bucket = { ids: [], tfs: [] };
        this.postings.set(term, bucket);
      } else if (bucket.ids instanceof Uint32Array) {
        bucket.ids = Array.from(bucket.ids);
        bucket.tfs = Array.from(bucket.tfs as Float32Array);
      }
      (bucket.ids as number[]).push(entryId);
      (bucket.tfs as number[]).push(count / len);
    }
    if (this.finalized) this.finalized = false;
    if (entryId + 1 > this.nEntries) this.nEntries = entryId + 1;
    return counts.size;
  }

  /** Finalize: convert JS arrays to typed arrays, compute DF, IDF, L2 norms. */
  finalize(idfMap: Map<string, number>, nEntries: number): void {
    this.idfCache = new Map(idfMap);
    this.nEntries = nEntries;
    this.norms.fill(0);
    for (const [term, bucket] of this.postings) {
      const ids = bucket.ids instanceof Uint32Array ? bucket.ids : new Uint32Array(bucket.ids);
      const tfs = bucket.tfs instanceof Float32Array ? bucket.tfs : new Float32Array(bucket.tfs);
      bucket.ids = ids;
      bucket.tfs = tfs;
      const idf = idfMap.get(term) ?? 0;
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (id === undefined) continue;
        const tf = tfs[i] ?? 0;
        const w = tf * idf;
        this.norms[id] = (this.norms[id] ?? 0) + w * w;
      }
    }
    for (let i = 0; i < this.norms.length; i += 1) {
      const n = this.norms[i] ?? 0;
      if (n > 0) this.norms[i] = Math.sqrt(n);
    }
    this.scoreBuffer = new Float64Array(this.norms.length);
    this.finalized = true;
  }

  computeDf(): Map<string, number> {
    const df = new Map<string, number>();
    for (const [term, bucket] of this.postings) {
      df.set(term, bucket.ids.length);
    }
    return df;
  }

  clear(): void {
    this.postings.clear();
    this.idfCache.clear();
    this.norms.fill(0);
    this.scoreBuffer.fill(0);
    this.nEntries = 0;
    this.finalized = false;
  }

  /**
   * Query the inverted index for a TF-IDF vector (query side).
   * Returns scores + candidate ids (entries with non-zero score).
   * `nEntries` is the number of alive entries (for score buffer sizing).
   */
  queryArray(qVec: ReadonlyMap<string, number>, nEntries: number): InvertedQueryResult {
    if (!this.finalized || nEntries > this.scoreBuffer.length) {
      this.scoreBuffer = new Float64Array(Math.max(nEntries, this.scoreBuffer.length));
    }
    this.scoreBuffer.fill(0, 0, nEntries);
    const candidates: number[] = [];
    for (const [term, qw] of qVec) {
      const bucket = this.postings.get(term);
      if (!bucket) continue;
      const ids = bucket.ids;
      const tfs = bucket.tfs;
      const idf = this.idfCache.get(term) ?? 0;
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (id === undefined) continue;
        const tf = tfs[i] ?? 0;
        const norm = this.norms[id] || 1;
        const score = (tf * idf / norm) * qw;
        this.scoreBuffer[id] = (this.scoreBuffer[id] ?? 0) + score;
      }
    }
    // Collect candidates (entries with non-zero score)
    for (let i = 0; i < nEntries; i += 1) {
      if ((this.scoreBuffer[i] ?? 0) > 0) candidates.push(i);
    }
    return { scores: this.scoreBuffer, candidates };
  }

  /**
   * Filtered query: skip query terms with IDF < idfFloor (common terms
   * with huge postings lists). Used at 100k+ scale to avoid scanning
   * 100k postings for "function" or "test".
   */
  queryFilteredArray(qVec: ReadonlyMap<string, number>, idfFloor: number, nEntries: number): InvertedQueryResult {
    if (!this.finalized || nEntries > this.scoreBuffer.length) {
      this.scoreBuffer = new Float64Array(Math.max(nEntries, this.scoreBuffer.length));
    }
    this.scoreBuffer.fill(0, 0, nEntries);
    const candidates: number[] = [];
    for (const [term, qw] of qVec) {
      const idf = this.idfCache.get(term) ?? 0;
      if (idf < idfFloor) continue;
      const bucket = this.postings.get(term);
      if (!bucket) continue;
      const ids = bucket.ids;
      const tfs = bucket.tfs;
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (id === undefined) continue;
        const tf = tfs[i] ?? 0;
        const norm = this.norms[id] || 1;
        const score = (tf * idf / norm) * qw;
        this.scoreBuffer[id] = (this.scoreBuffer[id] ?? 0) + score;
      }
    }
    for (let i = 0; i < nEntries; i += 1) {
      if ((this.scoreBuffer[i] ?? 0) > 0) candidates.push(i);
    }
    return { scores: this.scoreBuffer, candidates };
  }

  get postingsCount(): number {
    return this.postings.size;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  get entriesTracked(): number {
    return this.nEntries;
  }

  static readonly NULL_INDEX = NULL_INDEX;
}
