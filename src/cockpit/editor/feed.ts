/**
 * EDITOR — the doors to the server, and the honest states on this side of
 * them.
 *
 * One module owns every call this room makes, so the surfaces below it never
 * touch the network and every failure becomes a SENTENCE rather than an
 * exception on the way through. A refused or failed read renders as an absence
 * in plain words — never a spinner that never ends, never a fabricated empty
 * file.
 *
 * The doors are INJECTABLE (`setEditorReaders`) so the whole state machine is
 * node-testable without a network; production goes through `src/client.ts`,
 * the single owner of `fetch` in the web slice.
 *
 * WHERE THE WRITES GO, AND WHY THAT IS THE WHOLE RECORDING STORY. Every
 * mutating door here maps to a route that reaches disk through
 * `server/editor-bridge.ts`, the single in-process owner of file
 * write/mkdir/delete — and the bridge records the effect AT the mutation
 * (`recordFileEffect`). So a save, a create and a delete made from this room
 * land in the ledger, the timeline and custody for the same reason an agent's
 * edit does: not because this module remembered to say so, but because there
 * is no way to write a file that does not pass the recorder. Guarded by
 * tests/cockpit/editor-recording-owner.test.ts.
 */

import {
  createEditorFile,
  createEditorFolder,
  deleteEditorFile,
  editEditorFile,
  getFileTree,
  probeEditorFile,
  readEditorFile,
  readEditorMedia,
} from "../../client.ts";
import { absenceReason, UNREADABLE_SHAPE } from "../../data/absence.ts";
import type { PendingSave } from "./buffer.ts";
import { TREE_ENTRY_LIMIT } from "./editor-config.ts";
import { decodeMedia, decodeProbe, type FileProbe, type MediaWire } from "./file-kind.ts";
import { decodeTree, type DirLoad } from "./tree.ts";

// ── The doors ─────────────────────────────────────────────────────────────

export type EditorReaders = Readonly<{
  tree: (projectPath: string, dir: string) => Promise<unknown>;
  probe: (path: string, root: string) => Promise<unknown>;
  read: (path: string, root: string) => Promise<unknown>;
  media: (path: string, root: string) => Promise<unknown>;
  /** The PREIMAGE-CHECKED write. There is deliberately no unchecked one. */
  write: (save: PendingSave) => Promise<unknown>;
  createFile: (path: string, root: string) => Promise<unknown>;
  createFolder: (path: string, root: string) => Promise<unknown>;
  remove: (path: string, root: string) => Promise<unknown>;
}>;

const LIVE_READERS: EditorReaders = {
  tree: (projectPath, dir) =>
    getFileTree(projectPath, undefined, TREE_ENTRY_LIMIT, dir.length > 0 ? { dir } : { dir: "." }),
  probe: (path, root) => probeEditorFile(path, root),
  read: (path, root) => readEditorFile(path, root),
  media: (path, root) => readEditorMedia(path, root),
  // The one write door: `edit` carries the preimage the draft was written
  // against, so a file that changed underneath is REFUSED rather than
  // clobbered. `writeEditorFile` (unchecked) is intentionally not wired here.
  write: (save) => editEditorFile(save.apiPath, save.preimage, save.content, save.projectPath),
  createFile: (path, root) => createEditorFile(path, "", root),
  createFolder: (path, root) => createEditorFolder(path, root),
  remove: (path, root) => deleteEditorFile(path, root),
};

let readers: EditorReaders = LIVE_READERS;

/** Test seam. Returns the previous readers so a test can restore them. */
export function setEditorReaders(next: Partial<EditorReaders>): EditorReaders {
  const prev = readers;
  readers = { ...readers, ...next };
  return prev;
}

// ── Reads, each ending in a measured value or a sentence ──────────────────

/**
 * WHY THERE IS NOTHING HERE — said about a FILE.
 *
 * The shared owner (`src/data/absence.ts`) answers in the vocabulary of the
 * ledger, and it says so: "this is the default, not a ceiling". Two of its
 * answers are wrong here in the strong sense — they are true sentences about
 * the wrong subject. A 404 on a file read becomes "no recorded history", which
 * this room rendered as `this file — no recorded history`: a sentence about
 * the event log, shown about a file on a disk, that tells the reader nothing
 * they can act on and quietly suggests the wrong cause. Observed in the browser
 * while the API was restarting.
 *
 * Everything the shared owner has no special answer for still falls through to
 * it, so there is still exactly one place a NEW absence wording is decided.
 */
export function fileAbsenceReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (code === "file_not_found" || code === "not_a_file") {
    return "there is nothing at this path on disk";
  }
  if (code === "file_too_large") {
    return "it is past the size this server will send in one read";
  }
  if (status === 404) {
    return "the server has nothing to answer with at that path";
  }
  return absenceReason(err);
}

/**
 * One directory's children.
 *
 * `dir` is the path RELATIVE to the project root; `""` is the root itself
 * (the route wants `"."` for that, which the live door supplies).
 */
export async function loadDir(projectPath: string, dir: string): Promise<DirLoad> {
  try {
    const wire = await readers.tree(projectPath, dir);
    const decoded = decodeTree(wire);
    if (decoded === null) return { kind: "absent", reason: UNREADABLE_SHAPE };
    return {
      kind: "read",
      entries: decoded.entries,
      truncated: decoded.entries.length >= TREE_ENTRY_LIMIT,
    };
  } catch (err) {
    return { kind: "absent", reason: fileAbsenceReason(err) };
  }
}

export type ProbeLoad =
  | Readonly<{ kind: "measured"; probe: FileProbe }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** What is at a path, without decoding it (size, text-or-not, image-or-not). */
export async function probePath(path: string, root: string): Promise<ProbeLoad> {
  try {
    const decoded = decodeProbe(await readers.probe(path, root));
    if (decoded === null) return { kind: "absent", reason: UNREADABLE_SHAPE };
    return { kind: "measured", probe: decoded };
  } catch (err) {
    return { kind: "absent", reason: fileAbsenceReason(err) };
  }
}

export type TextLoad =
  | Readonly<{
      kind: "read";
      path: string;
      relativePath: string;
      content: string;
      size: number;
      lineCount: number;
      language: string;
      /** The server sent only the first `size` bytes it is configured to
       * send. Stated on screen; never hidden. */
      truncated: boolean;
    }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** A text file's content. */
export async function readText(path: string, root: string): Promise<TextLoad> {
  try {
    const wire = await readers.read(path, root);
    if (wire === null || typeof wire !== "object") {
      return { kind: "absent", reason: UNREADABLE_SHAPE };
    }
    const w = wire as Record<string, unknown>;
    if (
      typeof w.path !== "string" ||
      typeof w.content !== "string" ||
      typeof w.size !== "number" ||
      typeof w.truncated !== "boolean"
    ) {
      return { kind: "absent", reason: UNREADABLE_SHAPE };
    }
    return {
      kind: "read",
      path: w.path,
      relativePath: typeof w.relativePath === "string" ? w.relativePath : w.path,
      content: w.content,
      size: w.size,
      lineCount: typeof w.lineCount === "number" ? w.lineCount : w.content.split("\n").length,
      language: typeof w.language === "string" ? w.language : "text",
      truncated: w.truncated,
    };
  } catch (err) {
    return { kind: "absent", reason: fileAbsenceReason(err) };
  }
}

export type MediaLoad =
  | Readonly<{ kind: "read"; media: MediaWire }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** An image file's bytes, as a data URL. */
export async function readMedia(path: string, root: string): Promise<MediaLoad> {
  try {
    const decoded = decodeMedia(await readers.media(path, root));
    if (decoded === null) return { kind: "absent", reason: UNREADABLE_SHAPE };
    return { kind: "read", media: decoded };
  } catch (err) {
    return { kind: "absent", reason: fileAbsenceReason(err) };
  }
}

// ── Writes (all recorded at the bridge — see the header) ──────────────────

export type ActOutcome =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Turn a thrown client error into the sentence the room shows. */
function refusal(err: unknown): ActOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "already_exists") {
    return { kind: "refused", reason: "something already exists at that name — nothing was created" };
  }
  if (code === "parent_not_found") {
    return { kind: "refused", reason: "the folder it would go in does not exist — nothing was created" };
  }
  if (code === "cannot_delete_root") {
    return { kind: "refused", reason: "this is the project's own folder — it cannot be deleted from here" };
  }
  if (code === "file_not_found") {
    return { kind: "refused", reason: "there is nothing at that path any more — nothing was deleted" };
  }
  return { kind: "refused", reason: absenceReason(err) };
}

export async function createFileAt(path: string, root: string): Promise<ActOutcome> {
  try {
    await readers.createFile(path, root);
    return { kind: "done" };
  } catch (err) {
    return refusal(err);
  }
}

export async function createFolderAt(path: string, root: string): Promise<ActOutcome> {
  try {
    await readers.createFolder(path, root);
    return { kind: "done" };
  } catch (err) {
    return refusal(err);
  }
}

export async function removePath(path: string, root: string): Promise<ActOutcome> {
  try {
    await readers.remove(path, root);
    return { kind: "done" };
  } catch (err) {
    return refusal(err);
  }
}

/** The write door, for the save path (`save.ts` owns the outcome logic). */
export function saveWriter(save: PendingSave): Promise<unknown> {
  return readers.write(save);
}
