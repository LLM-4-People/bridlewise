import { MISALIGNMENT_POLICY_ERROR_CODE } from "../../engine/src/shared/llm/errors.ts";
/**
 * THE RUN EXECUTOR — the only module that spends money.
 *
 * It assembles the prompt, calls the provider, dispatches tools, writes the
 * projection and records the ledger. Nothing else in the server does any of
 * that, and the import graph is where you check it: this is the only module
 * under `server/routes`' reach that imports `llm-bridge` and `tool-executor`.
 *
 * ── WHY IT IS ITS OWN FILE ─────────────────────────────────────────────────
 *
 * All of this used to live inside `GET /api/run/:runId/stream`. The GET
 * handler WAS the executor; `POST /api/run/start` started nothing. So two
 * connections to one run ran the run twice — measured at the wire, two POSTs
 * to `/chat/completions` of 38,429 bytes each, byte-identical, billed twice,
 * and the same tool call dispatched twice. RFC 9110 §9.2.1 defines GET as
 * safe, which means every proxy, SDK retry policy, service worker and
 * speculative browser fetch in existence is entitled to repeat one.
 *
 * A check inside that handler would have fixed that handler. Two things make
 * the CLASS unavailable instead:
 *
 *   1. THE CLAIM (this file's first effect). `run_executions.run_id` is a
 *      PRIMARY KEY, and claiming it is the first thing that happens. A second
 *      execution of one run is refused BY SQLITE, before a prompt is
 *      assembled, let alone sent. That refusal does not depend on any code
 *      here staying correct: it survives a module that skips the facade, a
 *      route written years from now, and the `sqlite3` CLI.
 *
 *   2. THE WARRANT (the door's argument). `startRunExecution` demands a
 *      `MutationWarrant`, which only a state-changing verb is handed. A GET
 *      handler has no such value in scope and cannot declare one, so a GET
 *      that executes is a compile error rather than a review comment.
 *
 * ── AND ITS OUTPUT GOES TO A FEED, NOT A SOCKET ────────────────────────────
 *
 * The executor publishes frames to `run-feed.ts`. It never learns whether
 * anyone is reading. Consequently a subscriber's disconnect cannot end the
 * run — which it used to, aborting a shared `AbortController` so one party
 * closing a tab killed another party's turn. The ONLY thing that stops a run
 * early is `POST /api/run/:runId/cancel`, which is what the product has
 * always meant by cancel.
 */

import { SSE_EVENT_TYPES, MS_PER_SECOND } from "../../shared/constants.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { streamChat, type StreamChatOptions, type ToolCall } from "../llm/llm-bridge.ts";
import { getTimelineRecorder, getTimelineQuery } from "../observability/timeline-bridge.ts";
import { withRecordingContext, currentActor, currentRecordingContext, generateId } from "../kernel/canonical.ts";
import { getEnabledToolManifestForSession, manifestEntriesToToolDefinitions } from "../tools/tools-bridge.ts";
import { getAgentStatesForRun } from "../agent/agents-bridge.ts";
import { executeToolCall, type ToolCallResult } from "../tools/tool-executor.ts";
import { createRunSafetyGate, gateBlockEventKind } from "../safety/safety-bridge.ts";
import { createRunSafetyRuntime } from "../safety/safety-runtime-bridge.ts";
import { getQualityIndicatorAsync } from "../awareness/quality-bridge.ts";
import { makeFsGate } from "../filesystem/fs-gate.ts";
import { storeInteraction, storeToolResultMemory } from "../context/memory-bridge.ts";
import { buildLLMInput, buildTrimmedHistory, estimateHistoryTokens, estimateRequestTokens } from "../context/context-bridge.ts";
import { wireDedupForTurn } from "../awareness/dedup-bridge.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import {
  getMaximumToolIterations,
  getToolMemoryContentMaxChars,
  getToolMemoryArgsMaxChars,
  getInteractionContentMaxChars,
  refreshSettingsSnapshot,
} from "../kernel/harness-config.ts";
import { attemptNumberForCall, nextCounterAfterCall } from "./attempt-counter.ts";
import { NotFoundError } from "../kernel/errors.ts";
import { honorToolBoundary, tripToolBreaker, revertGateAutoTrips } from "../blocks/breaker.ts";
import { codeForError } from "../../shared/errors.ts";
import { getActiveRun, deleteActiveRun, waitForRunPauseAnswer, type ActiveRun } from "./run-registry.ts";
import { releaseAgentBridge } from "../agent/agent-runtime-bridge.ts";
import { publishRunFrame, openRunFeed, endRunFeed, type RunTerminalFrame } from "./run-feed.ts";
import { assertMutationWarrant, type MutationWarrant } from "../router/router.ts";
import type { ModelEvent, TimelineEventRecord } from "../kernel/canonical.ts";
import type { UiControlAction } from "../tools/ui-control.ts";
import type { MessageMetadataUpdate } from "../db/client.ts";
import type { EventKind } from "../../shared/event-types.ts";

// ── Helpers ──

/**
 * The producing window starts at the first token of ANY kind (thinking or
 * answer). TTFT still uses the first ANSWER token. This is the same split
 * the live footer uses, so a refresh prints the rate the reader already saw.
 */
function timingMetricsForTurn(
  active: ActiveRun,
  finishedAt: number,
): NonNullable<MessageMetadataUpdate["timingMetrics"]> {
  const startedAt = active.turnStartedAt ?? finishedAt;
  const firstTokenAt = active.turnFirstTokenAt ?? undefined;
  const firstOutputAt = active.turnFirstOutputAt ?? firstTokenAt;
  const totalMs = finishedAt - startedAt;
  const generationMs =
    firstOutputAt !== undefined ? finishedAt - firstOutputAt : totalMs;
  const tps =
    active.accumulatedTokenMetrics !== undefined && generationMs > 0
      ? Math.round((active.accumulatedTokenMetrics.outputTokens / (generationMs / MS_PER_SECOND)) * 10) / 10
      : undefined;
  const ttftMs = firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined;
  return {
    startedAt,
    ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
    finishedAt,
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    totalMs,
    ...(tps !== undefined ? { tps } : {}),
  };
}

/** The caller's tool-override rows as the manifest merge wants them. One
 * indexed per-user read, on the read pool.
 *
 * Exported because the run ROUTE needs the same answer before it trims the
 * seeded history: what a payload costs depends on whether this run is sending
 * the tool that brings it back, so the route must ask the same question this
 * module asks, from the same place. A second inline `listToolSettings` + `new
 * Map` there would be a second answer to one question. */
export async function readToolSettingsSnapshot(
  db: AsyncDbClient,
  userId: string,
): Promise<ReadonlyMap<string, boolean>> {
  const rows = await db.listToolSettings(userId);
  return new Map(rows.map((r) => [r.tool_name, r.enabled] as const));
}

// ── Helpers ──

/**
 * Persist a model event to the DB projection. The mapping:
 * "start" → create an empty assistant message (the streaming sink)
 * "text_delta" → accumulate text in memory (persisted on "finish")
 * "tool_call_start" → create a "tool" role message + a running
 * tool_call row linked to that message, tracked by callId
 * "tool_call_done" → no row write (persistToolResult, which already
 * ran for this event's call inside the same turn iteration, owns the
 * row's input — see the case)
 * "finish" → persist the accumulated assistant text to the DB
 * "error" → create an "error" role message so errors survive reload
 *
 * The tool RESULT (output + done/error status + duration) is persisted by
 * `persistToolResult` when the tool_result SSE event is sent (after
 * server-side execution). Together this makes tool calls AND their errors
 * survive a page refresh.
 *
 * This records the conversational surface so the chat history endpoint
 * returns real persisted rows on reload. Full LLM I/O (every delta) is
 * the canonical timeline's job, not the projection's.
 */
async function persistModelEvent(
  db: AsyncDbClient,
  runId: string,
  event: ModelEvent,
  timelineEventId?: string,
): Promise<void> {
  const active = getActiveRun(runId);
  if (!active || active.chatId === null) return;
  const chatId = active.chatId;

  switch (event.type) {
    case "start": {
      const msg = await db.createMessage(
        {
          chat_id: chatId,
          role: "assistant",
          content: "",
          model_event_type: event.type,
          run_id: runId,
        },
        active.userId,
      );
      active.assistantMessageId = msg.id;
      active.accumulatedText = "";
      active.accumulatedReasoning = "";
      active.accumulatedTokenMetrics = undefined;
      // Reset per-turn metadata so a new turn's assistant message does
      // not inherit the previous turn's headers/model (multi-turn runs).
      active.accumulatedResponseHeaders = undefined;
      active.accumulatedResponseModel = undefined;
      active.turnStartedAt = Date.now();
      active.turnFirstTokenAt = null;
      active.turnFirstOutputAt = null;
      active.turnFinishedAt = null;
      // Persist the injected context (if already received via the "context"
      // SSE event) on the new assistant message so the Context section
      // survives a refresh. The context may arrive before "start"; it is
      // buffered in active.accumulatedContext by the stream handler.
      if (active.accumulatedContext !== undefined) {
        await db.updateMessageMetadata(msg.id, { context: active.accumulatedContext }, active.userId);
      }
      // The turn's dedup summary arrives the same way — the `onDedup`
      // callback fires before the request, so it is already accumulated
      // when the message it belongs to is created here. Persisted now
      // (merge) so an interrupted run keeps it, and again in the finish
      // blob — the same defense-in-depth the token metrics get.
      if (active.accumulatedDedupSummary !== undefined) {
        await db.updateMessageMetadata(msg.id, { dedupSummary: active.accumulatedDedupSummary }, active.userId);
      }
      // The turn's redaction notice arrives the same way — the
      // `onRedaction` callback fires before the request. Persisted with
      // the same merge-now + finish-blob defense-in-depth, so the fact
      // that this turn's input was masked survives even an interrupted
      // run — a refresh must never turn a masked turn back into a silent
      // one.
      if (active.accumulatedRedactionNotice !== undefined) {
        await db.updateMessageMetadata(msg.id, { redactionNotice: active.accumulatedRedactionNotice }, active.userId);
      }
      break;
    }
    case "text_delta": {
      active.accumulatedText += event.delta;
      const now = Date.now();
      if (active.turnFirstOutputAt === null) active.turnFirstOutputAt = now;
      // Record first ANSWER token for TTFT. The producing window (tps)
      // starts at firstOutputAt, which may be a thinking token earlier.
      if (active.turnFirstTokenAt === null) {
        active.turnFirstTokenAt = now;
      }
      break;
    }
    case "reasoning_delta": {
      // Accumulate the model's chain-of-thought so the "Thinking" section
      // survives a refresh. Previously dropped by the default case.
      if (active.turnFirstOutputAt === null) active.turnFirstOutputAt = Date.now();
      active.accumulatedReasoning += event.delta;
      break;
    }
    case "usage": {
      // Store token metrics so they survive a refresh. Previously dropped
      // by the default case (the right-panel conversationSummary reset).
      active.accumulatedTokenMetrics = {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
        ...(event.usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: event.usage.cachedInputTokens }
          : {}),
        ...(event.usage.reasoningTokens !== undefined
          ? { reasoningTokens: event.usage.reasoningTokens }
          : {}),
      };
      // persist token metrics INCREMENTALLY (merge, not replace) so
      // an interrupted run (error/disconnect/abort between usage and finish)
      // still preserves token in/out. The finish handler re-persists the
      // full blob; this is the defense-in-depth for the pre-finish window.
      if (active.assistantMessageId !== null) {
        try {
          // THIS PROVIDER SENDS `usage` AFTER `finish`. Stamp tps here when
          // the producing window is already closed, so a refresh still has
          // the rate the live footer showed.
          const timing =
            active.turnFinishedAt !== null
              ? timingMetricsForTurn(active, active.turnFinishedAt)
              : undefined;
          await db.updateMessageMetadata(active.assistantMessageId, {
            tokenMetrics: active.accumulatedTokenMetrics,
            ...(timing !== undefined ? { timingMetrics: timing } : {}),
          }, active.userId);
        } catch (metaErr) {
          // Metadata persist is best-effort — never break the stream, but
          // DO route through the centralized debug bridge so a persistent DB
          // issue is visible when debug is on (not a silent swallow).
          webWarn("run", "token-metrics persist failed", () => ({ runId, error: metaErr instanceof Error ? metaErr.message : String(metaErr) }));
        }
      }
      break;
    }
    case "tool_call_start": {
      // Create a "tool" role message so the tool call renders as its own
      // card in chat history (matching the live client ingestion which
      // appends a tool-role ChatMessage). Link the tool_call row to this
      // message. Track by callId so tool_call_done + tool_result can
      // update the same row.
      const toolMsg = await db.createMessage(
        {
          chat_id: chatId,
          role: "tool",
          content: "",
          run_id: runId,
        },
        active.userId,
      );
      const toolRow = await db.createToolCall(
        {
          message_id: toolMsg.id,
          tool_name: event.name,
          // The stable callId, persisted: it is the identity the client's
          // live card already carries, so the run-end read-back can join
          // this row to the card it belongs to and heal a stranded one.
          call_id: event.callId,
          input: null,
          status: "running",
        },
        active.userId,
      );
      active.toolCallRows.set(event.callId, {
        messageId: toolMsg.id,
        rowId: toolRow.id,
        startedAtMs: Date.now(),
      });
      break;
    }
    case "tool_call_done": {
      // The row's input is NOT written here, and the omission is the fix.
      // Within one turn iteration this case's persist runs AFTER the tool
      // executed and `persistToolResult` already settled the row (output,
      // status, duration AND input — the dispatched arguments), so a second
      // input write here was a two-writer race the later write always won:
      // measured live (UIE-040), the done-event write landed 34ms after the
      // result write and clobbered the DISPATCHED whole with the raw delta
      // the model sent, so the reloaded view rendered an artifact whose
      // content nobody could reach. ONE writer owns "the row's input is
      // what was dispatched" — persistToolResult — and this case has
      // nothing of its own to add.
      break;
    }
    case "finish": {
      if (active.assistantMessageId !== null) {
        await db.updateMessageContent(active.assistantMessageId, active.accumulatedText, active.userId, {
          model_event_type: "finish",
        });
        // Persist the full rich metadata blob so the chat exposure
        // (reasoning, tokens, timing, headers, model, finish reason,
        // context) survives a page refresh. This is the single
        // persistence path — hydrateChatFromHistory reads it back.
        const finishedAt = Date.now();
        active.turnFinishedAt = finishedAt;
        const metadata: MessageMetadataUpdate = {
          ...(active.accumulatedReasoning.length > 0
            ? { reasoning: active.accumulatedReasoning }
            : {}),
          ...(active.accumulatedTokenMetrics !== undefined
            ? { tokenMetrics: active.accumulatedTokenMetrics }
            : {}),
          timingMetrics: timingMetricsForTurn(active, finishedAt),
          finishReason: event.reason,
          ...(active.accumulatedResponseHeaders !== undefined
            ? { responseHeaders: active.accumulatedResponseHeaders }
            : {}),
          ...(active.accumulatedResponseModel !== undefined
            ? { responseModel: active.accumulatedResponseModel }
            : {}),
          ...(active.accumulatedTraceId !== undefined
            ? { traceId: active.accumulatedTraceId }
            : {}),
          ...(active.accumulatedContext !== undefined
            ? { context: active.accumulatedContext }
            : {}),
          ...(active.accumulatedDedupSummary !== undefined
            ? { dedupSummary: active.accumulatedDedupSummary }
            : {}),
          ...(active.accumulatedRedactionNotice !== undefined
            ? { redactionNotice: active.accumulatedRedactionNotice }
            : {}),
        };
        await db.updateMessageMetadata(active.assistantMessageId, metadata, active.userId);
      }
      break;
    }
    case "error": {
      // Persist error messages so they survive a page refresh.
      // Previously errors were live-only (SSE stream) and vanished on
      // reload because the "error" case fell through to `default`.
      // The taxonomy determines its display; the recorder ID joins every
      // live, terminal and saved projection of this incident.
      await db.createMessage(
        {
          chat_id: chatId,
          role: "error",
          content: event.error.message,
          model_event_type: "error",
          run_id: runId,
          metadata: { errorCode: event.error.code, ...(timelineEventId !== undefined ? { timelineEventId } : {}) },
        },
        active.userId,
      );
      // an error mid-stream means "finish" will NOT arrive, so the
      // metadata blob would be missing whatever was accumulated so far
      // (tokens from a prior "usage" event, reasoning, headers). Flush the
      // accumulated fields NOW (merge, not replace) so an interrupted run
      // preserves partial chat exposure instead of losing it forever.
      // THE TARGET IS THIS CALL'S OWN MESSAGE OR NOTHING. The id names the
      // message this call's own "start" created; the turn loop clears it
      // at the top of every iteration, so a call that failed before its
      // first frame — no "start", no message of its own — reaches this
      // guard with null and stamps NOTHING, never the previous call's
      // settled turn. The failure itself is not lost: the error row above
      // is the record the reader sees, and the ledger holds its event.
      if (active.assistantMessageId !== null) {
        try {
          const errMetadata: MessageMetadataUpdate = {
            ...(active.accumulatedReasoning.length > 0
              ? { reasoning: active.accumulatedReasoning }
              : {}),
            ...(active.accumulatedTokenMetrics !== undefined
              ? { tokenMetrics: active.accumulatedTokenMetrics }
              : {}),
            ...(active.accumulatedResponseHeaders !== undefined
              ? { responseHeaders: active.accumulatedResponseHeaders }
              : {}),
            ...(active.accumulatedResponseModel !== undefined
              ? { responseModel: active.accumulatedResponseModel }
              : {}),
            ...(active.accumulatedTraceId !== undefined
              ? { traceId: active.accumulatedTraceId }
              : {}),
            ...(active.accumulatedContext !== undefined
              ? { context: active.accumulatedContext }
              : {}),
            ...(active.accumulatedDedupSummary !== undefined
              ? { dedupSummary: active.accumulatedDedupSummary }
              : {}),
            ...(active.accumulatedRedactionNotice !== undefined
              ? { redactionNotice: active.accumulatedRedactionNotice }
              : {}),
            finishReason: "error",
          };
          await db.updateMessageMetadata(active.assistantMessageId, errMetadata, active.userId);
        } catch (metaErr) {
          // Best-effort: never break the error path, but log so a DB issue
          // is visible (not a silent swallow).
          webWarn("run", "error-event metadata flush failed", () => ({ runId, error: metaErr instanceof Error ? metaErr.message : String(metaErr) }));
        }
      }
      break;
    }
    default:
      // tool_call_delta — partial arguments not accumulated (final
      // arguments arrive on tool_call_done). No other ModelEvent types
      // reach this function: headers/model go out-of-band via onMetadata
      // (persisted in the stream handler), and all other types are
      // handled above. Nothing is silently dropped.
      break;
  }
}

/**
 * Persist a tool execution result to the DB projection. Called when the
 * tool_result SSE event is sent (after server-side tool execution).
 * Updates the tracked tool_call row with the output, final status
 * (done/error), duration, and the attempt count so tool calls AND their
 * errors AND the "attempt N" badge survive a page refresh (:
 * all tool-call fields survive refresh — previously attempt_count was
 * in-memory only and vanished on reload).
 *
 * THE ROW'S INPUT HAS ONE WRITER, AND IT IS THIS FUNCTION. The call site
 * resolves `input` to what was DISPATCHED — the gate's merged whole when
 * the gate rewrote the call (the `dispatchedArguments` stamp), else the
 * event's own arguments — and this write settles it beside the output it
 * belongs to. The old tool_call_done model-event write of `{input:
 * event.arguments}` landed AFTER this one for the same call and clobbered
 * the dispatched whole with the raw delta (measured live, UIE-040: a
 * 34ms-later 25-byte patch overwriting a 430-byte patch), which is why
 * that write is gone and this one owns the field.
 */
async function persistToolResult(
  db: AsyncDbClient,
  runId: string,
  callId: string,
  result: string,
  success: boolean,
  attemptCount: number,
  /** The arguments the executor DISPATCHED — merged when the gate rewrote
   * the call, else the model's own arguments. The row's input records what
   * RAN, and a blocked call honestly records the delta the model sent. */
  input: Readonly<Record<string, unknown>>,
): Promise<void> {
  const active = getActiveRun(runId);
  if (!active || active.chatId === null) return;
  const tracked = active.toolCallRows.get(callId);
  if (tracked === undefined) return;
  const durationMs = Date.now() - tracked.startedAtMs;
  await db.updateToolCall(tracked.rowId, active.userId, {
    output: result,
    status: success ? "done" : "error",
    durationMs,
    attemptCount,
    input,
  });
}

/**
 * Persist an inline event (hallucination, steering, bias, self-healing) as
 * BOTH a timeline event AND a message row so it survives a page refresh.
 * Previously these events were live-only (sent via SSE but never persisted),
 * so they vanished on reload — the root cause of "we still lose info on
 * page refresh" for inline events (, third report).
 *
 * `parentEventId`, when given, is the LEDGER row this account is ABOUT — the
 * tool event of the call the gate blocked. It is the pairing that lets a
 * reader (and the sweep's error count) treat the tool event and this inline
 * account as ONE incident rather than two: `event_log.parent_event_id` is
 * the ledger's own parent-child vocabulary, and the pairing fact is created
 * here, where the two records are known to each other. Absent for the
 * unpaired kinds (steering, end-of-run findings) — an invented parent would
 * be a fabricated causal claim inside a chain-hashed ledger.
 *
 * Two persistence paths:
 * 1. Timeline event → recorded in the canonical ledger + persisted as a
 *    timeline_ref so hydrateChatFromHistory reconstructs it on reload.
 * 2. Message row → role="event" with metadata.eventKind so the message
 *    appears in the chat history on reload (same path as error messages).
 *
 * Each invocation records a distinct incident. Its canonical event ID joins
 * the message and timeline projections, including repeated live delivery.
 *
 * The owner is an argument, the same way persistTimelineEvent takes userId.
 * Looking the live run up here made end-of-run persist a no-op: the run
 * finally deletes the active run first, then asks us to persist findings
 * that can no longer find an owner. Persistence is for history — it cannot
 * require the run to still be in flight.
 */
async function persistInlineEvent(
  db: AsyncDbClient,
  chatId: string,
  runId: string,
  eventKind: EventKind,
  content: string,
  userId: string,
  parentEventId?: string,
): Promise<string> {
  // Returns the announcement's own ledger address (the recorded event's
  // id) so the live frame that announces the same fact can carry it: the
  // client then attaches the address to its live beat, and a replay of
  // either copy — this frame on a re-attach, or the run-end ledger replay —
  // joins the one beat instead of appending a same-words twin.
  const recorder = getTimelineRecorder();
  // Map the inline-event kind to a valid TimelineEventType (the canonical
  // registry does not include "hallucination"/"validation"/"loop"/"steering"/
  // "bias"/"self-healing" — these are UI-level event categories). The original
  // kind is preserved in the metadata.eventKind so the client reconstructs it.
  // The three gate-block kinds (hallucination / validation / loop) are all
  // denied interventions, so all three record an error event with a denied
  // outcome — the ledger distinction is preserved in metadata.eventKind.
  // A safety-finding is a detected problem, so it records failed rather than
  // succeeded. Bias is the same class — a detected problem, not a successful
  // action — so it records failed too. Gate-blocks stay denied.
  const isGateBlock =
    eventKind === "hallucination" || eventKind === "validation" || eventKind === "loop";
  const validEventType =
    isGateBlock ? "error" :
    eventKind === "self-healing" ? "promotion" :
    eventKind === "bias" || eventKind === "safety-finding" ? "quality" :
    "agent"; // steering
  const validOutcome =
    isGateBlock ? "denied" :
    eventKind === "safety-finding" ? "failed" :
    eventKind === "bias" ? "failed" :
    "succeeded";
  const recordedAt = new Date().toISOString();
  const event = recorder.recordEvent({
    eventType: validEventType,
    description: content,
    correlation: { runId },
    outcome: validOutcome,
    ...(parentEventId !== undefined ? { parentEventId } : {}),
  });
  // Persist the timeline ref so hydrateChatFromHistory reconstructs it.
  // TimelineStoreRecordResult only has { eventId, sequence, chainHash } —
  // use the locally-computed timestamp + metadata for the ref.
  await db.createTimelineRef(
    {
      chat_id: chatId,
      event_id: event.eventId,
      event_type: validEventType,
      timestamp: recordedAt,
      metadata: {
        eventKind,
        outcome: validOutcome,
        runId,
        description: content,
      },
    },
    userId,
  );
  // Also persist as a message row so the event appears in the chat history
  // on reload (the timeline_ref reconstruction is a fallback; the message
  // row is the primary path for inline events in the chat transcript).
  // The metadata carries the CANONICAL eventId this message IS — the
  // address of the record's documents, carried (never rendered) so the
  // documents fold survives a page refresh.
  await db.createMessage(
    {
      chat_id: chatId,
      role: "event",
      content,
      run_id: runId,
      metadata: { eventKind, timelineEventId: event.eventId },
    },
    userId,
  );
  return event.eventId;
}

async function persistTimelineEvent(
  db: AsyncDbClient,
  chatId: string,
  event: TimelineEventRecord,
  userId: string,
): Promise<void> {
  await db.createTimelineRef(
    {
      chat_id: chatId,
      event_id: event.eventId,
      event_type: event.eventType,
      timestamp: event.wallTime,
      metadata: {
        recordKind: event.recordKind,
        outcome: event.outcome,
        runId: event.runId,
        description: event.description,
      },
    },
    userId,
  );
}

/**
 * Record real timeline events for a model event. The recorder is the
 * canonical harness timeline; this replaces fixture timeline events with
 * durable ledger records (run, turn, message, token usage). Returns the
 * ids of any newly-recorded events so the stream can forward them.
 */
function recordTimelineForModelEvent(runId: string, event: ModelEvent): readonly string[] {
  const active = getActiveRun(runId);
  if (!active) return [];
  const recorder = getTimelineRecorder();
  const recorded: string[] = [];
  switch (event.type) {
    case "start": {
      const turnId = generateId("turn");
      active.turnId = turnId;
      const turn = recorder.recordTurn({
        description: "assistant turn started",
        correlation: { runId, turnId },
        ...(active.runEventId !== null ? { parentEventId: active.runEventId } : {}),
      });
      recorded.push(turn.eventId);
      if (active.assistantMessageId !== null) {
        const msg = recorder.recordMessage({
          description: "assistant message",
          correlation: { runId, turnId, messageId: active.assistantMessageId },
          parentEventId: turn.eventId,
        });
        recorded.push(msg.eventId);
      }
      break;
    }
    case "usage": {
      if (active.turnId !== null) {
        const usage = recorder.recordTokenUsage({
          promptTokens: event.usage.inputTokens,
          completionTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
          correlation: { runId, turnId: active.turnId },
          ...(active.runEventId !== null ? { parentEventId: active.runEventId } : {}),
        });
        recorded.push(usage.eventId);
      }
      break;
    }
    case "finish": {
      const outcome = event.reason === "stop" || event.reason === "tool_calls" ? "succeeded" : "failed";
      recorder.recordEvent({
        eventType: "run",
        description: `run finished: ${event.reason}`,
        correlation: { runId, ...(active.turnId !== null ? { turnId: active.turnId } : {}) },
        ...(active.runEventId !== null ? { parentEventId: active.runEventId } : {}),
        outcome,
      });
      break;
    }
    case "error": {
      const failure = recorder.recordEvent({
        eventType: "error",
        description: event.error.message,
        correlation: { runId, ...(active.turnId !== null ? { turnId: active.turnId } : {}) },
        ...(active.runEventId !== null ? { parentEventId: active.runEventId } : {}),
        outcome: "failed",
        // ONE value, not four flat fields. The store used to accept the flat
        // shape and complete whatever was missing with the literals "unknown"
        // and "" — placeholder text chain-hashed into a tamper-evident ledger
        // as though it had been observed. All four members are now required,
        // so there is nothing left to invent.
        //
        // `retryable` comes from the error itself rather than the store's old
        // `?? false` default: HarnessError carries it, and this call site was
        // throwing that real value away.
        error: {
          category: "provider",
          code: event.error.code,
          message: event.error.message,
          retryable: event.error.retryable,
        },
      });
      recorded.push(failure.eventId);
      break;
    }
    default:
      // text_delta, reasoning_delta, tool_call_* — not individually recorded
      // (the canonical timeline records them via the recorder's effect API
      // when the runtime is admitted; the projection DB owns the surface).
      break;
  }
  return recorded;
}

// ── The door ──

/**
 * Execute a run. Returns once the run is CLAIMED; the work itself continues
 * detached.
 *
 * The awaited part is deliberately just the claim, because that is what the
 * caller needs an answer about: a second start of the same run must be told
 * `409 run_already_executing` on its own request, not discover it later in a
 * stream. Everything after the claim runs on its own, publishing to the feed,
 * and no HTTP response waits for it.
 *
 * ORDER OF THE FIRST TWO STATEMENTS, stated because it is load-bearing.
 * `assertMutationWarrant` comes first and `claimRunExecution` second.
 * The warrant check performs NO i/o and has NO effect — it is the door
 * refusing a caller that cannot prove its request may change the world, and a
 * caller that fails it must not get to write a claim row either. The claim is
 * the first statement that touches anything, and therefore the first thing any
 * duplicate execution meets. Nothing between them can reach a provider.
 */
export async function startRunExecution(
  warrant: MutationWarrant,
  runId: string,
  userId: string,
  db: AsyncDbClient,
): Promise<void> {
  assertMutationWarrant(warrant);
  // THE RUN STARTS FROM THE SETTINGS IN FORCE NOW: a run is background work
  // that outlives its request, so it resolves the snapshot at its own start
  // (never throws; the store watch keeps it fresh while the run executes).
  refreshSettingsSnapshot();
  // THE RUNG-1 REFUSAL. A second execution of this run is rejected here, by
  // the engine's PRIMARY KEY, before a prompt exists. Throws ConflictError
  // (409, `run_already_executing`) which the router maps for the caller.
  await db.claimRunExecution(runId, userId);

  const active = getActiveRun(runId);
  if (active === undefined) {
    throw new NotFoundError(`Run ${runId} not found or already completed`);
  }
  const chatId = active.chatId;
  /**
   * HAS THIS RUN BEEN STOPPED?
   *
   * It reads the run's own cancellation signal — not a connection's state.
   * The distinction is the fix: this used to ask "has the client's socket
   * closed?", so a subscriber leaving ended the work, and the prompt was
   * already billed by the time the socket dropped. Only
   * `POST /api/run/:runId/cancel` aborts this controller.
   */
  const stopped = (): boolean => active.abortController.signal.aborted;

  /**
   * HOW THIS RUN ENDED — decided along the way, published once, at the exit.
   *
   * It used to be published wherever the decision was made, which put it in
   * the wrong place twice over. `done` went out BEFORE the run's timeline and
   * agent frames, so a client obeying `done`'s own documented meaning ("the
   * client closes the stream") closed and never received them — frames
   * computed, sent, and delivered to nobody. The tool-iteration bound was
   * worse: it published an `error` mid-loop and then carried on to publish
   * `done` as well, so one run reported two endings.
   *
   * The writers today: the pause bound, the iteration bound, a failed call's
   * error event — and the loop top CLEARS it, so a run that starts a further
   * turn is not ended by an earlier call's failure; the frame that survives
   * to the exit always names the run's own ending, the last call's fate.
   *
   * `null` means "nothing has decided yet", which is itself the answer for a
   * run that stops without reaching any of these — see the `finally`.
   */
  let terminalFrame: RunTerminalFrame | null = null;
  let policyStopped = false;

  // ── THE FEED IS OPENED HERE, BECAUSE THIS IS WHERE IT IS CLOSED ───────────
  //
  // It used to be opened by the start route, one statement before this call.
  // So a start refused after that point — a claim that throws for any genuine
  // reason, a run that vanished from the registry — left a feed nobody would
  // ever end, because the only `endRunFeed` is in the `finally` below and
  // that `finally` is never entered. Driven: five refused starts left five
  // feeds and five registry entries, and a subscriber attaching to one of
  // those corpses was ACCEPTED and held open forever, consuming a connection
  // slot for a run that would never publish.
  //
  // Opening it here puts open and end in one function, so the pair cannot
  // come apart. It is opened AFTER the claim deliberately: the claim must
  // stay the first effect (a caller that cannot prove its request may change
  // the world must not leave a trace), and a feed opened before it would be
  // that trace.
  //
  // Nothing is lost by the move. `startRunExecution` does not resolve until
  // the feed exists, and the route answers 201 only after it resolves — so a
  // subscriber still cannot arrive before the feed does, which is the
  // property the original ordering existed to provide.
  openRunFeed(runId, { userId: active.userId, chatId });

  // RUN RECORDING BOUNDARY — everything this run does happens inside it.
  //
  // Anything recorded through the ambient path rather than by an explicit
  // `correlation: { runId }` argument would otherwise land with a NULL run id:
  // measured, all 404 tool events in the ledger had no run id, so the tool
  // lane was empty in every chat- and project-scoped view even though the
  // calls were faithfully recorded. Entering it here — once, around the whole
  // run — means a tool, file or git effect is attributed to its run without
  // the code performing it knowing a run exists.
  //
  // The actor is carried over rather than replaced: this boundary knows the
  // run, not the identity, and overwriting the identity with a default is how
  // attribution was lost in the first place.
  //
  // THE LAUNCH ITSELF IS UNWOUND IF IT FAILS. The `finally` inside cleans up
  // everything the run does; it cannot clean up a run that never began. A
  // throw between opening the feed and entering that `try` would leak exactly
  // what the move above was made to stop leaking, so the one statement in
  // between is guarded rather than assumed safe.
  try {
  void withRecordingContext({ actor: currentActor(), runId }, async () => {
  // Declared before the try so the `finally` below can dispose it on every
  // exit path (a `const` inside the try block would not be visible there).
  let safetyRuntime: ReturnType<typeof createRunSafetyRuntime> | undefined;
  // Monotonic C09 turn counter, hoisted so the finally can completeTask/detect
  // after an early `if (stopped()) return` — that return used to skip the
  // post-loop publish and drop already-recorded findings. The prior code used
  // `state.turns.length`, which DECREASES after trimming and overwrote C09
  // entries; this counter only increases.
  let summaryTurnNumber = 0;
  try {
  // use the ENABLED tool manifest for the LLM. The full manifest
  // (including disabled + MCP entries) is still shown in the Tools panel
  // via GET /api/tools.
  // (tools per user): load the per-user overrides so each user
  // gets their own tool set. The global config's `tools.enabled` list is
  // the default; the per-user DB rows are overrides.
  // Through the one owner — this used to be an inline `listToolSettings` +
  // `new Map` that said the same thing as `readToolSettingsSnapshot` two
  // screens below it.
  const sessionOverrides = await readToolSettingsSnapshot(db, active.userId);
  // `let`, not `const`: the tools.breaker NEXT-BOUNDARY honor point (top
  // of every turn iteration below) re-derives both from the live per-user
  // override rows, so a breaker flipped mid-run lands at the next
  // tool-call decision point. `buildChatOpts` reads these variables at
  // call time, so each turn's request carries the current definitions.
  let toolManifest = getEnabledToolManifestForSession(sessionOverrides);
  let toolDefinitions = manifestEntriesToToolDefinitions(toolManifest);
  // SPO: create the per-run safety gate. The gate reads the
  // LIVE enabled manifest on every `check` (so a tool toggled mid-run
  // is reflected) + the config from `getSafetyGateConfig`. The gate
  // instance is stored on the active run + passed to the executor via
  // `ToolExecutionContext.gate`. The executor calls `gate.check`
  // BEFORE dispatch — the choke point, no caller bypasses it. The gate
  // detects ghost tools (not in the registry), schema mismatches (args
  // fail JSON-schema validation), and loops (identical name + args
  // repeated beyond a threshold). Blocked calls return a typed error
  // with `gateBlock` so the route emits a "hallucination" SSE event.
  active.toolSettingsSnapshot = await readToolSettingsSnapshot(db, active.userId);
  active.safetyGate = createRunSafetyGate(() =>
    // Genuinely live, in BOTH halves of the answer. The callback used to
    // re-read the global config but close over the `sessionOverrides` Map
    // captured once above, so a per-user tool toggle — which is what the
    // Tools panel actually writes — was frozen for the whole run while the
    // comment claimed it was honoured.
    //
    // The read cannot happen HERE any more: this callback is synchronous
    // because `executeToolCall` and the canonical gate are, and an async
    // one would hand the gate a promise instead of a manifest. So the
    // snapshot is refreshed in the async frame immediately before each
    // tool call, with no `await` between the refresh and the check — see
    // `ActiveRun.toolSettingsSnapshot`. The claim stays true and the read
    // stays off the synchronous path.
    getEnabledToolManifestForSession(active.toolSettingsSnapshot),
  );
  // SPO: the saveToMemory gate is NO LONGER built here. The
  // run route previously constructed a saveToMemory-tools Set from the
  // manifest and inlined the opt-in + success check before calling
  // storeProvenance — a SPO violation (the gate lived in the route, not
  // the memory owner). Now the gate is enforced at the memory owner
  // (`storeToolResultMemory` in memory-bridge.ts), which checks BOTH
  // the manifest owner's opt-in list (`isSaveToMemoryTool` from
  // tools-bridge) AND the result's success. A caller that bypasses
  // the route cannot skip the gate.

  // SPO: the event-feed safety runtime (the safety-runtime owner). Per-run
  // instance, like the gate: it constructs the workaround / bandaid /
  // step-skip / deviation detectors with the config owner's resolved
  // config, starts from the user's task, and is disposed when the run ends
  // (`finally`). It consumes tool RESULTS + assistant text, never proposals.
  safetyRuntime = createRunSafetyRuntime();
  safetyRuntime.setOriginalTask(active.prompt);

  // Build the full LLM input ONCE for this run via the context manager
  // (the SINGLE source of truth — SPO). `buildLLMInput` is the
  // ONE entry point that assembles the system prompt (project context +
  // repo map + memories) AND derives the trimmed conversation history
  // from the context manager. The run route does NOT build the system
  // prompt or conversationHistory ad-hoc (the prior three-call assembly
  // + two buildTrimmedHistory calls bypassed the context owner).
  // FIX: the LLM now receives project context so it can answer
  // "explain this project" instead of saying "You haven't provided a project."
  // inject retrieved memories into the system prompt so the LLM
  // has cross-run/cross-chat recall.
  // (system prompt configurable from web): load the per-user
  // prompt preferences (encrypted in user_prompt_prefs) and pass them
  // to buildLLMInput. The DB override wins field-by-field over the
  // config-file defaults (the global seed) — see resolvePromptPrefs
  // (the single merge point in project-context.ts).
  const userPromptPrefs = await db.getUserPromptPrefs(active.userId);
  const llmInput = buildLLMInput(
    active.contextManager,
    {
      projectName: active.projectName,
      projectPath: active.projectPath,
      tools: toolManifest,
      userPromptPrefs: userPromptPrefs ?? undefined,
    },
    active.retrievedMemories,
  );

  // Expose the injected context (system prompt + available tools +
  // conversation length) so the user can inspect exactly what was sent
  // to the model. Shown in a collapsible "Context" section on the
  // assistant message. This is the "expose everything" fix: the user
  // can see the system prompt, the tools, and how much history was
  // sent — not just the answer.
  // (truthful context): report the ACTUAL trimmed state from the
  // unified context manager (the single source of truth). contextTrimmed
  // reflects whether trimming occurred — NOT the raw unbounded history.
  // This fixes the 748% bug where the event reported 245,022 tokens /
  // limit 32,768 / trimmed: no.
  const contextState = active.contextManager.state();
  // (truthful per-call total, UIE-054): contextTokens is the cost of the
  // request this run is actually making — the system prompt + the trimmed
  // history + the tool schemas the request carries beside the messages —
  // derived from the ONE owner that counts every channel
  // (estimateRequestTokens). The history-only estimate that used to stand
  // here answered "how full is the conversation?" while claiming "the
  // tokens ACTUALLY sent to the LLM": on a fresh chat it read ~5.9k
  // against a ledger prompt of 12,122 (the schemas alone are ~6.8k on
  // this install, a constant the messages-only count can never see).
  // The history channel is served beside it as historyTokens, so the
  // gauge's total and the trim's own budget remain two distinguishable
  // facts.
  const historyTokens = estimateHistoryTokens(llmInput.conversationHistory);
  const sentTokens = estimateRequestTokens(llmInput, toolDefinitions);
  publishRunFrame(runId, SSE_EVENT_TYPES.context, {
    runId,
    systemPrompt: llmInput.systemPrompt,
    toolCount: toolDefinitions.length,
    toolNames: toolManifest.map((t) => t.name),
    historyLength: llmInput.conversationHistory.length,
    // expose the retrieved memory count + context manager state
    // so the UI can show "Recalled N memories" and the token pressure.
    recalledMemoryCount: active.retrievedMemories.length,
    contextTokens: sentTokens,
    historyTokens,
    contextTokenLimit: active.contextManager.tokenLimit(),
    contextTrimmed: contextState.trimmed || contextState.trimCount > 0,
    modelId: active.credential.modelId,
  });
  // Accumulate the injected context so it is persisted to the
  // assistant message's metadata blob on `finish`. The
  // context is context FOR the message — persisted so the Context
  // section survives a page refresh.
  active.accumulatedContext = {
    systemPrompt: llmInput.systemPrompt,
    toolNames: toolManifest.map((t) => t.name),
    historyLength: llmInput.conversationHistory.length,
    recalledMemoryCount: active.retrievedMemories.length,
    contextTokens: sentTokens,
    historyTokens,
    contextTokenLimit: active.contextManager.tokenLimit(),
    contextTrimmed: contextState.trimmed || contextState.trimCount > 0,
    modelId: active.credential.modelId,
  };

  // Build the LLM options once (shared across all turns in this run).
  // FIX BUG B (the 748% bug): the LLM receives the TRIMMED history
  // derived from the unified context manager (the single source of
  // truth), NOT the raw unbounded conversationHistory. The trimmed
  // history = recent window + pinned turns + a summary message for
  // older turns, with tool_calls/tool_call_id pairing preserved
  // (OpenAI contract). turnPrompt is "" for all turns — streamChat
  // skips appending a user message when prompt is empty, so the
  // trimmed history is sent as-is (the current user prompt is the
  // last turn in the manager).
  // SPO: the system prompt is reused from `llmInput`
  // (assembled once per run via the context owner — it does not
  // change between turns). The conversation history is RE-DERIVED from
  // the context manager on each `buildChatOpts` call via
  // `buildTrimmedHistory` (the context owner's history-derivation
  // function) so tool-call follow-up turns see the latest state (the
  // manager adds tool results between turns). Both go through the
  // context owner — the route does not build either ad-hoc.
  const buildChatOpts = (): StreamChatOptions => ({
    signal: active.abortController.signal,
    // The provider resolved at run start, carried for every turn. Not
    // re-resolved per turn: a run must not silently change provider halfway
    // through because Settings was edited in another tab.
    credential: active.credential,
    // The model's OWN stored request defaults — the per-model rows in
    // Settings — applied on every turn of this run, because the credential
    // was resolved for exactly this model. Absent means "let the provider
    // decide": the field is simply not sent, never a guessed number.
    ...(active.credential.model.maxTokens !== undefined
      ? { maxTokens: active.credential.model.maxTokens }
      : {}),
    ...(active.credential.model.temperature !== undefined
      ? { temperature: active.credential.model.temperature }
      : {}),
    ...(toolDefinitions.length > 0 ? { tools: toolDefinitions, toolChoice: "auto" } : {}),
    systemPrompt: llmInput.systemPrompt,
    // Same fact, same source as `buildLLMInput`: the run may only abridge a
    // payload when it is actually sending the tool that brings it back, and
    // the manifest is handed over rather than reduced to a flag first. It is
    // read at CALL time, so a tool the breaker switches off mid-run reprices
    // the history that the next turn's trim then reasons about.
    conversationHistory: buildTrimmedHistory(active.contextManager, toolManifest),
    // Forward response headers + actual model to the client via a
    // "metadata" SSE event so the UI can show them (expose-everything).
    onMetadata: (meta) => {
      if (stopped()) return;
      // The request's trace id rides the SAME metadata frame rather than a
      // parallel one: the frame already exists for out-of-band correlation
      // facts, and the id comes from the ambient recording context the
      // router minted — read, never re-derived. Absence is preserved (no
      // trace id key when there is no context) so a synthesised id can never
      // point at nothing in the ledger.
      const ambientTraceId = currentRecordingContext()?.traceId;
      if (ambientTraceId !== undefined) {
        // Run-scoped, never reset per turn: one request is one trace, every
        // LLM call in the run re-delivers the same id, and persisting it
        // with the turn's other measured facts keeps the ledger reachable
        // from the message long after the run view retires.
        active.accumulatedTraceId = ambientTraceId;
      }
      publishRunFrame(runId, SSE_EVENT_TYPES.metadata, {
        runId,
        ...(ambientTraceId !== undefined ? { traceId: ambientTraceId } : {}),
        ...meta,
      });
      // Accumulate response headers + actual model so they are
      // persisted to the assistant message's metadata blob on
      // `finish`. Previously these were live-only (sent via
      // the "metadata" SSE event) and vanished on page refresh.
      if (meta.headers !== undefined) {
        active.accumulatedResponseHeaders = { ...meta.headers };
      }
      if (meta.model !== undefined) {
        active.accumulatedResponseModel = meta.model;
      }
    },
    // SPO: emit the LLM-input dedup stats via a "dedup" SSE
    // event so the user sees the dedup working. The callback is invoked
    // by `streamChat` → `buildLLMMessages` → `summarizeDedupReports`
    // ONLY when dedup actually removed content (no noisy no-op events).
    // The dedup is opt-in via `memory.dedupCompression.llmInputDedup`
    // — when disabled, `dedupContentForLLM` is a no-op and
    // this callback is never invoked.
    //
    // The summary is also ACCUMULATED here (the response-headers pattern)
    // so it is persisted to this turn's assistant message: the savings
    // belong to the call whose input was folded, and the footer that
    // renders them must show the same face after a refresh. The callback
    // fires before the request — hence before this turn's `start` frame —
    // which is exactly the context event's arrival shape: buffered by the
    // accumulation, persisted when the message exists.
    onDedup: (summary) => {
      if (stopped()) return;
      active.accumulatedDedupSummary = summary;
      publishRunFrame(runId, SSE_EVENT_TYPES.dedup, { runId, ...summary });
    },
    // NEVER SILENTLY CHANGE WHAT THE MODEL SEES. The choke point
    // (`buildLLMMessages`) masks secrets in the system prompt, the
    // history and the prompt; this is how the user finds out it did, how
    // many values it hid, and — split by confidence — whether each one
    // was PROVEN (it equals a credential this server holds) or INFERRED
    // (a declaration phrase introduced it and its shape agreed).
    //
    // Invoked by `streamChat` ONLY when something was actually masked.
    // The notice is also ACCUMULATED here (the dedup-summary pattern) so
    // it is persisted to this turn's assistant message: the masking
    // belongs to the call whose input was rewritten, and the footer that
    // renders the fact must show the same face after a refresh. The
    // callback fires before the request — hence before this turn's
    // `start` frame — which is exactly the context event's arrival
    // shape: buffered by the accumulation, persisted when the message
    // exists.
    onRedaction: (notice) => {
      if (stopped()) return;
      active.accumulatedRedactionNotice = notice;
      publishRunFrame(runId, SSE_EVENT_TYPES.redaction, { runId, ...notice });
    },
  });

  /**
   * Stream turns in a loop. The first turn uses the initial prompt
   * (already in conversationHistory). After each turn:
   * If the LLM made tool calls (finish_reason "tool_calls"),
   * execute each tool, append the assistant tool_call message +
   * tool result messages to the history, and start a new turn
   * so the LLM can produce a follow-up response. (FIX )
   * If the user sent a steering message, start a new turn with
   * the full history + the steering message.
   * Otherwise, the run is complete.
   *
   * A bounded max iteration limit prevents infinite tool-call loops.
   */
  let turnPrompt = "";
  let isFirstTurn = true;
  let toolCallIterations = 0;
  // SPO FIX: track the current turn's user message (not
  // always the INITIAL prompt). The prior code passed `active.prompt`
  // (the initial run prompt) as the user message for EVERY turn,
  // including tool-call follow-ups + steering turns — so the C09 summary
  // over-recorded the initial prompt's topic. The current turn's user
  // message is: the initial prompt (first turn), the steering message
  // (steering turns — already in the manager), or empty (tool-call
  // follow-ups — no new user message). We derive it from the last user
  // turn in the context manager (the single source of truth).
  let currentTurnUserMessage = active.prompt;
  // PROACTIVE #4: the tool-call loop bound comes from the config's
  // `runtime.limits.maximumToolIterations` (plural — matching
  // bridlewise.config.json; no hardcoded configurables). The
  // default is owned by the config accessor (no literal scattered here).
  const toolIterationLimit = getMaximumToolIterations();
  // tools.breaker auto-trip memory: tool → the consecutive-failure count
  // a trip already fired at, so one failure streak trips exactly once and
  // an explicit reset is not instantly re-tripped at the same count.
  const breakerTripsFired = new Map<string, number>();

  // THE STEERING DOOR OPENS WITH THE TURN LOOP AND CLOSES AT ITS ONE EXIT
  // BOUNDARY. Opened HERE — not at registration — so a run that throws
  // before its first turn never offers a queue it will not read (the field
  // defaults closed). The try/finally below is the boundary every exit
  // from the loop crosses: a normal `break`, a cancellation's `return`, a
  // thrown error all close the door before the epilogue runs, so the steer
  // route can refuse a finishing run with the guided sentence rather than
  // accept a delivery the loop will never make.
  active.steeringOpen = true;
  try {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (stopped()) return;
    let rejectedIntoNextTurn = false;

    // ── tools.breaker NEXT-BOUNDARY HONOR POINT ──
    // The top of each turn iteration IS the next tool-call decision
    // point: the previous turn's calls (if any) have fully completed and
    // the next streamChat request has not been built. Here — and only
    // here — breaker flips land (`tools.breaker/set { at: "next-
    // boundary" }` wrote the override row; this re-read makes it
    // effective) and the deterministic auto-trip check runs against the
    // run's consecutive recorded failures. A flip mid-call can never
    // abort the in-flight call because the loop only consults the store
    // at this point; the per-decision safety gate (which re-reads the
    // same rows) backstops the window in depth.
    const boundary = await honorToolBoundary({
      db,
      userId: active.userId,
      consecutiveFailures: active.toolAttemptCounts,
      tripsFired: breakerTripsFired,
      runId,
    });
    toolManifest = boundary.manifest;
    toolDefinitions = boundary.definitions;

    // SPO FIX: derive the current turn's user message
    // from the context manager (the single source of truth) at the
    // START of each turn. This picks up the steering message (added
    // by the steer route between turns) and the initial prompt (seeded
    // before the first turn). For tool-call follow-up turns (no new
    // user message added), the last user turn is the initial prompt or
    // the steering message — which is correct (the summary records the
    // user's most recent intent, not a stale initial prompt repeated
    // verbatim). Falls back to the initial prompt when no user turn
    // survives in the manager (degenerate all-evicted case).
    const survivingUserTurns = active.contextManager.state().turns.filter((t) => t.role === "user");
    if (survivingUserTurns.length > 0) {
      currentTurnUserMessage = survivingUserTurns[survivingUserTurns.length - 1]!.content;
    }

    let turnAssistantText = "";
    let turnFinishReason = "stop";
    /**
     * Completed tool calls for this turn. Each entry has the callId,
     * name, arguments, and the server-side execution result. Used to
     * build the follow-up conversation history after the turn.
     */
    const completedToolCalls: { callId: string; name: string; arguments: Record<string, unknown>; result: string; success: boolean }[] = [];
    /**
     * Map callId → tool name, tracked from tool_call_start events.
     * The tool_call_done event has callId + arguments but NOT name
     * (per the ModelEvent schema), so we look up the name here.
     */
    const toolCallNames = new Map<string, string>();

    // ── THE STEER'S DELIVERY POINT (one instruction, one delivery) ──
    // Every entry sitting in the queue right now is already in the
    // conversation (queueSteer adds the manager turn before the queue
    // entry, with no await between), and THIS request — composed in the
    // same synchronous stretch as the consumption below — carries the
    // whole conversation. So those entries are delivered by the turn that
    // is starting, and consuming them HERE is what makes the delivery
    // exactly-once: leaving the signal queued after the words were sent
    // is the double-delivery defect (a mid-tool-turn steer used to be
    // composed into the tool-loop continuation turn AND left queued, so
    // the drain fired a SECOND full-context turn for the same
    // instruction — two identical reply beats, the record carrying a
    // duplicate answer).
    //
    // THE SHAPE OF THE BLOCK IS THE GUARANTEE. The durable announcement
    // is written first (its await is safe — the queue is still unread, so
    // a steer landing during it is consumed with the rest). Then the
    // delivery itself is ONE synchronous stretch: consume, publish,
    // compose. Nothing can interleave inside a synchronous stretch, so
    // the entries consumed are exactly the entries this request composes.
    // The drain below still exists for the other arrival shape: a steer
    // that lands while a turn STREAMS (after this point) composes into no
    // turn until the loop starts one for it.
    if (active.steeringQueue.length > 0) {
      // The announcement's own ledger address, captured at the persist so
      // the frame carries the row it announces — the live beat and the
      // record then state the same fact with the same words and the same
      // address, and a replay of either copy joins the one beat. The
      // words are the frame's own words (the client renders the remaining
      // count the frame reports) so the join's content half holds; the
      // count is the post-consumption truth this stretch produces.
      let steerEventId: string | undefined;
      if (chatId !== null) {
        try {
          steerEventId = await persistInlineEvent(
            db,
            chatId,
            runId,
            "steering",
            "Steered — delivered in the turn that is starting (0 queued)",
            active.userId,
          );
        } catch (steerErr) {
          webWarn("run", "steering persist failed", () => ({ runId, error: steerErr instanceof Error ? steerErr.message : String(steerErr) }));
        }
      }
      if (stopped()) return;
      active.steeringQueue.length = 0;
      publishRunFrame(runId, SSE_EVENT_TYPES.steered, {
        runId,
        remaining: active.steeringQueue.length,
        delivery: "composed",
        ...(steerEventId !== undefined ? { eventId: steerEventId } : {}),
      });
    }

    // THE TURN'S DEDUP SLATE IS CLEAN BEFORE ITS CALL IS BUILT. The
    // `onDedup` callback fires inside `streamChat` — before this turn's
    // first frame — so clearing here (once per iteration, ahead of the
    // call) is what makes the accumulated summary provably THIS turn's:
    // a call that removes nothing fires no callback and inherits the
    // previous turn's savings never. The stale-inheritance direction is
    // the one that would fabricate a savings face on a turn that saved
    // nothing, so it is cleared at the one place every iteration crosses.
    // The redaction notice has the same shape and the same hazard — a
    // turn whose call masked nothing must never wear the previous turn's
    // masking — so it clears at the same one place.
    active.accumulatedDedupSummary = undefined;
    active.accumulatedRedactionNotice = undefined;

    // A CALL THAT NEVER OPENED ITS OWN TURN OWES NO EARLIER TURN ITS
    // FACTS. `assistantMessageId` is set only by this call's own "start"
    // frame (the persist case above), and before this clear nothing ever
    // reset it between calls — so a call whose request died before its
    // first model frame (the typed client-construction refusal the
    // stream's head surfaces, say) left the id naming the PREVIOUS call's
    // message, and the error flush would restamp that settled turn: its
    // finish reason flipped to "error", the failed call's context and
    // trace written over a turn that already carries its own. Clearing
    // here — the same one place every iteration crosses, ahead of the
    // call — makes the id provably THIS call's or nothing, so the flush's
    // own null check is the whole guard and restamping a previous turn's
    // message is structurally impossible. The failure itself is recorded
    // by its own owners: the "error" case below writes the error row the
    // reader sees, and the timeline records the ledger event.
    active.assistantMessageId = null;

    // A TERMINAL FRAME RECORDED AT A FAILED CALL NAMES THIS RUN'S ENDING
    // ONLY IF NO FURTHER TURN RUNS. The steering drain below can start a
    // turn for an instruction that arrived while the failed call streamed,
    // and a run that CONTINUES past a failure is not ended by it — the
    // run's own ending is the fate of its LAST call. Clearing here — the
    // same one place every iteration crosses, ahead of the call — keeps
    // the recorded frame always the last call's: the error frame recorded
    // at a failed call either stands (the loop breaks with it, and the
    // run ended by that failure) or dies here (a further turn ran, and
    // whatever that turn's fate was will decide the ending instead). The
    // frames recorded at the pause bound and the iteration bound `break`
    // in the same statement that records them, so no clear ever reaches
    // those.
    terminalFrame = null;

    for await (const event of streamChat(turnPrompt, buildChatOpts())) {
      const policyRefusal = event.type === "error" && event.error.code === MISALIGNMENT_POLICY_ERROR_CODE;
      // Cancellation ends this run; it cannot erase a provider refusal that
      // has already reached us and governs the conversation's next admission.
      if (stopped() && !policyRefusal) return;
      if (policyRefusal) {
        policyStopped = true;
        active.steeringOpen = false;
      }
      // A failure's live event, persisted row, ledger replay and terminal
      // frame all describe the same recorded incident. Record before
      // publication so none of those projections has to infer identity.
      const eventId = event.type === "error"
        ? recordTimelineForModelEvent(runId, event).at(-1)
        : undefined;
      // Starts acquire their durable row identity before any subscriber can
      // see them. Replays and history therefore address the same transcript.
      if (event.type === "error" || event.type === "start" || event.type === "tool_call_start") {
        await persistModelEvent(db, runId, event, eventId);
      }
      publishRunFrame(runId, SSE_EVENT_TYPES.model, {
        ...event,
        ...(eventId !== undefined ? { eventId } : {}),
        ...(active.assistantMessageId !== null ? { assistantMessageId: active.assistantMessageId } : {}),
        ...(event.type === "tool_call_start" ? { messageId: active.toolCallRows.get(event.callId)?.messageId } : {}),
      });
      // Track assistant text for the conversation history.
      if (event.type === "text_delta") turnAssistantText += event.delta;
      // Track the finish reason to decide whether to start a follow-up turn.
      if (event.type === "finish") turnFinishReason = event.reason;
      // A FAILED CALL IS A CANDIDATE ENDING FOR THE RUN, recorded here —
      // where the failure's own code and message are known — exactly the
      // way the pause bound and the iteration bound record theirs: nothing
      // is published yet; the one publish happens last, at the exit. The
      // recorded frame carries the failing call's own taxonomy code, so a
      // reader of the run's ending alone learns what happened, not merely
      // that something did. It is a CANDIDATE, not a verdict: the turn
      // loop can still start a further turn for a steer that arrived while
      // the failed call streamed, and the loop-top clear is what keeps the
      // frame naming the run's own ending — the LAST call's fate — never
      // an earlier call's. A run that continued past a failure and
      // finished ends `done`; the failed call's own error row and ledger
      // event carry that failure either way.
      if (event.type === "error") {
        terminalFrame = {
          event: SSE_EVENT_TYPES.error,
          data: {
            runId,
            code: event.error.code,
            message: event.error.message,
            ...(eventId !== undefined ? { eventId } : {}),
          },
        };
        if (policyStopped) break;
      }
      // Track tool call names from tool_call_start (tool_call_done
      // has callId but not name per the ModelEvent schema).
      if (event.type === "tool_call_start") {
        toolCallNames.set(event.callId, event.name);
      }
      if (event.type === "tool_call_done") {
        // Execute the tool call server-side and stream the result.
        // FIX tool_call_done is now synthesized by llm-bridge
        // when the finish event has reason "tool_calls". Previously
        // this event was never emitted (only by fixtures), so tools
        // were never executed.
        // DEFENSE-IN-DEPTH (exp510): wrap execution so a tool_result
        // is ALWAYS sent — even if executeToolCall throws (it has its
        // own try/catch, but we guard the stream/persist path too).
        // Without this, a thrown error would skip the tool_result
        // event and the tool would stay "running" in the UI forever.
        const toolName = toolCallNames.get(event.callId) ?? "unknown";
        // track attempt count per tool name per run so the UI
        // can show "attempt N" on retried tool cards. The counter is
        // RESET TO 0 after a successful call (below), so the NEXT call
        // of the same tool name starts at attempt 1 (which the UI hides
        // via `attemptCount > 1`). This avoids the false positive where
        // an LLM reading 5 files in a row (5 successful read_file calls)
        // showed "attempt 5" on the 5th file. "attempt N" now means the
        // PREVIOUS call of the same tool name FAILED and this is a retry.
        // The increment/reset decision lives in the pure attempt-counter
        // helper (server/attempt-counter.ts) — the single owner, tested
        // behaviorally.
        const prevAttempts = active.toolAttemptCounts.get(toolName) ?? 0;
        const attemptCount = attemptNumberForCall(prevAttempts);
        active.toolAttemptCounts.set(toolName, attemptCount);
        let toolResult: ToolCallResult;
        try {
          // SPO: the safety gate runs INSIDE the executor (the choke
          // point). The gate is passed via ctx.gate + the
          // callId; the executor calls gate.check BEFORE dispatching
          // to the handler. Blocked calls (ghost_tool / schema_mismatch /
          // loop) return a typed error with `gateBlock` so the route can
          // emit a "hallucination" SSE event. No caller can
          // bypass the gate — the check is inside executeToolCall.
          // Refresh the snapshot the synchronous gate reads. Nothing
          // awaits between here and `gate.check` inside the executor, so
          // the gate sees exactly what a live read would have returned.
          active.toolSettingsSnapshot = await readToolSettingsSnapshot(db, active.userId);
          // `await`, and the adjacency above still holds: `executeToolCall`
          // is an `async function`, so everything up to its first `await`
          // — including the canonical gate's `check` — runs synchronously
          // in THIS frame, with nothing interleaved after the refresh.
          toolResult = await executeToolCall(toolName, event.arguments, {
            projectRoot: active.projectPath,
            userId: active.userId,
            gate: active.safetyGate,
            callId: event.callId,
            // The SAME store the context assembler abridges against —
            // threaded, never rebuilt, so the id the model was handed
            // resolves against the store that minted it.
            ...(active.contextManager.toolResultStore !== null
              ? { toolResults: active.contextManager.toolResultStore }
              : {}),
            // Agent-delegation context: the run's identity, abort signal,
            // credential and live manifest, so delegate_to_agent builds its
            // sub-agent on the SAME provider path + confinement the parent
            // run uses. Read only by the agent tools; ignored by the rest.
            runId,
            runSignal: active.abortController.signal,
            credential: active.credential,
            parentManifest: toolManifest,
            safetyRuntime,
            safetyTurn: summaryTurnNumber + 1,
          });
        } catch (execErr) {
          webWarn("run", "tool execution failed", () => ({ runId, toolName, callId: event.callId, error: execErr instanceof Error ? execErr.message : String(execErr) }));
          toolResult = {
            success: false,
            output: `Tool '${toolName}' failed: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
          };
        }
        // SPO: the safety gate (inside the executor) may have blocked
        // the call BEFORE dispatch. If so, emit a "hallucination" SSE
        // event + persist it so it survives a
        // page refresh. The `gateBlock` carries the kind (ghost_tool |
        // schema_mismatch | loop | tool_disabled), the tool name, the
        // callId, and the suggestion (the real tool name for ghost tools,
        // null for the other kinds). This REPLACES the prior inline
        // ghostToolSuggestion check in the route — the gate is now the
        // SINGLE owner of the check (no scattered duplicate; the route
        // only READS the result).
        // A gate AUTO-TRIP (the block that tripped the tool — NOT the
        // standing refusals a tripped tool keeps returning) routes the trip
        // through the breaker owner here: the same row flip + permission
        // event the boundary's armed check performs, so the panel shows the
        // tool tripped and the next boundary stops offering it. Runs
        // BEFORE the `!stopped()` gate and the SSE block below — the trip
        // is a safety consequence of the block, not a UI nicety; a
        // stopping run still trips. The run-end `finally` reverts this
        // run's auto-trips unless the user re-arms first.
        if (toolResult.gateBlock?.autoTripped === true && toolResult.gateBlock.autoTrippedAfter !== undefined) {
          try {
            await tripToolBreaker({
              db,
              userId: active.userId,
              tool: toolResult.gateBlock.toolName,
              failures: toolResult.gateBlock.autoTrippedAfter,
              autoRunId: runId,
            });
            // No snapshot refresh needed here: the next tool call's own
            // pre-call refresh re-reads the rows, and the gate's tripped-set
            // check (before ghost detection) answers same-turn repeats with
            // the honest refusal regardless of the manifest.
          } catch (tripErr) {
            webWarn("run", "gate auto-trip row flip failed", () => ({
              runId,
              tool: toolResult.gateBlock!.toolName,
              error: tripErr instanceof Error ? tripErr.message : String(tripErr),
            }));
          }
        }
        if (toolResult.gateBlock !== undefined && !stopped()) {
          const gb = toolResult.gateBlock;
          const gateMsg = toolResult.output;
          // The label names the intervention's actual kind (a schema
          // mismatch is a validation block, not a hallucination) — derived
          // from the gate owner's classifier, never a per-route literal, so
          // a new gate-block kind is labeled everywhere it surfaces.
          const eventKind = gateBlockEventKind(gb.kind);
          let eventId: string | undefined;
          // persist the gate-block event so it survives a
          // page refresh (third report — previously live-only). The tool
          // call's own ledger event id rides along as the PARENT: the tool
          // event (recorded by the executor's wrapper) and this inline
          // account are ONE incident recorded twice by design, and the
          // parent link is what lets every reader — the sweep's error count
          // included — fold the pair instead of counting it twice.
          if (chatId !== null) {
            try {
              eventId = await persistInlineEvent(
                db,
                chatId,
                runId,
                eventKind,
                gateMsg,
                active.userId,
                toolResult.toolEventId,
              );
            } catch (hallucErr) {
              webWarn("run", "gate-block persist failed", () => ({ runId, error: hallucErr instanceof Error ? hallucErr.message : String(hallucErr) }));
            }
          }
          publishRunFrame(runId, SSE_EVENT_TYPES.hallucination, {
            runId,
            ...(eventId !== undefined ? { eventId } : {}),
            callId: gb.callId,
            kind: gb.kind,
            toolName: gb.toolName,
            suggestion: gb.suggestion,
            message: gateMsg,
            // THE TRIP IS LIVE-ONLY WITHOUT THIS (UIE-036): the breaker row
            // flipped above, but the panel's rows are a cached Broker read —
            // the flip stays invisible until some UNRELATED event happens
            // to re-read them. The flag is the wire's own words for "the
            // row changed now", and the client turns it into the same
            // `tools:changed` invalidation the panel's own verbs fire.
            ...(gb.autoTripped === true ? { autoTripped: true } : {}),
          });
        }
        if (!stopped()) {
          publishRunFrame(runId, SSE_EVENT_TYPES.toolResult, {
            runId,
            callId: event.callId,
            toolName,
            // THE DISPATCHED ARGUMENTS (UIE-035): when the gate merged a
            // retained partial into the model's delta, the frame must
            // carry the whole the tool RAN with — a frame carrying only
            // the delta renders an artifact whose content nobody can
            // reach (the tool received the merge, the record kept the
            // delta). Absent the rewrite, the event's own arguments ARE
            // the dispatched whole.
            arguments: toolResult.dispatchedArguments ?? event.arguments,
            result: toolResult.output,
            success: toolResult.success,
            attemptCount,
          });
        }
        // Persist so tool calls + errors survive a refresh +
        // the attempt count survives refresh. The row's input takes the
        // DISPATCHED arguments for the same reason the frame does: the
        // hydration path renders the artifact from THIS row, and the delta
        // alone would paint the same unreachable frame after a reload. One
        // writer, this call — the resolved value is the merged whole when
        // the gate rewrote the call, else the model's own arguments.
        await persistToolResult(
          db,
          runId,
          event.callId,
          toolResult.output,
          toolResult.success,
          attemptCount,
          toolResult.dispatchedArguments ?? event.arguments,
        );
        // LLM control of the interface. When the LLM calls
        // control_interface successfully, the executor embedded the
        // validated action in the JSON output (single validation owner
        // — server/ui-control.ts). Forward it as a `ui_control` SSE
        // event so the frontend applies it (set_tab / toggle_panel /
        // set_theme / open_settings). Emitted AFTER the DB persist so
        // the row is durable before the side-effect notification. The
        // action is already validated; a parse failure here is a
        // wiring bug, never a silent UI mutation (defensive — the
        // executor owns the output shape).
        if (toolName === "control_interface" && toolResult.success && !stopped()) {
          try {
            const parsed = JSON.parse(toolResult.output) as { action?: UiControlAction };
            if (parsed.action !== undefined) {
              publishRunFrame(runId, SSE_EVENT_TYPES.uiControl, { runId, action: parsed.action });
            }
          } catch (uiErr) {
            webWarn("run", "control_interface output parse failed", () => ({ runId, error: uiErr instanceof Error ? uiErr.message : String(uiErr) }));
          }
        }
        // Reset on success / leave outstanding on failure (single owner:
        // server/attempt-counter.ts). Placed AFTER persistToolResult so the
        // result row + SSE event are written before the counter resets.
        active.toolAttemptCounts.set(toolName, nextCounterAfterCall(prevAttempts, toolResult.success));
        // SPO: store the tool result as a memory entry through
        // the memory owner's SINGLE entry point for tool-result storage
        // (`storeToolResultMemory`). The memory owner enforces BOTH
        // gates at the choke point: (1) the saveToMemory opt-in (the
        // manifest owner's `isSaveToMemoryTool`) AND (2) the result's
        // success. Previously the route built an inline opt-in Set and
        // checked it inline before storing — a SPO violation (the gate
        // lived in the route; a caller that bypassed the route skipped
        // the gate). Now `storeToolResultMemory` returns null when the
        // gate denies (tool did not opt in OR the result failed) — the
        // route does not need to know which tools opt in. Error
        // results are NEVER saved regardless of the opt-in flag. A
        // memory-store failure must never break the run.
        try {
          const contentMax = getToolMemoryContentMaxChars();
          const argsMax = getToolMemoryArgsMaxChars();
          const toolMemContent = `[${toolName}] ${toolResult.output.slice(0, contentMax)}`;
          const toolArgs = typeof event.arguments === "string"
            ? event.arguments
            : JSON.stringify(event.arguments).slice(0, argsMax);
          storeToolResultMemory(
            toolName,
            toolResult.success,
            toolMemContent,
            {
              originalRequest: toolArgs,
              ...(chatId !== null ? { chatId } : {}),
              userId: active.userId,
            },
            "short-term",
          );
        } catch (toolMemErr) {
          webWarn("memory", "failed to store tool result", () => ({ toolName, runId, error: toolMemErr instanceof Error ? toolMemErr.message : String(toolMemErr) }));
        }
        completedToolCalls.push({
          callId: event.callId,
          name: toolName,
          arguments: event.arguments,
          result: toolResult.output,
          success: toolResult.success,
        });
        // Tool-call recording for the event-feed detectors lives inside
        // executeToolCall (the function every parent and delegated call
        // already crosses). The runtime is threaded on the tool context
        // above; recording here would double-count the parent's calls and
        // still miss the sub-agent path.
      }
      if (event.type !== "error") {
        if (event.type !== "start" && event.type !== "tool_call_start") await persistModelEvent(db, runId, event);
        recordTimelineForModelEvent(runId, event);
      }
    }

    // A native policy refusal ends automatic work for this run, including
    // tool followups, queued steering and safety-generated continuation.
    if (policyStopped) break;

    // Record the assistant response in the unified context manager
    // (the single source of truth — no parallel conversationHistory).
    // When the turn included tool calls, the assistant turn carries
    // the tool_calls array and each tool result is added as a "tool"
    // turn with tool_call_id, so trimming keeps the group ATOMIC
    // (OpenAI contract: an assistant tool_calls message must stay
    // paired with its tool result messages).
    if (turnFinishReason === "tool_calls" && completedToolCalls.length > 0) {
      // Build the assistant tool_calls in the OpenAI format.
      const toolCallsForHistory: ToolCall[] = completedToolCalls.map((tc) => ({
        id: tc.callId,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      active.contextManager.addTurn({
        role: "assistant",
        content: turnAssistantText,
        toolCalls: toolCallsForHistory,
      });
      // route the assistant turn through the dedup layer.
      if (turnAssistantText.length > 0) wireDedupForTurn(turnAssistantText);
      // Append each tool result as a "tool" turn (matched by tool_call_id).
      for (const tc of completedToolCalls) {
        if (tc.result.length > 0) {
          active.contextManager.addTurn({
            role: "tool",
            content: tc.result,
            toolCallId: tc.callId,
          });
          // Route each tool result through the dedup layer too.
          wireDedupForTurn(tc.result);
        }
      }
    } else if (turnAssistantText.length > 0) {
      active.contextManager.addTurn({ role: "assistant", content: turnAssistantText });
      wireDedupForTurn(turnAssistantText);
    }

    // record the conversation summary turn (C09+summary, always
    // in context ~200 tokens) and trim approaching the token limit
    // trim is group-aware: a
    // tool_calls group is kept or summarized TOGETHER (never split).
    // SPO FIX: use the current turn's user message (not
    // always the initial prompt) + a MONOTONIC turn number (not
    // state.turns.length which decreases after trimming and causes
    // C09 summary entry collisions/overwrites).
    // THE TRIM IS NOT HERE ANY MORE, AND ITS ABSENCE IS THE FIX.
    //
    // Trimming at the END of a turn evicts against the manifest of the turn
    // that just finished, and the next turn re-reads the manifest at the
    // boundary above — so the eviction was priced for one request and the
    // request was made with another. With the retrieval tool withdrawn between
    // two turns this end-of-turn trim saw the cheap price, did nothing, and
    // the next `buildChatOpts()` sent the repriced history whole and
    // untrimmed. Eviction now happens where the history is derived, against
    // the manifest that same request carries.
    if (turnAssistantText.length > 0 || (turnFinishReason === "tool_calls" && completedToolCalls.length > 0)) {
      // SPO: feed the goal-deviation detector per turn (the assistant's
      // text; the files touched + searches are derived by the runtime owner
      // from the turn's own tool calls — one owner of that derivation).
      safetyRuntime.recordWork({ turn: summaryTurnNumber + 1, description: turnAssistantText });
      const intervention = safetyRuntime.takePendingIntervention();
      if (intervention.pause !== null && !stopped()) {
        // PERSIST FIRST, PUBLISH SECOND — the same order the steer door and
        // the safety-findings finally both use: the pause's frame carries
        // the ledger address its persist wrote, so the live beat joins the
        // record's row and the ledger's reveal affordance exists the moment
        // the pause lands (never only after a reload).
        let pauseEventId: string | undefined;
        if (chatId !== null) {
          try {
            pauseEventId = await persistInlineEvent(db, chatId, runId, "safety-finding", intervention.pause.message, active.userId);
          } catch (pauseErr) {
            webWarn("run", "pause-ask persist failed", () => ({ runId, error: pauseErr instanceof Error ? pauseErr.message : String(pauseErr) }));
          }
        }
        publishRunFrame(runId, SSE_EVENT_TYPES.pauseAsk, {
          runId,
          turn: intervention.pause.turn,
          message: intervention.pause.message,
          requestedActions: intervention.pause.requestedActions,
          ...(pauseEventId !== undefined ? { eventId: pauseEventId } : {}),
        });
        const pauseWait = await waitForRunPauseAnswer(
          active,
          active.abortController.signal,
          safetyRuntime.pauseAskWaitTimeoutMs,
        );
        if (pauseWait === "timedOut" && !stopped()) {
          // The pause was a question FOR THE USER that nobody answered
          // inside the configured bound. This is a seventh way the run
          // ends: not a fault (nothing threw), not a cancel (nobody asked
          // for it), and never a silent `done` — the pause question is
          // already in the transcript, and the run says plainly that the
          // wait ran out. The bound's own frame is the ending (the
          // iteration-limit shape).
          terminalFrame = {
            event: SSE_EVENT_TYPES.error,
            data: {
              runId,
              code: "pause_answer_timeout",
              message: `The run paused to ask a question and no answer arrived within the configured wait (${safetyRuntime.pauseAskWaitTimeoutMs} ms), so the run ended.`,
            },
          };
          break;
        }
      }
      if (intervention.rejectMessage !== null && !stopped()) {
        active.contextManager.addTurn({ role: "user", content: intervention.rejectMessage });
        // A stop-reason turn would otherwise `break` below and never send
        // this user turn to the model — the reject would be dropped.
        rejectedIntoNextTurn = true;
      }
      summaryTurnNumber += 1;
      active.contextManager.recordSummaryTurn(
        summaryTurnNumber,
        currentTurnUserMessage,
        turnAssistantText,
      );
    }

    if (isFirstTurn) {
      isFirstTurn = false;
    }

    // FIX if the turn ended with tool calls, feed the results
    // back to the LLM for a follow-up response. The tool results are
    // already tracked in the context manager (as "tool" turns); the
    // follow-up turn derives the trimmed history from the manager and
    // uses an empty prompt (streamChat sends the history as-is when
    // prompt is "").
    if (turnFinishReason === "tool_calls" && completedToolCalls.length > 0) {
      toolCallIterations++;
      if (toolCallIterations > toolIterationLimit) {
        // Safety bound: prevent infinite tool-call loops.
        // Every `error` frame carries a taxonomy `code` — the SAME
        // vocabulary the REST path sends as `{ error: <code> }`. Without
        // it the client had nothing to read and synthesised a cause from
        // `EventSource.readyState`, so every mid-run failure looked
        // identical and the displayed reason was invented. The guard in
        // tests/prevention/sse-error-code-owner.test.ts fails the build
        // if any `error` frame is emitted without one.
        //
        // RECORDED, NOT PUBLISHED HERE. This is how the run ENDS, and a
        // terminal frame is published once, last, at the single exit — see
        // the `finally`. Publishing it mid-loop put it BEFORE the run's
        // quality snapshot and timeline, which a client that closes on a
        // terminal frame would then never receive.
        terminalFrame = {
          event: SSE_EVENT_TYPES.error,
          data: {
            runId,
            code: "tool_iteration_limit",
            message: `Tool call iteration limit (${toolIterationLimit}) exceeded.`,
          },
        };
        break;
      }
      turnPrompt = "";
      continue;
    }

    // THE STEER DRAIN: entries that arrived while the turn STREAMED (after
    // the compose-point consumption at the turn's top) composed into no
    // request, so the loop starts a turn for them — one shift per turn, the
    // next turn's compose-point consumption accounts for any remainder.
    if (active.steeringQueue.length > 0) {
      active.steeringQueue.shift();
      // The count captured ONCE, so the row the persist writes and the
      // frame the publish sends state the same queue depth whatever
      // arrives during the persist's await — the join's content half is
      // the announcement's own words on both faces, live and reloaded.
      const steeredRemaining = active.steeringQueue.length;
      // The durable announcement first, the frame second — the composed
      // consumption's own order, and for the same reason: the frame can
      // then carry the row's own ledger address, and an arrival during
      // the await is consumed by the next turn exactly as it is there.
      let steerEventId: string | undefined;
      if (chatId !== null) {
        try {
          steerEventId = await persistInlineEvent(
            db,
            chatId,
            runId,
            "steering",
            `Steered — new turn starting (${steeredRemaining} queued)`,
            active.userId,
          );
        } catch (steerErr) {
          webWarn("run", "steering persist failed", () => ({ runId, error: steerErr instanceof Error ? steerErr.message : String(steerErr) }));
        }
      }
      publishRunFrame(runId, SSE_EVENT_TYPES.steered, {
        runId,
        remaining: steeredRemaining,
        delivery: "drain",
        ...(steerEventId !== undefined ? { eventId: steerEventId } : {}),
      });
      turnPrompt = "";
      continue;
    }

    // No steering messages — the run is complete, unless a reject still
    // has to reach the model on a stop-reason turn.
    if (rejectedIntoNextTurn) {
      turnPrompt = "";
      continue;
    }
    break;
  }
  } finally {
    // EVERY exit from the turn loop — the normal break, a cancellation's
    // early return, a thrown error — crosses here before the epilogue
    // below runs, so a run that is finishing never leaves a steering queue
    // open it will not read.
    active.steeringOpen = false;
  }

  // THE REGISTRY ENTRY LIVES FROM ADMISSION TO THE TERMINAL SETTLE, AND THE
  // EXECUTOR'S `finally` IS THE ONE REMOVAL.
  //
  // The claim used to be released here — the moment the turn loop ended, on
  // the reasoning that no further model request could race a second executor.
  // Measured against the live server (UIE-034), that reasoning had a hole the
  // reasoning itself named: everything after this point is EPILOGUE — the
  // quality snapshot, the memory write, the timeline replay — which takes
  // SECONDS on a real project, while the client's run view lives until the
  // terminal `done` frame (it renders "status running", stop verb present,
  // through the whole epilogue). In that window the steer door answered a
  // raw 404 about a run the reader was still watching, the cancel door did
  // the same, and the one-run gate admitted a SECOND executor whose requests
  // raced the first run's still-writing projection rows. The epilogue is not
  // invisible bookkeeping — it is part of the run the reader can still stop.
  //
  // So the release moved to the `finally`, immediately before the feed ends:
  // the registry claim and the terminal frame now settle together, and there
  // is no window in which the run is visible-live yet unanswerable. What
  // DOES end here is the run's ability to take a steering message — the loop
  // above will start no further turn, so a steer queued now would be
  // acknowledged and then silently lost. `steeringOpen` was closed at the
  // boundary every exit from the loop crosses, and the steer route refuses
  // with the guided "finishing" sentence instead of accepting a delivery
  // it can never make.

  // (quality automatic): after the run completes, score the
  // project's codebase quality and emit a "quality" SSE event so the
  // right panel shows real quality feedback without a manual button
  // press. The check is also persisted as an auto-check bound to the
  // chat so it survives a page refresh (the auto-checks panel reads
  // it back). The awareness-based indicator is lightweight (no
  // tree-sitter), so it is safe to run on every run.
  if (!stopped()) {
    try {
      // 502 wedge fix: the quality compute (awareness engine + repo
      // map) is CPU-heavy and runs in worker threads OFF the event
      // loop. The awaited workers yield the event loop while
      // building, so HTTP requests stay served (the previous sync
      // `engine.compute` wedged the server for tens of seconds on a
      // large codebase — the second 502 chat-run wedge).
      // THE GATE IS PASSED, and it is not redundant bookkeeping. The
      // ownership of this path IS established upstream — `active.projectPath`
      // comes from `db.getProject(input.projectId, user.userId)`, which is
      // scoped to the caller — so this is not a repair of a live leak. It is
      // the invariant being enforced where the bridge enforces it rather
      // than argued from a call chain a reader has to reconstruct: the
      // bridge's parameter is optional, and an omitted gate is an UNCHECKED
      // call that looks identical to a checked one.
      const qualityGate = await makeFsGate(active.userId, db, active.projectPath);
      const indicator = await getQualityIndicatorAsync(active.projectPath, qualityGate);
      publishRunFrame(runId, SSE_EVENT_TYPES.quality, { runId, ...indicator });
      if (chatId !== null) {
        await db.createAutoCheck(
          {
            project_id: active.projectId,
            chat_id: chatId,
            check_name: "lint",
            status: indicator.overallScore >= 80 ? "passed" : indicator.overallScore >= 60 ? "warning" : "failed",
            output: {
              score: indicator.overallScore,
              grade: indicator.grade,
              totalIssues: indicator.totalIssues,
              issuesPerKloc: indicator.issuesPerKloc,
              recommendations: indicator.recommendations,
            },
          },
          active.userId,
        );
      }
    } catch (qualityErr) {
      // A quality failure must never break the run stream. Emit a
      // typed error event and continue to "done". Also route through
      // the centralized debug bridge so the failure is visible when
      // debug is on (not a silent swallow).
      webWarn("run", "quality computation failed", () => ({ runId, error: qualityErr instanceof Error ? qualityErr.message : String(qualityErr) }));
      publishRunFrame(runId, SSE_EVENT_TYPES.quality, {
        runId,
        error: "quality_unavailable",
        message: qualityErr instanceof Error ? qualityErr.message : String(qualityErr),
      });
    }
  }

  // store the interaction in the memory store so it is retrievable
  // across runs/chats. The stored content is the
  // user prompt + the final assistant text, tagged with runId/chatId/topic.
  if (!stopped() && chatId !== null) {
    try {
      const finalAssistantText = active.accumulatedText;
      if (active.prompt.length > 0 || finalAssistantText.length > 0) {
        const interactionCap = getInteractionContentMaxChars();
        const assistantCapped = finalAssistantText.length > interactionCap
          ? `${finalAssistantText.slice(0, interactionCap)}…`
          : finalAssistantText;
        const interactionContent = `User: ${active.prompt}\nAssistant: ${assistantCapped}`;
        storeInteraction(interactionContent, {
          runId,
          chatId,
          topic: active.projectName,
          tags: ["chat", "interaction"],
          userId: active.userId,
        });
      }
    } catch (memErr) {
      // A memory-store failure must never break the run stream. Emit a
      // typed warning (not a silent swallow).
      webWarn("memory", "failed to store interaction", () => ({ runId, error: memErr instanceof Error ? memErr.message : String(memErr) }));
    }
  }

  if (!stopped()) {
    // Stream REAL timeline events recorded for this run (replaces the
    // fixture timeline event). The query reads the durable ledger.
    const timelineResult = getTimelineQuery().byRun(runId, { limit: 50 });
    for (const evt of timelineResult.events) {
      publishRunFrame(runId, SSE_EVENT_TYPES.timeline, evt);
      if (chatId !== null) await persistTimelineEvent(db, chatId, evt, active.userId);
    }
  }

  // Only stream REAL agent states from the agent runtime (if any are
  // active for this run). A simple chat does NOT create an agent — the
  // previous fixture injection of a fake "coordinator" agent is removed
  // so the Agents tab is truthful (empty until a real agent runs).
  // Deny-by-default: use the scoped `getAgentStatesForRun(runId)` —
  // iterating the GLOBAL store would load every user's agents into
  // memory (a cross-user exposure + O(N) over all users' active agents).
  // runId is this run's own server-generated id, so the filter is scoped
  // by construction.
  if (!stopped()) {
    for (const agent of getAgentStatesForRun(runId)) {
      publishRunFrame(runId, SSE_EVENT_TYPES.agent, agent);
    }
  }
  // ALL TURNS COMPLETE — recorded, not published here.
  //
  // `??=`, not `=`: a run that stopped at the tool-iteration bound, one whose
  // pause question went unanswered, or one whose LAST call failed has
  // already recorded how it ended, and overwriting that with `done` would
  // report a clean finish for a run that hit a safety limit or ended in
  // failure — the reader of the ending alone could not tell a failed run
  // from a finished one. The exit's own frame is the ending; this is only
  // the ending for a run that reached here without one — every turn
  // finished, or a failure the loop continued past and whose later turns
  // did finish.
  //
  // `done` is written AFTER the quality snapshot, the timeline events and the
  // agent states rather than before them, because `done` means "the client
  // closes the stream" — so anything published after it was, by its own
  // contract, sent to a client that had been told to leave.
  terminalFrame ??= { event: SSE_EVENT_TYPES.done, data: { runId } };
  // The finally below releases the activeRun, finalises stranded tool calls
  // and ends the feed — on this path and on every other.
} catch (err) {
  // -B1: an abort (client disconnect fired the close listener →
  // abortController.abort → the in-flight streamChat fetch rejects)
  // or an unexpected error. Never swallow — route through
  // the centralized debug bridge so the failure is visible
  // when debug is on, + emit a typed error event if the stream is
  // still open. An abort on a closed stream is expected (the client
  // is gone); the event send is guarded by isClosed so it's a no-op.
  // The REAL code off the thrown value, resolved by the SINGLE extractor the
  // taxonomy owner exposes (`codeForError`) — the same `.code` the REST path
  // would have put in `{ error: <code> }` had this failed before the response
  // was committed. An untyped throw carries no code, so the honest fallback
  // is `run_failed` ("the run failed and the thrower did not say why"), NOT a
  // specific cause the transport never reported.
  //
  // RECORDED, NOT PUBLISHED, and no longer guarded by `!stopped()`. That
  // guard is why a cancelled run said nothing at all: cancelling makes
  // `stopped()` true, the abort rejects the in-flight fetch, and the one
  // frame that would have reported an ending was skipped on its way past.
  // The `finally` decides between this and a cancellation, so the guard is
  // where the two are told apart rather than where one of them is dropped.
  terminalFrame = {
    event: SSE_EVENT_TYPES.error,
    data: {
      runId,
      code: codeForError(err, "run_failed"),
      message: err instanceof Error ? err.message : String(err),
    },
  };
  webWarn("run", "run stream ended unexpectedly", () => ({ runId, error: err instanceof Error ? err.message : String(err) }));
} finally {
  // THE ONE REMOVAL — every exit path crosses here, and this is the only
  // place a registry entry is forgotten for a run whose callback began
  // (the launch error path below owns the never-began case; the start
  // route's catch owns the refused-before-execution case). Before this
  // line the run was still visible-live to its reader; `endRunFeed` —
  // a few statements down, after the bookkeeping — publishes the terminal
  // frame, so the claim and the reader's own run view settle together.
  // Both delete + close are idempotent.
  deleteActiveRun(runId);
  // Release the run's agent-delegation substrate (the per-run agent tool
  // bundle + its state store) so a finished run's delegations do not
  // accumulate in the process-global map. Idempotent, like deleteActiveRun.
  releaseAgentBridge(runId);
  // SPO: event-feed safety verdicts. The loop can `return` early on cancel
  // (`if (stopped()) return`), which used to skip the post-loop detect() and
  // drop already-recorded findings. The finally is the single door every
  // exit walks through. completeTask stays gated: a cancelled run never
  // finished the task. detect() + publish + persist still run. The frame
  // carries `cancelled` so a stop is not reported as a clean end. Dispose
  // AFTER detect — disposing first would freeze the cache at empty.
  if (safetyRuntime !== undefined) {
    try {
      if (!stopped()) {
        safetyRuntime.completeTask({ turn: summaryTurnNumber + 1 });
      }
      const safetyReport = safetyRuntime.detect();
      // PERSIST FIRST, PUBLISH SECOND — the steer door's own order, for the
      // reason the steer door recorded: the frame can then carry each
      // finding's own ledger address (the persist's return), and the live
      // beat the client appends joins the record's row by that address
      // instead of arriving anonymous. The drive-18 filing this closes: a
      // live safety finding's ledger row carried no reveal affordance until
      // a reload re-read the ids — the one append path without an eventId.
      // A finding whose persist failed (or a run bound to no chat) carries
      // no address — the honest absent, never a fabricated one.
      const findings: { message: string; eventId?: string }[] = [];
      for (const findingMessage of safetyReport.messages) {
        let eventId: string | undefined;
        if (chatId !== null) {
          try {
            eventId = await persistInlineEvent(db, chatId, runId, "safety-finding", findingMessage, active.userId);
          } catch (findingErr) {
            webWarn("run", "safety-finding persist failed", () => ({ runId, error: findingErr instanceof Error ? findingErr.message : String(findingErr) }));
          }
        }
        findings.push({ message: findingMessage, ...(eventId !== undefined ? { eventId } : {}) });
      }
      publishRunFrame(runId, SSE_EVENT_TYPES.safetyFindings, {
        runId,
        ...safetyReport,
        messages: findings,
        cancelled: stopped(),
      });
    } catch (safetyErr) {
      webWarn("run", "safety-finding publish failed", () => ({ runId, error: safetyErr instanceof Error ? safetyErr.message : String(safetyErr) }));
    }
    safetyRuntime.dispose();
    safetyRuntime = undefined;
  }
  // NO TOOL CALL OUTLIVES ITS RUN.
  //
  // A tool_calls row is created "running" when the model announces the
  // call and moved to done/error when the result arrives. The only writer
  // that finalised them ran on the success path, so a run ending any other
  // way left its rows running forever: the history endpoint served them
  // back as "running" on every later reload, and there was no sweeper, no
  // reconciler and no startup pass anywhere in the server. The client-side
  // safety net had the same shape — one call site, on the `done` listener,
  // which is exactly the frame a failed run never sends.
  //
  // This runs on EVERY exit: completion, provider error, cancellation,
  // iteration bound. The row's output stays NULL — `output` is what the
  // tool returned, and writing the harness's own sentence there fed a
  // fabricated tool answer back to the model through the history rebuild.
  // The status is the whole record, and it is what the client's run-end
  // read-back uses to tell an honest absence (status, no output — the
  // placeholder stays) from a real result the stream never delivered
  // (status + output — the card heals).
  try {
    const stranded = await db.finalizeRunningToolCallsForRun(runId, active.userId);
    if (stranded > 0) {
      webWarn("run", "finalised tool calls left running by a run that ended", () => ({ runId, stranded }));
    }
  } catch (finalizeErr) {
    webWarn("run", "tool-call finalisation failed", () => ({ runId, error: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr) }));
  }
  // GATE AUTO-TRIP REVERT — the trip's lifetime is the run. The gate's
  // tripped set died with the gate instance above; this restores the row
  // flips the gate's auto-trips performed, so a fresh run starts with the
  // tool back on (the streak is per-run by design). Keyed on the marker's
  // OWN runId: a user's manual re-arm already cleared the marker (nothing
  // to revert), and a user-armed breaker trip re-stamped it without the
  // auto marker (the user's policy keeps its until-reset lifetime). A
  // crash before this point leaves the marker + the panel's tripped state
  // standing — the honest degraded state, one reset away.
  let revertedTools: readonly string[] = [];
  try {
    revertedTools = await revertGateAutoTrips(db, active.userId, runId);
    if (revertedTools.length > 0) {
      webWarn("run", "gate auto-trips reverted at run end", () => ({ runId, tools: revertedTools }));
    }
  } catch (revertErr) {
    webWarn("run", "gate auto-trip revert failed", () => ({ runId, error: revertErr instanceof Error ? revertErr.message : String(revertErr) }));
  }
  // ── EVERY WAY THIS RUN CAN STOP, AND HOW EACH ONE SAYS SO ────────────────
  //
  // Enumerated, because the previous version assumed there were two and there
  // are five — and the two it missed are the two that published nothing:
  //
  //   1. every turn finished             → `done`
  //   2. the tool-call iteration bound   → `error` / `tool_iteration_limit`
  //   2b. a pause-ask waited for an      → `error` / `pause_answer_timeout`:
  //      answer that never came within      the configured bound doing its job,
  //      the configured bound               so it says its own name, never `done`.
  //   3. the run threw                   → `error` / the thrower's own code
  //   3b. the LAST call failed           → `error` / the failing call's own
  //      code. The call's failure already has its own records — the error
  //      row the reader sees and the ledger event — but the run's ENDING
  //      is a different fact: a reconnect handed the terminal frame alone
  //      could not tell a failed run from a finished one. The loop-top
  //      clear keeps this naming the last call's fate: a run that
  //      continued past a failure and finished ends `done`.
  //   4. THE RUN WAS CANCELLED           → `cancelled`. Nothing at all, until
  //      now: every publish on the way out was guarded by `!stopped()`, and
  //      cancelling is exactly what makes `stopped()` true. The run that most
  //      obviously needed to say it had ended was the one that could not.
  //   5. cancelled, and then threw       → `cancelled`, for the same reason —
  //      the abort IS the cause of the throw, so reporting the throw would
  //      name a failure where a person pressed stop.
  //   6. anything nobody has thought of  → `run_ended_without_result`, which
  //      states what is known and invents no cause.
  //
  // ONE PUBLISH, HERE, LAST. Not because a terminal frame is hard to write at
  // each exit, but because the exits are what keep changing: cancellation
  // arrived without one, the iteration bound published one and then published
  // `done` on top of it, and `done` itself went out ahead of the run's own
  // timeline and agent frames. A sixth exit added tomorrow inherits the
  // guarantee without its author knowing this comment exists.
  //
  // `stopped()` is checked FIRST because cancellation outranks whatever else
  // was recorded on the way out: it is not a failure and must not be reported
  // as one.
  const endingFrame: RunTerminalFrame = stopped()
    ? { event: SSE_EVENT_TYPES.cancelled, data: { runId } }
    : (terminalFrame ?? {
        event: SSE_EVENT_TYPES.error,
        data: {
          runId,
          code: "run_ended_without_result",
          message: "The run stopped before it finished and did not report a reason.",
        },
      });
  // THE REVERT RIDES THE ENDING, THE SAME DOOR THE TRIP RODE ITS FRAME
  // (UIE-041). The auto-trip reverted SERVER-side just above — a write no
  // verb of the breaker panel fired — and the panel's rows are a cached
  // Broker read. Without this flag the client never re-reads them, so the
  // ▲ TRIPPED face and the annunciator keep offering a reset for a state
  // that ended minutes ago; only a reload or an unrelated invalidation
  // healed it. The flag is the wire's own words for "the rows changed
  // now", and the client turns it into the same `tools:changed`
  // invalidation the panel's own verbs fire — the exact mirror of the
  // trip's `autoTripped` flag on the hallucination frame. Present ONLY
  // when a trip actually reverted: an invalidation nobody's data changed
  // is the cry-wolf shape.
  endRunFeed(
    runId,
    revertedTools.length > 0
      ? {
          event: endingFrame.event,
          data: { ...(endingFrame.data as Record<string, unknown>), autoTripsReverted: true },
        }
      : endingFrame,
  );
}
  });
  } catch (launchErr) {
    // The run never started, so nothing downstream will ever end its feed or
    // forget it. Say so on the feed rather than releasing it silently: a
    // subscriber that reached it between the 201 and this point is owed a
    // terminal frame exactly as much as a run that failed later is.
    deleteActiveRun(runId);
    endRunFeed(runId, {
      event: SSE_EVENT_TYPES.error,
      data: {
        runId,
        code: codeForError(launchErr, "run_failed"),
        message: launchErr instanceof Error ? launchErr.message : String(launchErr),
      },
    });
    throw launchErr;
  }
}
