/**
 * DESK — session feed (§3.4–3.5): the state machine between the two block
 * reads (`run.compose`, `tools.breaker`) and the open desk's strips/rows.
 *
 * HONESTY RULES, mechanically kept (and mutation-tested in
 * tests/cockpit/desk-feed.test.ts):
 *
 *   - every load starts as explicit "pending" and becomes MEASURED only from
 *     a real read; a failed/refused read becomes ABSENT with plain words —
 *     never a spinner, never a guessed strip;
 *   - an act (pin/mute/trim/set/reset/arm) acknowledges OPTIMISTICALLY and
 *     synchronously (the <100ms §1.5 budget) by marking the target pending —
 *     but the DISPLAYED state (chip, strip, bar) only ever changes from a
 *     read: after the action settles the feed FORCE re-reads the block and
 *     the pending mark clears when that read-back lands. Confirmation comes
 *     from the read, not from hope: `confirmFromRead` is the ONLY transition
 *     that clears a settled act's pending mark.
 *   - a failed act clears its pending mark and records the failure in plain
 *     words on the same key — nothing changed, and the surface says so.
 *
 * Readers and the action poster are injectable (`setDeskIo`) so the machine
 * is node-testable without a network; production goes through the Broker.
 */

import { atom } from "nanostores";

import {
  action as brokerAction,
  onInvalidation,
  read,
  readKey,
  readMeta,
} from "../../data/broker.ts";
import { registerReset } from "../../state/store-registry.ts";
import { isStreaming } from "../../state/chat-messages.ts";
import { absenceReason } from "../../data/absence.ts";
import { DESK_READ_TTL_MS, DESK_RUN_END_DEBOUNCE_MS } from "./desk-config.ts";
import {
  decodeBreakerRows,
  decodeCompose,
  decodeConfinement,
  decodeItemDetail,
  type BreakerRowView,
  type ChannelId,
  type ComposeView,
  type ConfinementView,
  type ItemDetailView,
} from "./desk-data.ts";

// ── Load shapes ────────────────────────────────────────────────────────────

export type ComposeLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; view: ComposeView; asOf: number }>
  | Readonly<{ kind: "absent"; reason: string }>;

export type BreakerLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; rows: readonly BreakerRowView[]; asOf: number }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** One strip item's REAL body (`run.composeItem`) — same three states. */
export type ItemDetailLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; view: ItemDetailView; asOf: number }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** How much of this computer a run's commands can reach — same three states,
 *  and the MEASURED one carries the server's four-way reading inside it. */
export type ConfinementLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; view: ConfinementView; asOf: number }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** chatId → load. Written ONLY by this module. */
export const composeLoads = atom<Readonly<Record<string, ComposeLoad>>>({});
export const breakerLoads = atom<Readonly<Record<string, BreakerLoad>>>({});
/** The confinement reading — ONE value, not per chat: it describes this
 *  server's authority over this machine, which no conversation changes. */
export const confinementLoad = atom<ConfinementLoad>({ kind: "pending" });
/** `itemLoadKey(...)` → load. Written ONLY by this module. */
export const itemDetailLoads = atom<Readonly<Record<string, ItemDetailLoad>>>({});

/** In-flight act marks: key → plain-words note (see `actKey`). Set
 * synchronously when the act starts; cleared ONLY by read-back or failure. */
export const pendingActs = atom<Readonly<Record<string, string>>>({});
/** key → plain-words failure of the LAST act on that key (cleared on the
 * next act on the same key). */
export const actFailures = atom<Readonly<Record<string, string>>>({});

/** One vocabulary for act keys, shared with the components. */
export function actKey(kind: "breaker" | "compose", target: string): string {
  return `${kind}:${target}`;
}

// ── Injectable IO ──────────────────────────────────────────────────────────

export type DeskIo = Readonly<{
  compose: (chatId: string, force: boolean) => Promise<unknown>;
  breaker: (chatId: string, force: boolean) => Promise<unknown>;
  itemDetail: (
    chatId: string,
    channel: ChannelId,
    itemId: string,
    force: boolean,
  ) => Promise<unknown>;
  confinement: (force: boolean) => Promise<unknown>;
  act: (
    block: string,
    actionName: string,
    input: Readonly<Record<string, unknown>>,
    invalidates: readonly string[],
  ) => Promise<unknown>;
}>;

// ── The two reads' identities (params + the Broker cache key) ──────────────
//
// The params literal is written ONCE per read and both the reader and the
// LENS stamp are derived from it. A stamp assembled independently at the
// render site would be a SECOND opinion about what was fetched, and the day
// the two drift the callout starts naming a record that does not exist —
// the precise failure the no-invention law exists to prevent.

const composeParams = (chatId: string): Record<string, string> => ({ chatId });
const breakerParams = (chatId: string): Record<string, string> => ({ chatId });
const itemParams = (
  chatId: string,
  channel: ChannelId,
  itemId: string,
): Record<string, string> => ({ chatId, channel, itemId });

/** The per-item body's own identity — the Broker cache key doubles as the
 * load key, so a body and the request that fetched it cannot drift apart
 * (the same argument `composeProvKey` makes for the strips). */
export function itemLoadKey(chatId: string, channel: ChannelId, itemId: string): string {
  return readKey("run.composeItem", itemParams(chatId, channel, itemId));
}

/** The `data-prov` value for a chat's composition strips. */
export function composeProvKey(chatId: string): string {
  return readKey("run.compose", composeParams(chatId));
}

/** The `data-prov` value for a chat's breaker rows. */
export function breakerProvKey(chatId: string): string {
  return readKey("tools.breaker", breakerParams(chatId));
}

/** The `data-prov` value for the confinement reading. */
export function confinementProvKey(): string {
  return readKey("tools.confinement", {});
}

const LIVE_IO: DeskIo = {
  compose: (chatId, force) =>
    read<unknown>("run.compose", {
      params: composeParams(chatId),
      ttlMs: DESK_READ_TTL_MS,
      force,
      invalidateOn: ["compose:changed", "run:done"],
    }),
  breaker: (chatId, force) =>
    read<unknown>("tools.breaker", {
      params: breakerParams(chatId),
      ttlMs: DESK_READ_TTL_MS,
      force,
      invalidateOn: ["tools:changed", "run:done"],
    }),
  itemDetail: (chatId, channel, itemId, force) =>
    read<unknown>("run.composeItem", {
      params: itemParams(chatId, channel, itemId),
      ttlMs: DESK_READ_TTL_MS,
      force,
      invalidateOn: ["compose:changed", "run:done"],
    }),
  // NO TTL. The server recomputes this on every read (its own expensive half
  // is cached on the guardian binary's identity), and a window here would be
  // a window in which the desk keeps saying "in this project" after that
  // stopped being true. This is the one reading where staleness is not a
  // cosmetic lag.
  confinement: (force) =>
    read<unknown>("tools.confinement", { params: {}, ttlMs: 0, force }),
  act: (block, actionName, input, invalidates) =>
    brokerAction(block, actionName, input, { invalidates }),
};

let io: DeskIo = LIVE_IO;

/** Test seam. Returns the previous IO so a test can restore it. */
export function setDeskIo(next: Partial<DeskIo>): DeskIo {
  const prev = io;
  io = { ...io, ...next };
  return prev;
}

// ── Loads ──────────────────────────────────────────────────────────────────

/** The desk's own shape-mismatch sentence: a read that answered, but not
 * with strips/rows this surface can measure. Distinct from the transport
 * failures `absenceReason` maps — the answer arrived; it was unusable. */
const UNMEASURABLE_SHAPE = "the answer did not carry a composition this desk can measure";

function patchCompose(chatId: string, value: ComposeLoad): void {
  composeLoads.set({ ...composeLoads.get(), [chatId]: value });
}

function patchBreaker(chatId: string, value: BreakerLoad): void {
  breakerLoads.set({ ...breakerLoads.get(), [chatId]: value });
}

/**
 * NEVER BLANK WHAT IS ALREADY KNOWN.
 *
 * A read that FAILS does not un-measure the strips already on screen. They
 * were true when the server said them and they carry their own `asOf`; wiping
 * them because a later request timed out would make the desk emptier, not more
 * honest — and it is exactly the flash the user reported as "everything
 * reloads". Absence-first governs what was NEVER measured; it is not a licence
 * to forget what was.
 *
 * The failure is still recorded — the Broker logged it in the provenance
 * ledger under this read's key as `failed`, which is what LENS reads out.
 *
 * A read that SUCCEEDS with an unusable shape is different, and is NOT covered
 * here: the server answered, and its answer is that there is no composition
 * this desk can measure. That replaces the strips, because it is news.
 */
function measured(state: { kind: string } | undefined): boolean {
  return state?.kind === "measured";
}

/**
 * WHEN the value on screen was true — the envelope's own `asOf`, never the
 * moment these bytes reached this function.
 *
 * The Broker serves a last-known value instantly and revalidates underneath,
 * so `Date.now()` here would date a cached answer as this instant: a true
 * number under a false timestamp. The strips display this, and LENS explains
 * it, so it has to be the server's production time or nothing. The fallback is
 * only reachable for a payload that arrived through an injected test reader
 * with no cache entry behind it.
 */
function asOfFor(key: string): number {
  return readMeta(key)?.asOf ?? Date.now();
}

async function loadCompose(chatId: string, force: boolean): Promise<void> {
  try {
    const wire = await io.compose(chatId, force);
    const view = decodeCompose(wire);
    patchCompose(
      chatId,
      view === null
        ? ({ kind: "absent", reason: UNMEASURABLE_SHAPE } as const)
        : ({ kind: "measured", view, asOf: asOfFor(composeProvKey(chatId)) } as const),
    );
  } catch (err) {
    if (measured(composeLoads.get()[chatId])) return;
    patchCompose(chatId, { kind: "absent", reason: absenceReason(err) } as const);
  }
}

async function loadBreaker(chatId: string, force: boolean): Promise<void> {
  try {
    const wire = await io.breaker(chatId, force);
    const rows = decodeBreakerRows(wire);
    patchBreaker(
      chatId,
      rows === null
        ? ({ kind: "absent", reason: UNMEASURABLE_SHAPE } as const)
        : ({ kind: "measured", rows, asOf: asOfFor(breakerProvKey(chatId)) } as const),
    );
  } catch (err) {
    if (measured(breakerLoads.get()[chatId])) return;
    patchBreaker(chatId, { kind: "absent", reason: absenceReason(err) } as const);
  }
}

const UNMEASURABLE_BODY = "the answer did not carry a body this desk can show";

/** Which item each load key stands for, so a re-measure can re-ask for the
 * SAME body. Reconstructing the triple by parsing the key back would make
 * the key format load-bearing in two places. */
const requestedItems = new Map<string, { chatId: string; channel: ChannelId; itemId: string; owners: Set<symbol>; revision: number }>();

function patchItem(key: string, value: ItemDetailLoad): void {
  itemDetailLoads.set({ ...itemDetailLoads.get(), [key]: value });
}

async function loadItemDetail(
  chatId: string,
  channel: ChannelId,
  itemId: string,
  force: boolean,
): Promise<void> {
  const key = itemLoadKey(chatId, channel, itemId);
  const demand = requestedItems.get(key);
  if (demand === undefined) return;
  const revision = ++demand.revision;
  const current = () => requestedItems.get(key) === demand && demand.revision === revision;
  try {
    const wire = await io.itemDetail(chatId, channel, itemId, force);
    if (!current()) return;
    const view = decodeItemDetail(wire);
    patchItem(
      key,
      view === null
        ? ({ kind: "absent", reason: UNMEASURABLE_BODY } as const)
        : ({ kind: "measured", view, asOf: asOfFor(key) } as const),
    );
  } catch (err) {
    if (!current()) return;
    if (measured(itemDetailLoads.get()[key])) return; // never blank a read body
    patchItem(key, { kind: "absent", reason: absenceReason(err) } as const);
  }
}

/**
 * Ensure one strip item's REAL body is (being) read. Idempotent while
 * pending or measured; an ABSENT item is retried on the next request, the
 * same honest retry gesture the two strip reads make.
 *
 * ABSENCE-FIRST (§1.5): the caller paints the row's known facts — its name,
 * its measured cost — from the strips read it already has, and this fills
 * the body underneath. Nothing above the body moves when it lands.
 */
export function requestItemDetail(chatId: string, channel: ChannelId, itemId: string): () => void {
  const key = itemLoadKey(chatId, channel, itemId);
  const owner = Symbol(key);
  let demand = requestedItems.get(key);
  if (demand === undefined) {
    demand = { chatId, channel, itemId, owners: new Set(), revision: 0 };
    requestedItems.set(key, demand);
  }
  demand.owners.add(owner);
  const current = itemDetailLoads.get()[key];
  if (current === undefined || current.kind === "absent") {
    patchItem(key, { kind: "pending" } as const);
    void loadItemDetail(chatId, channel, itemId, false);
  }
  return () => {
    if (requestedItems.get(key) !== demand || !demand.owners.delete(owner) || demand.owners.size > 0) return;
    requestedItems.delete(key);
    const { [key]: released, ...retained } = itemDetailLoads.get();
    void released;
    itemDetailLoads.set(retained);
  };
}

/**
 * Ensure a chat's breaker rows are (being) loaded — the closed-desk edge
 * summary needs only this half.
 *
 * RE-ASKED ON EVERY OPEN, and that is not a re-fetch. The Broker serves what
 * it holds and only touches the network past the 5s TTL, so an open that finds
 * the entry fresh costs a promise; one that finds it stale gets the last-known
 * rows IMMEDIATELY and the fresh ones underneath. The `pending` state is set
 * only when there is genuinely nothing to show — a re-ask never blanks rows
 * that are already on screen, which is the difference between "updated in the
 * background" and "reloads".
 */
export function requestBreaker(chatId: string): void {
  const b = breakerLoads.get()[chatId];
  if (b === undefined) patchBreaker(chatId, { kind: "pending" } as const);
  void loadBreaker(chatId, false);
}

const UNMEASURABLE_CONFINEMENT =
  "the answer did not say how much of this computer a command can reach";

/**
 * Ensure the confinement reading is (being) loaded.
 *
 * DELIBERATELY UNLIKE THE OTHER READS IN ONE RESPECT: a failure here does NOT
 * keep the previous measured value on screen. Everywhere else, refusing to
 * blank what was already measured is the honest choice — a strip that was
 * true when the server said it is still evidence. Here the value is a claim
 * about what the model can currently reach, and a stale "in this project" is
 * not weaker evidence, it is the wrong answer in the dangerous direction. So
 * a failed re-read becomes absence with its reason, and the desk says it does
 * not know rather than repeating what it used to know.
 */
async function loadConfinement(force: boolean): Promise<void> {
  try {
    const wire = await io.confinement(force);
    const view = decodeConfinement(wire);
    confinementLoad.set(
      view === null
        ? ({ kind: "absent", reason: UNMEASURABLE_CONFINEMENT } as const)
        : ({ kind: "measured", view, asOf: asOfFor(confinementProvKey()) } as const),
    );
  } catch (err) {
    confinementLoad.set({ kind: "absent", reason: absenceReason(err) } as const);
  }
}

/** Ask for the confinement reading. Always re-asks: see `loadConfinement`. */
export function requestConfinement(): void {
  void loadConfinement(true);
}

/** Ensure a chat's full desk data (composition + breakers) is loaded — same
 *  re-ask discipline as `requestBreaker`. */
export function requestDesk(chatId: string): void {
  const c = composeLoads.get()[chatId];
  if (c === undefined) patchCompose(chatId, { kind: "pending" } as const);
  void loadCompose(chatId, false);
  requestBreaker(chatId);
}

/** Force-refresh the loaded halves of a chat's desk data (after an act, at
 * a run boundary). A half never requested stays unrequested; the previous
 * MEASURED state stays on screen while the re-read is in flight — a
 * re-measure is not an amnesia event. */
export function refreshDesk(chatId: string): void {
  const c = composeLoads.get()[chatId];
  if (c !== undefined) {
    if (c.kind !== "measured") patchCompose(chatId, { kind: "pending" } as const);
    void loadCompose(chatId, true);
  }
  const b = breakerLoads.get()[chatId];
  if (b !== undefined) {
    if (b.kind !== "measured") patchBreaker(chatId, { kind: "pending" } as const);
    void loadBreaker(chatId, true);
  }
  // An open body is part of the desk's reading of this chat: a pin, a mute
  // or a finished run changes what the next reply carries, so the text on
  // screen must be re-measured with the number above it — never left as the
  // last composition's words under this composition's count.
  for (const [key, item] of requestedItems) {
    if (item.chatId !== chatId) continue;
    const load = itemDetailLoads.get()[key];
    if (load === undefined) continue;
    if (load.kind !== "measured") patchItem(key, { kind: "pending" } as const);
    void loadItemDetail(item.chatId, item.channel, item.itemId, true);
  }
}

// ── Acts (optimistic ack · read-back confirm) ──────────────────────────────

function markPending(key: string, note: string): void {
  pendingActs.set({ ...pendingActs.get(), [key]: note });
  if (actFailures.get()[key] !== undefined) {
    const { [key]: _dropped, ...rest } = actFailures.get();
    void _dropped;
    actFailures.set(rest);
  }
}

function clearPending(key: string): void {
  const { [key]: _dropped, ...rest } = pendingActs.get();
  void _dropped;
  pendingActs.set(rest);
}

function markFailure(key: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  actFailures.set({ ...actFailures.get(), [key]: message });
}

/**
 * The one act runner. Sequence — and the honesty contract:
 *   1. SYNCHRONOUS pending mark (the <100ms acknowledgement);
 *   2. the real block action through the injected poster;
 *   3. on success: FORCE re-read the acted-on block (read-back) — the
 *      displayed state changes only when that read lands;
 *   4. clear the pending mark AFTER the read-back settles (success) or
 *      immediately with the failure recorded (nothing changed).
 */
async function runAct(
  key: string,
  note: string,
  post: () => Promise<unknown>,
  readBack: () => Promise<void>,
): Promise<void> {
  markPending(key, note);
  try {
    await post();
  } catch (err) {
    markFailure(key, err);
    clearPending(key);
    return;
  }
  await confirmFromRead(key, readBack);
}

/** THE only transition that clears a SETTLED act's pending mark: the forced
 * read-back landing (whatever it says — the read is the truth teller). */
async function confirmFromRead(key: string, readBack: () => Promise<void>): Promise<void> {
  try {
    await readBack();
  } finally {
    clearPending(key);
  }
}

// Breaker acts ───────────────────────────────────────────────────────────────

/** Flip a tool's breaker; lands at the next tool decision (§3.5). */
export function flipBreaker(chatId: string, tool: string, on: boolean): Promise<void> {
  return runAct(
    actKey("breaker", tool),
    on ? "turning on — confirming from the record" : "turning off — confirming from the record",
    () => io.act("tools.breaker", "set", { tool, on, at: "next-boundary" }, ["tools:changed"]),
    () => loadBreaker(chatId, true),
  );
}

/** Clear a tripped breaker (back on from the next tool decision). */
export function resetBreaker(chatId: string, tool: string): Promise<void> {
  return runAct(
    actKey("breaker", tool),
    "resetting — confirming from the record",
    () => io.act("tools.breaker", "reset", { tool }, ["tools:changed"]),
    () => loadBreaker(chatId, true),
  );
}

/** Arm auto-trip after N consecutive recorded failures. */
export function armBreaker(chatId: string, tool: string, tripAfterFailures: number): Promise<void> {
  return runAct(
    actKey("breaker", tool),
    "arming — confirming from the record",
    () => io.act("tools.breaker", "arm", { tool, tripAfterFailures }, ["tools:changed"]),
    () => loadBreaker(chatId, true),
  );
}

/** Remove the auto-trip setting — the way back from `arm` (UIE-008: the arm
 * used to be one-way; "not armed yet" was unreachable once armed). */
export function disarmBreaker(chatId: string, tool: string): Promise<void> {
  return runAct(
    actKey("breaker", tool),
    "disarming — confirming from the record",
    () => io.act("tools.breaker", "disarm", { tool }, ["tools:changed"]),
    () => loadBreaker(chatId, true),
  );
}

// Compose acts ───────────────────────────────────────────────────────────────

/** Pin a memory: always include it in this chat's next replies. */
export function pinMemory(chatId: string, itemId: string): Promise<void> {
  return runAct(
    actKey("compose", `memories:${itemId}`),
    "pinning — re-measuring the next turn",
    () =>
      io.act("run.compose", "pin", { chatId, channel: "memories", itemId }, ["compose:changed"]),
    () => loadCompose(chatId, true),
  );
}

/** Take a pin back: the memory is recalled on its own merits again. */
export function unpinMemory(chatId: string, itemId: string): Promise<void> {
  return runAct(
    actKey("compose", `memories:${itemId}`),
    "unpinning — re-measuring the next turn",
    () =>
      io.act("run.compose", "unpin", { chatId, channel: "memories", itemId }, ["compose:changed"]),
    () => loadCompose(chatId, true),
  );
}

/** Mute one memory out of the next reply (default one turn). */
export function muteMemoryItem(chatId: string, itemId: string, turns = 1): Promise<void> {
  return runAct(
    actKey("compose", `memories:${itemId}`),
    "muting — re-measuring the next turn",
    () =>
      io.act("run.compose", "mute", { chatId, channel: "memories", itemId, turns }, [
        "compose:changed",
      ]),
    () => loadCompose(chatId, true),
  );
}

/** Mute a whole channel out of the next reply (default one turn). */
export function muteChannel(
  chatId: string,
  channel: "memories" | "toolResults",
  turns = 1,
): Promise<void> {
  return runAct(
    actKey("compose", `channel:${channel}`),
    "muting — re-measuring the next turn",
    () => io.act("run.compose", "mute", { chatId, channel, turns }, ["compose:changed"]),
    () => loadCompose(chatId, true),
  );
}

/** Take an item mute back: the memory is composed on its own merits again. */
export function unmuteMemoryItem(chatId: string, itemId: string): Promise<void> {
  return runAct(
    actKey("compose", `memories:${itemId}`),
    "unmuting — re-measuring the next turn",
    () =>
      io.act("run.compose", "unmute", { chatId, channel: "memories", itemId }, [
        "compose:changed",
      ]),
    () => loadCompose(chatId, true),
  );
}

/** Take a channel mute back: the whole channel is composed again. */
export function unmuteChannel(
  chatId: string,
  channel: "memories" | "toolResults",
): Promise<void> {
  return runAct(
    actKey("compose", `channel:${channel}`),
    "unmuting — re-measuring the next turn",
    () => io.act("run.compose", "unmute", { chatId, channel }, ["compose:changed"]),
    () => loadCompose(chatId, true),
  );
}

/** Set the trim point — `beforeTurn` in the FULL saved conversation's own
 * numbering (desk-data `trimNumbering` owns the mapping; the caller passes
 * the number the handle shows). */
export function setTrim(chatId: string, beforeTurn: number): Promise<void> {
  return runAct(
    actKey("compose", "trim"),
    "moving the trim point — re-measuring the next turn",
    () => io.act("run.compose", "trim", { chatId, beforeTurn }, ["compose:changed"]),
    () => loadCompose(chatId, true),
  );
}

// ── Live refresh: run boundary + invalidation events ───────────────────────

function refreshAllLoaded(): void {
  const ids = new Set([
    ...Object.keys(composeLoads.get()),
    ...Object.keys(breakerLoads.get()),
  ]);
  for (const chatId of ids) refreshDesk(chatId);
}

let feedBound = false;
let runEndTimer: ReturnType<typeof setTimeout> | null = null;

/** Bind the standing subscriptions once (module load): a run genuinely
 * ending re-measures every loaded chat (debounced — the streaming flag
 * flickers false between model turns of one run), and any surface's
 * compose/tools act refreshes the loads it falsified. */
function bindFeed(): void {
  if (feedBound) return;
  feedBound = true;
  let was = isStreaming.get();
  isStreaming.subscribe((streaming) => {
    if (was && !streaming) {
      if (runEndTimer !== null) clearTimeout(runEndTimer);
      runEndTimer = setTimeout(() => {
        runEndTimer = null;
        if (!isStreaming.get()) refreshAllLoaded();
      }, DESK_RUN_END_DEBOUNCE_MS);
    } else if (streaming && runEndTimer !== null) {
      clearTimeout(runEndTimer);
      runEndTimer = null;
    }
    was = streaming;
  });
  onInvalidation("compose:changed", refreshAllLoaded);
  onInvalidation("tools:changed", refreshAllLoaded);
  onInvalidation("run:done", refreshAllLoaded);
}
bindFeed();

/** Full reset (tests / sign-out). Restores live IO. */
export function resetDeskFeed(): void {
  composeLoads.set({});
  breakerLoads.set({});
  confinementLoad.set({ kind: "pending" });
  itemDetailLoads.set({});
  requestedItems.clear();
  pendingActs.set({});
  actFailures.set({});
  if (runEndTimer !== null) {
    clearTimeout(runEndTimer);
    runEndTimer = null;
  }
  io = LIVE_IO;
}

registerReset("desk-feed", resetDeskFeed);
