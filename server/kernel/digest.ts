/**
 * Content digest — the SINGLE owner of "hash this text the way the harness
 * hashes text" in the server runtime.
 *
 * The same three-call expression (`createHash("sha256").update(content,
 * "utf8").digest("hex")`) was written out in the tool executor, in the editor
 * bridge and in the timeline bridge. Three copies of one decision is three
 * places for the algorithm, the encoding or the output form to drift, and the
 * values are COMPARED across those call sites: the editor tools verify a
 * preimage hash produced by one copy against a file hashed by another, and the
 * ledger stores digests that a reader is entitled to recompute. A copy that
 * quietly used a different encoding would not fail loudly — it would report a
 * preimage mismatch on a file nobody touched.
 *
 * The encoding is part of the contract, not a parameter: `"utf8"` in, hex out,
 * decided here once so a caller cannot forget it. This mirrors
 * `server/file-read.ts`, which owns the read encoding for the same reason.
 */
import { createHash } from "node:crypto";

/** SHA-256 of `content` read as UTF-8, as a lowercase hex string. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * SHA-256 of raw BYTES, as a lowercase hex string — the byte-image form of
 * the text contract above. A file read as a Buffer is hashed without a text
 * round-trip (a decode/encode pair would normalize byte sequences a digest
 * must see verbatim), so binary identity — a guardian binary, a blob — is
 * what this owns, beside the text contract the ledger's content digests
 * use. Same owner, same algorithm, both input kinds decided here once.
 */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
