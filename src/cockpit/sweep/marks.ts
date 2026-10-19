/**
 * Marks + ARM triggers (§6.2 `m`, §6.4 ARM).
 *
 * HONESTY: armed triggers are LEDGER-BACKED through the `arm.flags` block
 * (arm-sync.ts wires set/capture/clear through `broker.action`). Each
 * trigger's `storage` field carries the truth of where it lives —
 * `"ledger"` when the record accepted it, `"local"` when it could not be
 * saved (offline, or a predicate the record's grammar cannot express) —
 * and the ArmMenu states each row's storage in plain words. User `m` marks
 * remain browser-local (`LOCAL_STORAGE_NOTE`), as does trigger FIRING
 * state: the server evaluates nothing on append (`serverSideFiring:
 * false`), so a firing is always a client-side fact. "This browser" is the
 * browser, not the tab: both blobs live in this browser's shared
 * localStorage, every write goes through the MERGE seams below (a whole-
 * blob write cannot bury another tab's fresher fact), and every other tab
 * ADOPTS the stored list on write (sweep-store.ts's cross-tab handlers) —
 * so a trigger's fired instant travels to every tab of this browser and
 * survives a stale whole-write, and one firing lands once everywhere.
 * What never travels is the record: the server holds armed
 * predicates, never firings.
 */

import { adoptingForeignWrite } from "../../state/persistence.ts";

import type { SweepEvent, SweepMark } from "./types";

export const LOCAL_STORAGE_NOTE =
  "marks are stored in this browser only; armed triggers say on their row whether they reached the record";

export const MARKS_STORAGE_KEY = "cockpit.sweep.marks.v1";
export const ARMS_STORAGE_KEY = "cockpit.sweep.arms.v1";

// ── ARM predicates (§6.4's small menu, opened to the grammar) ──

export type ArmPredicateKind =
  | "check-fails"      // a check fails (test/quality event with a failure)
  | "tool-errors"      // any tool errors
  | "context-crosses"  // context crosses N% (evaluated on the compose refresh)
  | "file-edited"      // file X is edited (this browser only — no contains on the record)
  | "custom";          // a when-eval expression from the palette or the free-text entry

export type ArmedTrigger = Readonly<{
  id: string;
  kind: ArmPredicateKind;
  /** file path fragment for "file-edited"; percent (0–100) for
   * "context-crosses"; the expression itself for "custom"; unused
   * otherwise. */
  param: string | null;
  /** The record's when-eval expression when this row was armed through the
   * grammar (the custom entry, or a palette row's built predicate). Null
   * for the four fixed quick kinds — their evaluation is the honest
   * per-kind predicate in evalArmPredicate. */
  predicate: string | null;
  /** Where the RECORD holds this trigger: "chat" = scoped to the chat it
   * was armed in (the wire carried chatId); "all" = every chat the reader
   * owns (no chatId on the wire). Firing is evaluated by this browser over
   * its own live wire; the fired instant then travels to every tab of this
   * browser through the shared-blob adoption (see the module header). */
  scope: "chat" | "all";
  armedAtMs: number;
  /** Set when the trigger fired (single-shot, oscilloscope-style §6.4). */
  firedAtMs: number | null;
  /** Where the trigger lives: `"ledger"` = saved to the record through
   * `arm.flags` (its id is the server flag id); `"local"` = this browser
   * only (offline fallback, or an inexpressible predicate). */
  storage: "local" | "ledger";
}>;

export const ARM_PREDICATE_LABELS: Readonly<Record<ArmPredicateKind, string>> =
  Object.freeze({
    "check-fails": "a check fails",
    "tool-errors": "any tool errors",
    "context-crosses": "context crosses N%",
    "file-edited": "file X is edited",
    "custom": "a custom condition",
  });

/**
 * Evaluate an event-driven predicate against ONE received event.
 * "context-crosses" is NOT event-evaluable (context utilization is a
 * measurement a run serves once per compose, not a ledger event in the
 * streamed window) — it returns false here and is evaluated by the compose
 * door (`arm-fire.ts` `recordContextReading`) when the run reports its
 * context. "custom" rows evaluate through the grammar (their `predicate`
 * over the vocabulary context — arm-fire.ts); this per-kind table answers
 * false for them so the two paths cannot double-fire one row.
 * The ArmMenu says the evaluation truth on each row (honest absence).
 */
export function evalArmPredicate(t: ArmedTrigger, e: SweepEvent): boolean {
  switch (t.kind) {
    case "check-fails":
      return e.isError && (e.eventType === "test" || e.eventType === "quality");
    case "tool-errors":
      return e.isError && e.category === "tool";
    case "file-edited": {
      if (t.param === null || t.param.length === 0) return false;
      const isFileEvent =
        e.eventType === "file-effect" || e.eventType === "filesystem";
      return isFileEvent && e.description.includes(t.param);
    }
    case "context-crosses":
    case "custom":
      return false;
  }
}

/** Signal-fed evaluation for "context-crosses": the consumer that owns the
 * measured context percentage calls this on real signal updates. */
export function evalContextCross(t: ArmedTrigger, measuredPct: number): boolean {
  if (t.kind !== "context-crosses" || t.param === null) return false;
  const threshold = Number(t.param);
  return Number.isFinite(threshold) && measuredPct >= threshold;
}

// ── Local persistence (guarded — plain functions, no store coupling) ──

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrNull(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage denied — marks become session-only, still honest
  }
}

function loadJson<T>(key: string, validate: (v: unknown) => v is T): T[] {
  const s = storageOrNull();
  if (s === null) return [];
  try {
    const raw = s.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validate);
  } catch {
    return [];
  }
}

/**
 * Set when persistence failed (quota, private mode, storage denied): marks
 * degrade to session-only. Surfaces read this to say so — a degraded state
 * that is silent would be a band lying about durability.
 */
let storageDegradedReason: string | null = null;

export function marksStorageDegraded(): string | null {
  return storageDegradedReason;
}

// ── The cross-tab write seam (the single-shot law's persistence half) ──
//
// Every tab of this browser writes both blobs, and a whole-blob
// last-write-wins save can bury a fresher fact another tab just landed:
// measured as a ~2s window where the stored row read cocked while both
// tabs' UIs read fired, self-healed at the next write. A third tab loading
// inside such a window re-fires an already-fired trigger — the single-shot
// law broken browser-wide. Every write through this seam is a MERGE with
// the persisted blob instead of a clobber:
//
//   - within one row GENERATION (same `armedAtMs` — a re-arm stamps a new
//     one) the FIRING IS MONOTONE: a non-null `firedAtMs` survives a
//     cocked version, equal instants are the same fact, and two different
//     instants (the double-fire already materialized) resolve to the
//     EARLIER — the first firing is the truth;
//   - a newer GENERATION wins outright: a deliberate re-arm resets the
//     firing, and its recency beats a stale persisted firing;
//   - a row this tab CLEARED carries a session tombstone: the union will
//     not resurrect it from the persisted side, and a stale foreign blob
//     re-carrying it is refused at adoption. A deliberate re-arm of the
//     same row by another tab carries a strictly newer `armedAtMs` and
//     travels past the tombstone (the LWW-Element-Set re-add shape; at
//     equal stamps the tombstone wins — a genuine re-arm is never
//     equal-stamped).
//
// The marks blob is APPEND-ONLY by construction (rows are immutable), so
// its merge is a union by id: a stale whole-write can no longer silently
// DROP another tab's fresh mark, and a removed mark's session tombstone
// keeps the union from resurrecting it. What a synchronous seam cannot do
// is atomicity: two tabs' seams can still interleave between the read and
// the write (the one residual a Web-Locks section would close), and a
// tombstone dies with its tab — a stale tab that outlives the clearing
// tab's session can still resurrect a removed row. Both residuals are
// filed with the lock follow-up; neither is widened by this seam.

/** Merge two versions of one armed row (same id) — the generation/recency
 * rules above, as one pure function the write seam and the adoption seam
 * both consume. Symmetric: either side may be the local one. */
export function mergeArmedTriggerRow(
  mine: Readonly<ArmedTrigger>,
  theirs: Readonly<ArmedTrigger>,
): ArmedTrigger {
  if (mine.armedAtMs > theirs.armedAtMs) return mine;
  if (theirs.armedAtMs > mine.armedAtMs) return theirs;
  if (mine.firedAtMs === null) return theirs.firedAtMs === null ? mine : theirs;
  if (theirs.firedAtMs === null) return mine;
  return mine.firedAtMs <= theirs.firedAtMs ? mine : theirs;
}

/** Rows this tab deliberately cleared, and when (session-local: it guards
 * this tab's own seam and adoption until the tab goes away). */
const armsClearedAt = new Map<string, number>();
/** Marks this tab deliberately removed, and when. Marks are immutable, so
 * ANY persisted occurrence of a tombstoned id is the removed mark. */
const marksRemovedAt = new Map<string, number>();

function writeJson(key: string, value: readonly unknown[]): boolean {
  const s = storageOrNull();
  if (s === null) {
    storageDegradedReason = "browser storage unavailable";
    return false;
  }
  try {
    s.setItem(key, JSON.stringify(value));
    storageDegradedReason = null;
    return true;
  } catch (err) {
    // quota / private mode — record the degradation so the ArmMenu note
    // can say marks last only this session (honest, visible handling).
    storageDegradedReason = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/**
 * THE arms write seam: merge `mine` (this tab's snapshot) into the
 * persisted blob and write the merged result, returning it so the caller
 * converges its atom at the write. `clearedIds` names the rows this write
 * deliberately drops — a clear is the one mutation the union cannot
 * infer, so it travels as the write's own intent and is tombstoned for
 * this tab's session. Degraded storage (or an adoption in flight, which
 * must never write back) returns `mine` unchanged — the caller's own
 * snapshot stands, session-only, exactly as before this seam existed.
 */
export function saveArmsMerged(
  mine: readonly ArmedTrigger[],
  clearedIds: readonly string[] = [],
): readonly ArmedTrigger[] {
  if (adoptingForeignWrite()) return mine;
  const clearedAt = Date.now();
  for (const id of clearedIds) armsClearedAt.set(id, clearedAt);
  const s = storageOrNull();
  if (s === null) {
    storageDegradedReason = "browser storage unavailable";
    return mine;
  }
  // A persisted string that will not parse has no facts to preserve — the
  // merged write repairs it with this tab's own snapshot.
  const persisted = parseArms(s.getItem(ARMS_STORAGE_KEY)) ?? [];
  const byId = new Map<string, ArmedTrigger>();
  for (const row of mine) byId.set(row.id, row);
  for (const row of persisted) {
    const tombstone = armsClearedAt.get(row.id);
    if (tombstone !== undefined && row.armedAtMs <= tombstone) continue;
    const own = byId.get(row.id);
    byId.set(row.id, own === undefined ? row : mergeArmedTriggerRow(own, row));
  }
  const merged = [...byId.values()];
  writeJson(ARMS_STORAGE_KEY, merged);
  return merged;
}

/**
 * THE marks write seam: the same merge for the append-only blob — a union
 * by id (rows are immutable; on an id collision this tab's own row wins),
 * minus this write's deliberate removals and the session tombstones.
 * Returns the merged list for the caller's atom; degraded storage (or an
 * adoption in flight) returns `mine` unchanged.
 */
export function saveMarksMerged(
  mine: readonly SweepMark[],
  removedIds: readonly string[] = [],
): readonly SweepMark[] {
  if (adoptingForeignWrite()) return mine;
  const removedAt = Date.now();
  for (const id of removedIds) marksRemovedAt.set(id, removedAt);
  const s = storageOrNull();
  if (s === null) {
    storageDegradedReason = "browser storage unavailable";
    return mine;
  }
  const persisted = parseMarks(s.getItem(MARKS_STORAGE_KEY)) ?? [];
  const byId = new Map<string, SweepMark>();
  for (const m of mine) byId.set(m.id, m);
  for (const m of persisted) {
    if (marksRemovedAt.has(m.id)) continue;
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const merged = [...byId.values()];
  writeJson(MARKS_STORAGE_KEY, merged);
  return merged;
}

/**
 * THE arms adoption seam: fold a foreign whole-blob into this tab's rows.
 * Rows present in both merge by generation/recency (a firing this tab
 * holds survives a stale foreign blob; a stale firing does not un-fire a
 * re-armed row); rows only in the incoming blob are adopted — EXCEPT a
 * row this tab cleared (its stale re-carriage is refused); rows only in
 * this tab DROP, which is how a foreign clear travels (absence in a
 * whole-blob IS the clear) and heals at this tab's next seam write.
 */
export function adoptArmedTriggers(
  mine: readonly ArmedTrigger[],
  incoming: readonly ArmedTrigger[],
): ArmedTrigger[] {
  const mineById = new Map(mine.map((row) => [row.id, row] as const));
  const out: ArmedTrigger[] = [];
  for (const row of incoming) {
    const tombstone = armsClearedAt.get(row.id);
    if (tombstone !== undefined && row.armedAtMs <= tombstone) continue;
    const own = mineById.get(row.id);
    out.push(own === undefined ? row : mergeArmedTriggerRow(own, row));
  }
  return out;
}

/**
 * THE marks adoption seam: a foreign whole-blob replaces this tab's list
 * (absence is the only way a removal can travel — marks have no
 * generation to merge), minus this tab's session tombstones so a stale
 * blob cannot resurrect what this tab removed.
 */
export function adoptSweepMarks(incoming: readonly SweepMark[]): SweepMark[] {
  return incoming.filter((m) => !marksRemovedAt.has(m.id));
}

function isSweepMark(v: unknown): v is SweepMark {
  if (v === null || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.timeMs === "number" &&
    typeof m.label === "string" &&
    typeof m.createdAtMs === "number" &&
    (m.origin === "user" || m.origin === "arm") &&
    m.storage === "local"
  );
}

function isArmedTrigger(v: unknown): v is ArmedTrigger {
  if (v === null || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    (t.kind === "check-fails" || t.kind === "tool-errors" ||
      t.kind === "context-crosses" || t.kind === "file-edited" || t.kind === "custom") &&
    (t.param === null || typeof t.param === "string") &&
    // Absent counts as null: rows stored before these fields existed parse
    // as the honest "no expression / this chat" rather than being dropped.
    // isArmedTrigger only ADMITS such a row; normalizeArmedTrigger below is
    // what makes it the promised value — admission without normalization
    // left `predicate: undefined` in the atom, and the firing engine's
    // `t.predicate !== null` test read that as "has an expression", handing
    // the missing string to the grammar, which threw and killed the firing
    // pass for every row on every received event.
    (t.predicate === undefined || t.predicate === null || typeof t.predicate === "string") &&
    (t.scope === undefined || t.scope === "chat" || t.scope === "all") &&
    typeof t.armedAtMs === "number" &&
    (t.firedAtMs === null || typeof t.firedAtMs === "number") &&
    (t.storage === "local" || t.storage === "ledger")
  );
}

/**
 * Map a validated stored row onto the shape `ArmedTrigger` declares. A row
 * saved before `predicate` and `scope` existed round-trips those keys
 * ABSENT (JSON keeps null but drops undefined) — this is the one boundary
 * where the declared `string | null` must be RESTORED, so the atom never
 * holds `undefined` and no consumer has to defend against it.
 */
function normalizeArmedTrigger(t: ArmedTrigger): ArmedTrigger {
  const raw = t as Record<string, unknown>;
  return Object.freeze({
    ...t,
    ...(raw.predicate === undefined ? { predicate: null } : {}),
    ...(raw.scope === undefined ? { scope: "chat" as const } : {}),
  });
}

/**
 * Parse a stored blob STRICTLY: `null` means "this string is not evidence of
 * anything", as distinct from `[]` which means "evidence of no marks".
 *
 * `loadJson` collapses the two, and at boot that is right — a corrupt blob and
 * an empty one both leave you with no marks to restore. It is NOT right when
 * ADOPTING another tab's write, because there the alternative is not "nothing"
 * but "the marks this tab is already holding". Treating an unparseable foreign
 * blob as an empty list would delete real user bookmarks on the strength of a
 * string we could not read.
 */
function parseStrict<T>(raw: string | null, validate: (v: unknown) => v is T): T[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(validate);
}

/** Strict parse of a marks blob — `null` when it is not usable. */
export function parseMarks(raw: string | null): SweepMark[] | null {
  return parseStrict(raw, isSweepMark);
}

/** Strict parse of an arms blob — `null` when it is not usable. Every
 * admitted row is normalized to the declared shape (see
 * normalizeArmedTrigger) — the atom must never hold a legacy row whose
 * new fields round-tripped absent. */
export function parseArms(raw: string | null): ArmedTrigger[] | null {
  const rows = parseStrict(raw, isArmedTrigger);
  return rows === null ? null : rows.map(normalizeArmedTrigger);
}

export function loadMarks(): SweepMark[] {
  return loadJson(MARKS_STORAGE_KEY, isSweepMark);
}

export function loadArms(): ArmedTrigger[] {
  return loadJson(ARMS_STORAGE_KEY, isArmedTrigger).map(normalizeArmedTrigger);
}
