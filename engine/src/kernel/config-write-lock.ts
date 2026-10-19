/**
 * THE CONFIG FILE'S CROSS-PROCESS WRITE LOCK.
 *
 * `bridlewise.config.json` is written by parallel processes, not just one
 * server: the test suite's fork processes share the real config, and the dev
 * servers and the engine CLI write it too. Two failure classes were measured
 * on that shared file: a LOST UPDATE (two read-modify-write cycles
 * interleaving, a narrowed section and a mutated leaf surviving whole suite
 * runs) and the blind spot that follows from it (a landed residue becomes
 * the NEXT run's "found" bytes, because the self-healing restore that
 * rewrites what it found is itself a read-then-write).
 *
 * The lock itself is the one cross-process file lock
 * (`src/filesystem/file-lock.ts`: acquisition by `link(2)`, holder liveness by
 * pid and start time, nonce-checked release, re-entrancy, the bounded
 * synchronous wait). What is the config's own is WHERE the lock lives and the
 * error its timeout raises: beside the config it protects, inside the state
 * directory, named after the config's basename — two config files never share
 * a lock, and a test's scratch copy of the config gets its own lock in its
 * own temporary world.
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { ConfigWriteLockTimeout, InputError } from "./errors.ts";
import { STATE_DIRECTORY_NAME } from "./product-identity.ts";
import { withFileLock } from "../filesystem/file-lock.ts";

/** The lock file's name prefix inside the state directory beside the config. */
const LOCK_FILE_PREFIX = "config-write-" as const;

/** The lock file path derived from a config file path. */
export function configWriteLockPath(configPath: string): string {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new InputError(
      "the config write lock needs a config path",
      "config_path_invalid",
      { configPath: String(configPath) },
    );
  }
  // RESOLVED, always: the config path can reach callers as a relative
  // string (the web server's default is one), and two processes that spell
  // the same file differently must still derive the SAME lock — resolving
  // against the working directory matches exactly how the filesystem calls
  // below resolve the config path itself.
  const resolved = isAbsolute(configPath) ? configPath : resolve(configPath);
  const lockDirectory = join(dirname(resolved), STATE_DIRECTORY_NAME);
  return join(lockDirectory, `${LOCK_FILE_PREFIX}${basename(resolved)}.lock`);
}

/**
 * Run `fn` holding the config's cross-process write lock. Re-entrant within
 * one process: a caller that holds the lock for its whole
 * read-modify-write cycle and writes through a gate that locks internally
 * borrows the hold it already has. The lock is released when `fn` returns
 * or throws — a cycle that fails halfway does not wedge the next writer.
 */
export function withConfigWriteLock<T>(configPath: string, fn: () => T): T {
  return withFileLock(configWriteLockPath(configPath), (message, details) => new ConfigWriteLockTimeout(message, details), fn);
}
