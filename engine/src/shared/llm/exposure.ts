/**
 * LLM exposure catalog (EXP457).
 *
 * Registers the LLM module's signals, actions, and customizations on the
 * shared exposure registry (EXP425) so any consumer (the runtime, an LLM via
 * a tool, the CLI, the timeline) can observe and adjust the live queue /
 * adaptive-concurrency state through ONE canonical surface.
 *
 * IDs are domain-dotted (e.g. `queue.rejected`, `adaptive.concurrency`) with
 * `module: "llm"`; `snapshotExposure("llm")` filters by module so consumers
 * get exactly the llm catalog. The catalog is registered once via
 * {@link registerLLMExposure}. Signal `value` functions and action `execute`
 * functions read from / invoke a module-local active-client reference that
 * {@link SharedLLMClient} sets on construction, so a process with no client
 * reports an honest zero-state.
 *
 * Registration is idempotent: re-calling `registerLLMExposure` clears the
 * prior llm-module rows and re-registers (same pattern as
 * `src/safety/bandaid-exposure.ts`).
 */

import {
  registerSignal,
  registerAction,
  registerCustomization,
  unregisterSignal,
  unregisterAction,
  unregisterCustomization,
  type CustomizationValue,
} from "../exposure/index.ts";
import { InputError } from "../../kernel/errors.ts";
import { resolveQueueConfig, DEFAULT_ADAPTIVE, DEFAULT_CONCURRENCY, DEFAULT_CIRCUIT_BREAKER, DEFAULT_BACKOFF } from "./config.ts";

/**
 * What the queue settings default to, obtained from the RESOLVER rather than
 * from the default constant. The catalog's whole job is to tell a user what a
 * setting is worth if they leave it alone, and the honest answer to that is
 * what the resolver produces for an empty input — not a constant this file
 * would then have to keep in step by hand.
 */
const DEFAULTED_QUEUE = resolveQueueConfig();

const MODULE_ID = "llm";

/** Catalog counts (consumed by the EXP457 test + the gemma integration test). */
export const LLM_EXPOSURE_COUNTS = {
  signals: 32,
  actions: 9,
  customizations: 14,
} as const;

type LLMSnapshotReader = Readonly<{
  getQueue: () => Readonly<{
    active: number; pending: number; maxConcurrency: number; maxQueueSize: number;
    queueStrategy: string; paused: boolean; rejected: number; timedOut: number;
    cleared: number; avgWaitMs: number; utilization: number;
  }>;
  getAdaptive: () => Readonly<{
    concurrency: number; lastDecision: string;
    decisions: Readonly<{ increase: number; decrease: number; hold: number }>;
  }>;
  getStats: () => Readonly<{
    totalRequests: number; totalRetries: number; totalErrors: number;
    avgLatencyMs: number; failovers: number; lastErrorType: string | undefined;
    lastFailoverReason: string | undefined;
    totalTokens: Readonly<{ prompt: number; completion: number; total: number }>;
    byModel: Readonly<Record<string, { requests: number }>>;
    byProvider: Readonly<Record<string, { requests: number }>>;
  }>;
  getCircuit: () => Readonly<{
    state: string; consecutiveFailures: number; threshold: number; resetMs: number;
  }>;
  setConcurrency: (value: number) => void;
  pauseQueue: () => void;
  resumeQueue: () => void;
  clearQueue: () => number;
  rejectAll: () => number;
  resetCircuitForTest: () => void;
  getCurrentTarget: () => Readonly<{ model: string | undefined; providerId: string }>;
  getQueueConcurrency: () => number;
  isQueuePaused: () => boolean;
}>;

let activeClient: LLMSnapshotReader | undefined;

/** Bind the live client the catalog reads from. Called by SharedLLMClient. */
export function setActiveLLMClientForExposure(client: LLMSnapshotReader | undefined): void {
  activeClient = client;
}

const customizationValues: Record<string, CustomizationValue> = {
  "queue.maxConcurrency": DEFAULTED_QUEUE.maxConcurrency,
  "queue.maxQueueSize": DEFAULTED_QUEUE.maxQueueSize,
  "queue.queueTimeoutMs": DEFAULTED_QUEUE.queueTimeoutMs,
  "queue.priorityLevels": DEFAULTED_QUEUE.priorityLevels,
  "queue.strategy": DEFAULTED_QUEUE.queueStrategy,
  "concurrency.perModel": Object.freeze({}) as Readonly<Record<string, unknown>>,
  "concurrency.perProvider": Object.freeze({}) as Readonly<Record<string, unknown>>,
  "concurrency.global": DEFAULT_CONCURRENCY,
  "adaptive.enabled": DEFAULT_ADAPTIVE.enabled,
  "adaptive.decreaseFactor": DEFAULT_ADAPTIVE.decreaseFactor,
  "adaptive.rateLimitWeight": DEFAULT_ADAPTIVE.rateLimitWeight,
  "circuit.threshold": DEFAULT_CIRCUIT_BREAKER.threshold,
  "circuit.resetMs": DEFAULT_CIRCUIT_BREAKER.resetMs,
  "backoff.baseMs": DEFAULT_BACKOFF.baseMs,
};

const SIGNAL_IDS = [
  // Queue (10)
  "queue.rejected", "queue.timedOut", "queue.utilization", "queue.strategy",
  "queue.active", "queue.pending", "queue.maxConcurrency", "queue.paused",
  "queue.cleared", "queue.avgWaitMs",
  // Adaptive (4)
  "adaptive.concurrency", "adaptive.lastDecision", "adaptive.increases", "adaptive.decreases",
  // Stats (13)
  "stats.totalRequests", "stats.totalRetries", "stats.totalErrors", "stats.avgLatencyMs",
  "stats.failovers", "stats.lastErrorType", "stats.lastFailoverReason",
  "stats.tokens.prompt", "stats.tokens.completion", "stats.tokens.total",
  "stats.byModelCount", "stats.byProviderCount", "stats.circuitOpen",
  // Circuit (4)
  "circuit.state", "circuit.consecutiveFailures", "circuit.threshold", "circuit.resetMs",
  // Failover (1)
  "failover.currentModel",
] as const;
const ACTION_IDS = [
  "queue.setConcurrency", "queue.pauseQueue", "queue.resumeQueue", "queue.clearQueue", "queue.rejectAll",
  "circuit.reset", "queue.getConcurrency", "queue.isPaused", "failover.currentTarget",
] as const;
const CUSTOMIZATION_IDS = [
  "queue.maxConcurrency", "queue.maxQueueSize", "queue.queueTimeoutMs", "queue.priorityLevels", "queue.strategy",
  "concurrency.perModel", "concurrency.perProvider", "concurrency.global",
  "adaptive.enabled", "adaptive.decreaseFactor", "adaptive.rateLimitWeight",
  "circuit.threshold", "circuit.resetMs", "backoff.baseMs",
] as const;

function requireClient(): LLMSnapshotReader {
  if (activeClient === undefined) {
    throw new InputError("no active SharedLLMClient; construct one before invoking an llm action", "llm_action_no_active_client");
  }
  return activeClient;
}

export function registerLLMExposure(): void {
  for (const id of SIGNAL_IDS) unregisterSignal(id);
  for (const id of ACTION_IDS) unregisterAction(id);
  for (const id of CUSTOMIZATION_IDS) unregisterCustomization(id);

  registerSignal({ id: "queue.rejected", module: MODULE_ID, name: "Queue Rejected",
    description: "Total requests rejected by the queue (overflow / explicit rejectAll).",
    type: "counter", unit: "count", value: () => activeClient?.getQueue().rejected ?? 0 });
  registerSignal({ id: "queue.timedOut", module: MODULE_ID, name: "Queue Timed Out",
    description: "Total requests rejected because they waited longer than the queue timeout.",
    type: "counter", unit: "count", value: () => activeClient?.getQueue().timedOut ?? 0 });
  registerSignal({ id: "queue.utilization", module: MODULE_ID, name: "Queue Utilization",
    description: "Current queue utilization (active / maxConcurrency), 0–1.", type: "gauge", unit: "ratio",
    value: () => activeClient?.getQueue().utilization ?? 0 });
  registerSignal({ id: "queue.strategy", module: MODULE_ID, name: "Queue Strategy",
    description: "The queue selection policy (fifo, lifo, priority, round-robin).", type: "state",
    value: () => activeClient?.getQueue().queueStrategy ?? DEFAULTED_QUEUE.queueStrategy });
  registerSignal({ id: "adaptive.concurrency", module: MODULE_ID, name: "Adaptive Concurrency",
    description: "The current adaptive-concurrency value applied to the queue.", type: "gauge", unit: "count",
    value: () => activeClient?.getAdaptive().concurrency ?? 0 });
  registerSignal({ id: "adaptive.lastDecision", module: MODULE_ID, name: "Adaptive Last Decision",
    description: "The most recent AIMD decision (increase, decrease, hold, disabled).", type: "state",
    value: () => activeClient?.getAdaptive().lastDecision ?? "disabled" });
  registerSignal({ id: "adaptive.increases", module: MODULE_ID, name: "Adaptive Increases",
    description: "Total AIMD increase decisions in the current sample window.", type: "counter", unit: "count",
    value: () => activeClient?.getAdaptive().decisions.increase ?? 0 });
  registerSignal({ id: "adaptive.decreases", module: MODULE_ID, name: "Adaptive Decreases",
    description: "Total AIMD decrease decisions in the current sample window.", type: "counter", unit: "count",
    value: () => activeClient?.getAdaptive().decisions.decrease ?? 0 });

  // Queue extra (6)
  registerSignal({ id: "queue.active", module: MODULE_ID, name: "Queue Active", description: "Currently in-flight requests.", type: "gauge", unit: "count", value: () => activeClient?.getQueue().active ?? 0 });
  registerSignal({ id: "queue.pending", module: MODULE_ID, name: "Queue Pending", description: "Requests waiting in the queue.", type: "gauge", unit: "count", value: () => activeClient?.getQueue().pending ?? 0 });
  registerSignal({ id: "queue.maxConcurrency", module: MODULE_ID, name: "Queue Max Concurrency", description: "The configured concurrency cap.", type: "gauge", unit: "count", value: () => activeClient?.getQueue().maxConcurrency ?? 0 });
  registerSignal({ id: "queue.paused", module: MODULE_ID, name: "Queue Paused", description: "Whether queue admission is paused.", type: "boolean", value: () => activeClient?.getQueue().paused ?? false });
  registerSignal({ id: "queue.cleared", module: MODULE_ID, name: "Queue Cleared", description: "Total requests dropped by clearQueue.", type: "counter", unit: "count", value: () => activeClient?.getQueue().cleared ?? 0 });
  registerSignal({ id: "queue.avgWaitMs", module: MODULE_ID, name: "Queue Avg Wait (ms)", description: "Average queue wait time in ms.", type: "gauge", unit: "ms", value: () => activeClient?.getQueue().avgWaitMs ?? 0 });
  // Stats (13)
  registerSignal({ id: "stats.totalRequests", module: MODULE_ID, name: "Total Requests", description: "Total LLM requests attempted.", type: "counter", unit: "count", value: () => activeClient?.getStats().totalRequests ?? 0 });
  registerSignal({ id: "stats.totalRetries", module: MODULE_ID, name: "Total Retries", description: "Total retry attempts.", type: "counter", unit: "count", value: () => activeClient?.getStats().totalRetries ?? 0 });
  registerSignal({ id: "stats.totalErrors", module: MODULE_ID, name: "Total Errors", description: "Total failed requests.", type: "counter", unit: "count", value: () => activeClient?.getStats().totalErrors ?? 0 });
  registerSignal({ id: "stats.avgLatencyMs", module: MODULE_ID, name: "Avg Latency (ms)", description: "Average request latency in ms.", type: "gauge", unit: "ms", value: () => activeClient?.getStats().avgLatencyMs ?? 0 });
  registerSignal({ id: "stats.failovers", module: MODULE_ID, name: "Failovers", description: "Total provider failovers.", type: "counter", unit: "count", value: () => activeClient?.getStats().failovers ?? 0 });
  registerSignal({ id: "stats.lastErrorType", module: MODULE_ID, name: "Last Error Type", description: "The error type of the most recent failure.", type: "state", value: () => activeClient?.getStats().lastErrorType ?? "none" });
  registerSignal({ id: "stats.lastFailoverReason", module: MODULE_ID, name: "Last Failover Reason", description: "The reason for the most recent failover.", type: "state", value: () => activeClient?.getStats().lastFailoverReason ?? "none" });
  registerSignal({ id: "stats.tokens.prompt", module: MODULE_ID, name: "Prompt Tokens", description: "Total prompt tokens used.", type: "counter", unit: "tokens", value: () => activeClient?.getStats().totalTokens.prompt ?? 0 });
  registerSignal({ id: "stats.tokens.completion", module: MODULE_ID, name: "Completion Tokens", description: "Total completion tokens used.", type: "counter", unit: "tokens", value: () => activeClient?.getStats().totalTokens.completion ?? 0 });
  registerSignal({ id: "stats.tokens.total", module: MODULE_ID, name: "Total Tokens", description: "Total tokens (prompt + completion).", type: "counter", unit: "tokens", value: () => activeClient?.getStats().totalTokens.total ?? 0 });
  registerSignal({ id: "stats.byModelCount", module: MODULE_ID, name: "Models Used", description: "Number of distinct models with recorded requests.", type: "gauge", unit: "count", value: () => Object.keys(activeClient?.getStats().byModel ?? {}).length });
  registerSignal({ id: "stats.byProviderCount", module: MODULE_ID, name: "Providers Used", description: "Number of distinct providers with recorded requests.", type: "gauge", unit: "count", value: () => Object.keys(activeClient?.getStats().byProvider ?? {}).length });
  registerSignal({ id: "stats.circuitOpen", module: MODULE_ID, name: "Circuit Open", description: "Whether the circuit breaker is open.", type: "boolean", value: () => activeClient?.getCircuit().state === "open" });
  // Circuit (4)
  registerSignal({ id: "circuit.state", module: MODULE_ID, name: "Circuit State", description: "Circuit breaker state (closed, open, half-open).", type: "state", value: () => activeClient?.getCircuit().state ?? "closed" });
  registerSignal({ id: "circuit.consecutiveFailures", module: MODULE_ID, name: "Circuit Consecutive Failures", description: "Consecutive failures before the circuit opens.", type: "gauge", unit: "count", value: () => activeClient?.getCircuit().consecutiveFailures ?? 0 });
  registerSignal({ id: "circuit.threshold", module: MODULE_ID, name: "Circuit Threshold", description: "Failure threshold that opens the circuit.", type: "gauge", unit: "count", value: () => activeClient?.getCircuit().threshold ?? 0 });
  registerSignal({ id: "circuit.resetMs", module: MODULE_ID, name: "Circuit Reset (ms)", description: "Time before the circuit half-opens.", type: "gauge", unit: "ms", value: () => activeClient?.getCircuit().resetMs ?? 0 });
  // Failover (1)
  registerSignal({ id: "failover.currentModel", module: MODULE_ID, name: "Failover Current Model", description: "The model the failover selector currently targets.", type: "state", value: () => activeClient?.getCurrentTarget().model ?? "none" });

  registerAction({ id: "queue.setConcurrency", module: MODULE_ID, name: "Set Concurrency",
    description: "Set the queue's concurrency cap at runtime.",
    args: { value: { type: "number", required: true, description: "The new concurrency cap (integer ≥ 1)." } },
    execute: (args) => { requireClient().setConcurrency(Number(args?.value)); return { ok: true }; } });
  registerAction({ id: "queue.pauseQueue", module: MODULE_ID, name: "Pause Queue",
    description: "Pause queue admission; pending requests wait until resumed.",
    execute: () => { requireClient().pauseQueue(); return { ok: true }; } });
  registerAction({ id: "queue.resumeQueue", module: MODULE_ID, name: "Resume Queue",
    description: "Resume queue admission after a pause.",
    execute: () => { requireClient().resumeQueue(); return { ok: true }; } });
  registerAction({ id: "queue.clearQueue", module: MODULE_ID, name: "Clear Queue",
    description: "Drop all pending requests from the queue.",
    execute: () => { requireClient().clearQueue(); return { ok: true }; } });
  registerAction({ id: "queue.rejectAll", module: MODULE_ID, name: "Reject All",
    description: "Reject all pending requests with a typed error.",
    execute: () => { requireClient().rejectAll(); return { ok: true }; } });
  registerAction({ id: "circuit.reset", module: MODULE_ID, name: "Reset Circuit",
    description: "Reset the circuit breaker to closed (clears consecutive failures).",
    execute: () => { requireClient().resetCircuitForTest(); return { ok: true }; } });
  registerAction({ id: "queue.getConcurrency", module: MODULE_ID, name: "Get Concurrency",
    description: "Read the queue's current concurrency cap.",
    execute: () => requireClient().getQueueConcurrency() });
  registerAction({ id: "queue.isPaused", module: MODULE_ID, name: "Is Paused",
    description: "Read whether the queue is currently paused.",
    execute: () => requireClient().isQueuePaused() });
  registerAction({ id: "failover.currentTarget", module: MODULE_ID, name: "Current Failover Target",
    description: "Read the current failover target (provider + model).",
    execute: () => requireClient().getCurrentTarget() });

  registerCustomization({ id: "queue.maxConcurrency", module: MODULE_ID, name: "Queue Max Concurrency",
    description: "Maximum in-flight requests the queue admits concurrently.", type: "number",
    default: DEFAULTED_QUEUE.maxConcurrency, min: 1, unit: "count",
    current: () => customizationValues["queue.maxConcurrency"]!, set: (v) => { customizationValues["queue.maxConcurrency"] = Number(v); } });
  registerCustomization({ id: "queue.maxQueueSize", module: MODULE_ID, name: "Queue Max Size",
    description: "Maximum pending requests the queue holds before rejecting overflow.", type: "number",
    default: DEFAULTED_QUEUE.maxQueueSize, min: 0, unit: "count",
    current: () => customizationValues["queue.maxQueueSize"]!, set: (v) => { customizationValues["queue.maxQueueSize"] = Number(v); } });
  registerCustomization({ id: "queue.queueTimeoutMs", module: MODULE_ID, name: "Queue Timeout (ms)",
    description: "How long a pending request waits before it is rejected as stale.", type: "number",
    default: DEFAULTED_QUEUE.queueTimeoutMs, min: 0, unit: "ms",
    current: () => customizationValues["queue.queueTimeoutMs"]!, set: (v) => { customizationValues["queue.queueTimeoutMs"] = Number(v); } });
  registerCustomization({ id: "queue.priorityLevels", module: MODULE_ID, name: "Queue Priority Levels",
    description: "Enable priority queuing so callers may pass a request priority.", type: "boolean",
    default: DEFAULTED_QUEUE.priorityLevels,
    current: () => customizationValues["queue.priorityLevels"] === true, set: (v) => { customizationValues["queue.priorityLevels"] = v === true; } });
  registerCustomization({ id: "queue.strategy", module: MODULE_ID, name: "Queue Strategy",
    description: "Selection policy for the next pending request.", type: "enum",
    default: DEFAULTED_QUEUE.queueStrategy, enum: ["fifo", "lifo", "priority", "round-robin"],
    current: () => customizationValues["queue.strategy"]!, set: (v) => { customizationValues["queue.strategy"] = String(v); } });
  registerCustomization({ id: "concurrency.perModel", module: MODULE_ID, name: "Concurrency Per Model",
    description: "Per-model concurrency caps (model id → max in-flight).", type: "object", default: Object.freeze({}) as Readonly<Record<string, unknown>>,
    current: () => customizationValues["concurrency.perModel"]!, set: (v) => { customizationValues["concurrency.perModel"] = v; } });
  registerCustomization({ id: "concurrency.perProvider", module: MODULE_ID, name: "Concurrency Per Provider",
    description: "Per-provider concurrency caps (provider id → max in-flight).", type: "object", default: Object.freeze({}) as Readonly<Record<string, unknown>>,
    current: () => customizationValues["concurrency.perProvider"]!, set: (v) => { customizationValues["concurrency.perProvider"] = v; } });
  registerCustomization({ id: "concurrency.global", module: MODULE_ID, name: "Concurrency Global",
    description: "Global concurrency ceiling across all models + providers.", type: "number",
    default: DEFAULT_CONCURRENCY, min: 1, unit: "count",
    current: () => customizationValues["concurrency.global"]!, set: (v) => { customizationValues["concurrency.global"] = Number(v); } });
  registerCustomization({ id: "adaptive.enabled", module: MODULE_ID, name: "Adaptive Enabled",
    description: "Enable AIMD adaptive concurrency (auto-adjust on error/latency).", type: "boolean",
    default: DEFAULT_ADAPTIVE.enabled,
    current: () => customizationValues["adaptive.enabled"] === true, set: (v) => { customizationValues["adaptive.enabled"] = v === true; } });
  registerCustomization({ id: "adaptive.decreaseFactor", module: MODULE_ID, name: "Adaptive Decrease Factor",
    description: "Multiplicative decrease factor (0–1) on an error/429.", type: "number",
    default: DEFAULT_ADAPTIVE.decreaseFactor, min: 0, max: 1,
    current: () => customizationValues["adaptive.decreaseFactor"]!, set: (v) => { customizationValues["adaptive.decreaseFactor"] = Number(v); } });
  registerCustomization({ id: "adaptive.rateLimitWeight", module: MODULE_ID, name: "Adaptive Rate-Limit Weight",
    description: "Weight a 429/rate-limit error carries vs a hard error in the AIMD window.", type: "number",
    default: DEFAULT_ADAPTIVE.rateLimitWeight, min: 0,
    current: () => customizationValues["adaptive.rateLimitWeight"]!, set: (v) => { customizationValues["adaptive.rateLimitWeight"] = Number(v); } });
  registerCustomization({ id: "circuit.threshold", module: MODULE_ID, name: "Circuit Threshold",
    description: "Consecutive failures before the circuit opens.", type: "number",
    default: DEFAULT_CIRCUIT_BREAKER.threshold, min: 1, unit: "count",
    current: () => customizationValues["circuit.threshold"]!, set: (v) => { customizationValues["circuit.threshold"] = Number(v); } });
  registerCustomization({ id: "circuit.resetMs", module: MODULE_ID, name: "Circuit Reset (ms)",
    description: "Time before the circuit half-opens after tripping.", type: "number",
    default: DEFAULT_CIRCUIT_BREAKER.resetMs, min: 0, unit: "ms",
    current: () => customizationValues["circuit.resetMs"]!, set: (v) => { customizationValues["circuit.resetMs"] = Number(v); } });
  registerCustomization({ id: "backoff.baseMs", module: MODULE_ID, name: "Backoff Base (ms)",
    description: "Base delay for exponential retry backoff.", type: "number",
    default: DEFAULT_BACKOFF.baseMs, min: 0, unit: "ms",
    current: () => customizationValues["backoff.baseMs"]!, set: (v) => { customizationValues["backoff.baseMs"] = Number(v); } });
}
