/**
 * THE SEALED ORIGINALS — the one owner of a protected document's exact bytes.
 *
 * The store writes every document through the operational projection: a
 * detected secret is masked in the public `event_documents` row. When that
 * changes a document, the row is `protected` and names the digest of the
 * ORIGINAL (`original_digest`); the original itself is kept here, and only
 * here, encrypted (AES-256-GCM under the store key through the forensic AEAD
 * owner), in `event_document_originals` rows bound to that document row. So
 * no file of the ledger holds the secret in the clear, and a rollback still
 * restores the file exactly (CRED-F12).
 *
 * WHAT BINDS WHAT. Each chunk's associated data names the ledger, the event
 * and its sequence, so a chunk copied under another event does not open; a
 * chunk moved between two documents of one event, reordered or dropped fails
 * the reassembled digest, which must equal the row's `original_digest`. A
 * wrong key opens nothing. Every such failure is one typed refusal
 * (`timeline_sealed_original_unavailable`): the caller never receives bytes
 * that are not the original.
 *
 * WHICH KEY. The ledger records this key's CHECK VALUE at its first seal
 * (`timeline_seal_key_check`, append-only) and the store compares it at every
 * open: a ledger opened with another key (a host that resolves a different
 * one, a key minted after a loss) is refused before it seals or reads
 * anything (`timeline_seal_key_mismatch`), never left to collect seals under
 * two keys (a3-design H2).
 *
 * WHAT THIS IS NOT. It is not the encrypted evidence vault of REQ-025 (the
 * timeline's full-fidelity copy of EVERY payload, encrypted at rest): that
 * requirement stays open. Only the bytes the public projection lost are sealed.
 */
import type { KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  computeKeyCheckValue,
  createAes256GcmKeyOperations,
  openForensicPayload,
  sealForensicPayload,
  type SealedForensicPayload,
  type SealedPayloadAadFields,
} from "../forensics/forensic-crypto.ts";
import { SecurityError } from "../kernel/errors.ts";
import { randomBytes, sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

/** The purpose a timeline's seal key is checked under (`computeKeyCheckValue`). */
const SEAL_KEY_CHECK_PURPOSE = "timeline-seal-key";

/** Where a sealed original belongs: its event's coordinates, bound into every chunk. */
export type SealedOriginalCoordinates = Readonly<{ ledgerId: string; eventId: string; sequence: string }>;

export type TimelineSealing = Readonly<{
  /** This key's check value (recorded by the ledger at its first seal, compared at every open). */
  keyCheck: string;
  /** Seal `text` as the original of the `event_documents` row `docId` (inside the append's transaction). */
  seal(db: DatabaseSync, docId: bigint, at: SealedOriginalCoordinates, text: string): void;
  /** The original of row `docId`, opened and verified against `originalDigest`; refused when it is not exactly that. */
  open(db: DatabaseSync, docId: bigint, at: SealedOriginalCoordinates, originalDigest: string): string;
}>;

function refuse(): never {
  throw new SecurityError(
    "The sealed original of a protected timeline document could not be opened: it is missing, damaged, or sealed under another key",
    "timeline_sealed_original_unavailable",
  );
}

export function createTimelineSealing(key: KeyObject): TimelineSealing {
  const aead = createAes256GcmKeyOperations(key);
  const chunkBytes = ROOT_POLICY.forensics.limits.maximumInputBytes;
  const binding = (at: SealedOriginalCoordinates): SealedPayloadAadFields => ({
    ledgerId: at.ledgerId, eventId: at.eventId, sequence: at.sequence, classification: "sensitive", purpose: "raw-capture",
  });
  return Object.freeze({
    keyCheck: computeKeyCheckValue(key, SEAL_KEY_CHECK_PURPOSE),
    seal(db: DatabaseSync, docId: bigint, at: SealedOriginalCoordinates, text: string): void {
      const bytes = Buffer.from(text, "utf8");
      const insert = db.prepare("INSERT INTO event_document_originals (doc_id, chunk, sealed) VALUES (?, ?, ?)");
      // An empty original is one empty chunk, so every protected row has a seal.
      for (let offset = 0, chunk = 0; offset < bytes.length || chunk === 0; offset += chunkBytes, chunk += 1) {
        const sealed = sealForensicPayload(bytes.subarray(offset, offset + chunkBytes), binding(at),
          randomBytes(ROOT_POLICY.forensics.algorithms.nonceBytes), aead);
        insert.run(docId, chunk, JSON.stringify(sealed));
      }
    },
    open(db: DatabaseSync, docId: bigint, at: SealedOriginalCoordinates, originalDigest: string): string {
      const statement = db.prepare("SELECT chunk, sealed FROM event_document_originals WHERE doc_id = ? ORDER BY chunk");
      statement.setReadBigInts(true);
      const rows = statement.all(docId) as Array<{ chunk: bigint; sealed: string }>;
      let bytes: Buffer;
      try {
        bytes = Buffer.concat(rows.map((row, index) => {
          if (row.chunk !== BigInt(index)) return refuse();
          return openForensicPayload(JSON.parse(row.sealed) as SealedForensicPayload, binding(at), aead);
        }));
      } catch {
        // The forensic owner's own refusal (digest, AAD, tag) or an unparseable
        // row: one answer, and no part of the failed bytes leaves.
        return refuse();
      }
      if (rows.length === 0 || sha256(bytes) !== originalDigest) return refuse();
      return bytes.toString("utf8");
    },
  });
}
