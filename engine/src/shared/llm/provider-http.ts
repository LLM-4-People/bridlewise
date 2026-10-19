/**
 * Authenticated provider HTTP lifetime, cancellation and typed failures. Every
 * request goes out through the one outbound HTTP policy
 * (`shared/outbound-http.ts`: no redirects, verified TLS, the cleartext
 * decision, the header allowlist, bounded bodies and deadlines); this module
 * adds the provider's own headers, observation and error taxonomy, and maps
 * the policy's refusals into the LLM error family.
 */
import type { HeldSet } from "../../privacy/held-set.ts";
import { abortableDelay, awaitWithSignal, deadline as requestDeadline } from "../abort-signals.ts";
import { bestEffort } from "../best-effort.ts";
import { guarded } from "../../process/fault-policy.ts";
import { observeResponseEnvelope } from "../../privacy/responses-observation.ts";
import { currentRecordingContext } from "../../timeline/recording-context.ts";
import { providerHeldSet, observeProviderDiagnostic } from "./provider-observation.ts";
import { debugLog } from "../debug/debug-system.ts";
import type { ResponsesTransportConfig } from "./config.ts";
import { classifyProviderFailure } from "./provider-failure.ts";
import { CONTENT_TYPE_JSON } from "../../kernel/contracts.ts";
import { extractErrorMessage, isAbortError } from "../../kernel/errors.ts";
import { parseJsonExact } from "../../kernel/json-integrity.ts";
import { BadRequestError, safeAbortError, InvalidResponseError, isLLMError, LLMError, NetworkError, TimeoutError } from "./errors.ts";
import type { FailoverTarget } from "./failover.ts";
import { cancelBody, dispatchOutboundRequest, isOutboundHttpError, prepareOutboundRequest, readBody, type OutboundHttpError } from "../outbound-http.ts";
/** The central-log category of every provider request and body read. */
export const PROVIDER_LOG_CATEGORY = "llm";
const LOG_CATEGORY = PROVIDER_LOG_CATEGORY;
export type ProviderHttpTarget = Pick<FailoverTarget, "apiKey" | "headers" | "timeoutMs" | "providerId" | "allowPrivateAddress">;
export type ProviderHttpRequest = Readonly<{
  url: string; method: "GET" | "POST" | "DELETE"; accept: string; body?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal | undefined; model?: string; modelOperation?: boolean;
  onAborted?: () => void;
  /** The configured `runtime.responses` transport limits; never serialized into the provider request. */
  transport: ResponsesTransportConfig;
  /** Local observation context; never serialized into the provider request. */
  heldCredentials?: HeldSet;
  observationPrivacy?: import("../../privacy/redacted-messages.ts").RequestRedactionOptions;
  /** Private transport hooks; absent from request bodies and provider protocol. */
  beforeDispatch?: (signal: AbortSignal) => void | Promise<void>;
  onDispatch?: () => void;
}>;
export function checkAborted(signal?: AbortSignal): void { if (signal?.aborted) throw safeAbortError(signal.reason); }
export async function* requestProviderHttp<T>(target: ProviderHttpTarget, request: ProviderHttpRequest,
  consume: (response: Response, signal: AbortSignal, headers: Readonly<Record<string, string>>) => AsyncIterable<T>): AsyncGenerator<T> {
  // A provider key is its USER's: held for this call, never in the
  // process-wide registry (which holds only the harness's own secrets).
  const held = providerHeldSet(target).merge(request.heldCredentials);
  const deadline = requestDeadline(request.signal, target.timeoutMs, () => new TimeoutError("Provider request exceeded its deadline", { timeoutMs: target.timeoutMs }));
  const signal = deadline.signal;
  let response: Response | undefined;
  let dispatched = false;
  const started = performance.now();
  let outcome = "abandoned";
  const logAttempt = (event: string): void => { bestEffort(() => debugLog(LOG_CATEGORY, outcome === "failed" ? "warn" : "debug", event,
    () => observeProviderDiagnostic({ method: request.method, provider: target.providerId, outcome, status: response?.status,
      durationMs: performance.now() - started, ...currentRecordingContext() }, held))); };
  logAttempt("provider_http_started");
  const abort = guarded("llm.provider-http.abort", (): void => { request.onAborted?.(); if (response?.body && !response.body.locked) void cancelBody(() => response!.body!.cancel(), request.transport.cleanupTimeoutMs, LOG_CATEGORY); });
  signal.addEventListener("abort", abort, { once: true });
  try {
    checkAborted(signal);
    // Admitted by the outbound policy BEFORE any observer sees the request:
    // a request that can never be sent is never observed as dispatched.
    const prepared = prepareOutboundRequest({ url: request.url, method: request.method,
      operatorHeaders: target.headers,
      protocolHeaders: { "Content-Type": CONTENT_TYPE_JSON, Accept: request.accept, Authorization: `Bearer ${target.apiKey}` },
      logCategory: LOG_CATEGORY, allowPrivateAddress: target.allowPrivateAddress });
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    await awaitWithSignal(request.beforeDispatch?.(signal), signal);
    checkAborted(signal);
    dispatched = true; request.onDispatch?.();
    response = await dispatchOutboundRequest(prepared, body, signal);
    const responseHeaders = captureResponseHeaders(response, request.transport.maximumResponseHeaderBytes);
    if (!response.ok) await classifyHttpError(response, request, signal, held, responseHeaders);
    yield* consume(response, signal, responseHeaders);
    outcome = "completed";
  } catch (error) {
    outcome = "failed";
    if (signal.aborted) { checkAborted(signal); }
    if (isLLMError(error)) throw error;
    if (isOutboundHttpError(error)) throw outboundRefusal(error);
    if (isAbortError(error)) throw safeAbortError(undefined);
    if (!dispatched) throw new BadRequestError("Provider request preparation failed");
    if (error instanceof TypeError || error instanceof Error && /fetch|econn|enotfound|etimedout|eai_again|socket|network/iu.test(error.message)) throw new NetworkError("Provider network request failed");
    throw new LLMError("Unexpected provider transport failure", "llm_unexpected_error", "invalid-response", false);
  } finally {
    deadline.clear(); signal.removeEventListener("abort", abort);
    logAttempt("provider_http_finished");
    if (response?.body && !response.body.locked) await cancelBody(() => response!.body!.cancel(), request.transport.cleanupTimeoutMs, LOG_CATEGORY);
  }
}
/** The outbound policy's refusals in the provider error family: an oversized body keeps its invalid-response class; every other refusal is a non-retryable bad request carrying the policy's own code. */
function outboundRefusal(error: OutboundHttpError): LLMError {
  if (error.code === "outbound_body_too_large") return new InvalidResponseError("Provider response exceeds its byte bound");
  return new LLMError(error.message, error.code, "bad-request", false, error.safeDetails);
}
export function parseProviderJson(text: string): unknown {
  const parsed = parseJsonExact(text);
  if (parsed === undefined) throw new InvalidResponseError("Provider response is not valid JSON");
  return parsed.value;
}
export function captureResponseHeaders(response: Pick<Response, "headers">, maximumBytes: number): Readonly<Record<string, string>> {
  const entries: [string, string][] = []; let bytes = 2;
  const check = () => { if (bytes > maximumBytes) throw new InvalidResponseError("Provider response headers exceed their byte bound"); };
  check();
  for (const entry of response.headers.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(entry), "utf8") - 2 + (entries.length ? 1 : 0);
    check();
    entries.push(entry);
  }
  return Object.freeze(Object.fromEntries(entries));
}
async function classifyHttpError(response: Response, request: ProviderHttpRequest, signal: AbortSignal, heldCredentials: HeldSet, headers: Readonly<Record<string, string>>): Promise<never> {
  const status = response.status;
  const observeError = (raw: unknown) => observeResponseEnvelope({ headers, response: raw }, { ...request.observationPrivacy, heldCredentials,
    limits: request.transport, selectedHeaders: [], kind: "error" });
  let text: string;
  try { text = await readBody(response, signal, request.transport.maximumResponseBytes, request.transport.cleanupTimeoutMs, LOG_CATEGORY); }
  catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    if (isOutboundHttpError(error) && error.code === "outbound_body_too_large") {
      const message = "Provider error body exceeds its byte bound";
      throw classifyProviderFailure(message, { status, diagnostic: { message }, maximumMessageCharacters: request.transport.maximumErrorMessageCharacters });
    }
    else {
      const limit = request.transport.maximumErrorMessageCharacters;
      const detail = (observeError({ message: extractErrorMessage(error) }).diagnostic?.message ?? "Provider error body could not be read").slice(0, limit);
      throw new InvalidResponseError(`Provider error body read failed: ${detail}`, { readFailure: "body_read_failed" }, status);
    }
  }
  const parsed = parseJsonExact(text);
  // Text error bodies share the same safe classifier; JSON `null` stays `null`.
  const raw: unknown = parsed === undefined ? text : parsed.value;
  const observation = observeError(raw);
  throw classifyProviderFailure(raw, { status, modelOperation: request.modelOperation ?? false,
    heldCredentials, diagnostic: observation.diagnostic,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")), maximumMessageCharacters: request.transport.maximumErrorMessageCharacters });
}
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000)) return seconds * 1000;
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
/** The shared abortable delay; an abort is the provider family's typed cancellation. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  try { await abortableDelay(ms, signal); } catch (error) {
    if (signal?.aborted === true) throw safeAbortError(signal.reason);
    throw error;
  }
}
