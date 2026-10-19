/**
 * Proactive-injection query classifier (from EXP420).
 *
 * When the user (or LLM) asks "X", the classifier deterministically bins
 * the query into one of {code, memory, action, general} and extracts a
 * target identifier, with a confidence derived from the winner/runner-up
 * score gap. The injection thresholds and budgets live here as
 * `DEFAULT_INJECTION_CONFIG` and are re-published through the unified
 * config owner.
 */
import { deepFreeze } from "../../kernel/integrity.ts";

// The array owns it, so a fifth kind cannot be added to the type and missed
// by the classifier report that enumerates them.
const QUERY_KINDS = deepFreeze(["code", "memory", "action", "general"] as const);

export type QueryKind = typeof QUERY_KINDS[number];

export type ClassifiedQuery = Readonly<{
  kind: QueryKind;
  target: string | null;
  confidence: number;
}>;

export type InjectionConfig = Readonly<{
  topK: number;
  hybridThreshold: number;
  contextTokBudget: number;
}>;

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = deepFreeze({
  topK: 3,
  hybridThreshold: 0.55,
  contextTokBudget: 800,
});

/** Patterns for each query kind (configurable; no static keywords in callers). */
export type ClassifierConfig = Readonly<{
  codePatterns: readonly RegExp[];
  memoryPatterns: readonly RegExp[];
  actionPatterns: readonly RegExp[];
  generalPatterns: readonly RegExp[];
  /** Stop words excluded from target extraction. */
  targetStopWords: ReadonlySet<string>;
}>;

const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = deepFreeze({
  codePatterns: [
    /\b(where is|what does|how does|find|locate|show me|explain)\s+(the\s+)?([a-z_][a-z0-9_]*)\b/i,
    /\b(rename|refactor|extract|inline|move|delete|update|fix|implement|add)\s+([a-z_][a-z0-9_]*)\b/i,
    /\b(function|class|method|variable|const|let|var)\s+([a-z_][a-z0-9_]*)\b/i,
    /\b([a-z_][a-z0-9_]*)\s+(function|class|method|const|variable)\b/i,
  ],
  memoryPatterns: [
    /\b(remember|recall|previously|earlier|last time|yesterday|history|what did we|what were we)\b/i,
    /\b(we discussed|we decided|we agreed|we tried|we explored|we found)\b/i,
  ],
  actionPatterns: [
    /\b(run|build|test|deploy|commit|push|merge|install|lint|format|check)\b/i,
    /\b(start|stop|restart|init|create|delete|update|save|load)\b/i,
  ],
  generalPatterns: [
    /\b(hello|hi|hey|thanks|please|sorry|ok|okay|yes|no|bye)\b/i,
    /\b(summarize|overview|status|progress|what is going on|whats up)\b/i,
  ],
  targetStopWords: new Set<string>([
    "the", "a", "an", "and", "or", "but", "for", "to", "in", "on", "at", "by",
    "with", "from", "of", "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "it", "its", "function", "class",
    "method", "variable", "const", "let", "var", "the", "make", "create",
    "how", "what", "where", "when", "why", "who", "which", "find", "show",
    "explain", "rename", "refactor", "extract", "inline", "move", "delete",
    "update", "fix", "implement", "add", "me", "please", "tell",
  ]),
});

export function createClassifier(config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG): {
  classify(text: string): ClassifiedQuery;
} {
  return {
    classify(text: string): ClassifiedQuery {
      const scores: Record<QueryKind, number> = { code: 0, memory: 0, action: 0, general: 0 };
      const patterns: Record<QueryKind, readonly RegExp[]> = {
        code: config.codePatterns,
        memory: config.memoryPatterns,
        action: config.actionPatterns,
        general: config.generalPatterns,
      };
      for (const kind of Object.keys(patterns) as QueryKind[]) {
        for (const p of patterns[kind]) {
          if (p.test(text)) scores[kind] += 1;
        }
      }
      // Pick winner.
      let winner: QueryKind = "general";
      let winnerScore = 0;
      let runnerUp = 0;
      for (const k of Object.keys(scores) as QueryKind[]) {
        const s = scores[k];
        if (s > winnerScore) {
          runnerUp = winnerScore;
          winnerScore = s;
          winner = k;
        } else if (s > runnerUp) {
          runnerUp = s;
        }
      }
      const denom = winnerScore + runnerUp + 0.001;
      const confidence = winnerScore / denom;
      // Target extraction.
      const target = extractTarget(text, config);
      return deepFreeze({ kind: winner, target, confidence }) as ClassifiedQuery;
    },
  };
}

function extractTarget(text: string, config: ClassifierConfig): string | null {
  // Prefer "rename X to Y" → X (the SOURCE).
  const renameMatch = text.match(/\brename\s+([a-z_][a-z0-9_]*)\s+to\b/i);
  if (renameMatch && renameMatch[1]) return cleanIdent(renameMatch[1], config);
  // "where is X" / "what does X do" / "how does X work" / "find X"
  const phraseMatch = text.match(/\b(?:where is|what does|how does|find|locate|show me|explain|fix bug in|extract method|inline|move|delete|update|implement|add)\s+(?:the\s+)?([a-z_][a-z0-9_]*)\b/i);
  if (phraseMatch && phraseMatch[1]) return cleanIdent(phraseMatch[1], config);
  // Fallback: longest identifier-like token that isn't a stop word.
  const tokens = text.split(/[^a-zA-Z0-9_]+/).filter((t) => t.length >= 2);
  let best: string | null = null;
  for (const t of tokens) {
    if (config.targetStopWords.has(t.toLowerCase())) continue;
    if (best === null || t.length > best.length) best = t;
  }
  return best ? cleanIdent(best, config) : null;
}

function cleanIdent(s: string, config: ClassifierConfig): string {
  let cleaned = s.replace(/^[^a-zA-Z_]+|[^a-zA-Z0-9_]+$/g, "");
  if (cleaned.length === 0) return s;
  if (config.targetStopWords.has(cleaned.toLowerCase())) return s;
  return cleaned;
}
