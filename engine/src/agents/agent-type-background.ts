import { guarded } from "../process/fault-policy.ts";
import { extractErrorMessage } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type { AgentProfile } from "./agent-config.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./agents-config.ts";
import { createAgentRuntime, type AgentEvent, type AgentRunResult, type AgentRuntime, type AgentRuntimeOptions } from "./agent-runtime.ts";
import type { AgentTypeDefinition } from "./agent-type-registry.ts";
import type { AgentLifecycleState } from "./agent-state.ts";

/**
 * Background agent type — asynchronous execution model.
 *
 * The caller invokes the agent via `start(task)`, receives a
 * `BackgroundAgentHandle`, and can check status, retrieve results, or cancel
 * later. The agent runs in the background without blocking the conversation
 * loop (per USR-054 / DER-040).
 *
 * Lifecycle: pending → running → (suspended → running)* →
 * succeeded | failed | cancelled | timed-out
 * Execution mode: async
 *
 * The background runtime wraps the existing `createAgentRuntime` and runs
 * its `run` generator in a detached async context. Steering messages can
 * be injected between turns via the `steer` method — these are processed
 * in the agent's next turn through the existing message/turn mechanism (no
 * parallel control path).
 */

export type BackgroundAgentHandle = Readonly<{
  agentId: string;
  agentName: string;
  status(): AgentLifecycleState;
  result(): AgentRunResult | undefined;
  events(): AsyncGenerator<AgentEvent, void, unknown>;
  cancel(reason?: string): Promise<void>;
  suspend(reason?: string): Promise<void>;
  resume(): Promise<void>;
  steer(message: string): void;
  pendingSteeringMessages(): readonly string[];
  completion(): Promise<AgentRunResult>;
}>;

export type BackgroundAgentRuntime = AgentRuntime & Readonly<{
  start(task: string, signal?: AbortSignal): BackgroundAgentHandle;
}>;

const TERMINAL_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  "succeeded", "failed", "cancelled", "timed-out",
]);

function isTerminal(state: AgentLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function createBackgroundAgentRuntime(
  options: AgentRuntimeOptions,
  timeoutMs?: number,
): BackgroundAgentRuntime {
  const steeringQueue: string[] = [];
  let suspended = false;
  let suspendResolve: (() => void) | undefined;

  const messageInjector = (): readonly string[] => {
    if (steeringQueue.length === 0) return [];
    const drained = [...steeringQueue];
    steeringQueue.length = 0;
    return drained;
  };

  const turnBoundary = (): Promise<void> => {
    if (!suspended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      suspendResolve = resolve;
    });
  };

  const enhancedOptions: AgentRuntimeOptions = deepFreeze({
    ...options,
    messageInjector,
    turnBoundary,
  });

  const underlying = createAgentRuntime(enhancedOptions);

  function start(task: string, signal?: AbortSignal): BackgroundAgentHandle {
    const controller = new AbortController();
    if (signal) {
      signal.addEventListener("abort", guarded("agents.background.abort", () => controller.abort()), { once: true });
    }

    let status: AgentLifecycleState = "pending";
    let runResult: AgentRunResult | undefined;
    const eventBuffer: AgentEvent[] = [];
    let eventResolve: (() => void) | undefined;
    let done = false;

    let completionResolve: ((result: AgentRunResult) => void) | undefined;
    const completionPromise = new Promise<AgentRunResult>((resolve) => {
      completionResolve = resolve;
    });

    function notifyEventListeners(): void {
      if (eventResolve) {
        const resolve = eventResolve;
        eventResolve = undefined;
        resolve();
      }
    }

    const effectiveTimeout = timeoutMs ?? options.profile.backgroundTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    function clearTimer(): void {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    }

    timeoutHandle = setTimeout(guarded("agents.background.timeout", () => {
      if (!done && !isTerminal(status)) {
        clearTimer();
        options.stateStore.recordAgentTimeout({
          agentId: underlying.agentId,
          runId: options.runId,
          taskId: options.taskId,
          attemptId: options.attemptId,
          timeoutMs: effectiveTimeout,
        });
        status = "timed-out";
        controller.abort();
        runResult = deepFreeze({
          agentId: underlying.agentId,
          agentName: options.profile.name,
          turns: [],
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          finishReason: "timeout",
          lifecycleState: "cancelled",
          error: `Agent timed out after ${effectiveTimeout}ms`,
        });
        done = true;
        notifyEventListeners();
        if (completionResolve) completionResolve(runResult);
      }
    }), effectiveTimeout);

    (async () => {
      status = "running";
      const generator = underlying.run(task, controller.signal);
      try {
        let genResult = await generator.next();
        while (!genResult.done) {
          eventBuffer.push(genResult.value);
          notifyEventListeners();

          if (controller.signal.aborted) break;

          if (genResult.value.type === "turn_end" && suspended) {
            status = "suspended";
            options.stateStore.recordAgentSuspension({
              agentId: underlying.agentId,
              runId: options.runId,
              taskId: options.taskId,
              attemptId: options.attemptId,
              reason: "Suspended by caller",
            });
            await new Promise<void>((resolve) => {
              suspendResolve = resolve;
            });
            status = "running";
            options.stateStore.recordAgentResumption({
              agentId: underlying.agentId,
              runId: options.runId,
              taskId: options.taskId,
              attemptId: options.attemptId,
            });
          }

          if (controller.signal.aborted) break;

          genResult = await generator.next(genResult.value);
        }
        if (!controller.signal.aborted && genResult.done) {
          runResult = genResult.value;
          status = runResult.lifecycleState as AgentLifecycleState;
        } else if (controller.signal.aborted && (status as AgentLifecycleState) !== "timed-out") {
          status = "cancelled";
          if (!runResult) {
            runResult = deepFreeze({
              agentId: underlying.agentId,
              agentName: options.profile.name,
              turns: [],
              totalPromptTokens: 0,
              totalCompletionTokens: 0,
              totalTokens: 0,
              finishReason: "cancelled",
              lifecycleState: "cancelled",
              error: "Cancelled by signal",
            });
          }
        }
      } catch (error) {
        if (status !== "timed-out" as AgentLifecycleState) {
          status = "failed";
          runResult = deepFreeze({
            agentId: underlying.agentId,
            agentName: options.profile.name,
            turns: [],
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            finishReason: "error",
            lifecycleState: "failed",
            error: `Background agent error: ${extractErrorMessage(error)}`,
          });
        }
      } finally {
        clearTimer();
        done = true;
        notifyEventListeners();
        if (runResult) {
          if (completionResolve) completionResolve(runResult);
        }
      }
    })();

    return deepFreeze({
      agentId: underlying.agentId,
      agentName: options.profile.name,

      status: () => status,

      result: () => runResult,

      async *events(): AsyncGenerator<AgentEvent, void, unknown> {
        let index = 0;
        while (index < eventBuffer.length || !done) {
          while (index < eventBuffer.length) {
            yield eventBuffer[index]!;
            index++;
          }
          if (!done) {
            await new Promise<void>((resolve) => {
              eventResolve = resolve;
              if (done && index >= eventBuffer.length) {
                eventResolve = undefined;
                resolve();
              }
            });
          }
        }
      },

      async cancel(reason?: string): Promise<void> {
        clearTimer();
        const cancelReason = reason ?? "Cancelled by caller";
        if (!isTerminal(status) && !done) {
          options.stateStore.recordAgentCancellation({
            agentId: underlying.agentId,
            runId: options.runId,
            taskId: options.taskId,
            attemptId: options.attemptId,
            reason: cancelReason,
          });
          status = "cancelled";
          controller.abort();
          if (!runResult) {
            runResult = deepFreeze({
              agentId: underlying.agentId,
              agentName: options.profile.name,
              turns: [],
              totalPromptTokens: 0,
              totalCompletionTokens: 0,
              totalTokens: 0,
              finishReason: "cancelled",
              lifecycleState: "cancelled",
              error: cancelReason,
            });
          }
          done = true;
          notifyEventListeners();
          if (completionResolve) completionResolve(runResult!);
        }
      },

      async suspend(_reason?: string): Promise<void> {
        if (status === "running") {
          suspended = true;
        }
      },

      async resume(): Promise<void> {
        if (suspended) {
          suspended = false;
          if (suspendResolve) {
            const resolve = suspendResolve;
            suspendResolve = undefined;
            resolve();
          }
        }
      },

      steer(message: string): void {
        if (typeof message !== "string" || message.length === 0) return;
        steeringQueue.push(message);
      },

      pendingSteeringMessages: (): readonly string[] => {
        return [...steeringQueue];
      },

      completion: (): Promise<AgentRunResult> => completionPromise,
    });
  }

  return deepFreeze({
    ...underlying,
    start,
  });
}

export const BACKGROUND_AGENT_TYPE: AgentTypeDefinition = {
  typeId: "background",
  description: "Asynchronous agent: runs in background, caller checks status or retrieves results later.",
  executionMode: "async",
  lifecycleStates: ["pending", "running", "succeeded", "failed", "cancelled", "suspended", "idle", "timed-out"],
  terminalStates: ["succeeded", "failed", "cancelled", "timed-out"],
  hooks: {},
  createRuntime: (options) => createBackgroundAgentRuntime(options),
  validateProfile: (profile: AgentProfile): readonly string[] => {
    const errors: string[] = [];
    if (profile.maxTurns < 1) {
      errors.push("background agent requires maxTurns >= 1");
    }
    if (profile.name.length === 0) {
      errors.push("background agent requires a non-empty name");
    }
    return errors;
  },
};
