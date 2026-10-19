import { observeResponseProtocol } from "../../engine/src/privacy/responses-observation.ts";
import { messagesToResponseInput, serializeResponseTranscript, contextTurnMessage, bindResponseContext, projectResponseContext } from "../../engine/src/shared/llm/response-transcript.ts";
import { InputError } from "../../engine/src/kernel/errors.ts";
/**
 * Context bridge — the server-side adapter that wires the canonical
 * unified context manager + memory store into the web UI chat pipeline
 *.
 *
 * The unified context manager (EXP316 infinite-context + EXP435 C09+
 * summary) is the SINGLE source of truth for what is sent to the LLM.
 * The run route seeds it with the chat history, adds every turn (user,
 * assistant, tool_calls, tool results), calls `trim` before the token
 * limit, and derives the LLM-visible history via `buildTrimmedHistory`.
 * There is NO parallel raw `conversationHistory` sent to the LLM — the
 * manager owns the trimmed view (DRY). This fixes the
 * 748% context bug where the old manager trimmed its OWN internal state
 * while the raw unbounded history was sent verbatim.
 *
 * 1. `createRunContextManager` builds a per-run unified context
 * manager from the harness config's `memory` section.
 * 2. `buildTrimmedHistory` derives the `ChatMessage[]` actually sent
 * to the LLM from the manager's trimmed state (recent window +
 * pinned + a summary message for older turns), preserving
 * tool_calls/tool_call_id pairing (OpenAI contract).
 * 3. `injectMemoriesIntoPrompt` appends retrieved memory entries to
 * the system prompt so the LLM has cross-run/cross-chat recall.
 *
 * SPO: the dedup-compression adapter has moved to
 * `./dedup-bridge.ts` (the SINGLE web-UI owner of dedup). This
 * module no longer owns dedup functions. The run route + safety route
 * import from dedup-bridge.ts directly.
 *
 * Reuses: `integration/src/memory/unified/unified-context-manager.ts`,
 * `integration/src/memory/unified/unified-config.ts`,
 * `integration/src/memory/memory-types.ts`.
 * No rebuild.
 */

import { createUnifiedContextManager, extractiveSummarizer, type UnifiedContextManager, type ContextToolCall, type ContextRole, type ContextTurn } from "../../engine/src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig, type UnifiedConfig } from "../../engine/src/memory/unified/unified-config.ts";
import { estimateTokens } from "../../engine/src/memory/unified/tokenizer.ts";
import {
  abridgedReference,
  createToolResultStore,
  retrievalRouteFor,
  type RetrievalRoute,
} from "../../engine/src/memory/unified/unified-tool-result-store.ts";
import {
  resolveMemoryConfig,
  isPlainObject,
  type MemoryConfig,
} from "../kernel/canonical.ts";
// PII redaction owner: the
// redaction helpers live in `./redaction.ts` (the single web-UI adapter over
// the canonical `redactForLLMContext`). Imported here so buildTrimmedHistory,
// injectMemoriesIntoPrompt, and the redacting summarizer all route through
// the ONE owner — never redefined ("No Scattered Helpers").
import { redactContent, redactToolCallArguments } from "../llm/redaction.ts";
// SPO: the dedup-compression adapter has moved to `./dedup-bridge.ts`
// (the SINGLE web-UI owner of dedup). This module (the context manager
// owner) no longer owns dedup functions. The run route imports
// `wireDedupForTurn` + `dedupCompressionEnabled` directly from dedup-bridge.ts.
import { getMemoryConfig, getMemoryPreviewMaxChars, getPrivacyPolicy, getResponsesTransportSettings } from "../kernel/harness-config.ts";
import type { ChatMessage } from "../llm/llm-bridge.ts";
import type { ToolDefinition } from "../kernel/canonical.ts";
// context manager owner: the system-prompt assembly is a
// context-manipulation concern (it decides what the LLM sees), so it goes
// through the context owner (this module), NOT ad-hoc in the run route.
// `buildSystemPrompt` (project-context.ts) builds the base prompt; the
// repo-map + memory injections are context enrichments owned here.
import { buildSystemPrompt } from "./project-context.ts";
import { injectRepositoryMapIntoPrompt } from "../intelligence/intelligence-bridge.ts";
import type { ToolManifestEntry } from "../kernel/canonical.ts";

// Re-export the manager type under the name the run route imports, so the
// wiring stays stable. There is ONE context manager now (the unified one) —
// no parallel old implementation.
export type { UnifiedContextManager as ContextManager };
export type { ContextToolCall };

// ── PII redaction before LLM ──────────────────────────────────────
// Every string that leaves the context manager toward the LLM — the trimmed
// history (buildTrimmedHistory), the extractive summary (the summarizer), and
// the injected memories (injectMemoriesIntoPrompt) — is passed through
// `redactContent` (the single web-UI adapter over the canonical
// `redactForLLMContext`). It redacts sensitive VALUES while preserving the
// surrounding identifiers/structure (`const API_KEY = "sk-..."` →
// `const API_KEY = "[REDACTED:credential]"`) so the model still understands
// the code context but never sees raw secrets. The helpers are
// owned by `./redaction.ts` (the single redaction owner — SPO) and imported
// here; `redactToolCallArguments` parses + re-stringifies tool_calls JSON so
// escaped quotes don't break detection. The LLM bridge (`llm-bridge.ts`
// `buildLLMMessages`) applies the SAME redaction at the choke point too —
// defense-in-depth so a caller that bypasses this module is still caught.

/**
 * A redacting extractive summarizer. Wraps the canonical
 * `extractiveSummarizer` so each turn's content is redacted BEFORE the first
 * sentence is extracted — guaranteeing the summary of dropped turns never
 * contains PII from the original content. The summary structure
 * (`[T<n>/<role>] <sentence>`) is preserved; only the secret value is masked.
 */
function redactingSummarizer(
  turns: readonly ContextTurn[],
  maxTokens: number,
  evidence: readonly ContextTurn[],
): { content: string; turnIds: readonly string[] } {
  // ── REDACTED TOGETHER, NOT TURN BY TURN ─────────────────────────────────
  //
  // This mapped `redactContent` over each turn independently, and that is how
  // a password survived into the system prompt PERMANENTLY.
  //
  // A summary is written once and read for the rest of the conversation's
  // life. Redacting turn by turn masked the turn that DECLARED the credential
  // ("my password may be admin44" → `[REDACTED:credential]`) and left the
  // turn that merely mentioned it ("was it admin44 or something else")
  // untouched, because nothing in THAT turn declared anything. The stored
  // summary then contained the live value on one line and the proof it was a
  // password on the line above — and because the declaration had been
  // destroyed at write time, no later pass could ever recover enough context
  // to mask it. Every subsequent turn re-injected it into the system prompt.
  //
  // The canonical native observer reads full private evidence with the display
  // rows being summarized. Declarations in opaque native argument containers
  // therefore protect echoes even while the declaring turn remains pinned.
  const observed = observeResponseProtocol({ input: messagesToResponseInput(evidence.map(turn => contextTurnMessage(turn))),
    display: turns.map(turn => turn.content) }, { policy: getPrivacyPolicy(), limits: getResponsesTransportSettings() });
  if (!isPlainObject(observed) || !Array.isArray(observed.display) ||
      observed.display.length !== turns.length || observed.display.some(content => typeof content !== "string")) {
    throw new InputError("Context summary observation is invalid", "context_summary_observation_invalid");
  }
  const redacted = observed.display;
  const redactedTurns = turns.map((turn, index) => ({ ...turn, content: redacted[index] as string }));
  return extractiveSummarizer(redactedTurns, maxTokens);
}

// ── Config resolution (from the harness config `memory` section) ──

let cachedMemoryConfig: MemoryConfig | undefined;
let cachedUnifiedConfig: UnifiedConfig | undefined;

/**
 * Resolve the MemoryConfig from the harness config's `memory` section. The
 * backend's `resolveMemoryConfig` validates every field (bounds, types) and
 * throws a typed `InputError` on a bad value — so a malformed config fails
 * loudly, not silently. Cached because the config rarely changes within a
 * server lifetime; a config edit is picked up on next process restart (the
 * harness-config reader verifies current file bytes on each acquisition).
 */
export function getResolvedMemoryConfig(): MemoryConfig {
  if (cachedMemoryConfig !== undefined) return cachedMemoryConfig;
  const raw = getMemoryConfig() as Partial<MemoryConfig>;
  cachedMemoryConfig = resolveMemoryConfig({
    ...(typeof raw.contextTokenLimit === "number" ? { contextTokenLimit: raw.contextTokenLimit } : {}),
    ...(typeof raw.trimThreshold === "number" ? { trimThreshold: raw.trimThreshold } : {}),
    ...(typeof raw.recentTurnWindow === "number" ? { recentTurnWindow: raw.recentTurnWindow } : {}),
    ...(typeof raw.shortTermTurnLimit === "number" ? { shortTermTurnLimit: raw.shortTermTurnLimit } : {}),
    ...(typeof raw.longTermFactLimit === "number" ? { longTermFactLimit: raw.longTermFactLimit } : {}),
    ...(typeof raw.searchResultLimit === "number" ? { searchResultLimit: raw.searchResultLimit } : {}),
    ...(typeof raw.summaryMaxTokens === "number" ? { summaryMaxTokens: raw.summaryMaxTokens } : {}),
    ...(typeof raw.contentMaxCharacters === "number" ? { contentMaxCharacters: raw.contentMaxCharacters } : {}),
    ...(typeof raw.maxTagsPerEntry === "number" ? { maxTagsPerEntry: raw.maxTagsPerEntry } : {}),
    ...(typeof raw.maxTopicCharacters === "number" ? { maxTopicCharacters: raw.maxTopicCharacters } : {}),
    // Forwarded as written. The harness-side resolver owns which engine names
    // are real and refuses one it does not know, so a typo fails here with a
    // typed error instead of falling through to a default and reading as
    // applied.
    ...(typeof raw.searchEngine === "string" ? { searchEngine: raw.searchEngine } : {}),
  });
  return cachedMemoryConfig;
}

/**
 * Resolve the `UnifiedConfig` that the unified context manager consumes.
 * Bridged from the harness config's `memory` section — the single source of
 * truth for the context-token limit, trim threshold, recent window, and
 * the summary budget.
 * The unified config's `summaryTokenBudget` maps from the memory
 * section's `summaryMaxTokens` so one knob controls both surfaces.
 */
export function getResolvedUnifiedConfig(): UnifiedConfig {
  if (cachedUnifiedConfig !== undefined) return cachedUnifiedConfig;
  cachedUnifiedConfig = resolveUnifiedConfig(bridgedUnifiedOverrides());
  return cachedUnifiedConfig;
}

/**
 * The harness-config → engine-config mapping, stated once so the per-model
 * override below composes with it rather than restating it (a second
 * spelling of the bridge is the two-lists defect).
 */
function bridgedUnifiedOverrides(): Partial<UnifiedConfig> {
  const mem = getResolvedMemoryConfig();
  return {
    contextTokenLimit: mem.contextTokenLimit,
    trimThreshold: mem.trimThreshold,
    recentTurnWindow: mem.recentTurnWindow,
    summaryTokenBudget: mem.summaryMaxTokens,
  };
}

// ── Per-run context manager factory ──

/**
 * Create a fresh unified context manager for a run. The run route owns the
 * instance, seeds it with the chat history, adds turns as they stream, and
 * derives the LLM-visible history via `buildTrimmedHistory`. The manager
 * trims automatically when the token count crosses the threshold (default
 * 80% of the limit), summarizing older unpinned turns and keeping the
 * recent window + pinned turns verbatim — and keeping every tool_calls
 * group ATOMIC (an assistant + its tool results are kept or dropped
 * together, per the OpenAI contract).
 *
 * `contextTokenLimit` is the ACTIVE MODEL's declared context window, when
 * it has one — the per-model fact the settings room stores. Absent means
 * the model declared nothing, and the harness-wide limit answers (never a
 * guess). The override flows through the engine's own resolver, so every
 * derived fact follows it: the trim threshold, the summary budget's share
 * of the window, and the tool-result LRU floor that couples to the limit
 * are all computed by the same `resolveUnifiedConfig` from the same
 * override — the math is not forked here.
 */
export function createRunContextManager(contextTokenLimit?: number): UnifiedContextManager {
  // The summarizer redacts each turn's content BEFORE extracting the first
  // sentence, so summaries of dropped turns never leak PII. This
  // is the single wiring point for the extractive summarizer — the manager
  // stores raw content (DB/display integrity), but every derived LLM-bound
  // surface (summary + buildTrimmedHistory) is redacted.
  //
  // The `redactContent` topicRedactor (4th arg) applies the SAME redaction
  // BEFORE the C09 conversation-summary topic is extracted.
  // It reuses the canonical `redactForLLMContext` via `redactContent`
  // — one privacy seam, injected (the backend stays decoupled).
  //
  // ── THE TOOL-RESULT STORE, PLUGGED IN ────────────────────────────────────
  //
  // A tool call's `arguments` string is re-emitted into the request on EVERY
  // turn, verbatim, for as long as the turn survives the trim window. For an
  // ordinary tool call that is noise. For `create_artifact` it is the whole
  // document: measured on a real 55 KB artifact, ~14,000 tokens per turn,
  // ~140,000 over ten turns, and at the 512 KB ceiling the product allows,
  // ~131,000 tokens per turn for ONE artifact before the conversation even
  // starts. The second-order harm is worse than the first: the trim evicts by
  // TOTAL tokens, so one enormous immutable blob does not merely cost, it
  // pushes the actual conversation out to make room for itself, every turn.
  //
  // The store is per RUN, not per process: its ids are handed to the model,
  // and an id minted in one conversation must never resolve inside another.
  // Its thresholds come from the resolved config rather than from constants
  // here, so the size at which a payload becomes a reference is a configured
  // value with one owner.
  // The per-model window, when one is declared, resolves through the SAME
  // door the harness-wide config does — composed over the bridged mapping
  // so nothing else about the manager changes when the window does.
  const cfg = contextTokenLimit === undefined
    ? getResolvedUnifiedConfig()
    : resolveUnifiedConfig({ ...bridgedUnifiedOverrides(), contextTokenLimit });
  const toolResults = createToolResultStore(cfg.toolResult);
  return bindResponseContext(createUnifiedContextManager(
    cfg,
    toolResults,
    redactingSummarizer,
    redactContent,
    // ── THE BYTES, AND THEREFORE THE CHARGE ────────────────────────────────
    //
    // Both forms of a tool call's outbound arguments are supplied here, in
    // one object, and the manager chooses between them. The manager then
    // charges `estimateTokens` of whichever string it chose — so the number
    // the trim reasons about and the bytes the provider receives are the
    // same string, produced once.
    //
    // This used to be a function in this module that the emitter called and
    // the accounting did not. The emitter's answer depended on whether the
    // run was sending the retrieval tool; the accounting's did not; and with
    // retrieval switched off the manager priced a 56,181-token request at
    // 249 tokens and never trimmed it.
    //
    // Redaction lives on this side of the seam because it is a web-UI
    // concern, and it is applied to BOTH forms: an abridgement is not an
    // exemption from redaction, and the opening of a document is exactly
    // where a pasted credential tends to sit.
    //
    // AND THE NOTICE DESCRIBES WHAT THE MODEL WILL ACTUALLY GET. The way back
    // (`retrieve_tool_result`) masks the stored copy on its way out with this
    // same function, so the WHOLE form the manager already holds IS, byte for
    // byte, what a retrieval returns. Handing it to the notice-builder is what
    // stopped the notice announcing the stored size and promising nothing had
    // changed while the retrieval delivered a smaller, masked document.
    {
      whole: (tc) => redactToolCallArguments(tc.function.arguments),
      abridged: (entry, route, delivered) =>
        abridgedReference({ ...entry, summary: redactContent(entry.summary) }, route, delivered),
    },
    redactContent,
  ));
}

/**
 * The tool that undoes an abridgement, by the id the manifest registers — so
 * the words the model is given and the capability it actually has are the
 * same fact.
 */
export const RETRIEVE_TOOL_NAME = "retrieve_tool_result";

/**
 * The proven way back for THIS run, or `null` when it is not sending one.
 *
 * The retrieval tool is a normal manifest entry, so an operator's global
 * `tools.enabled` list or a per-user override can switch it off — and an
 * abridgement that names a tool the model has not been given is a fabricated
 * capability, which is a worse defect than the cost abridging saves. The
 * model would be told the document is retrievable, find no such tool, and
 * revise the fragment it can see.
 *
 * So the route is READ from the very manifest the run is about to send, never
 * assumed, and it is carried as a value the notice-builder demands rather
 * than as a boolean somebody has to act on correctly.
 */
export function retrievalRouteFromManifest(tools: readonly ToolManifestEntry[]): RetrievalRoute | null {
  return retrievalRouteFor(tools.map((t) => t.name), RETRIEVE_TOOL_NAME);
}

/**
 * Whether THIS run can honour the way back. Derived from the route rather
 * than answered separately, so there is one predicate and one lookup.
 */
export function retrievalIsAvailable(tools: readonly ToolManifestEntry[]): boolean {
  return retrievalRouteFromManifest(tools) !== null;
}

// ── Seeding + trimmed-history derivation (the single source of truth) ──

/**
 * Map an OpenAI chat role string to the unified context-manager role. The
 * unified manager supports a wider role set; the LLM-facing history only
 * uses system/user/assistant/tool. Unknown roles default to "user" so a
 * persisted oddity never breaks the LLM request.
 */
function toContextRole(role: string): ContextRole {
  switch (role) {
    case "system": return "system";
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool";
    default: return "user";
  }
}

/**
 * Seed the unified context manager with the reconstructed chat history so it
 * knows the existing token pressure BEFORE the first turn. Each `ChatMessage`
 * is added as a turn with its `tool_calls` (assistant) / `tool_call_id`
 * (tool result) preserved, so trimming never orphans a tool_calls group.
 * Empty-content assistant messages that only carry tool_calls are allowed.
 */
export function seedContextManagerFromHistory(
  cm: UnifiedContextManager,
  history: readonly ChatMessage[],
): void {
  bindResponseContext(cm);
  for (const msg of history) {
    const toolCalls = msg.tool_calls as readonly ContextToolCall[] | undefined;
    const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
    // Skip turns with no payload (e.g. an empty assistant turn with no
    // tool_calls) so they do not pollute the manager with zero-content
    // turns that would be rejected by the content validation.
    if (msg.content.length === 0 && !hasToolCalls && msg.tool_call_id === undefined && msg.responseItems === undefined && !msg.responseReplayBlocked) continue;
    cm.addTurn({
      role: toContextRole(msg.role),
      content: msg.content,
      ...(hasToolCalls ? { toolCalls } : {}),
      ...(msg.tool_call_id !== undefined ? { toolCallId: msg.tool_call_id } : {}),
      ...(msg.responseItems === undefined ? {} : { responseItems: msg.responseItems }),
      ...(msg.responseReplayBlocked === undefined ? {} : { responseReplayBlocked: msg.responseReplayBlocked }),
    });
  }
}

/**
 * Derive the `ChatMessage[]` actually sent to the LLM from the unified
 * manager's trimmed state. This is the SINGLE source of truth for the LLM
 * input — the run route never sends a raw unbounded history (the 748% bug).
 *
 * The derived history is:
 * 1. A `system` summary message (the C09 conversation-summary block +
 * the progressive-trim summaries) when any trimming has occurred —
 * so the model retains conversation continuity within budget.
 * 2. The surviving turns (recent window + pinned), mapped back to
 * `ChatMessage` with `tool_calls`/`tool_call_id` preserved so the
 * OpenAI tool_calls pairing contract is never violated.
 */
/**
 * ── WHAT IS RECORDED IS NOT WHAT IS SENT, AND ONLY ONE OF THEM CHANGES ────
 *
 * Abridging happens on the SEND path and nowhere else. The context manager's
 * turns still carry the arguments verbatim, `state()` still hands them back
 * verbatim, and the database row is untouched. Nothing is deleted, summarised
 * in place, or overwritten: the abridgement exists only in the array handed
 * to the provider, and is rebuilt from the full text on every turn. Undoing
 * it is reading the ledger.
 *
 * ── AND THE MODEL IS TOLD ─────────────────────────────────────────────────
 *
 * A silent substitution would be a worse defect than the cost it saves. The
 * model would be handed something that begins exactly like the document and
 * simply stops, with nothing saying it was cut — and would then "revise" the
 * artifact by rewriting the fragment it can see. So the reference states that
 * it is an abridgement, how large the original is, the id that names it, and
 * the exact call that returns it.
 *
 * ── AND IT IS NO LONGER DECIDED HERE ──────────────────────────────────────
 *
 * There used to be an `outboundArguments` in this module holding the second
 * half of one decision: it chose abridged or whole from a `canRetrieve` flag
 * the context manager never saw, while the manager charged for a choice it
 * had made independently. Both halves now live on the manager
 * (`outboundToolCallArguments`), which charges exactly what it returns.
 *
 * ── PRICING AND EVICTING ARE ONE ACT, AND THIS IS THE ONLY PLACE THEY HAPPEN
 *
 * They used to be two calls a caller made in the right order, and the run
 * route made them in the right order exactly once — at the seed. The executor
 * re-reads the tool manifest at every turn boundary and re-derives the history
 * from it, but its `trim()` sat at the END of the turn, priced against the
 * PREVIOUS boundary's manifest. So withdrawing the retrieval tool between two
 * turns — a per-user toggle does it, and so does the breaker, which the
 * retrieval tool can trip by failing on an id that aged out — repriced 4
 * artifacts from 629 tokens to 56,201 and sent them, untrimmed, at 1.72x the
 * limit, with `shouldTrim()` answering TRUE the whole time. The originally
 * filed symptom, arriving through time instead of through configuration.
 *
 * Repeating the seed's two calls at the boundary would have made THREE places
 * that must all remember; two that must both remember was already the defect.
 * So the order is not something a caller performs. Deriving the history IS
 * establishing the manifest, repricing against it, and evicting down to the
 * limit — one expression, in the one function every provider-bound history
 * comes out of, with no ordering left for a future caller to get wrong.
 *
 * Trimming here rather than at the caller is also the only place it is
 * CORRECT to trim: eviction is irreversible, and a turn evicted against a
 * manifest that no request will be sent with is a turn thrown away for a
 * price nobody pays. That is what the seed's trim did whenever the executor
 * later sent a different manifest, and what the compose preview did on every
 * call — it trimmed before it had read the manifest at all, so on the same
 * eight-artifact conversation it kept 7 messages and 519 tokens where the run
 * it claims to mirror keeps 17 and 1,254.
 */
export function buildTrimmedHistory(
  cm: UnifiedContextManager,
  /**
   * The tool manifest this run is SENDING — not a flag about it, and not a
   * declared or default manifest. Defaults to EMPTY so a caller that has not
   * established a way back sends documents whole: the expensive answer, never
   * the dishonest one.
   *
   * Passing it here rather than at the emit site is what keeps the accounting
   * honest. Deriving the history TELLS the manager what this run can honour,
   * so the charge it reports afterwards is a charge for this request rather
   * than for a differently-shaped one.
   */
  tools: readonly ToolManifestEntry[] = [],
): ChatMessage[] {
  cm.setRetrievalRoute(retrievalRouteFromManifest(tools));
  // Priced against the manifest immediately above, then evicted down to the
  // limit, then read — in one place, so no caller can perform the three in
  // another order or leave one of them out.
  cm.trim();
  return [...projectResponseContext(cm)];
}

// ── System-prompt assembly + LLM-input derivation (SPO) ────────────
// The unified context manager owns what is sent to the LLM. Before this
// round, the run route assembled the system prompt AD-HOC via three
// separate calls (buildSystemPrompt → injectRepositoryMapIntoPrompt →
// injectMemoriesIntoPrompt), bypassing the context owner — a SPO violation
// (the context manager was not the single source of truth for the system
// prompt). These two functions are the SINGLE entry points:
// - `assembleSystemPrompt` — the ONE owner of system-prompt assembly
// (project context + repo map + memories). The run route calls this,
// not the three injection functions directly.
// - `buildLLMInput` — the ONE owner of full LLM-input assembly. It
// derives BOTH the system prompt (via assembleSystemPrompt) AND the
// trimmed conversation history (via buildTrimmedHistory) from the
// context manager in a single call, returning the { systemPrompt,
// conversationHistory } pair that streamChat consumes. No route
// builds conversationHistory or systemPrompt directly (SPO: context
// management through ONE owner).

/**
 * The parts needed to assemble the system prompt. The context owner
 * (this module) is the single place that consumes these parts — the run
 * route passes them in, never assembles the prompt itself. `userPromptPrefs`
 * is `unknown` (the raw DB blob) — `buildSystemPrompt` coerces it to
 * `PromptPrefs` internally via `resolvePromptPrefs`, so the caller passes
 * the untrusted DB value and the coercion happens at the single owner.
 */
export type SystemPromptParts = Readonly<{
  readonly projectName: string;
  readonly projectPath: string;
  readonly tools: readonly ToolManifestEntry[];
  readonly userPromptPrefs: unknown;
}>;

/**
 * The full LLM input derived from the context manager — the single shape
 * `streamChat` consumes. Assembled by `buildLLMInput` (the context owner),
 * never built ad-hoc in a route.
 */
export type LLMInput = Readonly<{
  readonly systemPrompt: string;
  readonly conversationHistory: readonly ChatMessage[];
}>;

/**
 * Assemble the system prompt from its parts — the SINGLE owner of system-
 * prompt assembly (SPO). Combines the base project-context prompt,
 * the pre-indexed repository map, and the retrieved memories in ONE place
 * so no route builds the system prompt ad-hoc. The run route calls this
 * (or `buildLLMInput`), never `buildSystemPrompt` +
 * `injectRepositoryMapIntoPrompt` + `injectMemoriesIntoPrompt` directly.
 *
 * The repo-map injection degrades gracefully (when the map is not ready or
 * the path is broken, the prompt is unchanged — honest, no fake section).
 * Memory injection appends a "Recalled context" section only when memories
 * match (no empty section). Both reuse the existing single-owner helpers
 * (`buildSystemPrompt` in project-context.ts, `injectRepositoryMapIntoPrompt`
 * in intelligence-bridge.ts, `injectMemoriesIntoPrompt` below) — this
 * function is the orchestrator, not a reimplementation.
 */
export function assembleSystemPrompt(
  parts: SystemPromptParts,
  memories: readonly RetrievedMemory[],
): string {
  const base = buildSystemPrompt(
    {
      projectName: parts.projectName,
      projectPath: parts.projectPath,
      tools: parts.tools,
    },
    parts.userPromptPrefs,
  );
  const withMap = injectRepositoryMapIntoPrompt(base, parts.projectPath);
  return injectMemoriesIntoPrompt(withMap, memories);
}

/**
 * Build the full LLM input (system prompt + trimmed conversation history)
 * from the context manager in a SINGLE call — the ONE entry point for LLM-
 * input assembly (SPO: "the LLM bridge should receive its input
 * FROM the context manager, not from the route"). The run route calls this
 * and passes the result to `streamChat`; it never builds `conversationHistory`
 * or `systemPrompt` directly.
 *
 * This consolidates the three ad-hoc system-prompt calls + the two
 * `buildTrimmedHistory` calls (one for the SSE event, one for the LLM
 * options) that the run route previously made separately. The trimmed
 * history is derived ONCE from the context manager (the single source of
 * truth) and returned for both the LLM call and the context SSE event.
 * Redaction still happens at the LLM-bridge choke point (`buildLLMMessages`)
 * this function is the context owner, not a second redaction gate.
 */
export function buildLLMInput(
  contextManager: UnifiedContextManager,
  parts: SystemPromptParts,
  memories: readonly RetrievedMemory[],
): LLMInput {
  const systemPrompt = assembleSystemPrompt(parts, memories);
  // The abridgement and the tool that undoes it are decided from ONE fact:
  // the manifest this run is sending, handed over whole.
  const conversationHistory = buildTrimmedHistory(contextManager, parts.tools);
  return { systemPrompt, conversationHistory };
}

// ── Memory injection ──

export type RetrievedMemory = Readonly<{
  id: string;
  content: string;
  tier: string;
  timestamp: string;
  score: number;
}>;

/**
 * Inject retrieved memory entries into the system prompt so the LLM has
 * cross-run/cross-chat recall. The memories are APPENDED after the system
 * prompt as a "Recalled context" section (prompt-registry F-PR-5: three
 * comments said "prepended"). When no memories match, the prompt is
 * returned unchanged (no empty section).
 */
export function injectMemoriesIntoPrompt(
  systemPrompt: string,
  memories: readonly RetrievedMemory[],
): string {
  if (memories.length === 0) return systemPrompt;
  // Memories are redacted per entry before reaching the system prompt.
  //
  // KNOWN GAP, measured and reported rather than papered over: a per-entry
  // pass cannot see the entry beside it. A memory that DECLARES a credential
  // is masked; a sibling memory that merely repeats the value is not, because
  // nothing in that entry declares anything. Redacting the entries TOGETHER
  // here does not fix it either — the memories arrive already masked from the
  // memory WRITE path, so the declaration is gone before this function sees
  // it. The fix belongs at the write path and is not attempted here.
  const previewMax = getMemoryPreviewMaxChars();
  const memoryLines = memories.map((m) => {
    const safeContent = redactContent(m.content);
    const preview = safeContent.length > previewMax ? `${safeContent.slice(0, previewMax)}…` : safeContent;
    return `- [${m.tier}] ${preview.replace(/\n/g, " ")}`;
  });
  return [
    systemPrompt,
    "",
    "## Recalled context (from memory)",
    "The following are relevant entries from prior interactions. Use them if helpful, but prefer current file contents and tool results over stale memory.",
    memoryLines.join("\n"),
  ].join("\n");
}

// ── Dedup/compression (moved to dedup-bridge.ts — SPO) ──
// The dedup-compression adapter (`dedupCompressionEnabled`,
// `ensureDedupLowerLayer`, `wireDedupForTurn`, `dedupContentForLLM`) now lives
// in `./dedup-bridge.ts` — the SINGLE web-UI owner of dedup. This
// module (the context manager owner) no longer owns dedup functions. The
// run route + safety route import from dedup-bridge.ts directly.

// ── truthful context-token reporting ───────────────────────────────
// The "context" SSE event previously reported `contextManager.state.totalTokens`
// (the manager's internal tokenCount: activeTurns + summaryList + the C09
// block). But the tokens ACTUALLY sent to the LLM are `buildTrimmedHistory`
// — which adds the "Prior conversation (summarized)" framing text + maps
// turns back to ChatMessage (with tool_calls overhead). The manager's count
// under-reports by that framing overhead. `estimateHistoryTokens` estimates
// the real sent-token count from the trimmed history so the UI shows the
// truth (reuses the integration's canonical `estimateTokens`).
//
// AND THE MESSAGE CHANNELS ARE NOT THE WHOLE REQUEST EITHER (UIE-054). An
// OpenAI-compatible request carries the tool schemas beside the messages —
// a constant per-call cost the provider bills and counts (measured on this
// install: ~6.8k tokens for 46 schemas, the exact delta between the desk's
// messages-only total and the ledger's per-call prompt). A surface that
// claims "what the next call sends" while counting only the message
// channels understates the real fill by that whole constant. The two
// functions below are the single owners of the missing channels: the
// schemas' own cost, and the full per-request total derived from an
// `LLMInput` + the definitions the request carries.

/**
 * Estimate the token count of the ChatMessage[] actually sent to the LLM.
 * Sums `estimateTokens(content)` for every message plus the tool_calls
 * structure overhead (function name + arguments) for assistant tool_calls
 * messages. The history channel of the request — also served beside the
 * total in the context SSE event, so a reader can tell the history's own
 * pressure apart from the whole request's.
 */
export function estimateHistoryTokens(history: readonly ChatMessage[]): number {
  return estimateTokens(serializeResponseTranscript(history));
}

/**
 * The token cost of the OpenAI tool schemas a request carries — the
 * `tools` array the provider receives beside the messages, measured over
 * the same JSON serialization the wire sends, through the same canonical
 * estimator every other channel uses. The cost is a per-call constant for a
 * given enabled-tool set, which is exactly why it must be counted: it never
 * shrinks the way history can.
 */
export function estimateToolSchemasTokens(defs: readonly ToolDefinition[]): number {
  if (defs.length === 0) return 0;
  return estimateTokens(JSON.stringify(defs));
}

/**
 * The full per-call context cost the request ACTUALLY carries: the
 * assembled system prompt (project context + repository map + recalled
 * memories) + the trimmed conversation history (user, assistant, tool
 * results) + the tool schemas. THE one owner of "what the next call
 * sends" — the context SSE event's `contextTokens` and the desk's
 * per-channel sum both derive from the same channels this counts, never
 * from a subset. Honest calibration: every channel is estimated at
 * characters/4, so the total runs a content-mix-dependent ~8-17% above
 * the provider's own tokenizer (gemma's JSON-dense schemas compress
 * harder than chars/4) — the channel SET is exact, so a delta thousands
 * BELOW the provider's count is the red flag (a channel gone dark), and
 * over-count is the expected error.
 */
export function estimateRequestTokens(
  input: LLMInput,
  defs: readonly ToolDefinition[],
): number {
  return (
    estimateTokens(input.systemPrompt) +
    estimateHistoryTokens(input.conversationHistory) +
    estimateToolSchemasTokens(defs)
  );
}

// (Dedup/compression pipeline wiring moved to dedup-bridge.ts — SPO.)
