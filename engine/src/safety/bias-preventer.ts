import {
  type BiasConfig,
  type BiasStance,
  BIAS_TYPES,
} from "./bias-config.ts";
import {
  type BiasDetectionReport,
  type BiasDetector,
  type SearchEvent,
  type RepositoryAwareness,
  type MemoryFact,
  createBiasDetector,
  tokenizeForBias,
} from "./bias-detector.ts";

/**
 * Bias preventer: wraps LLM-facing search/read/suggest APIs to force
 * balanced behavior and reuses the EXP360/371 memory-trust enforcement
 * cascade for recency bias (DRY — do not duplicate).
 *
 * Each prevention strategy returns a `PreventionAction` describing what
 * the harness should inject (a system message, an extra tool call, a
 * coverage prompt, etc.). The caller is responsible for actually
 * invoking the LLM/tool; this module never calls the network.
 *
 * The eight prevention strategies map 1:1 to the eight bias types:
 * 1. confirmation → for each `for` search, emit a paired `against` search.
 * 2. anchoring → emit a from-scratch re-evaluation prompt every N turns.
 * 3. selection → after an answer, emit a coverage prompt for missing files.
 * 4. recency → emit the memory-trust enforcement cascade (L0-L4).
 * 5. availability → emit a relevance-first retrieval plan (TF-IDF + Ebbinghaus).
 * 6. representation → emit codebase-pattern hints before any code suggestion.
 * 7. sampling → emit either a full-coverage reindex plan or a documented strategy.
 * 8. metric → emit context annotations for each metric finding.
 */
export type PreventionAction = Readonly<{
  type: BiasActionType;
  bias: (typeof BIAS_TYPES)[number];
  turn: number;
  /** Human-readable instruction to inject into the LLM context. */
  injection: string;
  /** Side-effecting tool call to issue (or null for context-only actions). */
  toolCall: ToolCall | null;
}>;

export type BiasActionType =
  | "paired-search"
  | "reevaluation"
  | "coverage-prompt"
  | "memory-trust-cascade"
  | "relevance-retrieval"
  | "pattern-hint"
  | "reindex-or-document"
  | "metric-context";

export type ToolCall = Readonly<{
  tool: string;
  args: Readonly<Record<string, string>>;
}>;

export type PreventionPlan = Readonly<{
  actions: readonly PreventionAction[];
  /** Set of bias types for which no action was emitted (still clean). */
  clean: readonly (typeof BIAS_TYPES)[number][];
}>;

/**
 * The memory-trust enforcement cascade from EXP360/371.
 * Recency-bias prevention reuses this verbatim (DRY).
 *
 * L0 (natural) — normal CRITICAL CONTEXT injection.
 * L1 (re-injection) — re-inject with SECOND NOTICE.
 * L2 (direct answer) — inject the answer directly into the user message.
 * L3 (structured) — force a JSON response with the fact pre-filled.
 * L4 (bypass) — bypass the LLM; return the memory fact directly.
 */
export type EnforcementLevel = 0 | 1 | 2 | 3 | 4;

/**
 * The highest enforcement level the cascade escalates to BEFORE switching to
 * L4 (bypass). Derived from the {@link EnforcementLevel} union (levels 0–3
 * are escalating injections; 4 is the bypass-only terminal). Named (not a
 * bare `3` literal) so the cap is self-documenting + tied to the type (rule
 * 56: no magic numbers). This is a safety invariant — the level structure is
 * fixed by design (the injection messages are per-level), so it lives here
 * (the safety module), not in the config file (: safety invariants
 * belong in the module or `root-policy.ts`).
 */
const MAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS = 3 as EnforcementLevel;

export type EnforcementState = Readonly<{
  level: EnforcementLevel;
  consecutiveFails: number;
  bypassArmed: boolean;
}>;

export type MemoryTrustCascade = Readonly<{
  /** Apply one step of the cascade. Returns the injection + new state. */
  step(fact: MemoryFact, attempt: Readonly<{ correct: boolean }>): Readonly<{
    injection: string;
    state: EnforcementState;
    bypassed: boolean;
  }>;
  /** Current state. */
  state(): EnforcementState;
}>;

export type BiasPreventer = Readonly<{
  /** Wrap a search call: returns the original call + any paired `against` call. */
  wrapSearch(event: SearchEvent): PreventionAction | null;
  /** After N turns, emit a from-scratch re-evaluation prompt. */
  planAnchoringReevaluation(currentTurn: number, lastReevaluationTurn: number): PreventionAction | null;
  /** After an answer, emit a coverage prompt for any missing relevant files. */
  planCoveragePrompt(hypothesisId: string, readFiles: readonly string[]): PreventionAction | null;
  /** Build a memory-trust cascade for a fact (reuses EXP360/371). */
  buildMemoryTrustCascade(): MemoryTrustCascade;
  /** Build a relevance-first retrieval plan (TF-IDF + Ebbinghaus). */
  planRelevanceRetrieval(query: string, memoryFacts: readonly MemoryFact[]): PreventionAction | null;
  /** Emit codebase-pattern hints before a code suggestion. */
  planPatternHint(hypothesisId: string, filePath: string): PreventionAction | null;
  /** Emit a reindex-or-document action for incomplete coverage. */
  planReindexOrDocument(indexedCount: number, totalCount: number, strategyDocumented: boolean): PreventionAction | null;
  /** Emit context annotations for metric findings. */
  planMetricContext(findings: readonly { functionId: string; metricName: string; value: number; context: string }[]): PreventionAction | null;
  /** Produce a full prevention plan from a detection report. */
  planFromReport(report: BiasDetectionReport): PreventionPlan;
}>;

export type BiasPreventerOptions = Readonly<{
  config: BiasConfig;
  awareness: RepositoryAwareness | undefined;
}>;

function negateQuery(query: string): string {
  // Simple deterministic negation: prefix with "NOT " or "evidence against".
  // This is intentionally shallow — the harness's job is to force the
  // *paired* search, not to craft the perfect negation.
  const trimmed = query.trim();
  if (/^(find|search|grep|show|list)\s+/i.test(trimmed)) {
    return trimmed.replace(/^(\w+)\s+/i, "$1 contradicting ");
  }
  return `evidence against: ${trimmed}`;
}

export function createBiasPreventer(options: BiasPreventerOptions): BiasPreventer {
  const cfg = options.config;
  const awareness = options.awareness;

  function wrapSearch(event: SearchEvent): PreventionAction | null {
    if (!cfg.biases.confirmation.enabled) return null;
    if (event.stance !== "for") return null;
    const pairedQuery = negateQuery(event.query);
    return {
      type: "paired-search",
      bias: "confirmation",
      turn: event.turn,
      injection: `Paired contradicting-evidence search: ${pairedQuery}`,
      toolCall: {
        tool: "search_code",
        args: {
          query: pairedQuery,
          stance: "against",
          hypothesisId: event.hypothesisId,
        },
      },
    };
  }

  function planAnchoringReevaluation(
    currentTurn: number,
    lastReevaluationTurn: number,
  ): PreventionAction | null {
    if (!cfg.biases.anchoring.enabled) return null;
    const interval = cfg.anchoringReevaluationInterval;
    if (currentTurn - lastReevaluationTurn < interval) return null;
    return {
      type: "reevaluation",
      bias: "anchoring",
      turn: currentTurn,
      injection:
        "Re-evaluate your answer from scratch. Ignore your prior answers in this conversation; consider only the original task + the current evidence.",
      toolCall: null,
    };
  }

  function planCoveragePrompt(
    hypothesisId: string,
    readFiles: readonly string[],
  ): PreventionAction | null {
    if (!cfg.biases.selection.enabled) return null;
    if (!awareness) return null;
    const relevant = awareness.relevantFilesForHypothesis(hypothesisId);
    const readSet = new Set(readFiles);
    const missing = relevant.filter((p) => !readSet.has(p));
    if (missing.length === 0) return null;
    return {
      type: "coverage-prompt",
      bias: "selection",
      turn: 0,
      injection: `Before finalizing your answer, read the ${missing.length} relevant file(s) you have not yet examined: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}. They may contain contradicting evidence.`,
      toolCall: null,
    };
  }

  function buildMemoryTrustCascade(): MemoryTrustCascade {
    let state: EnforcementState = {
      level: 0,
      consecutiveFails: 0,
      bypassArmed: false,
    };
    return {
      state: () => state,
      step: (fact, attempt) => {
        let level: EnforcementLevel = state.level;
        let consecutiveFails = state.consecutiveFails;
        let bypassed = false;
        if (attempt.correct) {
          // Reset on success.
          level = 0;
          consecutiveFails = 0;
        } else if (state.consecutiveFails >= cfg.recencyEnforcement.bypassAfterFails) {
          // Already had `bypassAfterFails` fails at the start of this step — bypass now.
          // (EXP360/371: "if the LLM has already failed N consecutive times,
          // the harness answers for it.")
          level = 4;
          bypassed = true;
          consecutiveFails = state.consecutiveFails + 1;
        } else {
          consecutiveFails = state.consecutiveFails + 1;
          // Escalate L0 → L1 → L2 → L3 (L4 is bypass-only, handled above).
          level = Math.min(MAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS, state.level + 1) as EnforcementLevel;
        }
        const bypassArmed = consecutiveFails >= cfg.recencyEnforcement.bypassAfterFails;
        let injection: string;
        if (level === 0) {
          injection = `===== [CRITICAL CONTEXT — DO NOT IGNORE] =====\n${fact.content}`;
        } else if (level === 1) {
          injection = `SECOND NOTICE — your previous response did NOT use these facts:\n${fact.content}`;
        } else if (level === 2) {
          injection = `The correct answer is: ${fact.content}`;
        } else if (level === 3) {
          injection = `Respond as JSON: {"answer": "${fact.content}", "source": "memory"}`;
        } else {
          injection = `From memory: ${fact.content}`;
          bypassed = true;
        }
        state = { level, consecutiveFails, bypassArmed };
        return { injection, state, bypassed };
      },
    };
  }

  function planRelevanceRetrieval(
    query: string,
    memoryFacts: readonly MemoryFact[],
  ): PreventionAction | null {
    if (!cfg.biases.availability.enabled) return null;
    if (memoryFacts.length === 0) return null;
    const qTokens = tokenizeForBias(query);
    const qSet = new Set(qTokens);
    // Score = relevance (Jaccard with query) × retention (Ebbinghaus). NOT recency.
    const scored = memoryFacts.map((f) => {
      let inter = 0;
      for (const t of f.tokens) if (qSet.has(t)) inter += 1;
      const j = f.tokens.length === 0 ? 0 : inter / (qSet.size + f.tokens.length - inter || 1);
      return { f, score: j * Math.max(cfg.retentionScoreFloor, f.retention) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, cfg.availabilityTopK);
    if (top.length === 0) return null;
    const injection = `Top-${cfg.availabilityTopK} most-relevant memory entries (by TF-IDF × Ebbinghaus retention, NOT recency):\n${top
      .map((t, i) => `  ${i + 1}. [R=${t.f.retention.toFixed(2)}] ${t.f.content}`)
      .join("\n")}`;
    return {
      type: "relevance-retrieval",
      bias: "availability",
      turn: 0,
      injection,
      toolCall: null,
    };
  }

  function planPatternHint(
    _hypothesisId: string,
    filePath: string,
  ): PreventionAction | null {
    if (!cfg.biases.representation.enabled) return null;
    if (!awareness) return null;
    const patterns = awareness.patternsForFile(filePath);
    if (patterns.length === 0) return null;
    return {
      type: "pattern-hint",
      bias: "representation",
      turn: 0,
      injection: `Codebase patterns in scope for ${filePath}: ${patterns.join(", ")}. Use these patterns in your suggestion; do not import a different idiom from training data.`,
      toolCall: null,
    };
  }

  function planReindexOrDocument(
    indexedCount: number,
    totalCount: number,
    strategyDocumented: boolean,
  ): PreventionAction | null {
    if (!cfg.biases.sampling.enabled) return null;
    if (totalCount === 0) return null;
    const coverage = indexedCount / totalCount;
    if (coverage >= cfg.samplingMinCoverage) return null;
    if (cfg.samplingAllowDocumentedStrategy && strategyDocumented) return null;
    return {
      type: "reindex-or-document",
      bias: "sampling",
      turn: 0,
      injection: `Search coverage is ${(coverage * 100).toFixed(0)}% (${indexedCount}/${totalCount}), below the ${cfg.samplingMinCoverage * 100}% minimum. Either reindex the full codebase or document the sampling strategy in the report.`,
      toolCall: null,
    };
  }

  function planMetricContext(
    findings: readonly { functionId: string; metricName: string; value: number; context: string }[],
  ): PreventionAction | null {
    if (!cfg.biases.metric.enabled) return null;
    if (!cfg.metricProvideContext) return null;
    if (findings.length === 0) return null;
    const lines = findings.map(
      (f) => `  ${f.functionId} [${f.metricName}=${f.value}]: ${f.context || "NO CONTEXT — annotate why this metric is what it is."}`,
    );
    return {
      type: "metric-context",
      bias: "metric",
      turn: 0,
      injection: `Metric context annotations:\n${lines.join("\n")}`,
      toolCall: null,
    };
  }

  function planFromReport(report: BiasDetectionReport): PreventionPlan {
    const actions: PreventionAction[] = [];
    const clean: (typeof BIAS_TYPES)[number][] = [];
    for (const t of BIAS_TYPES) {
      const findings = report.byType[t];
      if (findings.length === 0) {
        clean.push(t);
        continue;
      }
      // Synthesize a prevention action for the first finding of each type.
      const first = findings[0]!;
      let action: PreventionAction;
      if (t === "confirmation") {
        action = {
          type: "paired-search",
          bias: t,
          turn: first.turn,
          injection: `Issue a paired contradicting-evidence search for hypothesis ${first.hypothesisId ?? "?"}.`,
          toolCall: null,
        };
      } else if (t === "anchoring") {
        action = {
          type: "reevaluation",
          bias: t,
          turn: first.turn,
          injection: `Force a from-scratch re-evaluation (interval=${cfg.anchoringReevaluationInterval}).`,
          toolCall: null,
        };
      } else if (t === "selection") {
        action = {
          type: "coverage-prompt",
          bias: t,
          turn: first.turn,
          injection: first.recommendation,
          toolCall: null,
        };
      } else if (t === "recency") {
        action = {
          type: "memory-trust-cascade",
          bias: t,
          turn: first.turn,
          injection: first.recommendation,
          toolCall: null,
        };
      } else if (t === "availability") {
        action = {
          type: "relevance-retrieval",
          bias: t,
          turn: first.turn,
          injection: first.recommendation,
          toolCall: null,
        };
      } else if (t === "representation") {
        action = {
          type: "pattern-hint",
          bias: t,
          turn: first.turn,
          injection: first.recommendation,
          toolCall: null,
        };
      } else if (t === "sampling") {
        action = {
          type: "reindex-or-document",
          bias: t,
          turn: first.turn,
          injection: first.recommendation,
          toolCall: null,
        };
      } else {
        action = {
          type: "metric-context",
          bias: t,
          turn: first.turn,
          injection: first.recommendation,
          toolCall: null,
        };
      }
      actions.push(action);
    }
    return { actions, clean };
  }

  return {
    wrapSearch,
    planAnchoringReevaluation,
    planCoveragePrompt,
    buildMemoryTrustCascade,
    planRelevanceRetrieval,
    planPatternHint,
    planReindexOrDocument,
    planMetricContext,
    planFromReport,
  };
}

/**
 * Convenience: build a one-shot detector + preventer + run the search
 * log through both, returning the report + plan. Useful for tests.
 */
export function runBiasAnalysis(events: {
  searches?: readonly SearchEvent[];
  reads?: readonly { turn: number; filePath: string; stance: BiasStance; hypothesisId: string; relevant: boolean }[];
  answers?: readonly {
    turn: number;
    hypothesisId: string;
    content: string;
    similarityToFirstAnswer: number;
    similarityToRecentContext: number;
    similarityToMemoryFacts: number;
    reevaluationForced: boolean;
  }[];
  suggestions?: readonly { turn: number; hypothesisId: string; patterns: readonly string[]; codebasePatterns: readonly string[] }[];
  metrics?: readonly { turn: number; functionId: string; metricName: string; value: number; context: string; falsePositive: boolean }[];
  coverage?: readonly { turn: number; indexedCount: number; totalCount: number; strategyDocumented: boolean; missingSamplePaths: readonly string[] }[];
}, config: BiasConfig, awareness?: RepositoryAwareness, memoryFacts?: readonly MemoryFact[]): {
  detector: BiasDetector;
  report: BiasDetectionReport;
  preventer: BiasPreventer;
  plan: PreventionPlan;
} {
  const detector = createBiasDetector({ config, awareness, memoryFacts });
  for (const s of events.searches ?? []) detector.recordSearch(s);
  for (const r of events.reads ?? []) detector.recordRead(r);
  for (const a of events.answers ?? []) detector.recordAnswer(a);
  for (const s of events.suggestions ?? []) detector.recordCodeSuggestion(s);
  for (const m of events.metrics ?? []) detector.recordMetricFinding(m);
  for (const c of events.coverage ?? []) detector.recordCoverage(c);
  const report = detector.detect();
  const preventer = createBiasPreventer({ config, awareness });
  const plan = preventer.planFromReport(report);
  return { detector, report, preventer, plan };
}

// Re-export the bias-types so consumers of the preventer don't need to
// import from bias-config directly. Avoids a parallel import surface.
export { BIAS_TYPES } from "./bias-config.ts";
export type { BiasType, BiasStance, BiasConfig } from "./bias-config.ts";
export type {
  SearchEvent,
  ReadEvent,
  AnswerEvent,
  CodeSuggestionEvent,
  MetricFindingEvent,
  CoverageEvent,
  MemoryFact,
  RepositoryAwareness,
  BiasFinding,
  BiasDetectionReport,
  BiasDetector,
} from "./bias-detector.ts";
export { createBiasDetector, tokenizeForBias, makeMemoryFact } from "./bias-detector.ts";
