// src/quality-packs/prevention/duplicate-body-types.ts
// Types, interfaces, and constants for the D3 duplicate-body detector.
// Extracted from duplicate-body-detector.ts for maintainability (EXP472).
// No runtime behavior — pure type definitions + defaults.

import type { AstNode } from "./ast-helpers.ts";

export interface DuplicateBodyFinding {
  file: string;
  line: number;
  name: string;
  bodySize: number;
  passes: "exact" | "normalized" | "both" | "embedding";
  cluster: string;
}

export interface DuplicateBodyAllowlistCross {
  hash: string;
  fileA: string;
  fileB: string;
  reason: string;
  contractTest?: string;
}

/**
 * An accepted clone group's members in ONE file: how many functions of the
 * group (`hash`) the file may hold. Identified by the group and the file,
 * never by line numbers (an edit above the group moved its lines and read
 * as a stale entry, WF1B3B-ALLOWLISTS): one more member than `count` is a
 * new duplicate, one fewer is debt that fell (the entry is stale until its
 * count is lowered).
 */
export interface DuplicateBodyAllowlistSameFile {
  hash: string;
  file: string;
  count: number;
  reason: string;
}

export interface DuplicateBodyEmbeddingPass3Options {
  /** Master switch. When `false` (the default), Pass 3 produces no findings. */
  enabled: boolean;
  /** Embedding-cosine threshold (0..1). Default 0.92 — catches the
   * v9-find-filter-first semantic duplicate (embScore 0.9212, the hardest
   * TP that Pass 1/2/2.5/2.6 miss: early-return ↔ filter+first) with 0% FP
   * on the 3 by-type control pairs + 0% FP on 5 production codebases
   * (babel, typescript, zod, express, lodash — test/vendor files excluded,
   * per EXP407). The 2 zod locale findings at 0.92 (hr.ts ↔ pl.ts) are REAL
   * DRY violations (same code structure, different translations) — TRUE
   * POSITIVES, not FPs.
   *
   * Lower values catch more semantic duplicates but increase FPs (at 0.4,
   * ~21,000 cross-file FPs on lodash 612 functions). Higher values are
   * more conservative (at 0.95, 0 FPs everywhere but 0 new TPs). */
  threshold?: number;
  /** Restrict Pass 3 to cross-file pairs only (default `true`). Same-file
   * pairs are already covered by Pass 1/2/2.5/2.6; allowing same-file in
   * Pass 3 produces many FPs on test files (multiple anonymous test setups
   * with similar structure). */
  crossFileOnly?: boolean;
  /** Require the pair's statement-count ratio to be strictly < 1.0 (default
   * `true`). This rejects "same-structure-different-behavior" FPs (the 3
   * by-type control pairs v6-2, v6-3, v6-5 all have stmtRatio = 1.0). Real
   * semantic duplicates (N1-N6+7) have DIFFERENT statement counts (different
   * structure, same behavior) — stmtRatio < 0.82. */
  requireStructuralDifference?: boolean;
  /** Require the string-literal VALUE sequence to match (default `true`).
   * This rejects "same-tokens-different-order" FPs — the most common FP
   * pattern that the structural filter misses. N3-CTRL (V5 control: ternary
   * with swapped branches) has stmtRatio 0.6 (different statement count:
   * 3 vs 5) so it passes the structural filter, but its string literals
   * appear in a DIFFERENT order ("big"/"small" swapped, "above"/"below"
   * swapped) → rejected. Real semantic duplicates (v9-find-filter-first:
   * early-return ↔ filter+first) have the same string literals in the SAME
   * order (the predicate and log messages are identical) → admitted.
   *
   * The check: extract the ordered sequence of StringLiteral VALUES from
   * each function. If the two sequences are DIFFERENT (different order OR
   * different values) AND the two sequences have the same SET of values,
   * reject (likely swapped-branch FP). If the sets differ, the pair has
   * different string content — admit (Pass 1/2 should have caught exact
   * duplicates; Pass 3 is for semantic duplicates with different structure). */
  requireStringLiteralOrderMatch?: boolean;
  /** Pass 3's own `minBodySize` filter (default: the top-level `minBodySize`).
   * Set lower than the top-level to let Pass 3 catch small semantic duplicates
   * that Pass 2 filters out. WARNING: lowering this re-introduces the small-
   * function FPs that EXP406 identified (the 5 FPs at threshold 0.4 all have
   * bodySize < 80); the structural filter (`requireStructuralDifference`)
   * does NOT eliminate them. */
  minBodySize?: number;
  /** Pass 3's own `minTokenCount` filter (default: the top-level
   * `minTokenCount`). Set lower than the top-level to let Pass 3 catch small
   * semantic duplicates that Pass 2 filters out. WARNING: lowering this
   * re-introduces small-function FPs; the structural filter does NOT
   * eliminate them all. */
  minTokenCount?: number;
  /** Model identifier (default `Xenova/all-MiniLM-L6-v2`). */
  model?: string;
  /** Model cache directory. If omitted, uses the transformers.js default. */
  cacheDir?: string;
  /** WASM paths override (for `onnxruntime-web`). If omitted, bundled. */
  wasmPaths?: string;
}

export interface DuplicateBodyOptions {
  sources: readonly { path: string; content: string }[];
  allowlistCross: readonly DuplicateBodyAllowlistCross[];
  allowlistSameFile: readonly DuplicateBodyAllowlistSameFile[];
  minBodySize?: number;
  minTokenCount?: number;
  jaccardThreshold?: number;
  shingleK?: number;
  /** Pass 3 — embedding-based semantic duplicate detection (EXP407). Opt-in
   * (default disabled). When enabled, runs after Pass 1/2/2.5/2.6 on pairs
   * NOT already caught. See `DuplicateBodyEmbeddingPass3Options`. */
  embeddingPass3?: DuplicateBodyEmbeddingPass3Options;
}

export interface DuplicateBodyResult {
  findings: readonly DuplicateBodyFinding[];
  mirrorViolations: readonly string[];
  contractTests: readonly string[];
}

export interface BodyHashEntry {
  path: string;
  line: number;
  name: string;
  bodySize: number;
  exactHash: string;
  normalizedHash: string;
}

export interface CollectedFunction {
  path: string;
  line: number;
  name: string;
  text: string;
  bodySize: number;
  exactHash: string;
  normalizedHash: string;
  normalizedTokens: readonly string[];
  node: AstNode;
}

export interface Pass1Cluster {
  hash: string;
  functions: readonly CollectedFunction[];
}

export { DEFAULT_MIN_BODY_SIZE, DEFAULT_JACCARD_THRESHOLD, DEFAULT_MIN_TOKEN_COUNT, DEFAULT_QUALITY_SHINGLE_K as DEFAULT_SHINGLE_K } from "../quality-config.ts";
