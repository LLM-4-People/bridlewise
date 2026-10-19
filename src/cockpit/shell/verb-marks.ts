/**
 * THE CONTROL MARKS — ok, cancel, add, remove, recycle, restore.
 * One table, every button.
 *
 * FolderPicker's choose already wore ✓ as its whole label. Cancel sat
 * beside it as the word "cancel", and create/save/add restated their own
 * words. Recycle wore a minus, then a recycling-symbol ♲ that people
 * read as packaging, not a bin; restore wore ok's ✓, then a generic
 * undo arrow. The CHARACTERS stay here as the fallback; the PICTURES
 * (trash can / unarchive) are the `.verb.recycle` / `.verb.restore`
 * masks in tokens.css.
 *
 * THE LOWEST CHOKE: this object is the only place the characters are
 * written. Buttons interpolate `VERB_MARK.ok` (etc.). The recipe markers
 * `.verb.ok` / `.verb.cancel` / `.verb.add` / `.verb.remove` /
 * `.verb.recycle` / `.verb.restore` are the look (tokens.css); they do
 * not restate the glyph. A button that is one of these roles and does
 * not consume this table is the defect
 * `tests/cockpit/verb-marks-owner.test.ts` exists to catch.
 *
 * These are CONTROL marks, not beat-state glyphs (`STATE_GLYPH` in
 * beat-state.ts). A succeeded tool call and an OK button happen to share
 * ✓; they are different vocabularies and must not import each other.
 */
export const VERB_MARK = Object.freeze({
  close: "×",
  copy: "⧉",
  edit: "✎",
  more: "⋯",
  ok: "✓",
  cancel: "✕",
  add: "+",
  remove: "−",
  recycle: "♲",
  restore: "↺",
} as const);

export type VerbMarkId = keyof typeof VERB_MARK;

export const VERB_MARK_IDS = Object.keys(VERB_MARK) as readonly VerbMarkId[];

/** Accessible name when the button's visible label is the mark alone. */
export const VERB_MARK_WORD: Readonly<Record<VerbMarkId, string>> = Object.freeze({
  close: "Close",
  copy: "Copy",
  edit: "Edit",
  more: "Actions",
  ok: "Confirm",
  cancel: "Cancel",
  add: "Add",
  remove: "Remove",
  recycle: "Move to bin",
  restore: "Restore",
});
