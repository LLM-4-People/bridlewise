/**
 * nanostores shared state: what the server masked before the model saw it.
 *
 * Fed ONLY by client.ts (`setRedactionNotice`) from the "redaction" SSE event,
 * which the server emits after a turn IN WHICH SOMETHING WAS ACTUALLY MASKED.
 * A turn that masked nothing sends no event and leaves this null, so a
 * non-null value always means the model's input really was changed. The same
 * parsed value feeds TWO consumers, so the live view and the record can never
 * disagree: this store (the LATEST notice — the run's most recent masking,
 * readable by any panel), and the TURN'S OWN RECORD (client.ts buffers the
 * event and attaches it to the assistant message it belongs to, where it is
 * persisted in the metadata blob — the turn footer renders the masking from
 * that record, so the live and reloaded views of the same turn agree).
 *
 * WHY THIS STORE EXISTS AT ALL. Redaction rewrites what the model is given,
 * on the user's behalf, without asking. That is the right default for a
 * credential — and it is also indistinguishable, from the outside, from
 * content going missing. If the redactor is wrong, the user's only symptom is
 * a model that answers as though it never saw something they definitely
 * typed. This store is what makes the rewrite observable, so a wrong
 * redaction is a visible mistake instead of an invisible one.
 *
 * CONFIDENCE IS CARRIED SEPARATELY, AND THAT IS THE POINT. `proven` means the
 * masked value was byte-equal to a credential the server holds — there is no
 * inference in that claim. `inferred` means a declaration phrase introduced it
 * and its shape agreed, which can be wrong. A surface that shows one total
 * presents a guess with the authority of a fact.
 *
 * NOTHING HERE IS EVER THE SECRET. The server sends positions, lengths,
 * categories and value-free reasons; there is no field that could carry a
 * preview, because a preview of a secret is the secret.
 */

import { atom, type WritableAtom } from "nanostores";

import { registerReset, registerContextReset } from "./store-registry";

/** One masked span, described without being revealed. */
export type RedactionReason = Readonly<{
  /** `proven` (equals a credential this server holds), `format` (matches a
   * published credential format), or `inferred` (a declaration introduced it
   * and its shape agreed). */
  readonly confidence: "proven" | "format" | "inferred";
  /** The redaction category the value was masked under. */
  readonly category: string;
  /** How many characters were replaced. Never the characters themselves. */
  readonly maskedLength: number;
  /** Why, in words the user can check against what they typed. */
  readonly explanation: string;
}>;

/**
 * The wire's own redaction notice for ONE LLM call: how many values that
 * call's input had masked (system prompt, history and prompt are masked
 * together, once per call), split by how confidently each was identified,
 * plus the values already masked upstream and a value-free reason per span.
 * The server emits this only when something was actually masked, so a value
 * that exists always means the model's input really was rewritten. One
 * owner of this shape: the message record, the beat and the live snapshot
 * all carry it.
 */
export type RedactionSummary = Readonly<{
  readonly maskedCount: number;
  readonly proven: number;
  readonly format: number;
  readonly inferred: number;
  /** Values already masked further upstream, whose reason is genuinely not
   * knowable here. Reported separately, never added to `maskedCount`. */
  readonly maskedUpstream: number;
  /** How many each tier of detection found, keyed by the tier id the privacy
   * registry declares. The join from "4 values hidden" to "which switch". */
  readonly byTier: Readonly<Record<string, number>>;
  readonly reasons: readonly RedactionReason[];
}>;

/** The live snapshot: the summary plus the run it arrived on. */
export type RedactionNoticeSnapshot = Readonly<RedactionSummary & {
  readonly runId?: string;
}>;

export const redactionNotice: WritableAtom<RedactionNoticeSnapshot | null> =
  atom<RedactionNoticeSnapshot | null>(null);

export function setRedactionNotice(snapshot: RedactionNoticeSnapshot | null): void {
  redactionNotice.set(snapshot);
}

/**
 * Reset the notice to null. Called by the single store-reset owner
 * (`resetAllStores`) on logout, so a re-login as a DIFFERENT user cannot see
 * that the previous user pasted a credential — which is itself a fact about
 * that user's message.
 */
export function resetRedactionNotice(): void {
  redactionNotice.set(null);
}

registerReset("redaction", resetRedactionNotice);
// Auto-reset on chat switch: the notice describes ONE turn in ONE
// conversation, and a notice that survived a chat switch would attach a
// warning about a masked credential to a conversation that never had one.
registerContextReset("redaction", resetRedactionNotice);
