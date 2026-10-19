/**
 * COCKPIT FLOW — the beat log (spec §3.8).
 *
 * THE EVENT LOG LIVES OUTSIDE REACTIVE STATE. This is the documented Svelte 5
 * large-proxy trap: putting a multi-thousand-element array of deep objects in
 * `$state` proxies every element on first touch and re-walks the structure on
 * every mutation. The log here is a PLAIN module array; the only reactive
 * value is a version counter (a nanostores atom holding one integer). The
 * Flow virtualizer subscribes to the counter, and on each bump re-reads ONLY
 * the visible window through the accessor functions below.
 *
 * Beats are immutable values; an update replaces the element (so a rendered
 * window can compare by reference), but the ARRAY itself is mutated in place —
 * appending beat 5,001 costs O(1), not a 5,001-element copy.
 *
 * ── ONE LOG PER WORKSPACE ─────────────────────────────────────────────────
 *
 * A page holds N workspaces (state/workspaces.ts) and ONE Flow component
 * serves all of them. A single module array therefore meant that switching
 * tabs re-ingested the whole conversation: `rebuild()` cleared the log the
 * moment the transcript diverged, which is exactly what a switch looks like.
 * The log is now a MAP of named logs with one DISPLAYED at a time, so the
 * beats a workspace has already earned stay warm underneath the tab you are
 * not looking at, and coming back is an assignment rather than a rebuild.
 *
 * Every accessor below reads the DISPLAYED log, so no call site changed. A
 * writer that must address a specific log (a run streaming into a background
 * workspace) wraps its writes in `withLog(id, …)`.
 *
 * The names are opaque strings to this module: it knows nothing about
 * workspaces, which keeps it Node-testable and keeps `state/workspaces.ts`
 * out of the flow's data layer. `flow-view.ts` is where the two are joined.
 *
 * ── MEMORY: THE POLICY, STATED ────────────────────────────────────────────
 *
 * N warm logs is unbounded, and an unbounded cache in a session that runs for
 * days is a leak with a nicer name. Two bounds, both enforced on every
 * activation, both least-recently-active first:
 *
 *   1. `MAX_WARM_LOGS` logs may hold beats at once.
 *   2. background logs may hold `BACKGROUND_BEAT_BUDGET` beats between them.
 *
 * The DISPLAYED log and any log explicitly protected (a workspace with a run
 * in flight — `run-ownership.ts` protects it) are never candidates: evicting
 * what is on screen, or what is actively being written, would be a bug rather
 * than a saving.
 *
 * AN EVICTION IS NOT A DELETION AND MUST NOT LOOK LIKE ONE. An evicted log
 * keeps its entry and remembers `evicted`, so `logIsReloading()` lets the
 * surface say it is reloading. Rendering "nothing recorded in this
 * conversation yet" over a conversation whose beats we dropped to save memory
 * would be the flow stating, in plain words, something untrue.
 */

import { ClientError } from "../../data/errors.ts";
import { atom } from "nanostores";

import type { Beat } from "./types.ts";
import { BACKGROUND_BEAT_BUDGET, MAX_WARM_LOGS } from "./flow-config.ts";

/** The log a mount with no workspace uses (dev harness, unit tests). */
export const DEFAULT_LOG_ID = "flow";

type LogStore = {
  readonly id: string;
  beats: Beat[];
  indexById: Map<string, number>;
  /** Epoch-ms this log was last made the displayed one. Real instant. */
  lastActiveMs: number;
  /** This log's beats were dropped to stay inside the budget above. */
  evicted: boolean;
  /**
   * HOW MANY BEATS HAVE EVER BEEN PREPENDED to this log — a monotone total,
   * not a flag.
   *
   * The height index is measurements BY POSITION, so a beat arriving at the
   * FRONT moves every measurement already taken. A boolean "something was
   * prepended" cannot tell the renderer by how much, and re-deriving it from
   * the count would confuse a prepend of 3 with an append of 3 — which move
   * the reader's scroll position in opposite directions.
   *
   * The renderer reads it, remembers what it last saw, and shifts its index
   * by the difference. A counter rather than an event because the renderer
   * may miss a bump (a background log, a batched version) and must still be
   * able to work out what it owes.
   */
  prepended: number;
};

const stores = new Map<string, LogStore>();

/** Logs eviction may not touch (a run is writing into them). */
const protectedIds = new Set<string>();

function storeFor(id: string): LogStore {
  let store = stores.get(id);
  if (store === undefined) {
    store = { id, beats: [], indexById: new Map(), lastActiveMs: 0, evicted: false, prepended: 0 };
    stores.set(id, store);
  }
  return store;
}

/** The log the accessors read and the writers write. */
let target: LogStore = storeFor(DEFAULT_LOG_ID);
/** The log ON SCREEN. Differs from `target` only inside `withLog`. */
let displayedId: string = DEFAULT_LOG_ID;

/**
 * Version counter — bumped once per mutation OF THE DISPLAYED LOG (or once
 * per batch). The ONLY reactive surface of the log. Subscribers re-read the
 * window; they never receive the array.
 *
 * A background log's mutation deliberately does NOT bump it: nothing on
 * screen changed, and waking the virtualizer to re-read an unchanged window
 * on every frame of someone else's stream is work paid for nothing.
 */
export const logVersion = atom<number>(0);

let batchDepth = 0;
let dirtyInBatch = false;

function bumpVersion(): void {
  if (target.id !== displayedId) return;
  if (batchDepth > 0) {
    dirtyInBatch = true;
    return;
  }
  logVersion.set(logVersion.get() + 1);
}

/** Group several mutations into ONE version bump (one window re-read). */
export function batch(fn: () => void): void {
  batchDepth += 1;
  try {
    fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0 && dirtyInBatch) {
      dirtyInBatch = false;
      logVersion.set(logVersion.get() + 1);
    }
  }
}

// ── Named logs ─────────────────────────────────────────────────────────────

/** The log currently on screen. */
export function displayedLogId(): string {
  return displayedId;
}

/**
 * Put a log on screen — the workspace switch, in one assignment.
 *
 * Creates the log if this is its first activation. Bumps the version exactly
 * once so the virtualizer re-reads its window against the new log; nothing is
 * cleared, nothing is re-ingested, and the beats the incoming workspace
 * already held are on screen in that same frame.
 */
export function activateLog(id: string): void {
  const store = storeFor(id);
  store.lastActiveMs = Date.now();
  const changed = displayedId !== id;
  displayedId = id;
  target = store;
  evictBeyondBudget();
  if (changed) logVersion.set(logVersion.get() + 1);
}

/**
 * Address a specific log for the duration of `fn` without changing what is on
 * screen. This is how a beat reaches the log of a workspace that is not the
 * active one; every accessor in this module works unchanged inside.
 */
export function withLog<T>(id: string, fn: () => T): T {
  const previous = target;
  target = storeFor(id);
  try {
    return fn();
  } finally {
    target = previous;
  }
}

/** Keep a log out of the eviction candidates (a run is writing into it). */
export function protectLog(id: string): void {
  protectedIds.add(id);
}

/** Release the protection. Does not evict; the next activation decides. */
export function unprotectLog(id: string): void {
  protectedIds.delete(id);
}

/**
 * Forget a log entirely — the workspace holding it was CLOSED. Distinct from
 * eviction: there is no workspace left to reload it for, so nothing has to
 * remember that it once existed.
 */
export function dropLog(id: string): void {
  if (id === displayedId) return;
  stores.delete(id);
  protectedIds.delete(id);
}

/** Ids of every log currently holding beats. Exported for tests + budgeting. */
export function warmLogIds(): readonly string[] {
  return [...stores.values()].filter((s) => s.beats.length > 0).map((s) => s.id);
}

/**
 * Is the DISPLAYED log one whose beats were evicted and not yet rebuilt?
 *
 * The surface asks this to say "reloading" instead of "nothing recorded here
 * yet". The two states look identical in the log (zero beats) and are
 * opposite in meaning, which is precisely why the flag is kept rather than
 * inferred.
 */
export function logIsReloading(): boolean {
  return target.evicted && target.beats.length === 0;
}

function evictBeyondBudget(): void {
  const candidates = (): LogStore[] =>
    [...stores.values()]
      .filter((s) => s.id !== displayedId && !protectedIds.has(s.id) && s.beats.length > 0)
      .sort((a, b) => a.lastActiveMs - b.lastActiveMs);

  // BACKGROUND logs, counted against a cap that RESERVES the incoming one's
  // slot. Counting everything warm instead would leave the check one
  // activation behind: the log being activated is empty at this moment and
  // fills immediately afterwards, so the cap would be exceeded by exactly one
  // for as long as the tab is open — a bound that is never actually held.
  const backgroundWarm = (): number =>
    [...stores.values()].filter((s) => s.id !== displayedId && s.beats.length > 0).length;
  const backgroundBeats = (): number =>
    [...stores.values()]
      .filter((s) => s.id !== displayedId)
      .reduce((sum, s) => sum + s.beats.length, 0);

  let pool = candidates();
  while (backgroundWarm() > MAX_WARM_LOGS - 1 && pool.length > 0) evict(pool.shift()!);
  pool = candidates();
  while (backgroundBeats() > BACKGROUND_BEAT_BUDGET && pool.length > 0) evict(pool.shift()!);
}

function evict(store: LogStore): void {
  store.beats.length = 0;
  store.indexById.clear();
  // Nothing is at the front any more because nothing is anywhere. The
  // renderer resyncs from a lower counter rather than owing a shift it can
  // no longer apply (Flow.svelte reads a DECREASE as "resync", not as a
  // negative prepend).
  store.prepended = 0;
  store.evicted = true;
}

// ── Accessors — all read the log `target` names ────────────────────────────

export function beatCount(): number {
  return target.beats.length;
}

export function beatAt(index: number): Beat | undefined {
  return target.beats[index];
}

export function indexOfBeat(id: string): number {
  return target.indexById.get(id) ?? -1;
}

export function beatById(id: string): Beat | undefined {
  const i = target.indexById.get(id);
  return i === undefined ? undefined : target.beats[i];
}

/** Read a slice [start, end) — the visible window. Returns plain values. */
export function windowSlice(start: number, end: number): readonly Beat[] {
  return target.beats.slice(Math.max(0, start), Math.min(target.beats.length, end));
}

/**
 * HOW MANY BEATS EXISTED AT AN INSTANT — the flow's half of the planted head
 * (§6.2: "every asOf-reactive surface renders its state at that instant").
 *
 * Every beat carries a MEASURED `at` (the wall-clock of the underlying fact,
 * from the source record), so "the flow at 10:14:21" needs no new data: it is
 * the prefix of the log whose facts had already happened. Returns that
 * prefix's LENGTH, so the caller bounds its window and its scroll height with
 * the number it already uses for `beatCount()`.
 *
 * A PREFIX, not a filter. The log is append-ordered by arrival, so scanning
 * stops at the first beat past the instant rather than sieving the whole
 * array: a beat recorded later cannot belong to an earlier moment of the
 * conversation, and hiding a hole in the middle would present a doctored
 * transcript as a past view — worse than showing nothing.
 */
export function beatsAtOrBefore(atMs: number): number {
  let n = 0;
  while (n < target.beats.length && target.beats[n]!.at <= atMs) n += 1;
  return n;
}

/**
 * The INDEX of the beat an instant falls in — the last one that had already
 * happened — or -1 when the instant is before the log begins.
 *
 * This is the flow's half of "scrub the sweep, the chat follows": a sweep
 * tick is addressed by a ledger event id, and a beat by its source record,
 * so the two id spaces do not always meet — but they share a CLOCK, and
 * every beat carries a measured `at`. Resolving by instant is therefore the
 * join that always works, and it is the one the scrub actually wants: "take
 * me to what was happening then".
 */
export function beatIndexAt(atMs: number): number {
  return beatsAtOrBefore(atMs) - 1;
}

export function appendBeat(beat: Beat): number {
  if (target.indexById.has(beat.id)) {
    throw new ClientError("cockpit_contract", `beat id "${beat.id}" already in the log — ids are the causal join key and must be unique`);
  }
  const index = target.beats.length;
  target.beats.push(beat);
  target.indexById.set(beat.id, index);
  // Beats again: whatever was dropped has been rebuilt, so the surface stops
  // saying it is reloading.
  target.evicted = false;
  bumpVersion();
  return index;
}

/**
 * PUT OLDER BEATS AT THE FRONT — the reader travelling backwards (§4).
 *
 * A conversation opens at its TAIL, so the beats above the first one it
 * holds are not missing, they are UNREAD. When a page of them arrives it
 * belongs before everything already in the log, and this is the only writer
 * that puts anything there.
 *
 * THE INDEX IS REBUILT, NOT PATCHED. `indexById` maps id → POSITION, and
 * every position after the insertion point moves. Adjusting them
 * incrementally would be the same O(n) work with an extra way to be wrong,
 * so the map is rebuilt once per page — a few hundred beats arriving into a
 * few thousand, not per beat.
 *
 * `prepended` is advanced by the same call, which is how the renderer learns
 * that its measurements — which are BY POSITION — have all moved down by
 * exactly this many rows.
 *
 * Order is the caller's: the beats arrive oldest-first and are placed as
 * given. This function does not sort, because the log's order is the causal
 * order the ingest built, not one this module could re-derive.
 */
export function prependBeats(beats: readonly Beat[]): void {
  if (beats.length === 0) return;
  for (const beat of beats) {
    if (target.indexById.has(beat.id)) {
      throw new ClientError(
        "cockpit_contract",
        `beat id "${beat.id}" is already in the log — an older page must not re-deliver a beat the log already holds`,
      );
    }
  }
  target.beats.unshift(...beats);
  target.indexById.clear();
  for (let i = 0; i < target.beats.length; i += 1) {
    target.indexById.set(target.beats[i]!.id, i);
  }
  target.prepended += beats.length;
  target.evicted = false;
  bumpVersion();
}

/** How many beats have EVER been prepended into the displayed log. The
 * renderer's cue that its position-keyed measurements have shifted; see
 * `LogStore.prepended`. */
export function prependedCount(): number {
  return target.prepended;
}

/** Replace a beat in place (same id, new value). No-op if absent. */
export function replaceBeat(id: string, next: Beat): boolean {
  const i = target.indexById.get(id);
  if (i === undefined) return false;
  if (next.id !== id) {
    throw new ClientError("cockpit_contract", `replaceBeat cannot change a beat's id ("${id}" → "${next.id}")`);
  }
  target.beats[i] = next;
  bumpVersion();
  return true;
}

/** Update a beat via a pure function. No-op (returns false) if absent. */
export function updateBeat(id: string, fn: (beat: Beat) => Beat): boolean {
  const i = target.indexById.get(id);
  if (i === undefined) return false;
  const next = fn(target.beats[i]!);
  if (next.id !== id) {
    throw new ClientError("cockpit_contract", `updateBeat cannot change a beat's id ("${id}")`);
  }
  target.beats[i] = next;
  bumpVersion();
  return true;
}

/** The last beat, if any. */
export function lastBeat(): Beat | undefined {
  return target.beats[target.beats.length - 1];
}

/**
 * The causal chain of a beat: [beat, parent, grandparent, …] as ids, walked
 * over the log's own parentage (§6.5 causal ribbons read this).
 */
export function causalChainOf(id: string): readonly string[] {
  const chain: string[] = [];
  let cursor: string | null = id;
  // Bounded walk: a cycle in parentage is a data bug; stop rather than hang.
  for (let hops = 0; cursor !== null && hops < 1000; hops += 1) {
    chain.push(cursor);
    const beat = beatById(cursor);
    cursor = beat?.parentId ?? null;
  }
  return chain;
}

/** Clear the log (chat switch / harness reset). */
export function clearLog(): void {
  target.beats.length = 0;
  target.indexById.clear();
  target.prepended = 0;
  // A DELIBERATE clear is not an eviction: the caller is about to rebuild
  // from a transcript it holds, so the surface must not claim it is waiting
  // on a reload it is not waiting on.
  target.evicted = false;
  bumpVersion();
}

/** Forget every log (sign-out / tests). */
export function resetAllLogs(): void {
  stores.clear();
  protectedIds.clear();
  displayedId = DEFAULT_LOG_ID;
  target = storeFor(DEFAULT_LOG_ID);
  logVersion.set(logVersion.get() + 1);
}
