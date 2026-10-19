/**
 * COCKPIT COMPUTER — the finding admission controller (spec §4.6).
 *
 * The relevance engine survives HERE: it scores candidate findings, admits
 * at most ONE per seam (queuing the rest behind a "+N more" fold), applies
 * dwell at the desk line (a finding stays ≥8s before another may replace
 * it), and learns dismissals in-session (a kind dismissed 3× stops
 * self-docking and retreats to ask-only — recorded and inspectable).
 *
 * Plain module + one small atom for the desk line. The clock is injectable
 * so dwell and learning are Node-testable without wall-clock waits.
 */

import { atom } from "nanostores";

import type { FindingBody } from "../flow/types.ts";
import { activeWorkspaceId } from "../../state/workspaces.ts";

import { DWELL_MS, DISMISSALS_TO_RETIRE } from "./computer-config.ts";

export { DWELL_MS, DISMISSALS_TO_RETIRE };

/** Base score per finding kind — aggregates outrank projections at a seam. */
const BASE_SCORE: Readonly<Record<string, number>> = {
  "turn-rollup": 50,
  "impact-reach": 40,
  "context-projection": 30,
  "ask-answer": 60,
  // An armed trigger firing is the reader's OWN requested watch tripping —
  // it outranks a turn rollup and, abnormal-boosted, outranks everything
  // else the desk line holds.
  "arm-fired": 55,
  // A shared capture is the same class of request: the reader picked a
  // stretch of their own record and asked to be shown it — their own
  // bookmark promoted to a finding ranks with their own watch tripping,
  // not with the computed-projection default.
  "arm-capture": 55,
};

export type Candidate = Readonly<{
  finding: FindingBody;
  /** Boost for abnormal inputs (a regression outranks a quiet rollup). */
  abnormal?: boolean;
}>;

export function scoreCandidate(c: Candidate): number {
  const base = BASE_SCORE[c.finding.findingKind] ?? 20;
  return base + (c.abnormal === true ? 25 : 0);
}

// ── Dismissal learning (in-session) ─────────────────────────────────────────

const dismissals = new Map<string, number>();

export function recordDismissal(findingKind: string): void {
  dismissals.set(findingKind, (dismissals.get(findingKind) ?? 0) + 1);
}

/** True once a kind has been dismissed 3× this session — ask-only from then. */
export function isAskOnly(findingKind: string): boolean {
  return (dismissals.get(findingKind) ?? 0) >= DISMISSALS_TO_RETIRE;
}

/** The record, inspectable (the Instruments room reads this later). */
export function dismissalRecord(): ReadonlyMap<string, number> {
  return dismissals;
}

// ── Seam admission ──────────────────────────────────────────────────────────

export type SeamAdmission = Readonly<{
  admitted: Candidate | null;
  /** Candidates queued behind the "+N more" fold. */
  queued: readonly Candidate[];
}>;

/**
 * Admit at most one candidate at a seam. Ask-only kinds never self-dock
 * (they still answer when asked — the `?` grammar bypasses admission).
 * Highest score wins; ties break toward the earlier candidate.
 */
export function admitAtSeam(candidates: readonly Candidate[]): SeamAdmission {
  const eligible = candidates.filter((c) => !isAskOnly(c.finding.findingKind));
  if (eligible.length === 0) return { admitted: null, queued: [] };
  let best = eligible[0]!;
  for (const c of eligible.slice(1)) {
    if (scoreCandidate(c) > scoreCandidate(best)) best = c;
  }
  return { admitted: best, queued: eligible.filter((c) => c !== best) };
}

// ── The desk line (one slot above the composer, §4.3) ───────────────────────

export type DeskLineState = Readonly<{
  finding: FindingBody;
  shownAt: number;
}> | null;

export const deskLine = atom<DeskLineState>(null);

let queuedDeskFinding: FindingBody | null = null;
let dwellTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Propose a finding for the desk line. Admitted immediately when the slot is
 * empty or the current occupant has dwelt ≥8s; otherwise the newest proposal
 * queues (replacing any earlier queued one) and lands when dwell expires.
 * Returns true when the finding took the slot now.
 */
export function proposeDeskLine(finding: FindingBody, now: number = Date.now()): boolean {
  if (isAskOnly(finding.findingKind)) return false;
  const current = deskLine.get();
  if (current === null || now - current.shownAt >= DWELL_MS) {
    deskLine.set({ finding, shownAt: now });
    return true;
  }
  queuedDeskFinding = finding;
  if (dwellTimer === null) {
    const waitMs = DWELL_MS - (now - current.shownAt);
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (queuedDeskFinding !== null) {
        const next = queuedDeskFinding;
        queuedDeskFinding = null;
        proposeDeskLine(next);
      }
    }, waitMs);
  }
  return false;
}

/** Dismiss the desk-line finding (recorded for learning). */
export function dismissDeskLine(now: number = Date.now()): void {
  const current = deskLine.get();
  if (current === null) return;
  recordDismissal(current.finding.findingKind);
  deskLine.set(null);
  void now;
}

/**
 * Empty the desk-line slot. Distinct from `dismissDeskLine`: nobody dismissed
 * anything, so nothing is learned from it.
 */
export function clearDeskLine(): void {
  deskLine.set(null);
  queuedDeskFinding = null;
  if (dwellTimer !== null) {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }
}

/**
 * ── A PROJECTION BELONGS TO THE CONVERSATION IT WAS COMPUTED FROM ──────────
 *
 * The desk line carries sentences like "at this rate, context fills in ~12
 * messages — projection from your last 10 messages (avg 1,120 tok each)".
 * Every one of those numbers is measured from ONE transcript. The slot,
 * however, was global, so switching tabs left a projection computed for the
 * conversation you had just left sitting above the composer of the one you
 * had just opened — a derived sentence whose stated derivation names inputs
 * that are not on screen. Under §4.4 that is not a stale cache; it is a
 * finding presenting another conversation's inputs as this one's.
 *
 * CLEARED, NOT KEYED. Keeping one per workspace and restoring it on return
 * was the other option and is worse: the projection's honesty rests on its
 * `asOf` and its input window, and a tab you come back to five minutes later
 * would re-display both as though they were current. The next run boundary in
 * that conversation proposes a fresh one from fresh inputs (ingest.ts
 * `onRunEnded`), which is the only version that can be true.
 *
 * The DISMISSAL RECORD is deliberately NOT cleared: "I keep waving this kind
 * of finding away" is a fact about the operator, and the workspace split puts
 * facts about the operator on the shared side (state/workspaces.ts).
 */
activeWorkspaceId.listen(() => clearDeskLine());

/** Reset all in-session learning + slots (harness/chat switch). */
export function resetAdmission(): void {
  dismissals.clear();
  clearDeskLine();
}
