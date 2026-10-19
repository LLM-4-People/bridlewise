/**
 * HOW FAR BACK THE READER HAS ACTUALLY READ (DESIGN-PERFORMANCE §4, §1 L3).
 *
 * A conversation now opens at its TAIL. That is what makes a 20,000-message
 * conversation openable at all — but it also creates a new way for the
 * surface to lie, and it is exactly the lie L3 forbids:
 *
 *     "older messages are not loaded yet"
 * is a different statement from
 *     "this is the beginning of the conversation"
 *
 * and they render as the same thing — the top of the list — unless something
 * holds the difference. `chat-history-load.ts` holds whether the read landed;
 * this holds HOW MUCH OF THE CONVERSATION it reached.
 *
 * The distinction is not inferred from counts on the client. `loaded <
 * messageCount` would be a plausible test and it is not the same question:
 * the transcript also carries synthesized event rows that were never messages
 * (client.ts merges inline events out of the timeline refs), so the two
 * numbers legitimately disagree in both directions. The SERVER answers it —
 * `endedBy: "beginning"` is issued only by a short page cut from one
 * snapshot, which is proof there is nothing older — and the client repeats
 * that answer rather than deriving its own.
 *
 * Single-slot for the same reason `chatHistoryLoad` is: the Flow renders one
 * conversation, and a per-chat map would let one conversation's reach be read
 * as another's.
 */

import { atom } from "nanostores";

import { registerContextReset, registerReset } from "./store-registry";

export type HistoryReach = Readonly<{
  readonly chatId: string;
  /** Older messages exist that this session has not fetched. */
  readonly hasOlder: boolean;
  /** The server's cursor for the page before the oldest one held. Present
   * exactly when `hasOlder` is true, so "there is more" and "here is how to
   * ask" cannot disagree. Opaque — the client never reads inside it. */
  readonly olderCursor: string | null;
  /** How many messages the conversation holds, COUNTED by the server. */
  readonly messageCount: number;
  /** How many of them this session has received. */
  readonly loaded: number;
  /** A page of older messages is in flight. */
  readonly loading: boolean;
  /**
   * Why the last attempt to reach further back did not land, in plain words,
   * or null. Kept beside `hasOlder` rather than replacing it: a failed page
   * does not make the older messages stop existing, and rendering "this is
   * the beginning" after a failed reach would be a fabricated absence.
   */
  readonly failure: string | null;
}>;

export const historyReach = atom<HistoryReach | null>(null);

/** The tail page landed: this is the reach it establishes. */
export function noteReachOpened(reach: Omit<HistoryReach, "loading" | "failure">): void {
  historyReach.set({ ...reach, loading: false, failure: null });
}

/** A page of older messages was asked for. No-op when the reach on record is
 * a different conversation's — a request that outlived its conversation must
 * not mark the current one busy. */
export function noteReachLoading(chatId: string): void {
  const current = historyReach.get();
  if (current === null || current.chatId !== chatId) return;
  historyReach.set({ ...current, loading: true, failure: null });
}

/** A page of older messages landed. `added` is what was really inserted (a
 * re-delivered message is dropped by the transcript, and the reach counts
 * what it holds, not what arrived). */
export function noteReachExtended(
  chatId: string,
  added: number,
  page: Readonly<{ hasOlder: boolean; olderCursor: string | null; messageCount: number }>,
): void {
  const current = historyReach.get();
  if (current === null || current.chatId !== chatId) return;
  historyReach.set({
    chatId,
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    messageCount: page.messageCount,
    loaded: current.loaded + added,
    loading: false,
    failure: null,
  });
}

/**
 * The reach did NOT extend. `hasOlder` and the cursor are left exactly as
 * they were: the messages are still there and the cursor still addresses
 * them, so the reader may press again. Only the fact that the attempt failed
 * is new.
 */
export function noteReachFailed(chatId: string, reason: string): void {
  const current = historyReach.get();
  if (current === null || current.chatId !== chatId) return;
  historyReach.set({ ...current, loading: false, failure: reason });
}

export function clearHistoryReach(): void {
  historyReach.set(null);
}

registerReset("chatHistoryReach", clearHistoryReach);
// A chat switch: reach describes ONE conversation, and carrying "12,000
// earlier messages" onto a conversation with four would be a number about
// something the reader is no longer looking at.
registerContextReset("chatHistoryReach", clearHistoryReach);
