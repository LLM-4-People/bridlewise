/**
 * ARM ↔ ledger wiring (§6.4) — the ArmMenu's set/capture/clear through
 * `broker.action` against the LIVE `arm.flags` block (server/blocks/arm.ts),
 * with the browser-local store as the OFFLINE FALLBACK and the honest
 * storage label switching accordingly ("saved to the record" vs "kept
 * locally only"). The CAPTURED RANGES list + their clear door live here
 * too (UIE-057): the same block's read lists them and the same clear verb
 * removes them, so a capture is no longer a one-way door.
 *
 * PREDICATE MAPPING — the menu's predicate kinds are encoded into the
 * server's when-eval grammar over its declared ARM_PREDICATE_VOCABULARY
 * (event/tool/check/context/run roots). The mapping is EXPORTED and
 * drift-tested against the server's own `validatePredicate`
 * (tests/cockpit/sweep-arm-sync.test.ts) so an expression the server would
 * refuse can never be offered as savable.
 *
 * HONEST LIMIT: the when-eval grammar has no "contains" operator, so the
 * "file X is edited" predicate (a path FRAGMENT match) cannot be expressed
 * on the record — it stays browser-local, and `armPredicateFor` says so
 * with the reason the menu shows. Firing state is NEVER on the record: the
 * server states `serverSideFiring: false` on every read, evaluation happens
 * in this browser over its own live wire, and the fired instant travels to
 * this browser's other tabs through the shared-blob adoption (sweep-store
 * owns that wire).
 *
 * THE CUSTOM PATH: a free-text when-eval expression goes through the same
 * `arm.flags/set` door, and the SERVER validates it (validatePredicate —
 * grammar + vocabulary). A refusal — the typed 428 that travels in the
 * 200 envelope (UIE-085; the fetch door reconstructs the typed error, so
 * the console stays quiet on the designed path) — is surfaced VERBATIM,
 * never a local fallback (a locally-armed copy of an expression the record
 * refused would lie about where it lives); only an unreachable record falls
 * back to this browser.
 */

import { atom, type ReadableAtom } from "nanostores";

import { action as brokerAction, read as brokerRead } from "../../data/broker.ts";
import { ClientError } from "../../data/errors.ts";
import { registerContextReset, registerReset } from "../../state/store-registry.ts";
import { currentChatId } from "../../state/chats.ts";
import {
  ARM_PREDICATE_LABELS,
  saveArmsMerged,
  type ArmedTrigger,
  type ArmPredicateKind,
} from "./marks";
import { armedTriggers, armTrigger, clearArm } from "./sweep-store";

// ── Predicate encoding (drift-tested against server validatePredicate) ─────

export type PredicateMapping =
  | Readonly<{ expressible: true; predicate: string; label: string }>
  | Readonly<{ expressible: false; reason: string }>;

/** The record scope a reader can arm a trigger under. "chat" sends the open
 * chat's id on the wire (the flag is folded to that chat); "all" omits it
 * (the flag answers across every chat the reader owns). */
export type ArmScope = "chat" | "all";

/**
 * Encode a menu predicate kind into the server's when-eval grammar, or
 * state plainly why it cannot be. Labels are the menu's own plain words.
 * The "custom" kind's expression IS its param — the free-text entry goes
 * through the same mapping, so one door owns every expressibility verdict.
 */
export function armPredicateFor(
  kind: ArmPredicateKind,
  param: string | null,
): PredicateMapping {
  switch (kind) {
    case "check-fails":
      return {
        expressible: true,
        predicate: "check.status == 'failed'",
        label: ARM_PREDICATE_LABELS["check-fails"],
      };
    case "tool-errors":
      return {
        expressible: true,
        predicate: "tool.failed",
        label: ARM_PREDICATE_LABELS["tool-errors"],
      };
    case "context-crosses": {
      const pct = Number(param);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return { expressible: false, reason: "needs a percentage between 1 and 100" };
      }
      return {
        expressible: true,
        predicate: `context.pct >= ${pct}`,
        label: `context crosses ${pct}%`,
      };
    }
    case "custom": {
      const expr = param?.trim() ?? "";
      if (expr.length === 0) {
        return { expressible: false, reason: "the custom condition is empty" };
      }
      // The expression is offered to the SERVER verbatim — validation is the
      // record's own (validatePredicate at the arm door), and its refusal
      // is surfaced verbatim rather than pre-judged here.
      return { expressible: true, predicate: expr, label: expr };
    }
    case "file-edited":
      return {
        expressible: false,
        reason:
          "the record's predicate grammar has no 'contains' — a path-fragment match stays in this browser",
      };
  }
}

// ── The wire shape of an arm.flags flag (mirror of server ArmFlag) ─────────

export type ArmFlagWire = Readonly<{
  id: string;
  kind: "trigger" | "range";
  predicate?: string;
  t0?: number;
  t1?: number;
  label?: string;
  chatId?: string;
  recordedAt: string;
}>;

/** The wire shape of an `arm.flags` READ (mirror of server ArmFlagsRead). */
export type ArmFlagsReadWire = Readonly<{
  flags: readonly ArmFlagWire[];
  serverSideFiring: false;
}>;

export type ArmSyncResult = Readonly<{
  /** The armed trigger, or null when arming was refused outright. */
  trigger: ArmedTrigger | null;
  /** True = the record holds it; false = this browser only / refused. */
  saved: boolean;
  /** Plain words for the row/note ("saved to the record" / why not). */
  note: string;
}>;

function chatScope(scope: ArmScope): Readonly<{ chatId?: string }> | null {
  if (scope === "all") return {};
  const id = currentChatId.get();
  return id !== null ? { chatId: id } : null;
}

/** Insert a ledger-backed trigger into the shared store (fallback-free). */
function pushLedgerTrigger(
  kind: ArmPredicateKind,
  param: string | null,
  predicate: string | null,
  scope: ArmScope,
  flag: ArmFlagWire,
): ArmedTrigger {
  const recordedMs = Date.parse(flag.recordedAt);
  const t: ArmedTrigger = Object.freeze({
    id: flag.id,
    kind,
    param,
    predicate,
    scope,
    armedAtMs: Number.isFinite(recordedMs) ? recordedMs : Date.now(),
    firedAtMs: null,
    storage: "ledger" as const,
  });
  const next = Object.freeze([...armedTriggers.get(), t]);
  // The merged write seam — a ledger trigger arriving from the record is
  // one more whole-blob write, and must not bury another tab's fresher
  // persisted fact (a firing, a concurrent re-arm) any more than a local
  // arm may.
  armedTriggers.set(Object.freeze(saveArmsMerged(next)));
  return t;
}

/**
 * Arm a trigger: record-first through `arm.flags/set`, browser-local as the
 * stated fallback. Never throws — the outcome (and its honest sentence) is
 * the return value.
 *
 * A server REFUSAL (the typed 428 reconstructed from the envelope, or any
 * sub-500 answer the record chose to give) is not a fallback case: the
 * record declined the predicate, so nothing is armed and the server's own
 * sentence is surfaced verbatim — a locally-armed copy of an expression
 * the record refused would be a trigger that lies about where it lives.
 * Only an UNREACHABLE record falls back to this browser, with the reason.
 */
export async function armTriggerSynced(
  kind: ArmPredicateKind,
  param: string | null = null,
  scope: ArmScope = "chat",
): Promise<ArmSyncResult> {
  const binding = chatScope(scope);
  if (binding === null) return { trigger: null, saved: false, note: "Open a conversation or choose All my conversations before creating a watch." };
  const mapped = armPredicateFor(kind, param);
  if (!mapped.expressible) {
    if (kind === "context-crosses") {
      // An invalid parameter is a refusal, not a local fallback.
      return { trigger: null, saved: false, note: `not armed — ${mapped.reason}` };
    }
    if (kind === "custom") {
      return { trigger: null, saved: false, note: `not armed — ${mapped.reason}` };
    }
    if (kind === "file-edited" && (param === null || param.trim().length === 0)) {
      return { trigger: null, saved: false, note: "not armed — name a path fragment first" };
    }
    return {
      trigger: armTrigger(kind, param, null, scope),
      saved: false,
      note: `kept locally only — ${mapped.reason}`,
    };
  }
  try {
    const flag = await brokerAction<ArmFlagWire>(
      "arm.flags",
      "set",
      { predicate: mapped.predicate, label: mapped.label, ...binding },
      { invalidates: ["arm:changed"] },
    );
    return {
      trigger: pushLedgerTrigger(kind, param, mapped.predicate, scope, flag),
      saved: true,
      note: "saved to the record",
    };
  } catch (err) {
    if (err instanceof ClientError && err.statusCode !== undefined && err.statusCode < 500) {
      // The record ANSWERED and refused — its sentence, verbatim.
      return { trigger: null, saved: false, note: `not armed — ${err.message}` };
    }
    return {
      trigger: armTrigger(kind, param, mapped.predicate, scope),
      saved: false,
      note: `kept locally only — the record could not be reached (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Clear a trigger. A ledger trigger clears the record first (a tombstone
 * event); if the record cannot be reached the trigger STAYS listed —
 * removing it locally while the record still holds it would lie.
 */
export async function clearArmSynced(
  trigger: ArmedTrigger,
): Promise<Readonly<{ cleared: boolean; note: string }>> {
  if (trigger.storage === "ledger") {
    try {
      await brokerAction(
        "arm.flags",
        "clear",
        { id: trigger.id },
        { invalidates: ["arm:changed"] },
      );
    } catch (err) {
      return {
        cleared: false,
        note: `still armed — the record could not be reached (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }
  clearArm(trigger.id);
  return {
    cleared: true,
    note: trigger.storage === "ledger" ? "cleared from the record" : "cleared (was local only)",
  };
}

export type CaptureResult = Readonly<{
  saved: boolean;
  note: string;
  flag: ArmFlagWire | null;
}>;

/**
 * Capture a range (a BOOKMARK over the ledger — nothing is copied). There
 * is no local range store, so a failure is stated plainly, never faked.
 */
export async function captureRangeSynced(
  t0: number,
  t1: number,
  label: string,
  scope: ArmScope = "chat",
): Promise<CaptureResult> {
  const binding = chatScope(scope);
  if (binding === null) return { saved: false, flag: null, note: "Open a conversation or choose All my conversations before saving a capture." };
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return { saved: false, note: "a capture needs a name", flag: null };
  }
  if (!(t0 < t1)) {
    return { saved: false, note: "nothing on the band to capture yet", flag: null };
  }
  try {
    const flag = await brokerAction<ArmFlagWire>(
      "arm.flags",
      "capture",
      { t0: Math.floor(t0), t1: Math.ceil(t1), label: trimmed, ...chatScope(scope) },
      { invalidates: ["arm:changed"] },
    );
    return { saved: true, note: `captured "${trimmed}" to the record`, flag };
  } catch (err) {
    return {
      saved: false,
      note: `not captured — the record could not be reached (${err instanceof Error ? err.message : String(err)})`,
      flag: null,
    };
  }
}

// ── Captured ranges: the list + the clear door (UIE-057) ────────────────────
//
// A capture is a one-way door no longer: the record's range flags LIST and
// CLEAR from the same surface that makes them. The list comes from the
// `arm.flags` READ (the folded live flag set — same wire the server's own
// clear contract answers over), filtered to `kind === "range"`; triggers are
// NOT duplicated here because the menu's "cocked" group already owns them
// from the local store (with firing state, which the wire cannot express).
//
// There is no LOCAL capture store to fall back to (a capture that did not
// reach the record never existed — `captureRangeSynced` says so), so a list
// read that fails keeps the last-known rows and states the failure beside
// them: the honest-degradation split, not a silent empty list.

/** The record's captured ranges, as last read. Empty = none known. */
export const capturedRanges: ReadableAtom<readonly ArmFlagWire[]> = atom<readonly ArmFlagWire[]>(
  [],
);
const capturedRangesW = capturedRanges as ReturnType<typeof atom<readonly ArmFlagWire[]>>;

/** Why the last capture listing failed, in plain words, or null when it
 * landed (or has never been asked for). Surfaces render it verbatim. */
export const capturedRangesFailure: ReadableAtom<string | null> = atom<string | null>(null);
const capturedRangesFailureW = capturedRangesFailure as ReturnType<typeof atom<string | null>>;
const listing = atom<"unread" | "pending" | "ready" | "failed">("unread");
export const capturedRangesState: ReadableAtom<"unread" | "pending" | "ready" | "failed"> = listing;
let captureReadGeneration = 0;
function resetCaptureListing(): void {
  captureReadGeneration += 1;
  capturedRangesW.set([]);
  capturedRangesFailureW.set(null);
  listing.set("unread");
}
registerReset("capture-listing", resetCaptureListing);
registerContextReset("capture-listing", resetCaptureListing);

/**
 * Re-read the record's captured ranges. Never throws — the outcome (and its
 * honest sentence, when the record could not be reached) is the atom pair.
 *
 * A read under a planted head carries the head as `until` (arm.flags is a
 * ranged block), so a past view lists the captures as of that instant —
 * the same honesty every other ranged read holds.
 */
export async function refreshCapturedRanges(): Promise<void> {
  const generation = ++captureReadGeneration;
  listing.set("pending");
  try {
    const read = await brokerRead<ArmFlagsReadWire>("arm.flags");
    if (generation !== captureReadGeneration) return;
    capturedRangesW.set(Object.freeze(read.flags.filter((f) => f.kind === "range")));
    capturedRangesFailureW.set(null);
    listing.set("ready");
  } catch (err) {
    if (generation !== captureReadGeneration) return;
    listing.set("failed");
    capturedRangesFailureW.set(
      `captures not listed — the record could not be reached (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** The outcome sentence shape every clear door answers with. */
export type CaptureClearResult = Readonly<{ cleared: boolean; note: string }>;

/**
 * Clear ONE captured range from the record — the same `arm.flags`/`clear`
 * contract the trigger rows use, which answers ranges by id. The record is
 * the authority: on failure the row STAYS listed (removing it locally while
 * the record still holds it would lie), and the note says so.
 */
export async function clearCapturedRangeSynced(flag: ArmFlagWire): Promise<CaptureClearResult> {
  try {
    await brokerAction(
      "arm.flags",
      "clear",
      { id: flag.id },
      { invalidates: ["arm:changed"] },
    );
  } catch (err) {
    return {
      cleared: false,
      note: `still captured — the record could not be reached (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  capturedRangesW.set(Object.freeze(capturedRanges.get().filter((f) => f.id !== flag.id)));
  return {
    cleared: true,
    note: `cleared "${flag.label ?? "unnamed stretch"}" from the record`,
  };
}

/**
 * Clear EVERY listed capture — the ARM menu's "clear all" verb. Each capture
 * goes through the same per-range door (the record stays the authority for
 * each), and the aggregate note states the partial truth when some could
 * not be reached: "N of M" rather than a single success sentence over a
 * list that still holds rows.
 */
export async function clearAllCapturedRangesSynced(): Promise<CaptureClearResult> {
  const flags = [...capturedRanges.get()];
  let clearedCount = 0;
  let firstFailure: string | null = null;
  for (const flag of flags) {
    const one = await clearCapturedRangeSynced(flag);
    if (one.cleared) clearedCount += 1;
    else if (firstFailure === null) firstFailure = one.note;
  }
  if (clearedCount === flags.length) {
    return {
      cleared: true,
      note:
        flags.length === 1
          ? "cleared from the record"
          : `cleared ${flags.length} captures from the record`,
    };
  }
  if (clearedCount === 0) {
    return { cleared: false, note: firstFailure ?? "nothing captured to clear" };
  }
  return {
    cleared: false,
    note: `cleared ${clearedCount} of ${flags.length} — the rest are still on the record (${firstFailure})`,
  };
}
