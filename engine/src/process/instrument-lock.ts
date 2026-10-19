/**
 * THE ONE INSTRUMENT LOCK OF THE HOST (L-2026-10-04-serialized-heavy-slot-is-exclusive;
 * UR-16, UR-18, UR-23). Every heavy instrument — a whole suite, a coverage
 * run, a browser profile or e2e run, `ws validate`/`ws merge`, an ad-hoc load
 * run (`harness slot run -- <command>`) — holds ONE lock of this host, so no
 * two instruments ever share the cores, in one checkout or across checkouts.
 * A second heavy run WAITS, saying who holds the lock; it never fails for the
 * wait and never runs beside the holder. One behaviour everywhere.
 *
 * IT IS THE ONE LOCK PRIMITIVE (`src/filesystem/file-lock.ts`): its record
 * (written by that owner's one serializer: pid AND start time, a nonce, a
 * bounded holder label), its liveness, its break of a dead holder, its
 * release. Two things are this lock's own:
 *
 * - WHERE: one file per HOST user, its place from config
 *   (`testExecution.instrumentLock.cacheRelativeLockPath`) under the cache
 *   folder of the home the password database names (`hostUserCacheFolder`):
 *   never `$HOME` or `$XDG_CACHE_HOME`, so a run under a substitute HOME still
 *   waits for the others; refused inside a checkout or the keep-out floor;
 *   and WHAT IS HEAVY (`testExecution.instrumentLock.minimumTestFiles`):
 *   a run of that many test files or more; a targeted run of fewer is light
 *   and takes nothing.
 * - NESTING, read from the record's STRUCTURED fields (never a label): a run
 *   whose live holder — the holder process or one it adopted — is this
 *   process or one of its ancestors is inside the hold (a validate's suites,
 *   a slot run's command, vitest inside the web runner) and BORROWS it.
 *
 * A HOLD OUTLIVES A KILLED HOLDER: every command a holder runs under the
 * native supervisor (`supervised-run.ts`) is ADOPTED into the record, so a
 * holder killed outright leaves the lock held until that supervisor — which
 * ends only after its whole process tree is gone — has ended too.
 *
 * THE STAMP every measurement carries ({@link instrumentLockStamp}): "held"
 * when this process runs inside a live hold AND carries that hold's own
 * acquisition token (the owner exports its record's nonce to everything it
 * starts, `HARNESS_INSTRUMENT_LOCK_TOKEN`), else "unslotted". A record
 * written by hand that names the caller's pid stamps nothing without the
 * token. The limit, stated: a process of the same user can write both the
 * record and its own environment; the lock file is private to that user
 * (folder 0700, file 0600), and the stamp is integrity, not a boundary.
 */
import { dirname, isAbsolute, join } from "node:path";

import { HarnessError, InstrumentLockWaitInterrupted } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { identityOverlapIndex, resolveLocation } from "../filesystem/path-identity.ts";
import { liveFileLockHolder, ownsFileLockHold, printableHolderLabel, tryAcquireFileLock, type FileLockContent } from "../filesystem/file-lock.ts";
import { floorKeepOutVerdict } from "../filesystem/self-protection/keep-out.ts";
import type { WholeInstrumentKind } from "../kernel/config-contracts.ts";
import { hostUserCacheFolder } from "../filesystem/user-folders.ts";
import { repositoryToplevel } from "../git/repository-ownership.ts";
import { ownedInstrumentHold, setOwnedInstrumentHold } from "./instrument-lock-adoption.ts";
import { ancestorsOf, isOwnProcessIdentityLive } from "./process-facts.ts";
import { guarded } from "./fault-policy.ts";

export type InstrumentLockConfig = Readonly<{
  /** The lock file, relative to the host user's cache folder (`hostUserCacheFolder`). */
  cacheRelativeLockPath: string;
  /** A run of this many test files or more is heavy. */
  minimumTestFiles: number;
  /** The whole instruments that are heavy by kind, whatever files they name. */
  wholeInstruments: readonly WholeInstrumentKind[];
  /** How often a waiting run looks at the lock again. */
  pollIntervalMs: number;
}>;

/** Whether a measurement ran inside a live hold of the one instrument lock. */
export type InstrumentLockStamp = "held" | "unslotted";

/** The variable an owner exports its acquisition token (the record's nonce) in, for the stamp of everything it starts. */
export const INSTRUMENT_LOCK_TOKEN_VARIABLE = "HARNESS_INSTRUMENT_LOCK_TOKEN";

export type InstrumentHold = Readonly<{
  /** This process took the lock (a borrowed or light hold owns nothing). */
  owns: boolean;
  runner: string;
  path: string;
  /** The measurement's stamp for the run this hold covers. */
  stamp: InstrumentLockStamp;
  /** Frees an owned hold (idempotent; a borrowed or light hold frees nothing). */
  release: () => void;
}>;

/**
 * The lock file of `config` for the harness checkout at `harnessRoot`: under
 * the per-user cache folder, and refused (`instrument_lock_misplaced`)
 * inside the checkout or the keep-out floor — by identity.
 */
export function instrumentLockPath(config: InstrumentLockConfig, harnessRoot: string): string {
  const misplaced = (why: string): HarnessError => new HarnessError(`the instrument lock (testExecution.instrumentLock.cacheRelativeLockPath = ${config.cacheRelativeLockPath}) ${why}`, "instrument_lock_misplaced");
  if (isAbsolute(config.cacheRelativeLockPath)) throw misplaced("must be relative to the per-user cache folder");
  const cache = hostUserCacheFolder();
  const lockPath = join(cache, config.cacheRelativeLockPath);
  const folder = resolveLocation(dirname(lockPath), "the instrument lock's folder");
  const overlap = identityOverlapIndex();
  if (!overlap.atOrUnder(folder, resolveLocation(cache, "the per-user cache folder"))) throw misplaced("must stay under the per-user cache folder");
  const repositoryRoot = repositoryToplevel(harnessRoot, "directory") ?? harnessRoot;
  if (overlap.overlaps(folder, resolveLocation(repositoryRoot, "the checkout"))) throw misplaced(`may not be inside or around the checkout ${repositoryRoot}`);
  if (floorKeepOutVerdict(harnessRoot, lockPath) !== undefined) throw misplaced("may not be in the keep-out floor");
  return lockPath;
}

/** A run of `testFileCount` test files is heavy (config, never code). */
export function isHeavyRun(config: InstrumentLockConfig, testFileCount: number): boolean {
  return testFileCount >= config.minimumTestFiles;
}

/**
 * THE COUNT A WHOLE INSTRUMENT PASSES the one heavy rule ({@link isHeavyRun}):
 * every file, when config declares the instrument heavy by kind
 * (`wholeInstruments`). An instrument config does not name is refused, never
 * guessed light: the rule lives in config, and a door of a kind it forgot
 * fails loudly.
 */
export function wholeInstrumentTestFileCount(config: InstrumentLockConfig, instrument: WholeInstrumentKind): number {
  if (!config.wholeInstruments.includes(instrument)) {
    throw new HarnessError(`testExecution.instrumentLock.wholeInstruments does not declare "${instrument}": whether a whole instrument is heavy is config's word, never a guess`, "instrument_lock_instrument_undeclared");
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * `holder`'s LIVE processes (the holder and what it adopted) include this
 * process or one of its ancestors — each judged by its full identity (pid AND
 * start time, this user's): an adopted entry whose process ended is pruned
 * only at the next adoption, and its pid recycled into this lineage is not the
 * process the hold adopted (security L-3).
 */
function holdsThisProcess(holder: FileLockContent): boolean {
  const lineage = new Set([process.pid, ...ancestorsOf(process.pid)]);
  return [{ pid: holder.pid, startTime: holder.startTime }, ...holder.adopted].some((entry) => lineage.has(entry.pid) && isOwnProcessIdentityLive(entry));
}

/**
 * "held" when this process runs inside a live hold of the lock at `lockPath`
 * (see the header): its OWN hold, by the acquisition this process made
 * (`ownsFileLockHold` — one process may hold several locks, and test files
 * sharing a process take their own); or an ancestor's, by the acquisition
 * token the owner exported to what it starts.
 */
export function instrumentLockStamp(lockPath: string): InstrumentLockStamp {
  const holder = liveFileLockHolder(lockPath);
  if (holder === null || !holdsThisProcess(holder)) return "unslotted";
  if (holder.pid === process.pid) return ownsFileLockHold(lockPath, holder.nonce) ? "held" : "unslotted";
  return process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] === holder.nonce ? "held" : "unslotted";
}

/**
 * The hold this process runs inside, BORROWED (it owns nothing and frees
 * nothing), or `undefined` when no live hold covers it — never a wait, never
 * a take.
 */
export function borrowInstrumentLock(lockPath: string, runner: string): InstrumentHold | undefined {
  const holder = liveFileLockHolder(lockPath);
  if (holder === null || !holdsThisProcess(holder)) return undefined;
  return deepFreeze({ owns: false, runner: printableHolderLabel(runner), path: lockPath, stamp: instrumentLockStamp(lockPath), release: () => undefined });
}

/** What a waiting run says about who it waits for. */
function holderLine(holder: FileLockContent): string {
  // The label was escaped and bounded when the record was read (file-lock.ts `printableHolderLabel`).
  return `held by ${holder.holder ?? "an unnamed instrument"} (pid ${String(holder.pid)}, since ${holder.acquiredAt}${holder.adopted.length === 0 ? "" : `, with ${String(holder.adopted.length)} adopted process(es)`})`;
}


/** The signals a waiting door honours: each ends the wait, typed, and the lock is never taken after one. */
const WAIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export { interruptedWaitExitCode } from "../kernel/errors.ts";

/**
 * TAKE THE ONE LOCK for `runner` (a bounded label: who runs, never a command
 * line), WAITING while another heavy run holds it — each change of holder is
 * said through `onWait` — or BORROW it when this process runs inside the
 * hold. Never refuses for a holder; an I/O failure throws.
 *
 * THE WAIT IS ASYNCHRONOUS AND HONOURS SIGNALS (design L-1): its handlers for
 * SIGTERM, SIGINT and SIGHUP are installed BEFORE the first look, the event
 * loop runs between looks, and a signal ends the wait with
 * {@link InstrumentLockWaitInterrupted} — also when it arrived while the lock
 * was being taken (the hold is given back first): a door told to stop never
 * goes on to take the lock.
 */
export async function waitForInstrumentLock(lockPath: string, runner: string, options: Readonly<{ onWait: (line: string) => void; pollIntervalMs: number }>): Promise<InstrumentHold> {
  if (runner.trim().length === 0) throw new HarnessError("the instrument lock needs a runner name: the wait names the holder to everyone else", "instrument_lock_runner_unnamed");
  const label = printableHolderLabel(runner);
  let received: NodeJS.Signals | undefined;
  let wake: (() => void) | undefined;
  // Guarded at the definition (the one callback owner): it is removed by reference below.
  const onSignal = guarded("instrument-lock.wait-signal", (signal: NodeJS.Signals): void => {
    received ??= signal;
    wake?.();
  });
  for (const signal of WAIT_SIGNALS) process.on(signal, onSignal);
  // A signal delivered while a synchronous look ran is handled when the loop next turns: let it.
  const settled = (): Promise<void> => new Promise((resolveTurn) => setImmediate(resolveTurn));
  try {
    return await waitLoop();
  } finally {
    for (const signal of WAIT_SIGNALS) process.removeListener(signal, onSignal);
  }

  async function waitLoop(): Promise<InstrumentHold> {
  let saidFor: string | undefined;
  for (;;) {
    await settled();
    if (received !== undefined) throw new InstrumentLockWaitInterrupted(label, received);
    const answer = tryAcquireFileLock(lockPath, { holder: label });
    if (answer.state === "taken") {
      await settled();
      if (received !== undefined) {
        answer.handle.release();
        throw new InstrumentLockWaitInterrupted(label, received);
      }
      setOwnedInstrumentHold(answer.handle);
      // The acquisition token, for the stamp of everything this process starts
      // (its own stamp reads its acquisition); a token it inherited comes back on release.
      const inherited = process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
      process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = answer.handle.nonce;
      return deepFreeze({
        owns: true, runner: label, path: lockPath, stamp: "held",
        release: () => {
          if (ownedInstrumentHold() === answer.handle) setOwnedInstrumentHold(undefined);
          if (process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] === answer.handle.nonce) {
            if (inherited === undefined) delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
            else process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = inherited;
          }
          answer.handle.release();
        },
      });
    }
    if (answer.state === "held" && holdsThisProcess(answer.holder)) {
      return deepFreeze({ owns: false, runner: label, path: lockPath, stamp: instrumentLockStamp(lockPath), release: () => undefined });
    }
    const line = answer.state === "held" ? holderLine(answer.holder) : answer.state === "unreadable" ? "held by a lock file no instrument wrote (honoured until the file lock's bound, then broken)" : "contended by other waiters";
    if (line !== saidFor) {
      saidFor = line;
      options.onWait(`[instrument-lock] ${label} waits for the one instrument lock (${lockPath}): ${line}`);
    }
    await new Promise<void>((resolveLook) => {
      const timer = setTimeout(resolveLook, options.pollIntervalMs);
      wake = () => { clearTimeout(timer); resolveLook(); };
    });
    wake = undefined;
  }
  }
}

/**
 * The hold for a run of `testFileCount` test files: the one lock when the run
 * is heavy ({@link waitForInstrumentLock}), else a LIGHT hold that owns
 * nothing (its stamp still says whether it runs inside a hold). A heavy run
 * with no declared lock is refused (`instrument_lock_undeclared`).
 */
export async function holdInstrumentLock(options: Readonly<{
  config: InstrumentLockConfig | undefined;
  harnessRoot: string;
  runner: string;
  testFileCount: number;
  onWait: (line: string) => void;
}>): Promise<InstrumentHold> {
  if (options.config === undefined) {
    throw new HarnessError("testExecution.instrumentLock is not declared in bridlewise.config.json: every heavy run holds the host's one instrument lock, and its place and what is heavy are declared there", "instrument_lock_undeclared");
  }
  const lockPath = instrumentLockPath(options.config, options.harnessRoot);
  if (!isHeavyRun(options.config, options.testFileCount)) {
    return deepFreeze({ owns: false, runner: options.runner, path: lockPath, stamp: instrumentLockStamp(lockPath), release: () => undefined });
  }
  return waitForInstrumentLock(lockPath, options.runner, { onWait: options.onWait, pollIntervalMs: options.config.pollIntervalMs });
}
