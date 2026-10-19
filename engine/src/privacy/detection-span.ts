import { deepFreeze } from "../kernel/integrity.ts";

/**
 * THE ONE THING EVERY DETECTION LAYER PRODUCES.
 *
 * Five layers detect secrets by five different kinds of evidence, and they
 * are combined by UNION rather than by precedence. A union only composes if
 * every layer speaks the same shape, and the shape has to carry WHY as well
 * as WHERE — a checksum that provably passed and a noun that probably
 * introduced a value are not the same claim, and a surface that renders them
 * identically is lying by omission.
 *
 * This module holds nothing but that contract, so a layer can import it
 * without importing another layer. That is not tidiness: `value-intrinsic`
 * and `secret-intelligence` each need the other's helpers, and a shared
 * contract module is what keeps that from being a cycle.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

/**
 * WHY A DETECTION IS BELIEVED, which is not the same as WHAT was detected.
 *
 * - `proven`   — no inference step exists. The span is byte-equal to a
 *                credential this process holds, or it carries a checksum that
 *                arithmetic says passes. It either is or it is not.
 * - `format`   — the span matches a published grammar (`AKIA…`, an email
 *                address, `-----BEGIN … PRIVATE KEY-----`). Proof of shape,
 *                not proof that this particular string is live.
 * - `inferred` — the surrounding words, or the value's own entropy against
 *                the benign enumeration, support the reading. This is the
 *                only class that can be wrong in either direction, and it is
 *                labelled so a reader can tell.
 */
export const SECRET_CONFIDENCES = deepFreeze([
  "proven",
  "format",
  "inferred",
] as const);

/** Derived from the array above, so a fourth class cannot be declared without
 * entering the list every consumer walks. */
export type SecretConfidence = typeof SECRET_CONFIDENCES[number];

/** A detected region, in UTF-16 code units, with the reason it is believed. */
export type IntelligenceSpan = Readonly<{
  startUtf16: number;
  endUtf16: number;
  signalId: string;
  detectorId: string;
  confidence: SecretConfidence;
  /** Human-readable, value-free. Safe to show a user and safe to log. */
  explanation: string;
}>;

export const NO_SPANS: readonly IntelligenceSpan[] = Object.freeze([]);
