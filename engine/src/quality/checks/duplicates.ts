/**
 * Duplicate-body check — MinHash + LSH (EXP357).
 *
 * Reuses the EXP186/EXP340 insight: token-level Jaccard similarity with
 * MinHash + LSH banding scales to large codebases (O(N) candidates instead
 * of O(N^2) pairwise). We extract function bodies, normalize whitespace,
 * shingle into k-grams, MinHash into a fixed-size signature, and use LSH
 * banding to find candidate pairs. Each candidate is verified with exact
 * Jaccard. Pairs ≥ threshold are reported as duplicates.
 *
 * Works across all languages because it operates on the parser-extracted
 * function bodies (token stream), not the raw AST.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { shinglesArray } from "../../shared/similarity.ts";

interface FuncBody {
  filePath: string;
  symbol: string;
  line: number;
  body: string;
  tokenStream: string;
}

const STOP_TOKENS = new Set([
  "{", "}", "(", ")", ";", ",", ".", ":", "->", "=>", "==", "!=", "<=", ">=", "++", "--", "+=", "-=", "*=", "/=",
]);

function tokenizeBody(body: string): string[] {
  return body.split(/[\s{}()[\];,:.]+/).filter((t) => t.length > 0 && !STOP_TOKENS.has(t));
}

function normalizeBody(body: string): string {
  return body
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"[^"]*"/g, '"str"')
    .replace(/'[^']*'/g, '"str"')
    .replace(/\b\d+(\.\d+)?\b/g, "NUM")
    .toLowerCase()
    .trim();
}

function shingles(tokens: string[], k: number): string[] {
  // R44: delegate to the canonical `shinglesArray` owner in
  // `src/shared/similarity.ts` (was a private near-duplicate body — "No
  // Scattered Helpers" violation). The `" "` separator is preserved so
  // existing MinHash signatures are byte-identical (the separator is part
  // of the shingle literal that the FNV-1a hash consumes).
  return shinglesArray(tokens, k, " ");
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

const NUM_HASHES = 64;
const NUM_BANDS = 16;
const BAND_SIZE = NUM_HASHES / NUM_BANDS;

function minHash(shingleSet: Set<string>): Uint32Array {
  const sig = new Uint32Array(NUM_HASHES);
  for (let h = 0; h < NUM_HASHES; h += 1) {
    let min = 0xffffffff;
    const seed = (h * 0x9e3779b1) >>> 0;
    for (const sh of shingleSet) {
      const v = (hashStr(sh) ^ seed) >>> 0;
      if (v < min) min = v;
    }
    sig[h] = min;
  }
  return sig;
}

function bandKey(sig: Uint32Array, band: number): string {
  const start = band * BAND_SIZE;
  let key = "";
  for (let r = 0; r < BAND_SIZE; r += 1) {
    key += (sig[start + r] ?? 0).toString(16) + "-";
  }
  return key;
}

export function checkDuplicateBodies(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const minTokens = config.thresholds.duplicateMinTokens;
  const threshold = config.thresholds.duplicateJaccard;
  const findings: Finding[] = [];

  const bodies: FuncBody[] = [];
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.bodyLines < 3) continue;
      const lines = f.content.split("\n");
      const body = lines.slice(sym.line - 1, Math.min(sym.endLine, lines.length)).join("\n");
      const normalized = normalizeBody(body);
      const tokens = tokenizeBody(normalized);
      if (tokens.length < minTokens) continue;
      bodies.push({
        filePath: f.path,
        symbol: sym.name,
        line: sym.line,
        body,
        tokenStream: tokens.join(" "),
      });
    }
  }

  if (bodies.length === 0) return findings;

  const sigs: Uint32Array[] = [];
  const shingleK = 4;
  const buckets: Map<string, number[]>[] = [];
  for (let b = 0; b < NUM_BANDS; b += 1) buckets.push(new Map());

  for (let i = 0; i < bodies.length; i += 1) {
    const tokens = bodies[i]!.tokenStream.split(" ");
    const sh = shingles(tokens, shingleK);
    const sig = minHash(new Set(sh));
    sigs.push(sig);
    for (let b = 0; b < NUM_BANDS; b += 1) {
      const key = bandKey(sig, b);
      const m = buckets[b]!;
      let arr = m.get(key);
      if (!arr) {
        arr = [];
        m.set(key, arr);
      }
      arr.push(i);
    }
  }

  const candidatePairs = new Set<number>();
  for (let b = 0; b < NUM_BANDS; b += 1) {
    for (const arr of buckets[b]!.values()) {
      if (arr.length < 2) continue;
      for (let x = 0; x < arr.length; x += 1) {
        for (let y = x + 1; y < arr.length; y += 1) {
          const a = arr[x]! < arr[y]! ? arr[x]! : arr[y]!;
          const c = arr[x]! < arr[y]! ? arr[y]! : arr[x]!;
          candidatePairs.add(a * bodies.length + c);
        }
      }
    }
  }

  const reported = new Set<string>();
  for (const pair of candidatePairs) {
    const a = Math.floor(pair / bodies.length);
    const c = pair % bodies.length;
    if (a === c) continue;
    const ba = bodies[a];
    const bc = bodies[c];
    if (!ba || !bc) continue;
    const sa = new Set(ba.tokenStream.split(" "));
    const sc = new Set(bc.tokenStream.split(" "));
    let inter = 0;
    for (const t of sa) if (sc.has(t)) inter += 1;
    const uni = sa.size + sc.size - inter;
    const j = uni > 0 ? inter / uni : 0;
    if (j >= threshold) {
      const key = a + "-" + c;
      if (reported.has(key)) continue;
      reported.add(key);
      findings.push({
        checkId: "duplicate-body",
        severity: "warning",
        filePath: ba.filePath,
        line: ba.line,
        column: 0,
        symbol: ba.symbol,
        message: `Duplicate of '${bc.symbol}' in ${bc.filePath}:${bc.line} (Jaccard ${j.toFixed(3)})`,
        extra: {
          jaccard: Number(j.toFixed(4)),
          otherFile: bc.filePath,
          otherLine: bc.line,
          otherSymbol: bc.symbol,
        },
      });
    }
  }
  return findings;
}
