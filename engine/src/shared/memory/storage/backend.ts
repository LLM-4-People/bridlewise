// src/shared/memory/storage/backend.ts
// Storage backend interface + factory. Single owner of the storage contract.
// Backends: json, sqlite (node:sqlite), msgpack (pure-TS), append-log.
// All backends implement the same MemoryStoragePort so the store is backend-
// agnostic (benchmark swaps backends via config).

import type { MemoryEntry } from "../memory-entry.ts";
import type { StorageBackend } from "../memory-config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InputError } from "../../../kernel/errors.ts";
import { createOwnedTemporaryDirectory } from "../../../filesystem/private-state.ts";
import { createAppendLogStorage } from "./append-log-backend.ts";
import { createJsonStorage } from "./json-backend.ts";
import { createMsgpackStorage } from "./msgpack-backend.ts";
import { createSqliteStorage } from "./sqlite-backend.ts";

export type MemoryStoragePort = Readonly<{
  readonly backend: StorageBackend;
  /** Persist all entries (full snapshot for json/msgpack; no-op for append-log). */
  flush(entries: readonly MemoryEntry[]): void;
  /** Append a single entry (append-log native; others buffer + flush). */
  append(entry: MemoryEntry): void;
  /** Load all persisted entries (cold-tier reconstruction). */
  load(): readonly MemoryEntry[];
  /** Bytes written to disk (cumulative; for benchmark disk-IO measurement). */
  bytesWritten(): number;
  /** Number of flush/append operations. */
  opCount(): number;
  /** Close + release resources (SQLite handles, file handles). */
  close(): void;
}>;

export type StorageFactoryOptions = Readonly<{
  backend: StorageBackend;
  /** The cold tier's file; `null`: a file in an owned temporary folder of this process (removed when it exits). */
  path: string | null;
}>;

/** What a backend is handed: always a path (never a shared default under `/tmp`, which every user and run would share). */
export type BackendStorageOptions = Readonly<{ path: string }>;

export function createStorage(options: StorageFactoryOptions): MemoryStoragePort {
  const backendOptions: BackendStorageOptions = {
    path: options.path ?? join(createOwnedTemporaryDirectory(tmpdir(), "shared-memory-cold-"), `cold.${options.backend}`),
  };
  switch (options.backend) {
    case "json":
      return createJsonStorage(backendOptions);
    case "sqlite":
      return createSqliteStorage(backendOptions);
    case "msgpack":
      return createMsgpackStorage(backendOptions);
    case "append-log":
      return createAppendLogStorage(backendOptions);
    default:
      throw new InputError(`unknown storage backend: ${String(options.backend)}`, "shared_memory_unknown_storage_backend");
  }
}
