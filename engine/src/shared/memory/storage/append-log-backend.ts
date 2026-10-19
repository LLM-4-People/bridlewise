// src/shared/memory/storage/append-log-backend.ts
// Append-only log storage. Each entry is appended as a single line
// (newline-delimited JSON). Best for write-heavy workloads + replay
// (Kagi research: append-only logs minimize write amplification). The
// benchmark measures insert throughput + replay latency.

import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import type { MemoryEntry } from "../memory-entry.ts";
import type { BackendStorageOptions, MemoryStoragePort } from "./backend.ts";
import { safeFromWire, toWire, type WireRecord } from "./serde.ts";
import { handleError } from "../../debug/debug-system.ts";

export function createAppendLogStorage(options: BackendStorageOptions): MemoryStoragePort {
  const { path } = options;
  let bytes = 0;
  let ops = 0;
  let buffered: MemoryEntry[] = [];
  return {
    backend: "append-log",
    flush(entries) {
      // Snapshot = rewrite the whole log from the provided entries.
      const lines = entries.map((e) => JSON.stringify(toWire(e))).join("\n") + "\n";
      const buf = Buffer.from(lines, "utf8");
      writeFileSync(path, buf);
      bytes += buf.byteLength;
      buffered = [...entries];
      ops += 1;
    },
    append(entry) {
      const line = JSON.stringify(toWire(entry)) + "\n";
      const buf = Buffer.from(line, "utf8");
      appendFileSync(path, buf);
      bytes += buf.byteLength;
      buffered.push(entry);
      ops += 1;
    },
    load() {
      if (!existsSync(path)) return [];
      const buf = readFileSync(path);
      const text = buf.toString("utf8");
      const out: MemoryEntry[] = [];
      let corrupt = 0;
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          const w = JSON.parse(line) as WireRecord;
          const e = safeFromWire(w);
          if (e) out.push(e);
          else corrupt += 1;
        } catch (e) {handleError(e, { module: "shared-memory-storage-append-log-backend", operation: "catch" });
          corrupt += 1;
        }
      }
      if (corrupt > 0) process.stderr.write(`append-log-backend: dropped ${corrupt} corrupt lines\n`);
      return out;
    },
    bytesWritten() { return bytes; },
    opCount() { return ops; },
    close() { buffered = []; },
  };
}
