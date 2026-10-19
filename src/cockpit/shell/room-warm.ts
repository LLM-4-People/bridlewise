/**
 * WARMING — turning "I am about to open this" into "this is already loaded".
 *
 * Keep-alive (room-visibility.ts / RoomHost.svelte) makes the SECOND open of a
 * room instant. This module is about the FIRST one, and about the case
 * keep-alive cannot help with: a room whose data has aged past its TTL while
 * it sat hidden. Both are solved by asking the Broker early, through the
 * `prefetch` door that has existed and been unused for rooms since the Broker
 * was written.
 *
 * TWO MOMENTS, ONE MECHANISM.
 *
 *   ON INTENT — a pointer or focus RESTING on a room's opener (a rail grip,
 *   the place chip, the desk grip) for `INTENT_DWELL_MS`. The dwell is what
 *   makes this cheap: a pointer sweeping across the rail on its way somewhere
 *   else warms nothing, only a deliberate pause does. Leaving before the dwell
 *   elapses cancels.
 *
 *   AT IDLE — after the one-reveal frame, when the browser has nothing else to
 *   do, in the order the user's OWN history says is likely (see
 *   `roomWarmOrder`).
 *
 * WHY THIS IS SAFE TO DO SPECULATIVELY. `broker.prefetch` already:
 *   - resolves the ambient head exactly as `read` does, so a warm during a
 *     past view warms the SAME key the open would use — and a block that
 *     cannot answer for a past instant is simply not warmed, never warmed live
 *     and then read as past (the cache-poisoning this whole design forbids);
 *   - no-ops on a fresh entry and on an in-flight request, so hovering the
 *     same grip ten times costs one request at most;
 *   - swallows its own failures, so a speculative fetch can never raise an
 *     error the user did not ask for. The real read is what states a refusal.
 *
 * AND WHAT IT CANNOT DO: warming writes to the Broker cache and NOTHING else.
 * It mounts no component, sets no store, moves no pixel. That is what lets the
 * idle pass run after the reveal without breaking the one-reveal law (§10.3):
 * zero layout change, by construction, because there is no render path.
 *
 * WHY THE READS ARE DECLARED HERE. A room's feed knows its own reads, but a
 * feed module only loads when its room loads — which is precisely the moment
 * warming was supposed to have happened already. So the plans live in the
 * shell, in ONE table, and `tests/cockpit/warm-data-owner.test.ts` fails if a
 * declared block stops appearing in the feed it claims to warm.
 *
 * @see src/data/broker.ts — `prefetch`, and the SWR `read` it warms for
 * @see src/cockpit/shell/room-visibility.ts — the other half: quiet when hidden
 */

import { INTENT_DWELL_MS } from "../../../shared/constants.ts";
import { prefetch } from "../../data/broker.ts";
import { currentChatId } from "../../state/chats.ts";
import { currentProject } from "../../state/projects.ts";
import { persistGet, persistSet } from "../../state/persistence.ts";
import { onForeignWrite } from "../../state/cross-tab.ts";
import { CUSTODY_READ_TTL_MS } from "../rooms/custody-config.ts";
import { SWITCH_READ_TTL_MS, MICRO_SWEEP_BINS } from "../rooms/switch-config.ts";
import { DESK_READ_TTL_MS } from "../desk/desk-config.ts";
import type { RoomId } from "./contract.ts";

/** One Broker read a warm would perform. */
export type WarmTarget = Readonly<{
  block: string;
  params?: Readonly<Record<string, string>>;
  ttlMs: number;
}>;

/**
 * The reads each opener warms, resolved AT CALL TIME from the state stores —
 * never captured, because the current conversation can change between the
 * hover that warms and the click that opens, and warming the previous chat's
 * key would be a request paid for nothing.
 *
 * An unresolved parameter yields NO target rather than a guessed one. Warming
 * the wrong row and caching it under the right key is worse than not warming.
 */
export type WarmPlan = () => readonly WarmTarget[];

const switchPlan: WarmPlan = () => {
  const chatId = currentChatId.get();
  if (chatId === null) return [];
  // The two per-reel reads the river fills in (switch-feed.ts). The open
  // conversation is the reel the river puts at the top, so it is the one whose
  // absence would be seen first.
  return [
    {
      block: "synthesis.conversationPulse",
      params: { chatId },
      ttlMs: SWITCH_READ_TTL_MS,
    },
    {
      block: "sweep.spectrum",
      params: { scope: "chat", chatId, bins: String(MICRO_SWEEP_BINS) },
      ttlMs: SWITCH_READ_TTL_MS,
    },
  ];
};

/**
 * `custody.state` ONLY — and the omission of `custody.history` is the
 * statement, not an oversight.
 *
 * A warm is speculative work paid for now against a room that may never open,
 * so the question it has to answer is not "would this be nice to have" but
 * "does anything read this while the room is CLOSED". The two reads answer it
 * differently:
 *
 *   - `custody.state` IS read with the room closed. `custodyChatCounts`
 *     (rooms/custody-feed.ts) is a computed over it, and the Switch's reels
 *     render a per-conversation custody badge from it. Warming it moves work
 *     the Switch is going to request anyway, so the warm costs nothing extra
 *     and lands earlier.
 *
 *   - `custody.history` is read by the CustodyRoom and by nothing else. It
 *     was warmed ~30ms after reveal for a room nobody had opened, on a 5s
 *     TTL, against a read measured at **4,336ms at scale** — so the work was
 *     usually stale before anyone could use it, and it was the demonstrated
 *     cause of head-of-line blocking: `/api/health` measures p50 1.31ms and
 *     **max 4,814ms** with one custody read in flight. Every SSE token and
 *     keystroke acknowledgement waited behind a fetch for a closed room.
 *
 * The room still reads its history the moment it opens (CustodyRoom requests
 * it on mount), so nothing is lost but the speculation. The server-side cost
 * of that read is separately down from ~24 sequential `git show` spawns to
 * one `git log --numstat` (server/blocks/custody.ts::commitFilesByHash);
 * getting the scan off the event loop belongs to the async facade.
 */
const custodyPlan: WarmPlan = () => {
  const projectId = currentProject.get()?.id;
  if (projectId === undefined) return [];
  return [{ block: "custody.state", params: { projectId }, ttlMs: CUSTODY_READ_TTL_MS }];
};

/**
 * The desk is not a room — it is a panel the composer opens — but its opener
 * is a hover target with reads behind it exactly like a rail grip, so it warms
 * through the same door.
 */
export const deskWarmPlan: WarmPlan = () => {
  const chatId = currentChatId.get();
  if (chatId === null) return [];
  return [
    { block: "run.compose", params: { chatId }, ttlMs: DESK_READ_TTL_MS },
    { block: "tools.breaker", params: { chatId }, ttlMs: DESK_READ_TTL_MS },
  ];
};

/**
 * Rooms with nothing to warm are ABSENT from this table, and that is a
 * statement, not an omission:
 *
 *   - `instruments` and `settings` read the served schema + values channel
 *     (`/api/schema/ui`, `/api/schema/ui/values`), both of which the boot
 *     critical batch already loaded before the reveal. They open from the
 *     store with every value painted in frame one — browser-measured at 112
 *     of 112 cells and 82 of 82 rows present at first paint. There is nothing
 *     left to warm, so warming them would be a request that buys nothing.
 *   - `editor` opens onto a buffer the user chose in the moment; there is no
 *     read to make ahead of a choice that has not happened.
 *
 * This note used to end by excusing `memory` and `tools`, which had no
 * component and were never going to warm. They are no longer declared rooms:
 * an id with no door is a surface the type says a caller may summon and the
 * shell can only answer "not built yet".
 */
export const WARM_PLANS: Partial<Record<RoomId, WarmPlan>> = {
  switch: switchPlan,
  custody: custodyPlan,
};

/**
 * Warm one opener's reads. Cheap, cancellable-by-irrelevance (a superseded
 * request is dropped by the Broker's generation guard), deduplicated, and
 * silent on failure.
 */
export function warmPlan(plan: WarmPlan): void {
  for (const target of plan()) {
    prefetch(target.block, {
      ...(target.params !== undefined ? { params: target.params } : {}),
      ttlMs: target.ttlMs,
    });
  }
}

/** Warm the reads a room would issue. A room with no plan is a no-op. */
export function warmRoom(id: RoomId): void {
  const plan = WARM_PLANS[id];
  if (plan === undefined) return;
  warmPlan(plan);
}

/**
 * The plan behind a GRAMMAR TARGET, so a grip warms without being configured.
 *
 * Every rail grip already carries the target it fires (`data-chord-target`) —
 * that attribute is the mouse-path guard's evidence that the click and the
 * chord route to the same place. Deriving the warm from the SAME string means
 * a grip cannot warm one room and open another, and a new room's grip warms
 * the moment its plan is declared, with no second wiring step to forget.
 *
 * `desk` is the one non-room opener: a panel, not a room, with reads behind it
 * exactly like a rail grip.
 */
export function planForTarget(target: string): WarmPlan | null {
  if (target === "desk") return deskWarmPlan;
  return WARM_PLANS[target as RoomId] ?? null;
}

/**
 * Svelte action — warm on DWELL, cancel on leave.
 *
 *     <button use:warmOnIntent={planForTarget(target)}>…</button>
 *
 * Pointer and keyboard both count as intent (`focus` is the keyboard's hover),
 * and both cancel the same way. The dwell timer is the cost control: a pointer
 * crossing the rail fires `pointerenter`/`pointerleave` far inside
 * `INTENT_DWELL_MS` and warms nothing at all.
 */
export function warmOnIntent(
  node: HTMLElement,
  plan: WarmPlan | null,
): Readonly<{ update: (next: WarmPlan | null) => void; destroy: () => void }> {
  let current = plan;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const start = (): void => {
    if (current === null) return;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      // Re-read through the closure: the plan resolves its params at CALL
      // time, so a conversation switched during the dwell warms the new one.
      if (current !== null) warmPlan(current);
    }, INTENT_DWELL_MS);
  };

  node.addEventListener("pointerenter", start);
  node.addEventListener("pointerleave", cancel);
  node.addEventListener("focus", start);
  node.addEventListener("blur", cancel);

  return {
    update(next: WarmPlan | null): void {
      current = next;
      if (next === null) cancel();
    },
    destroy(): void {
      cancel();
      node.removeEventListener("pointerenter", start);
      node.removeEventListener("pointerleave", cancel);
      node.removeEventListener("focus", start);
      node.removeEventListener("blur", cancel);
    },
  };
}

// ── The activation ledger (what "likely" means, honestly) ──────────────────

/**
 * How many times THIS user has opened each room, persisted through the app's
 * one persistence owner.
 *
 * The idle warm has to choose an order, and there are only two honest ways to
 * choose one: measure, or declare. This measures — every open is counted, the
 * count is never seeded, estimated or back-filled, and a room the user has
 * never opened has no entry rather than a zero that pretends to be an
 * observation. Until the ledger has anything to say (a first session, a
 * cleared browser) the order falls back to `STATIC_WARM_ORDER` below, which is
 * declared in the open rather than dressed up as a measurement.
 */
const ACTIVATIONS_STORAGE_KEY = "cockpit.rooms.activations.v1";

/**
 * The declared fallback order, and the tie-break for equal counts.
 *
 * Justified, not guessed: `switch` is the shell's own place-chip affordance
 * and the one room reachable without knowing any chord, so it is the room a
 * session is most likely to reach for first; `custody` carries the work a run
 * has left uncommitted, which is what a returning user checks. The two rooms
 * with nothing to warm are absent from the plans table anyway.
 *
 * DELIBERATE SUBSET: 2 of 5 rooms on purpose, and it must NOT be derived
 * from `RoomId`. This is a warm-up BUDGET — the shell pre-warms the rooms a
 * cold session is most likely to open, and warming all of them is the same as
 * warming none, because the work competes for the same idle frame. Every
 * other room is warmed on demand and loses nothing by being absent here. A
 * new room therefore belongs in this list only if someone decides it beats
 * one of these two, which is a judgement and not a completeness property.
 */
export const STATIC_WARM_ORDER: readonly RoomId[] = ["switch", "custody"];

/**
 * The counts, held in memory and WRITTEN THROUGH to storage.
 *
 * In memory because the order is consulted on a hot path (the reveal frame's
 * idle callback) and re-parsing a JSON blob per open is work for nothing;
 * written through because a count that only lived for the session would make
 * "the user's own history" mean "the last ten minutes". `null` means not yet
 * hydrated — hydration is lazy so a shell that never warms never reads
 * storage at all.
 *
 * Storage is a CACHE of this, not the truth: a browser that refuses to store
 * (private mode, quota, denied) degrades to session-only counts, which is
 * strictly better than degrading to none.
 */
let activations: Record<string, number> | null = null;

function loadActivations(): Record<string, number> {
  if (activations !== null) return activations;
  const out: Record<string, number> = {};
  const raw = persistGet(ACTIVATIONS_STORAGE_KEY);
  const parsed = parseCounts(raw);
  for (const [id, n] of Object.entries(parsed)) out[id] = n;
  activations = out;
  return out;
}

/**
 * Parse a stored blob into counts, keeping only what is genuinely a count.
 *
 * A corrupt, foreign or unparseable blob degrades to NO counts — never to an
 * invented one. That is the whole handling this failure needs and it is not a
 * swallowed error: a blob that will not parse is not evidence of anything, so
 * the honest reading of it is the empty ledger, which is exactly what a first
 * session has. The consequence is visible and correct (the declared static
 * order is used instead), so there is nothing left to report.
 */
function parseCounts(raw: string | null): Record<string, number> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[id] = Math.floor(n);
  }
  return out;
}

/** Record one real room open. Called by the shell's ONE open path, so a room
 *  opened by chord, by grip and by verb all count the same. */
export function recordRoomActivation(id: RoomId): void {
  const counts = loadActivations();
  counts[id] = (counts[id] ?? 0) + 1;
  persistSet(ACTIVATIONS_STORAGE_KEY, JSON.stringify(counts));
}

/** Test/reset seam: forget the learned order. */
export function resetRoomActivations(): void {
  activations = {};
  persistSet(ACTIVATIONS_STORAGE_KEY, null);
}

/**
 * Cross-tab: the ledger MERGES rather than being replaced.
 *
 * This is the failure the in-memory cache made certain. Both tabs hydrate the
 * counts once, then write the WHOLE blob through on every open. Two tabs
 * therefore each hold a stale copy of the other's opens and overwrite it, so
 * the ledger converges on whichever tab opened a room last — and "the user's
 * own history" quietly becomes "one tab's history". Nothing on screen was
 * wrong, which is exactly why it would never have been noticed.
 *
 * Merging by the larger count is not a guess. A room open is monotonic and
 * both tabs counted real ones, so each copy is a lower bound on the truth and
 * the larger is the better-measured. No room gains an entry it did not earn: a
 * room absent from both stays absent, and `parseCounts` still refuses anything
 * that is not a positive finite count.
 *
 * The merge is held in memory only. Writing it back here would be an echo (and
 * is muted anyway); the union reaches storage on this tab's next real open,
 * which is when it starts to matter. Zero render path: these counts only order
 * an idle prefetch pass, so adoption moves no pixel by construction.
 */
onForeignWrite(ACTIVATIONS_STORAGE_KEY, (raw) => {
  const incoming = parseCounts(raw);
  const mine = loadActivations();
  for (const [id, n] of Object.entries(incoming)) {
    const own = mine[id] ?? 0;
    if (n > own) mine[id] = n;
  }
});

/**
 * The order the idle pass warms in: most-opened first (this user's own
 * measured counts), ties and unmeasured rooms in the declared static order.
 * Only rooms with a warm plan appear — there is no point ordering nothing.
 */
export function roomWarmOrder(): readonly RoomId[] {
  const counts = loadActivations();
  const warmable = STATIC_WARM_ORDER.filter((id) => WARM_PLANS[id] !== undefined);
  return warmable.sort((a, b) => {
    const diff = (counts[b] ?? 0) - (counts[a] ?? 0);
    if (diff !== 0) return diff;
    // Stable Array.sort preserves declaration order for equal priorities.
    return 0;
  });
}

/**
 * The post-reveal idle fill: warm what the user will obviously need next,
 * one room at a time, each in its own idle slice so a long plan never becomes
 * a long task.
 *
 * ZERO LAYOUT CHANGE IS STRUCTURAL, not a promise: this calls `prefetch` and
 * nothing else, and `prefetch` writes to the Broker cache and nothing else.
 * There is no render path from here, so the one-reveal law cannot be broken by
 * it — which is exactly why the warming is done through the cache rather than
 * by pre-mounting rooms.
 *
 * Returns a cancel function; the shell cancels on teardown so a warm cannot
 * outlive the cockpit that asked for it.
 */
export function warmAtIdle(order: readonly RoomId[] = roomWarmOrder()): () => void {
  let cancelled = false;
  let index = 0;
  const schedule =
    typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
      ? (fn: () => void) => window.requestIdleCallback(fn)
      : // jsdom and older browsers have no idle callback. A timeout of 0 is
        // NOT equivalent (it competes with the reveal instead of yielding to
        // it), so the fallback waits for the frame after the reveal.
        (fn: () => void) => window.setTimeout(fn, 0);

  const step = (): void => {
    if (cancelled || index >= order.length) return;
    warmRoom(order[index]!);
    index += 1;
    schedule(step);
  };
  schedule(step);

  return () => {
    cancelled = true;
  };
}
