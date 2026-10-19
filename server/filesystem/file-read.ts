/**
 * File-read utility — the SINGLE owner of text-file reads in the server
 * runtime. Enforces UTF-8 at the LOWEST level ("Lowest-Level
 * Enforcement": a pattern that applies to everything goes to the lowest
 * level, not each call site). Every text read (config, editor content, tool
 * search, timeline ledger, llm config, models config) goes through
 * `readFileText` so the encoding is decided ONCE — a caller can never forget
 * the `"utf8"` argument and silently read mojibake / a Buffer.
 *
 * Binary reads (e.g. the DB key in `db-crypto.ts`) deliberately use
 * `readFileSync` directly WITHOUT an encoding — they need a `Buffer`, not a
 * string. The mechanical test (`no-scattered-helpers.test.ts`) permits raw
 * `readFileSync` ONLY in this file + `db-crypto.ts` (the binary owner).
 *
 * Single-Party-Owner (cross-cutting): encoding is a cross-cutting
 * concern with one owner; routes/bridges that read text import this instead
 * of re-declaring `readFileSync(path, "utf8")` (the prior 7 scattered call
 * sites — No Scattered Helpers principle).
 */
import { readFileSync } from "node:fs";

// Only this reader can attest that a freshly acquired buffer has no caller
// alias. Reflected constructor/static calls cannot obtain this capability.
const OWNED_READ_BYTES = Symbol("owned-read-bytes");

/**
 * Read a file as a UTF-8 string. The optional reuse form returns a caller-
 * owned byte/text snapshot, reusing its decoding when current bytes match.
 * This owner retains no cache; the config reader owns its single snapshot.
 * Throws the underlying `node:fs` error (ENOENT, EACCES, …) so
 * callers handle missing/locked files via their own typed-error mapping
 * (e.g. the editor bridge throws `ValidationError` `file_not_found`).
 */
// A plain { bytes, text } pair would let a caller mutate/forge the bytes and
// reuse unrelated text. Private bytes and immutable text preserve that
// relationship without a second cache. Only changed input creates a snapshot.
class FileTextSnapshot {
  readonly #bytes: Buffer;
  readonly text: string;

  private constructor(bytes: Buffer, ownership?: symbol) {
    // The constructor is discoverable through an instance's prototype even
    // though TypeScript makes it private. Own the bytes so a reflected caller
    // cannot change them through the buffer it supplied after text is decoded.
    this.#bytes = ownership === OWNED_READ_BYTES ? bytes : Buffer.from(bytes);
    this.text = this.#bytes.toString("utf8");
    Object.freeze(this);
  }

  /** A copy of the physical bytes, for a decoder that must see them (the
   * config reader refuses invalid UTF-8, which `text` would hide). */
  bytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  static reuse(bytes: Buffer, previous: FileTextSnapshot | undefined, ownership?: symbol): FileTextSnapshot {
    // Private-slot membership also rejects prototype forgeries and proxies;
    // never dispatch a comparison or read text through an untrusted handle.
    if (typeof previous === "object" && previous !== null && #bytes in previous && Buffer.compare(bytes, previous.#bytes) === 0) return previous;
    return new FileTextSnapshot(bytes, ownership);
  }
}
Object.freeze(FileTextSnapshot);
export type { FileTextSnapshot };

export function readFileText(path: string): string;
export function readFileText(path: string, reuse: Readonly<{ previous: FileTextSnapshot | undefined }>): FileTextSnapshot;
export function readFileText(path: string, reuse?: Readonly<{ previous: FileTextSnapshot | undefined }>): string | FileTextSnapshot {
  if (reuse === undefined) return readFileSync(path, "utf8");
  const bytes = readFileSync(path);
  return FileTextSnapshot.reuse(bytes, reuse.previous, OWNED_READ_BYTES);
}

/**
 * Compare physical file bytes with a UTF-8 write's bytes. Decoding first is
 * lossy: malformed input can decode to the same replacement character as a
 * valid string. Keep the encoding decision here with the text-read owner.
 * Filesystem errors propagate to the caller's existing refusal/write path.
 */
export function fileTextBytesEqual(path: string, text: string): boolean {
  return readFileSync(path).equals(Buffer.from(text, "utf8"));
}
