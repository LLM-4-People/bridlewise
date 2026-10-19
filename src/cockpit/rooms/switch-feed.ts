/**
 * THE SWITCH — session feeds (§5.2).
 *
 * The room opens INSTANTLY from in-memory stores (<200ms budget) and these
 * feeds fill the rest AFTER, absence-first, without layout shift:
 *
 *   - chats per project (client.listChats → the chats store), fetched once
 *     per session per project under a small concurrency cap — never a
 *     90-request stampede, and never re-fetched on every ⌘J;
 *   - one `synthesis.conversationPulse` read per RENDERED reel (outcome
 *     line), via the Broker (cached, deduplicated, invalidated on
 *     run:done);
 *   - one `sweep.spectrum` read per RENDERED reel (the 24px real-density
 *     strip), same discipline. Requests arrive in river order (newest
 *     first) under the concurrency cap, so the top of the screen fills
 *     first.
 *
 * HONESTY: every state here starts as explicit absence ("pending") and only
 * ever becomes measured from a real read. A refused or failed read becomes
 * an ABSENT state with plain words (§5 task law: refusals render as
 * absence, not error walls) — never a retry spinner, never a fake zero.
 *
 * Readers are injectable (`setSwitchReaders`) so the state machine is fully
 * node-testable without a network; production defaults go through the
 * Broker/client like every other cockpit surface.
 */

import { atom } from "nanostores";
import { SvelteMap } from "svelte/reactivity";

import { onFreshRead, read, readKey } from "../../data/broker.ts";
import { absenceReason } from "../../data/absence.ts";
import { listChats } from "../../client.ts";
import { registerReset } from "../../state/store-registry.ts";
import { outcomeFromPulse, type Outcome } from "./switch-outcome.ts";
import { decodeMicroDensity, type MicroDensity } from "./micro-bins.ts";
import { FEED_CONCURRENCY, MICRO_SWEEP_BINS, SWITCH_READ_TTL_MS } from "./switch-config.ts";
import type { ChatsLoadState } from "./switch-data.ts";

export type OutcomeState = Readonly<{ kind: "pending" }> | Outcome;

export type DensityState =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; density: MicroDensity }>
  | Readonly<{ kind: "absent"; reason: string }>;

// ── Stores (read by the room; written only by this module) ────────────────

export const outcomeStates = new SvelteMap<string, OutcomeState>();
export const densityStates = new SvelteMap<string, DensityState>();
export const chatsStates = new Map<string, ChatsLoadState>();
export const feedChanges = atom<Readonly<{
  kind: "chats" | "outcome" | "density" | "reset";
  ids: readonly string[];
}>>({ kind: "reset", ids: [] });
let generation = 0;

/** Session-stable cap order (switch-data.stableCapOrder output) — lives
 * here so cap positions HOLD across room close/open (§5.2). */
export const capOrder = atom<readonly string[]>([]);

// ── Injectable readers ─────────────────────────────────────────────────────

export type SwitchReaders = Readonly<{
  pulse: (chatId: string) => Promise<unknown>;
  spectrum: (chatId: string) => Promise<unknown>;
  chats: (projectId: string) => Promise<unknown>;
}>;

// ── The reels' read identities (params + the Broker cache key) ────────────
//
// Written ONCE per read and shared by the reader and the LENS stamp, so the
// key the callout resolves is by construction the key the Broker recorded
// under. Reassembling it at the render site would be a second opinion that
// can drift into naming a record that does not exist.

const pulseParams = (chatId: string): Record<string, string> => ({ chatId });
const microSpectrumParams = (chatId: string): Record<string, string> => ({
  scope: "chat",
  chatId,
  bins: String(MICRO_SWEEP_BINS),
});

/** The `data-prov` value for a reel's measured outcome line. */
export function pulseProvKey(chatId: string): string {
  return readKey("synthesis.conversationPulse", pulseParams(chatId));
}

/** The `data-prov` value for a reel's 24px density strip. */
export function microSpectrumProvKey(chatId: string): string {
  return readKey("sweep.spectrum", microSpectrumParams(chatId));
}

const LIVE_READERS: SwitchReaders = {
  pulse: (chatId) =>
    read<unknown>("synthesis.conversationPulse", {
      params: pulseParams(chatId),
      ttlMs: SWITCH_READ_TTL_MS,
      invalidateOn: ["run:done"],
    }),
  spectrum: (chatId) =>
    read<unknown>("sweep.spectrum", {
      params: microSpectrumParams(chatId),
      ttlMs: SWITCH_READ_TTL_MS,
      invalidateOn: ["run:done"],
    }),
  // listChats writes replaceChatsForProject into the chats store itself —
  // the reel data path stays the ONE store, never a private copy.
  chats: (projectId) => listChats(projectId),
};

/** Bins for a 320px-wide strip: ~5px per bar. Owned by switch-config.ts (the
 * shell's warm-on-intent plan names the same read and cannot import a feed);
 * re-exported here so every existing call site is unchanged. The feed's
 * concurrency cap re-exports for the same reason — the perf profile reads it
 * from the config leaf, existing call sites keep this path. */
export { MICRO_SWEEP_BINS, FEED_CONCURRENCY };

let readers: SwitchReaders = LIVE_READERS;

/** Test seam. Returns the previous readers so a test can restore them. */
export function setSwitchReaders(next: Partial<SwitchReaders>): SwitchReaders {
  const prev = readers;
  readers = { ...readers, ...next };
  return prev;
}

// ── Small concurrency queue (never a request stampede) ────────────────────

let active = 0;
const queue: Array<(() => Promise<void>) | undefined> = [];
let queueHead = 0;

function pump(): void {
  while (active < FEED_CONCURRENCY && queueHead < queue.length) {
    const task = queue[queueHead]!;
    queue[queueHead++] = undefined; // release the consumed reader/closure
    if (queueHead === queue.length) { queue.length = 0; queueHead = 0; }
    active += 1;
    void task().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function schedule(task: () => Promise<void>): void {
  queue.push(task);
  pump();
}

/** Observable for the perf/behavior tests: current in-flight count. */
export function feedActiveCount(): number {
  return active;
}

// ── Plain-words failure mapping (refusal → absence, §1.1) ─────────────────
//
// The mapping itself now lives in `src/data/absence.ts` — it is needed by
// `client.ts` (the history load states its own absence, DESIGN-PERFORMANCE §1
// L3) and this room imports `client.ts`, so keeping it here would have made
// the dependency a cycle. Re-exported nowhere: importers name the owner.

// ── Chats per project (once per session) ──────────────────────────────────

function patch<T>(store: Map<string, T>, key: string, value: T): void {
  store.set(key, value);
  feedChanges.set({
    kind: Object.is(store, chatsStates) ? "chats" : Object.is(store, outcomeStates) ? "outcome" : "density",
    ids: [key],
  });
}

/** Pending population is one publication. Each completion changes just its
 * keyed state. Loaded projects are retained; failed projects retry on reopen. */
export function ensureChats(projectIds: readonly string[]): void {
  const newlyPending: string[] = [];
  for (const id of projectIds) {
    const state = chatsStates.get(id);
    if (state === "pending" || state === "loaded") continue;
    chatsStates.set(id, "pending");
    newlyPending.push(id);
  }
  if (newlyPending.length === 0) return;
  feedChanges.set({ kind: "chats", ids: newlyPending });
  const epoch = generation;
  const readChats = readers.chats;
  for (const id of newlyPending) {
    schedule(async () => {
      try {
        await readChats(id);
        if (generation === epoch) patch(chatsStates, id, "loaded");
      } catch {
        if (generation === epoch) patch(chatsStates, id, "failed");
      }
    });
  }
}

// ── Per-reel data (outcome + density), requested when rendered ────────────

// ── Never blank what is already known ─────────────────────────────────────

/**
 * A read failed. Blank the reel ONLY if there is nothing to keep.
 *
 * A measured line that is on screen was TRUE when the server said it, and it
 * carries its own `asOf` — so replacing it with "not available right now"
 * because a later request failed does not make the surface more honest, it
 * makes it emptier. Absence-first governs what was NEVER known; it was never a
 * licence to un-measure what was.
 *
 * The failure is not hidden: the Broker recorded it in the provenance ledger
 * as `failed` under this exact key, which is what LENS reads out.
 */
function alreadyMeasured(
  store: ReadonlyMap<string, { kind: string }>,
  chatId: string,
): boolean {
  return store.get(chatId)?.kind === "measured";
}

/**
 * Patch a reel's outcome in place from a pulse payload.
 *
 * Shared by the first read and by every later revalidation, so a background
 * refresh takes the SAME path as the original — which is what makes it a
 * targeted value update rather than a re-render: only this one key of the
 * store changes, so only the reel's outcome line re-renders. Nothing mounts,
 * nothing above it moves.
 */
function applyPulse(chatId: string, wire: unknown): void {
  patch(outcomeStates, chatId, outcomeFromPulse(wire));
}

function applyReelDensity(chatId: string, wire: unknown): void {
  const density = decodeMicroDensity(wire);
  patch(
    densityStates,
    chatId,
    density === null
      ? ({ kind: "absent", reason: "no events recorded" } as const)
      : ({ kind: "measured", density } as const),
  );
}

/**
 * Standing subscriptions to the two reads' cache keys, one per reel.
 *
 * This is the "patched in place" half of stale-while-revalidate. When a reel's
 * read is revalidated — by the room reopening, by a `run:done` invalidation, by
 * a warm on intent — the Broker serves the last-known value instantly and
 * fires here only if the fresh bytes DIFFER. So the common case (the answer
 * did not change) costs zero updates, and the uncommon one costs exactly one
 * value.
 */
const reelWatch = new Map<string, () => void>();

function watchReel(chatId: string): void {
  const epoch = generation;
  const pulseKey = pulseProvKey(chatId);
  if (!reelWatch.has(pulseKey)) {
    reelWatch.set(pulseKey, onFreshRead(pulseKey, (data) => { if (generation === epoch) applyPulse(chatId, data); }));
  }
  const densityKey = microSpectrumProvKey(chatId);
  if (!reelWatch.has(densityKey)) {
    reelWatch.set(densityKey, onFreshRead(densityKey, (data) => { if (generation === epoch) applyReelDensity(chatId, data); }));
  }
}

/**
 * Request one reel's measured data. Called by the room for every rendered
 * reel; idempotent (a chat already pending/answered is not re-read — the
 * Broker's own TTL/invalidation governs freshness underneath).
 *
 * `revalidate` re-asks for a reel that is ALREADY answered. That is not a
 * refetch: the Broker serves what it holds and only goes to the network when
 * the entry is past its TTL, so re-asking for a screen full of reels on reopen
 * costs nothing when nothing has aged.
 */
export function requestReelData(chatId: string, revalidate = false): void {
  watchReel(chatId);
  const epoch = generation;
  const { pulse, spectrum } = readers;
  const oc = outcomeStates.get(chatId);
  if (oc === undefined || revalidate) {
    // A reel that has never answered shows its honest pending state; one that
    // HAS answered keeps its line while the re-ask is underway.
    if (oc === undefined) patch(outcomeStates, chatId, { kind: "pending" } as const);
    schedule(async () => {
      try {
        const wire = await pulse(chatId);
        if (generation === epoch) applyPulse(chatId, wire);
      } catch (err) {
        if (generation === epoch && !alreadyMeasured(outcomeStates, chatId)) {
          patch(outcomeStates, chatId, { kind: "absent", reason: absenceReason(err) } as const);
        }
      }
    });
  }
  const dn = densityStates.get(chatId);
  if (dn === undefined || revalidate) {
    if (dn === undefined) patch(densityStates, chatId, { kind: "pending" } as const);
    schedule(async () => {
      try {
        const wire = await spectrum(chatId);
        if (generation === epoch) applyReelDensity(chatId, wire);
      } catch (err) {
        if (generation === epoch && !alreadyMeasured(densityStates, chatId)) {
          patch(densityStates, chatId, { kind: "absent", reason: absenceReason(err) } as const);
        }
      }
    });
  }
}

/**
 * REVALIDATE ON SHOW — the room became visible again after being hidden.
 *
 * Re-asks for every reel already known, which is the honest counterpart of the
 * room having stayed mounted: the values on screen are last-known, so
 * something has to go and check. Cheap by construction — each re-ask is a
 * Broker read that only touches the network past its 60s TTL, and the results
 * land as in-place patches (see `watchReel`), never as a re-mount.
 */
export function revalidateReels(): void {
  for (const chatId of outcomeStates.keys()) requestReelData(chatId, true);
}

/** Full reset (tests / sign-out). Restores live readers. */
export function resetSwitchFeed(): void {
  generation += 1;
  outcomeStates.clear();
  densityStates.clear();
  chatsStates.clear();
  capOrder.set([]);
  feedChanges.set({ kind: "reset", ids: [] });
  queue.length = 0;
  queueHead = 0;
  for (const stop of reelWatch.values()) stop();
  reelWatch.clear();
  readers = LIVE_READERS;
}

registerReset("switch-feed", resetSwitchFeed);
