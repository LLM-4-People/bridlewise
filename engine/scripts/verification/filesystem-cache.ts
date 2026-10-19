// Optional filesystem-backed cache shared across processes. Cache envelopes
// bind a key and owner-validated value; writes publish through atomicWriteFile.
// Filesystem failures emit the fixed best-effort diagnostic and callers compute.
//
// maxEntries controls mtime-ordered trimming after the shared append counter
// reaches its threshold. This protocol does not enforce a strict directory cap:
// writes between trims can exceed it, and a delayed reset can discard another
// writer's increments. Capacity/concurrency repair remains required; cache
// admission and diagnostics do not establish a bound or crash durability.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { bestEffort } from "../../src/shared/best-effort.ts";
import { reportBestEffortFailure } from "../../src/shared/debug/debug-system.ts";
import { canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";

const FILESYSTEM_CACHE_SCHEMA_VERSION = "bridlewise-filesystem-cache/v1" as const;
const COUNTER_FILE_NAME = ".write-counter" as const;

type CacheEntry<T> = Readonly<{
  schemaVersion: string;
  cacheKey: string;
  value: T;
}>;

export type FilesystemCacheConfig = Readonly<{
  directory: string;
  maxEntries: number;
}>;

// The counter is shared on disk, but append/stat/trim/reset form separate
// operations. A failed append or stat reports once and declines the trim trigger.
// The reset race is a required capacity repair, not a correctness guarantee.
export function createSharedWriteCounter(counterDirectory: string, maxEntries: number): Readonly<{
  increment: () => boolean;
  reset: () => void;
}> {
  const counterPath = join(counterDirectory, COUNTER_FILE_NAME);
  return deepFreeze({
    increment: () => {
      return bestEffort(() => {
        if (!existsSync(counterDirectory)) {
          mkdirSync(counterDirectory, { recursive: true });
        }
        appendFileSync(counterPath, "1");
        return statSync(counterPath).size >= maxEntries;
      }) ?? false;
    },
    reset: () => {
      bestEffort(() => {
        writeFileSync(counterPath, "");
      });
    },
  });
}

// The analysis-cache key salt. A cached analysis is a function of the
// analyzed bytes AND the analyzer that produced them: an entry written
// before the analyzer's behavior changed must never be read back after —
// a stale entry would mask the change, silently serving pre-change
// results (a fixed scanner answering from before the fix). The
// analyzer's OWN BYTES are therefore part of every analysis-cache key:
// change the analyzer and every key changes with it. The analyzer is the
// module that owns the analysis function; a behavioral dependency (the
// classifier or plugin-selection module the analysis calls into) is part
// of its bytes too. If any source is unavailable, callers bypass result
// caches and compute. Only successful identities are memoized, so a later
// call can recover. Ordered JSON tuples frame both URL identity and source
// contents; embedded NULs cannot merge adjacent tuple members.
const analysisSemanticsIds = new Map<string, string>();
export function analysisSemanticsId(analyzerUrl: string | URL, ...behavioralDependencyUrls: readonly (string | URL)[]): string | undefined {
  const urls = [analyzerUrl, ...behavioralDependencyUrls];
  const memoKey = canonicalJson(urls.map((url) => String(url)));
  const memoized = analysisSemanticsIds.get(memoKey);
  if (memoized !== undefined) return memoized;
  const id = bestEffort(() =>
    sha256(canonicalJson(urls.map((url) => readFileSync(fileURLToPath(url), "utf8")))));
  if (id !== undefined) analysisSemanticsIds.set(memoKey, id);
  return id;
}

export function createFilesystemCache(config: FilesystemCacheConfig): Readonly<{
  read: <T>(cacheKey: string, validate: (value: unknown) => T | undefined) => T | undefined;
  write: <T>(cacheKey: string, value: T) => void;
}> {
  const cacheDirectory = join(tmpdir(), config.directory);
  const counter = createSharedWriteCounter(cacheDirectory, config.maxEntries);

  function cachePath(cacheKey: string): string {
    // The cache key may contain null bytes (path\0contentHash\0analysisSalt);
    // hash it for a filesystem-safe file name.
    return join(cacheDirectory, `${sha256(Buffer.from(cacheKey, "utf8"))}.json`);
  }

  function read<T>(cacheKey: string, validate: (value: unknown) => T | undefined): T | undefined {
    return bestEffort(() => {
      const path = cachePath(cacheKey);
      if (!existsSync(path)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== FILESYSTEM_CACHE_SCHEMA_VERSION) return undefined;
      if (typeof record.cacheKey !== "string" || record.cacheKey !== cacheKey) return undefined;
      const validated = validate(record.value);
      return validated === undefined ? undefined : deepFreeze(validated);
    }) ?? undefined;
  }

  function trim(): void {
    bestEffort(() => {
      const entries = readdirSync(cacheDirectory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const stats = statSync(join(cacheDirectory, name));
          return { name, mtimeMs: stats.mtimeMs };
        })
        .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
      const excess = entries.length - config.maxEntries;
      if (excess <= 0) return;
      for (let index = 0; index < excess; index += 1) {
        bestEffort(() => {
          unlinkSync(join(cacheDirectory, entries[index]!.name));
        });
      }
    });
  }

  function write<T>(cacheKey: string, value: T): void {
    bestEffort(() => {
      if (!existsSync(cacheDirectory)) {
        mkdirSync(cacheDirectory, { recursive: true });
      }
      const entry: CacheEntry<T> = { schemaVersion: FILESYSTEM_CACHE_SCHEMA_VERSION, cacheKey, value };
      const result = atomicWriteFile(cachePath(cacheKey), `${canonicalJson(entry)}\n`);
      if (!result.success) {
        reportBestEffortFailure();
        return;
      }
      // Trim and reset remain separate operations; see the capacity limit above.
      if (counter.increment()) {
        trim();
        counter.reset();
      }
    });
  }

  return deepFreeze({ read, write });
}
