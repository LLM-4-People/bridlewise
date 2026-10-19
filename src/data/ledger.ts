/**
 * The provenance LEDGER — what the Broker knows, kept where LENS can read it.
 *
 * WHY THIS IS A PLAIN MODULE AND NOT A STORE
 *
 * `src/data/broker.ts` imports this directly and statically. That is the
 * whole design. The alternative — a `setProvenanceSink()` registration, the
 * idiom the harness uses for `setEffectSink` — was rejected because a
 * registration is a step someone can forget, and a provenance system whose
 * recording depends on remembering to install it reproduces exactly the
 * failure this architecture exists to eliminate (doctrine 9: recording is
 * structurally unavoidable). A static import cannot be forgotten: if the
 * Broker is in the bundle, recording is in the bundle.
 *
 * The cost of that choice is a dependency edge from the data layer to a LENS
 * module. It is paid for by keeping this file a LEAF: no Svelte, no
 * nanostores, no DOM, no I/O. It is a Map, a bounded array and a listener set.
 * The reactive layer (`src/state/lens.ts`) depends on this; this depends on
 * nothing but the contract.
 *
 * WHY RECORDING IS UNCONDITIONAL
 *
 * Recording does NOT check whether LENS is open. If it did, provenance would
 * exist only for values fetched while someone happened to be looking, and the
 * first question anyone asks — "where did THAT come from?" — is always about a
 * value that is already on screen. The cost is one frozen object per network
 * read, on the I/O path, which is already thousands of times more expensive
 * than the allocation. The hot path this feature must not touch is RENDER, and
 * nothing here runs during a render.
 *
 * @see shared/provenance.ts — the shapes and every pure rule
 */

import {
  PROVENANCE_HISTORY_LIMIT,
  makeProvenanceRecord,
  makeActionRecord,
  type ActionProvenanceRecord,
  type ActionState,
  type CacheState,
  type ProvenanceRecord,
} from "../../shared/provenance.ts";

/** The current record per Broker cache key — what is on screen NOW. */
const current = new Map<string, ProvenanceRecord>();

/**
 * A bounded log, oldest first, used for reconstruction.
 *
 * A plain array with a shift at the cap, not a ring buffer with an index: at
 * this size the shift is unmeasurable and the array is always already in
 * chronological order, which every reader wants. A ring buffer would be
 * custom machinery bought with no gain (doctrine 11).
 */
const log: ProvenanceRecord[] = [];

/**
 * Listeners, so the UI updates without polling.
 *
 * Empty whenever LENS is closed, which is what makes notification free when
 * inactive: the loop below iterates zero entries.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Record an answered read. Called ONLY from the Broker choke point.
 *
 * `revalidating` is intentionally not written to the log: it is a transient
 * state about a request in flight, and putting it in the reconstruction log
 * would make a past view show "revalidating" forever at that instant, which
 * is not what was displayed.
 */
export function recordRead(
  input: Readonly<{
    key: string;
    block: string;
    params?: Readonly<Record<string, string>> | undefined;
    cacheState: CacheState;
    requestedAt: number;
    settledAt: number;
    ttlMs: number;
    meta?: unknown;
    errorCode?: string | undefined;
    /** The input the action was issued with — recorded, never reconstructed. */
    input?: unknown;
  }>,
): void {
  const record = makeProvenanceRecord(input);
  current.set(record.key, record);
  if (record.cacheState !== "revalidating") {
    log.push(record);
    if (log.length > PROVENANCE_HISTORY_LIMIT) log.shift();
  }
  notify();
}

/**
 * The write-side ledger: performed actions, newest state per key plus a
 * bounded log. SEPARATE arrays from the read ledger on purpose — the read
 * log's contents are asserted exactly by the choke-point suite ("two forced
 * reads → ['fresh','fresh']"), and reconstruction of a past VIEW must not
 * interleave verbs with values. Same listener set: LENS repaints once for
 * either kind of news.
 */
const currentActions = new Map<string, ActionProvenanceRecord>();
const actionEntries: ActionProvenanceRecord[] = [];

/** Record a performed action. Called ONLY from the Broker choke point. */
export function recordAction(
  input: Readonly<{
    origin: ActionProvenanceRecord["origin"];
    block: string;
    action: string;
    state: ActionState;
    requestedAt: number;
    settledAt: number;
    meta?: unknown;
    errorCode?: string | undefined;
    /** The input the action was issued with — recorded, never reconstructed. */
    input?: unknown;
  }>,
): void {
  const record = makeActionRecord(input);
  currentActions.set(record.key, record);
  actionEntries.push(record);
  if (actionEntries.length > PROVENANCE_HISTORY_LIMIT) actionEntries.shift();
  notify();
}

/** The latest record for `block/action`, or `undefined` when never performed. */
export function actionProvenanceFor(key: string): ActionProvenanceRecord | undefined {
  return currentActions.get(key);
}

/** The bounded action log, oldest first. */
export function actionLog(): readonly ActionProvenanceRecord[] {
  return actionEntries;
}

/** The record backing a key, or `undefined` when nothing has read it. */
export function provenanceFor(key: string): ProvenanceRecord | undefined {
  return current.get(key);
}

/** Every live record. Sorted by key so a rendered list is stable. */
export function currentProvenance(): readonly ProvenanceRecord[] {
  return [...current.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The bounded reconstruction log, oldest first. */
export function provenanceLog(): readonly ProvenanceRecord[] {
  return log;
}

/**
 * Subscribe to ledger changes. Returns the unsubscribe.
 *
 * This is the seam that keeps LENS free when inactive: no listener is
 * registered until the overlay opens, so `notify()` walks an empty set.
 */
export function subscribeProvenance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many listeners are attached. Exists so a test can PROVE the zero-cost claim. */
export function provenanceListenerCount(): number {
  return listeners.size;
}

/**
 * Drop everything.
 *
 * Called on logout and context switch through the store registry, for the
 * same reason every other store is: provenance keys and params can carry
 * project paths and ids, and leaving them in memory across a user switch is a
 * cross-user leak.
 */
export function clearProvenance(): void {
  current.clear();
  log.length = 0;
  currentActions.clear();
  actionEntries.length = 0;
  notify();
}
