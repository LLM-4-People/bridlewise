import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { identityOverlapIndex, resolveLocation } from "./path-identity.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { assertCheckoutWriteAllowed } from "./checkout-write-door.ts";
import { ownedSiblingTemporaryName, sweepAbandonedSiblingTemporaries } from "./private-state.ts";

/**
 * Canonical atomic file-write authority.
 *
 * Writes `content` to a sibling temp file in the same directory as
 * `resolvedPath`, fsyncs it, then renames it over the target. A crash during
 * the write leaves the original target intact; the orphaned temp file is
 * cleaned up on the next attempt or by the caller. The temp file is created
 * with `O_EXCL` (mode from `ROOT_POLICY.filesystemInfrastructure.privateState.fileMode`)
 * so two concurrent writers cannot clobber each other's temp files — each
 * gets a unique temp name and the rename is atomic on POSIX.
 *
 * This is the single owner of the write-temp-then-rename pattern, for the
 * engine AND the web server: the transactional editor, the module registrar
 * and every generator, the server's config writer and its editor bridge (the
 * server's own copy, `server/filesystem/atomic-write.ts`, was a second owner
 * the checkout write door did not guard — wf1a-design H-2 — and is deleted).
 * Several files replaced as one fact go through the journaled commit
 * (`journaled-commit.ts`), which is built on this.
 *
 * Returns `{ success: true }` on success or `{ success: false, reason }` on
 * failure; callers decide how to surface the failure. The ONE exception is a
 * REFUSAL, which throws before anything is written: the checkout write door
 * (`checkout-write-door.ts`) refuses a test process — or any descendant of
 * one — that would write a file the checkout under test owns. Every generator
 * writes through here, so the door covers them without a list.
 *
 * ── REPLACING A FILE'S CONTENTS DOES NOT CHANGE ITS PERMISSIONS ───────────
 *
 * A rename REPLACES THE INODE. The new inode's mode is the temp file's, not
 * the target's — and the temp file is deliberately created private. So every
 * atomic write silently re-permissioned its target, and the change was
 * INVISIBLE: git records only the executable bit, so `git status` reports a
 * clean tree while 52 tracked files sat at 0600 against 100644 in the index.
 * It cost three probes chasing an unrelated failure before anyone thought to
 * run `stat`. (An audit put the figure at 53 by counting the configuration
 * document, whose 0600 is REQUIRED and enforced by the config reader — it was
 * never drift, and "restoring" it stopped the suite from running at all.
 * Every mode that looks wrong is worth asking who requires it.)
 *
 * The mode is therefore carried across the rename: the temp file is chmodded
 * to whatever the target already had, through the open descriptor, so there
 * is no window in which the path can be swapped. Only a file that did not
 * exist takes the private default, which is the deny-by-default answer for
 * something this process is creating.
 *
 * Fixing it HERE is the point. This is the single owner of write-temp-then-
 * rename, so every caller — including ones written after this comment, by
 * someone who never learns this happened — inherits the guarantee with no
 * call-site edit. A list of files to re-chmod would have gone stale the next
 * time anything was written.
 */

/** On failure `error` is always set: the caught failure itself, for a caller that rethrows it with its errno code intact. */
export type AtomicWriteResult = Readonly<{ success: boolean; reason?: string; error?: unknown }>;

export type AtomicWriteOptions = Readonly<{
  /**
   * A mode the target MUST hold after the write, regardless of what it holds
   * now. When set, the result mode is the target's current mode tightened to
   * be no more permissive than `requiredMode` — an existing file that is too
   * open is tightened to `requiredMode`, and an existing file already that
   * strict (or stricter) keeps its own mode. A new file gets `requiredMode`.
   *
   * This is the answer to "the config must be 0600, full stop": preserving an
   * existing 0664 across the rename keeps the file readable by other accounts
   * and the next read refuses it — the recurring cascade. Tightening at the
   * single write owner means no caller remembers to chmod, and no write can
   * leave the file more open than the floor.
   */
  requiredMode?: number;
  /** Exact permissions for an explicitly admitted restoration, applied before publication. */
  exactMode?: number;
  /**
   * The mode a NEW file is created with, before the umask — what a plain
   * `open(2)` would be handed. Default: the private state mode (deny by
   * default). `0o666` is exactly what an ordinary write produces (the umask
   * decides), for a writer of the user's own files (the editor bridge). An
   * EXISTING file's own mode always wins; `requiredMode`/`exactMode` win over
   * this.
   */
  createMode?: number;
  /**
   * Whether missing parent directories are created (default true, what every
   * generator needs). A writer whose contract is "the directory must already
   * exist" (the editor's create-file refuses a missing parent) passes false,
   * and the write fails with the rename's ENOENT.
   */
  createParentDirectories?: boolean;
  /**
   * Roots a FINAL-COMPONENT symbolic link at the target may resolve into (the
   * write kind's own root: the config document's directory for the config
   * save, the project for the editor). A link whose target lies — by device
   * and inode, so a bind-mount alias counts — inside one of them is written
   * THROUGH: the file it names is replaced and the link stays a link. Any
   * other link — resolving elsewhere, dangling or looping — is REFUSED typed
   * and never replaced by a regular file. Default: none (every final link is
   * refused), so a writer that meets a link it did not expect stops.
   */
  linkTargetRoots?: readonly string[];
  /**
   * DURABLE: every fsync is part of the write — the temp file's before the
   * rename and the directory's after it — and a failed fsync is a failed
   * write, never swallowed. For a write whose loss after a power cut would
   * be a false fact (the journaled commit's journal, its `verified` mark and
   * its rollback restores). Default: the temp file's fsync is best effort.
   */
  durable?: boolean;
  /**
   * EXCLUSIVE: the target must not exist; the complete, fsynced temp file is
   * PUBLISHED under the target's name with `link(2)`, which fails when the
   * name exists (`EEXIST`), so no reader ever sees the file half-written and
   * a failed write (a full disk) leaves nothing behind. For a record whose
   * presence is itself the fact (a journal).
   */
  exclusive?: boolean;
}>;

/** The atomic writer's temp files: owned sibling temporaries (`private-state.ts`) of this kind beside the target. */
export const ATOMIC_WRITE_TEMPORARY_KIND = "write";
const PRIVATE_FILE_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode;

/**
 * Where a write to `path` lands: the path itself, or — for a final-component
 * link whose target lies inside one of `roots` — the file the link names.
 * Refuses (throws, typed) every other link: THE ONE RULE for every writer.
 */
export function atomicWriteTargetOf(path: string, roots: readonly string[]): string {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    // Nothing there (a first write creates it), or a fault the write reports.
    return path;
  }
  if (!isLink) return path;
  let target: string;
  try {
    target = realpathSync(path);
  } catch (error) {
    throw new SecurityError(
      `the write target ${path} is a symbolic link that does not resolve (dangling or looping: ${extractErrorMessage(error)}); nothing was written`,
      "atomic_write_link_unresolved",
    );
  }
  const identity = identityOverlapIndex();
  const resolvedTarget = resolveLocation(target, "the write target's link");
  if (roots.some((root) => identity.atOrUnder(resolvedTarget, resolveLocation(resolve(root), "a link target root")))) return target;
  throw new SecurityError(
    `the write target ${path} is a symbolic link to ${target}, outside ${roots.length === 0 ? "any root this write may follow a link into" : roots.join(", ")}; nothing was written and the link was not replaced`,
    "atomic_write_link_refused",
  );
}

/** The directory's own fsync: a rename or link inside it is durable only after this. */
export function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteFile(requestedPath: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): AtomicWriteResult {
  const resolvedPath = atomicWriteTargetOf(requestedPath, options.linkTargetRoots ?? []);
  assertCheckoutWriteAllowed(resolvedPath);
  const dir = dirname(resolvedPath);
  const tempPath = join(dir, ownedSiblingTemporaryName(basename(resolvedPath), ATOMIC_WRITE_TEMPORARY_KIND));
  // A writer killed between its temp and its publish left its temp beside the
  // target: the first write of this process into a directory removes what
  // dead writers left there (never a live writer's; never fails this write).
  bestEffort(() => sweepAbandonedSiblingTemporaries(dir, ATOMIC_WRITE_TEMPORARY_KIND));

  // The mode the target has NOW, read before anything is written. `undefined`
  // means there is no target yet, and a file this process is creating keeps
  // the private default rather than inheriting whatever the umask allows.
  //
  // Asked in ONE stat that answers absence (`throwIfNoEntry: false`) rather
  // than wrapped in a `try`: "there is no file there" is an ANSWER, not an
  // error, and turning a real stat failure into `undefined` would quietly
  // re-permission the very file it could not read. Never `existsSync` then
  // `statSync`: a target removed between the two (a released lock file, a
  // contender's unlink) threw ENOENT out of this function instead of reading
  // as absent (found by twelve parallel declarations racing one lock).
  // Anything else `statSync` can raise belongs to the write below, where it
  // is reported.
  const existing = statSync(resolvedPath, { throwIfNoEntry: false });
  const existingMode = existing === undefined ? undefined : existing.mode & 0o7777;
  // Tighten, never loosen: a `requiredMode` floor caps how open the result may
  // be, so a too-permissive existing file is brought back to the floor instead
  // of carried across the rename.
  if (options.requiredMode !== undefined && options.exactMode !== undefined) {
    const error = new InputError("Atomic write mode policies are mutually exclusive", "atomic_write_modes_exclusive");
    return { success: false, reason: error.message, error };
  }
  const targetMode = options.exactMode ?? (options.requiredMode !== undefined
    ? existingMode === undefined
      ? options.requiredMode
      : existingMode & options.requiredMode
    : existingMode);

  let fd: number | undefined;
  try {
    if (options.createParentDirectories !== false) bestEffort(() => mkdirSync(dir, { recursive: true }));
    // A new file with no mode policy is created the way the caller asked (the
    // umask applies, as for any open); every other case starts private and is
    // widened to its target mode through the descriptor below.
    fd = openSync(tempPath, "wx", targetMode === undefined ? options.createMode ?? PRIVATE_FILE_MODE : PRIVATE_FILE_MODE);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    const fdSafe = fd;
    if (options.durable === true) fsyncSync(fdSafe);
    else bestEffort(() => fsyncSync(fdSafe));
    // Through the DESCRIPTOR, not the path: the temp name cannot be swapped
    // for something else between the write and the permission change. NOT
    // best-effort — a write that silently re-permissions its target is the
    // defect this exists to prevent, so failing to carry the mode across is
    // a failed write, not a footnote.
    if (targetMode !== undefined) fchmodSync(fdSafe, targetMode);
    closeSync(fd);
    fd = undefined;
    if (options.exclusive === true) {
      linkSync(tempPath, resolvedPath);
      unlinkSync(tempPath);
    } else {
      renameSync(tempPath, resolvedPath);
    }
    if (options.durable === true) fsyncDirectory(dir);
    return { success: true };
  } catch (error) {
    const reason = extractErrorMessage(error);
    if (fd !== undefined) {
      const fdErr = fd;
      bestEffort(() => closeSync(fdErr));
    }
    bestEffort(() => unlinkSync(tempPath));
    return { success: false, reason, error };
  }
}
