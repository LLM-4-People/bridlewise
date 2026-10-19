/**
 * Dedup bridge — the SINGLE web-UI owner of the dedup-compression adapter
 *.
 *
 * ALL dedup/compression in the web UI goes through this module — no route,
 * bridge, or service imports the canonical dedup-compression subsystem
 * directly. This is a thin adapter over the canonical subsystem
 * (`integration/src/shared/dedup-compression/`), NOT a rebuild.
 *
 * Two modes (both opt-in, both default OFF"configurable and
 * opt-in"; "Deny-by-Default"):
 *
 * 1. **Storage reporting** (off-path): `wireDedupForTurn` stores context
 * turns in the content-addressed store for cross-turn dedup reporting
 * (metrics: how much duplication exists). Does NOT alter LLM input — the
 * LLM-visible content comes from `buildTrimmedHistory` (the context
 * manager). Controlled by `memory.dedupCompression.enabled`.
 *
 * 2. **LLM-input dedup** (on-path): `dedupContentForLLM` applies dedup to
 * each message's content at the LLM bridge choke point (llm-bridge.ts
 * `buildLLMMessages`), reducing tokens sent to the LLM. The dedup
 * removes near-duplicate blocks (the kept blocks are exact — lossless for
 * the kept content). Controlled by `memory.dedupCompression.llmInputDedup`.
 * Requires `memory.dedupCompression.enabled` to also be true (the lower
 * layer must be initialized).
 *
 * The dedup sits between the context manager and the LLM bridge
 * it compresses the trimmed history before it's sent. The lowest-level
 * enforcement is at the LLM bridge choke point (`buildLLMMessages`), so NO
 * caller can bypass the dedup — the same pattern as PII redaction.
 *
 * The dedup status is exposed via the `dedup` SSE event (so the user sees it
 * working — "Anything that can be shown must be wired and working").
 *
 * Web research (Kagi): the "layer below the API that compresses
 * context before each call" pattern is the industry standard (ContextPilot:
 * "sits between your code and the API and compresses context before each
 * call"; buildmvpfast.com: "semantic dedup" as one of 5 context-compression
 * patterns cutting token costs 30-70%).
 *
 * Reuses: `integration/src/shared/dedup-compression/`.
 */

import {
  DEFAULT_DEDUP_COMPRESSION_CONFIG as DEFAULT_DEDUP_CONFIG,
  initLowerLayer,
  storeContextTurn,
  dedup,
  resolveModuleConfig,
  type DedupCompressionConfig,
  type DedupReport,
} from "../../engine/src/shared/dedup-compression/index.ts";
// Re-export DedupReport so llm-bridge.ts + tests can import the type from the
// single dedup owner (SPO — no direct imports from the canonical subsystem
// outside this bridge).
export type { DedupReport };
import { getDedupCompressionSection } from "../kernel/harness-config.ts";
import { webWarn } from "../observability/debug-bridge.ts";
// Reuse the canonical `round` helper. Used by
// `summarizeDedupReports` for consistent decimal precision.
import { round } from "../../engine/src/shared/numeric-helpers.ts";

// ── Config reading (single source of truth: harness config `memory` section) ──

/**
 * Read the `memory.dedupCompression` config section via the config-owner
 * accessor. Returns null when the section is absent or not an object
 * (deny-by-default).
 */
function readDedupConfigSection(): Readonly<Record<string, unknown>> | null {
  return getDedupCompressionSection();
}

/**
 * Whether the dedup-compression lower layer is enabled at all (the global
 * kill switch). Opt-in via `memory.dedupCompression.enabled`.
 * When false, BOTH storage reporting AND LLM-input dedup are no-ops.
 */
export function dedupCompressionEnabled(): boolean {
  const section = readDedupConfigSection();
  if (section === null) return false;
  return section["enabled"] === true;
}

/**
 * Whether dedup should be applied to LLM-visible input (not just storage
 * reporting). Opt-in via `memory.dedupCompression.llmInputDedup`.
 * Requires `dedupCompressionEnabled` to also be true (the lower layer must
 * be initialized). When false, the LLM input is NOT deduped (the current
 * lossless behavior — the LLM sees the full un-deduped history).
 */
export function llmInputDedupEnabled(): boolean {
  if (!dedupCompressionEnabled()) return false;
  const section = readDedupConfigSection();
  if (section === null) return false;
  return section["llmInputDedup"] === true;
}

/**
 * The dedup mode to use for LLM-input dedup. Read from
 * `memory.dedupCompression.dedupMode` (one of: "none" | "line" | "block" |
 * "semantic" | "hash" | "ast"). Defaults to "block" (fast + effective for
 * removing near-duplicate paragraphs in natural language + code context —
 * "semantic" is more thorough but uses babel/tree-sitter parsing which is
 * expensive on large inputs). The user can override via config.
 */
export function getLlmInputDedupMode(): string {
  const section = readDedupConfigSection();
  if (section === null) return "block";
  const mode = section["dedupMode"];
  if (typeof mode !== "string") return "block";
  return mode;
}

// ── Storage reporting (off-path) ──

let dedupLowerLayerReady = false;

/**
 * Lazily initialize the dedup lower layer (once per process) when dedup is
 * enabled. Idempotent — safe to call on every turn. Returns true when the
 * store is ready to accept `storeContextTurn` calls.
 */
function ensureDedupLowerLayer(): boolean {
  if (!dedupCompressionEnabled()) return false;
  if (dedupLowerLayerReady) return true;
  try {
    initLowerLayer(DEFAULT_DEDUP_CONFIG);
    dedupLowerLayerReady = true;
    return true;
  } catch (err) {
    // A dedup init failure must never break the chat run. The LLM-visible content is unaffected
    // (the store is an off-path reporter); we log + disable so subsequent
    // turns skip the store instead of retrying init every call.
    webWarn(
      "dedup-bridge",
      "dedup lower-layer init failed (disabling for this process)",
 () => ({ error: err instanceof Error ? err.message : String(err) }),
    );
    return false;
  }
}

/**
 * Route a context turn through the dedup layer for storage reporting
 * (off-path — does NOT alter LLM input). Called by the run pipeline for
 * every turn added to the context manager (user, assistant, tool result,
 * steering). Best-effort: a store failure logs a warning and continues —
 * the LLM-visible content is never altered by the dedup layer.
 */
export function wireDedupForTurn(content: string): void {
  if (!ensureDedupLowerLayer()) return;
  if (content.length === 0) return;
  try {
    storeContextTurn(content);
  } catch (err) {
    webWarn(
      "dedup-bridge",
      "dedup storeContextTurn failed (turn not reported, chat continues)",
 () => ({ error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

// ── LLM-input dedup (on-path — compresses input before it goes to the LLM) ──

/**
 * The resolved dedup config for the `context` module (LLM-visible context).
 * Uses the canonical `DEFAULT_CONFIG` as the base + the `context` module
 * override (compressionMode: "none", llmVisibleLosslessOnly: true). The
 * dedupMode is overridden by `memory.dedupCompression.dedupMode` (so the
 * user can choose a faster mode like "block" for LLM input).
 */
function getLlmInputDedupConfig(): DedupCompressionConfig {
  const base = resolveModuleConfig(DEFAULT_DEDUP_CONFIG, "context");
  const mode = getLlmInputDedupMode();
  // Override the dedup mode with the user's choice. Keep compressionMode
  // "none" (the LLM sees the deduped text verbatim — no storage compression
  // is applied to LLM-visible content).
  return Object.freeze({
    ...base,
    dedupMode: mode as DedupCompressionConfig["dedupMode"],
    compressionMode: "none" as const,
    llmVisibleLosslessOnly: true,
  });
}

/**
 * Apply dedup to a single message's content for LLM input (per-message
 * dedup at the LLM bridge choke point). Returns the deduped content + a
 * report. No-op (returns the original content + null report) when
 * `llmInputDedupEnabled` is false, when the content is too short
 * (`minInputSizeForPipeline`), or when the dedup mode is "none".
 *
 * The dedup removes near-duplicate blocks (the kept blocks are exact —
 * lossless for the kept content). This reduces tokens sent to the LLM
 * without minifying (stripping comments/whitespace), respecting the
 * gemma-tolerance budget (the `context` module config has
 * `llmVisibleLosslessOnly: true`).
 */
export function dedupContentForLLM(content: string): {
  content: string;
  report: DedupReport | null;
} {
  if (!llmInputDedupEnabled()) return { content, report: null };
  if (content.length === 0) return { content, report: null };
  const cfg = getLlmInputDedupConfig();
  if (cfg.dedupMode === "none") return { content, report: null };
  // Skip short content (no benefit — same gate as the store).
  if (content.length < cfg.minInputSizeForPipeline) return { content, report: null };
  try {
    const result = dedup(content, cfg);
    // Only return a report when dedup actually removed something — so the
    // SSE event is not noisy (no event when dedup is a no-op).
    if (result.report.removedLines === 0 && result.report.removedBlocks === 0) {
      return { content: result.content, report: null };
    }
    return { content: result.content, report: result.report };
  } catch (err) {
    // A dedup failure must never alter the LLM input. Return the original content
    // so the LLM sees the un-deduped text — a dedup failure is a reporting
    // failure, not a content corruption.
    webWarn(
      "dedup-bridge",
      "dedupContentForLLM failed (sending original content, chat continues)",
 () => ({ error: err instanceof Error ? err.message : String(err) }),
    );
    return { content, report: null };
  }
}

/**
 * Accumulate dedup reports across multiple messages into a single summary
 * for the SSE event. Returns null when no dedup was applied (all messages
 * were no-ops). The summary contains the total reduction across all
 * messages so the user sees the net effect.
 */
export function summarizeDedupReports(
  reports: readonly (DedupReport | null)[],
): {
  applied: boolean;
  originalChars: number;
  dedupedChars: number;
  charReductionPct: number;
  removedBlocks: number;
  removedLines: number;
  messageCount: number;
} | null {
  const active = reports.filter((r): r is DedupReport => r !== null);
  if (active.length === 0) return null;
  let originalChars = 0;
  let dedupedChars = 0;
  let removedBlocks = 0;
  let removedLines = 0;
  for (const r of active) {
    originalChars += r.originalChars;
    dedupedChars += r.dedupedChars;
    removedBlocks += r.removedBlocks;
    removedLines += r.removedLines;
  }
  return {
    applied: true,
    originalChars,
    dedupedChars,
    charReductionPct: originalChars > 0
      ? round((1 - dedupedChars / originalChars) * 100, 2)
      : 0,
    removedBlocks,
    removedLines,
    messageCount: active.length,
  };
}
