// src/shared/memory/storage/sqlite-backend.ts
// SQLite storage via node:sqlite (built into Node 22.18+/24+, no dep).
// Indexed by tier, type, conversationId, projectId, timestamp. Best for
// large cold tiers with structured queries (Kagi research: SQLite wins for
// large datasets with indexing/querying).

import { createRequire } from "node:module";
import type { MemoryEntry } from "../memory-entry.ts";
import type { BackendStorageOptions, MemoryStoragePort } from "./backend.ts";
import { safeFromWire, toWire, type WireRecord } from "./serde.ts";
import { InputError } from "../../../kernel/errors.ts";

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void; all(...params: unknown[]): unknown[] };
  close(): void;
};

const esmRequire = createRequire(import.meta.url);

function loadDb(): { DatabaseSync: new (path: string) => SqliteDb } {
  // Lazy-load node:sqlite via createRequire (ESM-safe, sync). Throws a typed
  // error if unavailable (older Node) — never a silent fallback.
  try {
    return esmRequire("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };
  } catch (err) {
    throw new InputError(
      `sqlite-backend requires node:sqlite (Node 22.18+/24+): ${String(err)}`,
      "shared_memory_sqlite_unavailable",
    );
  }
}

export function createSqliteStorage(options: BackendStorageOptions): MemoryStoragePort {
  const { path } = options;
  const sqlite = loadDb();
  const db = new sqlite.DatabaseSync(path) as SqliteDb;
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      type TEXT NOT NULL,
      provenance TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      last_accessed TEXT NOT NULL,
      access_count INTEGER NOT NULL,
      ebbinghaus_score REAL NOT NULL,
      token_estimate INTEGER NOT NULL,
      digest TEXT NOT NULL,
      wire TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tier ON memory(tier);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_type ON memory(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv ON memory(conversation_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_proj ON memory(project_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_time ON memory(timestamp);`);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO memory (id,tier,type,provenance,conversation_id,project_id,timestamp,last_accessed,access_count,ebbinghaus_score,token_estimate,digest,wire) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const selAll = db.prepare(`SELECT wire FROM memory ORDER BY timestamp ASC;`);
  let bytes = 0;
  let ops = 0;
  return {
    backend: "sqlite",
    flush(entries) {
      for (const e of entries) {
        const wire = toWire(e);
        const wireStr = JSON.stringify(wire);
        bytes += wireStr.length;
        ins.run(e.id, e.tier, e.type, e.provenance, e.conversationId, e.projectId, e.timestamp, e.lastAccessed, e.accessCount, e.ebbinghausScore, e.tokenEstimate, e.digest, wireStr);
      }
      ops += 1;
    },
    append(entry) {
      const wire = toWire(entry);
      const wireStr = JSON.stringify(wire);
      bytes += wireStr.length;
      ins.run(entry.id, entry.tier, entry.type, entry.provenance, entry.conversationId, entry.projectId, entry.timestamp, entry.lastAccessed, entry.accessCount, entry.ebbinghausScore, entry.tokenEstimate, entry.digest, wireStr);
      ops += 1;
    },
    load() {
      const rows = selAll.all() as unknown[] as { wire: string }[];
      const out: MemoryEntry[] = [];
      let corrupt = 0;
      for (const r of rows) {
        const w = JSON.parse(r.wire) as WireRecord;
        const e = safeFromWire(w);
        if (e) out.push(e);
        else corrupt += 1;
      }
      if (corrupt > 0) process.stderr.write(`sqlite-backend: dropped ${corrupt} corrupt entries\n`);
      return out;
    },
    bytesWritten() { return bytes; },
    opCount() { return ops; },
    close() { db.close(); },
  };
}
