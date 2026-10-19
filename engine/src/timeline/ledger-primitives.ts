import { types as nodeTypes } from "node:util";
import { InputError, SecurityError } from "../kernel/errors.ts";
import { generateId, sha256, SHA256_HEX_REGEX } from "../kernel/integrity.ts";
import { assertUnicodeScalarSequence, canonicalizeLedgerJson } from "../kernel/ledger-canonical.ts";
import { snapshotJsonValue } from "../kernel/safe-structural.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import type { TimelineDocumentInput } from "./timeline-types.ts";

/**
 * Shared forensic-ledger primitives.
 *
 * Both the in-memory execution closure (`src/execution-closure.ts`) and the
 * durable timeline store (`src/timeline/timeline-store.ts`) validate the same
 * ledger-record shape: identifiers, sequences, hashes, descriptions, and a
 * fixed set of correlation fields, then chain records with a domain-segregated
 * SHA-256 hash. Before this module existed, every one of those constants and
 * helpers was duplicated — and two of them had silently drifted
 * (`MAXIMUM_DESCRIPTION_BYTES` 4096 vs 8192, `MAXIMUM_CORRELATION_FIELDS` 16 vs
 * 8, and a monotonic-time regex that disagreed on leading zeros).
 *
 * This module is the single authority for the shared limits, patterns, and
 * chain primitives. Each ledger keeps its own chain domain constant (the
 * execution-closure domain and the timeline domain are intentionally distinct)
 * and passes it to `computeChainHash` so the domain can differ while the
 * hashing algorithm cannot.
 */

export const ZERO_CHAIN_HASH = "0".repeat(64);
export const GENESIS_SEQUENCE = 1n;
export const MAXIMUM_SEQUENCE = 9223372036854775807n;
export const MAXIMUM_IDENTIFIER_CHARACTERS = 512;
export const MAXIMUM_DESCRIPTION_BYTES = 8192;
export const MAXIMUM_CORRELATION_FIELDS = 8;

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
export { SHA256_HEX_REGEX as HEX_64_PATTERN };
/**
 * A canonical non-negative decimal integer string: accepts `"0"` and positive
 * integers without leading zeros, rejects `""`, `"00"`, `"01"`, and `"-1"`.
 * Sequences start at `GENESIS_SEQUENCE` (1), so a `"0"` that slips past this
 * pattern is still rejected by the caller's range check; monotonic-time values
 * may legitimately be `"0"`.
 */
export const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

/**
 * The eight canonical correlation field names shared by every ledger record.
 * Both ledgers validate correlation objects against this exact key set, so the
 * field-count ceiling (`MAXIMUM_CORRELATION_FIELDS`) equals the set length.
 */
export const CORRELATION_FIELD_NAMES = [
  "runId",
  "sessionId",
  "turnId",
  "messageId",
  "taskId",
  "attemptId",
  "agentId",
  "parentEffectId",
] as const;

/**
 * Canonical identifier generator for ledger records. Re-exports the single
 * `generateId` owner from `integrity.ts` (which uses `crypto.randomUUID`
 * with a dash separator) under the ledger-domain name so existing consumers
 * (`execution-closure.ts`, `timeline-store.ts`) keep a stable import path.
 */
export { generateId as generateIdentifier };

/** Admit a successor before either ledger mutates its state. */
export function nextLedgerSequence(
  current: bigint,
  code: "execution_sequence_exhausted" | "timeline_sequence_exhausted",
): bigint {
  if (current < 0n || current >= MAXIMUM_SEQUENCE) {
    throw new SecurityError("Ledger sequence exhausted", code);
  }
  return current + 1n;
}

/** An append may have persisted; this instance must not retry it blindly. */
export class LedgerPersistenceUncertainError extends SecurityError {
  constructor() {
    super("Ledger persistence outcome is uncertain", "ledger_persistence_uncertain");
  }
}

/** Recognize only this owned error, without traversing caller-controlled prototypes. */
export function isLedgerPersistenceUncertainError(value: unknown): value is LedgerPersistenceUncertainError {
  return nodeTypes.isNativeError(value) && Object.getPrototypeOf(value) === LedgerPersistenceUncertainError.prototype;
}

export function formatSequence(value: bigint): string {
  return value.toString(10);
}

/**
 * Fit a message inside the ledger's own description bound, marking the cut.
 *
 * An effect's failure detail can be a whole tool output. Storing it whole
 * would push past `MAXIMUM_DESCRIPTION_BYTES` (the limit the store enforces
 * against this very owner's constant); storing nothing would lose the reason
 * a step failed. Truncation is stated in the value itself so a reader is
 * never shown a silently shortened message as if it were complete.
 *
 * THE ONE OWNER of the fitting algorithm: both effect sinks (the web server's
 * timeline bridge and the harness runtime bootstrap) consumed private
 * byte-identical copies of this loop, and two copies of a byte-measuring
 * routine is how one ledger gets a message the other would have refused.
 * Sliced by BYTES, not characters — a multi-byte character cut in half would
 * still overflow the limit measured in bytes, and decoding a severed
 * sequence yields U+FFFD, which is WIDER than the bytes it replaced — so the
 * result is re-measured and trimmed until it actually fits.
 */
export function truncateForLedger(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAXIMUM_DESCRIPTION_BYTES) return message;
  const marker = "…[truncated]";
  const budget = MAXIMUM_DESCRIPTION_BYTES - Buffer.byteLength(marker, "utf8");
  let head = Buffer.from(message, "utf8").subarray(0, budget).toString("utf8");
  while (head.length > 0 && Buffer.byteLength(head, "utf8") > budget) {
    head = head.slice(0, -1);
  }
  return `${head}${marker}`;
}

/**
 * Domain-segregated SHA-256 chain hash. The `domain` bytes prefix the preimage
 * so an execution-closure chain and a timeline chain over identical record
 * bodies still produce disjoint hash spaces. Callers pass their own immutable
 * domain constant; this function owns the canonicalization and hashing.
 */
export function computeChainHash(
  domain: string,
  previousChainHash: string,
  envelope: unknown,
): string {
  return sha256(Buffer.concat([
    Buffer.from(domain, "utf8"),
    Buffer.from(previousChainHash, "hex"),
    canonicalizeLedgerJson(envelope),
  ]));
}

/** Capture public ledger JSON before field reads, using the forensic bounds. */
export function snapshotLedgerInput<T>(input: T, code: string): T {
  const { maximumDepth, maximumNodes } = ROOT_POLICY.forensics.limits;
  const snapshot = snapshotJsonValue(input, { maximumDepth, maximumNodes }, code);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InputError("Ledger input must be a JSON record", code);
  }
  return snapshot as T;
}

/** Terminal callers cannot supply the provenance derived from durable intent. */
export function assertTerminalProvenanceAbsent(input: object): void {
  for (const key of ["actor", "correlation", "traceId", "spanId", "parentEventId", "actorKind", "actorId", "actorRole", ...CORRELATION_FIELD_NAMES]) {
    if (Object.hasOwn(input, key)) {
      throw new InputError("Timeline terminal provenance comes from its intent", "timeline_terminal_provenance_override");
    }
  }
}


/** The direct store and fitter share the configured document-byte domain. */
export function assertTimelineDocumentByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ROOT_POLICY.timeline.limits.maxDocumentBytes) {
    throw new InputError("Timeline document byte limit is invalid", "timeline_document_limit_invalid");
  }
}

/**
 * Admit captured document data without interpreting its text. The optional
 * byte ceiling applies to stored documents; originals are admitted before
 * fitting without that ceiling. Digest-only references have no inline text.
 */
export function assertTimelineDocument(document: unknown, maximumBytes?: number): asserts document is TimelineDocumentInput {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new InputError("Timeline document is invalid", "timeline_document_invalid");
  }
  const value = document as Record<string, unknown>;
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 256) {
    throw new InputError("Timeline document name is invalid", "timeline_document_invalid");
  }
  assertUnicodeScalarSequence(value.name);
  if (typeof value.contentDigest !== "string" || !SHA256_HEX_REGEX.test(value.contentDigest)) {
    throw new InputError("Timeline document digest is invalid", "timeline_document_invalid");
  }
  const hasContent = Object.hasOwn(value, "contentJson");
  const hasOrdered = Object.hasOwn(value, "orderedJson");
  if (hasContent && hasOrdered) throw new InputError("Timeline document has two inline representations", "timeline_document_invalid");
  if (!hasContent && !hasOrdered) return;
  const text = hasContent ? value.contentJson : value.orderedJson;
  if (typeof text !== "string") throw new InputError("Timeline document content is invalid", "timeline_document_invalid");
  assertUnicodeScalarSequence(text);
  if (maximumBytes !== undefined && Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new InputError("Timeline document content exceeds limit", "timeline_document_invalid");
  }
  if (value.contentDigest !== sha256(text)) {
    throw new InputError("Timeline document digest does not match its exact UTF8 text", "timeline_document_digest_mismatch");
  }
}
