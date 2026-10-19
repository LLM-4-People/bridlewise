/**
 * THE WEB-UI PERFORMANCE BUDGETS, ONE LIST (a module of its own: the root
 * policy's literal holds only imports before it, so its static reading stays
 * whole — S1's freeze boundary): each budget's name in the config
 * section `webUi.performance` with the kind of number it is. The config
 * schema, the server's accessor and the ledger judge's budget registry are
 * all read from it (UR-24: one budget judgement — a perf budget is judged
 * like the CPU budget, owned and not worse than the target's slotted value).
 */
export const WEB_PERFORMANCE_BUDGET_KINDS = {
  lcpMaxMs: "positive",
  clsMax: "non-negative",
  longTaskWorstMaxMs: "positive",
  longTaskTotalMaxMs: "positive",
  tabSwitchMaxMs: "positive",
  tabDomNodesMax: "positive-int",
  typingMeanMaxMs: "positive",
  apiResponseMaxMs: "positive",
  longSessionHeapGrowthMaxMb: "positive",
  longSessionDomGrowthMax: "positive-int",
  longChatRenderMaxMs: "positive",
  manyProjectsRenderMaxMs: "positive",
  viewportLcpMaxMs: "positive",
} as const;

/** Where a web ledger row keeps the profile's measurements, and the gate name a perf budget's judgement carries. */
export const WEB_PERFORMANCE_LEDGER_FIELD = "performanceMeasurements";
export const WEB_PERFORMANCE_GATE_PREFIX = "performance:";
