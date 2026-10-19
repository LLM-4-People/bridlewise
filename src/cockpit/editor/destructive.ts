/**
 * THE DELETE SHIELD — the rule a destructive verb must pass before it fires.
 *
 * Deleting a file MOVES it to the harness recycle bin — restore puts the
 * bytes back. The shield still stands: a dialog is one `onclick` away from
 * being bypassed, so three independent conditions must ALL hold before the
 * move fires.
 *
 * THE USER'S STANDING COMPLAINT: stray clicks opening things they did not ask
 * for. A confirmation that appears under a stationary pointer and can be
 * pressed immediately is not a confirmation — the second half of a double
 * click, or a click already travelling toward whatever used to be at that
 * spot, lands on it. So three independent conditions must ALL hold:
 *
 *   1. ARMED — the user pressed `delete` on this exact file, and recently.
 *      The arming carries the file's path, so arming on one file and
 *      confirming on another is not a state this rule can be in.
 *   2. REACHED — a pointer or keyboard focus ARRIVED on the confirm control
 *      after it had existed for a settling interval. A control that appears
 *      under a stationary pointer reports an arrival at ~armedAt, which is
 *      exactly what this refuses.
 *   3. NAMED — the user typed the file's own name. This is the condition that
 *      cannot be satisfied by any accident: no sequence of clicks types a
 *      word. It is also what makes the confirmation state WHICH file is about
 *      to be destroyed in the only way that proves the user read it.
 *
 * Pure: no clock, no DOM, no component. The instant being judged is passed in,
 * so every branch is drivable from a Node test — and is (with mutations).
 *
 * The armed/settle half is deliberately the SAME shape the custody room's undo
 * uses (`rooms/custody-data.ts::undoConfirmBlockReason`), and its two windows
 * are re-declared here for this room's own thresholds rather than reaching
 * across rooms for constants that mean something else.
 */

import { DELETE_CONFIRM_SETTLE_MS, DELETE_CONFIRM_WINDOW_MS } from "./editor-config.ts";

/** What the room armed, and when. `null` when nothing is armed. */
export type DeleteArm = Readonly<{
  /** The absolute path armed — the delete may target no other. */
  path: string;
  /** The file's own name, as the confirmation must be given it. */
  name: string;
  /** Whether the target is a folder (its sentence differs, and so does its
   * consequence — a folder takes everything under it). */
  isDirectory: boolean;
  /** When arming happened (ms). */
  armedAt: number;
}>;

/** Everything the rule judges. Plain numbers and strings only. */
export type DeleteReach = Readonly<{
  arm: DeleteArm | null;
  /** When a pointer or keyboard focus last ARRIVED on the confirm control
   * (ms), or null if it never has. */
  reachedAt: number | null;
  /** What the user typed into the naming field. */
  typedName: string;
  /** The instant being judged (ms). */
  now: number;
  /** The path the caller is about to delete. Compared against the ARM, so a
   * confirmation cannot be redirected at another file between arming and
   * firing. */
  targetPath: string;
}>;

/**
 * Why the delete may not fire — the sentence the room shows — or `null` when
 * it may. STATED, never silent: a control that refuses without saying so
 * reads as broken, and the user tries harder.
 */
export function deleteBlockReason(reach: DeleteReach): string | null {
  const { arm, reachedAt, typedName, now, targetPath } = reach;
  if (arm === null) return "nothing is armed for deletion";
  if (arm.path !== targetPath) {
    return "this confirmation was armed for a different file — press delete on the file you mean";
  }
  if (now - arm.armedAt > DELETE_CONFIRM_WINDOW_MS) {
    return "this confirmation timed out — press delete again if you still want it";
  }
  // ONE rule in two conditions: the press must be a deliberate arrival at THIS
  // control, made after the control had existed long enough for any click
  // already travelling toward the old contents of this spot to have landed.
  if (reachedAt === null || reachedAt - arm.armedAt < DELETE_CONFIRM_SETTLE_MS) {
    return "move onto this button to confirm — a stray click cannot delete a file";
  }
  if (typedName !== arm.name) {
    return `type the name “${arm.name}” to confirm — it moves to the recycle bin`;
  }
  return null;
}

/** Whether the armed delete may execute. */
export function deleteReady(reach: DeleteReach): boolean {
  return deleteBlockReason(reach) === null;
}

/**
 * The measured-loss sentence the confirmation must state.
 *
 * A folder's cost is stated as unbounded on purpose: the room has not walked
 * it, so it does not know how many files are under it, and a number it has not
 * counted would be exactly the fabrication this product refuses. What it CAN
 * say truthfully is that everything inside goes.
 */
export function deleteLossLine(arm: DeleteArm, size: number | null): string {
  if (arm.isDirectory) {
    return `moves “${arm.name}” and everything inside it to the recycle bin — restore from there`;
  }
  const measured = size === null ? "" : ` (${size.toLocaleString("en-US")} bytes)`;
  return `moves the file “${arm.name}”${measured} to the recycle bin — restore from there`;
}
