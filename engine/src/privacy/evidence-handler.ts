import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import {
  redactText,
  redactionMetadata,
  verifyRedaction,
  type RedactionResult,
} from "./redaction-engine.ts";
import {
  createPrivacyPolicy,
  type PrivacyPolicy,
} from "./privacy-policy.ts";

/**
 * Evidence handler — redacts sensitive content before persistence, display,
 * or model exposure, while preserving redaction metadata for audit.
 *
 * Unsupported parsing blocks semantic admission: if evidence content cannot
 * be parsed (binary, undecodable, unknown format), the evidence is marked
 * "unparseable" rather than "clean". The evidence is never silently passed
 * through and never hidden entirely — the block reason is recorded.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 *
 * Binding authorities:
 * item 11: "Unsupported parsing blocks semantic claims; it
 * does not hide the whole file or silently pass it."
 * USR-055 / DER-041: "Block truthfully on redaction uncertainty,
 * unsupported binary or undecodable bytes, unsafe path/type/link/mount
 * identity, unauthorized scope, stale snapshot, unbounded query, unsafe
 * regex, oversize mandatory view, detector failure or mapping
 * ambiguity."
 * Canonical requirements: "Redact authorization, API keys, cookies,
 * credentials, and secret-shaped values before durable storage or
 * display."
 * Root policy: "Log redaction/encryption decisions as metadata without
 * echoing matched secrets."
 */

export type EvidenceAdmissionStatus =
  | "clean"
  | "redacted"
  | "unparseable"
  | "blocked";

export type EvidenceRedactionMetadata = Readonly<{
  spanCount: number;
  redactionMapHash: string;
  originalByteLength: number;
  redactedByteLength: number;
  verified: boolean;
  residualSpanCount: number;
}>;

/**
 * A REFUSAL HAS NO CONTENT FIELD, AND THAT IS THE POINT.
 *
 * This used to answer a refusal with `redactedContent: ""` — the same shape a
 * clean, genuinely empty document has. A caller that read the payload and
 * ignored the status could not tell "there was nothing here" from "we would
 * not hand this over", so the safety check DESTROYED the evidence instead of
 * REFUSING to release it, and the destruction read downstream as success.
 *
 * The refused variant therefore carries no payload at all. `redactedContent`
 * is unreachable without narrowing on `status`, which turns ignoring a refusal
 * into a compile error rather than an empty string nobody notices.
 */
export type EvidenceRedactionAdmitted = Readonly<{
  status: "clean" | "redacted" | "unparseable";
  redactedContent: string;
  metadata: EvidenceRedactionMetadata;
  blockReason?: string;
  redactionResult: RedactionResult;
}>;

export type EvidenceRedactionRefused = Readonly<{
  status: "blocked";
  metadata: EvidenceRedactionMetadata;
  /** Why nothing is being handed over. Required — a refusal that cannot say
   * why is indistinguishable from a failure to answer. */
  blockReason: string;
  redactionResult: RedactionResult;
}>;

export type EvidenceRedactionResult = EvidenceRedactionAdmitted | EvidenceRedactionRefused;

export type EvidenceRedactionOptions = Readonly<{
  policy?: PrivacyPolicy;
  allowUnparseable?: boolean;
}>;

/**
 * Redact evidence content before persisting to the timeline/evidence store.
 *
 * This is the primary entry point for durable persistence. It:
 * 1. Detects and redacts all sensitive spans.
 * 2. Verifies the redaction is complete (no residual secrets).
 * 3. Returns the redacted content + metadata (no original secrets).
 * 4. If verification fails, marks as "blocked" with a content-free reason.
 */
export function redactForPersistence(
  content: string,
  options: EvidenceRedactionOptions = {},
): EvidenceRedactionResult {
  return redactEvidenceInternal(content, options, "persistence");
}

/**
 * THE TEXT A RECORD OR LOG MAY HOLD: the one persistence redaction, never a
 * block (UR-21, D-09) — a span the redaction cannot verify is withheld in place
 * with its content-free reason, and the rest is kept.
 */
export function persistableText(text: string): string {
  const redacted = redactForPersistence(text);
  return redacted.status === "blocked" ? `[withheld: ${redacted.blockReason}]` : redacted.redactedContent;
}

/**
 * Redact evidence content before displaying to the model or user.
 *
 * Same redaction as persistence, but the display path allows "unparseable"
 * status to pass through (with a visible block notice) rather than blocking
 * entirely. The model/user sees that evidence exists but could not be
 * semantically parsed.
 */
export function redactForDisplay(
  content: string,
  options: EvidenceRedactionOptions = {},
): EvidenceRedactionResult {
  return redactEvidenceInternal(content, options, "display");
}

/**
 * Redact evidence content for logging. Logging redaction is the strictest:
 * even if redaction verification passes, the metadata records that this was
 * a log-bound redaction so the audit trail can distinguish it from
 * persistence or display redactions.
 */
export function redactForLog(
  content: string,
  options: EvidenceRedactionOptions = {},
): EvidenceRedactionResult {
  return redactEvidenceInternal(content, options, "log");
}

/**
 * General evidence redaction function. Applies the privacy policy, verifies
 * completeness, and returns a typed result with the admission status.
 */
export function redactEvidence(
  content: string,
  options: EvidenceRedactionOptions = {},
): EvidenceRedactionResult {
  return redactEvidenceInternal(content, options, "general");
}

function redactEvidenceInternal(
  content: string,
  options: EvidenceRedactionOptions,
  path: "persistence" | "display" | "log" | "general",
): EvidenceRedactionResult {
  const policy = options.policy ?? createPrivacyPolicy();
  if (typeof content !== "string") {
    return blockedResult(
      "evidence_content_not_string",
      "",
      policy,
      path,
    );
  }
  const redactionResult = redactText(content, policy);
  const verification = verifyRedaction(redactionResult.redactedText, policy);
  const meta = redactionMetadata(redactionResult);
  const baseMetadata = deepFreeze({
    spanCount: meta.spanCount,
    redactionMapHash: meta.redactionMapHash,
    originalByteLength: meta.originalByteLength,
    redactedByteLength: meta.redactedByteLength,
    verified: verification.verified,
    residualSpanCount: verification.residualSpans.length,
  });

  if (redactionResult.spanCount === 0) {
    return deepFreeze({
      status: "clean",
      redactedContent: content,
      metadata: baseMetadata,
      redactionResult,
    });
  }

  if (!verification.verified) {
    return deepFreeze({
      status: "blocked",
      metadata: baseMetadata,
      blockReason: "redaction_incomplete_residual_secrets_detected",
      redactionResult,
    });
  }

  return deepFreeze({
    status: "redacted",
    redactedContent: redactionResult.redactedText,
    metadata: baseMetadata,
    redactionResult,
  });
}

function blockedResult(
  reason: string,
  content: string,
  _policy: PrivacyPolicy,
  path: string,
): EvidenceRedactionRefused {
  return deepFreeze({
    status: "blocked",
    metadata: deepFreeze({
      spanCount: 0,
      redactionMapHash: canonicalHash([]),
      originalByteLength: 0,
      redactedByteLength: 0,
      verified: false,
      residualSpanCount: 0,
    }),
    blockReason: `${reason}:${path}`,
    redactionResult: deepFreeze({
      redactedText: content,
      spans: [],
      spanCount: 0,
      redactionMapHash: canonicalHash([]),
      originalByteLength: 0,
      redactedByteLength: 0,
      profile: "admission",
    }),
  });
}

/**
 * Mark evidence as unparseable. This is the "blocks semantic claims" path:
 * the evidence exists but cannot be semantically parsed. It is NOT hidden
 * (the block reason is visible) and NOT silently passed (the status is
 * "unparseable", not "clean").
 */
export function markUnparseable(
  content: string,
  reason: string,
  options: EvidenceRedactionOptions = {},
): EvidenceRedactionResult {
  const policy = options.policy ?? createPrivacyPolicy();
  const redactionResult = content.length > 0
    ? redactText(content, policy)
    : emptyRedactionResult();
  const verification = verifyRedaction(redactionResult.redactedText, policy);
  if (!verification.verified) {
    return deepFreeze({
      status: "blocked",
      metadata: deepFreeze({
        spanCount: redactionResult.spanCount,
        redactionMapHash: redactionResult.redactionMapHash,
        originalByteLength: redactionResult.originalByteLength,
        redactedByteLength: redactionResult.redactedByteLength,
        verified: false,
        residualSpanCount: verification.residualSpans.length,
      }),
      blockReason: "redaction_incomplete_residual_secrets_detected",
      redactionResult,
    });
  }
  return deepFreeze({
    status: "unparseable",
    redactedContent: redactionResult.redactedText,
    metadata: deepFreeze({
      spanCount: redactionResult.spanCount,
      redactionMapHash: redactionResult.redactionMapHash,
      originalByteLength: redactionResult.originalByteLength,
      redactedByteLength: redactionResult.redactedByteLength,
      verified: verification.verified,
      residualSpanCount: verification.residualSpans.length,
    }),
    blockReason: reason,
    redactionResult,
  });
}

/**
 * Create an evidence receipt that binds the redaction metadata without
 * exposing any original content. The receipt contains only: the redaction
 * map hash, span count, byte lengths, and admission status.
 */
export function createEvidenceReceipt(
  result: EvidenceRedactionResult,
): Readonly<{
  status: EvidenceAdmissionStatus;
  spanCount: number;
  redactionMapHash: string;
  originalByteLength: number;
  redactedByteLength: number;
  verified: boolean;
  blockReason: string | null;
  receiptHash: string;
}> {
  return deepFreeze({
    status: result.status,
    spanCount: result.metadata.spanCount,
    redactionMapHash: result.metadata.redactionMapHash,
    originalByteLength: result.metadata.originalByteLength,
    redactedByteLength: result.metadata.redactedByteLength,
    verified: result.metadata.verified,
    blockReason: result.blockReason ?? null,
    receiptHash: canonicalHash({
      status: result.status,
      spanCount: result.metadata.spanCount,
      redactionMapHash: result.metadata.redactionMapHash,
      blockReason: result.blockReason ?? null,
    }),
  });
}

function emptyRedactionResult(): RedactionResult {
  return deepFreeze({
    redactedText: "",
    spans: [],
    spanCount: 0,
    redactionMapHash: canonicalHash([]),
    originalByteLength: 0,
    redactedByteLength: 0,
    profile: "admission",
  });
}
