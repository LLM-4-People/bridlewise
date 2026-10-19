/**
 * Conversation-history reconstruction — the single owner of the
 * DB projection → `ChatMessage[]` mapping used to give the LLM memory
 * of previous turns.
 *
 * Root cause of the memory bug: `run.ts` initialized `conversationHistory`
 * with ONLY the current prompt (`[{role:"user", content: prompt}]`), so
 * when the user sent a second message the LLM had no context of the first.
 * This module loads the chat's persisted messages from the DB, rebuilds
 * the full multi-turn history (user / assistant / tool), and appends the
 * current prompt last. The system prompt is NOT included here —
 * `streamChat` prepends it separately (it is rebuilt per-run from project
 * context), so putting it in the history would duplicate it.
 *
 * Tool-call reconstruction: the DB stores tool calls in a separate
 * `tool_calls` table linked to a "tool" role message by `message_id`. The
 * original LLM `callId` is not persisted (it is tracked only in-memory by
 * the run handler), so a stable synthetic id is synthesized from the
 * `tool_calls.id` (the DB row id) and used consistently for BOTH the
 * assistant's `tool_calls[].id` AND the tool result's `tool_call_id`.
 * The LLM only requires the two to match within one request, so a stable
 * synthesized id is valid (the original id is never seen again).
 *
 * Incomplete tool calls (status "running", null output) are omitted: an
 * assistant message with `tool_calls` MUST be followed by a `tool` message
 * for every `tool_call_id` (OpenAI API contract), so emitting tool_calls
 * without their results would produce an invalid sequence. When a tool
 * call is incomplete, the assistant is emitted as a plain content message
 * (or skipped if it has no content), keeping the sequence always valid.
 */

import { discardedMessageIdsForChat } from "../run/rewind.ts";
import type { ChatMessage } from "../llm/llm-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { MessageRow, ToolCallRow } from "../db/client.ts";

export type HistoryBuildOptions = Readonly<{
  /** The chat to load previous messages from. */
  readonly chatId: string;
  /** The current user prompt, appended LAST in the history. */
  readonly currentPrompt: string;
  /**
  * The owning user id (Single-Party-Owner: the DB reads are scoped by
   * userId so a run can never load another user's chat history). Threaded
   * from the run's authenticated user (run.ts → requireUserContext).
   */
  readonly userId: string;
  /**
  * Maximum number of prior messages to reconstruct (newest-first cap).
   * 0 or undefined = no cap (load all). Capping protects against context
   * overflow on very long chats; the progressive-context-management
   * feature will own intelligent trimming later.
   */
  readonly maxHistoryMessages?: number;
}>;

/**
 * Reconstruct the conversation history for an LLM request from the
 * persisted chat projection. Returns `ChatMessage[]` ordered:
 * [previous user/assistant/tool messages...] + [current user prompt]
 * The system prompt is intentionally absent (added by `streamChat`).
 *
 * The result is always a valid OpenAI message sequence:
 * every assistant with `tool_calls` is immediately followed by its
 * `tool` result messages (matching `tool_call_id`);
 * no orphaned `tool` messages;
 * no `error`/`system` roles leak into the LLM history.
 */
export async function buildConversationHistory(
  db: AsyncDbClient,
  options: HistoryBuildOptions,
): Promise<ChatMessage[]> {
  // Both reads are issued together: they are independent, they are on the
  // read pool, and serialising them would make one request wait for two round
  // trips where one would do.
  const [allMessages, toolCalls] = await Promise.all([
    db.listMessages(options.chatId, options.userId),
    db.listToolCallsByChat(options.chatId, options.userId),
  ]);
  const toolCallByMessage = new Map<string, ToolCallRow>();
  for (const tc of toolCalls) {
    toolCallByMessage.set(tc.message_id, tc);
  }

  // ── THE REWIND HONORING POINT (server/rewind.ts) ─────────────────────────
  // A withdrawn turn STOPS BEING SENT here, and only here. This is the one
  // function that turns persisted rows into the model's messages — the run
  // route and the context desk both call it — so a turn the user rewound
  // past cannot reach the provider through some other assembly, and the
  // desk's strips cannot claim a composition the request does not have.
  //
  // The rows themselves are untouched: they are still in `messages`, still
  // served by the history routes (flagged), still named by the ledger event
  // that withdrew them. Withdrawn is not deleted.
  const discarded = discardedMessageIdsForChat(options.chatId, options.userId);
  const messages = discarded.size === 0
    ? allMessages
    : allMessages.filter((m) => !discarded.has(m.id));

  // Apply a newest-first cap if configured: keep the most recent N
  // messages. The cap is applied to the raw message rows before
  // reconstruction so tool-call groupings are never split in the middle
  // (we slice from the start, preserving the tail intact).
  const capped = options.maxHistoryMessages !== undefined && options.maxHistoryMessages > 0
    ? messages.slice(-options.maxHistoryMessages)
    : messages;

  const history: ChatMessage[] = [];
  const n = capped.length;
  let i = 0;
  while (i < n) {
    const msg = capped[i]!;
    if (msg.role === "user") {
      history.push({ role: "user", content: msg.content });
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      // Look ahead for consecutive tool messages in the SAME run. They
      // are the results of THIS assistant's tool calls (created at
      // tool_call_start, which fires after the assistant "start" event).
      const collected: MessageRow[] = [];
      let j = i + 1;
      while (j < n) {
        const next = capped[j]!;
        if (next.role !== "tool" || next.run_id !== msg.run_id) break;
        collected.push(next);
        j += 1;
      }
      const completeToolCalls = collected
        .map((tm) => toolCallByMessage.get(tm.id))
        .filter((tc): tc is ToolCallRow => tc !== undefined && tc.output !== null && tc.output !== undefined);
      const hasCompleteResults = completeToolCalls.length === collected.length && collected.length > 0;
      if (hasCompleteResults) {
        // Emit the assistant message WITH tool_calls, then each tool
        // result. Synthetic tool_call_id = the tool_calls row id (stable
        // and consistent across both sides of the pairing).
        const toolCallsForHistory = completeToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.tool_name,
            arguments: serializeArguments(tc.input),
          },
        }));
        history.push({
          role: "assistant",
          content: msg.content,
          tool_calls: toolCallsForHistory,
        });
        for (const tc of completeToolCalls) {
          history.push({
            role: "tool",
            tool_call_id: tc.id,
            content: typeof tc.output === "string" ? tc.output : compactStringify(tc.output),
          });
        }
      } else if (msg.content.length > 0) {
        // No (complete) tool calls — emit as a plain assistant message.
        history.push({ role: "assistant", content: msg.content });
      }
      // An assistant with empty content and no complete tool calls is a
      // no-op turn (e.g. a cancelled mid-tool turn) — skip it so the
      // sequence stays clean.
      i = j;
      continue;
    }
    // "tool" messages are consumed by the assistant look-ahead above.
    // An orphaned tool message (no preceding assistant reconstructed)
    // would violate the API contract, so it is skipped, not emitted.
    // "error" and "system" roles are never part of the LLM history.
    i += 1;
  }

  // The current prompt is always LAST (per the task contract).
  history.push({ role: "user", content: options.currentPrompt });
  return history;
}

function serializeArguments(input: unknown): string {
  if (input === null || input === undefined) return "{}";
  if (typeof input === "string") return input;
  return compactStringify(input);
}

/**
 * Compact (no-indent) safe JSON serialization for STORAGE/transport of tool
 * call args + output. Distinct from the old tree's display `safeStringify`
 * (which indented for UI DISPLAY + mapped null→""; deleted at the cutover)
 * — this is the compact storage variant, named so the two never collided
 * (No Scattered Helpers).
 */
function compactStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
