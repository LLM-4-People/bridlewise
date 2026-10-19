/**
 * THE RECYCLE CONFIRM — one door for "this press may hide a project or
 * conversation". Trash is recoverable (`trashed_at`); it still needs a
 * second press so a hover-reveal recycle mark cannot fire on the same
 * gesture that found it.
 *
 * SwitchRoom's `binProject` / `binChat` are the only callers — the cap,
 * the reel, and the reel's context menu all land there. A first press
 * arms; a second press of the SAME id after the settle window fires.
 * Escape and a different id re-arm. The rule is pure so a test can
 * press it without the room.
 *
 * THE FACE is this module too: an armed control that still shows the
 * bin is not a confirmation (NN/g: the second chance has to name what
 * will happen). `recycleFace` is the one spelling.
 */
import { VERB_MARK } from "../shell/verb-marks.ts";
import { RECYCLE_CONFIRM_SETTLE_MS, RECYCLE_CONFIRM_WINDOW_MS } from "./switch-config.ts";

/** What an armed recycle control says instead of the bin. */
export const RECYCLE_CONFIRM_FACE = "confirm";

export type RecycleKind = "project" | "chat";

export type RecycleArm = Readonly<{
  kind: RecycleKind;
  id: string;
  name: string;
  armedAt: number;
}>;

export function recycleArmedTitle(name: string): string {
  return `press again to recycle “${name}” — it goes to the recycle bin`;
}

/**
 * THE ARMED FACE. Rest is the bin (or the menu's word). Armed is always
 * the confirmation word, so a second press cannot look like the first.
 */
export function recycleFace(armed: boolean, rest: string = VERB_MARK.recycle): string {
  return armed ? RECYCLE_CONFIRM_FACE : rest;
}

/**
 * One press. Returns whether THIS press may call delete*, and the arm
 * to keep (null after a firing press).
 */
export function takeRecyclePress(
  prev: RecycleArm | null,
  next: Readonly<{ kind: RecycleKind; id: string; name: string }>,
  now: number,
): Readonly<{ arm: RecycleArm | null; fire: boolean }> {
  const armed: RecycleArm = { ...next, armedAt: now };
  if (prev === null || prev.kind !== next.kind || prev.id !== next.id) {
    return { arm: armed, fire: false };
  }
  const elapsed = now - prev.armedAt;
  if (elapsed < RECYCLE_CONFIRM_SETTLE_MS || elapsed > RECYCLE_CONFIRM_WINDOW_MS) {
    return { arm: armed, fire: false };
  }
  return { arm: null, fire: true };
}
