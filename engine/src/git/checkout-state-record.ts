/**
 * THE CHECKOUT-STATE RECORDS' ONE READER AND WRITER.
 *
 * Two records describe a checkout's git state between commands: the live
 * index baseline (`index-baseline.ts`) and the deletion declarations
 * (`declared-deletions.ts`). Each is a private JSON document whose `entries`
 * carry a digest (`entriesDigest`), and each was read with its own copy of
 * read → parse → schema → digest (WF-DEL left the two side by side). The
 * shape is decided here once:
 *
 * - {@link readCheckoutStateRecord}: `null` when the file is absent (the
 *   record was never made, or was emptied); the caller's typed refusal when it
 *   cannot be read, is not JSON, fails its schema or its digest — a torn or
 *   hand-garbled record is never trusted, and never silently treated as empty.
 * - {@link writeCheckoutStateRecord}: the digest computed from the entries,
 *   the document in canonical JSON, published through the one atomic writer
 *   at the private-state mode, its folder created private.
 *
 * The digest is a self-consistency check against a torn or garbled file, not a
 * MAC: an edit that recomputes it is read like any record, and each record's
 * own rules judge what it says.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../filesystem/private-state.ts";
import { HarnessError } from "../kernel/errors.ts";
import { canonicalHash, canonicalJson } from "../kernel/integrity.ts";

/** The part every checkout-state record shares. */
export type DigestedEntries = Readonly<{ entriesDigest: string; entries: readonly unknown[] }>;

/**
 * The record at `path`, checked against `schema` and its entries' digest;
 * `null` when there is no file. `refusal(reason)` is the caller's typed error
 * for a record that cannot be trusted.
 */
export function readCheckoutStateRecord<T extends DigestedEntries>(path: string, schema: z.ZodType<T>, refusal: (reason: string) => HarnessError): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw refusal((error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw refusal((error as Error).message);
  }
  const record = schema.safeParse(parsed);
  if (!record.success || canonicalHash(record.data.entries) !== record.data.entriesDigest) throw refusal("not an intact record of its schema");
  return record.data;
}

/** Publishes `document` (its `entriesDigest` computed here) at `path`; `unwritableCode` names a failed write. */
export function writeCheckoutStateRecord<T extends DigestedEntries>(path: string, document: Omit<T, "entriesDigest">, unwritableCode: string): void {
  ensurePrivateStateDirectory(dirname(path));
  const record = { ...document, entriesDigest: canonicalHash(document.entries) };
  const written = atomicWriteFile(path, `${canonicalJson(record)}\n`, { createMode: PRIVATE_STATE_FILE_MODE });
  if (!written.success) throw written.error ?? new HarnessError(`could not write the checkout-state record at ${path}`, unwritableCode);
}
