// src/shared/memory/token-cap.ts
// Token-cap strategies. Single owner of the pruning/compression logic.
// Strategies (user directive #4): prune-oldest, prune-least-relevant,
// prune-lowest-ebbinghaus, compress, tier. The "tier" strategy (default)
// promotes overflowing hot→warm→cold entries, which the store orchestrates.

import type { MemoryEntry } from "./memory-entry.ts";
import type { TokenCapConfig } from "./memory-config.ts";
import { retentionRank } from "./ebbinghaus.ts";

export type TokenCapContext = Readonly<{
  config: TokenCapConfig;
  /** Pre-computed relevance score per entry id (from the last retrieval). */
  relevanceById: ReadonlyMap<string, number>;
  /** Estimated total tokens of all entries in the scope. */
  totalTokens: number;
  /** Token limit of the scope (hot/warm/cold). */
  scopeLimit: number;
}>;

export type TokenCapDecision = Readonly<{
  keep: readonly MemoryEntry[];
  /** Entries to demote (tier strategy) or drop (prune strategies). */
  evict: readonly MemoryEntry[];
  /** Entries to compress (compress strategy). */
  compress: readonly MemoryEntry[];
  tokensAfter: number;
}>;

export function applyTokenCap(entries: readonly MemoryEntry[], ctx: TokenCapContext): TokenCapDecision {
  if (ctx.totalTokens <= ctx.scopeLimit) {
    return { keep: entries, evict: [], compress: [], tokensAfter: ctx.totalTokens };
  }
  const trigger = Math.floor(ctx.scopeLimit * ctx.config.trimTriggerRatio);
  const target = Math.floor(ctx.scopeLimit * ctx.config.compressTargetRatio);
  switch (ctx.config.strategy) {
    case "prune-oldest":
      return pruneOldest(entries, ctx, target);
    case "prune-least-relevant":
      return pruneLeastRelevant(entries, ctx, target);
    case "prune-lowest-ebbinghaus":
      return pruneLowestEbbinghaus(entries, ctx, target);
    case "compress":
      return compressStrategy(entries, ctx, trigger, target);
    case "tier":
      return pruneOldest(entries, ctx, target); // tier promotion is orchestrated by the store; the cap itself evicts oldest.
    default:
      return { keep: entries, evict: [], compress: [], tokensAfter: ctx.totalTokens };
  }
}

function pruneOldest(entries: readonly MemoryEntry[], _ctx: TokenCapContext, target: number): TokenCapDecision {
  const sorted = [...entries].sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
  const keep: MemoryEntry[] = [];
  const evict: MemoryEntry[] = [];
  let tokens = 0;
  for (const e of sorted) {
    if (tokens + e.tokenEstimate <= target) { keep.push(e); tokens += e.tokenEstimate; }
    else evict.push(e);
  }
  return { keep, evict, compress: [], tokensAfter: tokens };
}

function pruneLeastRelevant(entries: readonly MemoryEntry[], ctx: TokenCapContext, target: number): TokenCapDecision {
  const scored = entries.map((e) => ({ e, r: ctx.relevanceById.get(e.id) ?? 0 }));
  scored.sort((a, b) => b.r - a.r);
  const keep: MemoryEntry[] = [];
  const evict: MemoryEntry[] = [];
  let tokens = 0;
  for (const { e } of scored) {
    if (tokens + e.tokenEstimate <= target) { keep.push(e); tokens += e.tokenEstimate; }
    else evict.push(e);
  }
  return { keep, evict, compress: [], tokensAfter: tokens };
}

function pruneLowestEbbinghaus(entries: readonly MemoryEntry[], ctx: TokenCapContext, target: number): TokenCapDecision {
  const scored = entries.map((e) => ({ e, r: retentionRank(e.ebbinghausScore, ctx.config.compressTargetRatio) }));
  scored.sort((a, b) => b.r - a.r);
  const keep: MemoryEntry[] = [];
  const evict: MemoryEntry[] = [];
  let tokens = 0;
  for (const { e } of scored) {
    if (tokens + e.tokenEstimate <= target) { keep.push(e); tokens += e.tokenEstimate; }
    else evict.push(e);
  }
  return { keep, evict, compress: [], tokensAfter: tokens };
}

function compressStrategy(entries: readonly MemoryEntry[], ctx: TokenCapContext, trigger: number, target: number): TokenCapDecision {
  // Compress: when total exceeds trigger, mark the oldest lowest-ebbinghaus
  // entries (down to target) for compression. The store replaces their
  // content with a deterministic summary.
  if (ctx.totalTokens <= trigger) {
    return { keep: entries, evict: [], compress: [], tokensAfter: ctx.totalTokens };
  }
  const scored = entries.map((e) => ({ e, r: retentionRank(e.ebbinghausScore, ctx.config.compressTargetRatio) }));
  scored.sort((a, b) => a.r - b.r);
  const compress: MemoryEntry[] = [];
  const keep: MemoryEntry[] = [];
  let tokens = ctx.totalTokens;
  for (const { e } of scored) {
    if (tokens <= target) { keep.push(e); continue; }
    compress.push(e);
    tokens -= Math.floor(e.tokenEstimate * (1 - ctx.config.compressTargetRatio));
  }
  return { keep, evict: [], compress, tokensAfter: tokens };
}
