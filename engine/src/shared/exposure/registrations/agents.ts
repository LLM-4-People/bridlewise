/**
 * Shared exposure registrations — `agents` module.
 *
 * Multi-agent orchestration shaping: how many agents one plan may run at
 * once, how often their alignment is monitored, how far an agent may drift
 * before it is corrected, and whether conflicting edits are detected
 * before they land.
 *
 * THE DISPOSITION DOCTRINE (this class's census, tests/prevention/
 * exposure-reachable.test.ts): the section declares 5 leaves. Four are
 * operator-shaping knobs with real consumers on both doors — the web
 * bridge reads the section live per call (the settings room's own
 * install), and the engine orchestrator resolves it once per run — so
 * they register as writable rows with the web install's honest
 * `immediate` timing. No cross-leaf floor is honest among them (the
 * leaves do not couple the way the safety escalation pair does: the
 * concurrency cap's 0 is the designed "no cap" spelling the orchestrator
 * itself honors, the monitor interval is positive by schema so the
 * monitor is always armed when the section exists, and the drift
 * threshold's default stands alone), so the rows carry the schema's own
 * bounds and no invented floor. `profiles` is an array of profile
 * OBJECTS — an entity list the settings sheet cannot write (it refuses
 * array JSON by design) — filed pending the mcpServers-class
 * add/edit/remove door, which owes the profiles editor too.
 *
 * THE HONEST TIMING: the web server's agent bridge and delegation runtime
 * re-read the config file per call (mtime-checked, no restart needed), so
 * a settings write reaches the very next agent listing or delegation —
 * `immediate` on this install. The engine CLI orchestrator resolves the
 * same file at each of its own run starts.
 */

import {
  registerCustomization,
  registerExposureModule,
} from "../index.ts";
import {
  readBooleanCustomization,
  readNumberCustomization,
  writeConfigCustomization,
} from "../config-binding.ts";
import { ROOT_POLICY } from "../../../kernel/root-policy.ts";
import { ABSENT_SECTION_AGENTS_CONFIG } from "../../../agents/agent-config.ts";
import { DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS } from "../../../agents/agents-config.ts";

let agentsRegistered = false;
export function registerAgentsExposure(): void {
  if (agentsRegistered) return;
  agentsRegistered = true;

  registerExposureModule({
    id: "agents",
    title: "How several agents work at once",
    purpose:
      "How many agents one plan may run at once, how often their alignment is checked, how far one may drift before correction, and whether conflicting edits are caught.",
  });

  registerCustomization({
    id: "agents.maximumConcurrentAgents",
    module: "agents",
    name: "Most agents one plan may run at once",
    description:
      "A plan may not need more concurrent agents than this; 0 means no cap at all. Lower = fewer agents compete for the machine and the model at once; higher = a wide plan runs without splitting into waves. Applies the moment the next delegation reads it.",
    type: "number",
    default: ABSENT_SECTION_AGENTS_CONFIG.maximumConcurrentAgents,
    min: 0,
    max: ROOT_POLICY.runtime.limits.maximumAgents,
    unit: "agents",
    current: () =>
      readNumberCustomization(
        "agents.maximumConcurrentAgents",
        ABSENT_SECTION_AGENTS_CONFIG.maximumConcurrentAgents,
      ),
    set: (v) => writeConfigCustomization("agents.maximumConcurrentAgents", v),
    contract: { effect: "immediate" },
    configPath: "agents.maximumConcurrentAgents",
  });
  registerCustomization({
    id: "agents.alignmentMonitorIntervalMs",
    module: "agents",
    name: "How often running agents are checked for alignment",
    description:
      "While several agents work, the alignment monitor looks in this often to confirm they still agree with the plan. Lower = drift is caught sooner at the cost of more checks; higher = less checking, slower detection. Applies the moment the next delegation reads it.",
    type: "number",
    default: ABSENT_SECTION_AGENTS_CONFIG.orchestration.alignmentMonitorIntervalMs,
    min: 1,
    max: ROOT_POLICY.runtime.limits.maximumTimeoutMs,
    unit: "milliseconds",
    current: () =>
      readNumberCustomization(
        "agents.orchestration.alignmentMonitorIntervalMs",
        ABSENT_SECTION_AGENTS_CONFIG.orchestration.alignmentMonitorIntervalMs,
      ),
    set: (v) => writeConfigCustomization("agents.orchestration.alignmentMonitorIntervalMs", v),
    contract: { effect: "immediate" },
    configPath: "agents.orchestration.alignmentMonitorIntervalMs",
  });
  registerCustomization({
    id: "agents.alignmentDriftThresholdMs",
    module: "agents",
    name: "How far an agent may drift before it is corrected",
    description:
      "An agent whose work has drifted from the plan for longer than this is pulled back. Lower = tight plans stay tight; higher = exploratory agents are given room before correction. Applies the moment the next delegation reads it.",
    type: "number",
    default: DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS,
    min: 1,
    max: ROOT_POLICY.runtime.limits.maximumTimeoutMs,
    unit: "milliseconds",
    current: () =>
      readNumberCustomization(
        "agents.orchestration.alignmentDriftThresholdMs",
        DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS,
      ),
    set: (v) => writeConfigCustomization("agents.orchestration.alignmentDriftThresholdMs", v),
    contract: { effect: "immediate" },
    configPath: "agents.orchestration.alignmentDriftThresholdMs",
  });
  registerCustomization({
    id: "agents.conflictDetectionEnabled",
    module: "agents",
    name: "Whether conflicting agent edits are detected",
    description:
      "When several agents write, their intended changes are checked against each other before they land. On = a plan whose agents would clobber one another is refused up front; off = independent task sets run without the check's overhead. Applies the moment the next delegation reads it.",
    type: "boolean",
    default: ABSENT_SECTION_AGENTS_CONFIG.orchestration.conflictDetectionEnabled,
    current: () =>
      readBooleanCustomization(
        "agents.orchestration.conflictDetectionEnabled",
        ABSENT_SECTION_AGENTS_CONFIG.orchestration.conflictDetectionEnabled,
      ),
    set: (v) => writeConfigCustomization("agents.orchestration.conflictDetectionEnabled", v),
    contract: { effect: "immediate" },
    configPath: "agents.orchestration.conflictDetectionEnabled",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetAgentsRegistration(): void {
  agentsRegistered = false;
}
