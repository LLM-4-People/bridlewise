/**
 * EXP454 — decompression (transparent to modules). The lower layer's
 * `store` compresses; `retrieve` decompresses. Modules see original text.
 */

import {
  gunzipSync, brotliDecompressSync, inflateSync,
} from "node:zlib";
import type { CompressionMode } from "./config.ts";
import { handleError } from "../debug/debug-system.ts";

export interface DecompressionResult {
  text: string;
  ok: boolean;
  decompressMs: number;
  /** CPU time (user+system) consumed by decompression, in ms (process). */
  cpuMs: number;
}

/** Decompress a buffer produced by `compress` given the effective mode. */
export function decompress(
  compressed: Buffer,
  effectiveMode: CompressionMode,
): DecompressionResult {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  let text: string;
  let failed = false;
  try {
    switch (effectiveMode) {
      case "none":
      case "minify": // minify is lossy; the stored bytes ARE the minified text
        text = compressed.toString("utf8");
        break;
      case "gzip":
        text = gunzipSync(compressed).toString("utf8");
        break;
      case "brotli":
        text = brotliDecompressSync(compressed).toString("utf8");
        break;
      case "deflate":
        text = inflateSync(compressed).toString("utf8");
        break;
      case "minify+gzip":
        text = gunzipSync(compressed).toString("utf8");
        break;
      case "minify+brotli":
        text = brotliDecompressSync(compressed).toString("utf8");
        break;
    }
  } catch (e) {handleError(e, { module: "shared-dedup-compression-decompression", operation: "catch" });
    text = "";
    failed = true;
  }
  const decompressMs = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return { text, ok: !failed, decompressMs, cpuMs };
}
