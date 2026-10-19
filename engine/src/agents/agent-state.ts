import { InputError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { sha256, deepFreeze, generateId } from "../kernel/integrity.ts";
import { DEFAULT_AGENT_EVENT_QUERY_LIMIT } from "./agents-config.ts";
import type { TimelineEventType } from "../timeline/timeline-types.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";

/**
 * Agent state persistence and reconstruction.
 *
 * Agent state must survive process loss and context compaction. This module
 * persists agent lifecycle events to the timeline store and reconstructs
 * agent state from the timeline on restart.
 *
 * State transitions: pending → running → (succeeded | failed | cancelled)
 *
 * Each state transition is recorded as a timeline event with full
 * correlation context (runId, agentId, taskId, attemptId). On restart,
 * the agent state is reconstructed by querying the timeline for the
 * latest agent events.
 */

export const AGENT_LIFECYCLE_STATES = deepFreeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "suspended",
  "idle",
  "timed-out",
] as const);

export type AgentLifecycleState = typeof AGENT_LIFECYCLE_STATES[number];

export type AgentTurnRecord = Readonly<{
  turnId: string;
  turnNumber: number;
  content: string;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finishReason: string;
  timestamp: string;
}>;

export type AgentState = Readonly<{
  agentId: string;
  agentName: string;
  runId: string;
  taskId: string;
  attemptId: string;
  lifecycleState: AgentLifecycleState;
  turnCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  turns: readonly AgentTurnRecord[];
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  compactionSummary: string | null;
  suspensionReason: string | null;
}>;

export type AgentStateStore = Readonly<{
  recordAgentStart(input: AgentStartInput): AgentState;
  recordAgentTurn(input: AgentTurnInput): AgentState;
  recordAgentCompletion(input: AgentCompletionInput): AgentState;
  recordAgentFailure(input: AgentFailureInput): AgentState;
  recordAgentCancellation(input: AgentCancellationInput): AgentState;
  recordAgentSuspension(input: AgentSuspensionInput): AgentState;
  recordAgentResumption(input: AgentResumptionInput): AgentState;
  recordAgentTimeout(input: AgentTimeoutInput): AgentState;
  recordCompaction(input: AgentCompactionInput): AgentState;
  getAgentState(agentId: string): AgentState | undefined;
  getAgentStatesByRunId(runId: string): readonly AgentState[];
  reconstructAgentState(agentId: string): AgentState | undefined;
  allAgentStates(): readonly AgentState[];
  getActiveAgents(): readonly AgentState[];
}>;

export type AgentStartInput = Readonly<{
  agentId?: string;
  agentName: string;
  runId: string;
  taskId: string;
  attemptId: string;
}>;

export type AgentTurnInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  turnId: string;
  turnNumber: number;
  content: string;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finishReason: string;
}>;

export type AgentCompletionInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
}>;

export type AgentFailureInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  error: string;
}>;

export type AgentCancellationInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  reason: string;
}>;

export type AgentCompactionInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  summary: string;
}>;

export type AgentSuspensionInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  reason: string;
}>;

export type AgentResumptionInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
}>;

export type AgentTimeoutInput = Readonly<{
  agentId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  timeoutMs: number;
}>;

const AGENT_EVENT_TYPE: TimelineEventType = "agent";
const AGENT_TURN_EVENT_TYPE: TimelineEventType = "turn";
const AGENT_TOKEN_EVENT_TYPE: TimelineEventType = "token";
const STATE_TRANSITION_DOC_NAME = "state-transition" as const;
const TOKEN_USAGE_DOC_NAME = "usage" as const;

type StateTransitionPayload = Readonly<{
  to: AgentLifecycleState;
  reason?: string;
}>;

function stateTransitionDoc(payload: StateTransitionPayload): Readonly<{
  name: string;
  contentJson: string;
  contentDigest: string;
}> {
  const data = deepFreeze({
    to: payload.to,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
  });
  const contentJson = JSON.stringify(data);
  return deepFreeze({
    name: STATE_TRANSITION_DOC_NAME,
    contentJson,
    contentDigest: sha256(contentJson),
  });
}

function parseStateTransition(doc: { name: string; contentJson: string | null }): StateTransitionPayload | undefined {
  if (doc.name !== STATE_TRANSITION_DOC_NAME || !doc.contentJson) return undefined;
  try {
    const parsed = JSON.parse(doc.contentJson) as { to?: string; reason?: string };
    if (typeof parsed.to !== "string") return undefined;
    if (!AGENT_LIFECYCLE_STATES.includes(parsed.to as AgentLifecycleState)) return undefined;
    return deepFreeze({
      to: parsed.to as AgentLifecycleState,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    });
  } catch {
    return undefined;
  }
}

export function createAgentStateStore(recorder: TimelineRecorder): AgentStateStore {
  const store = recorder.store;
  const states = new Map<string, AgentState>();

  function timestamp(): string {
    return new Date().toISOString();
  }

  function findState(agentId: string): AgentState {
    const state = states.get(agentId);
    if (state === undefined) {
      throw new InputError(
        `Agent state not found for agentId: ${agentId}`,
        "agent_state_not_found",
      );
    }
    return state;
  }

  function updateState(agentId: string, updater: (state: AgentState) => AgentState): AgentState {
    const current = findState(agentId);
    const updated = deepFreeze({ ...updater(current), updatedAt: timestamp() });
    states.set(agentId, updated);
    return updated;
  }

  function recordEvent(
    agentId: string,
    runId: string,
    taskId: string,
    eventType: TimelineEventType,
    description: string,
    documents?: readonly { name: string; contentJson?: string; contentDigest: string }[],
  ): void {
    recorder.recordEvent({
      eventType,
      description,
      correlation: deepFreeze({ runId, taskId, agentId }),
      ...(documents !== undefined ? { documents } : {}),
    });
  }

  function tokenUsageDoc(
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
  ): Readonly<{ name: string; contentJson: string; contentDigest: string }> {
    const data = deepFreeze({ promptTokens, completionTokens, totalTokens });
    const contentJson = JSON.stringify(data);
    return deepFreeze({
      name: TOKEN_USAGE_DOC_NAME,
      contentJson,
      contentDigest: sha256(contentJson),
    });
  }

  return deepFreeze({
    recordAgentStart(input: AgentStartInput): AgentState {
      const agentId = input.agentId ?? generateId("agent");
      const now = timestamp();
      const state: AgentState = deepFreeze({
        agentId,
        agentName: input.agentName,
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        lifecycleState: "running",
        turnCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        turns: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
        compactionSummary: null,
        suspensionReason: null,
      });
      states.set(agentId, state);
      recordEvent(agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent ${input.agentName} started for task ${input.taskId}`,
        deepFreeze([stateTransitionDoc({ to: "running" })]));
      return state;
    },

    recordAgentTurn(input: AgentTurnInput): AgentState {
      const now = timestamp();
      const turnRecord: AgentTurnRecord = deepFreeze({
        turnId: input.turnId,
        turnNumber: input.turnNumber,
        content: input.content,
        toolCallCount: input.toolCallCount,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        finishReason: input.finishReason,
        timestamp: now,
      });
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        turnCount: state.turnCount + 1,
        totalPromptTokens: state.totalPromptTokens + input.promptTokens,
        totalCompletionTokens: state.totalCompletionTokens + input.completionTokens,
        totalTokens: state.totalTokens + input.totalTokens,
        turns: deepFreeze([...state.turns, turnRecord]),
      }));
      const contentJson = JSON.stringify({
        turnId: input.turnId,
        turnNumber: input.turnNumber,
        toolCallCount: input.toolCallCount,
        finishReason: input.finishReason,
      });
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_TURN_EVENT_TYPE,
        `Agent turn ${input.turnNumber}: ${input.finishReason}`,
        deepFreeze([{
          name: "turn",
          contentJson,
          contentDigest: sha256(contentJson),
        }]));
      if (input.totalTokens > 0) {
        recordEvent(input.agentId, input.runId, input.taskId, AGENT_TOKEN_EVENT_TYPE,
          `Token usage: ${input.totalTokens} total`,
          deepFreeze([tokenUsageDoc(input.promptTokens, input.completionTokens, input.totalTokens)]));
      }
      return updated;
    },

    recordAgentCompletion(input: AgentCompletionInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        lifecycleState: "succeeded" as const,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent completed task ${input.taskId}`,
        deepFreeze([stateTransitionDoc({ to: "succeeded" })]));
      return updated;
    },

    recordAgentFailure(input: AgentFailureInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        lifecycleState: "failed" as const,
        lastError: input.error,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent failed: ${input.error}`,
        deepFreeze([stateTransitionDoc({ to: "failed", reason: input.error })]));
      return updated;
    },

    recordAgentCancellation(input: AgentCancellationInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        lifecycleState: "cancelled" as const,
        lastError: input.reason,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent cancelled: ${input.reason}`,
        deepFreeze([stateTransitionDoc({ to: "cancelled", reason: input.reason })]));
      return updated;
    },

    recordAgentSuspension(input: AgentSuspensionInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        lifecycleState: "suspended" as const,
        suspensionReason: input.reason,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent suspended: ${input.reason}`,
        deepFreeze([stateTransitionDoc({ to: "suspended", reason: input.reason })]));
      return updated;
    },

    recordAgentResumption(input: AgentResumptionInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        lifecycleState: "running" as const,
        suspensionReason: null,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent resumed`,
        deepFreeze([stateTransitionDoc({ to: "running" })]));
      return updated;
    },

    recordAgentTimeout(input: AgentTimeoutInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        lifecycleState: "timed-out" as const,
        lastError: `Agent timed out after ${input.timeoutMs}ms`,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent timed out after ${input.timeoutMs}ms`,
        deepFreeze([stateTransitionDoc({ to: "timed-out", reason: `timeout-${input.timeoutMs}ms` })]));
      return updated;
    },

    recordCompaction(input: AgentCompactionInput): AgentState {
      const updated = updateState(input.agentId, (state) => ({
        ...state,
        compactionSummary: input.summary,
      }));
      recordEvent(input.agentId, input.runId, input.taskId, AGENT_EVENT_TYPE,
        `Agent context compacted: ${input.summary.slice(0, 100)}`);
      return updated;
    },

    getAgentState(agentId: string): AgentState | undefined {
      return states.get(agentId);
    },

    getAgentStatesByRunId(runId: string): readonly AgentState[] {
      return [...states.values()].filter((s) => s.runId === runId);
    },

    reconstructAgentState(agentId: string): AgentState | undefined {
      const events = store.query({
        agentId,
        eventType: AGENT_EVENT_TYPE,
        limit: DEFAULT_AGENT_EVENT_QUERY_LIMIT,
      });
      if (events.length === 0) return undefined;

      const turnEvents = store.query({
        agentId,
        eventType: AGENT_TURN_EVENT_TYPE,
        limit: DEFAULT_AGENT_EVENT_QUERY_LIMIT,
      });

      const tokenEvents = store.query({
        agentId,
        eventType: AGENT_TOKEN_EVENT_TYPE,
        limit: DEFAULT_AGENT_EVENT_QUERY_LIMIT,
      });

      const agentNameMatch = events[0]?.description?.match(/^Agent (\S+) /);
      const agentName = agentNameMatch ? agentNameMatch[1] ?? "unknown" : "unknown";
      const runId = events[0]?.runId ?? "";
      const taskId = events[0]?.taskId ?? "";
      const attemptId = "";

      let lifecycleState: AgentLifecycleState = "pending";
      let lastError: string | null = null;
      let compactionSummary: string | null = null;
      let suspensionReason: string | null = null;

      for (const event of events) {
        const structuredDoc = event.documents.find((d) => d.name === STATE_TRANSITION_DOC_NAME);
        const structured = structuredDoc ? parseStateTransition(structuredDoc) : undefined;
        if (structured) {
          lifecycleState = structured.to;
          if (structured.to === "failed" && structured.reason) {
            lastError = structured.reason;
          } else if (structured.to === "cancelled" && structured.reason) {
            lastError = structured.reason;
          } else if (structured.to === "timed-out" && structured.reason) {
            lastError = `Agent timed out (${structured.reason})`;
          } else if (structured.to === "suspended" && structured.reason) {
            suspensionReason = structured.reason;
          } else if (structured.to === "running") {
            if (suspensionReason !== null && lifecycleState === "suspended") {
              suspensionReason = null;
            }
          }
        } else {
          const desc = event.description ?? "";
          if (desc.includes("completed")) lifecycleState = "succeeded";
          else if (desc.includes("failed")) {
            lifecycleState = "failed";
            lastError = desc.replace(/^Agent failed:\s*/, "");
          } else if (desc.includes("cancelled")) {
            lifecycleState = "cancelled";
            lastError = desc.replace(/^Agent cancelled:\s*/, "");
          } else if (desc.includes("compacted")) {
            compactionSummary = desc.replace(/^Agent context compacted:\s*/, "");
          } else if (desc.includes("started")) {
            lifecycleState = "running";
          }
        }
      }

      const turns: AgentTurnRecord[] = turnEvents.map((event, index) => {
        const doc = event.documents[0];
        let turnData: { turnId?: string; toolCallCount?: number; finishReason?: string } = {};
        if (doc?.contentJson) {
          const json = doc.contentJson;
          const parsed = bestEffort(() => JSON.parse(json) as { turnId?: string; toolCallCount?: number; finishReason?: string });
          if (parsed !== undefined) turnData = parsed;
        }
        return deepFreeze({
          turnId: turnData.turnId ?? `turn-${index}`,
          turnNumber: index + 1,
          content: "",
          toolCallCount: turnData.toolCallCount ?? 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          finishReason: turnData.finishReason ?? "stop",
          timestamp: event.wallTime,
        });
      });

      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalTokens = 0;
      for (const event of tokenEvents) {
        const usageDoc = event.documents.find((d) => d.name === TOKEN_USAGE_DOC_NAME);
        if (usageDoc?.contentJson) {
          const json = usageDoc.contentJson;
          const usage = bestEffort(() => JSON.parse(json) as {
            promptTokens?: number; completionTokens?: number; totalTokens?: number;
          });
          if (usage !== undefined) {
            totalPromptTokens += Number(usage.promptTokens) || 0;
            totalCompletionTokens += Number(usage.completionTokens) || 0;
            totalTokens += Number(usage.totalTokens) || 0;
          }
        }
      }

      return deepFreeze({
        agentId,
        agentName,
        runId,
        taskId,
        attemptId,
        lifecycleState,
        turnCount: turns.length,
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        turns: deepFreeze(turns),
        createdAt: events[0]?.wallTime ?? timestamp(),
        updatedAt: events[events.length - 1]?.wallTime ?? timestamp(),
        lastError,
        compactionSummary,
        suspensionReason,
      });
    },

    allAgentStates(): readonly AgentState[] {
      return [...states.values()];
    },

    getActiveAgents(): readonly AgentState[] {
      return [...states.values()].filter((s) =>
        s.lifecycleState === "running" ||
        s.lifecycleState === "suspended" ||
        s.lifecycleState === "idle"
      );
    },
  });
}

export function compactAgentTurns(
  turns: readonly AgentTurnRecord[],
  maxTurns: number,
): Readonly<{ compactedTurns: readonly AgentTurnRecord[]; summary: string }> {
  if (maxTurns <= 0) {
    return deepFreeze({ compactedTurns: [], summary: turns.length > 0 ? `Compacted all ${turns.length} turn(s).` : "" });
  }
  if (turns.length <= maxTurns) {
    return deepFreeze({ compactedTurns: turns, summary: "" });
  }
  const kept = turns.slice(-maxTurns);
  const dropped = turns.length - maxTurns;
  const summary = `Compacted ${dropped} earlier turn(s). Key facts from dropped turns: ${turns.slice(0, dropped).map((t) => `[Turn ${t.turnNumber}: ${t.finishReason}]`).join(" ")}`;
  return deepFreeze({ compactedTurns: kept, summary });
}
