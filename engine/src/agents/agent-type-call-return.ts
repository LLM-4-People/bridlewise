import type { AgentTypeDefinition } from "./agent-type-registry.ts";
import type { AgentProfile } from "./agent-config.ts";
import { createAgentRuntime } from "./agent-runtime.ts";

/**
 * Call-and-return agent type — the default synchronous execution model.
 *
 * The caller invokes the agent, waits for the full result, and the agent
 * terminates. This is the existing behavior, formalized as a type. The
 * `createRuntime` factory delegates to the existing `createAgentRuntime` —
 * no duplication, no behavioral change.
 *
 * Lifecycle: pending → running → succeeded | failed | cancelled
 * Execution mode: sync
 */

export const CALL_RETURN_AGENT_TYPE: AgentTypeDefinition = {
  typeId: "call-and-return",
  description: "Synchronous agent: caller invokes, waits for result, agent terminates.",
  executionMode: "sync",
  lifecycleStates: ["pending", "running", "succeeded", "failed", "cancelled"],
  terminalStates: ["succeeded", "failed", "cancelled"],
  hooks: {},
  createRuntime: (options) => createAgentRuntime(options),
  validateProfile: (profile: AgentProfile): readonly string[] => {
    const errors: string[] = [];
    if (profile.maxTurns < 1) {
      errors.push("call-and-return agent requires maxTurns >= 1");
    }
    if (profile.name.length === 0) {
      errors.push("call-and-return agent requires a non-empty name");
    }
    return errors;
  },
};
