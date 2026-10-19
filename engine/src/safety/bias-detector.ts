import { type BiasConfig, type BiasType, type BiasStance, BIAS_TYPES } from "./bias-config.ts";
import { jaccardArrays } from "../shared/similarity.ts";

/**
 * Bias detector for the LLM-to-machine interface.
 *
 * Records tool calls (searches, reads), answers, code suggestions, metric
 * findings, and coverage reports, then evaluates each of the eight bias
 * types the user named. Detection is deterministic; every threshold comes
 * from `BiasConfig` (no static constants in this file).
 *
 * Bias types:
 * 1. confirmation — LLM only searches for evidence FOR its hypothesis.
 * 2. anchoring — the first answer disproportionately shapes later answers.
 * 3. selection — LLM cherry-picks files supporting its answer.
 * 4. recency — recent context overrides established memory facts (EXP351).
 * 5. availability — easy-to-recall info overrides the most relevant.
 * 6. representation — training-data patterns override the codebase's patterns.
 * 7. sampling — search indexes a subset, missing relevant code.
 * 8. metric — quality metrics flag justified complexity as a defect.
 *
 * Integration points (per the binding directives):
 * - search: `recordSearch` wraps every search/grep call.
 * - memory: recency/availability draw on `MemoryFact` + similarity helpers.
 * - awareness: selection/representation draw on `RepositoryAwareness`.
 * - editor: `recordCodeSuggestion` wraps every edit suggestion.
 */
export type SearchEvent = Readonly<{
  turn: number;
  query: string;
  stance: BiasStance;
  hypothesisId: string;
}>;

export type ReadEvent = Readonly<{
  turn: number;
  filePath: string;
  stance: BiasStance;
  hypothesisId: string;
  /** True if this file is in the awareness-relevant set for the hypothesis. */
  relevant: boolean;
}>;

export type AnswerEvent = Readonly<{
  turn: number;
  hypothesisId: string;
  content: string;
  /** Jaccard similarity to the first answer for the same hypothesis (0-1). */
  similarityToFirstAnswer: number;
  /** Jaccard similarity to the most-recent context (0-1). */
  similarityToRecentContext: number;
  /** Jaccard similarity to the most-aligned established memory fact (0-1). */
  similarityToMemoryFacts: number;
  /** Was a re-evaluation (no prior answers in context) forced this turn? */
  reevaluationForced: boolean;
}>;

export type CodeSuggestionEvent = Readonly<{
  turn: number;
  hypothesisId: string;
  /** Patterns the suggestion uses (e.g. "for-loop", "forEach", "Promise.all"). */
  patterns: readonly string[];
  /** Patterns present in the codebase (from awareness) for this file scope. */
  codebasePatterns: readonly string[];
}>;

export type MetricFindingEvent = Readonly<{
  turn: number;
  functionId: string;
  metricName: string;
  value: number;
  /** Free-text context: WHY is the metric what it is (justification). */
  context: string;
  /** Reviewer label: was this finding a false positive? */
  falsePositive: boolean;
}>;

export type CoverageEvent = Readonly<{
  turn: number;
  indexedCount: number;
  totalCount: number;
  /** If sampling is incomplete, was the strategy documented? */
  strategyDocumented: boolean;
  missingSamplePaths: readonly string[];
}>;

export type MemoryFact = Readonly<{
  id: string;
  content: string;
  /** Ebbinghaus retention R(t) — established-fact strength. */
  retention: number;
  tokens: readonly string[];
}>;

export type RepositoryAwareness = Readonly<{
  /** Set of files relevant to a given hypothesis (e.g. by imports/data flow). */
  relevantFilesForHypothesis: (hypothesisId: string) => readonly string[];
  /** Patterns present in the codebase at a given file scope. */
  patternsForFile: (filePath: string) => readonly string[];
  /** Total files in the codebase. */
  totalFiles: number;
}>;

export type BiasSeverity = "low" | "medium" | "high";

export type BiasFinding = Readonly<{
  type: BiasType;
  turn: number;
  severity: BiasSeverity;
  hypothesisId: string | null;
  evidence: string;
  recommendation: string;
}>;

export type BiasDetectionReport = Readonly<{
  findings: readonly BiasFinding[];
  byType: Readonly<Record<BiasType, readonly BiasFinding[]>>;
  detectedCount: number;
}>;

export type BiasDetector = Readonly<{
  recordSearch(event: SearchEvent): void;
  recordRead(event: ReadEvent): void;
  recordAnswer(event: AnswerEvent): void;
  recordCodeSuggestion(event: CodeSuggestionEvent): void;
  recordMetricFinding(event: MetricFindingEvent): void;
  recordCoverage(event: CoverageEvent): void;
  detect(): BiasDetectionReport;
  /** Return the raw recorded events (for tests + inspection). */
  snapshot(): Readonly<{
    searches: readonly SearchEvent[];
    reads: readonly ReadEvent[];
    answers: readonly AnswerEvent[];
    suggestions: readonly CodeSuggestionEvent[];
    metrics: readonly MetricFindingEvent[];
    coverage: readonly CoverageEvent[];
  }>;
}>;

export type BiasDetectorOptions = Readonly<{
  config: BiasConfig;
  /** Optional awareness provider; when omitted/undefined, selection/representation degrade gracefully. */
  awareness: RepositoryAwareness | undefined;
  /** Optional established memory facts (for recency/availability). */
  memoryFacts: readonly MemoryFact[] | undefined;
}>;

function emptyByType(): Record<BiasType, readonly BiasFinding[]> {
  const acc = {} as Record<BiasType, readonly BiasFinding[]>;
  for (const t of BIAS_TYPES) acc[t] = [];
  return acc;
}

function severityFromRatio(ratio: number): BiasSeverity {
  if (ratio >= 0.75) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}

/**
 * Tokenize a string for Jaccard similarity. Same shape as `memory-search.tokenize`
 * (lowercase, split on non-word); kept local to avoid a cross-module dependency
 * for this experimental package.
 */
export function tokenizeForBias(text: string): readonly string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 0);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  // R44: delegate to the canonical array-Jaccard owner in
  // `src/shared/similarity.ts` (was a private near-duplicate body —
  // "No Scattered Helpers" violation). The shared owner has the same
  // conservative empty-set policy (returns 0 when either array is empty),
  // matching the previous local behavior.
  return jaccardArrays(a, b);
}

export function createBiasDetector(options: BiasDetectorOptions): BiasDetector {
  const cfg = options.config;
  const awareness = options.awareness;
  const memoryFacts = options.memoryFacts ?? [];

  const searches: SearchEvent[] = [];
  const reads: ReadEvent[] = [];
  const answers: AnswerEvent[] = [];
  const suggestions: CodeSuggestionEvent[] = [];
  const metrics: MetricFindingEvent[] = [];
  const coverage: CoverageEvent[] = [];

  function recordSearch(event: SearchEvent): void {
    searches.push(event);
  }
  function recordRead(event: ReadEvent): void {
    reads.push(event);
  }
  function recordAnswer(event: AnswerEvent): void {
    answers.push(event);
  }
  function recordCodeSuggestion(event: CodeSuggestionEvent): void {
    suggestions.push(event);
  }
  function recordMetricFinding(event: MetricFindingEvent): void {
    metrics.push(event);
  }
  function recordCoverage(event: CoverageEvent): void {
    coverage.push(event);
  }

  function detectConfirmation(): BiasFinding[] {
    const bias = cfg.biases.confirmation;
    if (!bias.enabled) return [];
    const byHyp = new Map<string, { forCount: number; againstCount: number; lastTurn: number }>();
    for (const s of searches) {
      let entry = byHyp.get(s.hypothesisId);
      if (!entry) {
        entry = { forCount: 0, againstCount: 0, lastTurn: s.turn };
        byHyp.set(s.hypothesisId, entry);
      }
      if (s.stance === "for") entry.forCount += 1;
      else if (s.stance === "against") entry.againstCount += 1;
      entry.lastTurn = Math.max(entry.lastTurn, s.turn);
    }
    const out: BiasFinding[] = [];
    for (const [hypId, e] of byHyp) {
      const total = e.forCount + e.againstCount;
      if (total < bias.minEvents) continue;
      const meetsAgainst = e.againstCount >= cfg.confirmationMinAgainstSearches;
      const ratio = e.againstCount === 0 ? Infinity : e.forCount / e.againstCount;
      if (meetsAgainst && ratio <= cfg.confirmationMaxForAgainstRatio) continue;
      const severity: BiasSeverity = e.againstCount === 0 ? "high" : severityFromRatio(Math.min(1, ratio / (cfg.confirmationMaxForAgainstRatio * 2)));
      out.push({
        type: "confirmation",
        turn: e.lastTurn,
        severity,
        hypothesisId: hypId,
        evidence: `${e.forCount} for vs ${e.againstCount} against searches (ratio ${isFinite(ratio) ? ratio.toFixed(2) : "inf"})`,
        recommendation: "Force a contradicting-evidence search for every supporting search.",
      });
    }
    return out;
  }

  function detectAnchoring(): BiasFinding[] {
    const bias = cfg.biases.anchoring;
    if (!bias.enabled) return [];
    const byHyp = new Map<string, AnswerEvent[]>();
    for (const a of answers) {
      let arr = byHyp.get(a.hypothesisId);
      if (!arr) {
        arr = [];
        byHyp.set(a.hypothesisId, arr);
      }
      arr.push(a);
    }
    const out: BiasFinding[] = [];
    for (const [hypId, arr] of byHyp) {
      if (arr.length < bias.minEvents) continue;
      const first = arr[0];
      if (first === undefined) continue;
      // Find answers AFTER a turn where new contradicting evidence arrived.
      // "Contradicting evidence" = either the recent context shifted (similarity
      // dropped by > 0.2 OR is now below 0.3) OR established memory contradicts
      // the answer (similarity to memory facts is below the recency floor).
      // The memory-contradicts signal lets anchoring + recency fire on the
      // SAME answer (anchoring = stuck on first answer; recency = aligned
      // with recent over memory) — both legitimate bias views.
      let prevRecent = first.similarityToRecentContext;
      for (let i = 1; i < arr.length; i += 1) {
        const cur = arr[i]!;
        const contextShifted =
          Math.abs(cur.similarityToRecentContext - prevRecent) > 0.2 ||
          cur.similarityToRecentContext < 0.3;
        const memoryContradicts = cur.similarityToMemoryFacts < cfg.recencyMinMemoryAlignment;
        const contradictingEvidence = contextShifted || memoryContradicts;
        if (contradictingEvidence && !cur.reevaluationForced &&
            cur.similarityToFirstAnswer >= cfg.anchoringConvergenceSimilarity) {
          const ratio = cur.similarityToFirstAnswer;
          out.push({
            type: "anchoring",
            turn: cur.turn,
            severity: severityFromRatio(ratio),
            hypothesisId: hypId,
            evidence: `answer@turn${cur.turn} converged to first answer (sim ${ratio.toFixed(2)}) despite shifted context`,
            recommendation: `Force a from-scratch re-evaluation (interval=${cfg.anchoringReevaluationInterval}).`,
          });
        }
        prevRecent = cur.similarityToRecentContext;
      }
    }
    return out;
  }

  function detectSelection(): BiasFinding[] {
    const bias = cfg.biases.selection;
    if (!bias.enabled) return [];
    if (!awareness) return [];
    const byHyp = new Map<string, { read: Set<string>; supporting: number; contradicting: number; lastTurn: number }>();
    for (const r of reads) {
      if (!r.relevant) continue;
      let entry = byHyp.get(r.hypothesisId);
      if (!entry) {
        entry = { read: new Set(), supporting: 0, contradicting: 0, lastTurn: r.turn };
        byHyp.set(r.hypothesisId, entry);
      }
      entry.read.add(r.filePath);
      if (r.stance === "for") entry.supporting += 1;
      else if (r.stance === "against") entry.contradicting += 1;
      entry.lastTurn = Math.max(entry.lastTurn, r.turn);
    }
    const out: BiasFinding[] = [];
    for (const [hypId, e] of byHyp) {
      const relevant = awareness.relevantFilesForHypothesis(hypId);
      const total = relevant.length;
      if (total < bias.minEvents) continue;
      const coverage = e.read.size / total;
      const ratio = e.contradicting === 0 ? Infinity : e.supporting / e.contradicting;
      const lowCoverage = coverage < cfg.selectionCoverageMinimum;
      const imbalanced = e.contradicting === 0 || ratio > cfg.selectionMaxSupportingContradictingRatio;
      if (!lowCoverage && !imbalanced) continue;
      const missing = relevant.filter((p) => !e.read.has(p));
      const severity: BiasSeverity = lowCoverage
        ? severityFromRatio(1 - coverage)
        : severityFromRatio(Math.min(1, (isFinite(ratio) ? ratio : 10) / (cfg.selectionMaxSupportingContradictingRatio * 2)));
      out.push({
        type: "selection",
        turn: e.lastTurn,
        severity,
        hypothesisId: hypId,
        evidence: `read ${e.read.size}/${total} relevant files (${e.supporting} supporting, ${e.contradicting} contradicting); missing ${missing.length}`,
        recommendation: `Read missing relevant files: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
      });
    }
    return out;
  }

  function detectRecency(): BiasFinding[] {
    const bias = cfg.biases.recency;
    if (!bias.enabled) return [];
    if (answers.length < bias.minEvents) return [];
    if (memoryFacts.length === 0) return [];
    const out: BiasFinding[] = [];
    for (const a of answers) {
      // Recency bias: answer aligns with recent context but contradicts memory facts.
      const alignsRecent = a.similarityToRecentContext >= cfg.recencyMaxRecentAlignment;
      const alignsMemory = a.similarityToMemoryFacts >= cfg.recencyMinMemoryAlignment;
      if (alignsRecent && !alignsMemory) {
        const ratio = a.similarityToRecentContext - a.similarityToMemoryFacts;
        out.push({
          type: "recency",
          turn: a.turn,
          severity: severityFromRatio(Math.max(0, Math.min(1, ratio))),
          hypothesisId: a.hypothesisId,
          evidence: `answer@turn${a.turn} aligns with recent (sim ${a.similarityToRecentContext.toFixed(2)}) but not memory (sim ${a.similarityToMemoryFacts.toFixed(2)})`,
          recommendation: "Re-inject established memory facts as authoritative system context (EXP360/371 cascade).",
        });
      }
    }
    return out;
  }

  function detectAvailability(): BiasFinding[] {
    const bias = cfg.biases.availability;
    if (!bias.enabled) return [];
    if (answers.length < bias.minEvents) return [];
    if (memoryFacts.length === 0) return [];
    const out: BiasFinding[] = [];
    for (const a of answers) {
      // Availability bias: answer uses easily-recalled (recent/common) info, not the
      // most-relevant. We approximate "most relevant" by the top-K highest-retention
      // memory facts. If the answer's overlap with the top-K is below the configured
      // coverage threshold, flag.
      const sortedFacts = [...memoryFacts].sort((x, y) => y.retention - x.retention);
      const topK = sortedFacts.slice(0, cfg.availabilityTopK);
      const topKTokens = new Set<string>();
      for (const f of topK) for (const t of f.tokens) topKTokens.add(t);
      const answerTokens = tokenizeForBias(a.content);
      let inter = 0;
      for (const t of answerTokens) if (topKTokens.has(t)) inter += 1;
      const coverage = answerTokens.length === 0 ? 0 : inter / answerTokens.length;
      if (coverage < cfg.availabilityMinRelevantCoverage) {
        out.push({
          type: "availability",
          turn: a.turn,
          severity: severityFromRatio(1 - coverage),
          hypothesisId: a.hypothesisId,
          evidence: `answer@turn${a.turn} reflects ${(coverage * 100).toFixed(0)}% of top-${cfg.availabilityTopK} most-relevant memory (min ${cfg.availabilityMinRelevantCoverage})`,
          recommendation: "Retrieve memory by TF-IDF + Ebbinghaus retention, not recency.",
        });
      }
    }
    return out;
  }

  function detectRepresentation(): BiasFinding[] {
    const bias = cfg.biases.representation;
    if (!bias.enabled) return [];
    if (suggestions.length < bias.minEvents) return [];
    if (!awareness) return [];
    const out: BiasFinding[] = [];
    for (const s of suggestions) {
      if (s.patterns.length === 0) continue;
      const codebaseSet = new Set(s.codebasePatterns);
      if (codebaseSet.size === 0) continue;
      let matched = 0;
      for (const p of s.patterns) if (codebaseSet.has(p)) matched += 1;
      const match = matched / s.patterns.length;
      if (match < cfg.representationMinPatternMatch) {
        const diverging = s.patterns.filter((p) => !codebaseSet.has(p));
        out.push({
          type: "representation",
          turn: s.turn,
          severity: severityFromRatio(1 - match),
          hypothesisId: s.hypothesisId,
          evidence: `suggestion@turn${s.turn} matches ${(match * 100).toFixed(0)}% of codebase patterns; diverges on ${diverging.join(", ")}`,
          recommendation: `Use codebase-existing patterns: ${[...codebaseSet].slice(0, 5).join(", ")}`,
        });
      }
    }
    return out;
  }

  function detectSampling(): BiasFinding[] {
    const bias = cfg.biases.sampling;
    if (!bias.enabled) return [];
    const out: BiasFinding[] = [];
    for (const c of coverage) {
      if (c.totalCount === 0) continue;
      const coverageRatio = c.indexedCount / c.totalCount;
      if (coverageRatio >= cfg.samplingMinCoverage) continue;
      if (cfg.samplingAllowDocumentedStrategy && c.strategyDocumented) continue;
      const missing = c.totalCount - c.indexedCount;
      out.push({
        type: "sampling",
        turn: c.turn,
        severity: severityFromRatio(1 - coverageRatio),
        hypothesisId: null,
        evidence: `search indexed ${c.indexedCount}/${c.totalCount} (${(coverageRatio * 100).toFixed(0)}%); missing ${missing} files`,
        recommendation: c.strategyDocumented
          ? "Sampling strategy documented but coverage still below threshold; widen the sample."
          : "Either index the full codebase or document the sampling strategy in the report.",
      });
    }
    return out;
  }

  function detectMetric(): BiasFinding[] {
    const bias = cfg.biases.metric;
    if (!bias.enabled) return [];
    if (metrics.length < bias.minEvents) return [];
    const byMetric = new Map<string, { total: number; fp: number; contextless: number; lastTurn: number }>();
    for (const m of metrics) {
      let entry = byMetric.get(m.metricName);
      if (!entry) {
        entry = { total: 0, fp: 0, contextless: 0, lastTurn: m.turn };
        byMetric.set(m.metricName, entry);
      }
      entry.total += 1;
      if (m.falsePositive) entry.fp += 1;
      if (m.context.trim().length === 0) entry.contextless += 1;
      entry.lastTurn = Math.max(entry.lastTurn, m.turn);
    }
    const out: BiasFinding[] = [];
    for (const [name, e] of byMetric) {
      if (e.total === 0) continue;
      const fpRate = e.fp / e.total;
      const biased = fpRate > cfg.metricMaxFalsePositiveRate;
      const missingContext = e.contextless > 0 && cfg.metricProvideContext;
      if (!biased && !missingContext) continue;
      const severity: BiasSeverity = biased
        ? severityFromRatio(fpRate)
        : "low";
      out.push({
        type: "metric",
        turn: e.lastTurn,
        severity,
        hypothesisId: null,
        evidence: `metric "${name}" produced ${e.fp}/${e.total} false positives (${(fpRate * 100).toFixed(0)}% FP)${e.contextless > 0 ? `; ${e.contextless} findings lack context` : ""}`,
        recommendation: cfg.metricProvideContext
          ? "Annotate each metric finding with context (WHY the value is what it is)."
          : "Tighten the metric threshold or replace the metric.",
      });
    }
    return out;
  }

  function detect(): BiasDetectionReport {
    const detectors: Record<BiasType, () => BiasFinding[]> = {
      confirmation: detectConfirmation,
      anchoring: detectAnchoring,
      selection: detectSelection,
      recency: detectRecency,
      availability: detectAvailability,
      representation: detectRepresentation,
      sampling: detectSampling,
      metric: detectMetric,
    };
    const byType = emptyByType();
    const all: BiasFinding[] = [];
    for (const t of BIAS_TYPES) {
      const fs = detectors[t]();
      byType[t] = fs;
      for (const f of fs) all.push(f);
    }
    all.sort((a, b) => a.turn - b.turn);
    return { findings: all, byType: deepFreezeReport(byType), detectedCount: all.length };
  }

  function snapshot() {
    return {
      searches: [...searches],
      reads: [...reads],
      answers: [...answers],
      suggestions: [...suggestions],
      metrics: [...metrics],
      coverage: [...coverage],
    };
  }

  return {
    recordSearch,
    recordRead,
    recordAnswer,
    recordCodeSuggestion,
    recordMetricFinding,
    recordCoverage,
    detect,
    snapshot,
  };
}

/**
 * Helper exported for tests and downstream consumers: compute a Jaccard
 * similarity between two texts using the detector's tokenizer. Pure.
 */
export function biasJaccard(a: string, b: string): number {
  return jaccard(tokenizeForBias(a), tokenizeForBias(b));
}

/**
 * Helper for tests: build a `MemoryFact` from raw text. Retention defaults
 * to 1.0 (full strength); tests can vary it.
 */
export function makeMemoryFact(id: string, content: string, retention = 1): MemoryFact {
  return { id, content, retention, tokens: tokenizeForBias(content) };
}

function deepFreezeReport(byType: Record<BiasType, readonly BiasFinding[]>): Readonly<Record<BiasType, readonly BiasFinding[]>> {
  const frozen = {} as Record<BiasType, readonly BiasFinding[]>;
  for (const t of BIAS_TYPES) frozen[t] = Object.freeze([...byType[t]]);
  return Object.freeze(frozen);
}
