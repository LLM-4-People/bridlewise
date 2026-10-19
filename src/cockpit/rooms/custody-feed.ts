/**
 * CUSTODY — session feed (§7.2 + the Switch reel's custody badge).
 *
 * The room opens INSTANTLY (<200ms law) from whatever this feed already
 * holds and fills AFTER, absence-first, from the real `custody.state` /
 * `custody.history` reads via the Broker (cached, deduplicated,
 * invalidated on `custody:changed` / `run:done`). Every state starts as
 * explicit absence ("pending") and only ever becomes measured from a real
 * read; a refused or failed read becomes an ABSENT state with plain words —
 * never a spinner, never a fake zero.
 *
 * The Switch reels consume the same feed: a reel's custody badge is the
 * count of changed files ATTRIBUTED to that conversation by the server's
 * ledger join — the outside bucket badges no reel (absence over
 * fabrication, §1.1).
 *
 * Readers are injectable (`setCustodyReaders`) so the state machine is
 * node-testable without a network; production goes through the Broker like
 * every cockpit surface.
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { cacheKey, onInvalidation, read } from "../../data/broker.ts";
import { registerReset } from "../../state/store-registry.ts";
import { CUSTODY_READ_TTL_MS } from "./custody-config.ts";
import { absenceReason, refusalReason, UNREADABLE_SHAPE } from "../../data/absence.ts";
import {
  decodeCustodyHistory,
  decodeCustodyState,
  custodyCountsByChat,
  type CustodyHistoryWire,
  type CustodyStateWire,
} from "./custody-data.ts";

export type CustodyStateLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; state: CustodyStateWire }>
  | Readonly<{ kind: "absent"; reason: string }>
  /** The server DECLINED, on purpose, with its own sentence (a typed 503 —
   *  `git_not_run` is the canonical case). Not a failure: it renders as the
   *  grammar's REFUSED, and it STANDS — `requestCustody` does not re-queue
   *  it, because the identical read gets the identical refusal until
   *  something changes (a custody write, a project switch, an explicit
   *  refresh). */
  | Readonly<{ kind: "refused"; reason: string }>;

export type CustodyHistoryLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "measured"; history: CustodyHistoryWire }>
  | Readonly<{ kind: "absent"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

// ── Stores (read by surfaces; written only by this module) ─────────────────

export const custodyStates = atom<Readonly<Record<string, CustodyStateLoad>>>({});
export const custodyHistories = atom<Readonly<Record<string, CustodyHistoryLoad>>>({});

/** chatId → attributed changed-file count, across every project loaded so
 * far. The Switch reel badge reads THIS — one derivation, one source. */
export const custodyChatCounts: ReadableAtom<Readonly<Record<string, number>>> = computed(
  custodyStates,
  (states) => {
    const out: Record<string, number> = {};
    for (const load of Object.values(states)) {
      if (load.kind !== "measured") continue;
      for (const [chatId, n] of Object.entries(custodyCountsByChat(load.state))) {
        out[chatId] = (out[chatId] ?? 0) + n;
      }
    }
    return out;
  },
);

// ── Injectable readers ─────────────────────────────────────────────────────

export type CustodyReaders = Readonly<{
  /** `fresh` bypasses the cache: the caller wants the world as it is NOW
   *  (a room re-open revalidating what it shows), not the last answer. */
  state: (projectId: string, fresh?: boolean) => Promise<unknown>;
  history: (projectId: string, fresh?: boolean) => Promise<unknown>;
}>;

// The two reads' identities, written once and shared by the reader and the
// LENS stamp (see the desk feed for why the stamp is never reassembled at
// the render site).
const custodyParams = (projectId: string): Record<string, string> => ({ projectId });

/** The `data-prov` value for a project's uncommitted-work parcels. */
export function custodyStateProvKey(projectId: string): string {
  return cacheKey("custody.state", custodyParams(projectId));
}

/** The `data-prov` value for a project's saved-work history. */
export function custodyHistoryProvKey(projectId: string): string {
  return cacheKey("custody.history", custodyParams(projectId));
}

const LIVE_READERS: CustodyReaders = {
  state: (projectId, fresh) =>
    read<unknown>("custody.state", {
      params: custodyParams(projectId),
      ttlMs: CUSTODY_READ_TTL_MS,
      invalidateOn: ["custody:changed", "run:done"],
      ...(fresh === true ? { force: true } : {}),
    }),
  history: (projectId, fresh) =>
    read<unknown>("custody.history", {
      params: custodyParams(projectId),
      ttlMs: CUSTODY_READ_TTL_MS,
      invalidateOn: ["custody:changed", "run:done"],
      ...(fresh === true ? { force: true } : {}),
    }),
};

let readers: CustodyReaders = LIVE_READERS;

/** Test seam. Returns the previous readers so a test can restore them. */
export function setCustodyReaders(next: Partial<CustodyReaders>): CustodyReaders {
  const prev = readers;
  readers = { ...readers, ...next };
  return prev;
}

// Plain-words failure mapping (refusal → absence, §1.1): imported from the
// switch feed — the single owner of the mapping.

function patchState(projectId: string, value: CustodyStateLoad): void {
  custodyStates.set({ ...custodyStates.get(), [projectId]: value });
}

function patchHistory(projectId: string, value: CustodyHistoryLoad): void {
  custodyHistories.set({ ...custodyHistories.get(), [projectId]: value });
}

async function loadState(projectId: string, fresh = false): Promise<void> {
  try {
    const wire = await readers.state(projectId, fresh);
    const decoded = decodeCustodyState(wire);
    patchState(
      projectId,
      decoded === null
        ? ({ kind: "absent", reason: UNREADABLE_SHAPE } as const)
        : ({ kind: "measured", state: decoded } as const),
    );
  } catch (err) {
    // A failed RE-read must not blank parcels already on screen. Under
    // stale-while-revalidate the 5s TTL re-read runs underneath a measured
    // value; if it fails, the last-known state is still the truest thing we
    // have (it was real when the server said it) and its age is visible.
    // Only a load with nothing known may report absence.
    if (custodyStates.get()[projectId]?.kind === "measured") return;
    const refusal = refusalReason(err);
    patchState(
      projectId,
      refusal !== null
        ? ({ kind: "refused", reason: refusal } as const)
        : ({ kind: "absent", reason: absenceReason(err) } as const),
    );
  }
}

async function loadHistory(projectId: string, fresh = false): Promise<void> {
  try {
    const wire = await readers.history(projectId, fresh);
    const decoded = decodeCustodyHistory(wire);
    patchHistory(
      projectId,
      decoded === null
        ? ({ kind: "absent", reason: UNREADABLE_SHAPE } as const)
        : ({ kind: "measured", history: decoded } as const),
    );
  } catch (err) {
    // Same rule as the state re-read above: keep the last-known history.
    if (custodyHistories.get()[projectId]?.kind === "measured") return;
    const refusal = refusalReason(err);
    patchHistory(
      projectId,
      refusal !== null
        ? ({ kind: "refused", reason: refusal } as const)
        : ({ kind: "absent", reason: absenceReason(err) } as const),
    );
  }
}

/**
 * Ensure a project's custody state is (being) loaded. Idempotent per
 * session: pending/measured is never re-queued (the Broker's TTL governs
 * freshness underneath); a FAILED project is retried on the next call —
 * opening the room again is the honest retry gesture.
 */
/**
 * ── THE BROWSER'S CONNECTION POOL IS A SHARED, TINY BUDGET ────────────────
 *
 * These reads used to fire immediately, one per project, with no bound at all.
 * The Switch requests custody for every project that has a rendered reel, so
 * on a real account that is a dozen simultaneous requests — and each one is a
 * filesystem/git scan, not a database read (measured at 4,336ms at scale; on a
 * fixture whose paths do not exist the same block answers in 2.6ms).
 *
 * Browsers allow roughly SIX connections per host on HTTP/1.1. Observed
 * consequence: `custody.state` climbing 1.0s → 3.3s → 13.6s → 23.6s, dozens of
 * requests killed by the browser with NS_BINDING_ABORTED, and `/api/live` — the
 * standing stream whose only job is noticing outages — waiting 36 SECONDS for a
 * socket and then reporting a false outage against a server answering in 2ms.
 *
 * So this feed takes at most ONE socket. It is background badge data: nothing
 * on screen is blocked on it, and it must never outrank the conversation the
 * reader is actually looking at.
 *
 * KNOWN DUPLICATION, deliberately not fixed under time pressure:
 * `rooms/switch-feed.ts` owns an identical queue. Two queues means two budgets
 * that do not know about each other, which is exactly the "one question, two
 * paths" defect the doctrine forbids. The right shape is ONE client-wide
 * limiter at the Broker's `fetchJson` — the single choke point every read and
 * write already passes through. Recorded rather than left to be rediscovered.
 */
const CUSTODY_CONCURRENCY = 1;
let custodyActive = 0;
const custodyQueue: Array<() => Promise<void>> = [];

function pumpCustody(): void {
  while (custodyActive < CUSTODY_CONCURRENCY && custodyQueue.length > 0) {
    const task = custodyQueue.shift()!;
    custodyActive += 1;
    void task().finally(() => {
      custodyActive -= 1;
      pumpCustody();
    });
  }
}

function scheduleCustody(task: () => Promise<void>): void {
  custodyQueue.push(task);
  pumpCustody();
}

export function requestCustody(projectId: string): void {
  const s = custodyStates.get()[projectId];
  // A REFUSED state deliberately does not requeue: the server declined this
  // read on purpose and the identical request gets the identical answer.
  // The refusal stands until a custody write (`refreshCustody` via the
  // invalidation), a reset, or an explicit refresh clears it — re-polling a
  // deterministic refusal on every render was a measured 130+ requests per
  // session for answers known in advance.
  if (s === undefined || s.kind === "absent") {
    patchState(projectId, { kind: "pending" } as const);
    scheduleCustody(() => loadState(projectId));
  }
}

/** Same discipline for the saved-work history. */
export function requestCustodyHistory(projectId: string): void {
  const s = custodyHistories.get()[projectId];
  if (s === undefined || s.kind === "absent") {
    patchHistory(projectId, { kind: "pending" } as const);
    scheduleCustody(() => loadHistory(projectId));
  }
}

/**
 * The room came back ON SCREEN: re-read what is measured, without blanking
 * it (the room-visibility law — quiet when hidden, warm when shown, never
 * blank in between). Custody changes under this client with no act of its
 * own to invalidate on — a `git init` in a terminal, a commit made outside
 * — so the open gesture is the honest revalidation moment; without it the
 * room kept "not under version control" forever after a real init.
 *
 * MEASURED states only, deliberately: pending already has a read queued,
 * absent is retried by `requestCustody` (the open calls both), and a
 * REFUSED state stands — the identical read gets the identical refusal
 * until something changes (see `requestCustody`). The read is FORCED
 * because the point is the world as it is now, and the store only learns
 * what its own load functions read back.
 */
export function revalidateCustody(projectId: string): void {
  if (custodyStates.get()[projectId]?.kind === "measured") {
    scheduleCustody(() => loadState(projectId, true));
  }
  if (custodyHistories.get()[projectId]?.kind === "measured") {
    scheduleCustody(() => loadHistory(projectId, true));
  }
}

/**
 * Force-refresh a project (after keep/undo — the action already dropped the
 * Broker cache; this re-reads and re-fills the stores).
 */
export function refreshCustody(projectId: string): void {
  patchState(projectId, { kind: "pending" } as const);
  patchHistory(projectId, { kind: "pending" } as const);
  // THROUGH THE QUEUE. The invalidation binding below calls this for EVERY
  // project loaded this session, so an unqueued pair here meant a keep or an
  // undo fired 2 x (every project ever rendered) requests at once — the single
  // largest fan-out in the client, and each one a git scan.
  scheduleCustody(() => loadState(projectId));
  scheduleCustody(() => loadHistory(projectId));
}

// A custody-changing action (from ANY surface — the room, the flow's effect
// verbs) re-fills every project this session has loaded: the Broker cache is
// already dropped by the event; the stores must follow it.
let invalidationBound = false;
function bindInvalidation(): void {
  if (invalidationBound) return;
  invalidationBound = true;
  onInvalidation("custody:changed", () => {
    for (const projectId of Object.keys(custodyStates.get())) refreshCustody(projectId);
  });
}
bindInvalidation();

/** Full reset (tests / sign-out). Restores live readers. */
export function resetCustodyFeed(): void {
  // THE QUEUE IS STATE AND MUST RESET WITH THE REST. Without this, a task
  // queued against the previous test's readers stays in flight, `custodyActive`
  // never returns to zero, and every later request waits behind a promise that
  // will never settle — the same leak shape as the SSE slot held by a listener
  // registered too late.
  custodyQueue.length = 0;
  custodyActive = 0;
  custodyStates.set({});
  custodyHistories.set({});
  readers = LIVE_READERS;
}

registerReset("custody-feed", resetCustodyFeed);
