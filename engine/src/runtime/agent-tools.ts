import { InputError } from "../kernel/errors.ts";
import { bestEffortAsync } from "../shared/best-effort.ts";
import { deepFreeze, generateId, generateShortId } from "../kernel/integrity.ts";
import type { AgentsConfig, AgentProfile, ProviderModelResolver, RuntimeProviderModel } from "../agents/agent-config.ts";
import { getAgentProfile } from "../agents/agent-config.ts";
import { createAgentRuntime, extractFinalAgentOutput, type AgentRunResult } from "../agents/agent-runtime.ts";
import { createAgentStateStore, type AgentStateStore } from "../agents/agent-state.ts";
import type { MetricsCollector } from "../performance/metrics-collector.ts";
import type { ProviderAdapter } from "./provider-adapter.ts";
import type { RegisteredTool, ToolContext } from "./tool-registry.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import { assertString } from "./tool-args.ts";
import { AGENT_NAME_MAX_LENGTH, AGENT_TASK_MAX_LENGTH } from "./runtime-config.ts";

/**
 * Agent tools for the interactive chat runtime (delivery-map item 4).
 *
 * Exposes multi-agent delegation to the model:
 * - list_agents: list configured agent profiles (read-only, sync)
 * - delegate_to_agent: run a single agent to completion and return its
 * result (async; the agent executes its own bounded turn loop using the
 * session's provider adapter and tool registry)
 * - get_agent_state: return the lifecycle state of agents run in this
 * session (read-only, sync)
 *
 * The tools are registered only when the central configuration document
 * declares an `agents` section. The agent runtime reuses the session's
 * provider adapter and tool registry; it does not perform writes directly —
 * agents must go through the registered editor tools for any file effect.
 */

export type AgentToolsOptions = Readonly<{
  repositoryRoot: string;
  agentsConfig: AgentsConfig;
  adapter: ProviderAdapter;
  toolRegistry: ToolRegistry;
  resolver: ProviderModelResolver;
  timeline: TimelineRecorder;
  runId: string;
  /**
   * Per-agent run timeout in milliseconds. When greater than zero the agent
   * runtime creates an AbortController that aborts the in-flight provider
   * call on expiry. Sourced from `runtime.limits.agentTimeoutMs` (default
   * `DEFAULT_AGENT_TIMEOUT_MS`).
   */
  timeoutMs?: number;
  /**
   * Optional metrics collector so agent provider calls and tool calls are
   * visible to `/metrics` (delivery-map item 13).
   */
  metricsCollector?: MetricsCollector;
  /**
   * Injectable agent-runtime factory for tests. Production leaves this
   * undefined so the real {@link createAgentRuntime} is used.
   */
  runtimeFactory?: typeof createAgentRuntime;
  stateStore?: AgentStateStore;
  defaultToolChoice?: "auto" | "none" | "required";
}>;

export function createAgentTools(options: AgentToolsOptions): readonly RegisteredTool[] {
  const repositoryRoot = options.repositoryRoot;
  const agentsConfig = options.agentsConfig;
  const stateStore = options.stateStore ?? createAgentStateStore(options.timeline);
  const runtimeFactory = options.runtimeFactory ?? createAgentRuntime;

  const listAgents: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "list_agents",
        description: "List the configured agent profiles available for delegation. Returns each profile's name, type, provider, model, capabilities, and write set. Read-only.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({}),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(_args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      return JSON.stringify(deepFreeze({
        maximumConcurrentAgents: agentsConfig.maximumConcurrentAgents,
        profiles: agentsConfig.profiles.map((p: AgentProfile) => deepFreeze({
          name: p.name,
          type: p.type,
          provider: p.provider,
          model: p.model,
          capabilities: p.capabilities,
          writeSet: p.writeSet,
          maxTurns: p.maxTurns,
        })),
      }));
    },
  });

  const delegateToAgent: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "delegate_to_agent",
        description: "Delegate a task to a configured agent. The agent runs its own bounded turn loop using the session's provider and tools, then returns a result. The agent does not write files directly — it uses the registered editor tools. Returns the agent's final lifecycle state, turn count, token usage, and the agent's final answer text (output, bounded to 2000 chars with a truncation marker).",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            agentName: { type: "string", description: "Name of the configured agent profile to delegate to" },
            task: { type: "string", description: "The task description for the agent" },
          }),
          required: ["agentName", "task"],
          additionalProperties: false,
        }),
      }),
    }),
    handler: () => {
      throw new InputError("delegate_to_agent is async-only; use executeAsync", "tool_async_only");
    },
    asyncHandler: async (args: Readonly<Record<string, unknown>>, _context: ToolContext, signal?: AbortSignal): Promise<string> => {
      const agentName = assertString(args, "agentName", { maxLength: AGENT_NAME_MAX_LENGTH });
      const task = assertString(args, "task", { maxLength: AGENT_TASK_MAX_LENGTH });
      const profile = getAgentProfile(agentsConfig, agentName);
      const modelConfig: RuntimeProviderModel = options.resolver.resolve(profile);
      const taskId = generateShortId("agent");
      const runtime = runtimeFactory(deepFreeze({
        adapter: options.adapter,
        toolRegistry: options.toolRegistry,
        modelConfig,
        profile,
        repositoryRoot,
        stateStore,
        runId: options.runId,
        taskId,
        attemptId: generateId("attempt"),
        timeline: options.timeline,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.metricsCollector !== undefined ? { metricsCollector: options.metricsCollector } : {}),
        ...(options.defaultToolChoice !== undefined ? { defaultToolChoice: options.defaultToolChoice } : {}),
      }));
      const generator = runtime.run(task, signal);
      let next = await generator.next();
      let runResult: AgentRunResult | undefined;
      try {
        while (!next.done) {
          next = await generator.next(next.value);
          if (signal?.aborted) break;
        }
        if (next.done) runResult = next.value;
      } finally {
        // MINOR-5: if the consumer broke out before the generator completed
        // (mid-turn abort), finalize it so its finally block (which clears
        // the turn timeout) runs promptly instead of being deferred. The
        // AsyncGenerator.return contract requires a TReturn value, so pass a
        // cancelled result that matches what the runtime would have returned.
        if (!next.done) {
          const cancelledResult: AgentRunResult = deepFreeze({
            agentId: runtime.agentId,
            agentName: runtime.agentName,
            turns: [],
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            finishReason: "cancelled",
            lifecycleState: "cancelled",
            error: null,
          });
          await bestEffortAsync(() => generator.return(cancelledResult));
        }
      }
      if (runResult === undefined) {
        return JSON.stringify(deepFreeze({
          agentName,
          taskId,
          lifecycleState: "cancelled",
          message: "Agent execution was cancelled before completion",
        }));
      }
      // A-1: surface the agent's actual final answer (bounded with a
      // truncation marker) so delegation is useful for
      // information-producing tasks, not just lifecycle bookkeeping.
      const finalOutput = extractFinalAgentOutput(runResult.turns);
      return JSON.stringify(deepFreeze({
        agentName,
        taskId,
        agentId: runResult.agentId,
        lifecycleState: runResult.lifecycleState,
        finishReason: runResult.finishReason,
        turns: runResult.turns.length,
        totalPromptTokens: runResult.totalPromptTokens,
        totalCompletionTokens: runResult.totalCompletionTokens,
        totalTokens: runResult.totalTokens,
        error: runResult.error,
        output: finalOutput.output,
        outputTruncated: finalOutput.truncated,
      }));
    },
  });

  const getAgentState: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "get_agent_state",
        description: "Return the lifecycle state of agents run in this session (name, state, turn count, token usage). Read-only.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            agentName: { type: "string", description: "Optional agent name filter" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const filter = typeof args.agentName === "string" ? args.agentName : null;
      const states = stateStore.allAgentStates()
        .filter((s) => filter === null || s.agentName === filter)
        .map((s) => deepFreeze({
          agentId: s.agentId,
          agentName: s.agentName,
          taskId: s.taskId,
          lifecycleState: s.lifecycleState,
          turnCount: s.turnCount,
          totalTokens: s.totalTokens,
          lastError: s.lastError,
        }));
      return JSON.stringify(deepFreeze({ agents: states, total: states.length }));
    },
  });

  return deepFreeze([listAgents, delegateToAgent, getAgentState]);
}
