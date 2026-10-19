/** Bounded public projection of UNTRUSTED native resources/events; never replay this output. */
import type { HeldSet } from "./held-set.ts";
import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { snapshotJsonValue, type SnapshotJsonValue } from "../kernel/safe-structural.ts";
import { mapJsonValues, mapStringValues, type StringValueLocation } from "../shared/string-values.ts";
import { isPlainObject } from "../shared/type-guards.ts";
import { resolveResponsesTransportConfig, type ResponsesTransportConfigInput } from "../shared/llm/config.ts";
import { DEFAULT_PRIVACY_POLICY, redactionReplacement, type PrivacyPolicy } from "./privacy-policy.ts";
import { applyRedactions, redactMessagesTogether, type DetectionOptions } from "./redaction-engine.ts";
import { isSensitiveKeyName } from "./secret-signals.ts";
import { responseObservationSlot, responseObservationLocation, isResponseObservationResource } from "./responses-redaction.ts";
import { rememberableDeclaredValue } from "./secret-intelligence.ts";
import { isResponseUsageValue, parseResponseResource, projectResponse, type ResponseProjection, type ResponseStatus } from "../shared/llm/responses.ts";

/** `limits` is REQUIRED: the configured `runtime.responses` transport, never a code fallback (a2-design M5). */
export type ResponseObservationOptions = Readonly<{ policy?: PrivacyPolicy; limits: ResponsesTransportConfigInput; heldCredentials?: HeldSet; detection?: Omit<DetectionOptions, "learningScope"> }>;
export type ResponseDisplay = Readonly<Omit<ResponseProjection, "response" | "toolCalls"> & { toolCalls: readonly Readonly<{ id: string; type: "function"; function: Readonly<{ name: string; arguments: string }> }>[] }>;
export type ResponseObservationEnvelope = Readonly<{ headers: Readonly<Record<string, string>>; response?: SnapshotJsonValue; display?: ResponseDisplay; diagnostic?: Readonly<{ message?: string; code?: string; type?: string }> }>;
export type ResponseEnvelopeOptions = ResponseObservationOptions & Readonly<{ selectedHeaders?: readonly string[]; status?: ResponseStatus; kind?: "error" }>;
export function observeResponseProtocol(value: unknown, options: ResponseObservationOptions): SnapshotJsonValue {
  return observe(value, options, false) as SnapshotJsonValue;
}
/** Trusted API wrapper; provider objects never select this normalization mode. */
export function observeResponseEnvelope(value: Readonly<{ headers: Readonly<Record<string, string>>; response?: unknown; evidence?: readonly unknown[] }>, options: ResponseEnvelopeOptions): ResponseObservationEnvelope {
  return observe(value, options, true) as ResponseObservationEnvelope;
}
function observe(value: unknown, options: ResponseEnvelopeOptions, envelope: boolean): SnapshotJsonValue | ResponseObservationEnvelope {
  const limits = resolveResponsesTransportConfig(options.limits), policy = options.policy ?? DEFAULT_PRIVACY_POLICY;
  const structural = { maximumDepth: limits.maximumDepth, maximumNodes: limits.maximumNodes };
  // One structural snapshot budgets the two subtrees together. The trusted
  // wrapper contributes one derived node/depth level, excluded from provider limits.
  const input = value as Readonly<{ headers: unknown; response?: unknown; evidence?: readonly unknown[] }>;
  const snapshot = snapshotJsonValue(envelope ? { headers: input.headers, ...(Object.hasOwn(input, "response") ? { response: input.response } : {}), ...(input.evidence?.length ? { evidence: input.evidence } : {}) } : value,
    envelope ? { maximumDepth: structural.maximumDepth + 1, maximumNodes: structural.maximumNodes + 1 } : structural, "responses_observation_structure_invalid");
  const checkBytes = (part: unknown, maximum: number): void => {
    if (Buffer.byteLength(JSON.stringify(part), "utf8") > maximum) throw new InputError("Response observation exceeds its byte bound", "responses_observation_too_large");
  };
  if (envelope) {
    const parts = snapshot as Record<string, SnapshotJsonValue>;
    checkBytes(parts.headers, limits.maximumResponseHeaderBytes);
    const bodyBytes = Object.hasOwn(parts, "response") ? Buffer.byteLength(JSON.stringify(parts.response), "utf8") : 0;
    const evidenceBytes = Object.hasOwn(parts, "evidence") ? Buffer.byteLength(JSON.stringify(parts.evidence), "utf8") : 0;
    if (bodyBytes + evidenceBytes > limits.maximumResponseBytes) throw new InputError("Response observation exceeds its byte bound", "responses_observation_too_large");
  } else checkBytes(snapshot, limits.maximumResponseBytes);
  const marker = redactionReplacement("token", policy);
  const record = isPlainObject(snapshot) ? snapshot : undefined;
  const resource = envelope && isPlainObject(record?.response) ? record.response : undefined;
  const status = options.status ?? resource?.status;
  if (options.kind !== "error" && envelope && resource?.object === "response" && Array.isArray(resource.output) && !["completed", "failed", "incomplete", "cancelled"].includes(String(status))) return deepFreeze({ headers: {} });
  const native = options.kind !== "error" && envelope && resource?.object === "response" && Array.isArray(resource.output) ? projectResponse(parseResponseResource(resource), status as ResponseStatus) : undefined;
  const locationOf = (location: StringValueLocation): StringValueLocation => responseObservationLocation(location, envelope);
  const slot = (location: StringValueLocation) => envelope && (!["response", "evidence"].includes(String(location.path[0])) || options.kind === "error") ? "text" : responseObservationSlot(locationOf(location));
  const headerTelemetry = (item: unknown, location: StringValueLocation) => envelope && location.path.length === 2 && location.path[0] === "headers" && typeof item === "string" && isRateLimitHeaderValue(String(location.path[1]), item);
  const numeric = (item: unknown, location: StringValueLocation) => headerTelemetry(item, location) || options.kind !== "error" && isNativeUsage(item, locationOf(location));
  const sensitive = (item: unknown, location: StringValueLocation) => typeof location.path.at(-1) === "string" && isSensitiveKeyName(String(location.path.at(-1))) && !numeric(item, location);
  const eventType = record && typeof record.type === "string" ? record.type : undefined;
  const progress = !isResponseObservationResource(record) && eventType !== undefined && (Object.hasOwn(record!, "sequence_number") || eventType.startsWith("response.") || eventType === "error") &&
    !["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(eventType);
  // Future terminal fields can declare strings from any earlier progress
  // payload (including keys/IDs). Only fixed numeric progress fields are public.
  if (progress) return deepFreeze(Object.fromEntries(
    ["sequence_number", "output_index", "content_index", "summary_index", "command_index"].flatMap(key => {
      const item = record![key];
      return typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? [[key, item]] : [];
    })));
  // Searched for in text: the held values at or above the held floor (the
  // held-set owner's `matched`); a shorter one is replaced only where a whole
  // string equals it (`exact`), never inside text.
  const exact: readonly string[] = options.heldCredentials?.values() ?? [];
  const localCredentials: string[] = [...(options.heldCredentials?.matched() ?? [])];
  const hidden = (location: StringValueLocation) => {
    const kind = slot(location);
    return kind === "opaque" || kind === "credential" || kind === "url";
  };
  // Mask whole semantic slots before detection, including malformed object values.
  const visible = mapJsonValues(snapshot, (item, location) => {
    if (slot(location) === "credential" || sensitive(item, location)) {
      mapStringValues(item, text => { if (rememberableDeclaredValue(text)) localCredentials.push(text); return text; });
    }
    return hidden(location) ? marker : item;
  });
  const texts: string[] = native ? [native.content, native.refusal, native.reasoning, native.model, native.finishReason] : [], keys = new Set<string>(), argumentsByPath = new Map<string, unknown>(), argumentsByText = new Map<string, unknown>();
  mapStringValues(visible, (text, location) => {
    texts.push(text);
    if (location.path.at(-1) === "arguments") {
      try {
        const parsed = snapshotJsonValue(JSON.parse(text), structural, "responses_observation_structure_invalid");
        argumentsByPath.set(JSON.stringify(location.path), parsed); argumentsByText.set(text, parsed);
        mapStringValues(parsed, leaf => { texts.push(leaf); return leaf; }, key => { keys.add(key); });
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    return text;
  }, key => { keys.add(key); });
  const held = localCredentials;
  const turn = redactMessagesTogether([...texts, ...keys], policy, {
    ...(options.detection?.profile === undefined ? {} : { profile: options.detection.profile }),
    ...(options.detection?.settings === undefined ? {} : { settings: options.detection.settings }),
    declaredValues: [...held, ...(options.detection?.declaredValues ?? [])], ...(options.heldCredentials === undefined ? {} : { heldCredentials: options.heldCredentials }) });
  const safeText = (text: string) => held.includes(text) || exact.includes(text) ? marker : turn.redact(text);
  const safeIdentity = (text: string) => held.includes(text) || exact.includes(text) ? marker : applyRedactions(text, turn.detectProtocolIdentity(text), policy);
  // Redacted keys are observation aliases, never protocol/routing identities.
  // Allocate from the existing key set so collisions cannot erase evidence.
  const keyProjection = new Map<string, string>(); let index = 0;
  for (const key of [...keys]) if (safeText(key) !== key) {
    let projected: string; do {
      if (index >= limits.maximumNodes) throw new InputError("Response observation aliases exceed their structural budget", "responses_observation_aliases_unavailable");
      projected = String(index++);
    } while (keys.has(projected) || safeText(projected) !== projected);
    keys.add(projected); keyProjection.set(key, projected);
  }
  const mapKey = (key: string, location?: StringValueLocation) => envelope && location?.path.length === 1 ? key : keyProjection.get(key) ?? key;
  const renderArguments = (parsed: unknown): string => JSON.stringify(mapJsonValues(parsed, (leaf, nested) =>
    typeof nested.path.at(-1) === "string" && isSensitiveKeyName(String(nested.path.at(-1))) ? marker : typeof leaf === "string" ? safeText(leaf) : leaf, key => mapKey(key)));
  const redact = (item: unknown, location: StringValueLocation): unknown => {
    if (sensitive(item, location) && item !== null) return marker;
    if (typeof item !== "string") return item;
    const parsed = argumentsByPath.get(JSON.stringify(location.path));
    if (parsed !== undefined) return renderArguments(parsed);
    if (held.includes(item)) return marker;
    if (slot(location) === "identity") return safeIdentity(item);
    return safeText(item);
  };
  const observed = mapJsonValues(visible, redact, mapKey);
  if (!envelope) return deepFreeze(observed) as SnapshotJsonValue;
  const result = observed as Record<string, unknown>, rawHeaders = record!.headers as Record<string, string>;
  const selected = options.selectedHeaders ?? Object.keys(rawHeaders);
  const safeHeaders = result.headers as Record<string, string>;
  const headers = Object.fromEntries(selected.filter(name => Object.hasOwn(rawHeaders, name)).map(name => [mapKey(name), safeHeaders[mapKey(name)]!]));
  const display = native === undefined ? undefined : {
    content: safeText(native.content), refusal: safeText(native.refusal), reasoning: safeText(native.reasoning), model: safeIdentity(native.model),
    finishReason: safeText(native.finishReason), truncated: native.truncated, usage: native.usage,
    toolCalls: native.toolCalls.map(call => ({ id: safeIdentity(call.id), type: "function" as const, function: { name: safeIdentity(call.function.name),
      arguments: argumentsByText.has(call.function.arguments) ? renderArguments(argumentsByText.get(call.function.arguments)) : safeText(call.function.arguments) } })),
  };
  const rawError = isPlainObject(record!.response) && isPlainObject(record!.response.error) ? record!.response.error : record!.response;
  const diagnostic = isPlainObject(rawError) ? Object.fromEntries(["message", "code", "type"].flatMap(key => typeof rawError[key] === "string" ? [[key, safeText(rawError[key])]] : []))
    : typeof rawError === "string" ? { message: safeText(rawError) } : undefined;
  return deepFreeze({ headers, ...(Object.hasOwn(result, "response") ? { response: result.response as SnapshotJsonValue } : {}),
    ...(display === undefined ? {} : { display }), ...(diagnostic === undefined ? {} : { diagnostic }) });
}

/** Sensitive-key vocabulary includes token counts; only native count slots keep numbers. */
function isNativeUsage(value: unknown, { path, ancestors }: StringValueLocation): boolean {
  const root = ancestors[0];
  if (!root || typeof root !== "object" || !("object" in root)) return false;
  if (path[0] === "usage" && ["response", "response.compaction"].includes(String(root.object))) return isResponseUsageValue(path.slice(1), value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return false;
  if (root.object === "response.input_tokens") return path.length === 1 && path[0] === "input_tokens";
  if (!["response", "response.compaction"].includes(String(root.object))) return false;
  if (path.length === 1 && path[0] === "max_output_tokens") return true;
  return false;
}

/** Documented numeric/duration headers remain telemetry, never a blanket token-key exception. */
function isRateLimitHeaderValue(name: string, value: string): boolean {
  if (/^x-ratelimit-(?:limit|remaining)-(?:requests|(?:project-)?tokens)$/iu.test(name)) return /^\d+$/u.test(value);
  if (/^x-ratelimit-reset-(?:requests|(?:project-)?tokens)$/iu.test(name)) return /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/u.test(value);
  return false;
}
