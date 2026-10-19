/**
 * Farm child — crash-isolated extract. Init tree-sitter at spawn, then
 * parse synchronously. A grammar trap kills THIS process; the farm
 * records the in-flight file and replaces the child.
 *
 * The parent is `process-farm.ts`. Protocol: init → ready; parse-batch
 * → batch-result. Announce `starting` before each file so a hard crash
 * names the culprit.
 */
import { readFileSync } from "node:fs";

import { guarded } from "../process/fault-policy.ts";
import { bootstrapProcess } from "../runtime/cli-debug.ts";

import { HarnessError } from "../kernel/errors.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { DEFAULT_FARM_KILL_ESCALATION_MS } from "./intelligence-config.ts";
import { getLanguageByExtension, getTreeSitterLanguages } from "./language-registry.ts";
import { extractSymbols } from "./symbol-extractor.ts";
import { initTreeSitterForExtract } from "./tree-sitter-backend.ts";

// A top-level program (the farm forks it): the one process bootstrap first —
// a worker fails closed on a lost fault, and the farm parent already replaces
// a child that exits.
bootstrapProcess({ role: "worker" });

const send = (msg: object): void => {
  if (typeof process.send === "function") process.send(msg);
};

process.on("disconnect", guarded("intelligence.farm-child.disconnect", () => {
  setTimeout(guarded("intelligence.farm-child.exit-escalation", () => process.exit(0)), DEFAULT_FARM_KILL_ESCALATION_MS).unref();
  process.exit(0);
}));

process.on("message", guarded("intelligence.farm-child.message", (m: { type?: string; languages?: readonly string[]; files?: readonly { path: string; absolutePath: string }[] }) => {
  void handle(m);
}));

async function handle(m: {
  type?: string;
  languages?: readonly string[];
  files?: readonly { path: string; absolutePath: string }[];
}): Promise<void> {
  if (m.type === "init") {
    // An omitted list means "all registered grammars". An empty list means
    // none — the parent dropped every language as poison and still wants a
    // ready child so remaining files can fail per-file, not hang.
    const langs = m.languages !== undefined
      ? m.languages
      : getTreeSitterLanguages().map((s) => s.id);
    for (const id of langs) {
      send({ type: "loading", language: id });
      try {
        await initTreeSitterForExtract([id]);
      } catch (e) {
        handleError(e, { module: "intelligence-farm-child", operation: "init" });
        process.exit(1);
      }
      send({ type: "loaded", language: id });
    }
    send({ type: "ready" });
    return;
  }
  if (m.type !== "parse-batch" || m.files === undefined) return;
  const results = [];
  for (const f of m.files) {
    send({ type: "starting", path: f.path });
    const t0 = Date.now();
    try {
      const source = readFileSync(f.absolutePath, "utf8");
      const extraction = extractSymbols(f.path, source);
      const lang = getLanguageByExtension(f.path)?.id ?? "unknown";
      // The result is marked ok only when the extraction returned the
      // expected shape — a computed verification, not a literal success
      // stamp. An extractor that returned garbage without throwing would
      // surface as a failed result instead of a confident lie.
      const extractionOk = Array.isArray(extraction.symbols) && typeof extraction.lineCount === "number";
      results.push({
        path: f.path,
        ok: extractionOk,
        symbols: extraction.symbols.length,
        imports: extraction.imports.length,
        exports: extraction.exports.length,
        lineCount: extraction.lineCount,
        byKind: Object.freeze({ [lang]: extraction.symbols.length }),
        calls: 0,
        docstrings: 0,
        signatures: 0,
        diagnostics: Object.freeze([]),
        detail: Object.freeze([extraction]),
        latencyMs: Date.now() - t0,
      });
    } catch (err) {
      handleError(err, { module: "intelligence-farm-child", operation: "extractSymbols" });
      results.push({
        path: f.path,
        ok: false,
        symbols: 0,
        imports: 0,
        exports: 0,
        lineCount: 0,
        byKind: Object.freeze({}),
        calls: 0,
        docstrings: 0,
        signatures: 0,
        diagnostics: Object.freeze([]),
        detail: Object.freeze([]),
        errorName: err instanceof Error ? err.name : "Error",
        errorMessage: err instanceof Error ? err.message : String(err),
        ...(err instanceof HarnessError ? { errorCode: err.code } : {}),
        latencyMs: Date.now() - t0,
      });
    }
  }
  send({ type: "batch-result", results });
}
