import { type BandaidConfig, type BandaidSeverity } from "./bandaid-config.ts";

/**
 * Goal-deviation detector — the LLM starts working on something other than
 * the original task.
 *
 * Related to the EXP360/371 drift detector, but compares the WORK performed
 * each turn (files touched, searches, edit descriptions) to the original
 * TASK, not the conversation TOPIC. Where EXP360/371 asks "did the
 * conversation drift off-topic?", this detector asks "did the LLM start
 * working on function Y when the task was to refactor function X?".
 *
 * Mechanism (mirrors EXP360/371's TF-IDF cosine-similarity shape, applied to
 * work not topic):
 * - The original task is tokenized once → a TF-IDF reference vector with
 * corpus DF = the set of all work tokens across all turns (so rare
 * task-specific tokens like the function name dominate the similarity).
 * - Each turn's work (a rolling window of the last `deviationWindowSize`
 * turns) is tokenized → a TF-IDF vector compared to the task vector via
 * cosine similarity.
 * - If sim < `deviationMinTaskSimilarity` and at least
 * `deviationMinTurnsBeforeDeviation` turns have elapsed, deviation
 * DETECTED. Consecutive deviations escalate to "persistent" after
 * `deviationPersistentThreshold` (mirrors the EXP360/371 correction
 * cascade shape).
 *
 * Every threshold comes from `BandaidConfig`.
 *
 * Integration: `setOriginalTask` is called once at the start of the task;
 * `recordWork` is called each turn. The detector produces a
 * `DeviationFinding[]` that feeds the investigation stage.
 */
export type WorkEvent = Readonly<{
  turn: number;
  /** Free-text description of the work this turn (edit summary, search query, etc.). */
  description: string;
  /** Files touched this turn (paths). */
  filesTouched: readonly string[];
  /** Search queries issued this turn. */
  searches: readonly string[];
}>;

export type DeviationFinding = Readonly<{
  family: "deviation";
  turn: number;
  severity: BandaidSeverity;
  /** Cosine similarity of the work vector to the task vector. */
  similarity: number;
  /** True when this is the `deviationPersistentThreshold`-th consecutive deviation. */
  persistent: boolean;
  evidence: string;
  recommendation: string;
}>;

export type DeviationDetectionReport = Readonly<{
  findings: readonly DeviationFinding[];
  detectedCount: number;
  /** True when the deviation became persistent (escalation signal). */
  persistent: boolean;
}>;

export type DeviationDetector = Readonly<{
  setOriginalTask(taskDescription: string): void;
  recordWork(event: WorkEvent): void;
  detect(): DeviationDetectionReport;
  snapshot(): Readonly<{ task: string; work: readonly WorkEvent[] }>;
}>;

export type DeviationDetectorOptions = Readonly<{ config: BandaidConfig }>;

/**
 * EXP432 (2026-07-21): the static `STOPWORDS` SOURCE CONSTANT is REMOVED.
 * The user directive ("static values like that are prohibited app-wide")
 * rejected hardcoded keyword lists in source. Two keyword-free mechanisms
 * replace it:
 *
 * 1. CONFIG stopwords: `BandaidConfig.deviationStopwords` (a CONFIGURABLE,
 * not a source constant). The default is the English closed-class words
 * (a linguistic fact, like lowercasing — override or empty it to rely
 * on the dynamic removal alone).
 * 2. DYNAMIC stopword removal: a token with df > N/2 in the work corpus
 * gets ZERO weight (it appears in more than half the work turns → no
 * task-distinctive signal for THIS corpus). This is computed per-corpus
 * from the work turns — adapts to any language/vocabulary.
 *
 * The two mechanisms compose: config stopwords remove the universal
 * closed-class words; dynamic removal catches corpus-specific frequent
 * words. Neither is a hardcoded SOURCE constant.
 */
function tokenize(text: string, stopwords: ReadonlySet<string>): readonly string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 0 && !stopwords.has(t));
}

/**
 * Compute the document-frequency map across all work turns (the "corpus" for
 * TF-IDF). Each unique token across all work descriptions + files + searches
 * contributes its DF. The task tokens that never appear in the work corpus
 * get DF = 0 (handled as a floor of 1 to avoid div-by-zero; they will have
 * the highest IDF).
 */
function computeDf(workTokens: readonly (readonly string[])[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of workTokens) {
    const seen = new Set<string>();
    for (const t of doc) {
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  return df;
}

/**
 * TF-IDF vector. TF = token count in the doc; IDF = ln((1 + N) / (1 + df)) + 1
 * (smooth IDF, sklearn-style). Returns a Map for cosine-similarity-friendly
 * intersection.
 *
 * EXP432 dynamic-stopword removal (keyword-free): a token that appears in
 * MORE THAN HALF of the work turns (df > N/2) AND is NOT in the task is a
 * "corpus stopword" — it carries no task-distinctive signal (it's a word
 * the LLM uses in every turn regardless of the task). We give it ZERO
 * weight. Words that ARE in the task are PRESERVED (a task word that
 * appears in most work turns is ON-TOPIC, not a stopword — zeroing it
 * would cause false-deviation on on-task work). This is computed
 * per-corpus from the work turns + the task — no static English list.
 */
function tfidfVector(
  doc: readonly string[],
  df: Map<string, number>,
  n: number,
  taskTokenSet: ReadonlySet<string>,
): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of doc) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const vec = new Map<string, number>();
  const idfDenom = 1 + n;
  const dynamicStopwordThreshold = n / 2;
  for (const [tok, count] of tf) {
    const dfVal = df.get(tok) ?? 0;
    if (n > 1 && dfVal > dynamicStopwordThreshold && !taskTokenSet.has(tok)) {
      // Dynamic stopword: frequent in the work corpus AND not in the task
      // → no task-distinctive signal → zero weight.
      continue;
    }
    const idf = Math.log(idfDenom / (1 + dfVal)) + 1;
    vec.set(tok, count * idf);
  }
  return vec;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== undefined) dot += v * w;
  }
  let normA = 0;
  for (const v of a.values()) normA += v * v;
  let normB = 0;
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createDeviationDetector(options: DeviationDetectorOptions): DeviationDetector {
  const cfg = options.config;
  const stopwords = new Set<string>(cfg.deviationStopwords);
  let task = "";
  let taskTokens: readonly string[] = [];
  const work: WorkEvent[] = [];

  function setOriginalTask(taskDescription: string): void {
    task = taskDescription;
    taskTokens = tokenize(taskDescription, stopwords);
  }

  function recordWork(event: WorkEvent): void {
    work.push(event);
  }

  function detect(): DeviationDetectionReport {
    const family = cfg.families.deviation;
    if (!family.enabled) return { findings: [], detectedCount: 0, persistent: false };
    if (work.length < family.minEvents) return { findings: [], detectedCount: 0, persistent: false };
    if (taskTokens.length === 0) return { findings: [], detectedCount: 0, persistent: false };

    // Build the work corpus tokens (one doc per turn = description + files + searches).
    const perTurnTokens: (readonly string[])[] = work.map((w) =>
      tokenize([w.description, ...w.filesTouched, ...w.searches].join(" "), stopwords),
    );
    const df = computeDf(perTurnTokens);
    const n = perTurnTokens.length;
    const taskTokenSet = new Set<string>(taskTokens);
    const taskVec = tfidfVector(taskTokens, df, n, taskTokenSet);

    const findings: DeviationFinding[] = [];
    let consecutive = 0;
    let persistent = false;

    // Rolling window of the last `deviationWindowSize` turns. For each turn
    // from the start, compute the windowed work vector and compare to the task.
    for (let end = 1; end <= work.length; end += 1) {
      const start = Math.max(0, end - cfg.deviationWindowSize);
      const windowTokens: string[] = [];
      for (let i = start; i < end; i += 1) {
        const tt = perTurnTokens[i];
        if (tt) windowTokens.push(...tt);
      }
      const windowVec = tfidfVector(windowTokens, df, n, taskTokenSet);
      const sim = cosine(taskVec, windowVec);
      const turn = work[end - 1]?.turn ?? end;
      const elapsed = end; // 1-indexed count of recorded work events

      if (sim < cfg.deviationMinTaskSimilarity && elapsed >= cfg.deviationMinTurnsBeforeDeviation) {
        consecutive += 1;
        const isPersistent = consecutive >= cfg.deviationPersistentThreshold;
        if (isPersistent) persistent = true;
        const severity: BandaidSeverity = isPersistent ? "high" : sim < cfg.deviationMinTaskSimilarity / 2 ? "medium" : "low";
        findings.push({
          family: "deviation",
          turn,
          severity,
          similarity: sim,
          persistent: isPersistent,
          evidence:
            `Work at turn ${turn} (sim ${sim.toFixed(3)} < ${cfg.deviationMinTaskSimilarity}) does not match the original task. ` +
            `Window: turns ${start + 1}-${end}; consecutive deviations: ${consecutive}.`,
          recommendation: isPersistent
            ? `Persistent deviation from the original task. Return to "${task}" or pause and ask the user if the task is impossible.`
            : `Work deviates from the original task "${task}". Either return to the task or document why the deviation is legitimate.`,
        });
      } else {
        consecutive = 0;
      }
    }

    return { findings, detectedCount: findings.length, persistent };
  }

  function snapshot(): Readonly<{ task: string; work: readonly WorkEvent[] }> {
    return { task, work };
  }

  return { setOriginalTask, recordWork, detect, snapshot };
}
