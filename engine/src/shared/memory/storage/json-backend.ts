// src/shared/memory/storage/json-backend.ts
// JSON file storage. Native JSON.stringify (fast in Node.js per Kagi
// research — V8's JSON is highly optimized). Baseline backend.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { MemoryEntry } from "../memory-entry.ts";
import type { BackendStorageOptions, MemoryStoragePort } from "./backend.ts";
import { fromWire, safeFromWire, toWire, type WireRecord } from "./serde.ts";

export function createJsonStorage(options: BackendStorageOptions): MemoryStoragePort {
  const { path } = options;
  let bytes = 0;
  let ops = 0;
  return {
    backend: "json",
    flush(entries) {
      const wire = entries.map(toWire);
      const data = JSON.stringify(wire);
      const buf = Buffer.from(data, "utf8");
      writeFileSync(path, buf);
      bytes += buf.byteLength;
      ops += 1;
    },
    append(_entry) {
      // JSON backend is snapshot-only; append triggers a no-op (store calls flush).
    },
    load() {
      if (!existsSync(path)) return [];
      const buf = readFileSync(path);
      const arr = JSON.parse(buf.toString("utf8")) as WireRecord[];
      const out: MemoryEntry[] = [];
      let corrupt = 0;
      for (const w of arr) {
        const e = safeFromWire(w);
        if (e) out.push(e);
        else corrupt += 1;
      }
      if (corrupt > 0) {
        // Corruption detected (HARD test protocol). Surface via stderr; the
        // store reports it through the exposure system too.
        process.stderr.write(`json-backend: dropped ${corrupt} corrupt entries\n`);
      }
      return out;
    },
    bytesWritten() { return bytes; },
    opCount() { return ops; },
    close() { /* nothing to release */ },
  };
}

export { fromWire };
