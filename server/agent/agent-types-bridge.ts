/**
 * Agent types bridge — exposes the canonical agent type registry and agent
 * configuration. Lists available agent types (call-and-return, background),
 * their descriptions, and any agent profiles configured in the harness config.
 */

import { AGENT_TYPE_IDS, ABSENT_SECTION_AGENTS_CONFIG } from "../kernel/canonical.ts";
import { getAgentsConfig } from "../kernel/harness-config.ts";

// ── Agent type metadata (the registry knows these) ──

export type AgentTypeInfo = Readonly<{
  typeId: string;
  description: string;
  executionMode: string;
}>;

const AGENT_TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "call-and-return": "Synchronous agent that executes a task and returns a result. Best for one-shot tasks like code analysis, file reads, or single-step operations.",
  "background": "Asynchronous agent that runs in the background with a lifecycle (start, suspend, resume, cancel). Best for long-running tasks like monitoring, continuous analysis, or multi-step workflows.",
};

export function listAgentTypes(): readonly AgentTypeInfo[] {
  return AGENT_TYPE_IDS.map((typeId) => ({
    typeId,
    description: AGENT_TYPE_DESCRIPTIONS[typeId] ?? `Agent type: ${typeId}`,
    executionMode: typeId === "background" ? "async" : "sync",
  }));
}

// ── Agent profiles (from the harness config — routed through harness-config.ts) ──

export type AgentProfileView = Readonly<{
  name: string;
  type: string;
  model: string;
  provider: string;
  systemPrompt: string;
  tools: readonly string[] | "all";
  capabilities: readonly string[];
  writeSet: readonly string[];
  maxTurns: number;
  backgroundTimeoutMs: number | null;
}>;

export function listAgentProfiles(): readonly AgentProfileView[] {
  const agentsSection = getAgentsConfig();
  if (agentsSection.profiles === undefined || !Array.isArray(agentsSection.profiles)) return [];
  return agentsSection.profiles.map((p) => ({
    name: String(p.name ?? ""),
    type: String(p.type ?? "call-and-return"),
    model: String(p.model ?? ""),
    provider: String(p.provider ?? ""),
    systemPrompt: String(p.systemPrompt ?? ""),
    tools: p.tools === "all" ? "all" : p.tools.map(String),
    capabilities: Array.isArray(p.capabilities) ? p.capabilities.map(String) : [],
    writeSet: Array.isArray(p.writeSet) ? p.writeSet.map(String) : [],
    maxTurns: Number(p.maxTurns ?? 10),
    backgroundTimeoutMs: typeof p.backgroundTimeoutMs === "number" ? p.backgroundTimeoutMs : null,
  }));
}

export function getAgentsConfigSummary(): Readonly<{
  maximumConcurrentAgents: number;
  profileCount: number;
  orchestration: Readonly<{
    alignmentMonitorIntervalMs: number;
    conflictDetectionEnabled: boolean;
  }>;
}> {
  const profiles = listAgentProfiles();
  const agentsSection = getAgentsConfig();
  // The absent-section answers come from the engine's one owner of that
  // state — never a restated literal here. The engine's own absent-section
  // default for the concurrency cap is 0 (the designed "no cap" spelling:
  // the orchestrator skips the plan-size check when it reads 0), so the
  // summary a reader sees matches what the orchestrator would actually do.
  const maxConcurrent = Number(
    agentsSection.maximumConcurrentAgents ?? ABSENT_SECTION_AGENTS_CONFIG.maximumConcurrentAgents,
  );
  const orch = agentsSection.orchestration;
  return {
    maximumConcurrentAgents: maxConcurrent,
    profileCount: profiles.length,
    orchestration: {
      alignmentMonitorIntervalMs: Number(
        orch?.alignmentMonitorIntervalMs ?? ABSENT_SECTION_AGENTS_CONFIG.orchestration.alignmentMonitorIntervalMs,
      ),
      conflictDetectionEnabled: Boolean(
        orch?.conflictDetectionEnabled ?? ABSENT_SECTION_AGENTS_CONFIG.orchestration.conflictDetectionEnabled,
      ),
    },
  };
}
