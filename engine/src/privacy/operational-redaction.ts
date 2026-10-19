/** Key-authenticated operational projection; the domain detector grants no exemptions beyond authenticated ciphertext and the bank-routing grammar on a JSON number. */
import type { KeyObject } from "node:crypto";
import { authenticatedEncryptedFieldRanges, ownerSealAad, UNBOUND_FIELD } from "./encrypted-field.ts";
import { jsonNumberRanges, parseJsonExact } from "../kernel/json-integrity.ts";
import { applyRedactions, collectContextRedactionCandidates, redactForLLMContext, resolveOverlaps, type ExplainedSpan } from "./redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY } from "./privacy-policy.ts";

/** The one grammar a JSON number token is exempt from (see `redactOperationalText`). */
const BANK_ROUTING_SIGNAL = "bank-routing";
/** A label that names a routing number: such a number keeps its detection (on doubt, redact: UR-21). */
const ROUTING_LABEL = /routing|transit|(?:^|[^a-z])(?:aba|rtn)(?:[^a-z]|$)/iu;

/**
 * The bindings ciphertext in `text` may be sealed under: unbound (fields
 * written before binding) and, for a document sealed to its owner (a memory
 * entry), that owner seal — so authenticated ciphertext is kept intact and
 * readable after a restart, and nothing else is exempted.
 */
function bindingsOf(text: string): readonly string[] {
  const parsed = parseJsonExact(text);
  const owner = parsed === undefined ? undefined : ownerSealAad(parsed.value);
  return owner === undefined ? [UNBOUND_FIELD] : [UNBOUND_FIELD, owner];
}

/**
 * A document's operational projection. Two exemptions, each by TYPE and each
 * as narrow as the defect that measured it:
 *
 * - authenticated field ciphertext under the store key (kept intact, so a
 *   memory entry carried in the ledger stays readable);
 * - the BANK-ROUTING check-digit grammar on a JSON NUMBER token, and nothing
 *   else. That grammar is unlabelled and low in specificity: about 3% of all
 *   9-digit numbers pass it, so a resource tick's `process.rss` byte count was
 *   written as "[REDACTED:pii]" (588 of 20,000 random counts, REDACT-NUM). A
 *   number whose key NAMES a routing number (`routing_number`, `aba`) keeps
 *   the detection: it is labelled, so on doubt it is redacted (UR-21).
 *   Every other detector still reads numbers: a secret-named key
 *   (`"password": 84729361528374`), a Luhn card number, a labelled social
 *   security number, in any document, an edited file's pre-image included.
 *   The same digits inside a string or free text are read by every detector.
 */
export function redactOperationalText(text: string, key: KeyObject): string {
  const protectedRanges = bindingsOf(text).flatMap((aad) => authenticatedEncryptedFieldRanges(text, key, aad)).sort((a, b) => a.startUtf16 - b.startUtf16);
  const numbers = jsonNumberRanges(text) ?? [];
  if (protectedRanges.length === 0 && numbers.length === 0) return redactForLLMContext(text);
  // Detection sees the complete raw and normalized text. Subtraction precedes
  // overlap arbitration so a candidate inside ciphertext cannot hide a second
  // overlapping candidate that extends into adjacent plaintext.
  const candidates = collectContextRedactionCandidates(text, DEFAULT_PRIVACY_POLICY, {}, true)
    .filter((span) => !(span.signalId === BANK_ROUTING_SIGNAL && numbers.some((number) =>
      number.startUtf16 <= span.startUtf16 && span.endUtf16 <= number.endUtf16 && (number.label === null || !ROUTING_LABEL.test(number.label)))));
  const projected: ExplainedSpan[] = [];
  let first = 0;
  for (const span of [...candidates].sort((a, b) => a.startUtf16 - b.startUtf16)) {
    while (first < protectedRanges.length && protectedRanges[first]!.endUtf16 <= span.startUtf16) first += 1;
    let cursor = span.startUtf16;
    for (let index = first; index < protectedRanges.length && protectedRanges[index]!.startUtf16 < span.endUtf16; index += 1) {
      const protectedRange = protectedRanges[index]!;
      if (cursor < protectedRange.startUtf16) projected.push({ ...span, startUtf16: cursor, endUtf16: protectedRange.startUtf16 });
      cursor = Math.max(cursor, protectedRange.endUtf16);
    }
    if (cursor < span.endUtf16) projected.push({ ...span, startUtf16: cursor });
  }
  return applyRedactions(text, resolveOverlaps(projected), DEFAULT_PRIVACY_POLICY);
}
