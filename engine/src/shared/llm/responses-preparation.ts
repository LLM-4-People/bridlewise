/** Private native composition. No caller-supplied preparation authority or secondary mint. */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../privacy/privacy-policy.ts";
import { currentPrivacySettings } from "../../privacy/pii-registry.ts";
import { redactAndMintRequest, validateResponseRequest, snapshotRequestContext, type RequestRedactionOptions } from "../../privacy/redacted-messages.ts";
import { RESPONSE_REQUEST_SCHEMAS, type ResponseOperation, type ResponseRequestFor } from "./responses-endpoints.ts";
import type { ResponsesTransportConfig } from "./config.ts";
import type { FailoverTarget } from "./failover.ts";
import type { HeldSet } from "../../privacy/held-set.ts";

export type ResponsePrivacyOptions = Pick<RequestRedactionOptions, "policy" | "detection" | "context">;
/** Captured once before queueing; raw values are PRIVATE and confer no egress authority. */
export function captureResponseSource<Operation extends ResponseOperation>(operation: Operation, input: ResponseRequestFor<Operation>, limits: ResponsesTransportConfig): ResponseRequestFor<Operation> {
  return validateResponseRequest(operation, input, limits);
}
export function captureResponsePrivacy(options: ResponsePrivacyOptions = {}, limits: ResponsesTransportConfig): ResponsePrivacyOptions {
  const policy = options.policy ?? DEFAULT_PRIVACY_POLICY, settings = options.detection?.settings ?? currentPrivacySettings();
  return deepFreeze({ ...(options.context === undefined ? {} : {context: snapshotRequestContext(undefined, options.context, limits).context}), policy: { ...policy, enabledCategories: new Set(policy.enabledCategories), rules: policy.rules.map(rule => ({ ...rule })),
    redactionCategories: [...policy.redactionCategories], piiClassifications: [...policy.piiClassifications] },
    detection: { ...options.detection, settings: { tiers: { ...settings.tiers }, disabledTypes: new Set(settings.disabledTypes) },
      ...(options.detection?.declaredValues === undefined ? {} : { declaredValues: [...options.detection.declaredValues] }),
      ...(options.detection?.heldCredentials === undefined ? {} : { heldCredentials: options.detection.heldCredentials }) } });
}
export function prepareResponseRequest<Operation extends ResponseOperation>(operation: Operation, source: Readonly<Record<string, unknown>>, target: FailoverTarget,
  streaming: boolean | undefined, limits: ResponsesTransportConfig, privacy: ResponsePrivacyOptions, heldCredentials: HeldSet) {
  // Endpoint defaults are projections; direct endpoint input (including extensions) stays intact.
  const fields = RESPONSE_REQUEST_SCHEMAS[operation].shape;
  const defaults = operation === "create" ? target.requestDefaults : Object.fromEntries(Object.entries(target.requestDefaults).filter(([key]) => Object.hasOwn(fields, key)));
  const body: Record<string, unknown> = { ...defaults, ...source };
  if (operation === "create") {
    if (Object.hasOwn(source, "stream") && (streaming ? source.stream !== true : source.stream === true)) {
      throw new InputError("Native stream mode conflicts with the invoked operation", "responses_stream_mode_invalid");
    }
    if (!Object.hasOwn(source, "stream")) body.stream = streaming === true;
    if (body.stream_options != null && body.stream !== true) {
      throw new InputError("Stream options require a streaming Responses request", "responses_stream_options_invalid");
    }
  }
  // Explicit initial model chooses the first target; an authorized failover replaces it.
  // Absence/null carries native meaning and must never be filled from a routing label.
  if (typeof source.model === "string" || !Object.hasOwn(source, "model") && body.prompt == null && target.model !== undefined) body.model = target.model;
  return redactAndMintRequest(operation, body, { ...privacy, limits,
    detection: { ...privacy.detection, heldCredentials: heldCredentials.merge(privacy.detection?.heldCredentials) } });
}
/** Conservative transport affinity; ordinary manual text/function replay has no remote lookup. */
export function responseRequiresOrigin(source: Readonly<Record<string, unknown>>): boolean {
  if (source.previous_response_id != null || source.conversation != null || source.prompt != null) return true;
  const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const part = (value: unknown): boolean => { const p = record(value); return !!p && (p.type === "encrypted_content" ||
    ["input_image", "input_file", "computer_screenshot"].includes(String(p.type)) && typeof p.file_id === "string"); };
  if (Array.isArray(source.input)) for (const value of source.input) {
    const item = record(value); if (!item) continue;
    if (typeof item.id === "string" && (item.type == null || item.type === "item_reference")) return true;
    if (item.type === "message" || item.type === undefined && typeof item.role === "string") {
      if (Array.isArray(item.content) && item.content.some(part)) return true;
    } else if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(String(item.type))) {
      if (Array.isArray(item.output) && item.output.some(part)) return true;
    } else return true; // Other native/extension items have no proved portable interpretation.
  }
  if (Array.isArray(source.tools)) for (const value of source.tools) {
    const tool = record(value); if (!tool) continue;
    if (tool.type === "file_search" || tool.type === "code_interpreter" &&
      (typeof tool.container === "string" || Array.isArray(record(tool.container)?.file_ids)) ||
      tool.type === "shell" && record(tool.environment)?.type === "container_reference") return true;
  }
  return typeof record(source.prompt_cache_options)?.comparison_response_id === "string";
}
