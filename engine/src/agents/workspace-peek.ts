import { deepFreeze } from "../kernel/integrity.ts";
import type { EventLedgerStoragePort, TimelineEventRecord } from "../timeline/timeline-types.ts";
import type { AgentStateStore, AgentTurnRecord } from "./agent-state.ts";
import type { BackgroundAgentHandle } from "./agent-type-background.ts";
import type { AgentLifecycleState } from "./agent-state.ts";

/**
 * Workspace peek (D22) — read-only inspection of an agent's current state.
 *
 * The orchestrator can peek into an agent's workspace for steering, monitoring,
 * and debugging. The peek is strictly read-only:
 *
 * - **No shared mutable state**: the peek returns a frozen snapshot, not a
 * live reference. Changes to the agent's state after the peek are not
 * reflected in the snapshot.
 * - **No parallel control path**: peeking is observation; steering is via
 * the existing message/turn mechanism (the orchestrator sends a message
 * to the agent's next turn via `handle.steer`).
 * - **No breakage**: the peek does not modify the agent's timeline, context,
 * or memory. It only reads from the state store and timeline store.
 *
 * Per D22: "The orchestrator must be able to inspect an agent's current
 * state, workspace, and recent outputs — for steering, monitoring, and
 * debugging."
 */

export type AgentWorkspaceSnapshot = Readonly<{
  agentId: string;
  agentName: string;
  status: AgentLifecycleState;
  currentTurn: number;
  recentTurns: readonly AgentTurnRecord[];
  recentToolCalls: ReadonlyArray<Readonly<{
    name: string;
    turnNumber: number;
    arguments: string;
  }>>;
  timelineEvents: readonly TimelineEventRecord[];
  contextSize: number;
  tokenUsage: Readonly<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
  suspensionReason: string | null;
  lastError: string | null;
  pendingSteeringMessages: readonly string[];
  timestamp: string;
}>;

export type PeekOptions = Readonly<{
  maxRecentTurns?: number;
  maxTimelineEvents?: number;
}>;

import { DEFAULT_MAX_RECENT_TURNS } from "./agents-config.ts";
import { DEFAULT_MAX_TIMELINE_EVENTS } from "./agents-config.ts";

export function peekAgentWorkspace(
  handle: BackgroundAgentHandle,
  stateStore: AgentStateStore,
  store: EventLedgerStoragePort,
  options?: PeekOptions,
): AgentWorkspaceSnapshot {
  const maxRecentTurns = options?.maxRecentTurns ?? DEFAULT_MAX_RECENT_TURNS;
  const maxTimelineEvents = options?.maxTimelineEvents ?? DEFAULT_MAX_TIMELINE_EVENTS;

  const status = handle.status();
  const agentState = stateStore.getAgentState(handle.agentId);

  const recentTurns: AgentTurnRecord[] = agentState
    ? agentState.turns.slice(-maxRecentTurns)
    : [];

  const recentToolCalls = recentTurns.flatMap((_turn) => {
    const tools: Array<Readonly<{ name: string; turnNumber: number; arguments: string }>> = [];
    return tools;
  });

  const timelineEvents = store.query({
    agentId: handle.agentId,
    limit: maxTimelineEvents,
    ascending: false,
  });

  const contextSize = agentState?.turns.length ?? 0;

  const tokenUsage = agentState
    ? deepFreeze({
        promptTokens: agentState.totalPromptTokens,
        completionTokens: agentState.totalCompletionTokens,
        totalTokens: agentState.totalTokens,
      })
    : deepFreeze({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  return deepFreeze({
    agentId: handle.agentId,
    agentName: handle.agentName,
    status,
    currentTurn: agentState?.turnCount ?? 0,
    recentTurns: deepFreeze(recentTurns),
    recentToolCalls: deepFreeze(recentToolCalls),
    timelineEvents: deepFreeze(timelineEvents),
    contextSize,
    tokenUsage,
    suspensionReason: agentState?.suspensionReason ?? null,
    lastError: agentState?.lastError ?? null,
    pendingSteeringMessages: handle.pendingSteeringMessages(),
    timestamp: new Date().toISOString(),
  });
}
