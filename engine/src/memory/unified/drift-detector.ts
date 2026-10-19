/**
 * Drift detector (deterministic + LLM-based, from EXP353/416).
 *
 * Two-layer:
 * 1. DETERMINISTIC layer (no LLM): track the conversation topic as a
 * rolling TF-IDF vector of the last N turns. Compare to the
 * original-task vector via cosine similarity. If sim < threshold
 * and minTurnsBeforeDrift elapsed, drift detected.
 * 2. LLM layer (from EXP416): if deterministic borderline, ask the
 * CALLER-DECLARED model to classify same/different domain. v4 prompt
 * (domain-focused few-shot CoT) achieved 0% FP / 100% TP on 500 pairs +
 * 0% FP / 99.96% TP on 10× (5000 pairs) when validated — those figures
 * were measured on one specific model; a caller pointing this at another
 * model inherits the prompt, not the measurement. The model, like the
 * address and the key, is declared by the caller — no vendor's model is
 * assumed here (see the refusals in `createDriftDetector`).
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { tokenize, termFrequency } from "./tokenizer.ts";
import { CONTENT_TYPE_JSON, PROVIDER_NOT_CONFIGURED_BASE_URL, isProviderConfigured } from "../../kernel/contracts.ts";
import { InputError } from "../../kernel/errors.ts";
import { bestEffort } from "../../shared/best-effort.ts";
import { handleError } from "../../shared/debug/debug-system.ts";
import { discardBody, outboundFetch, readBody } from "../../shared/outbound-http.ts";
import { OPERATOR_OWNER, privateAddressesAllowedFor } from "../../shared/outbound-policy.ts";
import { abortableDelay, deadline } from "../../shared/abort-signals.ts";
import { resolveResponsesTransportConfig } from "../../shared/llm/config.ts";
import { PROVIDER_LOG_CATEGORY } from "../../shared/llm/provider-http.ts";

/** The provider transport's body bound and cleanup deadline (the one transport owner's defaults). */
// INTERIM (Chat removal deletes this Chat-era classifier): the declared
// transport defaults, not the configured section — a static fallback behind
// the configured document, tracked in ALL-BUGS (a2-design M5 residue).
const TRANSPORT = resolveResponsesTransportConfig({});

export type DriftConfig = Readonly<{
  /** Cosine sim < this → drift detected (deterministic layer). */
  threshold: number;
  /** Rolling topic window size (recent N turns). */
  windowSize: number;
  /** Don't fire drift in the first N turns. */
  minTurnsBeforeDrift: number;
  /** If deterministic sim is in [ambiguousLow, ambiguousHigh], ask the LLM. */
  ambiguousLow: number;
  ambiguousHigh: number;
  /** LLM API base URL + key + model. */
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
  apiMaxTokens: number;
  apiTemperature: number;
  apiTimeoutMs: number;
  apiMaxRetries: number;
  apiBackoffMs: number;
}>;

/**
 * ── THE ADDRESS IS NOT A DEFAULT VALUE, IT IS A DEFAULT DESTINATION ────────
 *
 * `apiBaseUrl` used to default to a real vendor host. Read beside `apiKey: ""`
 * that looks safe — an unconfigured install sends nothing, because the LLM
 * layer is gated on the key being non-empty. But the config is spread into
 * every caller (`{ ...DEFAULT_DRIFT_CONFIG, ...config }`), so the shape the
 * code INVITES is a partial override: supply the key you have, inherit
 * everything you did not think about. Two callers took exactly that shape
 * (`scripts/exp445/run-exp445.mjs` at both of its live sites, passing
 * `apiKey` and `apiModel` and inheriting the host) while a neighbouring
 * experiment passed `apiBaseUrl` explicitly and was correct. **A real key
 * addressed at a hard-coded vendor, and the two doors disagreeing is the
 * defect rather than the difference.**
 *
 * So the default address is now one that cannot resolve on any network, and
 * `createDriftDetector` REFUSES the incoherent pair outright: a key without an
 * address is a misconfiguration with a plain-language remedy, not a request to
 * guess who the key belongs to. Both halves matter — the refusal is what a
 * caller meets, and the unresolvable default is what remains true if someone
 * later removes the refusal.
 */
export const DEFAULT_DRIFT_CONFIG: DriftConfig = deepFreeze({
  threshold: 0.20,
  windowSize: 3,
  minTurnsBeforeDrift: 3,
  ambiguousLow: 0.20,
  ambiguousHigh: 0.45,
  apiBaseUrl: PROVIDER_NOT_CONFIGURED_BASE_URL,
  apiKey: "",
  // EMPTY FOR THE SAME REASON THE ADDRESS IS UNRESOLVABLE. This used to name
  // a vendor's model, which combined with a caller-supplied key into a
  // request this code composed on the caller's behalf — the same
  // partial-override trap as the address, one field over. A key without a
  // model is refused below with the same shape as a key without an address.
  apiModel: "",
  apiMaxTokens: 200,
  apiTemperature: 0,
  apiTimeoutMs: 60000,
  apiMaxRetries: 4,
  apiBackoffMs: 2500,
});

export type DriftResult = Readonly<{
  detected: boolean;
  similarity: number;
  layer: "deterministic" | "llm" | "skipped";
  reason: string;
  llmLabel?: "SAME" | "DIFFERENT";
  llmConfidence?: number;
  llmMs?: number;
}>;

export interface DriftDetector {
  readonly config: DriftConfig;
  /** Set the original task vector (e.g. "refactor babel-traverse assertions"). */
  setOriginalTask(text: string): void;
  /** Track a turn's content. */
  trackTurn(turn: number, content: string): void;
  /** Check for drift after `turn`. Returns the similarity + verdict. */
  check(turn: number): Promise<DriftResult>;
  /** Reset state. */
  reset(): void;
}

export function createDriftDetector(config: Partial<DriftConfig> = {}): DriftDetector {
  const cfg: DriftConfig = { ...DEFAULT_DRIFT_CONFIG, ...config } as DriftConfig;
  if (cfg.threshold < 0 || cfg.threshold > 1 || !Number.isFinite(cfg.threshold)) {
    throw new InputError("drift.threshold must be in [0, 1]");
  }
  if (cfg.windowSize < 1 || !Number.isFinite(cfg.windowSize)) {
    throw new InputError("drift.windowSize must be >= 1");
  }
  if (cfg.minTurnsBeforeDrift < 0 || !Number.isFinite(cfg.minTurnsBeforeDrift)) {
    throw new InputError("drift.minTurnsBeforeDrift must be >= 0");
  }
  if (cfg.ambiguousLow > cfg.ambiguousHigh) {
    throw new InputError("drift.ambiguousLow must be <= ambiguousHigh");
  }
  // A KEY WITH NOWHERE TO GO IS A MISCONFIGURATION, NOT A REQUEST TO GUESS.
  //
  // This is the refusal that makes the partial override impossible rather than
  // merely harmless. The two states that make sense are "no key, so the LLM
  // layer is off" and "a key AND the address it belongs to". The third — a key
  // beside an inherited address — is the one that sends a real credential
  // somewhere the caller never named, and it is now unconstructable. The
  // message says what is missing and what to do about it, and it names no
  // vendor, because there is no vendor this code is entitled to assume.
  if (cfg.apiKey.length > 0 && !isProviderConfigured(cfg.apiBaseUrl)) {
    throw new InputError(
      "An API key was supplied for drift classification but no API address was. " +
      "A key on its own does not say who it belongs to, and this detector will not " +
      "choose a provider on your behalf. Pass `apiBaseUrl` alongside `apiKey`, or " +
      "leave both unset to use the deterministic layer only.",
      "drift_api_base_url_missing",
    );
  }
  // A KEY WITHOUT A MODEL IS THE SAME MISCONFIGURATION, one field over. The
  // model used to default to a vendor's, so "supply the key you have,
  // inherit everything you did not think about" composed a request naming a
  // model the caller never chose. There is no model this code is entitled
  // to assume, so the incoherent pair is unconstructable.
  if (cfg.apiKey.length > 0 && cfg.apiModel.length === 0) {
    throw new InputError(
      "An API key was supplied for drift classification but no model was. This detector " +
      "will not choose a model on your behalf. Pass `apiModel` alongside `apiKey`, or " +
      "leave both unset to use the deterministic layer only.",
      "drift_api_model_missing",
    );
  }
  let originalVector: Map<string, number> | null = null;
  const recentTurns: Array<{ turn: number; tokens: readonly string[] }> = [];

  function vecToMap(tokens: readonly string[]): Map<string, number> {
    return termFrequency(tokens);
  }

  function cosineMaps(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [k, v] of a) {
      normA += v * v;
      const bv = b.get(k);
      if (bv !== undefined) dot += v * bv;
    }
    for (const [, v] of b) normB += v * v;
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  return {
    config: deepFreeze(cfg) as DriftConfig,
    setOriginalTask(text: string) {
      originalVector = vecToMap(tokenize(text));
    },
    trackTurn(turn: number, content: string) {
      recentTurns.push({ turn, tokens: tokenize(content) });
      while (recentTurns.length > cfg.windowSize) recentTurns.shift();
    },
    async check(turn: number): Promise<DriftResult> {
      if (originalVector === null) {
        return { detected: false, similarity: 1, layer: "skipped", reason: "no-original-task" };
      }
      if (turn < cfg.minTurnsBeforeDrift) {
        return { detected: false, similarity: 1, layer: "skipped", reason: "before-min-turns" };
      }
      if (recentTurns.length === 0) {
        return { detected: false, similarity: 1, layer: "skipped", reason: "no-recent-turns" };
      }
      const combined: string[] = [];
      for (const r of recentTurns) combined.push(...r.tokens);
      const currentVec = vecToMap(combined);
      const sim = cosineMaps(originalVector, currentVec);

      // Deterministic decision.
      if (sim < cfg.threshold) {
        return { detected: true, similarity: sim, layer: "deterministic", reason: `sim ${sim.toFixed(3)} < threshold ${cfg.threshold}` };
      }
      // LLM ambiguous-zone check.
      if (sim >= cfg.ambiguousLow && sim <= cfg.ambiguousHigh && cfg.apiKey.length > 0) {
        const originalText = [...originalVector.keys()].join(" ");
        const recentText = combined.join(" ");
        const llmResult = await llmClassifyDrift(originalText, recentText, cfg);
        return {
          detected: llmResult.label === "DIFFERENT",
          similarity: sim,
          layer: "llm",
          reason: `deterministic ambiguous (sim ${sim.toFixed(3)}) → LLM ${llmResult.label}`,
          llmLabel: llmResult.label,
          llmConfidence: llmResult.confidence,
          llmMs: llmResult.ms,
        };
      }
      return { detected: false, similarity: sim, layer: "deterministic", reason: `sim ${sim.toFixed(3)} >= threshold ${cfg.threshold}` };
    },
    reset() {
      originalVector = null;
      recentTurns.length = 0;
    },
  };
}

/** LLM drift classifier (gemma-4-31b only, from EXP416 v4 prompt). */
async function llmClassifyDrift(
  originalText: string,
  recentText: string,
  cfg: DriftConfig,
): Promise<{ label: "SAME" | "DIFFERENT"; confidence: number; ms: number }> {
  const prompt = buildDriftPrompt(originalText, recentText);
  const messages = [
    { role: "system", content: "You are a domain classifier. Output JSON: {\"about_a\": \"\", \"about_b\": \"\", \"confidence_diff\": 0, \"label\": \"SAME|DIFFERENT\"}" },
    { role: "user", content: prompt },
  ];
  const t0 = Date.now();
  for (let attempt = 0; attempt < cfg.apiMaxRetries; attempt += 1) {
    // Through the one outbound HTTP policy (no redirect followed, verified
    // TLS, the one cleartext decision) and bounded end to end: the deadline
    // covers the body read, and the body is read through the door's bound
    // (it was an unbounded `res.json()` after the timer was cleared).
    const lifetime = deadline(undefined, cfg.apiTimeoutMs);
    try {
      const res = await outboundFetch({
        url: `${cfg.apiBaseUrl}/chat/completions`,
        method: "POST",
        protocolHeaders: { "Content-Type": CONTENT_TYPE_JSON, Authorization: `Bearer ${cfg.apiKey}` },
        // The operator's configured classifier endpoint (config, not a user's choice).
        allowPrivateAddress: privateAddressesAllowedFor(OPERATOR_OWNER),
        body: JSON.stringify({
          model: cfg.apiModel,
          messages,
          max_tokens: cfg.apiMaxTokens,
          temperature: cfg.apiTemperature,
        }),
        signal: lifetime.signal,
        logCategory: PROVIDER_LOG_CATEGORY,
      });
      if (!res.ok) {
        await discardBody(res, PROVIDER_LOG_CATEGORY, TRANSPORT.cleanupTimeoutMs);
        if (res.status === 429 || res.status >= 500) {
          await abortableDelay(cfg.apiBackoffMs * Math.pow(2, attempt));
          continue;
        }
        return { label: "SAME", confidence: 0, ms: Date.now() - t0 };
      }
      const text = await readBody(res, lifetime.signal, TRANSPORT.maximumResponseBytes, TRANSPORT.cleanupTimeoutMs, PROVIDER_LOG_CATEGORY);
      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      return parseDriftResponse(content, Date.now() - t0);
    } catch (e) {handleError(e, { module: "memory-unified-drift-detector", operation: "catch" });
      await abortableDelay(cfg.apiBackoffMs * Math.pow(2, attempt));
    } finally {
      lifetime.clear();
    }
  }
  // On LLM failure, fall back to deterministic SAME (avoid false drift).
  return { label: "SAME", confidence: 0, ms: Date.now() - t0 };
}

function parseDriftResponse(content: string, ms: number): { label: "SAME" | "DIFFERENT"; confidence: number; ms: number } {
  // Try to extract JSON.
  const jsonMatch = content.match(/\{[^{}]*\}/);
  if (jsonMatch && jsonMatch[0]) {
    const parsed = bestEffort(() =>
      JSON.parse(jsonMatch[0]) as { label?: string; confidence_diff?: number },
    );
    if (parsed !== undefined) {
      const label = parsed.label === "DIFFERENT" ? "DIFFERENT" : "SAME";
      const confidence = typeof parsed.confidence_diff === "number" ? parsed.confidence_diff : 50;
      return { label, confidence, ms };
    }
  }
  // Fall back: keyword match.
  const upper = content.toUpperCase();
  if (upper.includes("DIFFERENT")) return { label: "DIFFERENT", confidence: 100, ms };
  return { label: "SAME", confidence: 50, ms };
}

/** v4 prompt (domain-focused few-shot CoT, from EXP416). */
function buildDriftPrompt(a: string, b: string): string {
  return `KEY PRINCIPLE: Identify what each sentence is PRIMARILY ABOUT, and check the ACTOR and PURPOSE.

SAME = both about the same technical concept, even with different words/analogies.
DIFFERENT = about different subjects, even with same surface words/terms.

DECISION RULE:
1. What is A PRIMARILY ABOUT?
2. What is B PRIMARILY ABOUT?
3. Same concept → SAME. Different domains → DIFFERENT.

EXAMPLES (SAME):
- "parser tokenizes source code" vs "lexer splits input into tokens" → SAME (both about parsing)
- "binary tree traversal" vs "graph depth-first search" → SAME (both about tree/graph traversal)
- "Heisenberg uncertainty in measurement" vs "quantum measurement limit" → SAME (both about quantum measurement)
- "encrypt data with AES" vs "obfuscate payload using cipher" → SAME (both about encryption)

EXAMPLES (DIFFERENT):
- "software encrypts data" vs "spy encrypts message" → DIFFERENT (different actors: software vs spy)
- "parse JSON syntax" vs "parse lyrics meaning" → DIFFERENT (different domains: code vs music)
- "boolean in function" vs "boolean from witness" → DIFFERENT (programming vs legal)

Now classify:
A: ${a}
B: ${b}

Output JSON: {"about_a": "<domain of A>", "about_b": "<domain of B>", "confidence_diff": 0-100, "label": "SAME" or "DIFFERENT"}`;
}
