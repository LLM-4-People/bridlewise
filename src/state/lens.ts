/**
 * LENS state — what the provenance instrument is currently pointed at.
 *
 * @global-store — LENS is an app-wide instrument, not a per-chat surface. Its
 * state is the user's current INSPECTION (armed or not, what is under the
 * cursor, whether the view is live or held at a past instant), never the
 * provenance data itself. The data lives in `src/data/ledger.ts`, written
 * by the Broker; this file only ever reads it.
 *
 * WHY THE SUBSCRIPTION IS LIFECYCLE-BOUND
 *
 * `activateLens()` subscribes to the ledger and `deactivateLens()`
 * unsubscribes. Nothing observes anything while LENS is closed — no listener,
 * no interval, no observer — which is what makes the "costs nothing when
 * inactive" claim testable rather than asserted. Recording, by contrast, is
 * unconditional: the Broker writes the ledger whether anyone is looking or
 * not, because the first question is always about a value that is already on
 * screen.
 */

import { atom, computed, onMount, type ReadableAtom } from "nanostores";

import {
  answerFor,
  type ActionProvenanceRecord,
  type ProvenanceAnswer,
  type ProvenanceRecord,
} from "../../shared/provenance.ts";
import {
  actionLog,
  clearProvenance,
  provenanceFor,
  provenanceLog,
  subscribeProvenance,
} from "../data/ledger.ts";
import { registerReset } from "./store-registry";

/** Whether the instrument is powered. False means: observe nothing. */
export const lensActive = atom<boolean>(false);

/**
 * The binding key currently under inspection, or `null`.
 *
 * A key, not an element: the answer must survive the element being re-rendered
 * out from under the pointer, and holding a DOM node here would pin a detached
 * subtree in memory.
 */
export const lensKey = atom<string | null>(null);

/**
 * Bumped whenever the ledger changes or the clock ticks.
 *
 * Nanostores compares by reference and a `Map` mutated in place is reference-
 * equal to itself, so a version counter is the honest way to make a derived
 * value recompute. It is also what lets AGE update live: the same bump that
 * carries a new record carries the passage of time.
 */
export const lensVersion = atom<number>(0);

/** Wall clock as LENS last sampled it. Advanced by the overlay while open. */
export const lensNow = atom<number>(0);

// (The old shell's held-instant mechanism left with its readers at the
// cutover — the cockpit's past view is owned by src/data/asof.ts.)

/**
 * The answer for whatever LENS is pointed at.
 *
 * `absent` is a first-class outcome here, not an error path: an element with
 * no declared source is a doctrine violation made visible, and this store
 * reports it exactly as loudly as it reports a hit.
 */
export const lensAnswer: ReadableAtom<ProvenanceAnswer | null> = computed(
  [lensKey, lensVersion],
  (key) => (key === null ? null : answerFor(key, provenanceFor)),
);

/** The bounded reconstruction log, re-read on every ledger bump. */
export const lensHistory: ReadableAtom<readonly ProvenanceRecord[]> = computed(
  lensVersion,
  () => provenanceLog(),
);

/**
 * The SERVER's `asOf` for an answered Broker read, or `undefined`.
 *
 * Deliberately a plain function and NOT lifecycle-bound to `lensActive`:
 * recording is unconditional (the Broker writes the ledger whether or not
 * anyone is looking), and this is a caller asking about a read it just
 * issued, not the instrument observing.
 *
 * It exists because a COMPUTED FINDING must carry the asOf of its oldest
 * input (§4.4), and `broker.read()` returns the payload rather than the
 * envelope. Two cockpit joins were reaching around the Broker with a raw
 * `fetchJson` purely to keep hold of `meta.asOf` — which cost them the
 * ambient `until` and the honest past-view refusal, so during a past view
 * they served live data under a past banner. Reading the asOf back OUT of
 * the choke point's own record is strictly better provenance than the call
 * site reading its own envelope: it is the number the Broker recorded for
 * the read it actually performed, at the instant it actually performed it.
 *
 * `undefined` when the server stated no asOf. Callers must render that as
 * absence — never as "now", which would claim a freshness nobody measured.
 */
export function serverAsOfFor(brokerCacheKey: string): number | undefined {
  return provenanceFor(brokerCacheKey)?.asOf;
}

/**
 * The WRITE side: performed actions, re-read on every ledger bump.
 *
 * The Broker records actions at the same choke point it records reads
 * (`recordAction`), but until now nothing outside `src/data/ledger.ts`
 * could see them, so the callout could explain where a value came FROM and
 * never that the user had just changed it. This is the twin of
 * `lensHistory`, and it is bound to the same lifecycle for the same reason:
 * `lensVersion` only advances while the instrument is powered, so a closed
 * LENS observes nothing here either.
 *
 * WHY THE LOG AND NOT `actionProvenanceFor(key)`
 *
 * The ledger keys actions by `block/action`. A hovered region declares a
 * BLOCK (its read's cache key) or a setting id — it never declares an action
 * NAME, so a single-key accessor could only be called with a name the
 * callout guessed. Guessing "the action that probably changed this" is
 * exactly the invention the no-invention law forbids. Handing the callout
 * the recorded rows lets it MATCH on a field the region actually carries and
 * say nothing when no row matches.
 */
export const lensActions: ReadableAtom<readonly ActionProvenanceRecord[]> = computed(
  lensVersion,
  () => actionLog(),
);

/**
 * THE INTERVENTIONS THEMSELVES, independent of whether the LENS is powered.
 *
 * `lensActions` above is bound to `lensVersion`, which only advances while
 * the instrument is on — correct for a callout that only exists while the
 * lens is open, and wrong for anything else. The cockpit FLOW renders every
 * operator intervention as a beat ("show when we steer, manipulate context,
 * trim, etc"), and a run whose interventions were only recorded when someone
 * happened to have the lens open would be a partial account of itself, which
 * is precisely the defect the flow exists to prevent.
 *
 * So this is a plain always-live subscription to the same ledger: one
 * listener for the whole app, installed lazily on the first subscriber and
 * dropped when the last one leaves (nanostores `onMount`), emitting the same
 * bounded, oldest-first log the Broker keeps.
 *
 * IT LIVES HERE, in `src/state/**`, because that is the layer the cockpit is
 * allowed to talk to (guard: cockpit-no-legacy-imports). A cockpit module
 * reaching into `src/data/ledger.ts` directly would be the cockpit
 * growing a second, private door into the data layer.
 */
export const performedActions = atom<readonly ActionProvenanceRecord[]>([...actionLog()]);

/**
 * A COPY PER BUMP, DELIBERATELY. `actionLog()` returns the ledger's own
 * bounded array, and it returns the SAME REFERENCE every time — the Broker
 * pushes into it in place. A store that re-set that reference would compare
 * equal to its previous value and notify nobody, so every subscriber would
 * sit on a stale snapshot while the array underneath them silently grew. The
 * copy is bounded by PROVENANCE_HISTORY_LIMIT and only taken when an
 * intervention actually happens, which is rare by nature.
 */
onMount(performedActions, () => {
  performedActions.set([...actionLog()]);
  return subscribeProvenance(() => performedActions.set([...actionLog()]));
});

let unsubscribe: (() => void) | undefined;

function bump(): void {
  lensVersion.set(lensVersion.get() + 1);
}

/** Power the instrument on: subscribe to the ledger, sample the clock. */
export function activateLens(): void {
  if (lensActive.get()) return;
  lensActive.set(true);
  lensNow.set(Date.now());
  unsubscribe = subscribeProvenance(bump);
  bump();
}

/** Power it off: drop the subscription and the target, return to live. */
export function deactivateLens(): void {
  if (unsubscribe !== undefined) {
    unsubscribe();
    unsubscribe = undefined;
  }
  lensActive.set(false);
  lensKey.set(null);
}

/** Point the instrument at a binding key, or at nothing. */
export function pointLensAt(key: string | null): void {
  if (lensKey.get() === key) return;
  lensKey.set(key);
}

/**
 * Advance the clock LENS renders ages against.
 *
 * Injected rather than read from `Date.now()` inside a derived value so age is
 * a pure function of state — which is what makes staleness testable without
 * faking timers, and what keeps the derivation free of a hidden input.
 */
export function tickLens(nowMs: number): void {
  lensNow.set(nowMs);
  bump();
}

/**
 * Reset. Clears the provenance ledger too — keys and params can carry project
 * paths and record ids, so leaving them across a user switch is a cross-user
 * leak, which is the whole reason the reset registry exists.
 */
export function resetLens(): void {
  deactivateLens();
  lensVersion.set(0);
  lensNow.set(0);
  clearProvenance();
}

registerReset("lens", resetLens);
