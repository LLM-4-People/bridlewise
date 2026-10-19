/**
 * THE HOLD OF THE ONE INSTRUMENT LOCK THIS PROCESS OWNS — the one fact the
 * native supervisor's spawn needs (`supervised-run.ts`): every supervisor a
 * holder starts is adopted into the lock's record, so a holder killed
 * outright leaves the lock held until that supervisor — which ends only after
 * its whole process tree is gone — has ended too (src/process/instrument-lock.ts).
 * Kept apart from the lock's owner so the supervisor imports a registry, not
 * the lock's placement and keep-out machinery.
 */
import type { FileLockHandle } from "../filesystem/file-lock.ts";

let owned: FileLockHandle | undefined;

/** Record (or, with `undefined`, forget) the instrument lock hold this process owns. */
export function setOwnedInstrumentHold(handle: FileLockHandle | undefined): void {
  owned = handle;
}

/** The hold this process owns now, if any. */
export function ownedInstrumentHold(): FileLockHandle | undefined {
  return owned;
}

/**
 * Name `pid` (a supervisor this process just started) in the hold this
 * process OWNS. A process that owns no hold adopts nothing: inside a borrowed
 * hold, the owner's own adopted supervisor already spans this one.
 */
export function adoptIntoOwnedInstrumentLock(pid: number): void {
  owned?.adopt(pid);
}
