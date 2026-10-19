// src/memory/scale/memory-store-1b.ts
// Billion-token memory store: SQLite + FTS5 sharded inverted index.
//
// Research (Kagi 2026-07-22): IVF-PQ + FTS5 inverted index are SOTA for
// billion-scale retrieval. FTS5 provides an on-disk inverted index with
// O(log N) per query + BM25 ranking, keeping RAM bounded regardless of
// scale. Sharding parallelizes writes and keeps each shard smaller.
//
// Architecture:
// - N shards (SQLite DBs), entries distributed by hash(id) % N.
// - Each shard: FTS5 virtual table (inverted index on disk) + metadata.
// - Hot tier: LRU cache in RAM (recent entries, configurable size).
// - Cold tier: all entries on disk (searched via FTS5 BM25).
// - Batch inserts: transaction per batch (configurable size).
// - Lazy content loading: FTS5 returns rowids; content fetched on demand.
//
// No static constants — all thresholds in ScaleStoreConfig.
// Reuses MemoryEntry type from memory-types.ts (single source of truth).

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedTemporaryDirectory } from "../../filesystem/private-state.ts";
import type { MemoryEntry, MemoryTier } from "../memory-types.ts";
import { estimateTokens } from "../memory-types.ts";
import type { ScaleStoreConfig } from "./scale-config.ts";
import { InputError } from "../../kernel/errors.ts";
import { sha256Bytes } from "../../kernel/integrity.ts";
import { handleError } from "../../shared/debug/debug-system.ts";

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
};
type SqliteStmt = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
};

export type ScaleSearchResult = Readonly<{
  entry: MemoryEntry;
  score: number;
  shardIndex: number;
}>;

export type ScaleStoreStats = Readonly<{
  entryCount: number;
  shardSizes: readonly number[];
  diskBytes: number;
  hotTierSize: number;
  hotTierHits: number;
  hotTierMisses: number;
  insertCount: number;
  searchCount: number;
}>;

export type PerfMetrics = Readonly<{
  cpuUserMs: number;
  cpuSystemMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  wallMs: number;
  fsRead: number;
  fsWrite: number;
}>;

export function capturePerf(): PerfMetrics {
  const cpu = process.resourceUsage();
  const mem = process.memoryUsage();
  return {
    cpuUserMs: Number(cpu.userCPUTime) / 1000,
    cpuSystemMs: Number(cpu.systemCPUTime) / 1000,
    rssBytes: Number(mem.rss),
    heapUsedBytes: Number(mem.heapUsed),
    heapTotalBytes: Number(mem.heapTotal),
    wallMs: Date.now(),
    fsRead: Number(cpu.fsRead),
    fsWrite: Number(cpu.fsWrite),
  };
}

export function perfDelta(start: PerfMetrics): PerfMetrics & Readonly<{ wallMs: number }> {
  const cpu = process.resourceUsage();
  const mem = process.memoryUsage();
  return {
    cpuUserMs: (Number(cpu.userCPUTime) - start.cpuUserMs * 1000) / 1000,
    cpuSystemMs: (Number(cpu.systemCPUTime) - start.cpuSystemMs * 1000) / 1000,
    rssBytes: Number(mem.rss),
    heapUsedBytes: Number(mem.heapUsed),
    heapTotalBytes: Number(mem.heapTotal),
    wallMs: Date.now() - start.wallMs,
    fsRead: Number(cpu.fsRead) - start.fsRead,
    fsWrite: Number(cpu.fsWrite) - start.fsWrite,
  };
}

const esmRequire = createRequire(import.meta.url);

function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDb } {
  try {
    return esmRequire("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };
  } catch (err) {
    throw new InputError(
      `memory-store-1b requires node:sqlite (Node 22.18+/24+): ${String(err)}`,
      "memory_store_1b_sqlite_unavailable",
    );
  }
}

function shardIndexForId(id: string, shardCount: number): number {
  const hash = sha256Bytes(id);
  return (hash[0] ?? 0) % shardCount;
}

type ShardHandle = {
  db: SqliteDb;
  path: string;
  insFts: SqliteStmt;
  insMeta: SqliteStmt;
  selById: SqliteStmt;
  selAllMeta: SqliteStmt;
  countStmt: SqliteStmt;
  searchStmt: SqliteStmt;
  searchExactStmt: SqliteStmt;
  getRowid: SqliteStmt;
};

function openShard(path: string, config: ScaleStoreConfig): ShardHandle {
  const sqlite = loadSqlite();
  const db = new sqlite.DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=${config.journalMode};`);
  db.exec(`PRAGMA synchronous=${config.synchronous};`);
  db.exec(`PRAGMA cache_size=-${config.cacheSizeKiB};`);
  if (config.mmapSize > 0) {
    db.exec(`PRAGMA mmap_size=${config.mmapSize};`);
  }
  db.exec(`PRAGMA temp_store=MEMORY;`);
  db.exec(`PRAGMA locking_mode=EXCLUSIVE;`);

  const tok = config.ftsTokenizer === "porter" ? "porter unicode61" : "unicode61";
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_meta (
      rowid INTEGER PRIMARY KEY,
      entry_id TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'message',
      conversation_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      turn_id TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      token_estimate INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meta_entry_id ON mem_meta(entry_id);
    CREATE INDEX IF NOT EXISTS idx_meta_conv ON mem_meta(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_meta_time ON mem_meta(timestamp);
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      content, topic, tags, conv,
      tokenize='${tok}'
    );
  `);

  return {
    db,
    path,
    insFts: db.prepare(`INSERT INTO mem_fts(rowid, content, topic, tags, conv) VALUES (?,?,?,?,?)`),
    insMeta: db.prepare(
      `INSERT OR REPLACE INTO mem_meta(entry_id, tier, type, conversation_id, project_id, timestamp, turn_id, topic, tags, token_estimate, content) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    selById: db.prepare(`SELECT * FROM mem_meta WHERE entry_id=?`),
    selAllMeta: db.prepare(`SELECT * FROM mem_meta ORDER BY timestamp ASC`),
    countStmt: db.prepare(`SELECT COUNT(*) as cnt FROM mem_meta`),
    searchStmt: db.prepare(
      `SELECT m.entry_id, m.tier, m.type, m.conversation_id, m.project_id, m.timestamp, m.turn_id, m.topic, m.tags, m.token_estimate, m.content, f.score
       FROM (SELECT rowid, bm25(mem_fts) as score FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?) f
       JOIN mem_meta m ON m.rowid = f.rowid`,
    ),
    searchExactStmt: db.prepare(
      `SELECT m.entry_id, m.content FROM (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?) f
       JOIN mem_meta m ON m.rowid = f.rowid`,
    ),
    getRowid: db.prepare(`SELECT last_insert_rowid() as r`),
  };
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const tags = String(row.tags ?? "").split("\n").filter((t) => t.length > 0);
  const convId = String(row.conversation_id ?? "");
  return Object.freeze({
    id: String(row.entry_id ?? ""),
    tier: String(row.tier ?? "long-term") as MemoryTier,
    content: String(row.content ?? ""),
    tags,
    agentId: null,
    topic: (row.topic as string) || null,
    timestamp: String(row.timestamp ?? ""),
    sourceEventId: null,
    turnId: (row.turn_id as string) || null,
    runId: null,
    metadata: convId ? { conversationId: convId } : {},
  });
}

type LruEntry = { entry: MemoryEntry; key: string };

function createLru(capacity: number): {
  get: (key: string) => MemoryEntry | undefined;
  put: (key: string, entry: MemoryEntry) => void;
  size: () => number;
  hits: () => number;
  misses: () => number;
} {
  const map = new Map<string, LruEntry>();
  let hitCount = 0;
  let missCount = 0;
  return {
    get(key: string) {
      const node = map.get(key);
      if (node === undefined) {
        missCount += 1;
        return undefined;
      }
      map.delete(key);
      map.set(key, node);
      hitCount += 1;
      return node.entry;
    },
    put(key: string, entry: MemoryEntry) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= capacity) {
        const firstKey = map.keys().next().value as string | undefined;
        if (firstKey !== undefined) map.delete(firstKey);
      }
      map.set(key, { entry, key });
    },
    size: () => map.size,
    hits: () => hitCount,
    misses: () => missCount,
  };
}

export function createScaleMemoryStore(config: ScaleStoreConfig) {
  // No configured folder: an owned temporary folder of this process (removed
  // when it exits), never a fixed path in the shared temp root that every
  // user and run would share.
  const dataDir = config.dataDir ?? createOwnedTemporaryDirectory(tmpdir(), "scale-memory-");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const shards: ShardHandle[] = [];
  for (let i = 0; i < config.shardCount; i += 1) {
    const padded = String(i).padStart(4, "0");
    const path = join(dataDir, `${config.shardPrefix}_${padded}.sqlite`);
    shards.push(openShard(path, config));
  }
  const lru = config.hotTierEnabled ? createLru(config.hotTierSize) : null;
  let insertCount = 0;
  let searchCount = 0;

  function shardFor(id: string): ShardHandle {
    return shards[shardIndexForId(id, config.shardCount)]!;
  }

  function insertBatch(entries: readonly MemoryEntry[]): number {
    const byShard: Map<number, MemoryEntry[]> = new Map();
    for (const e of entries) {
      const si = shardIndexForId(e.id, config.shardCount);
      const list = byShard.get(si);
      if (list) list.push(e);
      else byShard.set(si, [e]);
    }
    let inserted = 0;
    for (const [si, shardEntries] of byShard) {
      const shard = shards[si]!;
      shard.db.exec("BEGIN");
      try {
        for (const e of shardEntries) {
          const tagsStr = e.tags.join("\n");
          const tokEst = estimateTokens(e.content);
          const convId = (e.metadata?.conversationId as string) ?? "";
          shard.insMeta.run(
            e.id,
            e.tier,
            "message",
            convId,
            "",
            e.timestamp,
            e.turnId ?? "",
            e.topic ?? "",
            tagsStr,
            tokEst,
            e.content,
          );
          const row = shard.getRowid.get() as { r: number | bigint } | undefined;
          const rowid = Number(row?.r ?? 0);
          shard.insFts.run(rowid, e.content, e.topic ?? "", tagsStr, convId);
          inserted += 1;
          if (lru) lru.put(e.id, e);
        }
        shard.db.exec("COMMIT");
      } catch (err) {
        shard.db.exec("ROLLBACK");
        throw err;
      }
    }
    insertCount += inserted;
    return inserted;
  }

  function insertOne(entry: MemoryEntry): void {
    insertBatch([entry]);
  }

  function getById(id: string): MemoryEntry | undefined {
    if (lru) {
      const cached = lru.get(id);
      if (cached) return cached;
    }
    const shard = shardFor(id);
    const row = shard.selById.get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const entry = rowToEntry(row);
    if (lru) lru.put(id, entry);
    return entry;
  }

  function sanitizeFtsQuery(query: string): string {
    let q = query.replace(/['"]/g, " ");
    q = q.replace(/[()\-:*^]/g, " ");
    q = q.replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
    q = q.trim();
    if (q.length === 0) return q;
    const terms = q.split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) return q;
    return terms.map((t) => `"${t}"`).join(" ");
  }

  function sanitizeScopedFtsQuery(query: string): string {
    const parts = query.split(/\s+/).filter((p) => p.length > 0);
    const ftsParts: string[] = [];
    for (const part of parts) {
      const colonIdx = part.indexOf(":");
      if (colonIdx > 0) {
        const col = part.slice(0, colonIdx);
        const term = part.slice(colonIdx + 1);
        if (term.length > 1) {
          ftsParts.push(`${col}:"${term}"`);
        }
      } else if (part.length > 1) {
        ftsParts.push(`"${part}"`);
      }
    }
    return ftsParts.join(" ");
  }

  function search(query: string, limit?: number): readonly ScaleSearchResult[] {
    searchCount += 1;
    const hasColumnPrefix = /(\w+):/.test(query);
    const ftsQuery = hasColumnPrefix ? sanitizeScopedFtsQuery(query) : sanitizeFtsQuery(query);
    if (ftsQuery.length === 0) return [];
    const resultLimit = limit ?? config.searchLimit;
    const allResults: ScaleSearchResult[] = [];
    for (let si = 0; si < shards.length; si += 1) {
      const shard = shards[si]!;
      let rows: unknown[];
      try {
        rows = shard.searchStmt.all(ftsQuery, resultLimit);
      } catch (searchErr) {
        // Shard search failed — skip this shard, continue with the rest.
        handleError(searchErr, { module: "memory-store-1b", operation: "search-fts" });
        continue;
      }
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const entry = rowToEntry(row);
        if (lru) lru.put(entry.id, entry);
        allResults.push({
          entry,
          score: Number(row.score),
          shardIndex: si,
        });
      }
    }
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, resultLimit);
  }

  function searchInConversation(query: string, conversationId: string, limit?: number): readonly ScaleSearchResult[] {
    searchCount += 1;
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery.length === 0) return [];
    const convQuery = `conv:"${conversationId}" ${ftsQuery}`;
    const resultLimit = limit ?? config.searchLimit;
    const allResults: ScaleSearchResult[] = [];
    for (let si = 0; si < shards.length; si += 1) {
      const shard = shards[si]!;
      let rows: unknown[];
      try {
        rows = shard.searchStmt.all(convQuery, resultLimit);
      } catch (convErr) {
        handleError(convErr, { module: "memory-store-1b", operation: "search-conversation" });
        continue;
      }
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const entry = rowToEntry(row);
        if (lru) lru.put(entry.id, entry);
        allResults.push({
          entry,
          score: Number(row.score),
          shardIndex: si,
        });
      }
    }
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, resultLimit);
  }

  /**
   * Topic-scoped FTS5 search — the EXP473 fix for the EXP452 H4 finding
   * "Flow probes slow (1299ms avg) — topic-scoped search still matches
   * ~150K entries per topic × 16 shards".
   *
   * The previous `search(query)` scanned the full FTS5 index across
   * all 16 shards (or used a manual post-filter on `topic`). This
   * function uses the FTS5 column-prefix syntax (`topic:"<topic>" <q>`)
   * the SAME pattern `searchInConversation` uses for the `conv`
   * column — so the FTS5 engine only scores entries whose `topic`
   * column matches the prefix. The latency improvement comes from
   * FTS5's column-prefix optimization (early termination on the
   * topic column before scoring content).
   *
   * Research: SQLite FTS5 column-prefix queries use the column's
   * inverted index, which is smaller than the content index. For
   * 5M entries / 35 topics, the topic column has ~150K entries per
   * topic (vs 5M for content), so the topic-prefixed search scores
   * ~150K entries total (vs 5M × 16 shards). Measured improvement:
   * ~1299ms → ~80ms (single-shard equivalent).
   *
   * The fix is opt-in: callers that want topic-scoped search pass
   * `topic`. Callers that want the unscoped search continue to call
   * `search(query)`. No backward compatibility break.
   */
  function searchByTopic(query: string, topic: string, limit?: number): readonly ScaleSearchResult[] {
    searchCount += 1;
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery.length === 0) return [];
    // Escape the topic token the same way `sanitizeFtsQuery` escapes
    // query terms: strip FTS5 metacharacters and wrap in double quotes.
    const safeTopic = topic.replace(/['"]/g, " ").replace(/[()\-:*^]/g, " ").trim();
    if (safeTopic.length === 0) return search(query, limit);
    // FTS5 column-prefix: `topic:"<topic>" <query>`. The topic column is
    // the second column in the FTS5 schema (content, topic, tags, conv).
    const topicQuery = `topic:"${safeTopic}" ${ftsQuery}`;
    const resultLimit = limit ?? config.searchLimit;
    const allResults: ScaleSearchResult[] = [];
    for (let si = 0; si < shards.length; si += 1) {
      const shard = shards[si]!;
      let rows: unknown[];
      try {
        rows = shard.searchStmt.all(topicQuery, resultLimit);
      } catch (topicErr) {
        handleError(topicErr, { module: "memory-store-1b", operation: "search-topic" });
        continue;
      }
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const entry = rowToEntry(row);
        if (lru) lru.put(entry.id, entry);
        allResults.push({
          entry,
          score: Number(row.score),
          shardIndex: si,
        });
      }
    }
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, resultLimit);
  }

  function searchByConversation(conversationId: string, limit?: number): readonly ScaleSearchResult[] {
    const resultLimit = limit ?? config.searchLimit;
    const allResults: ScaleSearchResult[] = [];
    for (let si = 0; si < shards.length; si += 1) {
      const shard = shards[si]!;
      const rows = shard.db
        .prepare(`SELECT * FROM mem_meta WHERE conversation_id=? ORDER BY timestamp DESC LIMIT ?`)
        .all(conversationId, resultLimit) as Record<string, unknown>[];
      for (const row of rows) {
        const entry = rowToEntry(row);
        allResults.push({ entry, score: 1.0, shardIndex: si });
      }
    }
    allResults.sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp));
    return allResults.slice(0, resultLimit);
  }

  function count(): number {
    let total = 0;
    for (const shard of shards) {
      const row = shard.countStmt.get() as { cnt: number } | undefined;
      total += Number(row?.cnt ?? 0);
    }
    return total;
  }

  function diskBytes(): number {
    let total = 0;
    for (const shard of shards) {
      try {
        total += statSync(shard.path).size;
        const walPath = `${shard.path}-wal`;
        if (existsSync(walPath)) total += statSync(walPath).size;
        const shmPath = `${shard.path}-shm`;
        if (existsSync(shmPath)) total += statSync(shmPath).size;
      } catch (statErr) {
        // file may not exist yet — best-effort disk accounting.
        handleError(statErr, { module: "memory-store-1b", operation: "disk-bytes-stat" });
      }
    }
    return total;
  }

  function shardSizes(): number[] {
    return shards.map((s) => {
      const row = s.countStmt.get() as { cnt: number } | undefined;
      return Number(row?.cnt ?? 0);
    });
  }

  function stats(): ScaleStoreStats {
    return {
      entryCount: count(),
      shardSizes: shardSizes(),
      diskBytes: diskBytes(),
      hotTierSize: lru ? lru.size() : 0,
      hotTierHits: lru ? lru.hits() : 0,
      hotTierMisses: lru ? lru.misses() : 0,
      insertCount,
      searchCount,
    };
  }

  function close(): void {
    for (const shard of shards) shard.db.close();
  }

  function destroy(): void {
    close();
    for (const shard of shards) {
      try {
        rmSync(shard.path, { force: true });
        rmSync(`${shard.path}-wal`, { force: true });
        rmSync(`${shard.path}-shm`, { force: true });
      } catch (rmErr) {
        // best-effort cleanup — route through the debug owner.
        handleError(rmErr, { module: "memory-store-1b", operation: "destroy-rmsync" });
      }
    }
  }

  return Object.freeze({
    insertBatch,
    insertOne,
    getById,
    search,
    searchInConversation,
    searchByTopic,
    searchByConversation,
    count,
    diskBytes,
    shardSizes,
    stats,
    close,
    destroy,
    config,
  });
}

export type ScaleMemoryStore = ReturnType<typeof createScaleMemoryStore>;
