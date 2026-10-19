/**
 * The ambient recording context — who is acting, and within what.
 *
 * Binding guideline: "we must ensure things cannot NOT be recorded... we don't
 * want to have to remember to code them or pass them into a function."
 *
 * THE DEFECT THIS FIXES
 *
 * `createTimelineRecorder` takes an actor ONCE, at construction, defaulting to
 * `{kind:"harness", id:"runtime"}`. Every event inherits it unless a caller
 * passes an explicit actor — and no caller does. Measured against 24,816 real
 * events: `actor_kind` is the constant `"harness"` for ALL of them. The ledger
 * has a rich actor model and records the same value every time, so "who did
 * this" is unanswerable in practice.
 *
 * The obvious fix — thread an actor parameter through every recording call —
 * is the failure mode the guideline names. It would have to be remembered at
 * every call site, forever, and a missed one degrades silently back to the
 * default.
 *
 * AMBIENT INSTEAD
 *
 * `AsyncLocalStorage` carries the context across every `await` without being
 * passed. A boundary (an HTTP request, a run, a turn) enters it once; anything
 * that records inside that boundary is attributed correctly with no parameter
 * and no memory. This is not a new pattern for this codebase — it is already
 * used by `runtime/admitted-node-runtime.ts` and
 * `filesystem/durable-filesystem-internal.ts`.
 *
 * WHAT NESTING BUYS
 *
 * Because contexts nest, the span stack yields `parentEventId` and `traceId`
 * from STRUCTURE rather than from a caller's diligence — which is why those
 * fields are currently 60% and 0% populated respectively. A nested `withSpan`
 * knows its parent because it is lexically inside it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Who is acting. */
export type RecordingActor = Readonly<{
  /**
   * The kind of actor. Deliberately open-ended rather than a closed union:
   * new actor kinds (a new agent type, a new tool family) must not require a
   * change here to be attributed.
   */
  kind: string;
  /** Stable identity within the kind. */
  id: string;
  /** Optional finer role, e.g. which subsystem. */
  role?: string;
}>;

/** The ambient context carried across async boundaries. */
export type RecordingContext = Readonly<{
  actor: RecordingActor;
  /** Correlation ids, all optional — set by whichever boundary knows them. */
  runId?: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
  /** Trace identity for the whole causal chain. */
  traceId?: string;
  /** The enclosing span, which becomes a recorded event's parent. */
  spanId?: string;
}>;

const storage = new AsyncLocalStorage<RecordingContext>();

/**
 * The actor used when nothing has entered a context.
 *
 * Deliberately NOT `harness/runtime` — that is the value that made the defect
 * invisible. `unattributed` is a visible admission in the ledger that
 * something recorded outside any boundary, which is a wiring bug worth
 * finding rather than hiding behind a plausible default.
 */
export const UNATTRIBUTED: RecordingActor = Object.freeze({
  kind: "unattributed",
  id: "unknown",
});

/** The current context, or `undefined` outside any boundary. */
export function currentRecordingContext(): RecordingContext | undefined {
  return storage.getStore();
}

/** The current actor, falling back to the visible `unattributed` marker. */
export function currentActor(): RecordingActor {
  return storage.getStore()?.actor ?? UNATTRIBUTED;
}

/** Re-enter this exact recording scope across iterator pulls, without merging the consumer's scope. */
export function bindRecordingContext(): <T>(fn: () => T) => T {
  const context = storage.getStore();
  return <T>(fn: () => T): T => context === undefined ? storage.exit(fn) : storage.run(context, fn);
}

/**
 * Run `fn` inside a recording context.
 *
 * Entering a context REPLACES the actor but MERGES correlation ids, so an
 * inner boundary that knows only its turn does not erase the run it belongs
 * to.
 */
export function withRecordingContext<T>(
  context: RecordingContext,
  fn: () => T,
): T {
  const parent = storage.getStore();
  const merged: RecordingContext = Object.freeze({
    ...parent,
    ...context,
    actor: context.actor,
  });
  return storage.run(merged, fn);
}

/**
 * Run `fn` inside a nested span.
 *
 * The span id becomes the parent of anything recorded within, so causality
 * comes from the call structure. A trace id is established at the outermost
 * span and inherited by every descendant, which is what makes a whole turn
 * traversable as one chain.
 */
export function withSpan<T>(spanId: string, fn: () => T): T {
  const parent = storage.getStore();
  const next: RecordingContext = Object.freeze({
    actor: parent?.actor ?? UNATTRIBUTED,
    ...parent,
    spanId,
    traceId: parent?.traceId ?? spanId,
  });
  return storage.run(next, fn);
}

/**
 * Amend the current context in place for the remainder of the boundary.
 *
 * Used when a correlation id becomes known only after the boundary was
 * entered — a run id assigned after the request began, for instance. Returns
 * false when called outside any context, which is a wiring bug rather than
 * something to paper over.
 */
export function amendRecordingContext(patch: Partial<RecordingContext>): boolean {
  const current = storage.getStore();
  if (current === undefined) return false;
  storage.enterWith(Object.freeze({ ...current, ...patch }));
  return true;
}
