import { extractErrorMessage, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type { ConfigDocument } from "../kernel/config-contracts.ts";

/**
 * Agent configuration resolution.
 *
 * Extracts agent profiles and orchestration settings from the central
 * configuration document. The configuration schema (config-contracts.ts)
 * validates structure, uniqueness, and root-policy ceilings; this module
 * performs cross-field validation against the runtime section (provider/model
 * existence) and produces frozen runtime types consumed by the agent runtime
 * and orchestrator.
 */

export type AgentCapability = "read" | "write" | "execute" | "delegate";

export type AgentProfile = Readonly<{
  name: string;
  type: string;
  model: string;
  provider: string;
  systemPrompt: string;
  /** An empty inventory grants no tools; all registry tools require an explicit grant. */
  tools: readonly string[] | "all";
  capabilities: readonly AgentCapability[];
  writeSet: readonly string[];
  maxTurns: number;
  backgroundTimeoutMs?: number;
}>;

export type OrchestrationConfig = Readonly<{
  alignmentMonitorIntervalMs: number;
  alignmentDriftThresholdMs?: number;
  conflictDetectionEnabled: boolean;
}>;

export type AgentsConfig = Readonly<{
  maximumConcurrentAgents: number;
  profiles: readonly AgentProfile[];
  orchestration: OrchestrationConfig;
}>;

/**
 * Default alignment-monitor interval (ms) used when the central config
 * document has no `agents` section. Mirrors the root-policy default tool
 * timeout so the monitor ticks at the same cadence as a single tool call.
 * The central config contract (`agents.orchestration.alignmentMonitorIntervalMs`)
 * is the authoritative owner when an `agents` section is present.
 */
export const DEFAULT_ALIGNMENT_MONITOR_INTERVAL_MS = 30_000;

/**
 * The agents section the runtime serves when the central config document
 * declares none — the ONE owner of every absent-`agents` default, so the
 * engine's orchestrator, the web bridge that summarizes the section, and
 * the settings registration that shows the built-in defaults cannot each
 * restate them. `maximumConcurrentAgents: 0` is the designed spelling of
 * "no cap" (the orchestrator skips the plan-size check when it reads 0).
 */
export const ABSENT_SECTION_AGENTS_CONFIG: Readonly<AgentsConfig> = deepFreeze({
  maximumConcurrentAgents: 0,
  profiles: [],
  orchestration: deepFreeze({
    alignmentMonitorIntervalMs: DEFAULT_ALIGNMENT_MONITOR_INTERVAL_MS,
    conflictDetectionEnabled: true,
  }),
});

export type RuntimeProviderModel = Readonly<{
  providerId: string;
  modelId: string;
  maxTokens: number;
  temperature: number;
}>;

export type ProviderModelResolver = Readonly<{
  resolve(profile: AgentProfile): RuntimeProviderModel;
  providerIds(): readonly string[];
  modelIds(providerId: string): readonly string[];
}>;

export function resolveAgentsConfig(document: ConfigDocument): AgentsConfig | undefined {
  const agentsSection = document.agents;
  if (agentsSection === undefined) return undefined;
  return deepFreeze({
    maximumConcurrentAgents: agentsSection.maximumConcurrentAgents,
    profiles: agentsSection.profiles.map((p) => deepFreeze({
      name: p.name,
      type: p.type,
      model: p.model,
      provider: p.provider,
      systemPrompt: p.systemPrompt,
      tools: p.tools === "all" ? "all" : deepFreeze([...p.tools]),
      capabilities: deepFreeze([...p.capabilities]),
      writeSet: deepFreeze([...p.writeSet]),
      maxTurns: p.maxTurns,
      ...(p.backgroundTimeoutMs !== undefined ? { backgroundTimeoutMs: p.backgroundTimeoutMs } : {}),
    })),
    orchestration: deepFreeze({
      alignmentMonitorIntervalMs: agentsSection.orchestration.alignmentMonitorIntervalMs,
      ...(agentsSection.orchestration.alignmentDriftThresholdMs !== undefined
        ? { alignmentDriftThresholdMs: agentsSection.orchestration.alignmentDriftThresholdMs }
        : {}),
      conflictDetectionEnabled: agentsSection.orchestration.conflictDetectionEnabled,
    }),
  });
}

export function createProviderModelResolver(document: ConfigDocument): ProviderModelResolver {
  const runtime = document.runtime;
  if (runtime === undefined) {
    throw new InputError(
      "Configuration has no 'runtime' section — required for agent model resolution",
      "agent_runtime_missing",
    );
  }
  const providers = new Map<string, Readonly<{
    id: string;
    models: ReadonlyMap<string, Readonly<{ maxTokens: number; temperature: number }>>;
  }>>();
  for (const provider of runtime.providers) {
    const models = new Map<string, Readonly<{ maxTokens: number; temperature: number }>>();
    for (const model of provider.models) {
      models.set(model.id, deepFreeze({ maxTokens: model.maxTokens, temperature: model.temperature }));
    }
    providers.set(provider.id, deepFreeze({ id: provider.id, models }));
  }
  return deepFreeze({
    resolve(profile: AgentProfile): RuntimeProviderModel {
      const provider = providers.get(profile.provider);
      if (provider === undefined) {
        throw new InputError(
          `Agent '${profile.name}' references unknown provider '${profile.provider}'`,
          "agent_provider_not_found",
        );
      }
      const model = provider.models.get(profile.model);
      if (model === undefined) {
        throw new InputError(
          `Agent '${profile.name}' references unknown model '${profile.model}' for provider '${profile.provider}'`,
          "agent_model_not_found",
        );
      }
      return deepFreeze({
        providerId: profile.provider,
        modelId: profile.model,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
      });
    },
    providerIds(): readonly string[] {
      return [...providers.keys()].sort();
    },
    modelIds(providerId: string): readonly string[] {
      const provider = providers.get(providerId);
      if (provider === undefined) return [];
      return [...provider.models.keys()].sort();
    },
  });
}

export function validateAgentsConfig(document: ConfigDocument): Readonly<{ valid: true; config: AgentsConfig; resolver: ProviderModelResolver }> | Readonly<{ valid: false; errors: readonly string[] }> {
  const errors: string[] = [];
  const agentsConfig = resolveAgentsConfig(document);
  if (agentsConfig === undefined) {
    return deepFreeze({ valid: true, config: ABSENT_SECTION_AGENTS_CONFIG, resolver: createProviderModelResolver(document) });
  }
  try {
    const resolver = createProviderModelResolver(document);
    for (const profile of agentsConfig.profiles) {
      try {
        resolver.resolve(profile);
      } catch (error) {
        errors.push(extractErrorMessage(error));
      }
    }
  } catch (error) {
    errors.push(extractErrorMessage(error));
  }
  if (errors.length > 0) {
    return deepFreeze({ valid: false, errors: deepFreeze(errors) });
  }
  return deepFreeze({ valid: true, config: agentsConfig, resolver: createProviderModelResolver(document) });
}

export function getAgentProfile(config: AgentsConfig, name: string): AgentProfile {
  const profile = config.profiles.find((p) => p.name === name);
  if (profile === undefined) {
    throw new InputError(`Agent profile '${name}' is not configured`, "agent_profile_not_found");
  }
  return profile;
}

export function hasCapability(profile: AgentProfile, capability: AgentCapability): boolean {
  return profile.capabilities.includes(capability);
}

export function isPathInWriteSet(profile: AgentProfile, path: string): boolean {
  if (profile.writeSet.length === 0) return false;
  for (const prefix of profile.writeSet) {
    if (path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export type WriteSetOwner = Readonly<{ name: string; writeSet: readonly string[] }>;

export function detectWriteSetConflictAmong(
  owners: readonly WriteSetOwner[],
): Readonly<{ conflicts: readonly Readonly<{ agentA: string; agentB: string; path: string }>[] }> {
  const conflicts: Array<Readonly<{ agentA: string; agentB: string; path: string }>> = [];
  for (let i = 0; i < owners.length; i++) {
    for (let j = i + 1; j < owners.length; j++) {
      const a = owners[i]!;
      const b = owners[j]!;
      if (a.writeSet.length === 0 || b.writeSet.length === 0) continue;
      for (const pathA of a.writeSet) {
        for (const pathB of b.writeSet) {
          if (pathA === pathB ||
            pathA.startsWith(pathB.endsWith("/") ? pathB : `${pathB}/`) ||
            pathB.startsWith(pathA.endsWith("/") ? pathA : `${pathA}/`)) {
            conflicts.push(deepFreeze({ agentA: a.name, agentB: b.name, path: pathA < pathB ? pathA : pathB }));
          }
        }
      }
    }
  }
  return deepFreeze({ conflicts: deepFreeze(conflicts) });
}

export function detectWriteSetConflict(
  profiles: readonly AgentProfile[],
): Readonly<{ conflicts: readonly Readonly<{ agentA: string; agentB: string; path: string }>[] }> {
  return detectWriteSetConflictAmong(profiles);
}
