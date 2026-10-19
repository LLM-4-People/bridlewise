import { InputError } from "../kernel/errors.ts";
import { bestEffortAsync } from "../shared/best-effort.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type { AgentsConfig, ProviderModelResolver } from "../agents/agent-config.ts";
import { createOrchestrator, type Orchestrator, type OrchestrationPlan, type OrchestrationResult } from "../agents/orchestrator.ts";
import { extractFinalAgentOutput } from "../agents/agent-runtime.ts";
import type { EventLedgerStoragePort } from "../timeline/timeline-types.ts";
import type { MetricsCollector } from "../performance/metrics-collector.ts";
import type { ProviderAdapter } from "./provider-adapter.ts";
import type { RegisteredTool, ToolContext } from "./tool-registry.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import { resolvePositiveInt } from "./tool-args.ts";
import { ORCHESTRATOR_MAX_TURNS } from "./runtime-config.ts";

/**
 * Orchestrator tools for the interactive chat runtime (delivery-map item 4).
 *
 * Exposes multi-agent orchestration to the model via a single tool:
 * - delegate_to_orchestrator: coordinate 0-5 agents in combination. The
 * orchestrator builds an OrchestrationPlan from the requested tasks,
 * resolves agent profiles and write-set conflicts, executes the plan
 * (sync call-and-return and async background agents), and returns a
 * summary of results, turns, tokens, and conflicts.
 *
 * The tool follows the agent-tools.ts pattern: it is registered only when
 * the central config document declares an `agents` section, reuses the
 * session's provider adapter and tool registry, and records to the durable
 * timeline. The orchestrator factory is injectable for tests.
 */

export type OrchestratorToolsOptions = Readonly<{
  repositoryRoot: string;
  agentsConfig: AgentsConfig;
  adapter: ProviderAdapter;
  toolRegistry: ToolRegistry;
  resolver: ProviderModelResolver;
  store: EventLedgerStoragePort;
  timeline: TimelineRecorder;
  /**
   * Per-agent run timeout in milliseconds, forwarded to every orchestrated
   * agent. Sourced from `runtime.limits.agentTimeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Optional metrics collector so orchestrated agent calls are visible to
   * `/metrics` (delivery-map item 13).
   */
  metricsCollector?: MetricsCollector;
  /**
   * Injectable orchestrator factory for tests. Production leaves this
   * undefined so the real {@link createOrchestrator} is used.
   */
  orchestratorFactory?: typeof createOrchestrator;
  defaultToolChoice?: "auto" | "none" | "required";
}>;

type TaskInput = Readonly<{
  agentName: string;
  task: string;
  taskId?: string;
  dependsOn?: readonly string[];
}>;

function parseTasks(raw: unknown): readonly TaskInput[] {
  if (!Array.isArray(raw)) {
    throw new InputError("tasks must be an array", "orchestrator_tasks_not_array");
  }
  const tasks: TaskInput[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new InputError("each task must be an object", "orchestrator_task_not_object");
    }
    const obj = item as Record<string, unknown>;
    const agentName = obj["agentName"];
    const task = obj["task"];
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new InputError("each task must have a non-empty agentName string", "orchestrator_task_missing_agent_name");
    }
    if (typeof task !== "string" || task.length === 0) {
      throw new InputError("each task must have a non-empty task string", "orchestrator_task_missing_task");
    }
    const taskId = typeof obj["taskId"] === "string" ? obj["taskId"] : undefined;
    const dependsOn = Array.isArray(obj["dependsOn"])
      ? (obj["dependsOn"] as unknown[]).filter((d): d is string => typeof d === "string")
      : undefined;
    tasks.push(deepFreeze({
      agentName,
      task,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(dependsOn !== undefined ? { dependsOn: deepFreeze(dependsOn) } : {}),
    }));
  }
  return deepFreeze(tasks);
}

export function createOrchestratorTools(options: OrchestratorToolsOptions): readonly RegisteredTool[] {
  const factory = options.orchestratorFactory ?? createOrchestrator;

  const delegateToOrchestrator: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "delegate_to_orchestrator",
        description: "Coordinate 0-5 agents in combination. Build an orchestration plan from the requested tasks (each with an agent name, task description, optional task ID, and optional dependencies on other tasks), resolve write-set conflicts, execute the plan, and return a summary of results, turns, tokens, conflicts, and each agent's final answer text (output, bounded to 2000 chars with a truncation marker).",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            tasks: {
              type: "array",
              description: "Tasks to execute. Each task has an agentName, a task description, an optional taskId, and optional dependsOn (taskIds this task waits for).",
              items: deepFreeze({
                type: "object",
                properties: deepFreeze({
                  agentName: { type: "string", description: "Name of the configured agent profile" },
                  task: { type: "string", description: "The task description" },
                  taskId: { type: "string", description: "Optional task ID (used by other tasks' dependsOn)" },
                  dependsOn: { type: "array", items: { type: "string" }, description: "Optional task IDs this task depends on" },
                }),
                required: ["agentName", "task"],
              }),
            },
            maximumTurns: {
              type: "integer",
              description: "Optional limit on the total number of turns across all agents (default: no limit)",
              minimum: 1,
            },
          }),
          required: ["tasks"],
          additionalProperties: false,
        }),
      }),
    }),
    handler: (): string => {
      throw new InputError("delegate_to_orchestrator is async-only; use executeAsync", "tool_async_only");
    },
    asyncHandler: async (args: Readonly<Record<string, unknown>>, _context: ToolContext, signal?: AbortSignal): Promise<string> => {
      const tasks = parseTasks(args["tasks"]);
      if (tasks.length === 0) {
        return JSON.stringify(deepFreeze({
          orchestrationId: null,
          lifecycleState: "cancelled",
          message: "No tasks provided",
        }));
      }
      // maximumTurns is optional; 0 means no limit. resolvePositiveInt
      // throws on missing without a defaultValue, so handle absence here.
      const maximumTurnsArg = args["maximumTurns"];
      const maximumTurns = maximumTurnsArg === undefined || maximumTurnsArg === null
        ? 0
        : resolvePositiveInt(args, "maximumTurns", { max: ORCHESTRATOR_MAX_TURNS });
      const orchestrator: Orchestrator = factory(deepFreeze({
        adapter: options.adapter,
        toolRegistry: options.toolRegistry,
        resolver: options.resolver,
        agentsConfig: options.agentsConfig,
        repositoryRoot: options.repositoryRoot,
        store: options.store,
        timeline: options.timeline,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.metricsCollector !== undefined ? { metricsCollector: options.metricsCollector } : {}),
        ...(options.defaultToolChoice !== undefined ? { defaultToolChoice: options.defaultToolChoice } : {}),
        ...(options.agentsConfig.orchestration.alignmentDriftThresholdMs !== undefined
          ? { alignmentDriftThresholdMs: options.agentsConfig.orchestration.alignmentDriftThresholdMs }
          : {}),
      }));
      let plan: OrchestrationPlan;
      try {
        plan = orchestrator.plan(tasks);
      } catch (error) {
        return JSON.stringify(deepFreeze({
          orchestrationId: orchestrator.runId,
          lifecycleState: "failed",
          message: error instanceof Error ? error.message : "plan failed",
        }));
      }
      const generator = orchestrator.execute(plan, signal);
      let next = await generator.next();
      let result: OrchestrationResult | undefined;
      try {
        while (!next.done) {
          next = await generator.next(next.value);
          if (signal?.aborted) break;
        }
        if (next.done) result = next.value;
      } finally {
        if (!next.done) {
          await bestEffortAsync(() => generator.return(undefined as never));
        }
      }
      if (result === undefined) {
        return JSON.stringify(deepFreeze({
          orchestrationId: orchestrator.runId,
          lifecycleState: "cancelled",
          message: "Orchestration was cancelled before completion",
        }));
      }
      const totalTurns = maximumTurns > 0 ? Math.min(result.totalTurns, maximumTurns) : result.totalTurns;
      return JSON.stringify(deepFreeze({
        orchestrationId: orchestrator.runId,
        allSucceeded: result.allSucceeded,
        agentCount: result.agentResults.length,
        totalTurns,
        totalTokens: result.totalTokens,
        conflicts: result.conflicts,
        agentResults: result.agentResults.map((r) => {
          // A-1: include each agent's actual final answer (bounded with a
          // truncation marker) so orchestration results are useful for
          // information-producing tasks, not just lifecycle bookkeeping.
          const finalOutput = extractFinalAgentOutput(r.turns);
          return deepFreeze({
            agentName: r.agentName,
            lifecycleState: r.lifecycleState,
            turns: r.turns.length,
            totalTokens: r.totalTokens,
            error: r.error,
            output: finalOutput.output,
            outputTruncated: finalOutput.truncated,
          });
        }),
      }));
    },
  });

  return deepFreeze([delegateToOrchestrator]);
}
