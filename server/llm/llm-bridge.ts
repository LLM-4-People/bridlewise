import { messagesToResponseInput } from "../../engine/src/shared/llm/response-transcript.ts";
/**
 * LLM bridge — wires the web UI to the integration/ harness's SharedLLMClient.
 *
 * WHERE THE PROVIDER COMES FROM: the caller's database record, and nowhere
 * else. This bridge used to read `a local operator config` for the
 * base URL and the API key, and `serverConfig.defaultModel` for the model —
 * two fallback sources that answered questions the user thought they had
 * answered in Settings. Both reads are gone, and the deletion is held in place
 * by the signature rather than by anybody's memory: this module cannot build a
 * client without a `ProviderCredential`, and `server/providers.ts` is the only
 * thing in the process that can produce one. There is no file it could read
 * that would give it a value of that type.
 *
 * The model is likewise not defaulted here. `credential.modelId` is whatever
 * the provider resolution already decided — the request, the chat's saved
 * model, or the user's stored default — so a model can no longer be silently
 * substituted between the picker and the request that leaves this process.
 */

import { performance } from "node:perf_hooks";

import { fetchProviderModels, SharedLLMClient, type StreamChunk, type ProviderRequestOptions, type ToolCall } from "../../engine/src/shared/llm/client.ts";
import { InvalidResponseError, TruncationError, isLLMError, MISALIGNMENT_POLICY_ERROR_CODE, type ErrorType } from "../../engine/src/shared/llm/errors.ts";
import type { ChatMessage } from "../kernel/canonical.ts";
import type { ResponseRequestFor } from "../../engine/src/shared/llm/responses-endpoints.ts";
import { toolsToResponses } from "../../engine/src/shared/llm/responses.ts";
import { admitEndpointCredential, admitMintedCredential, type ProviderEndpointCredential, type ProviderCredential } from "./providers.ts";
import { parseJsonLoose, parseJsonObjectExact } from "../../engine/src/text/json-repair.ts";
import { editorState } from "../../engine/src/shared/exposure/registrations/editor.ts";
import type { ProviderDiscoveryResult, DiscoveredProviderModel, ProviderTestFailureKind, ProviderTestResult } from "../../shared/wire-types.ts";
import { serverConfig, llmFixturesEnabled } from "../kernel/config.ts";
import { buildStreamModelEvents } from "./fixtures.ts";
import { recordLlmCall, recordLlmCancellation } from "../observability/metrics-recorder.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { bestEffort, recordEffectAsync, generateId, startResourceDeltaProbe } from "../kernel/canonical.ts";
import type { ModelEvent, Usage, ToolDefinition } from "../kernel/canonical.ts";
import type { EffectDocument, ResourceDelta } from "../kernel/canonical.ts";
// The server's digest owner: every document digest this bridge stamps is
// computed here, in the one place that owns "hash text the way the harness
// hashes text", so a stored digest is recomputable by every other reader.
import { sha256 } from "../kernel/digest.ts";
// The payload-capture switch, from the config accessor owner (never
// process.env, never a local default).
import { captureProviderPayloadsEnabled, performanceResourceDeltasEnabled, getPrivacyPolicy, getResponsesTransportSettings } from "../kernel/harness-config.ts";
import {
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
} from "../../shared/constants.ts";
// Web display/probe redaction remains here; native request privacy is owned by the client mint.
import {
  redactTurnTogether,
  redactContent,
  redactToolCallArguments,
  countMaskedValues,
  summarizeRedactions,
  type RedactionNotice,
} from "./redaction.ts";
import { createTemplateTokenFilter } from "./template-tokens.ts";
// Dedup owner: the LLM bridge is the CHOKE POINT
// for dedup too — `buildNativeRequest` applies `dedupContentForLLM` to every
// message's private content before native preparation, so NO caller can bypass the dedup
// (same lowest-level enforcement pattern as PII redaction). The dedup
// reduces tokens sent to the LLM by removing near-duplicate blocks (the
// kept blocks are exact — lossless for the kept content). The dedup is
// opt-in via `memory.dedupCompression.llmInputDedup` and is a
// no-op when disabled. The dedup stats are returned to the caller via the
// `onDedup` callback so the run route can emit a `dedup` SSE event.
import { dedupContentForLLM, summarizeDedupReports, type DedupReport } from "../awareness/dedup-bridge.ts";

// ToolDefinition is re-exported from the SINGLE canonical hub (canonical.ts)
// — NOT re-exported here. tools-bridge.ts (the manifest owner) imports it
// from canonical.ts; llm-bridge imports it above for its own `tools?` field.
// This avoids the prior scattered re-export (canonical.ts AND llm-bridge
// both re-exported it — one owner).
// Re-export ChatMessage and ToolCall so the run handler can construct
// tool-call conversation history entries (assistant messages with
// tool_calls, tool result messages with tool_call_id).
export type { ChatMessage };
export type { ToolCall };

// ── Configurables ──

const PROTOCOL = "openai-chat-completions" as const;
// The fixture fallback is owned by the centralized server config
// (HARNESS_WEB_LLM_FIXTURES), not read here from process.env directly.

// ── LLM client cache ──

/**
 * One client per (provider, model, base URL, key, headers) so the circuit
 * breaker, the concurrency queue and the call stats accumulate across
 * requests instead of resetting on every turn.
 *
 * THE KEY IS PART OF THE IDENTITY, AND THAT IS THE ROTATION FIX. The previous
 * cache held a single client keyed on the model name alone, so a user who
 * corrected a mistyped API key kept talking to a client built from the wrong
 * one until the server restarted — the correction appeared to be saved and
 * changed nothing. The stored key is compared, never logged and never
 * returned; a changed key simply misses the cache and rebuilds. The custom
 * headers are part of the same identity for the same reason: editing a
 * header without this would leave the old client answering for the new
 * configuration, the key-rotation bug wearing a second hat. The fingerprint
 * is compared, never logged.
 *
 * Distinct settings retain distinct clients until explicit reset so an older
 * client does not lose its active response ownership on reconfiguration.
 */
const clients = new Map<string, { client: SharedLLMClient; apiKey: string; headersFingerprint: string }>();

/**
 * The connection probe's OWN client cache — the probe is deliberately
 * SINGLE-SHOT, so it cannot share the run clients (whose retry budget and
 * backoff are right for a run and wrong for a button). Same identity key as
 * the run cache (key + headers are part of the probe's identity for the same
 * rotation reason), and cleared by the same `resetProviderClients` so a probe
 * client cannot outlive the provider row it was built from.
 */
const probeClients = new Map<string, { client: SharedLLMClient; apiKey: string; headersFingerprint: string }>();

/**
 * NO RETRIES, by disposition over the engine's closed error vocabulary: the
 * `test` verb's own title promises ONE real request, and the honest failure
 * of that one request is the first attempt's own error. A retrying probe
 * reported the retry LAYER's phrasing instead ("retry cancelled by caller" —
 * the abort of the button's own timeout surfacing as the answer), so a user
 * who mistyped the address read that THEY cancelled, when the truth was that
 * the address does not resolve. TOTAL over `ErrorType` on purpose: a new
 * error type without a zero here is a compile error, never a silently
 * retrying probe.
 */
const PROBE_MAX_RETRIES = {
  "rate-limit": 0,
  server: 0,
  network: 0,
  auth: 0,
  "bad-request": 0,
  "model-not-found": 0,
  "context-too-long": 0,
  truncation: 0,
  "invalid-response": 0,
  timeout: 0,
  "empty-response": 0,
  streaming: 0,
  overloaded: 0,
} satisfies Record<ErrorType, number>;

function getClient(credential: ProviderCredential): SharedLLMClient {
  return clientFor(credential, clients, undefined);
}

function getProbeClient(credential: ProviderCredential): SharedLLMClient {
  return clientFor(credential, probeClients, PROBE_MAX_RETRIES);
}

/**
 * The one client constructor, shared by the run cache and the probe cache so
 * the mint choke point, the identity key and the headers seam cannot drift
 * between them. `maxRetries` is the only deliberate difference: undefined
 * keeps the engine's defaults (the run path); a table zeroes them (the
 * single-shot probe).
 */
function clientFor(
  credential: ProviderCredential,
  cache: Map<string, { client: SharedLLMClient; apiKey: string; headersFingerprint: string }>,
  maxRetries: Readonly<Record<ErrorType, number>> | undefined,
): SharedLLMClient {
  // MEMBERSHIP, NOT SHAPE. An object spread copies the brand symbol with no
  // cast and keeps the genuine key closure while pointing baseUrl anywhere —
  // so before a credential becomes a network client, the mint's own WeakSet
  // is consulted and a copy the mint never made is a typed refusal. This is
  // the one door `streamChat`, the run path and `testProviderConnection`
  // build clients through, which is what makes it the choke point.
  admitMintedCredential(credential);
  const apiKey = credential.apiKey(), headers = credential.headers();
  const responses = getResponsesTransportSettings();
  const requestDefaults = {
    ...(credential.model.maxTokens === undefined ? {} : { max_output_tokens: credential.model.maxTokens }),
    ...(credential.model.temperature === undefined ? {} : { temperature: credential.model.temperature }),
  };
  const headersFingerprint = JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
  // Private qualification includes credential rotation and transport/default settings.
  // Old entries remain owned until explicit reset; replacing one would discard active responses.
  const cacheKey = sha256(JSON.stringify([credential.providerId, credential.modelId, credential.baseUrl, credential.allowPrivateAddress, apiKey, headersFingerprint, responses, requestDefaults]));
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.apiKey === apiKey && cached.headersFingerprint === headersFingerprint) {
    return cached.client;
  }
  // THE SEAM where the stored headers reach the engine. `SharedLLMClient`
  // merges `headers` over its base set on every request
  // (`shared/llm/client.ts` `sendRequest`), so a header the user saved in
  // Settings is on the wire for the run, the stream and the connection test
  // alike — there is no second engine config this could be left out of.
  const client = new SharedLLMClient({
    baseUrl: credential.baseUrl,
    allowPrivateAddress: credential.allowPrivateAddress,
    providerId: credential.providerId,
    apiKey,
    model: credential.modelId,
    headers, requestDefaults, responses,
    ...(maxRetries !== undefined ? { maxRetries, timeout: serverConfig.providerTestTimeoutMs } : {}),
  });
  cache.set(cacheKey, { client, apiKey, headersFingerprint });
  return client;
}

/**
 * Drop every cached client, the probe's included. Called when a provider is
 * edited or removed so a client built from a deleted provider cannot
 * outlive it.
 */
export function resetProviderClients(): void {
  clients.clear();
  probeClients.clear();
}

// The result shape is declared once in `shared/wire-types.ts` and imported
// by both sides, so a field added here cannot silently diverge from what the
// client reads. Re-exported for callers that already import from this module.
export type { ProviderTestFailureKind, ProviderTestResult };

/**
 * ASK THE PROVIDER, FOR REAL — ONCE.
 *
 * The whole value of a connection test is that it is not a simulation: a
 * mistyped key, a base URL pointing at nothing, an endpoint that speaks a
 * different protocol and a host that is simply down all fail differently, and
 * only an actual request tells them apart. So this sends one, through the
 * same `SharedLLMClient` a run uses, to the same address, with the same key —
 * if this succeeds and a run then fails, the difference is not the credential.
 *
 * One short prompt and a bounded output allowance leave room for a reasoning
 * model to reach its answer. A one-token limit can exhaust the budget before
 * content starts even when the endpoint and credential work correctly.
 *
 * EXACTLY ONE ATTEMPT (the probe client is built with a zeroed retry table),
 * because the verb's own title says "sends one real request" and the honest
 * failure of one request is that attempt's own error. The shared client's
 * retry-with-backoff is right for a run and wrong for a button: a retrying
 * probe hit the button's own timeout mid-backoff and reported the retry
 * layer's internal cancellation ("retry cancelled by caller") as the verdict,
 * so a user who mistyped the address read that THEY cancelled, when the
 * truth was that the address does not resolve. The single attempt also
 * names the failure class honestly: the first error IS what happened.
 *
 * `failureKind` carries that class in the wire's closed vocabulary (the
 * TOTAL map beside it), so the settings sentence can say "the endpoint did
 * not answer" for a dead address and "refused" for a live one that said no.
 *
 * The failure text is the PROVIDER's, passed through rather than replaced with
 * a house phrase — "invalid_api_key" from the endpoint tells the user more
 * than "connection failed" ever could. It is bounded by the same cap the
 * streaming error path uses so a hostile endpoint cannot return a megabyte,
 * and it goes out through the redaction layer's knowledge of this key: the
 * credential registered itself when it was minted, so a provider that echoes
 * the key back into its own error cannot smuggle it into this response.
 */
const PROBE_FAILURE_KIND: Readonly<Record<ErrorType, ProviderTestFailureKind>> = Object.freeze({
  "rate-limit": "refused-request",
  server: "refused-request",
  network: "no-answer",
  auth: "refused-key",
  "bad-request": "refused-request",
  "model-not-found": "refused-request",
  "context-too-long": "refused-request",
  truncation: "output-limit",
  "invalid-response": "invalid-response",
  timeout: "no-answer",
  "empty-response": "invalid-response",
  streaming: "refused-request",
  overloaded: "refused-request",
});

/** One authenticated catalog request; no completion, persistence or retry. */
/**
 * Ask a provider address for its models, under the destination rule the
 * credential was minted with (a non-admin's may not reach loopback or LAN
 * addresses unless an admin allows it — secb-security SECB-V-16; the same
 * rule the connection test and every run follow).
 */
export async function discoverProviderModels(credential: ProviderEndpointCredential, signal?: AbortSignal): Promise<ProviderDiscoveryResult> {
  admitEndpointCredential(credential);
  try {
    const result = await fetchProviderModels({ baseUrl: credential.baseUrl, apiKey: credential.apiKey(), headers: credential.headers(),
      providerId: credential.providerId, timeoutMs: serverConfig.providerTestTimeoutMs, maxBytes: serverConfig.providerDiscoveryMaxBytes,
      transport: getResponsesTransportSettings(), allowPrivateAddress: credential.allowPrivateAddress, ...(signal === undefined ? {} : {signal}) });
    if (typeof result !== "object" || result === null || !("data" in result) || !Array.isArray(result.data)) {
      throw new InvalidResponseError("The models endpoint did not return a data list.");
    }
    const models: DiscoveredProviderModel[] = [];
    const ids = new Set<string>();
    for (const row of result.data) {
      if (typeof row !== "object" || row === null || typeof row.id !== "string" || row.id.trim() === "") {
        throw new InvalidResponseError("The models endpoint returned an entry without a model ID.");
      }
      if (ids.has(row.id)) continue;
      ids.add(row.id);
      // These optional Runinfra fields are not part of generic OpenAI /models.
      // Ignore absent/invalid extensions instead of inventing model limits.
      models.push({ id: row.id,
        ...(Number.isSafeInteger(row.context_window) && row.context_window > 0 ? { contextWindow: row.context_window } : {}),
        ...(Number.isSafeInteger(row.max_output_tokens) && row.max_output_tokens > 0 ? { maxTokens: row.max_output_tokens } : {}) });
    }
    return { ok: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, failureKind: isLLMError(err) ? PROBE_FAILURE_KIND[err.errorType] : "unexpected",
      detail: (redactTurnTogether([message]).redacted[0] ?? message).slice(0, getResponsesTransportSettings().maximumErrorMessageCharacters) };
  }
}

export async function testProviderConnection(
  credential: ProviderCredential,
): Promise<ProviderTestResult> {
  const startedAt = performance.now();
  try {
    const client = getProbeClient(credential);
    // The fixed ping uses ordinary privacy admission and a bounded allowance.
    const result = await client.create({ model: credential.modelId, input: "ping", max_output_tokens: serverConfig.providerTestMaxTokens, store: false }, { privacy: { policy: getPrivacyPolicy() } });
    try {
      if (result.status === "incomplete" && result.response.incomplete_details?.reason === "max_output_tokens") {
        throw new TruncationError("The provider exhausted the probe's output allowance before answering.");
      }
      const answered = result.response.output.some(item => item.type === "message" &&
        (item.phase == null || item.phase === "final_answer") && (item.status == null || item.status === "completed") &&
        Array.isArray(item.content) && item.content.some(part => typeof part === "object" && part !== null &&
          "type" in part && part.type === "output_text" && "text" in part && typeof part.text === "string" && part.text.trim().length > 0));
      if (result.status !== "completed" || !answered) throw new InvalidResponseError("The provider did not complete the probe with a final answer.");
    } finally {
      // The probe does not retain a resumable conversation. Retire only local
      // ownership; this does not claim that outstanding remote work stopped.
      client.retireResponse(result.response.id, result.provider);
    }
    return { ok: true, elapsedMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failureKind: isLLMError(err) ? PROBE_FAILURE_KIND[err.errorType] : "unexpected",
      detail: (redactTurnTogether([message]).redacted[0] ?? message)
        .slice(0, getResponsesTransportSettings().maximumErrorMessageCharacters),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }
}

// ── ModelEvent mapping ──

export type StreamChatOptions = Readonly<{
  /**
   * WHO TO TALK TO AND AS WHAT MODEL — required, and obtainable only from
   * `server/providers.ts`, which reads the database.
   *
   * Required rather than optional on purpose. An optional credential would
   * re-open the exact hole this closed: the call site could omit it and
   * something downstream would have to invent a provider, which is a fallback
   * source however politely it is written. Omitting it is now a compile
   * error at the one door, so there is no forgetting to remember.
   */
  credential: ProviderCredential;
  signal?: AbortSignal;
  /** Private control handle; never included in public metadata. */
  onResponseReceipt?: ProviderRequestOptions["onResponseReceipt"];
  maxTokens?: number;
  temperature?: number;
  /** Tool definitions passed to the model so it can emit tool calls. */
  tools?: readonly ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  /** System prompt providing project context, tool descriptions, and instructions. */
  systemPrompt?: string;
  /** Full conversation history (multi-turn). Accepts the full ChatMessage
   * type so it can include assistant messages with tool_calls and tool
   * result messages (role: "tool" with tool_call_id). When provided, the
   * single `prompt` arg is appended as the latest user message — UNLESS
   * `prompt` is empty, in which case no user message is appended (used
   * for follow-up turns after tool calls where the tool results ARE the
   * new input). */
  conversationHistory?: readonly ChatMessage[];
  /** Receives non-ModelEvent metadata (response headers, actual model) as
   * the stream yields them. These are NOT ModelEvents (the canonical
   * ModelEvent schema is closed and lives in the read-only canonical
   * repo), so they are forwarded out-of-band via this callback. The run
   * route sends them to the client via a separate "metadata" SSE event
   * so the UI can show them in a collapsible "Headers" section. */
  onMetadata?: (meta: Readonly<{ headers?: Readonly<Record<string, string>>; model?: string }>) => void;
  /** Receives the LLM-input dedup summary when dedup is applied. The summary carries the total char reduction, removed
   * blocks/lines, and message count across all messages in this LLM call.
   * Called ONCE per `streamChat` invocation (after `buildNativeRequest`
   * dedupes the system prompt + history + user prompt). Null when dedup
   * is disabled or removed nothing — the callback is NOT invoked in that
   * case (no noisy no-op events). The run route emits a `dedup` SSE event
   * from this callback so the user sees the dedup working. */
  onDedup?: (summary: Readonly<{
    applied: boolean;
    originalChars: number;
    dedupedChars: number;
    charReductionPct: number;
    removedBlocks: number;
    removedLines: number;
    messageCount: number;
  }>) => void;
  /** THE MODEL'S INPUT WAS CHANGED, AND THE USER GETS TO KNOW.
   *
   * Invoked once per `streamChat`, and ONLY when the choke point actually
   * masked something. Redaction is a silent rewrite of what the model sees;
   * a silent rewrite the user cannot find out about is the failure mode this
   * callback exists to remove. The run route turns it into a `redaction` SSE
   * event, exactly as `onDedup` becomes a `dedup` event. */
  onRedaction?: (notice: RedactionNotice) => void;
}>;

/**
 * THE ROLES LLM-INPUT DEDUP MAY REWRITE — conversation content, and nothing
 * else (prompt-registry F-PR-9 and its amendment: dedup never rewrites a
 * registry-rendered role — instructions, notices, the tail frame). Deny by
 * default: a role not listed here (the system prompt, a future `developer`
 * notice) goes on the wire exactly as rendered (a2b-design M13: the rule was
 * a denylist of `system` alone).
 */
const DEDUPABLE_ROLES: ReadonlySet<string> = new Set<ChatMessage["role"]>(["user", "assistant", "tool"]);

/** Assemble PRIVATE native input. The client alone prepares, redacts and mints actual attempts. */
export function buildNativeRequest(prompt: string, options: StreamChatOptions): {
  request: ResponseRequestFor<"create">; context?: unknown; dedupReports: (DedupReport | null)[]; maskedUpstream: number;
} {
  const originals: ChatMessage[] = [
    ...(options.systemPrompt ? [{ role: "system" as const, content: options.systemPrompt }] : []),
    ...(options.conversationHistory ?? []),
    ...(prompt ? [{role: "user" as const, content: prompt}] : []),
  ];
  const dedupReports: (DedupReport | null)[] = [];
  let changed = false;
  const messages = originals.map(message => {
    // The system prompt goes on the wire EXACTLY as rendered (prompt-registry
    // F-PR-9): dedup rewrote it, so the text sent differed from the rendered,
    // versioned text (the attribution broke) and the cached prefix moved.
    // Dedup is for conversation content, never for the instructions.
    if (!DEDUPABLE_ROLES.has(message.role)) return message;
    const {content, report} = dedupContentForLLM(message.content);
    dedupReports.push(report); changed ||= content !== message.content;
    return {...message, content};
  });
  return { request: {
    model: options.credential.modelId, input: messagesToResponseInput(messages), store: false,
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools?.length ? { tools: toolsToResponses(options.tools), tool_choice: options.toolChoice ?? "auto" } : {}),
  }, ...(changed ? {context: { input: messagesToResponseInput(originals) }} : {}), dedupReports,
    maskedUpstream: originals.reduce((count, message) => count + countMaskedValues(message.content), 0) };
}

/**
 * How one provider stream ended, for the effect record. Settled exactly once
 * per stream (first settlement wins — `Promise` resolution is idempotent).
 *
 * `documents` carries the provider interaction captured at the two choke
 * points (the actual client request observation, the assembled
 * response from the stream consumer) so the interaction lands on the SAME
 * ledger event as the call's duration and outcome.
 */
type ProviderStreamSettlement = Readonly<{
  failed: boolean;
  /**
   * A finer outcome word the binary failed/succeeded classification cannot
   * say: a stream cancelled before its natural end (aborted by the run's
   * signal, or abandoned by its consumer) is NOT a failure — the server did
   * not fault, the work simply stopped — and recording it as `succeeded`
   * (the old `finally` behaviour) or `failed` (a plain throw classification)
   * would each lie in one direction. `cancelled` is the ledger registry's
   * own word, and its failure-disposition entry says a cancel is not a
   * failure verdict. Absent on the normal paths, deferring to `failed`.
   */
  outcome?: "cancelled";
  message?: string;
  code?: string;
  documents?: readonly EffectDocument[];
}>;

/**
 * RECORDING CHOKE POINT for the `llm` effect kind: pass the provider's chunk
 * stream through here and consuming it IS recording it.
 *
 * ONE effect per provider call — never per token. The effect starts when the
 * consumer pulls the first chunk (which is when the underlying HTTP request
 * is driven) and settles when the stream ends, errors, or is abandoned, so
 * `durationMs` is the real measured wall time of the provider call.
 *
 * `recordEffectAsync` cannot wrap an async GENERATOR directly (it records
 * when a promise settles; a generator's promise of work has no single
 * settle), so the wrapper hands it a deferred that this generator settles
 * from its own control flow:
 *   - provider error → settled FAILED with the real message/code, rethrown
 *     unchanged so `streamChat`'s error handling is untouched;
 *   - ABORT or consumer abandonment (an early `break`/`return()` runs the
 *     generator's `finally` without the loop ever completing) → settled
 *     CANCELLED — its own honest outcome, not the `succeeded` the bare
 *     `finally` used to record for a stream that was cut short;
 *   - normal end → settled succeeded. The catch settles first on a failure,
 *     and first settlement wins.
 *
 * `isCancelled` (optional) is read at settlement: when the run's abort
 * signal fired, the stream was cancelled whatever error shape the provider
 * surfaced (some wrap the abort in their own error type), so the
 * classification trusts the signal over the error's name. An abort-shaped
 * error alone (name `AbortError`) also classifies as cancelled for callers
 * that pass no signal reader.
 *
 * The `void` is deliberate: the recording promise resolves when the deferred
 * does and can never reject (the deferred is only ever resolved), so nothing
 * is dropped — awaiting it would deadlock the stream against its own record.
 *
 * Exported for the mechanical prevention test (which drives a controlled
 * stream through the REAL wrapper into the REAL ledger); production reaches
 * it only through `streamChat`, which is guarded by the same test.
 *
 * `captureDocuments` is the response half of the payload capture: a getter
 * the consumer (streamChat) supplies, read ONCE at settlement. It works
 * because of generator ordering — the consumer's body for the LAST yielded
 * chunk runs before this generator's `finally`, so the accumulated response
 * is complete when the getter runs, on the success path, the error path
 * (partial response, honestly captured) and consumer abandonment alike. A
 * broken getter costs the documents, never the work.
 *
 * `argsOf` is the invocation half: a getter (supplied by streamChat) read
 * once at emit time through the wrapper's `argsOf` option, carrying the model
 * id + the generation options WITHOUT the messages — the messages are already
 * captured whole by the request document, so duplicating them here would
 * double the ledger cost of every call for no new answer.
 */
export async function* recordProviderStream<T>(
  model: string,
  stream: AsyncIterable<T>,
  captureDocuments?: () => readonly EffectDocument[],
  argsOf?: () => unknown,
  isCancelled?: () => boolean,
): AsyncGenerator<T, void, unknown> {
  let settle: (s: ProviderStreamSettlement) => void = () => {};
  const settled = new Promise<ProviderStreamSettlement>((res) => { settle = res; });
  void recordEffectAsync("llm", model, () => settled, {
    outcomeOf: (s) => s.outcome,
    failedWhen: (s) => s.failed,
    errorOf: (s) => ({
      message: s.message ?? "provider stream failed",
      code: s.code ?? "llm_stream_error",
    }),
    documentsOf: (s) => s.documents,
    ...(argsOf !== undefined ? { argsOf } : {}),
  });
  // Computed at most once, even though `settle` may be reached twice (the
  // catch settles failed and rethrows; the `finally` then settles success,
  // which first-wins ignores). Redaction over a large response is real work;
  // paying it twice on the error path would be waste, not diligence.
  let captured: readonly EffectDocument[] | undefined;
  const documentsForSettlement = (): readonly EffectDocument[] | undefined => {
    // A failed capture costs the documents, never the settlement; it reports once, centrally.
    if (captured === undefined && captureDocuments !== undefined) captured = bestEffort(captureDocuments);
    return captured;
  };
  const CANCELLED_SETTLEMENT = (): ProviderStreamSettlement => ({
    failed: false,
    outcome: "cancelled",
    message: "the provider stream was cancelled",
    code: "llm_stream_cancelled",
  });
  // Set only when the loop completes NATURALLY — the one fact that separates
  // a served-out stream from one abandoned mid-flight (a consumer `break` or
  // `return()` runs this generator's `finally` without the loop finishing).
  let completedNaturally = false;
  try {
    for await (const chunk of stream) yield chunk;
    completedNaturally = true;
  } catch (err) {
    const docs = documentsForSettlement();
    const aborted = isCancelled?.() === true
      || (err instanceof Error && err.name === "AbortError");
    settle({
      ...(aborted
        ? CANCELLED_SETTLEMENT()
        : {
            failed: true,
            message: err instanceof Error ? err.message : String(err),
            ...(typeof (err as { code?: unknown } | null)?.code === "string" ? { code: (err as { code: string }).code } : {}),
          }),
      ...(docs !== undefined ? { documents: docs } : {}),
    });
    throw err;
  } finally {
    const docs = documentsForSettlement();
    const settlement = completedNaturally
      ? { failed: false as const, ...(docs !== undefined ? { documents: docs } : {}) }
      : CANCELLED_SETTLEMENT();
    settle(settlement);
  }
}

/**
 * Stream a chat completion as an async generator of `ModelEvent`s.
 *
 * Maps the SharedLLMClient's `StreamChunk` stream to the web UI's `ModelEvent`
 * schema so the SSE stream and DB persistence work unchanged.
 *
 * When `systemPrompt` is provided, it is prepended as a `system` message so the
 * model receives project context, available tools, and instructions. When
 * `conversationHistory` is provided, the full multi-turn history is sent as
 * proper `ChatMessage[]` (preserving role distinctions) instead of a flattened
 * text blob. `buildNativeRequest` assembles private input; the client's sole
 * mint applies the actual attempt's privacy context before dispatch.
 */
export async function* streamChat(
  prompt: string,
  options: StreamChatOptions,
): AsyncGenerator<ModelEvent, void, unknown> {
  // Fixture fallback for tests or when the LLM API is unavailable. The flag
  // is read at call time from the centralized config (HARNESS_WEB_LLM_FIXTURES=1).
  if (llmFixturesEnabled()) {
    // The fixture stream crosses the SAME recording choke point a provider
    // stream does, so the run's llm lane holds an event for every streamed
    // turn — the lane has no hole exactly where "what served this turn" is
    // the question. The args document says HOW it was served
    // (`fixture: true`): the event never claims a provider was called, and
    // a reader can tell a fixture turn from a live one by the args alone.
    yield* recordProviderStream(
      options.credential.modelId,
      fixtureEvents(),
      undefined,
      () => ({ model: options.credential.modelId, fixture: true }),
    );
    return;
  }

  let client: SharedLLMClient;
  try {
    client = getClient(options.credential);
  } catch (err) {
    // A config/client-creation failure (missing/corrupt LLM config) is a REAL
    // server issue and it FAILS. It must never fall back to fixtures.
    //
    // Fabricated output is prohibited: streaming fixture events here puts
    // invented text in front of the user in the exact place a model answer
    // belongs, with nothing to distinguish it from a real one. An earlier
    // revision identified this failure mode ("the user saw fixture events +
    // thought the LLM worked") and responded by adding a warning while still
    // fabricating — which fixed observability for the operator and left the
    // user reading fiction.
    //
    // Deny-by-default at the choke point: surface a typed error event — the
    // same shape the provider-stream failure path below already yields — and
    // stop. The operator still gets the centralized debug record; the user
    // gets the truth. Fixtures remain reachable ONLY through the explicit
    // `llmFixturesEnabled()` opt-in above, never as a silent fallback.
    //
    // THE LANE EVENT: the failed client creation is an llm effect in its own
    // right — the call was ATTEMPTED and the server failed to even build the
    // client, which is precisely the failure the llm lane exists to hold.
    // Recorded through the same wrapper (kind llm, outcome failed, the real
    // error's message) so the lane answers this turn too; the recording
    // promise RESOLVES by construction and can never reject, so the typed
    // error event below remains this path's only failure shape.
    const message = err instanceof Error ? err.message : String(err);
    webWarn(
      "llm-bridge",
      "LLM client creation failed",
      () => ({ model: options.credential.modelId, error: message }),
    );
    void recordEffectAsync("llm", options.credential.modelId, async () => ({ failed: true }), {
      failedWhen: () => true,
      errorOf: () => ({ message, code: "llm_client_unavailable" }),
      argsOf: () => ({ model: options.credential.modelId }),
    });
    yield {
      sequence: 0,
      protocol: PROTOCOL,
      type: "error",
      error: {
        kind: "provider",
        code: "llm_client_unavailable",
        message: message.slice(0, getResponsesTransportSettings().maximumErrorMessageCharacters),
        retryable: false,
      },
    } as const;
    return;
  }
  // NOT DEFAULTED HERE. The credential already carries the model the caller
  // resolved, so the model that leaves this process is the model the picker
  // named — the substitution that used to happen at this line is gone.
  const model = options.credential.modelId;
  const { request, context, dedupReports, maskedUpstream } = buildNativeRequest(prompt, options);
  let requestDocument: EffectDocument | undefined;
  let noticed = false;
  // SPO: emit the dedup summary via the `onDedup` callback so the
  // run route can emit a `dedup` SSE event. `summarizeDedupReports` returns
  // null when no dedup was applied (all reports null) — in that case the
  // callback is NOT invoked (no noisy no-op events).
  if (options.onDedup !== undefined) {
    const summary = summarizeDedupReports(dedupReports);
    if (summary !== null) options.onDedup(summary);
  }
  // PER-ATTEMPT OBSERVATION, folded into ONE span. The shared client retries
  // and fails over INTERNALLY — one provider call is one attempt sequence,
  // and the honest record is ONE llm event carrying how many attempts that
  // sequence took (never one effect per attempt: the volume buys nothing the
  // count does not). The client reports each attempt through its
  // `metricsSink` hook; the count is read at settlement by the args getter,
  // so the recorded `attempts` is the final truth. When the sink never fires
  // (a stream that ended before the client reported, or a client that does
  // not report), the fact was not observed and the field is absent rather
  // than fabricated.
  let attemptCount = 0;

  const transportOptions: ProviderRequestOptions = {
    privacy: { policy: getPrivacyPolicy(), ...(context === undefined ? {} : {context}) },
    onRequest(event) {
      if (captureProviderPayloadsEnabled()) { const contentJson = JSON.stringify(event.request); requestDocument = {name: TIMELINE_LLM_REQUEST_DOCUMENT, contentJson, contentDigest: sha256(contentJson)}; }
      if (!noticed && options.onRedaction) { noticed = true; const notice = summarizeRedactions(event.redactions, maskedUpstream); if (notice !== null) options.onRedaction(notice); }
    },
    ...(options.onResponseReceipt === undefined ? {} : { onResponseReceipt: options.onResponseReceipt }),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    metricsSink: () => { attemptCount += 1; },
  };

  // THE INVOCATION, SMALL. The args document carries the model id and the
  // generation knobs — never the messages (already captured whole by the
  // request document) and never the full tool schemas (the tool NAMES answer
  // "what could it call" without shipping every parameter tree into the
  // ledger). Built once here, read once at stream settlement by the wrapper.
  const generationArgs = {
    model,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    ...(options.tools !== undefined && options.tools.length > 0
      ? { toolNames: options.tools.map((t) => t.function.name) }
      : {}),
  };

  let sequence = 0;
  const responseId = generateId("resp");

  yield {
    sequence: sequence++,
    protocol: PROTOCOL,
    type: "start",
    responseId,
  } as const;

  let outputIndex = 0;
  let finishReason = "stop";
  let usage: Usage | undefined;
  const streamStart = performance.now();
  // The metrics lane's resource measurement: the same shared probe the effect
  // wrapper uses, over the metrics call's own window (the whole stream, from
  // first chunk to settlement). One probe PER STREAM — a module-level one
  // would measure concurrent streams into each other. It is stopped exactly
  // once, by whichever terminal path runs; whether the reading is RECORDED is
  // the resource-deltas gate, applied in `streamResource` below.
  const streamProbe = startResourceDeltaProbe();
  const streamResource = (): ResourceDelta | undefined => {
    const delta = streamProbe.stop();
    return performanceResourceDeltasEnabled() ? delta : undefined;
  };

  /**
   * Pending tool calls tracked across stream chunks. The OpenAI SSE
   * protocol sends tool calls as: tool_call_start (id+name) →
   * tool_call_delta(s) (arguments fragments) → finish (reason:
   * "tool_calls"). There is no explicit "done" event in the stream.
   *
   * FIX we synthesize tool_call_done ModelEvents for each
   * pending tool call when the finish event arrives, so the run
   * handler can execute the tools and feed results back to the LLM.
   * Keyed by the tool call's index (outputIndex in the stream).
   */
  const pendingToolCalls = new Map<number, { callId: string; name: string; argumentsBuffer: string }>();

  // ── THE PROVIDER INTERACTION, CAPTURED AT THE TWO CHOKE POINTS ──────────
  //
  // A developer investigating a past run must be able to read the exact
  // redacted messages the provider received and the response it assembled —
  // the incident this closed had a model burning ~2,700 completion tokens a
  // turn writing file content as assistant TEXT, and nothing anywhere
  // recorded what was actually sent. Both documents ride the provider
  // effect's own ledger event through the recorder's document channel.
  //
  // REQUEST: the actual immutable onRequest projection from the client.
  // This optional completion capture is not a durable pre-dispatch acknowledgement.
  //
  // RESPONSE: accumulated by the consumer loop below (text deltas + the
  // tool-call pairs synthesized at the finish event) and finalized by the
  // getter ONLY at stream settlement — never per chunk. Response text and
  // tool arguments pass through the single redaction owner before the
  // document exists, because the store deliberately does not mask document
  // content: whatever reaches this function is what is stored.
  let responseText = "";
  const completedToolCalls: { name: string; arguments: string }[] = [];
  // THE TEMPLATE-TOKEN CHOKE POINT. Every provider text delta crosses this
  // filter before it becomes a yielded ModelEvent — so the SSE display, the
  // DB-persisted message, the next-turn context and this response document
  // all see the SAME cleaned stream, from ONE owner. A model served with its
  // chat template's control tokens preserved can emit them in its answer
  // (the measured instance: gemma-4-31b's ghost thought channel
  // `<|channel>thought\n<channel|>` persisting into the transcript and then
  // re-entering the context on the next turn). The filter holds back from
  // the last unresolved `<` so a marker split across chunk boundaries still
  // strips; only lattice shapes (`<|name>`, `<name|>`, `<|name|>`) and the
  // empty channel declaration ever match, so HTML, markdown and prose pass
  // through untouched. User text never crosses here: it enters through
  // buildNativeRequest above and is user fact, verbatim.
  const templateTokens = createTemplateTokenFilter();
  // The flush is called from three places that can each be the last one to
  // run: before the finish event (the normal end), inside the document
  // capture (the source settled first — a stream that ended without a
  // finish chunk, or threw), and in this generator's own exit paths. The
  // filter's flush is idempotent, so whichever runs first wins and the
  // others are no-ops; `heldForYield` carries a tail flushed by the CAPTURE
  // (which cannot yield events) until the next event-yielding site releases
  // it, so text stripped at settlement still reaches the transcript, not
  // just the document.
  let heldForYield = "";
  const flushTemplateTokens = (): string => {
    const tail = templateTokens.flush();
    if (tail.length > 0) responseText += tail;
    return tail;
  };
  const captureProviderDocuments = (): EffectDocument[] => {
    // Settled first (a source that ended or threw before a finish chunk):
    // flush NOW so the document's text and trace are complete, and hold the
    // tail for the next event-yielding site — this runs even when document
    // capture is off, because the settlement it answers is real either way.
    heldForYield += flushTemplateTokens();
    if (requestDocument === undefined) return [];
    const response = {
      text: redactContent(responseText),
      toolCalls: [
        ...completedToolCalls,
        ...[...pendingToolCalls.values()].map((tc) => ({
          name: tc.name,
          arguments: redactToolCallArguments(tc.argumentsBuffer),
        })),
      ],
      // THE STRIP IS RECORDED, NEVER SILENT. The document carries what the
      // harness RECORDED — the post-strip text, the honest transcript the
      // user saw and the context will carry — plus the exact fragments that
      // were removed, so the pre-strip text stays recoverable and a reader
      // digging an incident can see the corruption the model emitted.
      ...(templateTokens.stripped.length > 0
        ? { templateTokensStripped: templateTokens.stripped }
        : {}),
    };
    const responseJson = JSON.stringify(response);
    return [
      requestDocument,
      {
        name: TIMELINE_LLM_RESPONSE_DOCUMENT,
        contentJson: responseJson,
        contentDigest: sha256(responseJson),
      },
    ];
  };

  // ── METRICS SETTLEMENT — each terminal path records exactly once, and a
  // cancel is neither a success nor a failure in EITHER lane. The ledger
  // half is settled inside `recordProviderStream` (the cancelled outcome);
  // this is the metrics half, through the collector's own cancellation
  // counter. `metricsSettled` guards the double-record: the abandonment
  // path below fires only when no other path already settled this stream.
  let metricsSettled = false;
  try {
    // The provider stream is consumed THROUGH the recording choke point
    // (`recordProviderStream`), so this call lands in the ledger as one
    // `llm` effect with its real duration, outcome, the captured
    // request/response documents, the attempt count, and — when the stream
    // was aborted or abandoned — the cancelled outcome instead of a
    // fabricated success.
    for await (const chunk of recordProviderStream(
      model,
      client.stream(request, transportOptions),
      captureProviderDocuments,
      () => ({ ...generationArgs, ...(attemptCount > 0 ? { attempts: attemptCount } : {}) }),
      () => options.signal?.aborted === true,
    )) {
      // Forward non-ModelEvent metadata (response headers, actual model)
      // out-of-band via the onMetadata callback. The canonical ModelEvent
      // schema is closed, so these are not emitted as model events; the run
      // route sends them to the client via a separate "metadata" SSE event.
      if (chunk.type === "headers" || chunk.type === "model") {
        options.onMetadata?.(
          chunk.type === "headers"
            ? { headers: chunk.headers }
            : { model: chunk.model },
        );
      }
      const event = mapChunk(chunk, sequence, outputIndex);
      if (event !== undefined) {
        // Track tool calls for tool_call_done synthesis.
        if (event.type === "tool_call_start") {
          outputIndex = Math.max(outputIndex, event.outputIndex + 1);
          pendingToolCalls.set(event.outputIndex, {
            callId: event.callId,
            name: event.name,
            argumentsBuffer: "",
          });
        }
        if (event.type === "tool_call_delta") {
          const pending = pendingToolCalls.get(event.outputIndex);
          if (pending !== undefined) {
            pending.argumentsBuffer += event.argumentsDelta;
          }
        }
        // The assembled response's TEXT, accumulated at the same choke point
        // that yields it to the client — the raw material for the response
        // document, finalized only at stream settlement. The delta crosses
        // the template-token filter FIRST, so what accumulates here, what is
        // yielded below, what persists and what re-enters the next turn's
        // context are all the SAME cleaned stream. A delta the filter holds
        // whole (a marker still forming across a chunk boundary) yields
        // nothing now and reappears when the held candidate resolves; the
        // counter still advances so the next event's sequence is unaffected.
        if (event.type === "text_delta") {
          const clean = templateTokens.push(event.delta);
          sequence = event.sequence + 1;
          if (clean.length === 0) continue;
          responseText += clean;
          yield { ...event, delta: clean };
          continue;
        }
        if (event.type === "finish") {
          // Release everything the filter still holds BEFORE the finish
          // event — a consumer that finalizes the turn on `finish` must see
          // the whole cleaned text, and a tail yielded after it would be
          // text the transcript never absorbs.
          const tail = heldForYield + flushTemplateTokens();
          heldForYield = "";
          if (tail.length > 0) {
            yield {
              sequence,
              protocol: PROTOCOL,
              type: "text_delta",
              outputIndex: 0,
              delta: tail,
            } as const;
          }
          finishReason = event.reason;
          // Synthesize tool_call_done for each pending tool call BEFORE
          // yielding the finish event. The run handler needs the parsed
          // arguments to execute the tool server-side.
          if (event.reason === "tool_calls" && pendingToolCalls.size > 0) {
            for (const [idx, tc] of pendingToolCalls) {
              // THE JSON-REPAIR CHOKE POINT. Every tool-call argument the model
              // emits crosses here, exactly once, before dispatch. A weak model
              // routinely emits almost-JSON (a markdown fence, a raw newline in
              // a string, an unclosed brace, a trailing comma); the
              // `parseJsonLoose` ladder repairs it. A payload that is ALREADY
              // valid JSON is never touched — it parses on the first exact
              // pass, so the repair never mangles valid input (pinned by the
              // json-safety tests). Gated by `editor.jsonRepairEnabled`; when
              // off, a malformed payload surfaces as an error rather than a
              // silent `{}`.
              const raw = tc.argumentsBuffer;
              let parsedArgs: Record<string, unknown> | null = null;
              if (raw.length > 0) {
                if (editorState.jsonRepairEnabled) {
                  // The exact parse first: a payload that is already valid is
                  // parsed once and is not a repair; only what fails it goes
                  // down the repair ladder and counts (a2-design L2: the
                  // valid case used to be parsed twice through a wrapper).
                  const exact = parseJsonObjectExact(raw);
                  const repaired = exact ?? parseJsonLoose(raw);
                  if (repaired !== null) {
                    parsedArgs = repaired as Record<string, unknown>;
                    if (exact === null) editorState.jsonRepairCount += 1;
                  }
                } else {
                  parsedArgs = parseJsonObjectExact(raw);
                }
              } else {
                parsedArgs = {};
              }
              if (parsedArgs === null) {
                // Unparseable even after repair (or repair disabled): surface
                // it via the centralized debug bridge and fall back to `{}` so
                // the run continues (the tool handler validates args + returns
                // a typed error) — never a silent, invisible default.
                webWarn(
                  "llm-bridge",
                  "tool_call arguments JSON could not be parsed (defaulting to {})",
                  () => ({ callId: tc.callId, name: tc.name, repairEnabled: editorState.jsonRepairEnabled }),
                );
                parsedArgs = {};
              }
              // The finalized pair joins the response capture: the RAW
              // arguments buffer (what the provider actually emitted, redacted
              // when the document is built), not the repaired parse — the
              // document is forensic evidence, and the repair ladder's output
              // is already visible in the dispatched tool call.
              completedToolCalls.push({ name: tc.name, arguments: raw });
              yield {
                sequence: sequence++,
                protocol: PROTOCOL,
                type: "tool_call_done",
                outputIndex: idx,
                callId: tc.callId,
                arguments: parsedArgs as Record<string, unknown> as Record<string, never>,
              } as const;
            }
            pendingToolCalls.clear();
          }
        }
        if (event.type === "usage") usage = event.usage;
        sequence = event.sequence + 1;
        yield event;
      }
    }
    metricsSettled = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A CANCELLED STREAM IS NEITHER A SUCCESS NOR A FAILURE. The abort
    // signal fired (or the provider surfaced an abort-shaped error), so the
    // metrics lane counts a cancellation — its own counter — and the error
    // event still tells the client the truth about why the stream stopped.
    const cancelled = options.signal?.aborted === true
      || (error instanceof Error && error.name === "AbortError");
    // Route through the centralized debug bridge so a provider stream
    // failure is visible to the operator when debug is on (the error event
    // is yielded to the client, but the server-side observability requires
    // the debug bridge — zero-overhead when off).
    webWarn("llm-bridge", "LLM stream error", () => ({ model, code: (error as { code?: string } | null)?.code, cancelled, error: message }));
    // The source threw while the filter might still be holding text. The
    // settlement already flushed what it could (recordProviderStream's
    // capture ran before rethrowing) and parked it in `heldForYield`;
    // anything STILL held resolves here. Both pieces are model text, not
    // markers — a marker never survives to this point unresolved — so they
    // are yielded, never dropped: the transcript must not lose real text
    // because the stream died mid-candidate.
    const errorTail = heldForYield + flushTemplateTokens();
    heldForYield = "";
    if (errorTail.length > 0) {
      yield {
        sequence: sequence++,
        protocol: PROTOCOL,
        type: "text_delta",
        outputIndex: 0,
        delta: errorTail,
      } as const;
    }
    yield {
      sequence: sequence++,
      protocol: PROTOCOL,
      type: "error",
      error: {
        kind: "provider",
        code: isLLMError(error) && error.code === MISALIGNMENT_POLICY_ERROR_CODE ? error.code : cancelled ? "llm_stream_cancelled" : "llm_stream_error",
        message: message.slice(0, getResponsesTransportSettings().maximumErrorMessageCharacters),
        retryable: false,
      },
    } as const;
    if (cancelled) {
      recordLlmCancellation(model);
    } else {
      recordLlmCall(model, performance.now() - streamStart, false, undefined, undefined, streamResource());
    }
    metricsSettled = true;
    return;
  } finally {
    // ABANDONMENT — the consumer stopped pulling (the run was stopped, the
    // client disconnected) without the stream ending or throwing: neither
    // the success path nor the catch ran, so this is the one settle left.
    // The LEDGER half recorded `cancelled` inside `recordProviderStream`'s
    // finally; this is the metrics half, once, for the same stream.
    if (!metricsSettled) {
      recordLlmCancellation(model);
      metricsSettled = true;
    }
  }

  // The source ended without a finish chunk — the filter may still hold a
  // candidate that only now resolves (a marker that never completed is
  // model text and flows through; a completed one strips). Yielded BEFORE
  // the synthesized finish for the same reason the in-loop flush precedes
  // the real one: `finish` is where consumers finalize the turn.
  const settledTail = heldForYield + flushTemplateTokens();
  heldForYield = "";
  if (settledTail.length > 0) {
    yield {
      sequence: sequence++,
      protocol: PROTOCOL,
      type: "text_delta",
      outputIndex: 0,
      delta: settledTail,
    } as const;
  }

  // Ensure a finish event is always emitted (the client may not send one
  // on early returns or cancellations).
  if (usage === undefined) {
    yield {
      sequence: sequence++,
      protocol: PROTOCOL,
      type: "finish",
      outputIndex: 0,
      reason: finishReason as "stop" | "length" | "tool_calls" | "content_filter" | "cancelled" | "unknown",
    } as const;
  }

  // Record the LLM call into the metrics collector so the Metrics tab
  // shows real per-model latency histograms (not an idle collector).
  recordLlmCall(model, performance.now() - streamStart, true, undefined, usage !== undefined ? { input: usage.inputTokens, output: usage.outputTokens } : undefined, streamResource());
}

function mapChunk(
  chunk: StreamChunk,
  sequence: number,
  outputIndex: number,
): ModelEvent | undefined {
  switch (chunk.type) {
    case "content":
      return {
        sequence,
        protocol: PROTOCOL,
        type: "text_delta",
        outputIndex: 0,
        delta: chunk.text,
      } as const;
    case "reasoning":
      return {
        sequence,
        protocol: PROTOCOL,
        type: "reasoning_delta",
        outputIndex: 0,
        delta: chunk.text,
      } as const;
    case "tool_call_start":
      return {
        sequence,
        protocol: PROTOCOL,
        type: "tool_call_start",
        outputIndex: chunk.index,
        callId: chunk.id,
        name: chunk.name,
      } as const;
    case "tool_call_delta":
      return {
        sequence,
        protocol: PROTOCOL,
        type: "tool_call_delta",
        outputIndex: chunk.index,
        callId: "",
        argumentsDelta: chunk.arguments,
      } as const;
    case "usage":
      return {
        sequence,
        protocol: PROTOCOL,
        type: "usage",
        usage: {
          inputTokens: chunk.usage.promptTokens,
          outputTokens: chunk.usage.completionTokens,
          totalTokens: chunk.usage.totalTokens,
        },
      } as const;
    case "finish":
      return {
        sequence,
        protocol: PROTOCOL,
        type: "finish",
        outputIndex: outputIndex > 0 ? outputIndex : 0,
        reason: chunk.reason as "stop" | "length" | "tool_calls" | "content_filter" | "cancelled" | "unknown",
      } as const;
    // "model" and "headers" are forwarded out-of-band via onMetadata (the
    // canonical ModelEvent schema is closed and lives in the read-only
    // canonical repo). They are NOT emitted as model events.
    case "model":
    case "headers":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Yield the fixture model events (deterministic) for tests or when the LLM
 * API is unavailable. This keeps the SSE persistence test green without a
 * live LLM and gives the web UI a working demo stream in offline dev.
 */
async function* fixtureEvents(): AsyncGenerator<ModelEvent, void, unknown> {
  for (const event of buildStreamModelEvents()) {
    yield event;
  }
}
