/**
 * THE EDITOR BUFFER — the single owner of "which file is open" and "the
 * unsaved edit in progress", and the reason an edit in this room cannot be
 * lost.
 *
 * ── THE DEFECT THIS SHAPE REMOVES ─────────────────────────────────────────
 *
 * The harness has already lost a user's work twice in an editor, and both
 * failures were shape failures rather than missing-check failures:
 *
 *   1. A project-switch effect ran `selectedFile = null; editedContent = ""`
 *      unconditionally. Anything holding the component could clear the buffer
 *      with a plain assignment, and something did. A `confirm()` on that line
 *      would have fixed THAT line and left the shape intact — the next code
 *      path that clears the buffer starts out unguarded again.
 *
 *   2. Save re-derived the file's path by searching the tree entries. The tree
 *      is loaded lazily and a reload resets it to the root level, so a NESTED
 *      file's entry disappeared after the first save; the lookup returned
 *      `undefined` and the whole save was skipped inside an `if` — no write,
 *      no error, no feedback.
 *
 * So this module is built so neither is expressible:
 *
 *   A. The state lives in a module-private atom. What is exported is a frozen
 *      read facade with no `.set` AT RUNTIME — not a type that omits one,
 *      which a cast defeats. No component can assign to the buffer at all.
 *
 *   B. Every mutator that can take the buffer away from a live draft
 *      (`openBufferFile`, `closeBufferFile`, `endBufferEdit`) REQUIRES a
 *      `PendingWork` argument. It has no default, so a caller cannot reach the
 *      destructive operation without stating what happens to the unsaved text.
 *      Omitting it is a compile error, not a review comment.
 *
 *   C. `"park"` destroys nothing. The draft moves to the parked map keyed by
 *      (user, project, path) and comes back when that file is reopened. So
 *      navigation — clicking another file, closing the room, switching
 *      workspace — is not a data-loss operation at all and needs no dialog:
 *      the honest answer to "what about my unsaved work" is "it is still
 *      here". `"discard"` is the only value that drops content and it is
 *      reachable only where the user's act IS the decision to drop it.
 *
 *   D. The save path carries the path CAPTURED AT OPEN (`PendingSave.apiPath`)
 *      and the preimage the draft was written against. Nothing looks a path up
 *      again, so there is no lookup left to return the wrong file.
 *
 * ── WHAT IS NEW HERE, AND WHY ─────────────────────────────────────────────
 *
 * The prior module documented one boundary it could not cross: drafts did NOT
 * survive a page reload, and a `beforeunload` warning was the only cover. That
 * is the one navigation path the user cannot be talked out of — a reload, a
 * crashed tab, a closed window — so this buffer WRITES THROUGH to local
 * storage on every change and restores on load. A restored draft comes back
 * parked, which is exactly where a draft belongs when no file is open yet, and
 * the room states how many are waiting.
 *
 * The write-through is keyed by USERNAME, so signing in as someone else does
 * not read the previous person's text off the disk — and signing out PARKS the
 * live draft rather than clearing it, because a sign-out is not a decision to
 * throw away an edit either.
 *
 * ── WHY THE PREIMAGE TRAVELS WITH THE DRAFT ───────────────────────────────
 *
 * `base` is the on-disk content the buffer was opened against, and it is what
 * the save sends as its preimage. A parked draft carries its OWN base, so a
 * draft written against yesterday's bytes can never be applied to a file that
 * changed since: the server's preimage check rejects it (`preimage_mismatch`)
 * instead of silently overwriting someone else's work. Refreshing the base
 * from disk for an old draft would turn a rejected save into a clobbered file.
 */

import { atom } from "nanostores";

import { authState } from "../../state/auth.ts";
import { persistGet, persistSet } from "../../state/persistence.ts";
import { registerReset } from "../../state/store-registry.ts";
import { DRAFT_FLUSH_MS } from "./editor-config.ts";

/** The file the editor has open, as captured AT OPEN TIME. */
export type OpenFile = Readonly<{
  /** The project this file belongs to — part of the parked-draft identity. */
  projectId: string;
  /** The project root the file is addressed against (the `root` on the wire). */
  projectPath: string;
  /**
   * The path the editor API is called with, captured when the file was opened.
   *
   * ABSOLUTE, and never re-derived. Save must not look this up in the tree:
   * the tree is lazily loaded and a reload resets it to the root level, so a
   * nested file's entry vanishes and the lookup returns nothing. Holding the
   * path we already had removes the failure mode instead of guarding it.
   */
  apiPath: string;
  /** Path relative to the project root — the display name and tree identity. */
  relativePath: string;
  /** The file's own name (the word a delete confirmation must be given). */
  name: string;
  language: string;
  size: number;
}>;

/** The whole buffer, as one immutable value. */
export type EditorBufferState = Readonly<{
  /** `null` when no file is open. */
  file: OpenFile | null;
  /** The on-disk content the buffer was opened against — and the preimage. */
  base: string;
  /** `null` when viewing; a string when an edit is in progress. */
  draft: string | null;
  /**
   * The live draft came back from a park, so `base` may predate the file on
   * disk and a save may be legitimately refused. Surfaced in the room so a
   * restored draft is never mistaken for a fresh read.
   */
  restored: boolean;
}>;

/**
 * What must happen to an unsaved draft before the buffer may be replaced.
 *
 * - `"park"` — keep it; it returns when this file is reopened. Correct for
 *   every navigation path, because navigation is not a decision to destroy.
 * - `"discard"` — drop it. Only where the user's action IS that decision.
 */
export type PendingWork = "park" | "discard";

const EMPTY: EditorBufferState = Object.freeze({
  file: null,
  base: "",
  draft: null,
  restored: false,
});

/**
 * THE buffer. Module-private on purpose: this binding is the only thing in the
 * program that can write it, and it is not exported.
 */
const buffer = atom<EditorBufferState>(EMPTY);

/**
 * The read handle every consumer uses.
 *
 * A hand-built facade rather than the atom (or a `computed` over it), because
 * both carry a `.set` AT RUNTIME: a `ReadableAtom` type that omits the setter
 * is a claim one `as never` defeats. This object genuinely has none, so "the
 * buffer cannot be written from outside" is a property of the program rather
 * than of its annotations. It satisfies the store contract Svelte's
 * `$fileBuffer` needs.
 */
export type EditorBufferHandle = Readonly<{
  get(): EditorBufferState;
  subscribe(listener: (value: EditorBufferState) => void): () => void;
}>;

export const fileBuffer: EditorBufferHandle = Object.freeze({
  get: () => buffer.get(),
  subscribe: (listener: (value: EditorBufferState) => void) => buffer.subscribe(listener),
});

// ── Parked drafts ─────────────────────────────────────────────────────────

/** A draft kept aside, with the base it was written against. */
export type ParkedDraft = Readonly<{
  /** The file it belongs to, so the room can offer it back by name. */
  file: OpenFile;
  base: string;
  draft: string;
  /** When it was last written to (epoch ms) — stated, never guessed. */
  at: number;
}>;

/**
 * Parked drafts, keyed by (user, project, path).
 *
 * The user is in the key because this module outlives a sign-out: the app
 * resets its stores rather than reloading, so without it a parked draft could
 * be restored into the next person's session if they opened the same path.
 * Keying it out is cheaper than remembering to clear it — and clearing it
 * would be another unconditional destroy path.
 */
const parked = new Map<string, ParkedDraft>();

/** NUL cannot appear in a username or a path, so two different triples can
 * never collide into one key the way a space or a slash could. */
const DRAFT_KEY_SEPARATOR = "\u0000";

function draftKey(file: OpenFile): string {
  return [currentUser(), file.projectId, file.apiPath].join(DRAFT_KEY_SEPARATOR);
}

function currentUser(): string {
  return authState.get().username;
}

// ── The write-through (what makes a reload survivable) ────────────────────

/** The storage slot for one user's drafts. */
function storageKey(user: string): string {
  return `cockpit-editor-drafts:${user}`;
}

/** The user whose drafts are currently in memory (null = nothing loaded). */
let loadedFor: string | null = null;

type WireDraft = Readonly<{ file: OpenFile; base: string; draft: string; at: number }>;

function isWireDraft(v: unknown): v is WireDraft {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  if (typeof d.base !== "string" || typeof d.draft !== "string") return false;
  if (typeof d.at !== "number") return false;
  const f = d.file;
  if (f === null || typeof f !== "object") return false;
  const file = f as Record<string, unknown>;
  return (
    typeof file.projectId === "string" &&
    typeof file.projectPath === "string" &&
    typeof file.apiPath === "string" &&
    typeof file.relativePath === "string" &&
    typeof file.name === "string" &&
    typeof file.language === "string" &&
    typeof file.size === "number"
  );
}

/**
 * Load this user's drafts if they are not already in memory.
 *
 * Called at the top of every exported entry point, because the username
 * arrives asynchronously at boot: a module-load-time read would run before
 * anyone is signed in and would find nothing, forever. A DECODE failure drops
 * that entry and keeps the rest — a half-parsed draft is content we cannot
 * vouch for, and restoring it would be fabricating the user's own text.
 */
function ensureLoaded(): void {
  const user = currentUser();
  if (user === loadedFor) return;
  loadedFor = user;
  parked.clear();
  if (user.length === 0) return;
  const raw = persistGet(storageKey(user));
  if (raw === null) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(decoded)) return;
  for (const entry of decoded) {
    if (!isWireDraft(entry)) continue;
    parked.set(draftKey(entry.file), entry);
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDue = false;
let flushSuppressedUntil = 0;

/** Serialize what is held right now: the parked map PLUS the live draft.
 *
 * The live draft is written into the SAME list, under its own key, because a
 * reload has no "live" to come back to — the honest restored form of an edit
 * in progress is a parked draft waiting for its file to be reopened. */
function flushNow(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDue = false;
  const user = currentUser();
  if (user.length === 0) return;
  const entries: WireDraft[] = [...parked.values()];
  const state = buffer.get();
  if (state.file !== null && state.draft !== null && state.draft !== state.base) {
    const key = draftKey(state.file);
    const live: WireDraft = { file: state.file, base: state.base, draft: state.draft, at: Date.now() };
    const at = entries.findIndex((e) => draftKey(e.file) === key);
    if (at === -1) entries.push(live);
    else entries[at] = live;
  }
  persistSet(storageKey(user), entries.length === 0 ? null : JSON.stringify(entries));
  flushSuppressedUntil = Date.now() + DRAFT_FLUSH_MS;
}

/**
 * Persist, leading-edge: the first change after a quiet period is written
 * immediately, and a trailing write always follows a burst. Typing therefore
 * costs one storage write per `DRAFT_FLUSH_MS` instead of one per keystroke,
 * and the exposure of an unexpected process death is bounded by that window.
 */
function scheduleFlush(): void {
  const now = Date.now();
  if (now >= flushSuppressedUntil) {
    flushNow();
    return;
  }
  if (flushDue) return;
  flushDue = true;
  flushTimer = setTimeout(flushNow, Math.max(0, flushSuppressedUntil - now));
}

/**
 * A DELIBERATE exit — a reload, a closed tab, a navigation away — flushes
 * first, so the one navigation path the user cannot be talked out of loses
 * nothing at all. `pagehide` fires where `beforeunload` is unreliable (mobile,
 * bfcache) and both are cheap, so both are held.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushNow);
  window.addEventListener("beforeunload", flushNow);
}

/** Force the write-through now (tests, and the exit handlers above). */
export function flushEditorDrafts(): void {
  flushNow();
}

// ── Queries ───────────────────────────────────────────────────────────────

/** True when the buffer holds an edit that is not on disk. */
export function bufferIsDirty(state: EditorBufferState): boolean {
  return state.draft !== null && state.draft !== state.base;
}

/**
 * Everything a save needs, or `null` when there is nothing to save.
 *
 * `preimage` is REQUIRED, so "the file was empty" (`""`) and "there is nothing
 * to save" (`null`) are different values of different types rather than two
 * readings of one falsy string. The prior editor conflated them — `if
 * (content.length > 0) edit(…) else write(…)` treated an empty file as "no
 * preimage" and fell through to the UNCHECKED writer, so saving a file that
 * was empty when it was opened silently overwrote whatever had been written to
 * it since. Carried as data, there is no branch left to get wrong.
 */
export type PendingSave = Readonly<{
  /** The path captured AT OPEN. Never looked up again. */
  apiPath: string;
  /** The project root the path is addressed against. */
  projectPath: string;
  /** The content the draft was written against. `""` is a real preimage. */
  preimage: string;
  /** The text to write. */
  content: string;
}>;

/** The save the buffer is currently holding, or `null` if it holds none. */
export function bufferPendingSave(state: EditorBufferState): PendingSave | null {
  if (state.file === null || state.draft === null) return null;
  return {
    apiPath: state.file.apiPath,
    projectPath: state.file.projectPath,
    preimage: state.base,
    content: state.draft,
  };
}

/** Every draft kept aside for this user, newest first. The room lists them so
 * a restored edit is discoverable rather than merely present. */
export function parkedDrafts(): readonly ParkedDraft[] {
  ensureLoaded();
  return [...parked.values()].sort((a, b) => b.at - a.at);
}

/** Parked-draft keys as the tree consumes them: `projectId\0apiPath`. */
export function parkedPaths(): ReadonlySet<string> {
  ensureLoaded();
  const out = new Set<string>();
  for (const entry of parked.values()) {
    out.add(`${entry.file.projectId}${DRAFT_KEY_SEPARATOR}${entry.file.apiPath}`);
  }
  return out;
}

// ── Mutators ──────────────────────────────────────────────────────────────

/**
 * Resolve the unsaved work in the buffer.
 *
 * The ONLY code that may take the buffer away from a live draft, and it cannot
 * run without being told what happens to that draft. Every exported mutator
 * that replaces or clears the buffer calls this first; there is no second
 * path.
 */
function resolveUnsaved(pending: PendingWork): void {
  const state = buffer.get();
  if (state.file === null || !bufferIsDirty(state)) return;
  if (pending === "park") {
    parked.set(draftKey(state.file), {
      file: state.file,
      base: state.base,
      draft: state.draft!,
      at: Date.now(),
    });
    return;
  }
  // "discard": the caller carries an explicit decision to destroy this edit,
  // so any older park for the same file goes with it — otherwise a discarded
  // edit would reappear the next time the file was opened.
  parked.delete(draftKey(state.file));
}

/**
 * Open `file` (whose current on-disk content is `content`), after resolving
 * whatever is unsaved in the buffer right now.
 *
 * A parked draft for this exact file is restored along with the base it was
 * written against, and the buffer comes back IN EDIT MODE so the user sees the
 * work rather than having to guess it survived.
 */
/*
 * No write-through here on purpose. Opening a file never CHANGES the set of
 * drafts that exist — parking the previous one and restoring this one both
 * move a draft between the live slot and the parked map, and the persisted
 * form holds both under the same key. Flushing anyway would start the
 * coalescing window and delay the FIRST keystroke of the edit that follows,
 * which is exactly the one an unexpected death is most likely to take.
 */
export function openBufferFile(file: OpenFile, content: string, pending: PendingWork): void {
  ensureLoaded();
  resolveUnsaved(pending);
  const restored = parked.get(draftKey(file));
  if (restored !== undefined) {
    // It is LIVE now, so it leaves the parked map — otherwise the same edit
    // would be listed as "waiting" while it is on screen, and a reader would
    // reasonably conclude there were two. Nothing is at risk in the move: the
    // write-through persists the live draft under the same key, and any exit
    // from this buffer parks it again.
    parked.delete(draftKey(file));
    buffer.set({ file, base: restored.base, draft: restored.draft, restored: true });
    return;
  }
  buffer.set({ file, base: content, draft: null, restored: false });
}

/**
 * Close whatever is open (the room closing, a workspace switch, the open file
 * being deleted, a failed read), after resolving whatever is unsaved.
 */
export function closeBufferFile(pending: PendingWork): void {
  ensureLoaded();
  resolveUnsaved(pending);
  buffer.set(EMPTY);
  flushNow();
}

/** Start editing the open file. Cannot lose work: it only adds a draft. */
export function beginBufferEdit(): void {
  ensureLoaded();
  const state = buffer.get();
  if (state.file === null || state.draft !== null) return;
  buffer.set({ ...state, draft: state.base, restored: false });
}

/** Record what the user has typed. Cannot lose work: it only moves it on. */
export function setBufferDraft(text: string): void {
  const state = buffer.get();
  if (state.draft === null) return;
  buffer.set({ ...state, draft: text });
  scheduleFlush();
}

/**
 * Stop editing, after resolving the draft. Separate from `closeBufferFile`
 * because the file stays open; identical in that it cannot be reached without
 * saying what happens to the unsaved text.
 */
export function endBufferEdit(pending: PendingWork): void {
  ensureLoaded();
  resolveUnsaved(pending);
  const state = buffer.get();
  buffer.set({ ...state, draft: null, restored: false });
  flushNow();
}

/**
 * The draft is now on disk: it becomes the new base. The edit SESSION stays
 * live — the pane the user is typing into is still in edit mode, so the
 * buffer keeps `draft === base` (nothing unsaved, every keystroke still
 * registers) rather than going draft-less underneath a live textarea.
 *
 * Retiring the draft here was the silent data-entry loss: `setBufferDraft`
 * answers null with "no session", so every keystroke after a save changed
 * the DOM and registered nothing — no chip, no save, and on reload the text
 * was gone. A session the screen still shows cannot be retired by the save
 * that satisfied it; only leaving edit mode (`endBufferEdit`, the revert
 * verb) ends a session.
 */
export function markBufferSaved(content: string): void {
  ensureLoaded();
  const state = buffer.get();
  if (state.file !== null) parked.delete(draftKey(state.file));
  buffer.set({ ...state, base: content, draft: content, restored: false });
  flushNow();
}

/**
 * Throw away a PARKED draft. The one explicit destroy path for work that is
 * not on screen, so the room can offer "discard" beside the draft it names —
 * a draft you can see the name of and cannot get rid of is its own defect.
 */
export function discardParkedDraft(file: OpenFile): void {
  ensureLoaded();
  parked.delete(draftKey(file));
  flushNow();
}

/**
 * SIGN-OUT PARKS, IT DOES NOT DISCARD.
 *
 * `resetAllStores` runs on sign-out and clears every registered store. A reset
 * that dropped the live draft would be exactly the unconditional destroy path
 * this module exists to make unexpressible — so the reset resolves it as
 * `"park"`, flushes it under the OUTGOING user's key, and only then clears.
 * The next sign-in as that same person finds the work waiting.
 */
export function resetEditorBuffer(): void {
  resolveUnsaved("park");
  flushNow();
  buffer.set(EMPTY);
  parked.clear();
  loadedFor = null;
}

registerReset("cockpit-editor-buffer", resetEditorBuffer);

/** Tests only: forget everything in memory WITHOUT writing through, so one
 * test's drafts cannot leak into the next. Never called by the room. */
export function forgetEditorBufferForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDue = false;
  flushSuppressedUntil = 0;
  buffer.set(EMPTY);
  parked.clear();
  loadedFor = null;
}
