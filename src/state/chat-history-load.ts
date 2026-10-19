/**
 * WHETHER THIS CONVERSATION COULD BE READ (DESIGN-PERFORMANCE §1 L3).
 *
 * The transcript store (`chat-messages.ts`) can only say how many messages it
 * holds. Zero is two different facts:
 *
 *   - the conversation genuinely has no messages, and
 *   - the conversation could not be read.
 *
 * Until this store existed the Flow could not tell them apart, so a history
 * read that timed out rendered "nothing recorded in this conversation yet".
 * That is the product asserting an absence it never measured — the same
 * fabricated-absence failure the whole product exists to prevent, arriving
 * through the performance door. Measured: a 21,405-message conversation is
 * 75.1MB / 34,665ms against a 30,000ms client timeout, so the request aborts
 * and the Flow rendered `beats: 0` with no error at all.
 *
 * The shape is the one every other surface already uses (custody-feed,
 * switch-feed, desk-feed, editor/feed): pending | measured | absent, with the
 * absence carrying PLAIN WORDS from the single `absenceReason` owner.
 *
 * Two rules this module encodes, both load-bearing:
 *
 *   1. An absence names WHAT IT COULD NOT REACH — the conversation, by the
 *      title the reader knows it by. "Something failed" is not honest
 *      absence; it is a shrug.
 *   2. The absence is STICKY until something happens. It is not cleared by a
 *      timer and it does not arm an automatic retry: the identical request
 *      that just failed the same way is not a recovery strategy, it is the
 *      same failure twice (measured: the UI fired the 34.7s request TWICE,
 *      both aborted). Re-entry is the honest retry, and it is a gesture the
 *      reader makes.
 */

import { atom } from "nanostores";

import { registerContextReset, registerReset } from "./store-registry";

export type ChatHistoryLoad =
  /** A read is in flight and nothing is known yet. */
  | Readonly<{ kind: "pending"; chatId: string }>
  /** The read landed. What the Flow shows IS the conversation. */
  | Readonly<{ kind: "measured"; chatId: string }>
  /**
   * The read did not land. `reason` is the plain-words why (from
   * `absenceReason`); `title` is what could not be reached, as the reader
   * names it — null only when the chat list itself is not loaded.
   */
  | Readonly<{ kind: "absent"; chatId: string; reason: string; title: string | null }>;

/**
 * The load state of the CURRENTLY SELECTED conversation's history, or null
 * when no read has been attempted for it. Single-slot deliberately: the Flow
 * renders one conversation, and a per-chat map would outlive the selection it
 * describes and let a stale absence be read as the current one.
 */
export const chatHistoryLoad = atom<ChatHistoryLoad | null>(null);

export function noteChatHistoryPending(chatId: string): void {
  chatHistoryLoad.set({ kind: "pending", chatId });
}

export function noteChatHistoryRead(chatId: string): void {
  chatHistoryLoad.set({ kind: "measured", chatId });
}

export function noteChatHistoryUnread(
  chatId: string,
  reason: string,
  title: string | null,
): void {
  chatHistoryLoad.set({ kind: "absent", chatId, reason, title });
}

export function clearChatHistoryLoad(): void {
  chatHistoryLoad.set(null);
}

registerReset("chatHistoryLoad", clearChatHistoryLoad);
// Also reset on chat switch: the state describes ONE conversation, and
// carrying "could not read" from the conversation you left onto the one you
// opened would be a fabricated absence of its own.
registerContextReset("chatHistoryLoad", clearChatHistoryLoad);
