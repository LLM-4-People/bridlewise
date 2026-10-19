import { guarded } from "../process/fault-policy.ts";
import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze, generateId } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import type { EventLedgerStoragePort } from "../timeline/timeline-types.ts";
import type { ProviderAdapter } from "../runtime/provider-adapter.ts";
import type { ToolRegistry } from "../runtime/tool-registry.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../timeline/timeline-recorder.ts";
import type { ExecutionClosure } from "../kernel/execution-closure.ts";
import type { AgentProfile, AgentsConfig, ProviderModelResolver } from "./agent-config.ts";
import {
  detectWriteSetConflict,
  getAgentProfile,
} from "./agent-config.ts";
import { createAgentStateStore, type AgentStateStore, type AgentState, type AgentLifecycleState } from "./agent-state.ts";
import { type AgentRunResult, type AgentEvent, type AgentRuntime } from "./agent-runtime.ts";
import { createAgentTypeRegistry, type AgentTypeRegistry, type AgentTypeDefinition } from "./agent-type-registry.ts";
import { CALL_RETURN_AGENT_TYPE } from "./agent-type-call-return.ts";
import { BACKGROUND_AGENT_TYPE, type BackgroundAgentRuntime, type BackgroundAgentHandle } from "./agent-type-background.ts";
import type { MetricsCollector } from "../performance/metrics-collector.ts";

/**
 * Orchestrator — manages 0-5 agents in combination.
 *
 * Responsibilities:
 * - Manage agent lifecycle (create, run, complete, cancel)
 * - Handle task dependencies (agent B starts after agent A completes)
 * - Shared live awareness (agents can see each other's outputs)
 * - Background alignment monitoring (periodic check)
 * - Deterministic conflict prevention (two agents can't write the same file)
 * - Dispatch sync (call-and-return) and async (background) agent types
 *
 * The orchestrator is a deterministic coordinator. It does not perform I/O
 * directly — it delegates to the agent runtime, which delegates to the
 * provider adapter and tool registry. Agent type resolution is delegated
 * to the `AgentTypeRegistry` (per DER-027: no orchestration-engine edits
 * to add new agent types).
 */

export type TaskDependency = Readonly<{
  task: string;
  dependsOn: readonly string[];
}>;

export type OrchestrationTask = Readonly<{
  taskId: string;
  task: string;
  agentName: string;
  dependsOn: readonly string[];
}>;

export type OrchestrationPlan = Readonly<{
  runId: string;
  tasks: readonly OrchestrationTask[];
}>;

export type AwarenessEntry = Readonly<{
  agentName: string;
  taskId: string;
  content: string;
  timestamp: string;
  turnNumber: number;
}>;

export type AwarenessStore = Readonly<{
  publish(entry: AwarenessEntry): void;
  getEntries(): readonly AwarenessEntry[];
  getEntriesForAgent(agentName: string): readonly AwarenessEntry[];
  getEntriesForTask(taskId: string): readonly AwarenessEntry[];
  snapshot(): Readonly<{ entries: readonly AwarenessEntry[] }>;
}>;

export type OrchestrationResult = Readonly<{
  runId: string;
  agentResults: readonly AgentRunResult[];
  totalTurns: number;
  totalTokens: number;
  allSucceeded: boolean;
  conflicts: readonly Readonly<{ agentA: string; agentB: string; path: string }>[];
}>;

export type OrchestratorOptions = Readonly<{
  adapter: ProviderAdapter;
  toolRegistry: ToolRegistry;
  resolver: ProviderModelResolver;
  agentsConfig: AgentsConfig;
  repositoryRoot: string;
  store: EventLedgerStoragePort;
  closure?: ExecutionClosure;
  timeline?: TimelineRecorder;
  agentTypeRegistry?: AgentTypeRegistry;
  /**
   * Drift threshold for the alignment monitor: a running agent whose
   * `createdAt` is older than this many milliseconds is considered to have
   * drifted (RES-8). Defaults to {@link DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS}.
   */
  alignmentDriftThresholdMs?: number;
  /**
   * Injectable clock for time-derived behavior (RES-10). Defaults to
   * ` => new Date.toISOString`. Tests pass a deterministic clock.
   */
  clock?: Clock;
  defaultToolChoice?: "auto" | "none" | "required";
  /**
   * Per-agent run timeout in milliseconds, forwarded to every agent the
   * orchestrator creates. Sourced from `runtime.limits.agentTimeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Optional metrics collector so orchestrated agent provider calls and
   * tool calls are visible to `/metrics` (delivery-map item 13).
   */
  metricsCollector?: MetricsCollector;
}>;

type Clock = () => string;

const DEFAULT_CLOCK: Clock = () => new Date().toISOString();

import { DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS, DEFAULT_AWARENESS_PUBLISH_CONTENT_CAP } from "./agents-config.ts";

export type Orchestrator = Readonly<{
  runId: string;
  awareness: AwarenessStore;
  stateStore: AgentStateStore;
  agentTypeRegistry: AgentTypeRegistry;
  backgroundHandles: ReadonlyMap<string, BackgroundAgentHandle>;
  plan(tasks: readonly (Readonly<{ task: string; agentName: string; taskId?: string; dependsOn?: readonly string[] }>)[]): OrchestrationPlan;
  execute(plan: OrchestrationPlan, signal?: AbortSignal): AsyncGenerator<OrchestrationEvent, OrchestrationResult, unknown>;
  detectConflicts(): Readonly<{ conflicts: readonly Readonly<{ agentA: string; agentB: string; path: string }>[] }>;
  getAgentStates(): readonly AgentState[];
}>;

export type OrchestrationEvent =
  | Readonly<{ type: "task_started"; taskId: string; agentName: string }>
  | Readonly<{ type: "task_completed"; taskId: string; agentName: string; result: AgentRunResult }>
  | Readonly<{ type: "task_failed"; taskId: string; agentName: string; error: string }>
  | Readonly<{ type: "task_skipped"; taskId: string; reason: string }>
  | Readonly<{ type: "agent_event"; taskId: string; event: AgentEvent }>
  | Readonly<{ type: "alignment_check"; message: string; driftDetected: boolean }>
  | Readonly<{ type: "orchestration_complete"; result: OrchestrationResult }>;

const MAXIMUM_AGENTS = ROOT_POLICY.runtime.limits.maximumAgents;

const DEFAULT_REGISTRY = createAgentTypeRegistry([
  CALL_RETURN_AGENT_TYPE,
  BACKGROUND_AGENT_TYPE,
]);

function isBackgroundRuntime(runtime: AgentRuntime): runtime is BackgroundAgentRuntime {
  return typeof (runtime as BackgroundAgentRuntime).start === "function";
}

const TERMINAL_LIFECYCLE_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  "succeeded", "failed", "cancelled", "timed-out",
]);

function isTerminalLifecycleState(state: AgentLifecycleState): boolean {
  return TERMINAL_LIFECYCLE_STATES.has(state);
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const runId = generateId("run");
  const awarenessStore = createAwarenessStore();
  const recorder = options.timeline ?? createTimelineRecorder({ store: options.store });
  const stateStore = createAgentStateStore(recorder);
  const registry = options.agentTypeRegistry ?? DEFAULT_REGISTRY;
  const backgroundHandles = new Map<string, BackgroundAgentHandle>();
  const driftThresholdMs = options.alignmentDriftThresholdMs ?? DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS;
  const clock = options.clock ?? DEFAULT_CLOCK;

  function resolveProfile(agentName: string): AgentProfile {
    return getAgentProfile(options.agentsConfig, agentName);
  }

  function resolveType(agentName: string): AgentTypeDefinition {
    const profile = resolveProfile(agentName);
    return registry.resolve(profile);
  }

  function createAgentForTask(task: OrchestrationTask): AgentRuntime {
    const profile = resolveProfile(task.agentName);
    const typeDef = registry.resolve(profile);
    const modelConfig = options.resolver.resolve(profile);
    return typeDef.createRuntime({
      adapter: options.adapter,
      toolRegistry: options.toolRegistry,
      modelConfig,
      profile,
      repositoryRoot: options.repositoryRoot,
      stateStore,
      runId,
      taskId: task.taskId,
      attemptId: generateId("attempt"),
      ...(options.closure !== undefined ? { closure: options.closure } : {}),
      ...(options.timeline !== undefined ? { timeline: options.timeline } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.metricsCollector !== undefined ? { metricsCollector: options.metricsCollector } : {}),
      ...(options.defaultToolChoice !== undefined ? { defaultToolChoice: options.defaultToolChoice } : {}),
    });
  }

  function checkDependencies(task: OrchestrationTask, completed: Set<string>): boolean {
    return task.dependsOn.every((dep) => completed.has(dep));
  }

  async function* runTask(
    task: OrchestrationTask,
    signal?: AbortSignal,
  ): AsyncGenerator<OrchestrationEvent, AgentRunResult, unknown> {
    const agent = createAgentForTask(task);
    yield { type: "task_started", taskId: task.taskId, agentName: task.agentName };

    const generator = agent.run(task.task, signal);
    let result = await generator.next();
    while (!result.done) {
      const event = result.value;
      yield { type: "agent_event", taskId: task.taskId, event };
      if (event.type === "turn_end" && event.turnNumber > 0) {
        const agentState = stateStore.getAgentState(agent.agentId);
        if (agentState && agentState.turns.length > 0) {
          const lastTurn = agentState.turns[agentState.turns.length - 1]!;
          awarenessStore.publish(deepFreeze({
            agentName: task.agentName,
            taskId: task.taskId,
            content: lastTurn.content.slice(0, DEFAULT_AWARENESS_PUBLISH_CONTENT_CAP),
            timestamp: lastTurn.timestamp,
            turnNumber: lastTurn.turnNumber,
          }));
        }
      }
      result = await generator.next(result.value);
    }

    yield { type: "task_completed", taskId: task.taskId, agentName: task.agentName, result: result.value };
    return result.value;
  }

  async function* execute(
    plan: OrchestrationPlan,
    signal?: AbortSignal,
  ): AsyncGenerator<OrchestrationEvent, OrchestrationResult, unknown> {
    if (plan.tasks.length > MAXIMUM_AGENTS) {
      throw new InputError(
        `Orchestration plan exceeds maximum ${MAXIMUM_AGENTS} agents`,
        "orchestration_too_many_agents",
      );
    }

    const conflictResult = detectConflicts();
    if (conflictResult.conflicts.length > 0 && options.agentsConfig.orchestration.conflictDetectionEnabled) {
      throw new SecurityError(
        `Write-set conflicts detected: ${conflictResult.conflicts.map((c) => `${c.agentA}/${c.agentB}/${c.path}`).join(", ")}`,
        "orchestration_write_set_conflict",
      );
    }

    const completed = new Set<string>();
    const failed = new Set<string>();
    const results: AgentRunResult[] = [];
    const running = new Map<string, { handle: BackgroundAgentHandle; task: OrchestrationTask }>();
    let totalTurns = 0;
    let totalTokens = 0;
    let alignmentTimer: ReturnType<typeof setInterval> | undefined;
    // Queue for alignment_check events emitted by the background monitor
    // interval. The execute loop drains this at the top of each iteration so
    // drift detected during an `await` is surfaced to the consumer as soon
    // as the generator regains control (RES-8).
    const alignmentQueue: OrchestrationEvent[] = [];

    if (options.agentsConfig.orchestration.alignmentMonitorIntervalMs > 0) {
      alignmentTimer = setInterval(guarded("agents.orchestrator.alignment-monitor", () => {
        const activeAgents = stateStore.allAgentStates().filter((s) => s.lifecycleState === "running");
        if (activeAgents.length === 0) {
          // Nothing to monitor: stop the interval so it does not run forever
          // after all agents have terminated.
          if (alignmentTimer !== undefined) {
            clearInterval(alignmentTimer);
            alignmentTimer = undefined;
          }
          return;
        }
        const nowMs = Date.parse(clock());
        const drifted = activeAgents.filter((s) => (nowMs - Date.parse(s.createdAt)) > driftThresholdMs);
        if (drifted.length > 0) {
          alignmentQueue.push({
            type: "alignment_check",
            message: `Alignment drift detected: ${drifted.length} agent(s) running longer than ${driftThresholdMs}ms`,
            driftDetected: true,
          });
        } else {
          alignmentQueue.push({
            type: "alignment_check",
            message: `Alignment check: ${activeAgents.length} agent(s) running, no drift`,
            driftDetected: false,
          });
        }
      }), options.agentsConfig.orchestration.alignmentMonitorIntervalMs);
    }

    try {
      const remaining = new Set(plan.tasks.map((t) => t.taskId));
      const taskMap = new Map(plan.tasks.map((t) => [t.taskId, t]));

      while (remaining.size > 0 || running.size > 0) {
        // Drain alignment checks emitted by the background monitor before
        // processing the next task batch so drift is surfaced promptly.
        while (alignmentQueue.length > 0) {
          yield alignmentQueue.shift() as OrchestrationEvent;
        }
        if (signal?.aborted) break;

        const ready = [...remaining]
          .map((id) => taskMap.get(id)!)
          .filter((t) => checkDependencies(t, completed));

        if (ready.length === 0 && running.size === 0 && remaining.size > 0) {
          const stuck = [...remaining].map((id) => taskMap.get(id)!);
          const allDepsFailed = stuck.every((t) =>
            t.dependsOn.every((d) => failed.has(d)),
          );
          if (allDepsFailed) {
            for (const task of stuck) {
              yield { type: "task_skipped", taskId: task.taskId, reason: "Dependency failed" };
              remaining.delete(task.taskId);
            }
          } else {
            for (const task of stuck) {
              yield { type: "task_skipped", taskId: task.taskId, reason: "Dependency cycle or unresolvable" };
              remaining.delete(task.taskId);
            }
          }
          continue;
        }

        for (const task of ready) {
          if (signal?.aborted) break;
          remaining.delete(task.taskId);
          const typeDef = resolveType(task.agentName);

          if (typeDef.executionMode === "sync") {
            try {
              const generator = runTask(task, signal);
              let result = await generator.next();
              while (!result.done) {
                yield result.value;
                result = await generator.next(result.value);
              }
              const agentResult = result.value;
              results.push(agentResult);
              totalTurns += agentResult.turns.length;
              totalTokens += agentResult.totalTokens;
              if (agentResult.lifecycleState === "failed") {
                failed.add(task.taskId);
                yield { type: "task_failed", taskId: task.taskId, agentName: task.agentName, error: agentResult.error ?? "Agent failed" };
              } else {
                completed.add(task.taskId);
              }
              yield {
                type: "alignment_check",
                message: `Task ${task.taskId} completed. ${results.length}/${plan.tasks.length} done.`,
                driftDetected: false,
              };
            } catch (error) {
              const errorMsg = extractErrorMessage(error);
              yield { type: "task_failed", taskId: task.taskId, agentName: task.agentName, error: errorMsg };
              failed.add(task.taskId);
            }
          } else {
            const runtime = createAgentForTask(task);
            if (!isBackgroundRuntime(runtime)) {
              yield { type: "task_failed", taskId: task.taskId, agentName: task.agentName, error: "Agent type declared async but runtime does not support background execution" };
              failed.add(task.taskId);
              continue;
            }
            const handle = runtime.start(task.task, signal);
            backgroundHandles.set(task.taskId, handle);
            running.set(task.taskId, { handle, task });
            yield { type: "task_started", taskId: task.taskId, agentName: task.agentName };
          }
        }

        for (const [taskId, entry] of running) {
          if (isTerminalLifecycleState(entry.handle.status())) {
            const result = entry.handle.result();
            running.delete(taskId);
            backgroundHandles.delete(taskId);
            if (result) {
              results.push(result);
              totalTurns += result.turns.length;
              totalTokens += result.totalTokens;
              if (result.lifecycleState === "failed" || entry.handle.status() === "timed-out") {
                failed.add(taskId);
                yield { type: "task_failed", taskId, agentName: entry.task.agentName, error: result.error ?? "Agent failed" };
              } else {
                completed.add(taskId);
                yield { type: "task_completed", taskId, agentName: entry.task.agentName, result };
              }
              yield {
                type: "alignment_check",
                message: `Task ${taskId} completed. ${results.length}/${plan.tasks.length} done.`,
                driftDetected: false,
              };
            }
          }
        }

        if (ready.length === 0 && running.size > 0) {
          await Promise.race(
            [...running.values()].map((e) => e.handle.completion()),
          );
        }
      }
    } finally {
      if (alignmentTimer !== undefined) clearInterval(alignmentTimer);
    }

    const allSucceeded = failed.size === 0 && completed.size === plan.tasks.length;
    const orchestrationResult: OrchestrationResult = deepFreeze({
      runId,
      agentResults: deepFreeze(results),
      totalTurns,
      totalTokens,
      allSucceeded,
      conflicts: conflictResult.conflicts,
    });

    yield { type: "orchestration_complete", result: orchestrationResult };
    return orchestrationResult;
  }

  function detectConflicts(): Readonly<{ conflicts: readonly Readonly<{ agentA: string; agentB: string; path: string }>[] }> {
    const profiles = options.agentsConfig.profiles;
    if (!options.agentsConfig.orchestration.conflictDetectionEnabled) {
      return deepFreeze({ conflicts: [] });
    }
    return detectWriteSetConflict(profiles);
  }

  function plan(
    tasks: readonly (Readonly<{ task: string; agentName: string; taskId?: string; dependsOn?: readonly string[] }>)[],
  ): OrchestrationPlan {
    if (tasks.length > MAXIMUM_AGENTS) {
      throw new InputError(
        `Orchestration plan exceeds maximum ${MAXIMUM_AGENTS} agents`,
        "orchestration_too_many_agents",
      );
    }
    const taskIds = new Set<string>();
    const orchestrationTasks: OrchestrationTask[] = tasks.map((t) => {
      const taskId = t.taskId ?? generateId("task");
      if (taskIds.has(taskId)) {
        throw new InputError(
          `Duplicate task ID: ${taskId}`,
          "orchestration_duplicate_task_id",
        );
      }
      taskIds.add(taskId);
      return deepFreeze({
        taskId,
        task: t.task,
        agentName: t.agentName,
        dependsOn: deepFreeze([...(t.dependsOn ?? [])]),
      });
    });

    for (const task of orchestrationTasks) {
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep)) {
          throw new InputError(
            `Task '${task.taskId}' depends on unknown task '${dep}'`,
            "orchestration_unknown_dependency",
          );
        }
      }
    }

    return deepFreeze({
      runId,
      tasks: deepFreeze(orchestrationTasks),
    });
  }

  return deepFreeze({
    runId,
    awareness: awarenessStore,
    stateStore,
    agentTypeRegistry: registry,
    backgroundHandles,
    plan,
    execute,
    detectConflicts,
    getAgentStates: () => stateStore.allAgentStates(),
  });
}

function createAwarenessStore(): AwarenessStore {
  const entries: AwarenessEntry[] = [];
  return deepFreeze({
    publish(entry: AwarenessEntry): void {
      entries.push(deepFreeze(entry));
    },
    getEntries(): readonly AwarenessEntry[] {
      return [...entries];
    },
    getEntriesForAgent(agentName: string): readonly AwarenessEntry[] {
      return entries.filter((e) => e.agentName === agentName);
    },
    getEntriesForTask(taskId: string): readonly AwarenessEntry[] {
      return entries.filter((e) => e.taskId === taskId);
    },
    snapshot(): Readonly<{ entries: readonly AwarenessEntry[] }> {
      return deepFreeze({ entries: deepFreeze([...entries]) });
    },
  });
}

export function validateOrchestrationPlan(
  config: AgentsConfig,
  tasks: readonly { agentName: string }[],
): Readonly<{ valid: true }> | Readonly<{ valid: false; errors: readonly string[] }> {
  const errors: string[] = [];
  const profileNames = new Set(config.profiles.map((p) => p.name));
  for (const task of tasks) {
    if (!profileNames.has(task.agentName)) {
      errors.push(`Unknown agent profile: ${task.agentName}`);
    }
  }
  if (config.maximumConcurrentAgents > 0 && tasks.length > config.maximumConcurrentAgents) {
    errors.push(`Plan has ${tasks.length} tasks but maximumConcurrentAgents is ${config.maximumConcurrentAgents}`);
  }
  if (errors.length > 0) {
    return deepFreeze({ valid: false, errors: deepFreeze(errors) });
  }
  return deepFreeze({ valid: true });
}
