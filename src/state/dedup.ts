/**
 * nanostores shared state: the latest dedup/compression summary.
 *
 * Fed ONLY by client.ts (setDedupSnapshot) from the "dedup" SSE event
 * the server emits before each LLM call whose input dedup actually
 * removed content. The same parsed value feeds TWO consumers, so the
 * live view and the record can never disagree: this store (the LATEST
 * summary — the run's most recent savings, readable by any panel), and
 * the TURN'S OWN RECORD (client.ts buffers the event and attaches it to
 * the assistant message it belongs to, where it is persisted in the
 * metadata blob — the turn footer renders the savings from that record,
 * so the live and reloaded views of the same turn agree). Plain .ts —
 * Node-testable via Vitest.
 *
 * The dedup sits below the LLM API (compresses input before each call).
 * It is opt-in via `memory.dedupCompression.enabled` +
 * `memory.dedupCompression.llmInputDedup` (both default OFF), so the
 * snapshot stays null unless the user enables dedup AND a turn removes
 * content.
 */

import { atom, type WritableAtom } from "nanostores";

import { registerReset, registerContextReset } from "./store-registry";

/**
 * The wire's own dedup summary for ONE LLM call: how much of that call's
 * input the dedup layer folded (chars before/after, the reduction pct, how
 * many repeated blocks were removed and from how many messages). The server
 * emits this only when dedup actually removed content, so a value that
 * exists always means the input really was rewritten. One owner of this
 * shape: the message record, the beat and the live snapshot all carry it.
 */
export type DedupSummary = Readonly<{
  readonly applied: boolean;
  readonly originalChars: number;
  readonly dedupedChars: number;
  readonly charReductionPct: number;
  readonly removedBlocks: number;
  readonly removedLines: number;
  readonly messageCount: number;
}>;

/** The live snapshot: the summary plus the run it arrived on. */
export type DedupSnapshot = Readonly<DedupSummary & {
  readonly runId?: string;
}>;

export const dedupSnapshot: WritableAtom<DedupSnapshot | null> = atom<DedupSnapshot | null>(null);

export function setDedupSnapshot(snapshot: DedupSnapshot | null): void {
  dedupSnapshot.set(snapshot);
}

/**
 * Reset the dedup store to null. Called by the single store-reset owner
 * (`resetAllStores`) on logout so a re-login as a DIFFERENT user does not
 * briefly see the previous user's dedup summary.
 */
export function resetDedup(): void {
  dedupSnapshot.set(null);
}

registerReset("dedup", resetDedup);
// Auto-reset on chat switch: the store self-registers so the chat-change
// signal resets it automatically (no manual call in the chat-switch
// handler).
registerContextReset("dedup", resetDedup);
