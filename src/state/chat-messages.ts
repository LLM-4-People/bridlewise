/**
 * nanostores shared state: chat message log + streaming flag.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts (the sole
 * writer). Components read via $store auto-subscription.
 *
 * ChatMessage is the client-side view model for the conversation. Model and
 * tool output attached to messages is UNTRUSTED — components must render it
 * with Svelte's auto-escaping ({value}) and never {@html}.
 *
 * `setMessages` is the bulk-load path: client.ts calls it on chat switch
 * to hydrate the store from the DB history payload (one round-trip via
 * /api/chats/:id/history). The history payload is converted to
 * ChatMessage[] by client.ts; this store just receives the final list.
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import type { ModelEvent } from "../../shared/types";
import type { EventKind } from "../../shared/event-types.ts";
import { registerReset, registerContextReset } from "./store-registry";
// The dedup summary's one shape owner — the live snapshot, the message
// record and the beat all carry this type, never a restated copy.
import type { DedupSummary } from "./dedup.ts";
// The redaction notice's one shape owner — same rule: the live snapshot,
// the message record and the beat all carry this type.
import type { RedactionSummary } from "./redaction.ts";

// ── View models ──

export type ToolCallStatus = "running" | "done" | "error";

export type ToolCallView = Readonly<{
  readonly id?: string;
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: ToolCallStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  /** Why this call never reported a result — set by
   * `finalizeRunningToolCalls` when the run ended with the call still
   * "running" (SSE disconnect, server crash, a `tool_result` that never
   * arrived). This is a CLIENT OBSERVATION, deliberately kept out of
   * `output`: `output` means "what the tool returned", and writing a
   * synthesized sentence there made the UI present the client's guess as the
   * tool's own result. The renderer labels the two differently. */
  readonly incompleteReason?: string;
  /** TRUE when the recorded result is a REFUSAL record — the call was
   * refused before dispatch (the safety gate: a schema mismatch, a ghost
   * tool, a loop, a tripped/disabled tool) or the tool itself returned a
   * failure. Set ONLY where a real result landed (the live `tool_result`
   * frame, the ledger heal, the persisted row a reload rebuilds from) — a
   * stranded call's client-observed incompleteness is NOT a refusal, and
   * neither is a call still in flight. The artifact renderer keys its
   * "was the document accepted" decision on this typed fact, so a
   * gate-refused create_artifact holds the refusal instead of mounting
   * the document the gate declined to create. */
  readonly refused?: true;
  /** how many times this tool has been attempted in the current
   * run (retries included). Shown as "attempt N" on the tool card so the
   * user sees retries on the SAME card instead of N scattered cards. */
  readonly attemptCount?: number;
}>;

/**
 * What the duration owner actually reads. `ToolCallView` is the store's
 * shape; the flow's `ToolBody` carries the same four fields and is a legal
 * caller. Widening here is what lets the live tool beat ask the owner
 * without inventing a second duration path or casting through the store type.
 */
export type ToolCallDurationSource = Pick<
  ToolCallView,
  "status" | "startedAt" | "endedAt" | "durationMs"
>;

/**
 * The single owner of "how long did this tool call take". Returns the
 * MEASURED duration in ms, or `null` when no measurement exists — never a
 * synthesized stand-in (no fake data).
 *
 * Sources, in order of authority:
 *  1. `durationMs` — measured server-side and persisted with the tool-call
 *     row; the only source that survives a page refresh.
 *  2. `endedAt - startedAt` — measured client-side on the live stream.
 *  3. `now - startedAt` — a LIVE elapsed timer, valid only while the call is
 *     still running.
 *
 * A finished call with neither (1) nor (2) has no duration: rendering
 * `now - startedAt` for it reports the age of the transcript, not the work.
 *
 * The live branch CLAMPS at zero. The reader's clock tick and the call's
 * `startedAt` stamp come from different places, so for up to one tick `now`
 * can sit BEFORE the stamp (the pane's 1s `now` mid-call-start, the flow's
 * tool beat on its own tick) — an unclamped subtraction renders a NEGATIVE
 * elapsed, which is not a measurement any call earned. The run's own
 * elapsed figure clamps the same way; the clamp lives here so both
 * consumers get it from the one owner.
 *
 * Callers pass `now` explicitly so the function stays pure (Node-testable)
 * and so a component can drive it from its own reactive clock.
 */
export function toolCallDurationMs(tc: ToolCallDurationSource, now: number): number | null {
  if (tc.durationMs !== undefined) return tc.durationMs;
  if (tc.endedAt !== undefined) return tc.endedAt - tc.startedAt;
  if (tc.status === "running") return Math.max(0, now - tc.startedAt);
  return null;
}

export type TokenMetrics = Readonly<{
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}>;

export type TimingMetrics = Readonly<{
  /** Wall-clock when the "start" event was received (ms epoch). */
  readonly startedAt: number;
  /** Wall-clock when the first "text_delta" arrived (ms epoch). */
  readonly firstTokenAt?: number;
  /** Wall-clock when the "finish" event arrived (ms epoch). */
  readonly finishedAt?: number;
  /** Time to first token: firstTokenAt - startedAt (ms). */
  readonly ttftMs?: number;
  /** Total generation duration: finishedAt - startedAt (ms). */
  readonly totalMs?: number;
  /** Tokens per second: outputTokens / generationSeconds. */
  readonly tps?: number;
}>;

export type ChatRole = "user" | "assistant" | "tool" | "error" | "event";

/**
 * The kind of inline event shown in the chat when a hallucination, steering,
 * bias, self-healing, error, or UI control is detected. Stored in the
 * message metadata blob (eventKind field) so it survives a page refresh.
 *
 * `EventKind` is the canonical vocabulary owned by
 * `shared/event-types.ts` (the single zod schema + derived type).
 * Imported above + re-exported here so existing
 * `import { type EventKind } from "./chat-messages"` call sites keep
 * working; the shape is derived from the zod schema (a server change
 * auto-propagates to the client type — no manual mirror to drift). 
 * was a 6-value inline union that drifted from the server's 4-value /
 * 5-value / any-string definitions.
 */
export type { EventKind };

/**
 * The injected context for a run: the system prompt sent to the model, the
 * available tools, and how much conversation history was included. Sent
 * once per run via the "context" SSE event so the user can inspect exactly
 * what was sent to the model (expose-everything). Shown in a collapsible
 * "Context" section on the assistant message.
 */
export type RunContext = Readonly<{
  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
  readonly historyLength: number;
  readonly modelId?: string;
  /** Tokens consumed by the assembled request (system prompt + trimmed
   * history + the tool schemas the request carries beside the messages)
   * for this run — the per-call cost the provider bills, so the gauge's
   * fill is the true one. Shown on the Metrics → Context section. */
  readonly contextTokens?: number;
  /** The history channel alone (the trimmed conversation the manager
   * sent) — the portion the context limit's trim budget actually governs,
   * served beside the total so the two facts stay distinguishable. */
  readonly historyTokens?: number;
  /** The context manager's soft token limit for this run. */
  readonly contextTokenLimit?: number;
  /** Whether the context manager trimmed/evicted older turns to fit the
   * limit this run (compression/eviction was active). */
  readonly contextTrimmed?: boolean;
  /** How many memories were retrieved + injected into the system prompt
   * for this run (cross-run/cross-chat recall). */
  readonly recalledMemoryCount?: number;
}>;

export type ChatMessage = Readonly<{
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly toolCall?: ToolCallView;
  readonly timestamp: number;
  readonly modelEvent?: ModelEvent;
  readonly tokenMetrics?: TokenMetrics;
  readonly timingMetrics?: TimingMetrics;
  /** The model's reasoning/thinking (streamed before the answer). Shown in
   * a collapsible "Thinking" section so the user can inspect the chain of
   * thought. Accumulated from `reasoning_delta` events. */
  readonly reasoning?: string;
  /** Response headers from the LLM API (rate limits, request id, model id,
   * …). Shown in a collapsible "Headers" section. From the `headers` event. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** The actual model that responded (may differ from the requested model
   * when failover/fixed by the provider). From the `model` event. */
  readonly responseModel?: string;
  /**
   * The trace id of the HTTP request that produced this turn — the address
   * of every ledger event that request recorded. From the `metadata` frame;
   * persisted in the message metadata so it survives a page refresh.
   */
  readonly traceId?: string;
  /** The finish reason for this turn (stop, length, tool_calls, …). From
   * the `finish` event. */
  readonly finishReason?: string;
  /**
   * Why this turn never reported an answer — the hydrate reconcile's verdict
   * for an assistant row that started, streamed to a reader, and whose run
   * then ended without ever keeping a word or recording an ending (a server
   * death mid-stream, a cancel, any exit that wrote no terminal mark). A
   * CLIENT OBSERVATION in the tool call's `incompleteReason` sense: never
   * persisted, re-derived by the reconcile at every hydrate, and never
   * written into `content` — a synthesized sentence there would read as the
   * model's own words. Renders as the turn's quiet ending line.
   */
  readonly incompleteReason?: string;
  /** The injected context for this run (system prompt, tools, history
   * length). From the "context" SSE event. Shown in a collapsible
   * "Context" section so the user can inspect what was sent to the model. */
  readonly context?: RunContext;
  /**
   * How much of THIS call's input the dedup layer folded before the
   * request (chars before/after, pct, blocks removed). From the "dedup"
   * SSE event, buffered and attached when the turn opens (the context
   * event's own arrival shape) and persisted in the message metadata so
   * the turn's footer shows the same savings live and reloaded. Absent
   * when the call removed nothing — absence, never a zero.
   */
  readonly dedupSummary?: DedupSummary;
  /**
   * What THIS call's input had masked before the request left the machine
   * (how many values, split by confidence, the already-hidden-upstream
   * count, and a value-free reason per span). From the "redaction" SSE
   * event, buffered and attached when the turn opens (the context event's
   * own arrival shape) and persisted in the message metadata so the turn's
   * footer shows the same masking face live and reloaded. Absent when the
   * call masked nothing — absence, never a zero.
   */
  readonly redactionNotice?: RedactionSummary;
  /** For role="event" messages: the event kind (hallucination, steering,
   * bias, self-healing, error). Determines the icon + color styling. */
  readonly eventKind?: EventKind;
  /**
   * For recorded event/error messages: the CANONICAL ledger event this message IS
   * (the eventId the recording run returned). INTERNAL — a ledger address
   * consumed by the documents door, never rendered text. Absent when the
   * event was never recorded in a ledger (client-side errors) or was
   * recorded before the field existed.
   */
  readonly timelineEventId?: string;
  /** The run that produced this row, when known. */
  readonly runId?: string;
  /** The recorded failure taxonomy, used to derive its display sentence. */
  readonly errorCode?: string;
  /**
   * TRUE when this user message was sent while this conversation's run was
   * LIVE — it queued for the run's next turn rather than starting a run of
   * its own (the composer's steer routing). Live-session state, deliberately
   * NOT persisted: the durable trace of the same fact is the `steering`
   * inline EVENT the executor records when it consumes the instruction
   * (whether the next turn composes it or the drain starts one for it),
   * which survives the refresh; a reloaded transcript honestly shows the
   * message plus that event, not a marking only this session knew.
   */
  readonly steered?: boolean;
}>;

/**
 * The durable metadata blob persisted on each assistant message so the
 * full chat exposure survives a page refresh. This is the client-side
 * authority for the persisted metadata shape; the server's
 * `server/db/schema.ts` MESSAGE_METADATA is the wire/validation authority
 * and must stay structurally identical. `hydrateChatFromHistory` spreads
 * these fields back onto the ChatMessage on reload.
 */
export type MessageMetadata = Readonly<{
  readonly reasoning?: string;
  readonly tokenMetrics?: TokenMetrics;
  readonly timingMetrics?: TimingMetrics;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseModel?: string;
  readonly traceId?: string;
  readonly finishReason?: string;
  readonly context?: RunContext;
  readonly dedupSummary?: DedupSummary;
  readonly redactionNotice?: RedactionSummary;
  /** For role="event" messages: the event kind, persisted so inline
   * events survive a page refresh. */
  readonly eventKind?: EventKind;
  /**
   * For role="event" messages: the CANONICAL ledger event this message IS
   * (the eventId the recording run returned). INTERNAL — a ledger address
   * consumed by the documents door, never rendered text. Persisted so the
   * documents fold survives a page refresh. Structurally identical to the
   * server's MESSAGE_METADATA.timelineEventId (the wire authority).
   */
  readonly timelineEventId?: string;
  /**
   * For role="error" rows: the failure's own taxonomy code. Persisted by the
   * run's error projection so a re-attach's REPLAYED error event can tell
   * its own row from a different failure with the same words (see
   * `appendErrorMessage`'s join arm). Structurally identical to the
   * server's MESSAGE_METADATA.errorCode (the wire authority).
   */
  readonly errorCode?: string;
}>;

// ── Stores ──

export const messages = atom<readonly ChatMessage[]>([]);
export const isStreaming = atom<boolean>(false);

export const messageCount: ReadableAtom<number> = computed(
  messages,
  (list) => list.length,
);

export const lastMessage: ReadableAtom<ChatMessage | null> = computed(
  messages,
  (list) => list[list.length - 1] ?? null,
);

// ── Last run context (single owner of "find the last run's injected context") ──
// SPO (No Scattered Helpers): the "iterate messages backwards to find
// the last assistant message carrying a `context` blob" logic was
// duplicated in ContextGauge.svelte + MetricsDashboard.svelte. Both
// computed the same thing with their own loop — a near-duplicate body
// This derived store is the SINGLE owner: both consumers read
// `$lastRunContext` instead of iterating the message list themselves
// (Relieve Responsibilities — the consumers no longer carry the lookup
// logic; adding a third consumer is one import, not a third loop).
// Returns the last RunContext whose `contextTokens` is defined (the
// context SSE event always carries it; a context without tokens is not
// useful for the gauge/dashboard).
export const lastRunContext: ReadableAtom<RunContext | null> = computed(
  messages,
  (list) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const ctx = list[i]!.context;
      if (ctx !== undefined && ctx.contextTokens !== undefined) return ctx;
    }
    return null;
  },
);

/**
 * The measured context PERCENTAGE of a run's report, as the ONE derivation
 * every consumer reads (the closed-desk gauge, the ARM context triggers).
 * Null when the report carries no usable pair — absence, never a fake 0%,
 * so a context-crossing trigger cannot fire on a number nobody measured.
 */
export function contextPctOf(ctx: RunContext): number | null {
  if (ctx.contextTokens === undefined || ctx.contextTokenLimit === undefined) {
    return null;
  }
  if (ctx.contextTokenLimit <= 0) return null;
  return Math.round((ctx.contextTokens / ctx.contextTokenLimit) * 100);
}

// ── Conversation summary (aggregate metrics for the current chat) ──

export type ConversationSummary = Readonly<{
  readonly messageCount: number;
  readonly userMessageCount: number;
  readonly assistantMessageCount: number;
  readonly toolCallCount: number;
  readonly errorCount: number;
  readonly eventCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly avgTtftMs: number;
  readonly avgTps: number;
}>;

export const conversationSummary: ReadableAtom<ConversationSummary> = computed(
  messages,
  (list) => {
    let userCount = 0;
    let assistantCount = 0;
    let toolCount = 0;
    let errorCount = 0;
    let eventCount = 0;
    let totalIn = 0;
    let totalOut = 0;
    let totalTokens = 0;
    let totalDuration = 0;
    let ttftSum = 0;
    let ttftCount = 0;
    let tpsSum = 0;
    let tpsCount = 0;

    for (const msg of list) {
      switch (msg.role) {
        case "user":
          userCount++;
          break;
        case "assistant":
          assistantCount++;
          if (msg.tokenMetrics) {
            totalIn += msg.tokenMetrics.inputTokens;
            totalOut += msg.tokenMetrics.outputTokens;
            totalTokens += msg.tokenMetrics.totalTokens;
          }
          if (msg.timingMetrics) {
            if (msg.timingMetrics.totalMs !== undefined)
              totalDuration += msg.timingMetrics.totalMs;
            if (msg.timingMetrics.ttftMs !== undefined) {
              ttftSum += msg.timingMetrics.ttftMs;
              ttftCount++;
            }
            if (msg.timingMetrics.tps !== undefined) {
              tpsSum += msg.timingMetrics.tps;
              tpsCount++;
            }
          }
          break;
        case "tool":
          toolCount++;
          break;
        case "error":
          errorCount++;
          break;
        case "event":
          eventCount++;
          break;
      }
    }

    return {
      messageCount: list.length,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      toolCallCount: toolCount,
      errorCount,
      eventCount,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalTokens,
      totalDurationMs: totalDuration,
      avgTtftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
      avgTps: tpsCount > 0 ? Math.round((tpsSum / tpsCount) * 10) / 10 : 0,
    };
  },
);

// ── Internal id generation (deterministic + unique enough for UI) ──

let messageCounter = 0;
// The in-flight tail and its model cursor have one owner. The cursor names
// the durable assistant row, so history arriving during replay cannot retarget
// tokens to whichever row happens to be last. No per-attachment registry.
let activeModelFrame: { messageId: string; runId: string; event: ModelEvent; settled: boolean } | null = null;

function newMessageId(): string {
  messageCounter += 1;
  return `msg-${messageCounter.toString(36)}-${Date.now().toString(36)}`;
}

// ── Ingestion (called only by client.ts) ──

export function appendMessage(message: ChatMessage): string {
  messages.set([...messages.get(), message]);
  return message.id;
}

/**
 * Take back ONE message the client appended — the send it optimistically
 * recorded was REFUSED by the server, so the row was never a fact: nothing
 * was persisted (a refused run-start writes no message), and leaving the
 * optimistic row in the store kept a client-only beat on screen that a
 * reload would silently erase — the reader's words visible exactly until
 * they mattered. The inverse of `appendMessage`, owned beside it: one
 * writer module for the transcript. Returns whether a row was withdrawn, so
 * a caller can tell a real unwind from a double one.
 */
export function withdrawMessage(id: string): boolean {
  const list = messages.get();
  const without = list.filter((m) => m.id !== id);
  if (without.length === list.length) return false;
  messages.set(without);
  return true;
}

export function appendUserMessage(content: string, steered = false): string {
  return appendMessage({
    id: newMessageId(),
    role: "user",
    content,
    timestamp: Date.now(),
    ...(steered ? { steered: true } : {}),
  });
}

/**
 * Take back ONE message's steered marking — the steer POST was refused, so
 * the queued-state claim the marking would render ("the model receives this
 * after the current turn") never became true: the route persists the
 * instruction only on success, and the marking itself is live-session state
 * (see `ChatMessage.steered`), so a reload would already have dropped it
 * while the live view kept claiming a delivery that never happened. The
 * message STAYS — it is the reader's own visible words — only without the
 * marking. The inverse of `appendUserMessage`'s `steered` flag, owned beside
 * it for the same reason: one writer module for the marking.
 */
export function unmarkSteeredMessage(id: string): void {
  messages.set(
    messages.get().map((m) => {
      if (m.id !== id || m.steered !== true) return m;
      const { steered: _unmarked, ...rest } = m;
      return rest;
    }),
  );
}

export function appendAssistantMessage(
  content: string,
  modelEvent?: ModelEvent,
): string {
  const id = activeModelFrame?.messageId ?? newMessageId();
  if (messages.get().some((message) => message.id === id)) return id;
  const msg: ChatMessage =
    modelEvent !== undefined
      ? { id, role: "assistant", content, timestamp: Date.now(), modelEvent }
      : { id, role: "assistant", content, timestamp: Date.now() };
  return appendMessage(activeModelFrame === null ? msg : { ...msg, runId: activeModelFrame.runId, modelEvent: activeModelFrame.event });
}

export function appendToolCall(
  toolCall: ToolCallView,
  content = "",
  identity?: Readonly<{ messageId: string; runId: string; event: ModelEvent }>,
): string {
  const existing = messages.get().find((message) =>
    message.id === identity?.messageId ||
    (toolCall.id !== undefined && message.role === "tool" && message.runId === identity?.runId && message.toolCall?.id === toolCall.id));
  if (existing !== undefined) return existing.id;
  return appendMessage({
    id: identity?.messageId ?? newMessageId(),
    role: "tool",
    content,
    toolCall,
    timestamp: Date.now(),
    ...(identity !== undefined ? { runId: identity.runId, modelEvent: identity.event } : {}),
  });
}

/** Accept each model frame once at the transcript's existing write door.
 * The model's sequence is scoped to its durable assistant row. A saved
 * ending supersedes replayed partial output; distinct row IDs stay distinct. */
export function acceptModelFrame(runId: string, messageId: string | undefined, event: ModelEvent): boolean {
  if (messageId === undefined) {
    if (activeModelFrame !== null) commitStreamingTail();
    activeModelFrame = null;
    return true;
  }
  let previousSequence = activeModelFrame?.event.sequence;
  if (activeModelFrame?.messageId !== messageId) {
    commitStreamingTail();
    const recorded = messages.get().find((message) => message.id === messageId);
    previousSequence = recorded?.modelEvent?.sequence;
    activeModelFrame = {
      messageId, runId, event: recorded?.modelEvent ?? event,
      settled: recorded?.finishReason !== undefined,
    };
  }
  if (previousSequence !== undefined && event.sequence <= previousSequence) return false;
  activeModelFrame.event = event;
  return !activeModelFrame.settled ||
    (event.type !== "start" && event.type !== "text_delta" && event.type !== "reasoning_delta" && event.type !== "tool_call_delta" && event.type !== "finish");
}

/** The shared live/history equality door for a recorded incident. */
export function recordedMessageForEvent(
  list: readonly ChatMessage[],
  timelineEventId: string | undefined,
): ChatMessage | undefined {
  // Wording and position describe an event; only its recorder's ID proves
  // identity. Anonymous observations never acquire an inferred association.
  return timelineEventId === undefined
    ? undefined
    : list.find((message) => message.timelineEventId === timelineEventId);
}

export function appendErrorMessage(
  message: string,
  failure?: Readonly<{ runId: string; code: string }>,
  timelineEventId?: string,
): string {
  const existing = recordedMessageForEvent(messages.get(), timelineEventId);
  if (existing !== undefined) return existing.id;
  return appendMessage({
    id: newMessageId(),
    role: "error",
    content: message,
    timestamp: Date.now(),
    // The row retains the recorded failure taxonomy beside its display projection.
    ...(failure !== undefined
      ? {
          runId: failure.runId,
          errorCode: failure.code,
        }
      : {}),
    ...(timelineEventId !== undefined ? { timelineEventId } : {}),
  });
}

/** Append an inline event, joining only redeliveries of its canonical ID. */
export function appendEventMessage(
  kind: EventKind,
  content: string,
  timelineEventId?: string,
): string {
  const existing = recordedMessageForEvent(messages.get(), timelineEventId);
  if (existing !== undefined) return existing.id;
  return appendMessage({
    id: newMessageId(),
    role: "event",
    content,
    timestamp: Date.now(),
    eventKind: kind,
    // The canonical ledger address of the event this message IS — carried
    // (never rendered) so the documents fold can reach the record. Absent
    // for events that were never recorded (client-side errors).
    ...(timelineEventId !== undefined ? { timelineEventId } : {}),
  });
}

/**
 * The in-flight assistant text.
 *
 * WHY STREAMING TEXT IS NOT IN `messages`
 *
 * Appending a token used to call `updateLastMessage`, which copies the ENTIRE
 * message array (`slice(0,-1)` + push + `set`). That single write then fanned
 * out: `conversationSummary` is a `computed` over `messages`, so every token
 * re-derived twelve aggregates across all N messages; the render list was
 * rebuilt from scratch; and the keyed each-block diffed the whole transcript.
 * One token cost O(N) four times over, and the cost grew with the length of
 * the conversation — exactly backwards.
 *
 * Nothing about a token actually changes the message ARRAY: no message is
 * added, removed or reordered, and no aggregate the summary computes depends
 * on the in-flight text. Only one string grows. Holding that string in its own
 * atom makes the append O(1): the sole subscriber is the component rendering
 * the tail, `messages` stays referentially stable, and the summary does not
 * recompute at all.
 *
 * The tail is folded back into the last assistant message when the stream
 * finishes (`commitStreamingTail`), so the persisted transcript shape is
 * unchanged and every existing consumer of `messages` still sees the finished
 * text exactly as before.
 */
export const streamingTail = atom<string>("");

/** Append a token to the in-flight text. O(1) — one small atom write. */
export function appendStreamingTail(delta: string): void {
  streamingTail.set(streamingTail.get() + delta);
}

/**
 * Fold the accumulated tail into the last ASSISTANT message and clear it.
 * Called once when the stream ends, so the array is rewritten ONCE per
 * response rather than once per token. Idempotent: a second call with an
 * empty tail is a no-op (so it can be called from several stream-terminating
 * paths without duplicating text).
 *
 * The target is the last message with role "assistant" — NOT simply the last
 * message. A turn that streams text and then calls a tool ends with tool
 * messages appended after the assistant message, so keying on `list[len-1]`
 * found a "tool" row, bailed out — and, because the tail atom had ALREADY
 * been cleared, silently destroyed the model's text at the exact moment the
 * turn finished. Data loss, and it hit the most common shape of turn there
 * is ("I'll check that" → tool call).
 */
export function commitStreamingTail(): void {
  const tail = streamingTail.get();
  if (tail === "") return;
  const list = messages.get();
  let target = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]!.role === "assistant") {
      target = i;
      break;
    }
  }
  // Clear only once the text has somewhere to go. `ingestTextDelta`
  // guarantees an assistant message exists before any tail accumulates, so
  // this is an invariant violation, not a routine branch — keeping the tail
  // preserves the text instead of dropping it.
  if (target === -1) return;
  streamingTail.set("");
  const next = list.slice();
  const msg = next[target]!;
  next[target] = { ...msg, content: msg.content + tail, ...(activeModelFrame !== null ? { modelEvent: activeModelFrame.event } : {}) };
  messages.set(next);
}

/**
 * Classify a timeline event (by eventType + description) into an inline
 * EventKind, or null if the event is not relevant for inline chat display.
 * Shared by the SSE handler (live events) and history hydration (persisted
 * timeline refs) so the two paths use the same mapping (DRY).
 *
 * Mirrors the category mapping in timeline-categories.ts but returns the
 * coarser EventKind used for inline chat styling (5 kinds vs 17 categories).
 */
export function classifyInlineEvent(
  eventType: string,
  description: string,
): EventKind | null {
  const lowerDesc = description.toLowerCase();
  // Gate-block kinds (must run before generic error check — a gate block
  // persists as eventType "error"). A gate block's label names its ACTUAL
  // kind: the canonical gate's messages carry the distinguishing substrings,
  // so the reconstruction reads them back rather than flattening every block
  // to "hallucination". Schema validation is a validation block, not a
  // hallucination; a repeated-call block is a loop, not a hallucination.
  if (
    eventType === "validation" ||
    lowerDesc.includes("failed schema validation")
  ) {
    return "validation";
  }
  if (eventType === "loop" || lowerDesc.includes("looks like a loop")) {
    return "loop";
  }
  // Hallucination detection (must run before generic error check).
  if (
    eventType === "hallucination" ||
    lowerDesc.includes("hallucinat") ||
    lowerDesc.includes("ghost tool") ||
    lowerDesc.includes("schema mismatch")
  ) {
    return "hallucination";
  }
  // Generic error (after hallucination).
  if (eventType === "error" || eventType === "self-protection-violation") {
    return "error";
  }
  // Steering.
  if (
    eventType === "steering" ||
    eventType === "steer" ||
    lowerDesc.includes("steer")
  ) {
    return "steering";
  }
  // Bias detection.
  if (
    eventType === "bias" ||
    lowerDesc.includes("bias detect") ||
    lowerDesc.includes("bias found")
  ) {
    return "bias";
  }
  // Self-healing.
  if (
    eventType === "promotion" ||
    eventType === "auto-heal" ||
    eventType === "self-heal" ||
    lowerDesc.includes("auto-heal") ||
    lowerDesc.includes("self-heal") ||
    lowerDesc.includes("stale inventory")
  ) {
    return "self-healing";
  }
  // Event-feed safety findings persist as timeline "quality" events whose
  // message carries the owner's stable "Safety finding (…)" marker.
  if (lowerDesc.includes("safety finding")) {
    return "safety-finding";
  }
  return null;
}

export function updateLastMessage(
  updater: (msg: ChatMessage) => ChatMessage,
): void {
  const list = messages.get();
  const last = list[list.length - 1];
  if (!last) return;
  const next = list.slice(0, -1);
  next.push(updater(last));
  messages.set(next);
}

/**
 * Update the last ASSISTANT message, wherever it sits.
 *
 * `updateLastMessage` with a role guard inside the updater looks like the
 * same thing and is not: when a turn's tail is a TOOL card (every turn with
 * tool calls), the guard makes the whole update a SILENT NO-OP. That is
 * exactly how the live `usage` frame was dropped — the provider sends usage
 * after the tool messages exist, the guard saw a tool card, and the footer
 * claimed "tokens not measured" for a turn whose usage the stream had
 * delivered (the history path, which maps by row, showed the same turn's
 * real numbers after a refresh). This walks back to the message the fact
 * belongs to instead of testing whichever message happens to be last.
 */
export function updateLastAssistantMessage(
  updater: (msg: ChatMessage) => ChatMessage,
): void {
  const list = messages.get();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]!.role !== "assistant" || (activeModelFrame !== null && list[i]!.id !== activeModelFrame.messageId)) continue;
    const next = [...list];
    next[i] = updater({ ...list[i]!, ...(activeModelFrame !== null ? { modelEvent: activeModelFrame.event } : {}) });
    messages.set(next);
    return;
  }
}

/**
 * Update the tool-call message identified by `callId` (the stable id from
 * the `tool_call_start` event). This is the CORRECT way to update a tool
 * call — `updateLastMessage` is unsafe when multiple tool calls are in
 * flight because the "last" message may belong to a different tool.
 *
 * FIX (exp510): `ingestToolCallDone` and `ingestToolResult` previously
 * used `updateLastMessage`, so when the LLM called N tools in one turn,
 * every result was applied to the Nth tool message. Tools 1..N-1 stayed
 * "running" forever. Matching by callId fixes this for any N.
 */
export function updateToolCallById(
  callId: string,
  updater: (tc: ToolCallView) => ToolCallView,
  runId?: string,
): void {
  const list = messages.get();
  let next: (typeof list)[number][] | undefined;
  for (let i = 0; i < list.length; i += 1) {
    const msg = list[i]!;
    if (msg.role === "tool" && msg.toolCall !== undefined && msg.toolCall.id === callId && (runId === undefined || msg.runId === undefined || msg.runId === runId)) {
      const toolCall = updater(msg.toolCall);
      if (toolCall === msg.toolCall) continue;
      next ??= list.slice();
      next[i] = { ...msg, toolCall };
    }
  }
  if (next !== undefined) messages.set(next);
}

/**
 * Safety net: mark every tool call still in "running" status as "error".
 * Called when the SSE "done" event fires (the run is complete). A tool
 * still "running" at that point never received its `tool_result` event
 * (e.g. SSE disconnect, server crash, or a tool_call_done that was never
 * synthesized because the provider returned a non-"tool_calls" finish
 * reason). Without this, such tools stay "running" forever — the exact
 * bug the user reported ("stuck at running even tho I am pretty sure it
 * is done").
 *
 * Returns the count of finalized tools so the caller can log it.
 */
export function finalizeRunningToolCalls(reason: string): number {
  const list = messages.get();
  let count = 0;
  const next = list.map((msg) => {
    if (msg.role === "tool" && msg.toolCall !== undefined && msg.toolCall.status === "running") {
      count++;
      return {
        ...msg,
        toolCall: {
          ...msg.toolCall,
          status: "error" as const,
          endedAt: Date.now(),
          // `output` is NOT synthesized here. The tool returned nothing, and
          // writing "Tool did not complete: …" into the output field made the
          // card present the client's inference as the tool's own result. The
          // reason is a separate, honestly-labelled field.
          incompleteReason: reason,
        },
      };
    }
    return msg;
  });
  if (count > 0) messages.set(next);
  return count;
}

/**
 * One row of the ledger read-back (`GET /api/chats/:id/tool-calls`) — the
 * fields the heal consumes. Structural (no import from client.ts, which
 * imports this store): the caller passes the rows it fetched.
 */
export type ToolCallLedgerRow = Readonly<{
  /** The DB row's own id, used when the provider supplied no callId. */
  readonly id?: string;
  /** The provider's stable callId — the SAME identifier a live card's
   * `toolCall.id` carries (from `tool_call_start`). The join key. NULL on
   * rows recorded before the server persisted it (those cannot join, and
   * their cards keep the honest placeholder). */
  readonly callId: string | null;
  readonly status: "running" | "done" | "error";
  readonly output: unknown;
  readonly durationMs: number | null;
  readonly attemptCount: number;
  /** The DISPATCHED arguments the run persisted for this call — the row's
   * own record of what the tool RAN (merged whole when the gate repaired a
   * partial). Optional because the heal's contract predates it; a row that
   * carries a non-null input heals the card's input too, so a stranded
   * gate-repaired call renders its artifact instead of the delta the
   * model sent. */
  readonly input?: unknown;
}>;

/**
 * Heal stranded tool-call cards from the ledger read-back, run-end.
 *
 * THE DEFECT THIS CLOSES: a tool call's card is created from its
 * `tool_call_start` frame, but its RESULT frame can fail to reach the client
 * — the SSE replay buffer evicted it (a run long enough to cross the frame
 * cap), the connection dropped, or the result arrived after the client
 * stopped applying. `finalizeRunningToolCalls` then marks the card "error"
 * with an `incompleteReason`, and the card renders the placeholder — "no
 * result — the run completed without this tool returning a result (client
 * observation, not the tool's output)" — while the DB holds the call's REAL
 * result (the incident: a gate-blocked call whose recorded refusal sat in
 * the ledger behind a card that claimed no result existed).
 *
 * THE RULE: the ledger is the authority. A card whose local state is the
 * placeholder condition (`incompleteReason` set) and whose ledger row
 * carries a RECORDED result (a settled status + a non-null output) is
 * healed from that row — status, output, duration, attempt count — and the
 * client observation is withdrawn. A row with no output is an honest
 * absence and is NEVER healed: the placeholder then means exactly what it
 * says — no result in the ledger either. A row still "running" heals
 * nothing (nothing to heal from yet).
 *
 * Returns the number of cards healed so the caller can report it.
 */
export function healStrandedToolCallsFromLedger(rows: readonly ToolCallLedgerRow[]): number {
  if (rows.length === 0) return 0;
  const byCallId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.callId !== null) byCallId.set(r.callId, r);
  }
  const list = messages.get();
  let healed = 0;
  const next = list.map((msg) => {
    if (
      msg.role !== "tool" ||
      msg.toolCall === undefined ||
      msg.toolCall.incompleteReason === undefined ||
      msg.toolCall.id === undefined
    ) {
      return msg;
    }
    const row = byCallId.get(msg.toolCall.id);
    // Deny by default: no row, a row still running, or a row with no
    // recorded output all leave the placeholder exactly as it was.
    if (row === undefined || row.status === "running" || row.output === null || row.output === undefined) {
      return msg;
    }
    healed += 1;
    // The ledger has spoken; the client observation is withdrawn with the
    // key, not overwritten with `undefined` (the view type is exact-optional).
    const { incompleteReason: _observed, ...rest } = msg.toolCall;
    void _observed;
    return {
      ...msg,
      toolCall: {
        ...rest,
        status: row.status,
        output: row.output,
        // The row's own record of what RAN — the dispatched arguments. A
        // stranded card's input is whatever the model-event ingest set (the
        // delta the model sent), so a gate-repaired call heals its input
        // too or the healed card renders the same unreachable document the
        // frame path fixed. Absent/null on a row: keep the card's input.
        ...(row.input !== null && row.input !== undefined ? { input: row.input } : {}),
        ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
        ...(row.attemptCount !== undefined ? { attemptCount: row.attemptCount } : {}),
        // A healed FAILURE with a recorded output is a real refusal record
        // (a gate block or the tool's own error) — the same typed fact the
        // live result frame sets.
        ...(row.status === "error" ? { refused: true as const } : {}),
      },
    };
  });
  if (healed > 0) messages.set(next);
  return healed;
}

/**
 * Settle a HYDRATED tool card that still shows "working" from the ledger
 * read-back — the reload-orphan heal (UIE-042).
 *
 * THE DEFECT THIS CLOSES: a page reloaded mid-run never re-attaches to the
 * live run's SSE, so the frames that settle in-flight beats — the
 * `tool_result` frames and the terminal frame the client's own safety net
 * (`finalizeStrandedToolCalls`) hangs from — never arrive. Measured live:
 * eight beats at "◍ working Ns" with climbing clocks 5+ minutes after the
 * server-side run had closed; the rows it was rebuilt from were persisted
 * "running" and nothing ever re-read them.
 *
 * THE LEDGER IS THE AUTHORITY, the same rule the run-end heal obeys, read
 * through the same bounded route. For each hydrated card still "running":
 *
 *   - a row that is now TERMINAL with a recorded output settles the card
 *     with that output (a real result the stream never delivered);
 *   - a row that is TERMINAL with NO output settles the card as the honest
 *     incomplete — the server's own finalize writes status without output,
 *     and the reason names what is known without inventing a tool answer;
 *   - a row still "running" settles nothing (the run is live server-side,
 *     the working face is true) and is COUNTED, so the caller can keep
 *     reconciling until the run's guaranteed end.
 *
 * The join accepts the provider callId and the DB row id used when a
 * provider supplied no callId. Deny-by-default on both — a card with
 * no row keeps its working face exactly as it was.
 */
export function settleHydratedRunningToolCalls(
  rows: readonly ToolCallLedgerRow[],
  incompleteReason: string,
): Readonly<{ settled: number; stillRunning: number }> {
  if (rows.length === 0) return { settled: 0, stillRunning: 0 };
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    // Prefer the shared provider ID; retain rows with no provider ID too.
    // Neither may overwrite the other's entry when both are present.
    if (r.id !== undefined && !byKey.has(r.id)) byKey.set(r.id, r);
    if (r.callId !== null && !byKey.has(r.callId)) byKey.set(r.callId, r);
  }
  const list = messages.get();
  let settled = 0;
  let stillRunning = 0;
  let changed = false;
  const next = list.map((msg) => {
    if (msg.role !== "tool" || msg.toolCall === undefined || msg.toolCall.id === undefined) {
      return msg;
    }
    if (msg.toolCall.status !== "running") return msg;
    const row = byKey.get(msg.toolCall.id);
    // No row, or a row still running: the run is live server-side (or the
    // row predates the join key) — the working face stands.
    if (row === undefined || row.status === "running") {
      stillRunning += 1;
      return msg;
    }
    settled += 1;
    changed = true;
    const recorded = row.output !== null && row.output !== undefined && row.output !== "";
    // A terminal row WITH output carries the result the stream never
    // delivered — adopt it (and the row's own record of the dispatched
    // arguments, the same adoption the run-end heal makes). Without output,
    // the output field stays empty and the reason says what is known —
    // never a fabricated tool answer.
    const settledTool: typeof msg.toolCall = recorded
      ? {
          ...msg.toolCall,
          status: row.status,
          output: row.output,
          endedAt: Date.now(),
          ...(row.input !== null && row.input !== undefined ? { input: row.input } : {}),
          ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
          ...(row.attemptCount !== undefined ? { attemptCount: row.attemptCount } : {}),
          // A terminal FAILURE with a recorded output is a real refusal
          // record — the same typed fact the live result frame sets.
          ...(row.status === "error" ? { refused: true as const } : {}),
        }
      : {
          ...msg.toolCall,
          status: "error" as const,
          endedAt: Date.now(),
          incompleteReason,
        };
    return { ...msg, toolCall: settledTool };
  });
  if (changed) messages.set(next);
  return { settled, stillRunning };
}

/**
 * Is this an assistant row whose turn STARTED and never ended, on the
 * record's own evidence? The exact shape a hydrate rebuilds from a run that
 * died server-side mid-stream (a dev-server crash, a power loss, a deploy —
 * or a cancel, which writes no terminal mark either): the run's "start"
 * created the row empty, the words lived only in the dead process's memory
 * (text is persisted at finish, never incrementally), no `finish` event ever
 * stamped a finish reason, and no error row carries the failure.
 *
 * Narrow on purpose, each clause a fact the record states:
 *  - `role === "assistant"` — only the model's own sink row;
 *  - no content and no reasoning — nothing of the answer was kept;
 *  - no `finishReason` — the one mark every ended turn carries (a clean
 *    finish stamps its reason; a failed call's error event stamps "error";
 *    only an exit that wrote nothing leaves it absent);
 *  - a `runId` — the run to ask about. An empty row with no run cannot be
 *    verified against anything and is left alone (deny-by-default);
 *  - not already settled — the reconcile is idempotent.
 */
export function isUnansweredAssistantRow(msg: ChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    msg.content.length === 0 &&
    (msg.reasoning === undefined || msg.reasoning.length === 0) &&
    msg.finishReason === undefined &&
    msg.incompleteReason === undefined &&
    msg.runId !== undefined
  );
}

/**
 * Apply the hydrate reconcile's verdicts to assistant rows, BY ROW ID.
 *
 * The verdicts are whole replacement rows the caller built: a settled row
 * carries `incompleteReason` (the honest ending face); a row whose words
 * were kept after all carries the fresh record itself. Replacing by id is
 * what keeps the write surgical — `setMessages` would reset streaming and
 * drop the in-flight tail, which a page mid-run on another run must never
 * pay for — and what keeps it safe across a chat switch mid-flight: ids are
 * unique per conversation, so a verdict aimed at a conversation the reader
 * has left matches nothing and writes nothing.
 *
 * Returns how many rows actually changed.
 */
export function applyReconciledAssistantRows(updates: readonly ChatMessage[]): number {
  if (updates.length === 0) return 0;
  const byId = new Map(updates.map((u) => [u.id, u]));
  const list = messages.get();
  let changed = 0;
  const next = list.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const update = byId.get(msg.id);
    if (update === undefined || update === msg) return msg;
    changed += 1;
    return update;
  });
  if (changed > 0) messages.set(next);
  return changed;
}

/**
 * Bulk-replace the message list. Used on chat switch to hydrate from
 * the DB history payload. Resets streaming to false (a fresh chat is
 * not streaming). Preserves id stability for messages that already
 * exist in the store (so Svelte keyed-each doesn't remount them).
 */
/**
 * ── A PAGE OF OLDER MESSAGES ARRIVED — AND IT IS A DELTA, NOT A RELOAD ────
 *
 * The transcript is loaded at its TAIL (DESIGN-PERFORMANCE §4), so travelling
 * backwards inserts at the FRONT. Every consumer that indexes the list by
 * position is therefore shifted by exactly `older.length` — including the
 * flow's ingest, whose whole cursor is "the first N entries of `messages` are
 * the beats I already built".
 *
 * That consumer cannot work the shift out for itself. From inside a
 * `messages` subscription, a prefix insertion and a completely different
 * conversation look identical: the entry at index 0 changed. The ingest's
 * answer to "the transcript diverged" is to rebuild the whole log, which for
 * a prepend would throw away every beat, every measured height and the
 * reader's position — to add two hundred rows above them.
 *
 * So the delta NAMES ITSELF (§3: "a delta names what changed"). The signal is
 * published BEFORE `messages.set`, because a nanostores subscriber runs
 * synchronously on `set` — publishing afterwards would be one frame too late,
 * and the rebuild would already have happened.
 *
 * It carries the chat id because a page belongs to ONE conversation: a signal
 * consumed by a workspace showing a different chat would splice one
 * transcript's messages into another's beats.
 */
export type TranscriptPrepend = Readonly<{ chatId: string; count: number }>;

/** The unconsumed prepend, or null. Written by `prependMessages`, cleared by
 * whoever applies it (the flow's ingest) and by any bulk replacement — a
 * transcript that was thrown away has no prefix left to splice. */
export const pendingPrepend = atom<TranscriptPrepend | null>(null);

/**
 * Put a page of OLDER messages in front of the transcript.
 *
 * Returns the number actually prepended: entries whose id the transcript
 * already holds are dropped, because a re-delivered message is one message,
 * and two rows for it would be the surface saying you sent it twice. The
 * signal reports the number that was really inserted, so a consumer shifting
 * its own cursors shifts by what happened rather than by what was offered.
 */
export function prependMessages(chatId: string, older: readonly ChatMessage[]): number {
  if (older.length === 0) return 0;
  const list = messages.get();
  const held = new Set(list.map((m) => m.id));
  const fresh = older.filter((m) => !held.has(m.id));
  if (fresh.length === 0) return 0;
  pendingPrepend.set({ chatId, count: fresh.length });
  messages.set([...fresh, ...list]);
  return fresh.length;
}

export function setMessages(list: readonly ChatMessage[], preserveLive = false, discardedIds: readonly string[] = []): void {
  if (preserveLive) {
    commitStreamingTail();
    const live = messages.get().filter((message) => message.modelEvent !== undefined && !discardedIds.includes(message.id));
    const byId = new Map(live.map((message) => [message.id, message]));
    const merged = list.map((recorded) => {
      const received = byId.get(recorded.id);
      byId.delete(recorded.id);
      if (received === undefined) return recorded;
      const settled = recorded.role === "assistant" ? recorded.finishReason !== undefined : recorded.toolCall?.status !== "running";
      return settled ? { ...recorded, ...(received.modelEvent !== undefined ? { modelEvent: received.modelEvent } : {}) } : { ...recorded, ...received };
    });
    messages.set([...merged, ...byId.values()]);
    const frame = activeModelFrame;
    if (frame !== null) frame.settled = messages.get().find((message) => message.id === frame.messageId)?.finishReason !== undefined;
    if (activeModelFrame === null || activeModelFrame.settled) isStreaming.set(false);
    pendingPrepend.set(null);
    return;
  }
  // A bulk replacement supersedes any unapplied prefix: the list it was a
  // prefix OF no longer exists.
  pendingPrepend.set(null);
  messages.set(list);
  isStreaming.set(false);
  // Replacing the whole transcript invalidates any in-flight tail: it was
  // streamed into a message that no longer exists. Dropping it here stops it
  // from being folded into an unrelated message on the next commit.
  streamingTail.set("");
  activeModelFrame = null;
}

export function setStreaming(value: boolean): void {
  isStreaming.set(value);
}

export function clearMessages(): void {
  activeModelFrame = null;
  pendingPrepend.set(null);
  messages.set([]);
  isStreaming.set(false);
  // The in-flight tail is part of the transcript state and MUST be reset
  // with it. It was not: switching chats (or logging out) mid-stream left
  // the half-streamed text in the atom, and the next chat's first
  // `commitStreamingTail` folded the PREVIOUS chat's words into the new
  // chat's first assistant message. The tail lives here, so the reset
  // belongs here — not in each caller.
  streamingTail.set("");
  // Reset the id counter so a re-login (same OR different user) starts from
  // a clean id sequence — the counter is module-level mutable state that
  // `messages.set([])` does NOT touch, so without this a logout+relogin keeps
  // climbing the counter across users (stale session state). SPO.
  messageCounter = 0;
}

registerReset("chatMessages", clearMessages);
// Also reset on chat switch — the messages are per-chat. Without this,
// switching from chat A to chat B leaves chat A's messages on the
// screen until chat B's history finishes loading (a stale-content
// flash showing the WRONG chat). The reset fires synchronously on
// currentChatId.set (BEFORE the chatId $effect loads the new history),
// so the ChatPanel briefly shows the empty state (correct — a freshly-
// selected chat shows nothing until its history loads), then chat B's
// messages. The messageCounter reset is safe: new-message ids include a
// Date.now() component so counter reuse across chats cannot collide.
registerContextReset("chatMessages", clearMessages);
