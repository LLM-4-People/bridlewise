import type { ProviderRequestOptions } from "../shared/llm/client.ts";
import { InputError, HarnessError } from "../kernel/errors.ts";
import { bestEffortAsync } from "../shared/best-effort.ts";
import { guarded } from "../process/fault-policy.ts";
import { deepFreeze, generateId } from "../kernel/integrity.ts";
export { DEFAULT_AGENT_TIMEOUT_MS } from "./agents-config.ts";
import { combineSignals } from "../shared/abort-signals.ts";
import type { ExecutionClosure } from "../kernel/execution-closure.ts";
import type { MetricsCollector, MetricScopeKey } from "../performance/metrics-collector.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import type { ChatMessage, ProviderAdapter, ToolCall, ToolDefinition } from "../runtime/provider-adapter.ts";
import type { ToolRegistry, ToolResult } from "../runtime/tool-registry.ts";
import type { AgentProfile, RuntimeProviderModel } from "./agent-config.ts";
import type { AgentStateStore } from "./agent-state.ts";
import type { AgentHookContext, AgentLifecycleHooks } from "./agent-type-registry.ts";
import { ResponseTurn, responseAssistantMessage, turnRequest, type NativeResponseObserver } from "../runtime/response-turn.ts";
import { createGovernedToolDispatch, type GovernedToolExecution } from "../runtime/governed-tool-dispatch.ts";
import type { ToolCallGate, ToolCallGateConfig } from "../safety/tool-call-gate.ts";
import { inspectResponseDisposition, assertResponseDispositionAvailable, type ResponseDisposition } from "../shared/llm/responses-disposition.ts";
import { toolsToResponses, type ResponseResource, type ResponseStatus } from "../shared/llm/responses.ts";
import { isLLMError, MISALIGNMENT_POLICY_ERROR_CODE, type LLMError } from "../shared/llm/errors.ts";

/**
 * Agent runtime — executes a single agent's task.
 *
 * Loads agent config, creates an interactive session using the existing
 * runtime, executes the agent's task in a bounded turn loop, records every
 * turn in the timeline, and respects capabilities and write sets.
 *
 * The agent runtime is a pure state machine that delegates I/O to the
 * provider adapter and tool registry. It does not directly perform
 * filesystem writes — agents must acquire a write lease through the
 * orchestrator for any write operation.
 */

export type AgentRuntimeOptions = Readonly<{
  adapter: ProviderAdapter;
  toolRegistry: ToolRegistry;
  modelConfig: RuntimeProviderModel;
  profile: AgentProfile;
  repositoryRoot: string;
  stateStore: AgentStateStore;
  runId: string;
  taskId: string;
  attemptId: string;
  closure?: ExecutionClosure;
  timeline?: TimelineRecorder;
  metricsCollector?: MetricsCollector;
  messageInjector?: () => readonly string[];
  turnBoundary?: () => Promise<void>;
  hooks?: AgentLifecycleHooks;
  timeoutMs?: number;
  defaultToolChoice?: "auto" | "none" | "required";
  toolCallGate?: ToolCallGate;
  gateConfig?: ToolCallGateConfig;
  governedExecution?: GovernedToolExecution;
  onResponse?: NativeResponseObserver;
  /** Private local ownership callback, separate from native response observations. */
  onResponseReceipt?: ProviderRequestOptions["onResponseReceipt"];
}>;

export type AgentTurnResult = Readonly<{
  content: string;
  refusal?: string;
  toolCalls: readonly ToolCall[];
  toolResults: readonly ToolResult[];
  finishReason: string;
  usage: Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }> | undefined;
  iterations: number;
  response?: ResponseResource;
  status?: ResponseStatus;
  disposition?: ResponseDisposition;
  errorCode?: string;
}>;

export type AgentRunResult = Readonly<{
  agentId: string;
  agentName: string;
  turns: readonly AgentTurnResult[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  finishReason: string;
  lifecycleState: "succeeded" | "failed" | "cancelled";
  error: string | null;
}>;

export type AgentEvent =
  | Readonly<{ type: "turn_start"; turnNumber: number }>
  | Readonly<{ type: "content"; text: string }>
  | Extract<import("../runtime/provider-adapter.ts").ChatStreamEvent, { type: "response" | "response_event" }>
  | Readonly<{ type: "tool_call"; name: string; arguments: string }>
  | Readonly<{ type: "tool_result"; result: ToolResult }>
  | Readonly<{ type: "turn_end"; turnNumber: number; finishReason: string }>
  | Readonly<{ type: "agent_end"; result: AgentRunResult }>;

/**
 * Maximum characters of an agent's final assistant output surfaced through
 * delegation results (A-1). Longer outputs are truncated with a marker so a
 * delegated answer cannot overflow the delegating model's context.
 */
const MAX_DELEGATION_OUTPUT_CHARS = 2_000;

/**
 * Extract an agent's final assistant message content for delegation results
 * (A-1). A final native turn's text or refusal wins over earlier progress.
 * Callers without native disposition use the last non-empty projection. Bounded to
 * MAX_DELEGATION_OUTPUT_CHARS with an explicit truncation marker.
 */
export function extractFinalAgentOutput(turns: readonly AgentTurnResult[]): Readonly<{ output: string; truncated: boolean }> {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.disposition !== undefined && turn.disposition.kind !== "final") continue;
    const content = turn.content || turn.refusal || "";
    if (content.length > 0 || turn.disposition?.kind === "final") {
      if (content.length > MAX_DELEGATION_OUTPUT_CHARS) {
        return deepFreeze({
          output: `${content.slice(0, MAX_DELEGATION_OUTPUT_CHARS)}… [truncated: ${content.length} chars total, limit ${MAX_DELEGATION_OUTPUT_CHARS}]`,
          truncated: true,
        });
      }
      return deepFreeze({ output: content, truncated: false });
    }
  }
  return deepFreeze({ output: "", truncated: false });
}

export type AgentRuntime = Readonly<{
  agentId: string;
  agentName: string;
  messages(): readonly ChatMessage[];
  state(): Readonly<{
    lifecycleState: string;
    turnCount: number;
    totalTokens: number;
  }>;
  run(task: string, signal?: AbortSignal): AsyncGenerator<AgentEvent, AgentRunResult, unknown>;
}>;

const NOOP_HOOKS: AgentLifecycleHooks = deepFreeze({});

/**
 * Default per-agent run timeout when the central config document does not
 * declare `runtime.limits.agentTimeoutMs`. Mirrors the `DEFAULT_TOOL_RESOURCE_BOUNDS`
 * pattern (default in the runtime module, ceiling in `ROOT_POLICY.runtime.limits`).
 */
// DEFAULT_AGENT_TIMEOUT_MS moved to./agents-config.ts (canonical owner).

/**
 * Invoke an optional lifecycle hook, awaiting any returned promise.
 *
 * Hooks are observers: a throwing hook must never crash the agent run, so
 * hook failures are swallowed here (mirroring the "recording failures must
 * not crash the editor/session" pattern used elsewhere). The generic tuple
 * type preserves each hook's argument types without casts.
 */
async function invokeHook<T extends readonly unknown[]>(
  hook: ((...args: T) => void | Promise<void>) | undefined,
  ...args: T
): Promise<void> {
  if (hook === undefined) return;
  await bestEffortAsync(async () => { await hook(...args); });
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  let policyFailure: LLMError | undefined;
  const agentId = generateId("agent");
  const profile = options.profile;
  const hooks = options.hooks ?? NOOP_HOOKS;
  const messages: ChatMessage[] = profile.systemPrompt.length > 0
    ? [deepFreeze({ role: "system" as const, content: profile.systemPrompt })]
    : [];

  const state = options.stateStore.recordAgentStart({
    agentId,
    agentName: profile.name,
    runId: options.runId,
    taskId: options.taskId,
    attemptId: options.attemptId,
  });

  let cancelled = false;

  function getEnabledTools(): readonly ToolDefinition[] {
    const all = options.toolRegistry.definitions();
    if (profile.tools === "all") return all;
    const allowed = new Set(profile.tools);
    return all.filter((t) => allowed.has(t.function.name));
  }
  const dispatch = createGovernedToolDispatch({
    registry: options.toolRegistry, repositoryRoot: options.repositoryRoot, definitions: getEnabledTools,
    ...(options.toolCallGate === undefined ? {} : { gate: options.toolCallGate }),
    ...(options.gateConfig === undefined ? {} : { gateConfig: options.gateConfig }),
    ...(options.governedExecution === undefined ? {} : { governedExecution: options.governedExecution }),
  });

  async function* runTurn(_turnNumber: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, AgentTurnResult, unknown> {
    const tools = getEnabledTools();
    const toolChoice = options.defaultToolChoice ?? "auto";
    const request = turnRequest({
      model: options.modelConfig.modelId,
      messages: [...messages],
      max_tokens: options.modelConfig.maxTokens,
      temperature: options.modelConfig.temperature,
      ...(tools.length > 0 ? { tools } : {}),
      ...(tools.length > 0 ? { tool_choice: toolChoice } : {}),
    }, signal);

    const metrics = options.metricsCollector;
    const metricsKey: MetricScopeKey | undefined = metrics
      ? { module: "agent-runtime", function: "runTurn", scope: profile.name }
      : undefined;
    const metricsCorrelation = metrics
      ? { agentId: profile.name, providerId: options.modelConfig.providerId, modelId: options.modelConfig.modelId, runId: options.runId, taskId: options.taskId }
      : undefined;
    const metricsStartMs = metrics ? performance.now() : 0;

    const turn = new ResponseTurn();
    const toolResults: ToolResult[] = [];
    let assistantIndex: number | undefined;
    let turnSettled = false;
    const remember = (result: import("../runtime/provider-adapter.ts").ChatCompletionResult & Readonly<{ errorCode?: string }>): void => {
      if (!turn.hasEvidence) return;
      const message = responseAssistantMessage(result, turn.hasEvidence);
      if (assistantIndex === undefined) {
        assistantIndex = messages.length;
        messages.push(message);
      } else messages[assistantIndex] = message;
    };
    try {
      for await (const event of turn.stream(options.adapter, request,
        { onResponseReceipt: options.onResponseReceipt, onResponse: options.onResponse, onFailureEvidence: remember }, signal)) {
        if (signal?.aborted) throw new InputError("Agent turn cancelled", "agent_cancelled");
        switch (event.type) {
          case "content": case "response": case "response_event": yield event; break;
          case "refusal": yield { type: "content", text: event.text }; break;
        }
      }
      const result = turn.complete();
      const disposition = inspectResponseDisposition(result.response!, result.status, {
        tools: toolsToResponses(tools), toolChoice, admit: dispatch.admit,
      });
      assertResponseDispositionAvailable(disposition);
      for await (const { call, result: toolResult } of dispatch.execute(disposition.toolCalls, tools, signal)) {
        toolResults.push(toolResult);
        messages.push(deepFreeze({ role: "tool", content: toolResult.content, tool_call_id: toolResult.toolCallId }));
        yield { type: "tool_call", name: call.function.name, arguments: call.function.arguments };
        yield { type: "tool_result", result: toolResult };
      }
      remember(result);
      if (metrics && metricsKey && metricsCorrelation) {
        metrics.recordCall(metricsKey, metricsCorrelation, performance.now() - metricsStartMs,
          result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed", "shared");
      }
      turnSettled = true;
      return deepFreeze({ ...result, toolCalls: disposition.toolCalls, toolResults, disposition, iterations: 0 });
    } catch (error) {
      if (isLLMError(error) && error.code === MISALIGNMENT_POLICY_ERROR_CODE) policyFailure = error;
      if (metrics && metricsKey && metricsCorrelation) {
        metrics.recordCall(metricsKey, metricsCorrelation, performance.now() - metricsStartMs, signal?.aborted ? "cancelled" : "failed", "shared");
      }
      const errorCode = error instanceof HarnessError || isLLMError(error) ? error.code : "agent_provider_error";
      const result = { ...turn.failed(), ...(signal?.aborted ? { finishReason: "cancelled" } : {}), errorCode };
      remember(result);
      turn.retireReceipt();
      turnSettled = true;
      return deepFreeze({ ...result, toolResults, iterations: 0 });
    } finally {
      try { if (!turnSettled && turn.hasEvidence) remember(turn.failed()); }
      finally { turn.retireReceipt(); }
    }
  }

  async function* run(task: string, signal?: AbortSignal): AsyncGenerator<AgentEvent, AgentRunResult, unknown> {
    if (policyFailure) throw policyFailure;
    const hookContext: AgentHookContext = deepFreeze({
      agentId,
      agentName: profile.name,
      runId: options.runId,
      taskId: options.taskId,
      attemptId: options.attemptId,
      profile,
    });
    await invokeHook(hooks.onStart, hookContext);

    messages.push(deepFreeze({ role: "user", content: task }));

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // Per-run AbortController so a timeout actually aborts the in-flight
    // provider call instead of only being checked at the top of the next
    // turn loop. Without this, a hung provider delays the timeout by up
    // to the provider's own timeoutMs (typically 120s). The controller is
    // combined with the external signal so either source aborts the call.
    // Only created when a real timeout is configured so runs without a
    // timeout don't add a synthetic signal to the provider request.
    const timeoutController: AbortController | undefined =
      options.timeoutMs !== undefined && options.timeoutMs > 0 ? new AbortController() : undefined;
    if (timeoutController !== undefined) {
      timeoutHandle = setTimeout(guarded("agents.runtime.timeout", () => {
        timedOut = true;
        timeoutController.abort();
      }), options.timeoutMs!);
    }
    const combinedSignal = combineSignals(signal, timeoutController?.signal);
    let settled = false;

    try {
      const turns: AgentTurnResult[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalTokens = 0;
      let lastFinishReason = "stop";
      let lastError: string | null = null;

      for (let turnNumber = 1; turnNumber <= profile.maxTurns; turnNumber++) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        if (timedOut) {
          break;
        }

        if (options.messageInjector) {
          const injected = options.messageInjector();
          for (const msg of injected) {
            messages.push(deepFreeze({ role: "user" as const, content: msg }));
          }
        }

        yield { type: "turn_start", turnNumber };
        // Cancellation retains the current turn's settled output before the
        // normal terminal recording path marks the run cancelled.
        const result = yield* runTurn(turnNumber, combinedSignal);

        if (result.usage) {
          totalPromptTokens += result.usage.promptTokens;
          totalCompletionTokens += result.usage.completionTokens;
          totalTokens += result.usage.totalTokens;
        }

        options.stateStore.recordAgentTurn({
          agentId,
          runId: options.runId,
          taskId: options.taskId,
          attemptId: options.attemptId,
          turnId: `${agentId}-turn-${turnNumber}`,
          turnNumber,
          content: result.content,
          toolCallCount: result.toolCalls.length,
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          finishReason: result.finishReason,
        });

        yield { type: "turn_end", turnNumber, finishReason: result.finishReason };

        turns.push(result);
        lastFinishReason = result.finishReason;

        await invokeHook(hooks.onTurn, hookContext, result);

        if (combinedSignal?.aborted) {
          cancelled = !timedOut;
          break;
        }
        if (result.finishReason === "error" || result.status !== "completed") {
          lastError = result.errorCode ?? "Provider response did not complete";
          break;
        }
        if (result.disposition?.kind !== "actions" && result.disposition?.kind !== "continue") {
          break;
        }
        if (turnNumber === profile.maxTurns) {
          lastError = "agent_iteration_limit";
          lastFinishReason = "tool_iteration_limit";
          break;
        }

        if (options.turnBoundary) {
          await options.turnBoundary();
          if (signal?.aborted || timedOut) {
            cancelled = signal?.aborted ?? false;
            break;
          }
        }
      }

      let lifecycleState: "succeeded" | "failed" | "cancelled";
      let cancelReason = "Cancelled by signal";
      if (timedOut) {
        lifecycleState = "cancelled";
        cancelReason = options.timeoutMs !== undefined
          ? `Agent timed out after ${options.timeoutMs}ms`
          : "Agent timed out";
        options.stateStore.recordAgentCancellation({
          agentId,
          runId: options.runId,
          taskId: options.taskId,
          attemptId: options.attemptId,
          reason: cancelReason,
        });
      } else if (cancelled) {
        lifecycleState = "cancelled";
        options.stateStore.recordAgentCancellation({
          agentId,
          runId: options.runId,
          taskId: options.taskId,
          attemptId: options.attemptId,
          reason: cancelReason,
        });
      } else if (lastError !== null) {
        lifecycleState = "failed";
        options.stateStore.recordAgentFailure({
          agentId,
          runId: options.runId,
          taskId: options.taskId,
          attemptId: options.attemptId,
          error: lastError,
        });
      } else {
        lifecycleState = "succeeded";
        options.stateStore.recordAgentCompletion({
          agentId,
          runId: options.runId,
          taskId: options.taskId,
          attemptId: options.attemptId,
        });
      }

      settled = true;
      const runResult: AgentRunResult = deepFreeze({
        agentId,
        agentName: profile.name,
        turns: deepFreeze(turns),
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        finishReason: lastFinishReason,
        lifecycleState,
        error: lastError,
      });

      if (timedOut) {
        await invokeHook(hooks.onTimeout, hookContext);
      } else if (cancelled) {
        await invokeHook(hooks.onCancel, hookContext, cancelReason);
      } else if (lifecycleState === "failed") {
        await invokeHook(hooks.onFailure, hookContext, lastError ?? "");
      } else {
        await invokeHook(hooks.onComplete, hookContext, runResult);
      }

      yield { type: "agent_end", result: runResult };
      return runResult;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (!settled) options.stateStore.recordAgentCancellation({ agentId, runId: options.runId,
        taskId: options.taskId, attemptId: options.attemptId, reason: "Agent iterator closed before completion" });
    }
  }

  return deepFreeze({
    agentId,
    agentName: profile.name,
    messages: () => Object.freeze([...messages]),
    state: () => {
      const current = options.stateStore.getAgentState(agentId) ?? state;
      return deepFreeze({ lifecycleState: current.lifecycleState, turnCount: current.turnCount, totalTokens: current.totalTokens });
    },
    run,
  });
}
