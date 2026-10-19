/**
 * EXP454 — dedup engine. Built on EXP449's dedup-v2 but with the PROHIBITED
 * hardcoded JS_KEYWORDS list REMOVED and replaced by dynamic-keywords.ts.
 *
 * Five techniques (same as EXP449, same DedupReport shape for comparison):
 * 1. `line` — remove duplicate lines (keep first). O(n).
 * 2. `block` — remove duplicate blank-line-separated blocks by Jaccard
 * on the SET of lines (threshold configurable).
 * 3. `semantic` — normalize identifiers via DYNAMIC keyword detection
 * (babel tokens / tree-sitter / frequency-learned), then
 * Jaccard. Catches functions differing only in var names.
 * 4. `hash` — SHA-256 of each markdown section; drop exact-hash dups.
 * 5. `ast` — parse TS with @babel/parser, hash each top-level
 * statement, drop duplicate structural hashes.
 *
 * One canonical owner per technique (this file). No hardcoded keywords.
 */

import { parse } from "@babel/parser";
import type { DedupCompressionConfig, DedupMode } from "./config.ts";
import {
  normalizeBlock,
  normalizeBlockAsync,
  learnKeywordsFromCorpus,
  type NormalizeResult,
} from "./dynamic-keywords.ts";
import { round } from "../../shared/numeric-helpers.ts";
import { jaccardLenient } from "../similarity.ts";
import { sha256, stripMarkdownFences } from "./shared-helpers.ts";

export type { DedupMode } from "./config.ts";

export interface DedupReport {
  mode: DedupMode;
  originalChars: number;
  originalLines: number;
  originalBlocks: number;
  dedupedChars: number;
  dedupedLines: number;
  dedupedBlocks: number;
  removedLines: number;
  removedBlocks: number;
  charReductionPct: number;
  lineReductionPct: number;
  blockReductionPct: number;
  nearDupCount: number;
  /** The keyword strategy actually used (for `semantic` mode). */
  keywordStrategy: string | null;
  /** Number of keywords detected dynamically (for `semantic` mode). */
  keywordCount: number | null;
  /** Number of identifiers normalized to ID (for `semantic` mode). */
  identifierCount: number | null;
  parseError: string | null;
}

export interface DedupResult {
  content: string;
  report: DedupReport;
}

/** Synchronous dedup. `semantic` mode uses sync normalization (babel-tokens
 * or frequency-learned fallback; tree-sitter needs normalizeBlockAsync). */
export function dedup(text: string, cfg: DedupCompressionConfig): DedupResult {
  if (!cfg.enabled) return noOp(text, cfg.dedupMode);
  switch (cfg.dedupMode) {
    case "none": return noOp(text, "none");
    case "line": return dedupLine(text, cfg);
    case "block": return dedupBlock(text, cfg, (b) => lineSet(b, cfg.minLineLengthForDedup));
    case "semantic": return dedupSemanticSync(text, cfg);
    case "hash": return dedupHash(text);
    case "ast": return dedupAst(text, cfg);
  }
}

/** Asynchronous dedup (supports tree-sitter for `semantic` mode). */
export async function dedupAsync(text: string, cfg: DedupCompressionConfig): Promise<DedupResult> {
  if (!cfg.enabled) return noOp(text, cfg.dedupMode);
  if (cfg.dedupMode === "semantic") return dedupSemanticAsync(text, cfg);
  return dedup(text, cfg);
}

// ===== technique 1: line =====

function dedupLine(text: string, cfg: DedupCompressionConfig): DedupResult {
  const lines = text.split("\n");
  const seen = new Set<string>();
  let removed = 0;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < cfg.minLineLengthForDedup) { out.push(line); continue; }
    if (seen.has(trimmed)) { removed++; continue; }
    seen.add(trimmed);
    out.push(line);
  }
  const content = out.join("\n");
  return makeReport("line", text, content, removed, 0, 0, "line", null, null, null);
}

// ===== technique 2: block =====

function dedupBlock(
  text: string,
  cfg: DedupCompressionConfig,
  tokenSet: (b: string) => Set<string>,
): DedupResult {
  const blocks = splitBlocks(text);
  const seenSets: Set<string>[] = [];
  const out: string[] = [];
  let removedBlocks = 0, nearDup = 0;
  for (const block of blocks) {
    const ts = tokenSet(block);
    if (ts.size === 0) { out.push(block); continue; }
    let isDup = false;
    for (const existing of seenSets) {
      const j = jaccardLenient(ts, existing);
      if (j >= cfg.blockSimilarityThreshold) { isDup = true; if (j < 1) nearDup++; break; }
    }
    if (isDup) { removedBlocks++; continue; }
    seenSets.push(ts);
    out.push(block);
  }
  const content = out.join("\n\n");
  return makeReport("block", text, content, 0, removedBlocks, nearDup, "block", null, null, null);
}

// ===== technique 3: semantic (dynamic keywords) =====

function dedupSemanticSync(text: string, cfg: DedupCompressionConfig): DedupResult {
  const blocks = splitBlocks(text);
  const results: NormalizeResult[] = blocks.map((b) =>
    b.length < cfg.minBlockSizeForSemantic
      ? { tokens: lineSet(b, cfg.minLineLengthForDedup), strategy: "line-fallback", keywordCount: 0, identifierCount: 0, parseError: null }
      : normalizeBlock(b, cfg),
  );
  return applySemantic(text, blocks, results, cfg);
}

async function dedupSemanticAsync(text: string, cfg: DedupCompressionConfig): Promise<DedupResult> {
  const blocks = splitBlocks(text);
  // Pre-learn keywords from the corpus for frequency-learned strategy.
  const learnedKeywords = learnKeywordsFromCorpus(blocks, cfg.keywordFrequencyThreshold);
  const results: NormalizeResult[] = await Promise.all(
    blocks.map((b) =>
      b.length < cfg.minBlockSizeForSemantic
        ? Promise.resolve({ tokens: lineSet(b, cfg.minLineLengthForDedup), strategy: "line-fallback", keywordCount: 0, identifierCount: 0, parseError: null })
        : normalizeBlockAsync(b, cfg, learnedKeywords),
    ),
  );
  return applySemantic(text, blocks, results, cfg);
}

function applySemantic(
  text: string,
  blocks: string[],
  results: NormalizeResult[],
  cfg: DedupCompressionConfig,
): DedupResult {
  const seenSets: Set<string>[] = [];
  const out: string[] = [];
  let removedBlocks = 0, nearDup = 0;
  let kwTotal = 0, idTotal = 0, parseErr: string | null = null;
  let strategyUsed = "none";
  for (let i = 0; i < blocks.length; i++) {
    const r = results[i]!;
    if (r.strategy !== "line-fallback") strategyUsed = r.strategy;
    kwTotal += r.keywordCount;
    idTotal += r.identifierCount;
    if (r.parseError && !parseErr) parseErr = r.parseError;
    const ts = r.tokens;
    if (ts.size === 0) { out.push(blocks[i]!); continue; }
    let isDup = false;
    for (const existing of seenSets) {
      const j = jaccardLenient(ts, existing);
      if (j >= cfg.blockSimilarityThreshold) { isDup = true; if (j < 1) nearDup++; break; }
    }
    if (isDup) { removedBlocks++; continue; }
    seenSets.push(ts);
    out.push(blocks[i]!);
  }
  const content = out.join("\n\n");
  return makeReport("semantic", text, content, 0, removedBlocks, nearDup, strategyUsed, kwTotal, idTotal, parseErr);
}

// ===== technique 4: hash (markdown sections) =====

function dedupHash(text: string): DedupResult {
  const sections = splitByHeading(text);
  const seen = new Set<string>();
  const out: string[] = [];
  let removed = 0;
  for (const s of sections) {
    const h = sha256(s);
    if (seen.has(h)) { removed++; continue; }
    seen.add(h);
    out.push(s);
  }
  const content = out.join("\n\n");
  return makeReport("hash", text, content, 0, removed, removed, "hash", null, null, null);
}

// ===== technique 5: ast (top-level statement dedup) =====

function dedupAst(text: string, cfg: DedupCompressionConfig): DedupResult {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(stripMarkdownFences(text), { plugins: ["typescript", "jsx"], sourceType: "module", errorRecovery: true });
  } catch (e) {
    // parse failed — fall back to block dedup so we don't lose data
    return dedupBlock(text, cfg, (b) => lineSet(b, cfg.minLineLengthForDedup));
  }
  const body = ast.program.body;
  const seen = new Set<string>();
  const kept: typeof body = [];
  let removed = 0;
  for (const stmt of body) {
    const h = structuralHash(stmt);
    if (seen.has(h)) { removed++; continue; }
    seen.add(h);
    kept.push(stmt);
  }
  if (removed === 0) return makeReport("ast", text, text, 0, 0, 0, "ast", null, null, null);
  const ranges: Array<[number, number]> = [];
  for (const stmt of kept) {
    const start = (stmt as any).start ?? 0;
    const end = (stmt as any).end ?? text.length;
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  for (const [s, e] of ranges) parts.push(text.slice(s, e));
  const content = parts.join("\n\n");
  return makeReport("ast", text, content, 0, removed, removed, "ast", null, null, null);
}

// ===== helpers =====

function lineSet(block: string, minLen: number): Set<string> {
  const s = new Set<string>();
  for (const l of block.split("\n")) {
    const t = l.trim();
    if (t.length >= minLen) s.add(t);
  }
  return s;
}

function splitBlocks(text: string): string[] {
  return text.split(/\n\s*\n+/u).map((b) => b.trim()).filter((b) => b.length > 0);
}

function splitByHeading(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (/^#{1,4}\s/u.test(line)) {
      if (cur.length > 0) sections.push(cur.join("\n").trim());
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join("\n").trim());
  return sections.filter((s) => s.length > 0);
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function countBlocks(text: string): number {
  return text.trim().length === 0 ? 0 : splitBlocks(text).length;
}


function structuralHash(node: unknown): string {
  const parts: string[] = [];
  walk(node, (n) => {
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if ("type" in o) parts.push(String(o.type));
    if (o.type === "Identifier" && "name" in o) parts.push(`ID:${String(o.name)}`);
    if ((o.type === "StringLiteral" || o.type === "NumericLiteral" || o.type === "BooleanLiteral") && "value" in o) parts.push(`LIT:${String(o.value)}`);
  });
  return sha256(parts.join(","));
}

function walk(node: unknown, visit: (n: unknown) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const item of v) walk(item, visit);
    else if (v && typeof v === "object" && "type" in (v as object)) walk(v, visit);
  }
}

function noOp(text: string, mode: DedupMode): DedupResult {
  return makeReport(mode, text, text, 0, 0, 0, mode, null, null, null);
}

function makeReport(
  mode: DedupMode,
  original: string,
  deduped: string,
  removedLines: number,
  removedBlocks: number,
  nearDup: number,
  strategy: string,
  keywordCount: number | null,
  identifierCount: number | null,
  parseError: string | null,
): DedupResult {
  const oc = original.length, dc = deduped.length;
  const ol = countLines(original), dl = countLines(deduped);
  const ob = countBlocks(original), db = countBlocks(deduped);
  return {
    content: deduped,
    report: {
      mode,
      originalChars: oc, originalLines: ol, originalBlocks: ob,
      dedupedChars: dc, dedupedLines: dl, dedupedBlocks: db,
      removedLines, removedBlocks, nearDupCount: nearDup,
      charReductionPct: oc > 0 ? round((1 - dc / oc) * 100, 2) : 0,
      lineReductionPct: ol > 0 ? round((removedLines / ol) * 100, 2) : 0,
      blockReductionPct: ob > 0 ? round((removedBlocks / ob) * 100, 2) : 0,
      keywordStrategy: strategy, keywordCount, identifierCount, parseError,
    },
  };
}
