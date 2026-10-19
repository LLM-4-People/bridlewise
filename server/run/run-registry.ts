/**
 * WHO IS RUNNING, AND WHAT THEY OWN — the run registry.
 *
 * One process-global table of the runs currently in flight, and nothing else.
 * It answers "does this run exist, and whose is it?" for the routes that ask,
 * and it holds the mutable per-run state the executor accumulates while a turn
 * streams.
 *
 * IT IS A SEPARATE MODULE BECAUSE OF WHAT IT DOES NOT IMPORT. The subscriber
 * route (`routes/run-stream.ts`) needs the registry to answer its 404 and its
 * 403, and needs NOTHING else the old `routes/run.ts` reached — not the LLM
 * bridge, not the tool executor. Splitting the table out of the file that
 * calls a provider is what makes the subscriber's import cone provably clean:
 * the check is a walk of the import graph, not a list of function names
 * somebody has to keep current.
 *
 * The registry does NOT own the run's OUTPUT. Frames go to `run-feed.ts`,
 * which subscribers read; the registry never learns that a subscriber exists.
 * That is the point — a connection arriving or leaving is not an event in the
 * run's life.
 */

// The ONE value import, and it is the feed — which every consumer of this
// module already reaches. The registry therefore adds no executable module to
// anybody's import cone, which is what keeps the subscriber route's cone free
// of the LLM bridge and the tool executor. Everything else here is type-only
// and erased entirely.
import { runFeedOwner } from "./run-feed.ts";
import { guarded } from "../kernel/canonical.ts";
import type { ContextManager, RetrievedMemory } from "../context/context-bridge.ts";
import type { MessageMetadataUpdate } from "../db/client.ts";
import type { ToolCallGate } from "../kernel/canonical.ts";
import type { ProviderCredential } from "../llm/providers.ts";

export type ActiveRun = {
  readonly chatId: string | null;
  readonly prompt: string;
  /**
   * WHO THIS RUN TALKS TO, RESOLVED ONCE AT START.
   *
   * This used to be `modelId: string | null`, and the `null` was doing real
   * damage: it meant "nobody chose", which something downstream then had to
   * turn into a model — and what it turned it into was a server-wide default
   * that had nothing to do with the user's Settings. A run either has a
   * provider or it never started, so the nullable field is gone and with it
   * the branch that invented an answer.
   *
   * Resolved at `POST /api/run/start`, so an account with no provider is told
   * what to do BEFORE a run id exists, a message is persisted or a stream is
   * opened — rather than after, as a failed turn.
   */
  readonly credential: ProviderCredential;
  /** The owning user id (v12: multi-user). Threads the authenticated user
   * from run-start into the stream handler so tool/prompt/memory scoping
   * uses the run's user, not the (possibly different) stream requester. */
  readonly userId: string;
  /** The project's id (for auto-check persistence + DB linkage). */
  readonly projectId: string;
  /** The project's absolute path (for system prompt + tool execution). */
  readonly projectPath: string;
  /** The project's display name (for the system prompt). */
  readonly projectName: string;
  /** Accumulated assistant text for the current streaming turn. */
  accumulatedText: string;
  /** The DB message id of the current assistant message. Set only by the
   * call's own "start" frame (the persist case creates the message), and
   * cleared at the top of every turn iteration — so the id names THIS
   * call's message or nothing, never a previous call's: a call whose
   * request dies before its first frame has no message of its own, and the
   * error flush must stamp nothing rather than restamp the settled turn
   * before it. */
  assistantMessageId: string | null;
  /** AbortController for cancellation. */
  abortController: AbortController;
  /** Timeline run event id (parent for turns/messages in this run). */
  runEventId: string | null;
  /** Current turn id (generated per assistant turn). */
  turnId: string | null;
  /** Steering messages queued by the user while the current turn streams. */
  steeringQueue: string[];
  /**
   * WHETHER THE TURN LOOP CAN STILL TAKE A STEER.
   *
   * The registry entry now lives from the run's admission to its terminal
   * settle (the executor's `finally` — one removal, every exit path), which
   * is what makes the run's whole VISIBLE life answer its own doors: the
   * client's run view retires only at the terminal frame, so a window where
   * the entry is gone while the reader still watches "running" was a window
   * where the steer and cancel doors answered 404s about a run that had not
   * finished settling yet, and the one-run gate admitted a second executor
   * that overlapped the first run's own epilogue (the epilogue still writes
   * projection rows, so "no further model requests" was never the whole
   * safety argument once the reader can still see it live).
   *
   * But an entry that is alive cannot mean a steer can be DELIVERED: the
   * epilogue will start no further turn, so a steer queued there would be
   * acknowledged and then silently lost — the exact fabrication class this
   * product refuses. This flag is the run's own answer to that question,
   * closed at the one boundary every exit from the turn loop crosses.
   * Deny-by-default: a run that throws before its loop begins leaves the
   * door closed, and a steer pressed then is refused as "finishing" rather
   * than queued into a run that will never read the queue.
   */
  steeringOpen: boolean;
  /** Tool-call DB tracking: callId → { tool message id, tool_call row id,
   * startedAtMs }. The run stream creates a "tool" role message + a
   * "running" tool_call row on tool_call_start, updates the input on
   * tool_call_done, and updates the output+status+duration on
   * tool_result. This makes tool calls (and their errors) survive a
   * page refresh. Keyed by the stable callId from tool_call_start. */
  toolCallRows: Map<string, { messageId: string; rowId: string; startedAtMs: number }>;
  /** per-run per-tool-name attempt counter. When the LLM retries a
   * failed tool call (same name, new callId), this tracks how many times
   * the tool has been attempted so the UI can show "attempt 2/3" on the
   * tool card instead of spamming new identical cards (user: "on retry, we
   * should just update the specific tool call instead of spamming 2-3 new
   * ones"). Keyed by tool name; reset per run. */
  toolAttemptCounts: Map<string, number>;
  /** ── Rich chat-exposure metadata accumulation (persistence) ──
   * These fields are accumulated during streaming and persisted to the
   * assistant message's `metadata` JSON column so the full chat exposure
   * (reasoning, tokens, timing, headers, model, finish reason, context)
   * survives a page refresh. One persistence path: accumulated here →
   * updateMessageMetadata on finish → getChatHistory → hydrateChatFromHistory. */
  /** Accumulated reasoning text (from reasoning_delta events). */
  accumulatedReasoning: string;
  /** Token metrics from the last `usage` event for the current turn. */
  accumulatedTokenMetrics: MessageMetadataUpdate["tokenMetrics"];
  /** Response headers from the `metadata` SSE event (out-of-band). */
  accumulatedResponseHeaders: MessageMetadataUpdate["responseHeaders"];
  /** Actual responding model from the `metadata` SSE event. */
  accumulatedResponseModel: MessageMetadataUpdate["responseModel"];
  /**
   * The request's trace id, read from the ambient recording context in the
   * `metadata` SSE handler and persisted beside the headers/model so the
   * trace stays reachable from the message after the run view retires (a
   * refresh, or minutes later — exactly when an incident gets dug).
   */
  accumulatedTraceId: MessageMetadataUpdate["traceId"];
  /** Injected run context (system prompt, tools, history) from the
   * `context` SSE event. Persisted so the Context section survives reload. */
  accumulatedContext: MessageMetadataUpdate["context"];
  /**
   * The dedup summary for the CURRENT turn's LLM call, from the
   * `onDedup` callback (which fires before the request, hence before the
   * turn's `start` frame). Cleared at the top of every turn iteration so
   * a call that removed nothing inherits the previous call's savings
   * never; persisted to the assistant message's metadata blob on start +
   * finish + the error flush, exactly like the context.
   */
  accumulatedDedupSummary: MessageMetadataUpdate["dedupSummary"];
  /**
   * The redaction notice for the CURRENT turn's LLM call, from the
   * `onRedaction` callback (which fires before the request, hence before
   * the turn's `start` frame — the same arrival shape the dedup summary
   * and the context have). Cleared at the top of every turn iteration so
   * a call that masked nothing inherits the previous call's masking
   * never; persisted to the assistant message's metadata blob on start +
   * finish + the error flush, exactly like the dedup summary. Carries no
   * field that could hold the masked value itself.
   */
  accumulatedRedactionNotice: MessageMetadataUpdate["redactionNotice"];
  /** Wall-clock (ms epoch) when the current turn's "start" event arrived. */
  turnStartedAt: number | null;
  /** Wall-clock (ms epoch) when the first text_delta for the current turn
   * arrived. Used to compute TTFT. */
  turnFirstTokenAt: number | null;
  /** First token of ANY kind (reasoning or answer) — producing-window start. */
  turnFirstOutputAt: number | null;
  /** Finish-frame time. Kept so a late `usage` can stamp tps. */
  turnFinishedAt: number | null;
  /** ── progressive context manager (trim approaching the limit) ──
   * One per run. Each turn (user + assistant) is added; the manager trims
   * automatically when the token count crosses the threshold
   * (progressive context management that starts trimming/retrieving
   * BEFORE a critical limit while preserving old evidence). */
  contextManager: ContextManager;
  /** ── memories retrieved for the initial prompt (persisted in
   * the context SSE event so the "Recalled context" section survives a
   * page refresh). */
  readonly retrievedMemories: readonly RetrievedMemory[];
  /** SPO: the per-run hallucination/safety gate. Created when
   * the stream starts (after the enabled manifest is loaded) via
   * `createRunSafetyGate`. The gate's `getDefinitions` reads the LIVE
   * manifest on every `check`, so a tool toggled mid-run is reflected.
   * The loop-detection window persists across `check` calls within the
   * run. Passed to the executor via `ToolExecutionContext.gate` so the
   * gate runs BEFORE dispatch (the choke point — no caller bypasses it). */
  safetyGate: ToolCallGate | undefined;
  /**
   * The caller's per-tool override rows, as of the last refresh.
   *
   * The safety gate's `getDefinitions` is SYNCHRONOUS — it is called from
   * inside `executeToolCall`, which is synchronous all the way down into the
   * canonical gate — so it cannot await a database read. It used to issue one
   * itself, on the request thread, on every check.
   *
   * It now reads this snapshot, and the snapshot is refreshed IMMEDIATELY
   * BEFORE each tool call is executed, in the async frame that surrounds the
   * synchronous check. No `await` runs between the refresh and the check, so
   * the value the gate sees is the value a live read would have returned —
   * this is the same guarantee, not a weaker one, and it is stated here
   * because "live" was the whole point of the callback.
   */
  toolSettingsSnapshot: ReadonlyMap<string, boolean>;
};

const activeRuns = new Map<string, ActiveRun>();
const pauseWaiters = new WeakMap<ActiveRun, () => void>();

/**
 * How a pause-ask wait ended. The caller owns the terminal shape for a
 * timeout; "answered" and "cancelled" leave the run in its existing flow.
 */
export type RunPauseWaitOutcome = "answered" | "cancelled" | "timedOut";

/**
 * The event-feed pause-ask wait. Resolves "answered" when the user steers
 * (the existing steer route is the answer channel), "cancelled" when the
 * run is cancelled, and "timedOut" when the configured bound elapses with
 * neither. A pause is a USER question — without the bound an unanswered
 * one leaves the run alive in this process forever, so the bound is a
 * REQUIRED argument: waiting without one is not a shape this API offers.
 * `timeoutMs === 0` is the operator's explicit "wait forever".
 * If a steering message is already queued, returns immediately — the
 * user answered before the wait was installed.
 */
export function waitForRunPauseAnswer(active: ActiveRun, signal: AbortSignal, timeoutMs: number): Promise<RunPauseWaitOutcome> {
  if (active.steeringQueue.length > 0) return Promise.resolve("answered");
  if (signal.aborted) return Promise.resolve("cancelled");
  return new Promise<RunPauseWaitOutcome>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (outcome: RunPauseWaitOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      pauseWaiters.delete(active);
      resolve(outcome);
    };
    const onAbort = guarded("run.pause-wait.abort", (): void => { done("cancelled"); });
    pauseWaiters.set(active, () => done("answered"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(guarded("run.pause-wait.timeout", () => done("timedOut")), timeoutMs);
    if (active.steeringQueue.length > 0) done("answered");
    else if (signal.aborted) done("cancelled");
  });
}

/** Wake a run waiting on pause-ask. Called from the steer route after it queues the answer. */
export function notifyRunPauseAnswer(active: ActiveRun): void {
  pauseWaiters.get(active)?.();
}

/**
 * QUEUE ONE STEERING INSTRUCTION — the single act the steer route performs,
 * owning BOTH halves of the delivery in one synchronous stretch:
 *
 *   1. the instruction enters the context manager (it becomes part of the
 *      conversation the next request composes), and
 *   2. the queue takes the entry (the signal that tells the turn loop a
 *      turn must compose it).
 *
 * THE ORDER IS THE CORRECTNESS, NOT A STYLE CHOICE. The manager turn is
 * added BEFORE the queue entry, and nothing awaits between them, so at
 * every instant the executor can observe, a queue entry is already in the
 * manager: a turn that starts after this call composes the instruction,
 * and the loop's compose-point consumption (run-executor) can treat
 * "queued" as "composed by the next request" without a window in which
 * the two halves disagree. The reversed order (queue, then an awaited
 * row write, then the manager add — the old route shape) left a window
 * where the executor drained the signal while the words were not yet in
 * the conversation: an instruction consumed but never delivered. A call
 * site cannot reintroduce that window, because both mutations live here.
 *
 * Returns the queue depth after the entry lands (the steer route's
 * response and the pane's "N queued" line read the same number).
 */
export function queueSteer(active: ActiveRun, content: string): number {
  active.contextManager.addTurn({ role: "user", content });
  active.steeringQueue.push(content);
  return active.steeringQueue.length;
}

// ── The registry's door ──
//
// The Map is module-private. Every reader goes through these, so "who can
// reach a run" is answerable by reading this file rather than by grepping for
// a Map that used to be in scope for a thousand-line route module.

/** The run, or `undefined` when this process has no record of it. */
export function getActiveRun(runId: string): ActiveRun | undefined {
  return activeRuns.get(runId);
}

/** Record a run as in flight. Called once, by the start route. */
export function setActiveRun(runId: string, run: ActiveRun): void {
  activeRuns.set(runId, run);
}

/**
 * Forget a run. Idempotent.
 *
 * A run is forgotten when it ENDS or when it is CANCELLED — never because a
 * subscriber went away. A disconnect used to delete the run and abort its
 * work, which meant one party closing a tab ended another party's paid turn,
 * and a dropped socket made the run unreachable for good. A subscriber
 * leaving is now not an event this module hears about.
 */
export function deleteActiveRun(runId: string): boolean {
  return activeRuns.delete(runId);
}

/** How many runs this process currently has in flight. Reported rather than
 *  asserted: a guard that names a population has to be able to state it. */
export function activeRunCount(): number {
  return activeRuns.size;
}

/**
 * The run in flight for a CHAT, if one is — answered with its ID. The start
 * route's guard against a second concurrent run in one conversation (two
 * executors racing one transcript); ownership is part of the question, so a
 * foreign chat answers undefined exactly like a quiet one — the caller
 * refuses on "a run is live", never on whose run it is. The ID is the useful
 * half of the answer: the `chat_run_live` refusal NAMES this run as its own
 * subject so the client can adopt it (open its stream, plant its view) — a
 * run the client did not start is otherwise invisible in the flow and
 * unreachable by the refusal's own steer remedy. Callers needing the run
 * itself read it by ID (`getActiveRun`).
 */
export function activeRunForChat(
  chatId: string,
  userId: string,
): string | undefined {
  for (const [runId, run] of activeRuns) {
    if (run.chatId === chatId && run.userId === userId) return runId;
  }
  return undefined;
}

/**
 * WHO OWNS THIS RUN — for every route that has to answer 404-or-403.
 *
 * Asked in TWO places, and the second is what stops a finished run from
 * becoming an ownership hole. The registry knows runs that are still
 * executing. The feed outlives the run by its retention window and carries the
 * same owner, so a request about a run that ended moments ago still resolves.
 *
 * Without the second lookup, a run's completion silently converts every
 * foreign request from "403, that is not yours" to "404, no such run" — the
 * caller learns nothing wrong, but the routes stop agreeing with each other
 * about what a run is, and the subscriber's reconnect becomes impossible for
 * exactly the same reason. One resolution, used by all three run routes, so
 * they cannot drift apart.
 *
 * `undefined` means this process has no record of the run at all, which is the
 * only honest 404.
 */
export function resolveRunOwner(runId: string): string | undefined {
  return activeRuns.get(runId)?.userId ?? runFeedOwner(runId)?.userId;
}
