/**
 * THE SYSTEM TEMP ROOT — the one preflight both test runners (and the
 * server) run before they start.
 *
 * HEADROOM: the suites create their temporaries under the system temp root.
 * On this machine it is a tmpfs shared with other projects, and it has run out
 * of INODES while bytes were still free (80-87% used for days): a run started
 * there fails files for reasons that have nothing to do with the code, and the
 * failures read like regressions. So a runner states the headroom before it
 * starts, and WARNS loudly (the operator may know better) when either free
 * share is under `ROOT_POLICY.filesystemInfrastructure.temporaryRootMinimumFreeFraction`.
 *
 * PLACE: a temp root inside the safety floor, or a relative one, is REFUSED
 * ({@link temporaryRootKeepOutRefusal}): every temporary the harness made
 * there would be refused or land somewhere else.
 */
import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { sweepAbandonedTemporaries } from "./private-state.ts";
import { floorKeepOutVerdict } from "./self-protection/keep-out.ts";

export type TemporaryRootHeadroom = Readonly<{
  root: string;
  freeBytesFraction: number;
  freeInodesFraction: number;
  /** Either share under the policy's minimum. */
  low: boolean;
}>;

/** The temp root's free bytes and inodes as shares of its size, or `undefined` when the filesystem cannot say. */
export function temporaryRootHeadroom(root: string = tmpdir()): TemporaryRootHeadroom | undefined {
  const stats = statfsSync(root);
  if (stats.blocks <= 0 || stats.files <= 0) return undefined;
  const freeBytesFraction = stats.bavail / stats.blocks;
  const freeInodesFraction = stats.ffree / stats.files;
  const minimum = ROOT_POLICY.filesystemInfrastructure.temporaryRootMinimumFreeFraction;
  return Object.freeze({ root, freeBytesFraction, freeInodesFraction, low: freeBytesFraction < minimum || freeInodesFraction < minimum });
}

/** One line for a runner to print: the headroom, and a warning when it is low. */
export function temporaryRootPreflightLine(runner: string, headroom: TemporaryRootHeadroom | undefined): string {
  if (headroom === undefined) return `[${runner}] the temp root's headroom is unknown (the filesystem reports no size)`;
  const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;
  const facts = `${headroom.root}: ${percent(headroom.freeBytesFraction)} of bytes and ${percent(headroom.freeInodesFraction)} of inodes free`;
  return headroom.low
    ? `[${runner}] WARNING — the temp root is nearly full (${facts}); tests that create temporaries may fail for this reason alone — free space (df -h, df -i) before trusting a red`
    : `[${runner}] temp root ${facts}`;
}

/**
 * A TEMP ROOT INSIDE THE SAFETY FLOOR IS REFUSED (TMPDIR-KEEPOUT-001). The
 * harness keeps its confined commands, key homes and stores out of every
 * floor entry (`~/.local/state/<product>-*` holds other checkouts and
 * backups; a home's credential stores; the harness's own code), so under a
 * temp root there it refuses its OWN temporary files, and the failures read
 * like regressions (A2b's run under `~/.local/state/bridlewise-tmp/`). A
 * runner and the server refuse to start there instead: the sentence names
 * the entry and the fix, or `undefined` when the temp root is clear.
 * `harnessRoot` is the checkout's engine (the folder of its config).
 */
export function temporaryRootKeepOutRefusal(harnessRoot: string, root: string = tmpdir()): string | undefined {
  // A relative TMPDIR names a different folder in every working directory (a
  // test that changes directory writes elsewhere); refused in the same one line.
  if (!isAbsolute(root)) {
    return `the temp root ${root} is a relative path, a different folder in every working directory; ` +
      `set TMPDIR to an absolute private folder outside the floor (e.g. ~/.cache/bridlewise-tmp/<task>, mode 0700)`;
  }
  const verdict = floorKeepOutVerdict(harnessRoot, root);
  if (verdict === undefined) return undefined;
  const entry = `${verdict.entry.path}${verdict.entry.prefix ? "*" : ""}`;
  return `the temp root ${root} ${verdict.relation === "under" ? "lies inside" : "holds"} the safety floor's keep-out entry ${entry}, ` +
    `where the harness refuses its own temporary files; set TMPDIR to a private folder outside the floor (e.g. ~/.cache/bridlewise-tmp/<task>, mode 0700)`;
}

/**
 * WHAT A RUN LEFT IN ITS TEMP ROOT, removed when it ends: every owned
 * temporary (`private-state.ts` naming, any prefix) whose owner is dead. A
 * test worker ended by a signal runs no exit hook, so its owned folders (a
 * confined spawn's spec folder, a process's fixture root) would otherwise wait
 * for the next creation under the same prefix. A concurrent run's folders are
 * kept: their owners are alive. Both runners call it when their run ends.
 */
export function sweepEndedRunTemporaries(runner: string, root: string = tmpdir()): string {
  const removed = sweepAbandonedTemporaries(root);
  return `[${runner}] removed ${String(removed.length)} temporary folder(s) left by ended processes in ${root}`;
}
