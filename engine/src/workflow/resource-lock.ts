/**
 * NAMED RESOURCE LOCKS — the test lock (`harness test`) and the workspace
 * lock (`harness workspace`: admission and merge), each a lock file under a
 * lock directory (the checkout's, or the repository registry's).
 *
 * The lock itself is the one cross-process file lock
 * (`src/filesystem/file-lock.ts`: acquisition by `link(2)`, a live holder is
 * never broken, a dead holder's lock is broken at once and atomically, an
 * unreadable one only after its bound, every break and timeout audited).
 * What is the resource lock's own is WHERE a resource's lock lives (a
 * validated name under the lock directory), the typed timeout it raises, and
 * the handle it returns. It used to be a second implementation that broke a
 * LIVE holder after 300 s and removed a stale lock with a plain unlink that
 * could remove a contender's fresh one (wf-del2-design D1).
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { deepFreeze } from "../kernel/integrity.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import type { ConfigDocument } from "../kernel/config-contracts.ts";
import { acquireFileLock } from "../filesystem/file-lock.ts";
import { DEFAULT_LOCK_DIRECTORY, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_LOCK_POLL_INTERVAL_MS, DEFAULT_LOCK_STALE_MS, numericOption } from "./workflow-config.ts";

// The lock modes are the private-state policy's (the one source of truth).
export const LOCK_FILE_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode;
export const LOCK_DIR_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.directoryMode;
export const RESOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export type ResourceLockHandle = Readonly<{
  resource: string;
  lockPath: string;
  pid: number;
  acquiredAt: string;
  owner: string | null;
  release: () => void;
}>;

export type AcquireLockOptions = Readonly<{
  lockDirectory?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * How old an UNREADABLE lock file (one no harness process wrote) must be
   * before it is broken. A live holder is never broken, whatever its age; a
   * dead holder's lock is broken at once.
   */
  unreadableAfterMs?: number;
  owner?: string;
}>;

/**
 * The lock options the configuration declares (`resourceLock`: the wait, the
 * poll interval, the age after which an UNREADABLE lock is broken) for a
 * lock held by `owner` — an undeclared section leaves the lock owner's
 * defaults, but the wait is always resolved (a ceiling over a run that waits
 * for the lock counts it). The one reader (the test lock, a promotion's
 * locks).
 */
export function configuredLockOptions(document: Pick<ConfigDocument, "resourceLock">, owner: string): AcquireLockOptions & Readonly<{ timeoutMs: number }> {
  const declared = document.resourceLock;
  return {
    owner,
    timeoutMs: declared?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    ...(declared !== undefined ? { pollIntervalMs: declared.pollIntervalMs, unreadableAfterMs: declared.staleMs } : {}),
  };
}

export class LockAcquisitionTimeout extends HarnessError {
  constructor(resource: string, timeoutMs: number, detail = "") {
    super(
      `lock acquisition timed out for resource "${resource}" after ${timeoutMs}ms${detail.length > 0 ? `: ${detail}` : ""}`,
      "lock_acquisition_timeout",
      true,
      { resource, timeoutMs },
    );
  }
}

export function validateResourceName(resource: string): void {
  if (typeof resource !== "string" || resource.length === 0) {
    throw new InputError("lock resource must be a non-empty string", "input_error");
  }
  if (resource.length > 128) {
    throw new InputError("lock resource name exceeds 128 characters", "input_error");
  }
  if (!RESOURCE_NAME_PATTERN.test(resource)) {
    throw new InputError(
      `lock resource name is invalid: "${resource}" (must match ${RESOURCE_NAME_PATTERN.source})`,
      "input_error",
    );
  }
}

export function lockPathFor(
  root: string,
  resource: string,
  lockDirectory: string = DEFAULT_LOCK_DIRECTORY,
): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new InputError("root must be a non-empty string", "input_error");
  }
  validateResourceName(resource);
  const absoluteDir = isAbsolute(lockDirectory) ? lockDirectory : resolve(root, lockDirectory);
  return resolve(absoluteDir, `${resource}.lock`);
}

/** The resources whose lock file lies in `lockDirectory` now (held, or left by a dead holder until the next acquisition breaks it), optionally those named with `prefix`. */
export function lockedResources(lockDirectory: string, prefix = ""): readonly string[] {
  if (!existsSync(lockDirectory)) return [];
  return readdirSync(lockDirectory).filter((name) => name.endsWith(".lock") && name.startsWith(prefix)).map((name) => name.slice(0, -".lock".length)).toSorted();
}

export async function acquireLock(
  root: string,
  resource: string,
  options: AcquireLockOptions = {},
): Promise<ResourceLockHandle> {
  const lockPath = lockPathFor(root, resource, options.lockDirectory);
  const timeoutMs = numericOption(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "timeoutMs", "non-negative");
  const pollIntervalMs = numericOption(options.pollIntervalMs, DEFAULT_LOCK_POLL_INTERVAL_MS, "pollIntervalMs", "positive");
  const unreadableAfterMs = numericOption(options.unreadableAfterMs, DEFAULT_LOCK_STALE_MS, "unreadableAfterMs", "positive");
  const owner = options.owner ?? null;
  const handle = await acquireFileLock(lockPath, (message) => new LockAcquisitionTimeout(resource, timeoutMs, message), {
    holder: owner, timeoutMs, pollIntervalMs, unreadableAfterMs,
  });
  return deepFreeze({ resource, lockPath, pid: process.pid, acquiredAt: handle.acquiredAt, owner, release: handle.release });
}

export async function withLock<T>(
  root: string,
  resource: string,
  fn: () => Promise<T>,
  options: AcquireLockOptions = {},
): Promise<T> {
  const handle = await acquireLock(root, resource, options);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
