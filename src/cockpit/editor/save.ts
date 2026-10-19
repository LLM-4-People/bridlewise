/**
 * THE SAVE PATH — and the two things it makes impossible.
 *
 * ── 1. A SAVE THAT WRITES TO THE WRONG FILE ───────────────────────────────
 *
 * The prior editor re-derived the target path at save time by searching the
 * file-tree entries. That list is lazily loaded and a reload resets it to the
 * root level, so a NESTED file's entry disappeared after the first save: the
 * lookup returned `undefined`, and the whole save was skipped inside an `if` —
 * no write, no error, no feedback. The user's edit was simply not there.
 *
 * Two independent changes remove the failure mode rather than guarding it:
 *
 *   (a) the path is CAPTURED AT OPEN and travels with the draft
 *       (`buffer.ts::PendingSave.apiPath`). Nothing looks a path up again, so
 *       there is no lookup left to return the wrong answer or none at all;
 *
 *   (b) the write is VERIFIED BY PATH against what the server says it wrote.
 *       The server resolves the path it was given and returns it; if that is
 *       not the file we opened, the save is reported as failed and the draft
 *       is KEPT. A response about another file is never allowed to retire the
 *       user's text — which is what "verified by path, not by name or index"
 *       has to mean to be worth anything.
 *
 * (b) is what makes (a) provable at runtime instead of merely intended, and it
 * is the assertion the mutation test breaks: a writer that answers with a
 * SIBLING file's path must fail the save and leave the buffer dirty.
 *
 * ── 2. A SAVE THAT SILENTLY OVERWRITES SOMEONE ELSE'S WORK ────────────────
 *
 * Every save goes through the PREIMAGE-CHECKED door (`/api/editor/edit`),
 * carrying the bytes the draft was written against. If the file changed
 * underneath — another agent, another tab, the tool executor — the server
 * refuses with `preimage_mismatch` and the draft survives. The unchecked
 * writer (`/api/editor/write`) is not reachable from this room at all, so
 * there is no branch that can fall through to it: the prior editor's
 * `if (content.length > 0) edit(…) else write(…)` treated an EMPTY file as
 * "no preimage" and used the unchecked writer, which is how saving a file that
 * was empty when it was opened silently overwrote what had been written to it
 * since.
 *
 * ── RECORDING ─────────────────────────────────────────────────────────────
 *
 * Nothing here calls a recorder. The write reaches disk through
 * `server/editor-bridge.ts::writeFileRaw`, which is the single in-process
 * owner of file writes and records the effect AT the write. Calling a recorder
 * from this module would be the shape where recording can be forgotten; the
 * choke point is the shape where it cannot.
 */

import type { PendingSave } from "./buffer.ts";

/** The door a save goes through. Injected so the outcome logic is testable
 * without a network, and so the room cannot reach a second door. */
export type SaveWriter = (save: PendingSave) => Promise<unknown>;

export type SaveOutcome =
  | Readonly<{ kind: "written"; path: string; content: string }>
  /** The draft matched the file on disk — there was nothing to write. */
  | Readonly<{ kind: "unchanged" }>
  /** The file changed underneath the draft. The draft is kept. */
  | Readonly<{ kind: "stale"; reason: string }>
  /** The server reported writing a DIFFERENT path. The draft is kept. */
  | Readonly<{ kind: "wrong-path"; reason: string; wrote: string }>
  /** Anything else, in plain words. The draft is kept. */
  | Readonly<{ kind: "failed"; reason: string }>;

/** Trailing separators are not part of a path's identity. */
function normalizePath(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/** The server's `{ path }` from an edit response, or null when it said none. */
export function writtenPathOf(wire: unknown): string | null {
  if (wire === null || typeof wire !== "object") return null;
  const w = wire as Record<string, unknown>;
  return typeof w.path === "string" ? w.path : null;
}

/**
 * Whether a save landed on the file that was opened.
 *
 * Exported because it is the assertion, and an assertion worth having is worth
 * being able to drive directly from a test.
 */
export function wroteTheOpenedFile(expected: string, wrote: string | null): boolean {
  if (wrote === null) return false;
  return normalizePath(expected) === normalizePath(wrote);
}

/** Plain words for a SAVE refusal, from the error the client door threw.
 * Named for its subject: the general refused-vs-failed classifier is
 * `refusalReason` in src/data/absence.ts, and this is not it — these are
 * the editor's own sentences about a write that did not land. */
function saveRefusalWords(err: unknown): { stale: boolean; reason: string } {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (code === "preimage_mismatch") {
    return {
      stale: true,
      reason:
        "this file changed on disk since you opened it — your edit was NOT written and is still here. Reopen the file to see the new version, or copy your text out first.",
    };
  }
  if (code === "file_too_large") {
    return { stale: false, reason: "this file is past the size this server accepts in one write — nothing was written" };
  }
  if (code === "file_not_found") {
    return { stale: false, reason: "this file is no longer on disk — nothing was written, and your edit is still here" };
  }
  if (status === 401 || status === 403) {
    return { stale: false, reason: "this session may not write to this project — nothing was written" };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { stale: false, reason: `the write did not go through — ${message}` };
}

/**
 * Run one save and say exactly what happened to the bytes.
 *
 * The caller retires the draft ONLY on `written`. Every other outcome keeps
 * it, which is the whole contract: an edit is never retired by anything but a
 * write that was verified to have landed on the file it was for.
 */
export async function performSave(save: PendingSave, write: SaveWriter): Promise<SaveOutcome> {
  if (save.content === save.preimage) return { kind: "unchanged" };
  let wire: unknown;
  try {
    wire = await write(save);
  } catch (err) {
    const { stale, reason } = saveRefusalWords(err);
    return stale ? { kind: "stale", reason } : { kind: "failed", reason };
  }
  const wrote = writtenPathOf(wire);
  if (!wroteTheOpenedFile(save.apiPath, wrote)) {
    return {
      kind: "wrong-path",
      wrote: wrote ?? "(the server named no file)",
      reason:
        `the server reported writing ${wrote ?? "no file at all"}, which is not the file you opened ` +
        `(${save.apiPath}). Your edit is still here and was NOT retired.`,
    };
  }
  return { kind: "written", path: save.apiPath, content: save.content };
}
