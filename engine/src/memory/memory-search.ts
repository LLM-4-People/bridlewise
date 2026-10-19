import { deepFreeze } from "../kernel/integrity.ts";
import {
  buildInvertedIndex as buildTextInvertedIndex,
  type InvertedIndex as TextInvertedIndex,
} from "../shared/memory/retrieval/inverted-index.ts";
import {
  DEFAULT_TOKENIZER_CONFIG,
  tokenize as sharedTokenize,
  type TextTokenizerConfig,
} from "../shared/memory/retrieval/text-utils.ts";
import type {
  MemoryEntry,
  MemorySearchEngineKind,
  MemorySearchQuery,
  MemorySearchResult,
} from "./memory-types.ts";

/**
 * Memory search engine.
 *
 * Search has no external dependencies. The `MemorySearchEngine` interface is
 * the one door: a new way of finding candidates is a new implementation of
 * it, and every consumer — the memory store, the attempt history, the
 * context manager — reaches it through the door it already uses. Two
 * implementations exist today, `lexical` and `inverted-index`; which one a
 * store uses is a configured value (`memory.searchEngine`), not a call-site
 * decision. A future vector or hybrid engine plugs into the same interface.
 *
 * Lexical search uses a token-overlap scoring algorithm:
 * 1. Tokenize the query and each entry's content (lowercase, split on
 * non-alphanumeric boundaries).
 * 2. Compute a TF-based score: the fraction of query tokens that appear
 * in the entry content, weighted by the number of occurrences.
 * 3. Apply exact-match boosts for agent, topic, tags, and tier filters.
 * 4. Rank descending by score, then by recency (timestamp) as a
 * deterministic tiebreaker.
 *
 * Research findings (2026-07-16, Kagi search):
 * - Microsoft Harrier-oss-v1-0.6b (MIT, 0.6B params, Qwen3-0.6B base):
 * highest-ranked open-source embedding model with unrestricted
 * commercial license. AVG nDCG@3 = 0.8911.
 * - Qwen3-Embedding family (Apache-2.0): 0.6B (nDCG@10 0.751, 23ms),
 * 4B (nDCG@10 0.802, 28ms), 8B (nDCG@10 0.818, 56ms).
 * - BAAI/bge-m3 (MIT): nDCG@10 0.753, 29ms — reliable lightweight option.
 * - BM25 remains competitive on domains with dense entity language.
 * - For v1, lexical search is sufficient and has zero dependencies.
 * The `SemanticSearchEngine` interface is ready for a future
 * embedding-based engine; no heavy dependency is added now.
 *
 * Per the root policy invariant `retrievalScoreAsTruthAllowed: false`,
 * search results are discovery evidence only. They cannot alone block an
 * attempt, approve an edit, or resolve a conflict.
 */

export type MemorySearchEngine = Readonly<{
  search(entries: readonly MemoryEntry[], query: MemorySearchQuery): readonly MemorySearchResult[];
}>;

export type SemanticSearchEngine = Readonly<{
  readonly engineId: string;
  readonly modelId: string | null;
  embed(text: string): Promise<readonly number[]>;
  search(embeddings: readonly number[], entries: readonly MemoryEntry[], limit: number): Promise<readonly MemorySearchResult[]>;
}>;

const LEXICAL_ENGINE: MemorySearchEngine = {
  search(entries: readonly MemoryEntry[], query: MemorySearchQuery): readonly MemorySearchResult[] {
    return lexicalSearch(entries, query);
  },
};

export function createLexicalSearchEngine(): MemorySearchEngine {
  return LEXICAL_ENGINE;
}

export function lexicalSearch(
  entries: readonly MemoryEntry[],
  query: MemorySearchQuery,
): readonly MemorySearchResult[] {
  const filtered = applyFilters(entries, query);
  const queryTokens = query.text !== null ? tokenize(query.text) : [];
  const results: MemorySearchResult[] = [];
  for (const entry of filtered) {
    const { score, matchedFields } = scoreEntry(entry, query, queryTokens);
    if (score > 0 || queryTokens.length === 0) {
      results.push({ entry, score, matchedFields: deepFreeze(matchedFields) });
    }
  }
  results.sort(compareSearchResults);
  const limited = results.slice(0, query.limit);
  return deepFreeze(limited);
}

function applyFilters(
  entries: readonly MemoryEntry[],
  query: MemorySearchQuery,
): readonly MemoryEntry[] {
  const result: MemoryEntry[] = [];
  for (const entry of entries) {
    if (query.tier !== null && entry.tier !== query.tier) continue;
    if (query.agentId !== null && entry.agentId !== query.agentId) continue;
    if (query.topic !== null && entry.topic !== query.topic) continue;
    if (query.fromTime !== null && entry.timestamp < query.fromTime) continue;
    if (query.toTime !== null && entry.timestamp > query.toTime) continue;
    if (query.tags.length > 0 && !tagsMatch(entry.tags, query.tags)) continue;
    result.push(entry);
  }
  return deepFreeze(result);
}

function tagsMatch(entryTags: readonly string[], queryTags: readonly string[]): boolean {
  const entrySet = new Set(entryTags);
  for (const tag of queryTags) {
    if (!entrySet.has(tag)) return false;
  }
  return true;
}

function scoreEntry(
  entry: MemoryEntry,
  query: MemorySearchQuery,
  queryTokens: readonly string[],
): { score: number; matchedFields: readonly string[] } {
  let score = 0;
  const matchedFields: string[] = [];

  if (queryTokens.length > 0) {
    const contentTokens = tokenize(entry.content);
    const contentTokenCounts = countTokens(contentTokens);
    let overlap = 0;
    let totalWeight = 0;
    const queryTokenSet = new Set(queryTokens);
    for (const token of queryTokenSet) {
      const count = contentTokenCounts.get(token);
      if (count !== undefined && count > 0) {
        overlap += 1;
        totalWeight += count;
      }
    }
    if (overlap > 0) {
      const coverage = overlap / queryTokenSet.size;
      const density = Math.min(totalWeight / (contentTokens.length || 1), 1);
      score += coverage * 0.7 + density * 0.3;
      matchedFields.push("content");
    }
  }

  if (query.topic !== null && entry.topic === query.topic) {
    score += 0.15;
    matchedFields.push("topic");
  }

  if (query.agentId !== null && entry.agentId === query.agentId) {
    score += 0.1;
    matchedFields.push("agent");
  }

  if (query.tags.length > 0) {
    score += 0.1 * query.tags.length;
    matchedFields.push("tags");
  }

  if (query.tier !== null && entry.tier === query.tier) {
    score += 0.05;
    matchedFields.push("tier");
  }

  return { score, matchedFields: deepFreeze(matchedFields) };
}

function compareSearchResults(a: MemorySearchResult, b: MemorySearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.entry.timestamp !== b.entry.timestamp) {
    return b.entry.timestamp > a.entry.timestamp ? 1 : -1;
  }
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

/**
 * How memory text is cut into terms — derived from the canonical tokenizer
 * profile, overriding only what memory search deliberately differs on.
 *
 * Memory keeps every word: an entry is a sentence a person or an agent wrote
 * on purpose, so a stopword list tuned for code retrieval would drop the
 * common words that carry a recollection ("what we decided about the retry").
 * Punctuation is dropped rather than kept, because memory content is prose,
 * not identifiers.
 *
 * It is one named profile rather than an object written at each call site
 * because BOTH the scorer and the index must cut text the same way. If they
 * ever disagreed, the index would rule out an entry the scorer would have
 * matched, and the result would be a silently smaller answer that still
 * looked ordered and plausible. Sharing one profile makes that divergence
 * unrepresentable rather than merely unlikely.
 */
const MEMORY_TOKENIZER_PROFILE: TextTokenizerConfig = deepFreeze({
  minLength: DEFAULT_TOKENIZER_CONFIG.minLength,
  stopwords: new Set<string>(),
  keepCodePunct: false,
});

export function tokenize(text: string): readonly string[] {
  // Delegate to the CANONICAL tokenizer in src/shared/memory/retrieval/
  // text-utils.ts. This file was a duplicate tokenize owner; now it is a
  // thin re-export so the old memory-store API keeps its import path.
  return sharedTokenize(text, MEMORY_TOKENIZER_PROFILE);
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

// ===========================================================================
// The second engine behind the same interface.
//
// `lexicalSearch` reads and tokenizes every stored entry on every query, so
// the cost of one question grows with everything ever remembered and is paid
// again for the next question. The engine below folds the corpus once into a
// token → entries map and then scores only the entries a query's own words
// can reach.
//
// It is an ENGINE, not a second search function: it implements the
// `MemorySearchEngine` interface this file already declared for exactly this
// purpose, so the memory store, the attempt history and every consumer reach
// it through the door they already use. Nothing gains a new entry point.
//
// The index structure itself is NOT built here. `src/shared/memory/retrieval/
// inverted-index.ts` already owns "term → the documents containing it"; this
// engine supplies the documents and interprets the postings. A second posting
// builder would be a second thing to get right.
// ===========================================================================

/**
 * The text a query can match an entry BY. Content is the substance; topic and
 * tags are indexed alongside it because a query naming a topic word should
 * reach the entry even when the body never repeats it.
 */
function indexableText(entry: MemoryEntry): string {
  if (entry.topic === null && entry.tags.length === 0) return entry.content;
  return [entry.content, entry.topic ?? "", ...entry.tags].join("\n");
}

/**
 * Can this query score an entry that shares NO word with it?
 *
 * `scoreEntry` adds a boost for a matching topic, agent, tier or tag — and
 * `applyFilters` has already discarded every entry that does not match those,
 * so when a query names any of them, EVERY surviving entry scores above zero
 * whether or not its text overlaps the query. Narrowing by word overlap would
 * then drop entries that belong in the answer.
 *
 * This is the condition under which the index may narrow at all, and it is
 * why the two engines return the same results rather than merely similar
 * ones. Getting it wrong does not fail loudly: the answer stays ordered,
 * scored and plausible, and is simply missing rows.
 */
function scoresEveryFilteredEntry(query: MemorySearchQuery): boolean {
  return query.topic !== null
    || query.agentId !== null
    || query.tier !== null
    || query.tags.length > 0;
}

type MemoryIndexCache = {
  /** The exact entry list the index was folded from. */
  entries: readonly MemoryEntry[];
  /** Position i holds the id of the document at posting index i. */
  ids: readonly string[];
  index: TextInvertedIndex;
};

/**
 * Is the cached fold still a description of `entries`?
 *
 * Compared by identity, entry by entry. Memory entries are frozen and are
 * replaced rather than mutated (promote, demote and reload all mint a new
 * object), so identity is exact — it cannot report a stale index as fresh.
 *
 * A length-and-endpoints signature was the obvious cheaper alternative and is
 * wrong: replacing an entry in the middle leaves the length and both ends
 * unchanged, so the fold would be reused against content it no longer
 * describes. Comparing references costs one pointer test per entry, allocates
 * nothing, and is far below the cost of the tokenization it protects.
 */
function cacheDescribes(cache: MemoryIndexCache, entries: readonly MemoryEntry[]): boolean {
  if (cache.entries.length !== entries.length) return false;
  for (let i = 0; i < entries.length; i += 1) {
    if (cache.entries[i] !== entries[i]) return false;
  }
  return true;
}

function foldEntries(entries: readonly MemoryEntry[]): MemoryIndexCache {
  const documents: string[] = [];
  const ids: string[] = [];
  for (const entry of entries) {
    documents.push(indexableText(entry));
    ids.push(entry.id);
  }
  return {
    entries,
    ids,
    index: buildTextInvertedIndex(documents, MEMORY_TOKENIZER_PROFILE),
  };
}

/**
 * The ids a query's words can reach, or null when there are no words to
 * narrow by (a pure filter query, which every filtered entry answers).
 *
 * When no query word appears anywhere the result is the EMPTY set, not null:
 * the scorer would award zero to every entry, so saying so in one step is the
 * same answer arrived at without reading the corpus.
 */
function reachableIds(cache: MemoryIndexCache, queryTokens: readonly string[]): Set<string> | null {
  if (queryTokens.length === 0) return null;
  const reached = new Set<string>();
  for (const token of new Set(queryTokens)) {
    const postings = cache.index.postings.get(token);
    if (postings === undefined) continue;
    for (const docIndex of postings) {
      const id = cache.ids[docIndex];
      if (id !== undefined) reached.add(id);
    }
  }
  return reached;
}

/**
 * A {@link MemorySearchEngine} that scores only the entries a query can
 * reach. The fold is kept until the entry set changes, so a store answering
 * many questions pays for one pass over its content rather than one per
 * question.
 *
 * Each call returns its OWN engine: the fold is state about one store's
 * entries, and two stores sharing it would thrash the cache and — worse —
 * could serve one store's postings while its own entries had changed.
 */
export function createInvertedIndexSearchEngine(): MemorySearchEngine {
  let cache: MemoryIndexCache | null = null;
  return {
    search(entries: readonly MemoryEntry[], query: MemorySearchQuery): readonly MemorySearchResult[] {
      if (cache === null || !cacheDescribes(cache, entries)) {
        cache = foldEntries(entries);
      }
      const queryTokens = query.text !== null ? tokenize(query.text) : [];
      const filtered = applyFilters(entries, query);
      const reached = scoresEveryFilteredEntry(query) ? null : reachableIds(cache, queryTokens);
      const results: MemorySearchResult[] = [];
      for (const entry of filtered) {
        if (reached !== null && !reached.has(entry.id)) continue;
        const { score, matchedFields } = scoreEntry(entry, query, queryTokens);
        if (score > 0 || queryTokens.length === 0) {
          results.push({ entry, score, matchedFields: deepFreeze(matchedFields) });
        }
      }
      results.sort(compareSearchResults);
      return deepFreeze(results.slice(0, query.limit));
    },
  };
}

/**
 * The ONE place a configured engine name becomes an engine.
 *
 * Consumers name a kind; they never construct an engine themselves. That is
 * what keeps "which engine is in use" answerable from the configuration
 * rather than from whichever call site was edited last.
 */
export function resolveMemorySearchEngine(kind: MemorySearchEngineKind): MemorySearchEngine {
  return kind === "lexical" ? LEXICAL_ENGINE : createInvertedIndexSearchEngine();
}

export function computeContextFingerprint(input: {
  repositoryHash?: string;
  configHash?: string;
  agentId?: string;
  toolId?: string;
  targetPath?: string;
  intentHash?: string;
}): string {
  const parts: string[] = [];
  if (input.repositoryHash !== undefined) parts.push(`repo:${input.repositoryHash}`);
  if (input.configHash !== undefined) parts.push(`cfg:${input.configHash}`);
  if (input.agentId !== undefined) parts.push(`agent:${input.agentId}`);
  if (input.toolId !== undefined) parts.push(`tool:${input.toolId}`);
  if (input.targetPath !== undefined) parts.push(`target:${input.targetPath}`);
  if (input.intentHash !== undefined) parts.push(`intent:${input.intentHash}`);
  return parts.join("|");
}
