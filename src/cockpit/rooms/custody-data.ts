/**
 * CUSTODY — pure data helpers (DESIGN-COCKPIT-V2 §7.2).
 *
 * Plain .ts — Node-testable without the Svelte compiler. Everything here is
 * decoding and arithmetic over the `custody.state` / `custody.history` wire
 * shapes: no fetching, no stores, no DOM. The wire is decoded defensively —
 * a malformed payload becomes `null` (rendered as honest absence), never a
 * partially-guessed object.
 *
 * Zero-knowledge language rule (§7.1): the words produced here speak custody
 * of work — keep / undo / saved work — never git nouns.
 */

// The single plain-object guard owner (No Scattered Helpers).
import { isRecord } from "../../state/coverage.ts";
import { UNDO_CONFIRM_SETTLE_MS, UNDO_CONFIRM_WINDOW_MS } from "./custody-config.ts";

// ── Wire shapes (the server's custody block output) ────────────────────────

export type CustodyFileWire = Readonly<{
  path: string;
  state: string;
  insertions: number | null;
  deletions: number | null;
  countsAbsentReason?: string;
  lastRecordedTouch?: string;
}>;

export type ParcelAttributionWire =
  | Readonly<{
      kind: "conversation";
      runId: string;
      chatId: string;
      chatTitle: string;
      turn: number | null;
      requestText: string | null;
      lastTouchedAt: string;
    }>
  | Readonly<{ kind: "outside"; reason: string }>;

export type ParcelWire = Readonly<{
  id: string;
  attribution: ParcelAttributionWire;
  files: readonly CustodyFileWire[];
  insertions: number;
  deletions: number;
  derivation: string;
}>;

export type CustodyStateWire = Readonly<{
  repository: boolean;
  reason?: string;
  branch: string | null;
  parcels: readonly ParcelWire[];
  join: Readonly<{
    changedFiles: number;
    attributedFiles: number;
    filesBeyondPathCap: number;
    fileEffectEventsExamined: number;
    undecodableEffects: number;
    truncated: boolean;
    withheldRuns: number;
  }>;
}>;

export type SavedWorkWire = Readonly<{
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  when: string;
  files: number;
  insertions: number;
  deletions: number;
  filePaths: readonly string[];
  conversation: Readonly<{
    chatId: string;
    chatTitle: string;
    overlapFiles: number;
    matchedRecords: number;
  }> | null;
  derivation: string;
}>;

export type CustodyHistoryWire = Readonly<{
  repository: boolean;
  reason?: string;
  commits: readonly SavedWorkWire[];
  remoteConfigured: boolean;
}>;

// ── Defensive decoding ─────────────────────────────────────────────────────

/** Decode a `custody.state` payload, or null when the shape is not honest. */
export function decodeCustodyState(wire: unknown): CustodyStateWire | null {
  if (!isRecord(wire)) return null;
  if (typeof wire.repository !== "boolean") return null;
  if (!Array.isArray(wire.parcels) || !isRecord(wire.join)) return null;
  for (const p of wire.parcels) {
    if (!isRecord(p) || typeof p.id !== "string" || !Array.isArray(p.files)) return null;
    if (!isRecord(p.attribution) || typeof p.attribution.kind !== "string") return null;
  }
  return wire as unknown as CustodyStateWire;
}

/** Decode a `custody.history` payload, or null. */
export function decodeCustodyHistory(wire: unknown): CustodyHistoryWire | null {
  if (!isRecord(wire)) return null;
  if (typeof wire.repository !== "boolean" || !Array.isArray(wire.commits)) return null;
  for (const c of wire.commits) {
    if (!isRecord(c) || typeof c.hash !== "string" || typeof c.message !== "string") return null;
  }
  return wire as unknown as CustodyHistoryWire;
}

// ── Parcel language (measured, plain) ──────────────────────────────────────

/** Cap for the suggested save message derived from the request's words. */
export const SUGGESTION_CAP = 72;

/**
 * The suggested save message for a parcel: the producing turn's OWN words
 * (first line, capped), labeled as quoted — or an empty suggestion when the
 * parcel has none to quote (§7.2: derived from the turn's words, never
 * invented).
 */
export function suggestedMessage(
  attribution: ParcelAttributionWire,
): Readonly<{ text: string; fromRequest: boolean }> {
  if (attribution.kind !== "conversation" || attribution.requestText === null) {
    return Object.freeze({ text: "", fromRequest: false });
  }
  const firstLine = attribution.requestText.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return Object.freeze({ text: "", fromRequest: false });
  const text = firstLine.length > SUGGESTION_CAP ? `${firstLine.slice(0, SUGGESTION_CAP - 1)}…` : firstLine;
  return Object.freeze({ text, fromRequest: true });
}

/** Parcel header words: the producing conversation, or the honest bucket. */
export function parcelTitle(attribution: ParcelAttributionWire): string {
  if (attribution.kind === "outside") return "not from a recorded conversation";
  const turn = attribution.turn !== null ? ` · turn ${attribution.turn}` : "";
  return `from “${attribution.chatTitle}”${turn}`;
}

/** ± counts as text; absent counts are stated, never zero-filled. */
export function countsLine(insertions: number | null, deletions: number | null): string {
  if (insertions === null || deletions === null) return "";
  return `+${insertions} −${deletions}`;
}

/**
 * File states with NO earlier saved version at that path, so undo has
 * nothing to return them to and the server refuses them. `new` was always
 * here; `moved` joined it once the room started addressing a move by its
 * destination — the last save holds no file at the destination either, and
 * offering a verb the server will refuse is a false affordance.
 */
export const UNRESTORABLE_STATES: ReadonlySet<string> = new Set(["new", "moved"]);

/** Files in a parcel that CAN be undone (the surface never offers a verb
 * the server would refuse — see UNRESTORABLE_STATES). */
export function undoableFiles(parcel: ParcelWire): readonly CustodyFileWire[] {
  return parcel.files.filter((f) => !UNRESTORABLE_STATES.has(f.state));
}

/**
 * The honest sentence for a file whose "see what changed" came back with an
 * EMPTY patch. The old wording was a single unconditional claim — "the file
 * matches its last saved state" — which is false for the two states that
 * have no last saved state to match. What is true depends on the state the
 * room already measured, so the room passes it down.
 */
export function emptyPatchLine(state: string | undefined): string {
  if (state === "new") {
    return "nothing to compare — this file has never been saved, so there is no earlier version to show it against";
  }
  if (state === "moved") {
    return "nothing to compare — this file was moved here, so the last save holds no file at this path";
  }
  return "no difference to show — the file matches its last saved state";
}

/**
 * The measured-loss sentence an undo confirmation must state (§7.2):
 * exact ±counts summed over the files that would be restored.
 */
export function lossLine(files: readonly CustodyFileWire[]): string {
  let ins = 0;
  let del = 0;
  for (const f of files) {
    ins += f.insertions ?? 0;
    del += f.deletions ?? 0;
  }
  const n = files.length;
  return `returns +${ins} −${del} across ${n} file${n === 1 ? "" : "s"} to the last saved state`;
}

// ── The destructive verb's shield ──────────────────────────────────────────

/**
 * Everything the armed-undo confirmation knows about how it was reached.
 * Plain numbers so the rule below is pure — no clock, no DOM, no component.
 */
export type UndoReach = Readonly<{
  /** When the confirmation was armed (ms), or null when nothing is armed. */
  armedAt: number | null;
  /** When a pointer or keyboard focus last ARRIVED on the confirm control
   * (ms), or null if it never has. */
  reachedAt: number | null;
  /** The instant being judged (ms). */
  now: number;
}>;

/** Why a confirmation is not pressable — the sentence the surface shows,
 * or null when it IS pressable. Stated, never silent: a control that
 * refuses without saying so reads as broken. */
export function undoConfirmBlockReason(reach: UndoReach): string | null {
  const { armedAt, reachedAt, now } = reach;
  if (armedAt === null) return "nothing is armed";
  if (now - armedAt > UNDO_CONFIRM_WINDOW_MS) {
    return "this confirmation timed out — press undo again if you still want it";
  }
  // The two conditions below are ONE rule: the press must be a deliberate
  // arrival at THIS control, made after the control existed long enough for
  // any click already travelling toward the old contents of this spot to
  // have landed. A control that appears under a stationary pointer reports
  // an arrival at ~armedAt, which is exactly what this refuses.
  if (reachedAt === null || reachedAt - armedAt < UNDO_CONFIRM_SETTLE_MS) {
    return "move onto this button to confirm — a stray click cannot discard your work";
  }
  return null;
}

/** Whether the armed undo may execute. */
export function undoConfirmReady(reach: UndoReach): boolean {
  return undoConfirmBlockReason(reach) === null;
}

// ── Diff arithmetic (shared by the room's diff sheet) ──────────────────────

/** First-hunk preview cap (micro-diff, §3.2 — same bound the flow uses). */
export const DIFF_PREVIEW_LINES = 12;

/** Count a unified diff's real ± lines and slice its first hunk. */
export function countPatch(patch: string): Readonly<{ added: number; removed: number; firstHunk: string }> {
  let added = 0;
  let removed = 0;
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  const start = lines.findIndex((l) => l.startsWith("@@"));
  let firstHunk = "";
  if (start !== -1) {
    const rest = lines.slice(start);
    const next = rest.slice(1).findIndex((l) => l.startsWith("@@"));
    const hunk = next === -1 ? rest : rest.slice(0, next + 1);
    firstHunk = hunk.slice(0, DIFF_PREVIEW_LINES).join("\n");
  }
  return Object.freeze({ added, removed, firstHunk });
}

// ── The Switch reel badge (real counts from the same read) ─────────────────

/**
 * Changed-file counts per conversation, from a decoded custody state: only
 * files ATTRIBUTED to a conversation count toward its badge (the outside
 * bucket belongs to no reel — a badge from it would fabricate custody).
 */
export function custodyCountsByChat(state: CustodyStateWire): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const parcel of state.parcels) {
    if (parcel.attribution.kind !== "conversation") continue;
    const chatId = parcel.attribution.chatId;
    counts[chatId] = (counts[chatId] ?? 0) + parcel.files.length;
  }
  return counts;
}
