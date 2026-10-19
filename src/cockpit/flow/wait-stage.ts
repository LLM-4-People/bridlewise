/**
 * THE WAIT — what is actually known between "send" and the first character.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
 *
 * THE USER'S REPORT, VERBATIM: "I don't like the first animation we are
 * getting when submitting the message, the waiting thing, I do like a lot the
 * one we use for streaming tho, maybe we can use something similar but
 * appropriate?" — and, naming the moment exactly: "animation when sending a
 * message still waiting for the first characters".
 *
 * What they were looking at was the token rail (StreamPulse) in its
 * pre-first-token state: fourteen dead cells and the words "waiting for the
 * first characters". The rail is an honest instrument — every cell it lights
 * was paid for by text that actually landed — but before the first token
 * there is no text, so the instrument had nothing to measure and said so by
 * doing nothing at all. A reader cannot tell a system that is working from
 * one that has fallen over, which is the same failure a spinner has, reached
 * from the opposite direction.
 *
 * ── WHAT IS ACTUALLY OBSERVABLE IN THAT WINDOW ─────────────────────────────
 *
 * Three things, and exactly three. They are the points on the send path
 * (flow/run-stream.ts → src/client.ts) where the client learns something new
 * about this run, each from a real return value or a real received frame:
 *
 *   1. ACCEPTED   `startRun(...)` resolved with a runId — the server took the
 *                 run and named it;
 *   2. CONNECTED  the stream's `connected` frame arrived — the server
 *                 acknowledged the open stream for that runId;
 *   3. ANSWERING  the first model event arrived on that stream — the model
 *                 has begun.
 *
 * NO FOURTH STAGE IS INVENTED to make the motion smoother. Three honest steps
 * beat four fabricated ones: a stage that does not correspond to something
 * the client observed would be a spinner wearing a milestone's clothes, which
 * is the exact dishonesty the rail was built to avoid.
 *
 * ── THE STAGE THAT WAS REMOVED, AND WHY ────────────────────────────────────
 *
 * THE USER'S REPORT, VERBATIM: "when waiting for generation, i see your
 * message is in for a brief moment beside the frozen animation, then it
 * starts generating with the animation moving. wondering if there is a
 * cleaner way to let the user know its being sent" — and, narrowing it:
 * "when sending a message i mean".
 *
 * There WAS a first milestone, `sent`, saying "your message is in". It was
 * fired on the line after `sendUserMessage(prompt)`, which is a SYNCHRONOUS
 * store append — so the sentence and the user's own beat appeared in the same
 * frame, and the sentence's entire content was a caption on a picture already
 * in view. VERIFIED, not assumed: `beginCockpitRun` refuses a past view
 * BEFORE `sendUserMessage`, so a refused send appends no beat and needs no
 * caption either; and there is no path on which the append can lag, because
 * nothing between the two lines awaits. The stage therefore had no case in
 * which it told the reader something they could not already see, so it is
 * gone rather than reworded.
 *
 * What it left behind was worse than redundant: `sent` gave the rail one
 * observed milestone, which lit exactly one cell and then held there for the
 * whole of `startRun`. A rail frozen at cell 0 is indistinguishable from a
 * broken one — the same "cannot tell working from fallen-over" failure the
 * rail exists to remove, arriving from the other side. The wait now begins
 * where there is genuinely something to report.
 *
 * ── THE MOTION LAW, CARRIED FORWARD ────────────────────────────────────────
 *
 * There is no timer here. `advance` is called from the observation itself, so
 * a stalled connection produces no advance and the instrument holds at the
 * last thing that genuinely happened — visibly. That is the property the user
 * likes about the streaming rail, applied to a window where the arrivals are
 * milestones instead of characters.
 *
 * ── WHY IT IS ADVANCE-ONLY ─────────────────────────────────────────────────
 *
 * Frames can be observed out of order (a fast `connected` racing the awaited
 * `startRun` promise, a retry's first model event landing before the previous
 * run's watcher is torn down). A stage that could move BACKWARD would show
 * the reader an instrument running in reverse, which reports something that
 * did not happen. So the store keeps the furthest milestone reached, and a
 * new run clears it explicitly (`resetWait`) rather than by comparison.
 */

import { atom } from "nanostores";

import { registerReset } from "../../state/store-registry.ts";

/**
 * The stages, in observation order. `idle` is the absence: nothing has been
 * sent, or the run has ended — and absence renders as absence (§1.1).
 */
export const WAIT_STAGES = ["idle", "accepted", "connected", "answering"] as const;

export type WaitStage = (typeof WAIT_STAGES)[number];

/**
 * What the WAIT ROW says before the first milestone — a DIFFERENT fact from
 * `WAIT_SAY.idle`, and the reason the two are not one constant.
 *
 * The rail measures ARRIVALS, so its absence is "no characters yet". The wait
 * row covers the window between pressing send and the run being accepted, so
 * its absence is "the harness has not taken it yet". Collapsing them once
 * looked like deduplication and was actually a surface saying something
 * untrue: the rail, mounted for a fresh stream with no run at all, announced
 * that it was waiting for a run to be accepted.
 */
export const WAIT_ROW_IDLE_SAY = "waiting for the harness to take the run";

/** How many milestones a send can reach — `idle` is the absence, not one of
 *  them. Derived, never written down twice: the wait row prints "n of N" and
 *  a hardcoded N is how that caption comes to disagree with the sequence. */
export const WAIT_MILESTONE_COUNT = WAIT_STAGES.length - 1;

/**
 * What each milestone MEANS, in plain words, said from the reader's side.
 *
 * Zero-knowledge language (§1.1): no "runId", no "SSE", no "stream opened".
 * Every sentence names a thing that happened to the reader's message.
 *
 * `idle` here is THE RAIL's absence — "no characters have arrived" — because
 * `WAIT_SAY` is the token rail's vocabulary (flow/StreamPulse.svelte), and a
 * rail at idle is one that has measured nothing. The WAIT ROW's absence is a
 * different fact and has its own sentence; see `WAIT_ROW_IDLE_SAY`.
 */
export const WAIT_SAY: Readonly<Record<WaitStage, string>> = Object.freeze({
  idle: "waiting for the first characters",
  accepted: "the run was accepted",
  connected: "listening for the answer",
  answering: "the model is answering",
});

/**
 * How many milestones have been observed at a stage — and therefore how many
 * cells the rail has earned. `idle` has earned none, which is why firing no
 * milestone produces no movement.
 */
export function waitSteps(stage: WaitStage): number {
  return WAIT_STAGES.indexOf(stage);
}

/** The furthest milestone this run has reached. */
export const waitStage = atom<WaitStage>("idle");

/**
 * WHEN THE SEND HAPPENED — epoch ms, or `null` when no send is outstanding.
 *
 * This is the second half of the honest answer, and the half the stage alone
 * cannot give. "the run was accepted" reads as normal at 0.4s and as a
 * problem at 14s, and only this atom knows which one the reader is living
 * through. It is also what lets the wait row show motion without claiming an
 * arrival: a clock counting real elapsed time asserts that time passed, which
 * is true and measured, and never that data came back — the distinction a
 * spinner erases (see WaitLine.svelte).
 *
 * It is a REAL timestamp taken at the send, not a render-time default, so
 * every consumer measures from the same instant and a row that mounts late
 * (the reply beat appearing, the row moving) shows the same elapsed the
 * previous one did.
 */
export const waitStartedAt = atom<number | null>(null);

/**
 * ── THE WAIT THAT ENDED WITHOUT A RUN ─────────────────────────────────────
 *
 * `startRun` can settle by THROWING — the server refused the run (a 428
 * naming what the user must configure first) or the attempt broke. Before
 * this state existed the instrument had no way to say so: `beginWait` had
 * started the clock, no milestone would ever arrive, and the row ticked
 * "waiting for the harness to take the run" FOREVER over a run the server
 * had already declined. A standing instrument reporting a wait that cannot
 * end is the frozen-spinner dishonesty this module was built to remove.
 *
 * So the end is a fact of its own: refused (the system declined, on purpose,
 * with the server's sentence) or failed (the attempt broke). The clock stops
 * — `waitStartedAt` returns to null, because no send is outstanding — and
 * the row renders the outcome in the response grammar's own vocabulary
 * instead of a milestone. It stands until the next send (`beginWait`) or a
 * reset clears it, exactly like every other standing answer.
 */
export type WaitEnd = Readonly<{ kind: "refused" | "failed"; reason: string }>;

/** How the outstanding send ended without a run, or null (no such end). */
export const waitEnd = atom<WaitEnd | null>(null);

/**
 * The send's promise settled with no run to wait for. One call, all three
 * facts — stage back to absence, clock stopped, outcome standing — so no
 * caller can stop the clock and forget to say why.
 */
export function endWaitWithout(end: WaitEnd): void {
  waitStage.set("idle");
  waitStartedAt.set(null);
  waitEnd.set(end);
}

/**
 * A send has just been made: absence for the stage, and the clock starts.
 *
 * One call, both facts, because a start time without a cleared stage would
 * carry the previous run's furthest milestone into this one, and a cleared
 * stage without a start time would show a wait with no measurable duration.
 * A standing refusal from the PREVIOUS send is cleared by the same rule:
 * this is a new send, and the old outcome is not its outcome.
 */
export function beginWait(): void {
  waitStage.set("idle");
  waitStartedAt.set(Date.now());
  waitEnd.set(null);
}

/**
 * Record a milestone. Advance-only (see the header) — a stage already passed
 * is not re-entered, and an out-of-order observation cannot rewind the
 * instrument.
 */
export function advanceWait(stage: WaitStage): void {
  if (waitSteps(stage) <= waitSteps(waitStage.get())) return;
  waitStage.set(stage);
}

/**
 * Back to absence: the run has ended, or a reset cleared the stores. Explicit
 * rather than derived, so the one thing that can move the stage backwards is
 * a caller saying "this is a different run now".
 */
export function resetWait(): void {
  waitStage.set("idle");
  waitStartedAt.set(null);
  waitEnd.set(null);
}

registerReset("flow-wait-stage", resetWait);
