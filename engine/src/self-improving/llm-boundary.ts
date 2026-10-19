/**
 * EXP424 — LLM Boundary: the mechanical layer that classifies every piece
 * of the LLM's output as either GENERATION (good — the LLM's only job) or
 * MECHANICAL (bad — the harness should have done this).
 *
 * The user's ideology: "remove responsibilities from llm as much as
 * possible, because like human, they make mistakes, forget things, etc.
 * they're good at generating, which we cannot do mechanically, but we
 * must make it so its their only task."
 *
 * The boundary is enforced TWO ways:
 * 1. PREVENTION: the harness intercepts mechanical work BEFORE it reaches
 * the LLM (no error messages, no context-management, no quality
 * checking, no memory management, no workflow improvement).
 * 2. MEASUREMENT: after each LLM response, the harness classifies each
 * output span as generation or mechanical. Target: 100% generation,
 * 0% mechanical.
 */

import { z } from "zod";

import {
  type SelfImprovingConfig,
} from "./config.ts";
import { InputError } from "../kernel/errors.ts";

/** A single output span (from the LLM's response). */
const OUTPUT_SPAN_SCHEMA = z.object({
  /** The span text. */
  text: z.string().min(1),
  /** The category (must be in mechanicalCategories or generationCategories). */
  category: z.string().min(1),
  /** Whether the category counts as mechanical or generation. */
  mechanical: z.boolean(),
});
export type OutputSpan = z.infer<typeof OUTPUT_SPAN_SCHEMA>;

/** A complete LLM response classification. */
const LLM_RESPONSE_CLASSIFICATION_SCHEMA = z.object({
  /** The raw response (truncated for storage). */
  rawResponse: z.string().min(1),
  /** The classified spans. */
  spans: z.array(OUTPUT_SPAN_SCHEMA),
  /** Total span count. */
  totalSpans: z.number().int().nonnegative(),
  /** Generation span count (good). */
  generationSpans: z.number().int().nonnegative(),
  /** Mechanical span count (bad — should be 0). */
  mechanicalSpans: z.number().int().nonnegative(),
  /** Generation fraction (target: 1.0). */
  generationFraction: z.number().min(0).max(1),
  /** Mechanical fraction (target: 0.0). */
  mechanicalFraction: z.number().min(0).max(1),
  /** Whether the response is pure generation (target: true). */
  pureGeneration: z.boolean(),
  /** List of violations (mechanical spans the LLM should not have produced). */
  violations: z.array(z.object({
    category: z.string().min(1),
    text: z.string().min(1),
    reason: z.string().min(1),
  })),
});
export type LLMResponseClassification = z.infer<typeof LLM_RESPONSE_CLASSIFICATION_SCHEMA>;

/** Mechanical markers (regexes that signal the LLM is doing mechanical work). */
export const MECHANICAL_MARKERS: Readonly<Record<string, RegExp>> = {
  error_handling: /(?:\btry\b.{0,40}?\bcatch\b|\bcatch\s*\(|\bthrow\s+\w|\bhandle\b.{0,20}?\berror\b|\bon\s+error\b|\berror\s+handler\b)/u,
  tool_selection: /(?:\bwhich\s+tool\b|\bselect\s+tool\b|\bchoose\s+tool\b|\btool\s+for\b|\buse\s+the\s+\w+\s+tool\b|\bpick\s+(?:a|the)\s+tool\b)/u,
  context_management: /(?:\btrim\b.{0,20}?\bcontext\b|\bmanage\b.{0,20}?\bcontext\b|\bcontext\s+window\b|\bcontext\s+budget\b|\bcompact\s+context\b|\bshrink\s+context\b)/u,
  quality_check: /(?:\brun\b.{0,10}?\btests\b|\bverify\b.{0,20}?\bquality\b|\bquality\s+check\b|\brun\b.{0,10}?\blint\b|\blint\b.{0,10}?\bcode\b|\bcheck\b.{0,20}?\berrors\b)/u,
  hallucination_check: /(?:\bverify\b.{0,30}?\bhallucinat|\bself[- ]?check\b|\bam\s+i\s+sure\b|\bcheck\s+my\s+answer\b)/u,
  memory_management: /(?:\bsave\b.{0,20}?\bmemory\b|\brecall\b.{0,20}?\bmemory\b|\bstore\b.{0,20}?\bmemory\b|\bretrieve\b.{0,20}?\bmemory\b|\bforget\b.{0,20}?\bmemory\b)/u,
  workflow_improvement: /(?:\bimprove\b.{0,20}?\bworkflow\b|\bworkflow\s+improvement\b|\bself[- ]?improv|\blearn\b.{0,20}?\bmistakes\b)/u,
  retry: /(?:\bretry\b|\btry\s+again\b|\btrying\s+again\b)/u,
  fallback: /(?:\bfallback\b|\bfall\s+back\b|\bplan\s+b\b|\balternative\s+approach\b)/u,
  search_invocation: /(?:\bsearching\s+for\b|\bsearch\s+the\s+codebase\b|\bgrep\s+for\b|\bfind\s+all\s+\w+\b)/u,
  edit_application: /(?:\bapply\s+(?:the\s+)?edit\b|\bwrite\s+(?:the\s+)?file\b|\bmodify\s+(?:the\s+)?file\b|\binsert\s+at\s+line\b|\bedit\s+(?:the\s+)?file\b)/u,
  verification: /(?:\bverify\b.{0,20}?\bresult\b|\bcheck\b.{0,20}?\boutput\b|\bassert\s+that\b|\bconfirm\b.{0,20}?\bedit\b)/u,
};

/** Generation markers (the LLM's actual job — generating new content). */
export const GENERATION_MARKERS: Readonly<Record<string, RegExp>> = {
  code: /(?:```[\s\S]*?```|function\s+\w+|const\s+\w+\s*=|class\s+\w+|interface\s+\w+)/u,
  text: /(?:[A-Z][a-z]+\s+[a-z]+\s+[a-z]+)/u,
  explanation: /(?:because|therefore|so\s+that|in\s+order\s+to|the\s+reason)/u,
  decision: /(?:we\s+(?:should|will|must|can)|the\s+best\s+approach|I\s+(?:recommend|suggest|propose))/u,
  plan: /(?:step\s+1|first|next|then|finally|plan\s+of\s+action)/u,
  natural_language: /(?:[A-Z][a-z]+\s+[a-z]+)/u,
  rationale: /(?:rationale|reasoning|justification|motivation)/u,
};

/**
 * Classify a single span of LLM output. Returns the category + whether
 * it's mechanical or generation. Mechanical markers are checked FIRST —
 * if the LLM is doing mechanical work, it's flagged as mechanical even if
 * the response also contains generation-like text. The ideology is: the
 * LLM should ONLY generate; any mechanical work is a violation.
 */
export function classifySpan(
  text: string,
  config: SelfImprovingConfig,
): { category: string; mechanical: boolean } {
  // Check mechanical markers FIRST (the LLM should NOT be doing these).
  for (const [cat, regex] of Object.entries(MECHANICAL_MARKERS)) {
    if (config.mechanicalCategories.includes(cat) && regex.test(text)) {
      return { category: cat, mechanical: true };
    }
  }
  // Check generation markers (the LLM's actual job).
  for (const [cat, regex] of Object.entries(GENERATION_MARKERS)) {
    if (config.generationCategories.includes(cat) && regex.test(text)) {
      return { category: cat, mechanical: false };
    }
  }
  // Default: treat as generation (the LLM produced something new).
  return { category: "text", mechanical: false };
}

/**
 * Classify a complete LLM response. Splits the response into sentences
 * (rough), classifies each, and aggregates the metrics.
 *
 * The harness uses this AFTER the LLM responds to verify the LLM only
 * generated — it does NOT verify the LLM did mechanical work (that would
 * be a violation of the ideology).
 */
export function classifyResponse(
  rawResponse: string,
  config: SelfImprovingConfig,
): LLMResponseClassification {
  // Split into "spans" by sentence boundaries (rough — not a real parser,
  // we just need a deterministic chunking for measurement).
  const spans = splitIntoSpans(rawResponse);
  const classified: OutputSpan[] = spans.map((text) => {
    const { category, mechanical } = classifySpan(text, config);
    const result = OUTPUT_SPAN_SCHEMA.safeParse({ text, category, mechanical });
    if (!result.success) {
      // Should not happen — return a safe default.
      return { text, category: "text", mechanical: false } as OutputSpan;
    }
    return result.data;
  });
  const totalSpans = classified.length;
  const generationSpans = classified.filter((s) => !s.mechanical).length;
  const mechanicalSpans = classified.filter((s) => s.mechanical).length;
  const generationFraction = totalSpans > 0 ? generationSpans / totalSpans : 1;
  const mechanicalFraction = totalSpans > 0 ? mechanicalSpans / totalSpans : 0;
  const pureGeneration = mechanicalSpans === 0;
  const violations = classified
    .filter((s) => s.mechanical)
    .map((s) => ({
      category: s.category,
      text: s.text,
      reason: `LLM should not do ${s.category} — that's the harness's job.`,
    }));
  const result = LLM_RESPONSE_CLASSIFICATION_SCHEMA.safeParse({
    rawResponse,
    spans: classified,
    totalSpans,
    generationSpans,
    mechanicalSpans,
    generationFraction,
    mechanicalFraction,
    pureGeneration,
    violations,
  });
  if (!result.success) {
    throw new InputError(`Internal: invalid classification for ${rawResponse.slice(0, 50)}`);
  }
  return result.data;
}

/**
 * Split a response into spans. Uses sentence-like boundaries (period,
 * newline, semicolon) but keeps the punctuation. Deterministic.
 */
function splitIntoSpans(text: string): string[] {
  if (text.length === 0) return [];
  // Split on sentence boundaries but KEEP the delimiter (so each span is a
  // complete sentence). This is intentionally simple — we just need a
  // deterministic chunking for measurement, not a real parser.
  const rough = text.split(/(?<=[.;\n])\s+/u).map((s) => s.trim()).filter((s) => s.length > 0);
  return rough.length > 0 ? rough : [text];
}

/**
 * Build the LLM-boundary interception layer. The harness wraps every
 * request to the LLM with this layer: it removes mechanical context
 * (errors, retries, fallbacks, quality feedback) and only injects the
 * task + the clean context the LLM needs to generate.
 *
 * Returns the cleaned context + the list of removed spans (so the harness
 * can log them and apply them mechanically).
 */
export function interceptRequest(
  context: string,
  config: SelfImprovingConfig,
): { cleanedContext: string; removedSpans: { category: string; text: string }[] } {
  const spans = splitIntoSpans(context);
  const cleaned: string[] = [];
  const removed: { category: string; text: string }[] = [];
  for (const span of spans) {
    const { category, mechanical } = classifySpan(span, config);
    if (mechanical) {
      removed.push({ category, text: span });
    } else {
      cleaned.push(span);
    }
  }
  return { cleanedContext: cleaned.join(" "), removedSpans: removed };
}

/**
 * Construct the synthetic "this failed, try a different approach" message
 * the LLM sees INSTEAD of a raw error. The LLM never sees errors — it
 * sees a clean signal that the previous attempt failed + a request to
 * generate a different approach.
 */
export function buildFailureSignal(previousAttempt: string, reason: string): string {
  return `The previous attempt did not work. Reason: ${reason}. Generate a different approach.\n\nPrevious attempt:\n${previousAttempt.slice(0, 500)}`;
}
