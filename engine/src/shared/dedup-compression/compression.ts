/**
 * EXP454 — compression engine. Built on EXP449's compress-v2 but adapted for
 * the lower layer. Lossless (brotli/gzip/deflate) for storage and for
 * LLM-visible context. Lossy-for-structure (minify) only for storage or when
 * the module config explicitly allows it (llm-output minifies for storage).
 *
 * The gemma-tolerance contract: if `llmVisibleLosslessOnly` is true, minify
 * is rejected for that data and a lossless mode is used instead. This
 * ensures gemma always sees the original text (comments, whitespace) so it
 * can generate correct edits.
 */

import {
  gzipSync, brotliCompressSync, deflateSync,
  gunzipSync, brotliDecompressSync, inflateSync,
  constants as zConstants,
} from "node:zlib";
import type { DedupCompressionConfig, CompressionMode } from "./config.ts";
import { clamp, round } from "../../shared/numeric-helpers.ts";
import { handleError } from "../debug/debug-system.ts";

export type { CompressionMode } from "./config.ts";

export interface CompressionReport {
  mode: CompressionMode;
  originalChars: number;
  compressedBytes: number;
  /** compressed / original. Lower = more compression. */
  compressionRatio: number;
  /** (1 - compressed/original) * 100. Higher = more savings. */
  charSavingsPct: number;
  decompressedChars: number;
  /** Whether the round-trip (decompress → original) succeeded. */
  roundTripOk: boolean;
  /** Whether the effective mode was downgraded from a lossy mode to a
   * lossless one to respect the gemma-tolerance budget. */
  downgradedForGemma: boolean;
  compressMs: number;
  /** CPU time (user+system) consumed by compression, in ms (process). */
  cpuMs: number;
}

export interface CompressionResult {
  compressed: Buffer;
  /** The mode actually used (may differ from config if downgraded). */
  effectiveMode: CompressionMode;
  report: CompressionReport;
}

const BROTLI_QUALITY_KEY = zConstants.BROTLI_PARAM_QUALITY;

/** Compress text. If `llmVisible` is true and config requires lossless,
 * lossy modes (minify, minify+*) are downgraded to their lossless base. */
export function compress(
  text: string,
  cfg: DedupCompressionConfig,
  llmVisible: boolean,
): CompressionResult {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const originalChars = text.length;
  let mode = cfg.compressionMode;
  let downgraded = false;
  if (llmVisible && cfg.llmVisibleLosslessOnly && isLossy(mode)) {
    mode = losslessBase(mode);
    downgraded = true;
  }
  let compressed: Buffer;
  let roundTripOk = true;
  let decompressedChars = originalChars;
  switch (mode) {
    case "none":
      compressed = Buffer.from(text, "utf8");
      break;
    case "minify": {
      const m = minify(text, cfg);
      compressed = Buffer.from(m, "utf8");
      decompressedChars = m.length;
      break;
    }
    case "gzip":
      compressed = gzipSync(Buffer.from(text, "utf8"), { level: clampLevel(cfg.compressionLevel, 1, 9) });
      try { decompressedChars = gunzipSync(compressed).length; } catch (e) {handleError(e, { module: "shared-dedup-compression-compression", operation: "catch" }); roundTripOk = false; }
      break;
    case "brotli": {
      const brLevel = clampLevel(cfg.compressionLevel, 0, 11);
      compressed = brotliCompressSync(Buffer.from(text, "utf8"), { params: { [BROTLI_QUALITY_KEY]: brLevel } });
      try { decompressedChars = brotliDecompressSync(compressed).length; } catch (e) {handleError(e, { module: "shared-dedup-compression-compression", operation: "catch" }); roundTripOk = false; }
      break;
    }
    case "deflate":
      compressed = deflateSync(Buffer.from(text, "utf8"), { level: clampLevel(cfg.compressionLevel, 1, 9) });
      try { decompressedChars = inflateSync(compressed).length; } catch (e) {handleError(e, { module: "shared-dedup-compression-compression", operation: "catch" }); roundTripOk = false; }
      break;
    case "minify+gzip": {
      const m = minify(text, cfg);
      compressed = gzipSync(Buffer.from(m, "utf8"), { level: clampLevel(cfg.compressionLevel, 1, 9) });
      try { decompressedChars = gunzipSync(compressed).length; } catch (e) {handleError(e, { module: "shared-dedup-compression-compression", operation: "catch" }); roundTripOk = false; }
      break;
    }
    case "minify+brotli": {
      const m = minify(text, cfg);
      const brLevel = clampLevel(cfg.compressionLevel, 0, 11);
      compressed = brotliCompressSync(Buffer.from(m, "utf8"), { params: { [BROTLI_QUALITY_KEY]: brLevel } });
      try { decompressedChars = brotliDecompressSync(compressed).length; } catch (e) {handleError(e, { module: "shared-dedup-compression-compression", operation: "catch" }); roundTripOk = false; }
      break;
    }
  }
  const compressMs = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const compressedBytes = compressed.length;
  return {
    compressed,
    effectiveMode: mode,
    report: {
      mode, originalChars, compressedBytes,
      compressionRatio: originalChars > 0 ? round(compressedBytes / originalChars, 4) : 1,
      charSavingsPct: originalChars > 0 ? round((1 - compressedBytes / originalChars) * 100, 2) : 0,
      decompressedChars, roundTripOk, downgradedForGemma: downgraded, compressMs, cpuMs,
    },
  };
}

/** Minify: regex-based structural strip. Lossy for comments/whitespace. */
export function minify(text: string, cfg: DedupCompressionConfig): string {
  let out = text;
  if (cfg.stripBlockComments) out = out.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (cfg.stripLineComments) out = out.replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  if (cfg.removeBlankLines) out = out.replace(/\n\s*\n+/gu, "\n");
  if (cfg.collapseWhitespace) {
    out = out.replace(/[ \t]+/gu, " ");
    out = out.replace(/[ \t]+\n/gu, "\n");
    out = out.replace(/\n[ \t]+/gu, "\n");
  }
  return out.trim();
}

function isLossy(mode: CompressionMode): boolean {
  return mode === "minify" || mode === "minify+gzip" || mode === "minify+brotli";
}

function losslessBase(mode: CompressionMode): CompressionMode {
  if (mode === "minify") return "none";
  if (mode === "minify+gzip") return "gzip";
  if (mode === "minify+brotli") return "brotli";
  return mode;
}

function clampLevel(level: number, lo: number, hi: number): number {
  // R44: delegate to the canonical `clamp` owner in
  // `src/shared/numeric-helpers.ts` (was a private near-duplicate body —
  // "No Scattered Helpers" violation). The body was byte-identical to
  // `clamp(value, min, max)`.
  return clamp(level, lo, hi);
}
