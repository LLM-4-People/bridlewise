import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type { AgentProfile } from "./agent-config.ts";
import type { AgentRuntime, AgentRuntimeOptions, AgentRunResult, AgentTurnResult } from "./agent-runtime.ts";
import type { AgentLifecycleState } from "./agent-state.ts";

/**
 * Agent type registry — the canonical extensibility mechanism for agent types.
 *
 * Each agent type (call-and-return, background, future types) registers an
 * `AgentTypeDefinition` that describes its execution mode, lifecycle states,
 * hooks, and factory function. The orchestrator resolves an agent profile to
 * its type definition via `registry.resolve(profile)` and uses the type's
 * `createRuntime` factory to create the agent — without hardcoding any
 * specific type.
 *
 * `AGENT_TYPE_IDS` is the one canonical owner for the set of valid agent type
 * IDs. It is consumed by the config schema (config-contracts.ts), the agent
 * config resolver (agent-config.ts), and the registry itself. Adding a new
 * agent type requires adding its ID to `AGENT_TYPE_IDS`, creating an
 * `AgentTypeDefinition`, and registering it at bootstrap — no changes to the
 * orchestrator, config schema, or agent-config.
 *
 * Per DER-027: "Configure topology, role assignment, nesting, and
 * zero-to-five-agent combinations through the central configuration and
 * registry without orchestration-engine source edits."
 *
 * Per DER-030: types are registered at bootstrap, not dynamically at runtime.
 * The registry seals after initial registration; `register` throws if
 * called after sealing.
 */

export const AGENT_TYPE_IDS = deepFreeze(["call-and-return", "background"] as const);

export type AgentTypeId = (typeof AGENT_TYPE_IDS)[number];

export type AgentExecutionMode = "sync" | "async";

export type AgentHookContext = Readonly<{
  agentId: string;
  agentName: string;
  runId: string;
  taskId: string;
  attemptId: string;
  profile: AgentProfile;
}>;

export type AgentLifecycleHooks = Readonly<{
  onStart?: (context: AgentHookContext) => void | Promise<void>;
  onTurn?: (context: AgentHookContext, turnResult: AgentTurnResult) => void | Promise<void>;
  onComplete?: (context: AgentHookContext, result: AgentRunResult) => void | Promise<void>;
  onFailure?: (context: AgentHookContext, error: string) => void | Promise<void>;
  onCancel?: (context: AgentHookContext, reason: string) => void | Promise<void>;
  onSuspend?: (context: AgentHookContext, reason: string) => void | Promise<void>;
  onResume?: (context: AgentHookContext) => void | Promise<void>;
  onTimeout?: (context: AgentHookContext) => void | Promise<void>;
}>;

export type AgentTypeDefinition = Readonly<{
  typeId: AgentTypeId;
  description: string;
  executionMode: AgentExecutionMode;
  lifecycleStates: readonly AgentLifecycleState[];
  terminalStates: readonly AgentLifecycleState[];
  hooks: AgentLifecycleHooks;
  createRuntime: (options: AgentRuntimeOptions) => AgentRuntime;
  validateProfile: (profile: AgentProfile) => readonly string[];
}>;

export type AgentTypeRegistry = Readonly<{
  register(typeDef: AgentTypeDefinition): void;
  resolve(profile: AgentProfile): AgentTypeDefinition;
  get(typeId: string): AgentTypeDefinition | undefined;
  registeredTypes(): readonly string[];
  has(typeId: string): boolean;
}>;

const NOOP_HOOKS: AgentLifecycleHooks = deepFreeze({});

export function createAgentTypeRegistry(
  types?: readonly AgentTypeDefinition[],
): AgentTypeRegistry {
  const registry = new Map<string, AgentTypeDefinition>();
  let sealed = false;

  function register(typeDef: AgentTypeDefinition): void {
    if (sealed) {
      throw new InputError(
        `Agent type registry is sealed; cannot register type '${typeDef.typeId}' after bootstrap`,
        "agent_registry_sealed",
      );
    }
    if (typeof typeDef.typeId !== "string" || typeDef.typeId.length === 0) {
      throw new InputError(
        "Agent type definition has empty or invalid typeId",
        "agent_registry_invalid_type_id",
      );
    }
    if (!AGENT_TYPE_IDS.includes(typeDef.typeId as AgentTypeId)) {
      throw new InputError(
        `Agent type '${typeDef.typeId}' is not in AGENT_TYPE_IDS`,
        "agent_registry_type_id_not_allowed",
      );
    }
    if (typeof typeDef.createRuntime !== "function") {
      throw new InputError(
        `Agent type '${typeDef.typeId}' has missing createRuntime factory`,
        "agent_registry_invalid_definition",
      );
    }
    if (typeof typeDef.validateProfile !== "function") {
      throw new InputError(
        `Agent type '${typeDef.typeId}' has missing validateProfile function`,
        "agent_registry_invalid_definition",
      );
    }
    if (!Array.isArray(typeDef.lifecycleStates) || typeDef.lifecycleStates.length === 0) {
      throw new InputError(
        `Agent type '${typeDef.typeId}' has empty lifecycleStates`,
        "agent_registry_invalid_definition",
      );
    }
    if (!Array.isArray(typeDef.terminalStates)) {
      throw new InputError(
        `Agent type '${typeDef.typeId}' has invalid terminalStates`,
        "agent_registry_invalid_definition",
      );
    }
    if (registry.has(typeDef.typeId)) {
      throw new InputError(
        `Agent type '${typeDef.typeId}' is already registered`,
        "agent_registry_duplicate_type",
      );
    }
    const mergedHooks: AgentLifecycleHooks = deepFreeze({ ...NOOP_HOOKS, ...typeDef.hooks });
    registry.set(typeDef.typeId, deepFreeze({
      ...typeDef,
      hooks: mergedHooks,
      // Wrap createRuntime so the type's hooks are injected into the runtime
      // options automatically. This keeps the orchestrator and every concrete
      // type definition free of hook-wiring code: a caller invoking
      // typeDef.createRuntime(options) gets a runtime whose hooks are already
      // bound to typeDef.hooks.
      createRuntime: (options: AgentRuntimeOptions) => typeDef.createRuntime({ ...options, hooks: mergedHooks }),
    }));
  }

  for (const typeDef of types ?? []) {
    register(typeDef);
  }
  sealed = true;

  function resolve(profile: AgentProfile): AgentTypeDefinition {
    const typeId = profile.type ?? "call-and-return";
    const typeDef = registry.get(typeId);
    if (typeDef === undefined) {
      throw new InputError(
        `Unknown agent type '${typeId}' for agent '${profile.name}'`,
        "agent_registry_unknown_type",
      );
    }
    return typeDef;
  }

  function get(typeId: string): AgentTypeDefinition | undefined {
    return registry.get(typeId);
  }

  function registeredTypes(): readonly string[] {
    return [...registry.keys()].sort();
  }

  function has(typeId: string): boolean {
    return registry.has(typeId);
  }

  return deepFreeze({ register, resolve, get, registeredTypes, has });
}
