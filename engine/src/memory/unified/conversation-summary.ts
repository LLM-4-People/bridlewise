/**
 * Deterministic hierarchical conversation summary (from EXP435).
 *
 * Replaces C16 (evict-to-0%) with C09 (preserve continuity) — the LLM
 * keeps a 200-token summary of the conversation FLOW at all times.
 *
 * DESIGN:
 * 1. Record one (turn, topic) pair per turn. Topic = short keyword
 * extracted deterministically (NOT LLM-based).
 * 2. Build a hierarchical block capped at `tokenBudget`:
 * Level 0 (recent): last 10 turns, 1 line each.
 * Level 1 (medium): every 10th turn in last 100.
 * Level 2 (old): every 100th turn in last 1000.
 * Level 3 (ancient): every 1000th turn in all history.
 * 3. Block rebuilt every turn (deterministic, no LLM call) and
 * injected as a "summary" message kind (always in context).
 *
 * Recent-first: when the block exceeds the budget, ancient levels are
 * truncated first; the recent level is always included.
 */
import { estimateTokens, tokenize } from "./tokenizer.ts";
import { InputError } from "../../kernel/errors.ts";

export type SummaryConfig = Readonly<{
  /** Token budget for the summary block (default 200). */
  tokenBudget: number;
  /** Lines per level: [1, 10, 100, 1000] = recent/medium/old/ancient. */
  levelSteps: readonly number[];
  /** Max chars for a topic (kept short to pack lines). */
  maxTopicChars: number;
  /** Max chars for the main topic header. */
  maxMainTopicChars: number;
}>;

const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  tokenBudget: 200,
  levelSteps: [1, 10, 100, 1000],
  maxTopicChars: 24,
  maxMainTopicChars: 40,
};

export interface SummaryEntry {
  readonly turn: number;
  readonly topic: string;
}

export class ConversationSummary {
  private readonly entries: SummaryEntry[] = [];
  private readonly turnIndex: Map<number, number> = new Map();
  private sorted = true;
  private readonly config: SummaryConfig;
  private mainTopic = "";

  constructor(config: Partial<SummaryConfig> = {}) {
    this.config = {
      tokenBudget: config.tokenBudget ?? DEFAULT_SUMMARY_CONFIG.tokenBudget,
      levelSteps: config.levelSteps ?? DEFAULT_SUMMARY_CONFIG.levelSteps,
      maxTopicChars: config.maxTopicChars ?? DEFAULT_SUMMARY_CONFIG.maxTopicChars,
      maxMainTopicChars: config.maxMainTopicChars ?? DEFAULT_SUMMARY_CONFIG.maxMainTopicChars,
    };
    if (this.config.tokenBudget < 32 || !Number.isFinite(this.config.tokenBudget)) {
      throw new InputError("summary.tokenBudget must be >= 32 and finite");
    }
    if (this.config.levelSteps.length === 0) {
      throw new InputError("summary.levelSteps must have at least one level");
    }
  }

  get config_(): SummaryConfig {
    return this.config;
  }

  setMainTopic(topic: string): void {
    this.mainTopic = topic.slice(0, this.config.maxMainTopicChars);
  }

  recordTurn(turn: number, topic: string): void {
    const cleanTopic = topic.slice(0, this.config.maxTopicChars).replace(/\s+/g, "_").toLowerCase();
    const existingIdx = this.turnIndex.get(turn);
    if (existingIdx !== undefined) {
      (this.entries as Array<{ turn: number; topic: string }>)[existingIdx]!.topic = cleanTopic;
      return;
    }
    // Append in O(1) when turns arrive in increasing order (the common case
    // for both production conversations and the probe regression tests).
    // Out-of-order turns are appended + marked unsorted; the array is
    // sorted lazily on the next ordered read (buildBlock). This collapses
    // the previous O(n^2 log n) findIndex + full-sort-per-call into O(n)
    // total for the in-order case.
    if (this.sorted && (this.entries.length === 0 || turn > this.entries[this.entries.length - 1]!.turn)) {
      this.turnIndex.set(turn, this.entries.length);
      (this.entries as Array<{ turn: number; topic: string }>).push({ turn, topic: cleanTopic });
    } else {
      this.sorted = false;
      this.turnIndex.set(turn, this.entries.length);
      (this.entries as Array<{ turn: number; topic: string }>).push({ turn, topic: cleanTopic });
    }
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * Build the hierarchical summary block capped at `tokenBudget` tokens.
   * Lines are packed multiple-per-line to save tokens.
   */
  buildBlock(): string {
    if (this.entries.length === 0) return "";
    this.ensureSorted();
    const maxTurn = this.entries[this.entries.length - 1]!.turn;
    const lines: string[] = [];
    const mainTopicStr = this.mainTopic ? ` — main: ${this.mainTopic}` : "";
    lines.push(`[CONVERSATION SUMMARY — T1..T${maxTurn} — ${this.entries.length} turns${mainTopicStr}]`);

    // Build hierarchical levels, RECENT FIRST (most recent at top, ancient
    // at bottom). Truncate ancient levels first when budget exceeded.
    const levels = this.config.levelSteps;
    const levelLines: string[][] = [];
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx += 1) {
      const step = levels[levelIdx];
      if (step === undefined) continue;
      const levelEntries: string[] = [];
      const windowSize = step * 10;
      const windowStart = Math.max(1, maxTurn - windowSize + 1);
      for (const e of this.entries) {
        if (e.turn < windowStart) continue;
        if (step === 1 || e.turn % step === 0) {
          levelEntries.push(`T${e.turn}:${e.topic}`);
        }
      }
      levelLines.push(levelEntries);
    }

    // Concatenate levels, most recent FIRST (so truncation hits oldest).
    const orderedLevels = levelLines;  // already recent-first
    const allLines: string[] = [];
    for (const level of orderedLevels) {
      if (level.length === 0) continue;
      // Pack lines multiple per row to save tokens (~6 entries per line).
      const packed: string[] = [];
      for (let i = 0; i < level.length; i += 6) {
        packed.push(level.slice(i, i + 6).join(" "));
      }
      allLines.push(...packed);
    }

    // Truncate to token budget.
    let tokens = estimateTokens(lines[0] ?? "");
    const finalLines: string[] = [...lines];
    for (const line of allLines) {
      const lineTokens = estimateTokens(line);
      if (tokens + lineTokens > this.config.tokenBudget) break;
      finalLines.push(line);
      tokens += lineTokens;
    }

    return finalLines.join("\n");
  }

  /**
   * Check if a turn is represented in the summary at any level.
   * Used by continuity probes. O(1) via the turn index.
   */
  isTurnInSummary(turn: number): boolean {
    return this.turnIndex.has(turn);
  }

  /**
   * Extract a topic keyword from a user+assistant message pair
   * (deterministic, no LLM).
   */
  static extractTopic(userMessage: string, assistantMessage: string): string {
    const userTokens = tokenize(userMessage);
    const assistantTokens = tokenize(assistantMessage);
    const stop = new Set([
      "what", "did", "we", "discuss", "talk", "about", "ask", "tell", "me", "please",
      "summarize", "conversation", "so", "far", "can", "you", "help", "explain",
      "describe", "show", "list", "find", "search", "get", "give", "make", "create",
    ]);
    // First non-stop token from the user message.
    for (const t of userTokens) {
      if (!stop.has(t) && t.length > 2) return t;
    }
    // Fallback: first non-stop token from assistant.
    for (const t of assistantTokens) {
      if (!stop.has(t) && t.length > 2) return t;
    }
    // Final fallback: a token from either.
    return userTokens[0] ?? assistantTokens[0] ?? "topic";
  }

  /** Pick N turns for continuity probes (turns that ARE in the summary). */
  pickContinuityProbeTurns(n: number, maxTurn: number): number[] {
    const candidates: number[] = [];
    const step = Math.max(1, Math.floor(maxTurn / (n * 2)));
    for (let t = step; t <= maxTurn; t += step) {
      if (this.isTurnInSummary(t)) candidates.push(t);
      if (candidates.length >= n) break;
    }
    return candidates;
  }

  clear(): void {
    this.entries.length = 0;
    this.turnIndex.clear();
    this.sorted = true;
    this.mainTopic = "";
  }

  /**
   * Sort the entries array by turn (lazy) and rebuild the turn index. Only
   * invoked when out-of-order recordTurn calls left the array unsorted.
   * O(n log n) once per unordered batch instead of O(n^2 log n) per call.
   */
  private ensureSorted(): void {
    if (this.sorted) return;
    (this.entries as Array<{ turn: number; topic: string }>).sort((a, b) => a.turn - b.turn);
    this.turnIndex.clear();
    for (let i = 0; i < this.entries.length; i += 1) {
      this.turnIndex.set(this.entries[i]!.turn, i);
    }
    this.sorted = true;
  }
}
