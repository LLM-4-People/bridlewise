/**
 * COCKPIT FLOW — docking findings into the stream.
 *
 * Ask answers (§4.5) and effect-seam findings (§4.3) enter the log here.
 * Ask answers bypass the admission controller — the user asked. Effect-seam
 * findings go THROUGH admission (at most one per seam; dismissal-learned
 * kinds stay away).
 */

import { appendBeat, beatById, lastBeat } from "./log.ts";
import { admitAtSeam, type Candidate } from "../computer/admission.ts";
import type { Beat, FindingBody } from "./types.ts";

let findingCounter = 0;

/** Dock an ask answer as a finding beat at the end of the flow. */
export function dockAskFinding(finding: FindingBody): Beat {
  findingCounter += 1;
  const last = lastBeat();
  const beat: Beat = {
    id: `find-ask-${findingCounter}`,
    kind: "finding",
    parentId: null,
    turnIndex: last?.turnIndex ?? 0,
    at: Date.now(),
    abnormal: false,
    bleed: true,
    verbs: [],
    finding,
  };
  appendBeat(beat);
  return beat;
}

/**
 * Dock a finding at an effect seam (right after its effect beat, §4.3),
 * subject to admission. Returns the docked beat or null when admission
 * declined (ask-only kind, or nothing eligible).
 */
export function dockEffectSeamFinding(
  effectBeatId: string,
  candidates: readonly Candidate[],
): Beat | null {
  const host = beatById(effectBeatId);
  if (host === undefined) return null;
  const admission = admitAtSeam(candidates);
  if (admission.admitted === null) return null;
  findingCounter += 1;
  const beat: Beat = {
    id: `find-fx-${findingCounter}`,
    kind: "finding",
    parentId: effectBeatId,
    turnIndex: host.turnIndex,
    at: Date.now(),
    abnormal: false,
    bleed: true,
    verbs: [],
    finding: admission.admitted.finding,
  };
  appendBeat(beat);
  return beat;
}

/** Test/reset hook. */
export function resetDockCounter(): void {
  findingCounter = 0;
}
