import type { ProviderRequestOptions } from "../shared/llm/client.ts";
import { bindResponseContext, projectResponseContext } from "../shared/llm/response-transcript.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { reportBestEffortFailure } from "../shared/debug/debug-system.ts";
import { sha256, canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import type { ExecutionClosure } from "../kernel/execution-closure.ts";
import type { AttemptHistory } from "../memory/attempt-history.ts";
import type { AddTurnInput, UnifiedContextManager } from "../memory/unified/unified-context-manager.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import type { ProviderAdapter, ChatMessage, TokenUsage, ToolCall } from "./provider-adapter.ts";
import type { ToolRegistry, ToolResult } from "./tool-registry.ts";
import { type ToolCallGate, type ToolCallGateConfig } from "../safety/tool-call-gate.ts";
import { createGovernedToolDispatch, type GovernedToolDispatch, type GovernedToolExecution } from "./governed-tool-dispatch.ts";
import { ResponseTurn, responseAssistantMessage, turnRequest, type NativeResponseObserver } from "./response-turn.ts";
import { toolsToResponses, type ResponseResource, type ResponseStatus } from "../shared/llm/responses.ts";
import { inspectResponseDisposition, assertResponseDispositionAvailable, type ResponseDisposition } from "../shared/llm/responses-disposition.ts";
import { isLLMError, MISALIGNMENT_POLICY_ERROR_CODE, type LLMError } from "../shared/llm/errors.ts";

/**
 * Interactive session library for provider-agnostic hosts.
 *
 * Maintains multi-turn conversation state (message history, cumulative
 * token usage), drives the provider adapter, executes tool calls in a
 * bounded loop, and records every operation in the execution-closure
 * ledger so the timeline has no gaps.
 *
 * The session is a pure state machine: it does not perform I/O directly
 * (the provider adapter handles HTTP; the tool registry handles
 * filesystem). This makes it deterministic and easy to test with mocks.
 */

import { DEFAULT_MAXIMUM_TOOL_ITERATIONS } from "./runtime-config.ts";

/**
 * Shared diagnostic counter for recording and context operations.
 * Context failures additionally close the provider request path. Failures are counted and the
 * first failure is reported through the debug owner so the problem is not silently
 * swallowed (RES-1, RES-7).
 */
type FailureTracker = { count: number; warningEmitted: boolean };

function noteFailure(tracker: FailureTracker): void {
  tracker.count++;
  if (!tracker.warningEmitted) {
    tracker.warningEmitted = true;
    reportBestEffortFailure();
  }
}

export type InteractiveSessionOptions = Readonly<{
  adapter: ProviderAdapter;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  toolRegistry: ToolRegistry;
  repositoryRoot: string;
  closure?: ExecutionClosure;
  timeline?: TimelineRecorder;
  contextManager?: UnifiedContextManager;
  /**
   * Optional attempt history (REQ-020). When provided, the session records
   * each turn as an attempt so future retries can retrieve similar prior
   * attempts via `attemptHistory.retrieveBeforeRetry`. The session only
   * records; the retrieval-before-retry policy is owned by the caller.
   */
  attemptHistory?: AttemptHistory;
  correlation?: SessionCorrelation;
  maximumToolIterations?: number;
  defaultToolChoice?: "auto" | "none" | "required";
  /**
   * Pre-dispatch hallucination gate. When omitted, one is created from
   * `toolRegistry` with the default config (or `gateConfig` when provided).
   * The gate validates every tool call BEFORE it reaches the registry:
   * ghost-tool detection, argument schema validation, and loop detection.
   * Blocked calls are returned to the model as structured error results.
   */
  toolCallGate?: ToolCallGate;
  /** Config for the auto-created gate (ignored when `toolCallGate` is set). */
  gateConfig?: ToolCallGateConfig;
  governedExecution?: GovernedToolExecution;
  /** Durable native output must settle before action admission and execution. */
  onResponse?: NativeResponseObserver;
  /** Private local ownership callback, separate from native response observations. */
  onResponseReceipt?: ProviderRequestOptions["onResponseReceipt"];
}>;

export type SessionCorrelation = Readonly<{
  runId?: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
}>;

export type SessionEvent =
  | Readonly<{ type: "content"; text: string }>
  | Readonly<{ type: "tool_call_start"; index: number; id: string; name: string }>
  | Readonly<{ type: "tool_call_delta"; index: number; arguments: string }>
  | Readonly<{ type: "tool_result"; result: ToolResult }>
  | Readonly<{ type: "usage"; usage: TokenUsage }>
  | Readonly<{ type: "finish"; reason: string }>
  | Extract<import("./provider-adapter.ts").ChatStreamEvent, { type: "response" | "response_event" }>
  | Readonly<{ type: "error"; error: HarnessError | LLMError }>;

export type TurnResult = Readonly<{
  content: string;
  refusal?: string;
  toolCalls: readonly ToolCall[];
  usage: TokenUsage | undefined;
  finishReason: string;
  toolResults: readonly ToolResult[];
  iterations: number;
  response?: ResponseResource;
  status?: ResponseStatus;
  disposition?: ResponseDisposition;
  errorCode?: string;
}>;

export type SessionState = Readonly<{
  messages: readonly ChatMessage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  turnCount: number;
}>;

export function createInteractiveSession(options: InteractiveSessionOptions): InteractiveSession {
  const maximumToolIterations = options.maximumToolIterations ?? DEFAULT_MAXIMUM_TOOL_ITERATIONS;
  const recordingFailures: FailureTracker = { count: 0, warningEmitted: false };
  const contextManagerFailures: FailureTracker = { count: 0, warningEmitted: false };
  const attemptHistoryFailures: FailureTracker = { count: 0, warningEmitted: false };
  // Pre-dispatch hallucination gate — validates tool calls BEFORE they reach
  // the registry. Ghost tools, schema mismatches, and loops are blocked and
  // returned to the model as structured error tool results (EXP485).
  const dispatch = createGovernedToolDispatch({
    registry: options.toolRegistry, repositoryRoot: options.repositoryRoot,
    ...(options.toolCallGate === undefined ? {} : { gate: options.toolCallGate }),
    ...(options.gateConfig === undefined ? {} : { gateConfig: options.gateConfig }),
    ...(options.governedExecution === undefined ? {} : { governedExecution: options.governedExecution }),
  });
  if (options.contextManager !== undefined) bindResponseContext(options.contextManager);
  const messages: ChatMessage[] = options.systemPrompt.length > 0
    ? [deepFreeze({ role: "system" as const, content: options.systemPrompt })]
    : [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let turnCount = 0;
  const contextTurnIds: (string | undefined)[] = [];
  let contextFailure: HarnessError | undefined;
  let policyFailure: LLMError | undefined;

  function contextError(): HarnessError {
    noteFailure(contextManagerFailures);
    return contextFailure ??= new HarnessError("Conversation context could not be captured or projected", "session_context_failed", false);
  }

  function captureMessage(message: ChatMessage, index = messages.length): number {
    messages[index] = message; // Private evidence precedes every public yield and context observer.
    const cm = options.contextManager;
    if (cm === undefined || contextFailure !== undefined) return index;
    const input: AddTurnInput = { role: message.role, content: message.content,
      ...(message.tool_calls === undefined ? {} : { toolCalls: message.tool_calls as NonNullable<AddTurnInput["toolCalls"]> }),
      ...(message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id }),
      ...(message.responseItems === undefined ? {} : { responseItems: message.responseItems }),
      ...(message.responseReplayBlocked === undefined ? {} : { responseReplayBlocked: message.responseReplayBlocked }),
      ...(message.role === "system" ? { pinned: true } : {}) };
    try {
      const id = contextTurnIds[index];
      contextTurnIds[index] = (id === undefined ? cm.addTurn(input) : cm.updateTurn(id, input)).turnId;
    } catch { contextError(); return index; }
    return index;
  }

  function assertContextReady(): void {
    if (contextFailure !== undefined) throw contextFailure;
  }

  function requestMessages(): readonly ChatMessage[] {
    if (contextFailure !== undefined) throw contextFailure;
    if (options.contextManager === undefined) return [...messages];
    try {
      options.contextManager.trim();
      return projectResponseContext(options.contextManager);
    } catch (error) {
      // Preserve an exact protocol readiness refusal; other capture faults latch.
      if (isLLMError(error)) throw error;
      throw contextError();
    }
  }

  for (const [index, message] of messages.entries()) captureMessage(message, index);

  function lastUserMessage(): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role === "user") return m.content;
    }
    return "";
  }

  function recordAttempt(result: TurnResult): void {
    if (options.attemptHistory === undefined) return;
    const intent = lastUserMessage();
    if (intent.length === 0) return;
    const failed = result.errorCode !== undefined || result.status !== "completed";
    try {
      options.attemptHistory.record({
        kind: "prompt",
        intent,
        input: intent,
        outcome: failed ? "failed" : "succeeded",
        // AttemptHistory requires non-empty result; a turn may legitimately
        // produce no content (e.g. a turn that only emitted tool calls or
        // errored before any content streamed). Use a placeholder so the
        // attempt is still recorded for retrieval-before-retry.
        result: result.content.length > 0 ? result.content : "(no content)",
        ...(failed ? { error: result.finishReason } : {}),
        ...(options.correlation?.runId !== undefined ? { agentId: options.correlation.runId } : {}),
      });
    } catch {
      return noteFailure(attemptHistoryFailures);
    }
  }

  return deepFreeze({
    addUserMessage(text: string): void {
      if (policyFailure) throw policyFailure;
      if (text.length === 0) throw new InputError("User message is empty", "session_empty_message");
      if (contextFailure !== undefined) throw contextFailure;
      captureMessage(deepFreeze({ role: "user", content: text }));
      assertContextReady();
      recordTimelineEvent(options, recordingFailures, "message", `User message (${text.length} chars)`, {
        correlation: {},
      });
    },
    clearHistory(): void {
      if (policyFailure) throw policyFailure;
      // Reset the conversation to just the system prompt. Cumulative token
      // usage and turn count are preserved — /clear resets the model's
      // context window, not the session accounting (use /usage to view it).
      if (options.contextManager !== undefined) {
        try {
          options.contextManager.clear();
        } catch {
          throw contextError();
        }
      }
      contextFailure = undefined;
      contextTurnIds.length = 0;
      messages.length = 0;
      if (options.systemPrompt.length > 0) captureMessage(deepFreeze({ role: "system", content: options.systemPrompt }));
      assertContextReady();
    },
    messages(): readonly ChatMessage[] {
      return [...messages];
    },
    state(): SessionState {
      return deepFreeze({
        messages: [...messages],
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        turnCount,
      });
    },
    getRecordingFailures(): number {
      return recordingFailures.count;
    },
    getContextManagerFailures(): number {
      return contextManagerFailures.count;
    },
    getAttemptHistoryFailures(): number {
      return attemptHistoryFailures.count;
    },
    async* runTurn(signal?: AbortSignal): AsyncGenerator<SessionEvent, TurnResult, unknown> {
      if (policyFailure) throw policyFailure;
      const turnId = (options.correlation?.turnId ?? generateId("turn"));
      turnCount++;
      recordTimelineEvent(options, recordingFailures, "turn", `Turn ${turnCount} started`, {
        correlation: { turnId },
      });
      let iteration = 0;
      let lastResult: TurnResult;
      const allToolResults: ToolResult[] = [];
      while (true) {
        const result = yield* runSingleRequest(options, recordingFailures, requestMessages(), captureMessage, assertContextReady, iteration, turnId, signal, dispatch, error => { policyFailure = error; });
        lastResult = result;
        allToolResults.push(...result.toolResults);
        if (result.usage) {
          totalPromptTokens += result.usage.promptTokens;
          totalCompletionTokens += result.usage.completionTokens;
          totalTokens += result.usage.totalTokens;
          const usageJson = JSON.stringify({
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          });
          recordTimelineEvent(options, recordingFailures, "token",
            `Token usage: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}`,
            {
              correlation: { turnId },
              documents: [{
                name: "usage",
                contentJson: usageJson,
                contentDigest: sha256(usageJson),
              }],
            });
        }
        recordTimelineEvent(options, recordingFailures, "message", `Assistant message (${result.content.length} chars)`, {
          correlation: { turnId },
        });
        const needsContinuation = result.disposition?.kind === "actions" || result.disposition?.kind === "continue";
        if (!needsContinuation || result.finishReason === "error") break;
        if (iteration >= maximumToolIterations) {
          lastResult = { ...result, finishReason: "tool_iteration_limit", errorCode: "session_iteration_limit" };
          break;
        }
        iteration++;
      }
      const turnResult = deepFreeze({
        ...lastResult,
        toolResults: deepFreeze(allToolResults),
        iterations: iteration + 1,
      });
      recordAttempt(turnResult);
      return turnResult;
    },
  });
}

export type InteractiveSession = Readonly<{
  addUserMessage(text: string): void;
  clearHistory(): void;
  messages(): readonly ChatMessage[];
  state(): SessionState;
  runTurn(signal?: AbortSignal): AsyncGenerator<SessionEvent, TurnResult, unknown>;
  getRecordingFailures(): number;
  getContextManagerFailures(): number;
  getAttemptHistoryFailures(): number;
}>;

async function* runSingleRequest(
  options: InteractiveSessionOptions,
  recordingFailures: FailureTracker,
  messages: readonly ChatMessage[],
  captureMessage: (message: ChatMessage, index?: number) => number,
  assertContextReady: () => void,
  iteration: number,
  turnId: string,
  signal: AbortSignal | undefined,
  dispatch: GovernedToolDispatch,
  stopForPolicy: (error: LLMError) => void,
): AsyncGenerator<SessionEvent, TurnResult, unknown> {
  const tools = options.toolRegistry.definitions();
  const toolChoice = options.defaultToolChoice ?? "auto";
  const request = turnRequest({
    model: options.model,
    messages: [...messages],
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 ? { tool_choice: toolChoice } : {}),
  }, signal);
  const effectId = `provider-${turnId}-${iteration}`;
  recordIntent(options, recordingFailures, effectId, "provider", request);
  const turn = new ResponseTurn();
  const toolResults: ToolResult[] = [];
  let providerSettled = false;
  let assistantIndex: number | undefined;
  const remember = (result: import("./provider-adapter.ts").ChatCompletionResult & Readonly<{ errorCode?: string }>, requireContext = true): void => {
    if (!turn.hasEvidence) return;
    assistantIndex = captureMessage(responseAssistantMessage(result, turn.hasEvidence), assistantIndex);
    if (requireContext) assertContextReady();
  };
  try {
    for await (const event of turn.stream(options.adapter, request,
      { onResponseReceipt: options.onResponseReceipt, onResponse: options.onResponse, onFailureEvidence: result => remember(result) }, signal)) {
      if (signal?.aborted) {
        throw new InputError("Turn cancelled by user", "session_cancelled");
      }
      switch (event.type) {
        case "content": case "tool_call_start": case "tool_call_delta": case "usage":
        case "response": case "response_event": yield event; break;
        case "refusal": yield { type: "content", text: event.text }; break;
      }
    }
    const result = turn.complete();
    const outcome = result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
    recordTerminal(options, recordingFailures, effectId, "provider", outcome);
    providerSettled = true;
    const disposition = inspectResponseDisposition(result.response!, result.status, {
      tools: toolsToResponses(tools), toolChoice, admit: dispatch.admit,
    });
    assertResponseDispositionAvailable(disposition);
    for await (const { result: toolResult } of dispatch.execute(disposition.toolCalls, tools, signal, {
      beforeExecute: call => recordIntent(options, recordingFailures, `tool-${turnId}-${iteration}-${call.id}`, "process", {
        tool: call.function.name, arguments: call.function.arguments,
      }),
      afterExecute: (call, output) => recordTerminal(options, recordingFailures, `tool-${turnId}-${iteration}-${call.id}`, "process", output.isError ? "failed" : "succeeded"),
      afterFailure: call => recordTerminal(options, recordingFailures, `tool-${turnId}-${iteration}-${call.id}`, "process", signal?.aborted ? "cancelled" : "failed"),
    })) {
      toolResults.push(toolResult);
      captureMessage(deepFreeze({ role: "tool", content: toolResult.content, tool_call_id: toolResult.toolCallId }));
      assertContextReady();
      yield { type: "tool_result", result: toolResult };
    }
    remember(result);
    yield { type: "finish", reason: result.finishReason };
    return deepFreeze({ ...result, toolCalls: disposition.toolCalls, toolResults, disposition, iterations: 0 });
  } catch (error) {
    if (isLLMError(error) && error.code === MISALIGNMENT_POLICY_ERROR_CODE) stopForPolicy(error);
    const providerError = error instanceof HarnessError || isLLMError(error)
      ? error
      : new HarnessError("Provider operation failed", "session_provider_error", false);
    if (!providerSettled) {
      recordTerminal(options, recordingFailures, effectId, "provider", signal?.aborted ? "cancelled" : "failed", providerError);
      providerSettled = true;
    }
    const result = { ...turn.failed(), errorCode: providerError.code };
    remember(result, false);
    turn.retireReceipt();
    yield { type: "error", error: providerError };
    return deepFreeze({ ...result, toolResults, iterations: 0 });
  } finally {
    try {
      if (!providerSettled) {
        if (turn.hasEvidence) remember(turn.failed(), false);
        recordTerminal(options, recordingFailures, effectId, "provider", "cancelled");
      }
    } finally { turn.retireReceipt(); }
  }
}

function recorderOf(options: InteractiveSessionOptions): EffectRecorder | undefined {
  if (options.timeline !== undefined) return options.timeline;
  return options.closure;
}

type EffectRecorder = Pick<ExecutionClosure, "beginEffect" | "endEffect"> | Pick<TimelineRecorder, "beginEffect" | "endEffect">;

function recordIntent(
  options: InteractiveSessionOptions,
  recordingFailures: FailureTracker,
  effectId: string,
  kind: "provider" | "process",
  payload: unknown,
): void {
  const recorder = recorderOf(options);
  if (recorder === undefined) return;
  try {
    // The provider request carries an `AbortSignal` for operational
    // cancellation. The signal is not part of the semantic intent and is not
    // canonicalizable (`canonicalHash` throws on non-plain objects such as
    // AbortSignal, DOMException, etc.). Strip it before hashing so the
    // timeline records the intent instead of dropping the entire event.
    // The signal is an operational concern; the intent hash must reflect
    // only the semantic request (model, messages, tools, etc.).
    const serializablePayload = stripNonSerializableFields(payload);
    recorder.beginEffect({
      effectId,
      kind,
      actor: { kind: "harness", id: "interactive-session", role: "runtime" },
      ...(options.correlation?.runId !== undefined ? { correlation: { runId: options.correlation.runId } } : {}),
      description: kind === "provider" ? "Provider chat completion request" : "Tool execution",
      intentHash: canonicalHash(serializablePayload),
    });
  } catch {
    return noteFailure(recordingFailures);
  }
}

/**
 * Strip non-serializable fields from an intent payload before canonical
 * hashing. Currently strips `signal` (AbortSignal) from provider requests.
 * Returns the payload unchanged for non-plain-object payloads (arrays,
 * primitives, null). The returned object is a shallow copy; the original
 * payload is not mutated.
 */
function stripNonSerializableFields(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Readonly<Record<string, unknown>>;
  if (!("signal" in record)) return payload;
  const { signal: _signal, ...rest } = record;
  void _signal;
  return rest;
}

function recordTerminal(
  options: InteractiveSessionOptions,
  recordingFailures: FailureTracker,
  effectId: string,
  kind: "provider" | "process",
  outcome: "succeeded" | "failed" | "cancelled",
  error?: HarnessError | LLMError,
): void {
  const recorder = recorderOf(options);
  if (recorder === undefined) return;
  try {
    recorder.endEffect(effectId, {
      outcome,
      resultHash: canonicalHash({ effectId, outcome }),
      ...(error !== undefined
        ? { error: { category: kind, code: error.code, message: error.message, retryable: error.retryable } }
        : {}),
    });
  } catch {
    return noteFailure(recordingFailures);
  }
}

function recordTimelineEvent(
  options: InteractiveSessionOptions,
  recordingFailures: FailureTracker,
  eventType: "turn" | "message" | "token",
  description: string,
  extra?: Readonly<{ correlation?: Record<string, string | undefined>; documents?: readonly { name: string; contentJson?: string; contentDigest: string }[] }>,
): void {
  if (options.timeline === undefined) return;
  try {
    const correlation: Record<string, string | undefined> = {};
    if (options.correlation?.runId !== undefined) correlation.runId = options.correlation.runId;
    if (extra?.correlation !== undefined) {
      for (const [k, v] of Object.entries(extra.correlation)) { if (v !== undefined) correlation[k] = v; }
    }
    options.timeline.recordEvent({
      eventType,
      description,
      ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
      ...(extra?.documents !== undefined ? { documents: extra.documents } : {}),
    });
  } catch {
    return noteFailure(recordingFailures);
  }
}
