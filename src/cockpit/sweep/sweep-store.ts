/**
 * SWEEP shared state — nanostores, plain .ts (Node-testable), following the
 * repo's store discipline: components read via $-subscription; ingestion
 * goes through the exported functions.
 *
 * This store is the CONTROLLER for the global-time-travel contract, not its
 * owner:
 *  - `sweepHead` is the SAME atom as `src/data/asof.ts`'s `asOfHead` —
 *    re-exported, not re-declared. The sweep WRITES the head (click, scrub,
 *    `Esc`); the Broker READS it on every call and carries it as `until`.
 *    Two atoms would be two opinions about what time it is, and the day they
 *    disagreed the banner and the data would describe different instants.
 *  - `streamState` + `nowEdge` hold the honest liveness truth: the edge
 *    advances ONLY through `recordReceivedEvent` (a genuinely received
 *    event); status transitions never move it.
 *
 * @see src/data/asof.ts — the asOf owner and the honest-degradation split
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { asOfHead, returnToLive } from "../../data/asof.ts";

import {
  INITIAL_STREAM_STATE,
  type StreamState,
  type StreamStatusKind,
  type SweepEvent,
  type SweepMark,
  type SweepWindow,
} from "./types";
import {
  INITIAL_NOW_EDGE,
  advanceNowEdge,
  type NowEdgeState,
} from "./now-edge";
import {
  ARMS_STORAGE_KEY,
  MARKS_STORAGE_KEY,
  adoptArmedTriggers,
  adoptSweepMarks,
  evalArmPredicate,
  loadArms,
  loadMarks,
  parseArms,
  parseMarks,
  saveArmsMerged,
  saveMarksMerged,
  type ArmedTrigger,
  type ArmPredicateKind,
} from "./marks";
// The firing engine's grammar half + the outcomes (the deferred-binding
// pair this module's doors call — arm-fire.ts's header states the contract).
import {
  announceArmFiring,
  armTriggerLabel,
  evalArmGrammar,
  isPureContextPredicate,
  matchesContextReading,
} from "./arm-fire";
// The compose door's measured-percentage derivation (the RunContext owner).
import { contextPctOf, type RunContext } from "../../state/chat-messages.ts";
import { onForeignRawWrite } from "../../state/cross-tab";

// Register with the app-wide reset registry when available. Optional import
// kept as a static relative import (allowlisted: src/state/*).
import { registerReset, registerContextReset } from "../../state/store-registry";

// ── Head (asOf) ──
//
// Re-exported from the one owner. The sweep's vocabulary is kept (`sweepHead`,
// `plantHead`, `returnToLive`, `isTimeTraveling`) so every band component and
// test reads unchanged, while the VALUE behind it is the global `asOf` the
// Broker consults on every read.

export {
  asOfHead as sweepHead,
  isPastView as isTimeTraveling,
  plantHead,
  returnToLive,
} from "../../data/asof.ts";
// The scrub and the reset below write the head directly, so the owner is also
// imported (a re-export is not a binding in this module's scope).

/** Scrub the head by a signed step (the `[` `]` bindings). When live,
 * scrubbing back starts from the now edge (the last real event). No edge
 * recorded yet → nothing to scrub to → no-op (returns null). */
export function scrubHead(deltaMs: number): number | null {
  const current = asOfHead.get();
  const edge = nowEdge.get().timeMs;
  const from = current ?? edge;
  if (from === null) return null;
  const next = from + deltaMs;
  if (edge !== null && next >= edge) {
    // Scrubbed forward to (or past) now — return to live rather than
    // planting a head in a future no event has reached.
    returnToLive();
    return null;
  }
  asOfHead.set(next);
  return next;
}

// ── Stream state + now edge ──

export const streamState = atom<StreamState>(INITIAL_STREAM_STATE);
export const nowEdge = atom<NowEdgeState>(INITIAL_NOW_EDGE);

/**
 * THE only way the now edge moves: a genuinely received event. Also flips
 * status to "live" (receiving an event IS proof of liveness) and evaluates
 * armed triggers against the event (§6.4 — a firing drops a flag).
 */
export function recordReceivedEvent(e: SweepEvent): void {
  nowEdge.set(advanceNowEdge(nowEdge.get(), e));
  const s = streamState.get();
  streamState.set(Object.freeze({
    status: "live",
    lastEventMs: nowEdge.get().timeMs,
    eventsReceived: s.eventsReceived + 1,
  }));
  fireMatchingArms(e);
}

/** Status transitions (open/reconnecting/closed) — never move the edge. */
export function setStreamStatus(status: StreamStatusKind): void {
  const s = streamState.get();
  streamState.set(Object.freeze({ ...s, status }));
}

// ── Marks (client-stored v1 — see marks.ts LOCAL_STORAGE_NOTE) ──

export const sweepMarks = atom<readonly SweepMark[]>(loadMarks());

let markSeq = 0;

function pushMark(mark: SweepMark): void {
  const next = Object.freeze([...sweepMarks.get(), mark]);
  // The merged seam: the atom converges on the union with the persisted
  // blob at the very write that produced the mark.
  sweepMarks.set(Object.freeze(saveMarksMerged(next)));
}

/**
 * Drop a user mark at now (§6.2: "`m` drops a mark at now"). "Now" is the
 * last received event's time — the band has no other honest now. With no
 * events received there is no now to mark: returns null (surfaces say
 * "nothing recorded yet").
 */
export function dropMarkAtNow(label = "mark"): SweepMark | null {
  const t = nowEdge.get().timeMs;
  if (t === null) return null;
  const mark: SweepMark = Object.freeze({
    id: `mark-${Date.now()}-${markSeq++}`,
    timeMs: t,
    label,
    createdAtMs: Date.now(),
    origin: "user" as const,
    storage: "local" as const,
  });
  pushMark(mark);
  return mark;
}

export function removeMark(id: string): void {
  const next = Object.freeze(sweepMarks.get().filter((m) => m.id !== id));
  // The removal travels as this write's own intent, and is tombstoned for
  // the session so neither this tab's union nor a stale foreign blob can
  // resurrect the mark.
  sweepMarks.set(Object.freeze(saveMarksMerged(next, [id])));
}

// ── ARM triggers (client-stored v1) ──

export const armedTriggers = atom<readonly ArmedTrigger[]>(loadArms());

let armSeq = 0;

export function armTrigger(
  kind: ArmPredicateKind,
  param: string | null = null,
  predicate: string | null = null,
  scope: "chat" | "all" = "chat",
): ArmedTrigger {
  const t: ArmedTrigger = Object.freeze({
    id: `arm-${Date.now()}-${armSeq++}`,
    kind,
    param,
    predicate,
    scope,
    armedAtMs: Date.now(),
    firedAtMs: null,
    storage: "local" as const,
  });
  const next = Object.freeze([...armedTriggers.get(), t]);
  armedTriggers.set(Object.freeze(saveArmsMerged(next)));
  return t;
}

export function clearArm(id: string): void {
  const next = Object.freeze(armedTriggers.get().filter((t) => t.id !== id));
  // A clear is the one mutation the union cannot infer — it travels as
  // this write's own intent and is tombstoned for the session.
  armedTriggers.set(Object.freeze(saveArmsMerged(next, [id])));
}

/**
 * RE-ARM — the oscilloscope's manual verb: a fired trigger re-cocks (a new
 * arming of the same predicate; the firing's history stays in the mark it
 * dropped and the finding it docked). The record's flag is UNTOUCHED — the
 * flag stores the predicate, and the server never held the firing
 * (`serverSideFiring: false`); the re-cocked firing state is this
 * browser's, and it travels to this browser's other tabs through the same
 * whole-blob adoption every other arms write travels by. Returns the
 * re-cocked row, or null when no such row exists or it had not fired
 * (re-arming a cocked row is a no-op — it is already waiting).
 */
export function reArmTrigger(id: string): ArmedTrigger | null {
  let reArmed: ArmedTrigger | null = null;
  const next = armedTriggers.get().map((t) => {
    if (t.id !== id || t.firedAtMs === null) return t;
    // The generation stamp must be STRICTLY newer than the row's own prior
    // generation — it is the recency discriminator the merge seams use, and
    // a wall-clock read inside the same millisecond as the old stamp would
    // degenerate the re-arm into a within-generation monotone tie the stale
    // firing could win.
    reArmed = Object.freeze({
      ...t,
      firedAtMs: null,
      armedAtMs: Math.max(Date.now(), t.armedAtMs + 1),
    });
    return reArmed;
  });
  if (reArmed === null) return null;
  const frozen = Object.freeze(next);
  // The re-arm's newer generation is the recency discriminator: the merged
  // write cannot let a stale persisted firing un-fire the re-cocked row.
  armedTriggers.set(Object.freeze(saveArmsMerged(frozen)));
  return reArmed;
}

/** How many triggers are cocked (armed, waiting) right now — the arm group
 * cap's standing count. Derived, never a second store. */
export const cockedTriggerCount: ReadableAtom<number> = computed(
  armedTriggers,
  (arms) => arms.filter((t) => t.firedAtMs === null).length,
);

/** Evaluate cocked (un-fired) triggers against a received event; a match
 * fires single-shot: the trigger records its firing, a flag mark drops
 * at the EVENT's recorded time (not "now o'clock" — the event is the
 * moment), and the firing's OUTCOMES run (the finding dock + its verbs —
 * arm-fire.ts announceArmFiring). Pure-context predicates are skipped
 * here: the compose door owns them (fireContextArms). Returns the marks
 * dropped. */
export function fireMatchingArms(e: SweepEvent): readonly SweepMark[] {
  const dropped: SweepMark[] = [];
  const current = armedTriggers.get();
  let changed = false;
  const next = current.map((t) => {
    if (t.firedAtMs !== null) return t;
    const matched =
      t.predicate !== null
        ? !isPureContextPredicate(t.predicate) && evalArmGrammar(t.predicate, e)
        : evalArmPredicate(t, e);
    if (!matched) return t;
    changed = true;
    const mark: SweepMark = Object.freeze({
      // The firing's identity is (trigger row, event) — deterministic across
      // tabs, so two tabs evaluating the same event drop the SAME id and
      // the marks union collapses the double evaluation to one persisted
      // mark. A re-armed generation fires on a later event, so ids stay
      // unique across firings.
      id: `mark-arm-${t.id}-${e.eventId}`,
      timeMs: e.timeMs,
      label: `armed: ${armTriggerLabel(t)}`,
      createdAtMs: Date.now(),
      origin: "arm" as const,
      storage: "local" as const,
    });
    pushMark(mark);
    dropped.push(mark);
    announceArmFiring(t, e.timeMs, {
      kind: "event",
      eventId: e.eventId,
      eventDescription: e.eventType,
    });
    return Object.freeze({ ...t, firedAtMs: e.timeMs });
  });
  if (changed) {
    const frozen = Object.freeze(next);
    armedTriggers.set(Object.freeze(saveArmsMerged(frozen)));
  }
  return Object.freeze(dropped);
}

// ── The compose door: context readings fire context triggers ───────────────
//
// The run's context report (the "context" SSE event — what the composing
// code path measured for the assembled request) is the ONLY live wire the
// context gauge has: it arrives once per compose, never per token. A trigger
// over context therefore evaluates HERE, at the measurement's arrival — the
// row says so, and the receipt IS the moment (the same standard the
// model-event tick uses: a genuinely received event's real time).
//
// The receipt also ticks the now edge (edge + liveness only, no band point —
// a context report is not a ledger record), so the fired mark lands at a
// moment the band has really reached.

let contextTickSeq = 0;

/**
 * Record a run's context report: tick the edge at its receipt, then fire the
 * context triggers (the fixed "context crosses N%" kind and pure-context
 * grammar predicates) single-shot. A report with no usable measurement
 * (no tokens, no limit) fires nothing — absence is not a crossing.
 */
export function recordContextReading(context: RunContext): readonly SweepMark[] {
  const pct = contextPctOf(context);
  contextTickSeq += 1;
  const atMs = Date.now();
  recordReceivedEvent(Object.freeze({
    eventId: `live-context-${contextTickSeq}`,
    timeMs: atMs,
    category: "context",
    isError: false,
    eventType: "context",
    outcome: null,
    errorCode: null,
    runId: null,
    turnId: null,
    parentEventId: null,
    description: "",
  }));
  if (pct === null) return Object.freeze([]);
  return fireContextArms(
    {
      pct,
      ...(context.contextTokens !== undefined ? { tokens: context.contextTokens } : {}),
      ...(context.contextTokenLimit !== undefined ? { limit: context.contextTokenLimit } : {}),
    },
    atMs,
  );
}

/** Fire the context triggers against one measured reading, at its receipt
 * instant. The single-shot law is the caller's store state: a row that
 * already fired does not fire again until re-armed. */
export function fireContextArms(
  measured: Readonly<{ pct: number; tokens?: number; limit?: number }>,
  atMs: number,
): readonly SweepMark[] {
  const dropped: SweepMark[] = [];
  const current = armedTriggers.get();
  let changed = false;
  const next = current.map((t) => {
    if (t.firedAtMs === null && matchesContextReading(t, measured)) {
      changed = true;
      const mark: SweepMark = Object.freeze({
        // Deterministic per row GENERATION (a re-arm stamps a new
        // armedAtMs): the same measurement firing in two tabs collapses
        // to one persisted mark, and a re-armed generation stays unique.
        id: `mark-context-${t.id}-${t.armedAtMs}`,
        timeMs: atMs,
        label: `armed: ${armTriggerLabel(t)}`,
        createdAtMs: Date.now(),
        origin: "arm" as const,
        storage: "local" as const,
      });
      pushMark(mark);
      dropped.push(mark);
      announceArmFiring(t, atMs, { kind: "context", measuredPct: measured.pct });
      return Object.freeze({ ...t, firedAtMs: atMs });
    }
    return t;
  });
  if (changed) {
    const frozen = Object.freeze(next);
    armedTriggers.set(Object.freeze(saveArmsMerged(frozen)));
  }
  return Object.freeze(dropped);
}

// ── The band's capture window (the ARM menu's "capture the band" subject) ──
//
// The capture verb bookmarks the span the BAND is showing — a fact only the
// mounted band derives (its coverage, else its pinned view). The arm menu's
// body used to receive it as a prop from the Sweep, which was fine while the
// menu could only open inside the band; the right-menu host (shell/
// RightMenuHost.svelte) mounts the SAME body with no band in its tree, so
// the window crosses the seam the way every other band fact does: the
// mounted Sweep writes the mirror, every host of the body reads it. ONE
// writer (the live band), one reader grammar, no prop path to drift from it.
//
// NOT persisted and NOT reset with the arms: it is a projection of what is
// on screen right now, not a bookmark. A host that opens with no band
// mounted reads null and states "nothing recorded yet", which is the truth.

export const armCaptureWindow = atom<SweepWindow | null>(null);

/** The band's own $effect keeps this in step; see the section header. */
export function setArmCaptureWindow(win: SweepWindow | null): void {
  armCaptureWindow.set(win);
}

// ── Reset ──

export function resetSweep(): void {
  returnToLive();
  streamState.set(INITIAL_STREAM_STATE);
  nowEdge.set(INITIAL_NOW_EDGE);
  // Marks/arms are deliberately NOT cleared on app reset — they are the
  // user's local bookmarks, not per-session projection state.
}

registerReset("cockpitSweep", resetSweep);
registerContextReset("cockpitSweep", resetSweep);

// ── Cross-tab: marks and armed triggers ───────────────────────────────────
//
// Both are the operator's own bookmarks on the record — not per-workspace,
// not per-tab. Dropping a mark in one tab and not seeing it in the other is
// the plainest form of the divergence this closes: the user performed an act,
// it appeared to work, and a second window of the same cockpit showed a band
// with no mark on it.
//
// Armed triggers matter more than marks, because an ARM is a standing
// instruction. Two tabs each holding their own arm list means a trigger the
// user cleared in one tab is still cocked in the other and will still fire —
// and the whole-blob adoption closes exactly that: each tab adopts the
// other's ENTIRE stored list, fired instants included, so a trigger that
// FIRED in one tab reads "fired" in the other too (drive 18 measured it:
// the follower converged by adoption, not its own evaluation, and one band
// mark landed). Each row's `storage` field is preserved verbatim through
// the adoption, so a ledger-backed trigger does not quietly become a local
// one by travelling.
//
// THE WRITE SIDE IS MERGED TOO (the whole-write race this section once
// carried as a known limit): every arm/re-arm/fire/clear/save goes through
// the merge seams in marks.ts, so a tab's whole snapshot can no longer
// bury another tab's fresher persisted fact — the firing is monotone
// within a row generation, a re-arm's newer generation wins by recency,
// clears travel as intents with session tombstones, and the marks union
// keeps every tab's fresh marks. The adoption below merges the same way
// for rows both sides hold.
//
// THE HONEST RESIDUAL, FILED: a synchronous seam cannot be atomic between
// tabs — two tabs' seams can still interleave between their read and their
// write (a much narrower window than the adoption-latency window the merge
// closed, and the one a Web-Locks section over the same seams would
// close), and a session tombstone dies with its tab, so a stale tab that
// outlives the clearing tab's session can still resurrect a removed row
// (a persisted tombstone protocol — with its retention policy — would
// close that). Both are filed with the lock follow-up; neither is widened
// by the merge.
//
// These two keys are stored UNPREFIXED (they predate the persistence owner),
// so they register through the raw door and are re-validated on the way in by
// the same `loadMarks`/`loadArms` used at boot — a foreign write is held to
// exactly the standard a stored one is.
//
// PATCHED, NOT REMOUNTED: the band renders marks from this atom, and
// `sweepWindowEvents` already dedups by id, so an adopted list flows through
// the identical subscription a local drop uses. The marks layer is absolutely
// positioned over the band (it has no flow geometry of its own), so a mark
// appearing changes no box.
// A blob that will not parse is REFUSED, not adopted as an empty list. At
// boot the two are the same (either way there is nothing to restore), but here
// the alternative to adopting is the marks this tab is already holding — and
// deleting a person's bookmarks on the strength of a string we could not read
// would be a worse bug than the divergence being fixed.
onForeignRawWrite(MARKS_STORAGE_KEY, (raw) => {
  const next = parseMarks(raw);
  if (next === null) return;
  sweepMarks.set(Object.freeze(adoptSweepMarks(next)));
});

onForeignRawWrite(ARMS_STORAGE_KEY, (raw) => {
  const next = parseArms(raw);
  if (next === null) return;
  armedTriggers.set(Object.freeze(adoptArmedTriggers(armedTriggers.get(), next)));
});
