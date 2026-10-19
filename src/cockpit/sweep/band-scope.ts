/**
 * WHAT YOU ARE LOOKING AT — the band's own sentence, and its ONE owner.
 *
 * THE CAPTION THAT USED TO LIVE HERE, AND WHY IT IS GONE. This module used to
 * own a second sentence as well: a "coverage caption" printed inside the band
 * ("this conversation · since Jul 25 13:40", "this project's recorded history
 * · since …"). It existed to stop the band overstating its own span, and it
 * did — but the head résumé below now states the viewed window, its span and
 * its counts from measured values, in the same corner of the screen. Two
 * sentences about the same band, one of them a weaker version of the other,
 * is duplication of exactly the kind the user has reported elsewhere ("past
 * view info shows in yellow at the bottom right and at the top in the
 * header"), so the caption was REMOVED rather than moved. Nothing inherited
 * its claim: with it gone there is no sentence in the tree that asserts a
 * scope, so there is none left to be wrong. What the band covers is shown by
 * the band's own extent and stated, in measured terms, by `bandViewLine`.
 *
 * (If a scope claim is ever wanted again, it belongs here and it comes back
 * with its honesty assertion — `git show df5467c^..HEAD -- this file` has the
 * previous one, `bandSpan` + `assertBandSpanHonest`.)
 *
 * EVERY VALUE BELOW IS MEASURED. Nothing is estimated and nothing is filled
 * in when absent — a band with nothing on it returns `null` and the head
 * renders nothing at all.
 */

import { formatClock, formatFullPrecision, formatSpan } from "./now-edge";
import { type SweepWindow } from "./types";
import type { DataStateValue } from "../response/grammar.ts";

/**
 * THE HEAD'S SENTENCE. It answers "what stretch of time is on screen right
 * now, where is my playhead, and am I in the present or the past."
 *
 * Why it matters beyond tidiness: this cockpit has a real time-travel mode
 * (`src/data/asof.ts`), and every write door correctly REFUSES while a
 * head is planted. A reader who scrubbed into the past without noticing finds
 * controls mysteriously declining them. The first clause of this sentence is
 * the answer, and it is stated before anything else for that reason.
 *
 * The zoom/span clause is the feedback for pan and zoom — the two things
 * taking hold of the band unlocks. Turn the wheel and this number changes;
 * that is how you know the gesture landed.
 *
 * EVERY VALUE IS MEASURED: `view` is the window the painter is drawing,
 * `headMs` is the planted instant itself. Nothing is estimated and nothing is
 * filled in when absent — a band with nothing on it returns `null` and the
 * head renders nothing at all.
 */
export type BandViewInput = Readonly<{
  /** The window the band is painting right now (after any pan/zoom). */
  view: SweepWindow | null;
  /** The planted head, or null when the band sits at now. */
  headMs: number | null;
  /**
   * WHAT IS IN THE WINDOW — the résumé, and both numbers come from the SAME
   * binning of the SAME window (`SweepBins`), which is the only way they can
   * be reported side by side honestly. A run count is deliberately NOT here:
   * on a spectrum read the bins are the server's full history while the
   * client holds only the streamed events, so a run count next to an event
   * count would be two different scopes wearing one sentence.
   */
  contents?: Readonly<{ events: number; errors: number }> | null;
  /**
   * True when the band's emptiness is a MEASURED one: the spectrum read for
   * THE OPEN CONVERSATION landed and honestly reported nothing (and nothing
   * streamed locally either). Only then may the head say the absence in
   * words — a band whose read has not landed yet (in flight, failed, no
   * scope) is an UNMEASURED emptiness, and a sentence about it would be the
   * "in flight ≠ empty" lie the flow's own empty-state law refuses.
   */
  measuredEmpty?: boolean;
  /**
   * True when there is no shell above the band. Under the shell the SHELL
   * owns the past-view banner — it states the condition, the reason acting is
   * refused, and the way back, across the whole width. Repeating any of that
   * here is the duplication the user reported ("past view info shows in
   * yellow at the bottom right and at the top in the header"). Standing
   * alone, the band is the only thing on screen that can say it, so it does.
   */
  standalone?: boolean;
}>;

/**
 * THE BAND'S TIME POSITION — a DOMAIN axis, not a presentation state. The
 * grammar's `data-state` vocabulary has no `now` member on purpose: "the
 * window sits at the present" is a fact about the SUBJECT (where the
 * playhead stands), the same way the breaker's `on/off/tripped` is. What the
 * grammar admits is the band's two standing presentation conditions —
 * `past` (the record behind the head) and `empty` (no record loaded) — so
 * this axis never reaches the attribute directly; it is mapped at the one
 * door below, the way the breaker row maps its own domain state.
 */
export type BandTimePosition = "now" | "past";

export type BandViewLine = Readonly<{
  /** Which condition the whole cockpit is in. */
  state: BandTimePosition;
  /** "at now" / "past view" — present ONLY when nothing above the band owns
   * the condition. Null under a shell. */
  stateLabel: string | null;
  /** "viewing 14:02:11.415", or null when the band sits at now. */
  viewingLabel: string | null;
  /** "showing 14:01:07 → 14:04:02" — the window on screen. Null ONLY in the
   * measured-empty absence line (no window exists to describe). */
  windowLabel: string | null;
  /** "2m 55s of the record" — how much time that window covers. Null ONLY in
   * the measured-empty absence line. */
  spanLabel: string | null;
  /** "128 events" — what is in the window. Null when nothing counted it. */
  eventsLabel: string | null;
  /** "4 with errors" — present ONLY when there are some (§1.2: a normal
   * state earns no pixels, and "0 errors" is a normal state). */
  errorsLabel: string | null;
  /** "No timeline events recorded in this conversation yet" — present ONLY in the
   * measured-empty line: the same absence the flow's own empty state
   * states, in the band's readout, so one fact has one voice. */
  absenceLabel: string | null;
  /** The whole sentence, in reading order — for titles and AT labels. */
  label: string;
}>;

/**
 * THE MEASURED-EMPTY SENTENCE, in the flow's own empty-conversation voice
 * (Flow.svelte's empty state says the same words) minus the "say something
 * below" nudge — that instruction belongs to the surface the reader types
 * into, not to the instrument reading the record.
 */
export const BAND_MEASURED_EMPTY_SENTENCE = "No timeline events recorded yet";

export function bandViewLine(input: BandViewInput): BandViewLine | null {
  const { view, headMs, contents = null, standalone = false, measuredEmpty = false } = input;
  if (view === null) {
    // THE ABSENCE IS STATED ONLY WHERE IT WAS MEASURED. `measuredEmpty` is
    // the Sweep's own derivation (spectrum landed for the open
    // conversation, decoded honestly empty, nothing streamed locally) —
    // without it, null stays null and the head renders nothing at all,
    // exactly the law this module has always kept for an unmeasured band.
    if (!measuredEmpty) return null;
    return Object.freeze({
      state: "now" as const,
      stateLabel: null,
      viewingLabel: null,
      windowLabel: null,
      spanLabel: null,
      eventsLabel: null,
      errorsLabel: null,
      absenceLabel: BAND_MEASURED_EMPTY_SENTENCE,
      label: BAND_MEASURED_EMPTY_SENTENCE,
    });
  }
  const past = headMs !== null;
  const stateLabel = standalone ? (past ? "past view" : "at now") : null;
  const viewingLabel = headMs === null ? null : `viewing ${formatFullPrecision(headMs)}`;
  const windowLabel = `showing ${formatClock(view.t0)} → ${formatClock(view.t1)}`;
  const spanLabel = `${formatSpan(view.t1 - view.t0)} of the record`;
  const eventsLabel =
    contents === null
      ? null
      : `${contents.events} event${contents.events === 1 ? "" : "s"}`;
  const errorsLabel =
    contents === null || contents.errors === 0
      ? null
      : `${contents.errors} with errors`;
  return Object.freeze({
    state: past ? ("past" as const) : ("now" as const),
    stateLabel,
    viewingLabel,
    windowLabel,
    spanLabel,
    eventsLabel,
    errorsLabel,
    absenceLabel: null,
    label: [stateLabel, viewingLabel, windowLabel, spanLabel, eventsLabel, errorsLabel]
      .filter((c): c is string => c !== null)
      .join(" · "),
  });
}

/**
 * THE ONE DOOR from the band's domain vocabulary to the grammar's. Total
 * over the input: a null line is the band's standing `empty`, `past` maps to
 * the admitted `past`, and `now` maps to NO hue — the at-now head is content
 * (the résumé of the current window), not a state the grammar must paint, so
 * it renders in the quiet fallback ink the way a measured reel line does.
 * The return type is derived from the grammar, so a position the grammar
 * does not admit is a compile error HERE, at the door — never an attribute
 * value on screen.
 */
export function bandDataState(line: BandViewLine | null): DataStateValue | null {
  // The measured-empty absence line keeps the standing `empty` the null line
  // wore — stating the absence in words does not change the condition, and
  // the grammar's absent register is still the honest hue for it.
  if (line === null || line.absenceLabel !== null) return "empty";
  switch (line.state) {
    case "past":
      return "past";
    case "now":
      return null;
  }
}

/**
 * The band's bounds: the recorded span, extended to the now edge when a
 * genuinely received event is newer than the loaded coverage.
 *
 * WHY THE EXTENSION IS NOT A FABRICATION: the spectrum read is a snapshot,
 * and events keep arriving after it. Without this the now edge — the last
 * REALLY received event — paints past the right border of its own band. The
 * extension adds EMPTY ground, never a bin and never a count; the edge still
 * moves only on a received event, which is what `assertHonestBandRender`
 * checks. `null` for the edge (nothing received) leaves the bounds alone.
 */
export function bandBounds(
  coverage: SweepWindow | null,
  nowEdgeMs: number | null,
): SweepWindow | null {
  if (coverage === null) return null;
  if (nowEdgeMs === null || nowEdgeMs <= coverage.t1) return coverage;
  return Object.freeze({ t0: coverage.t0, t1: nowEdgeMs });
}
