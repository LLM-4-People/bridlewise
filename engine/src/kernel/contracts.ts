import { z } from "zod";

import type { ConfigDocument } from "./config-contracts.ts";
import { canonicalHash, deepFreeze } from "./integrity.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import { schemaId } from "./product-identity.ts";

/**
 * Canonical content-type literals. One owner so HTTP/MCP/SSE/LLM adapters and
 * the unified memory drift detector do not each redeclare the same string
 * (the duplicated-literals prevention rule). Consumers import from here
 * instead of inlining `"application/json"`.
 */
export const CONTENT_TYPE_JSON = "application/json" as const;

/**
 * WHERE A REQUEST GOES WHEN NOBODY HAS SAID WHERE — and it deliberately goes
 * nowhere.
 *
 * `.invalid` is reserved by RFC 2606 §2 precisely so that it can never be
 * delegated, so this address cannot resolve on any network, ever. That is the
 * whole point: a default endpoint is not a default VALUE, it is a default
 * DESTINATION FOR A CREDENTIAL, and the failure mode is silent rather than
 * loud. A configuration that supplies a key and inherits the address sends the
 * user's real key to whatever vendor the default names, and everything looks
 * like it is working.
 *
 * That was live, twice, in one shape: `DEFAULT_DRIFT_CONFIG` carried a real
 * vendor host beside an empty key, and two callers supplied the key while
 * inheriting the host — the partial override the shape invites. A neighbouring
 * caller passed both and was correct, which is the tell: one door refusing and
 * one door admitting is the defect, not the difference.
 *
 * ONE OWNER, because it was written out four times across two subsystems and a
 * guard was already keyed to the SPELLING of it in one of them. A sentinel that
 * exists in four copies is four things that can drift, and a scan for the
 * fourth copy is a scan that finds nothing when someone renames the third.
 */
export const PROVIDER_NOT_CONFIGURED_BASE_URL = "https://provider-not-configured.invalid/v1" as const;

/**
 * Whether an endpoint address is the "nobody configured this" sentinel rather
 * than a real destination.
 *
 * A predicate rather than an `===` at each call site, so a caller asks the
 * QUESTION instead of restating the value — and so the answer stays right if
 * the sentinel ever grows a second spelling.
 */
export function isProviderConfigured(baseUrl: string): boolean {
  return baseUrl.length > 0 && baseUrl !== PROVIDER_NOT_CONFIGURED_BASE_URL;
}

const LIMITS = ROOT_POLICY.contracts.limits;
const IDENTIFIER = z.string().min(1).max(LIMITS.maximumIdentifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const TOOL_NAME = z.string().min(1).max(LIMITS.maximumIdentifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const PATH_SCOPE = z.string().min(1).max(LIMITS.maximumTextCharacters)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u);
const TEXT = z.string().max(LIMITS.maximumTextCharacters);
const JSON_VALUE = z.json();
export const JSON_OBJECT_SCHEMA = z.record(z.string(), JSON_VALUE);

export type ContractSettings = ConfigDocument["contracts"];

const PROTOCOL_ID_SCHEMA = z.enum(ROOT_POLICY.contracts.protocolIds);
const MODEL_PROTOCOL_ID_SCHEMA = z.enum(ROOT_POLICY.contracts.modelProtocolIds);

export const TOOL_PARAMETER_SCHEMA = z.strictObject({
  $schema: z.literal(ROOT_POLICY.contracts.schemaDialect).optional(),
  type: z.literal("object"),
  properties: z.record(z.string().min(1).max(LIMITS.maximumIdentifierCharacters), JSON_VALUE).optional(),
  required: z.array(z.string().min(1).max(LIMITS.maximumIdentifierCharacters))
    .max(LIMITS.maximumToolSchemaProperties).optional(),
  additionalProperties: z.boolean().optional(),
  description: TEXT.optional(),
});

export const MODEL_TOOL_SCHEMA = z.strictObject({
  name: TOOL_NAME,
  description: TEXT.optional(),
  inputSchema: TOOL_PARAMETER_SCHEMA,
  outputSchema: TOOL_PARAMETER_SCHEMA.optional(),
});

export const HARNESS_TOOL_CONTROL_SCHEMA = z.strictObject({
  effect: z.enum(["none", "read", "write", "process", "network"]),
  approval: z.enum(["never", "always", "on-effect"]),
  pathScope: z.array(PATH_SCOPE).max(LIMITS.maximumToolSchemaProperties),
  idempotency: z.enum(["none", "intrinsic", "key-required"]),
  retry: z.enum(["never", "idempotent-only"]),
});

export const TOOL_CONTRACT_SCHEMA = z.strictObject({
  model: MODEL_TOOL_SCHEMA,
  control: HARNESS_TOOL_CONTROL_SCHEMA,
});

const MESSAGE_SCHEMA = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("system"), content: TEXT }),
  z.strictObject({ role: z.literal("developer"), content: TEXT }),
  z.strictObject({ role: z.literal("user"), content: TEXT }),
  z.strictObject({ role: z.literal("assistant"), content: TEXT }),
  z.strictObject({ role: z.literal("tool"), content: TEXT, toolCallId: IDENTIFIER }),
]);

export const MODEL_REQUEST_SCHEMA = z.strictObject({
  requestId: IDENTIFIER,
  model: z.string().min(1).max(LIMITS.maximumIdentifierCharacters),
  messages: z.array(MESSAGE_SCHEMA).min(1).max(LIMITS.maximumMessages),
  tools: z.array(TOOL_CONTRACT_SCHEMA).max(LIMITS.maximumTools),
  toolChoice: z.enum(["none", "auto", "required"]),
  parallelToolCalls: z.boolean(),
  stream: z.boolean(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});

export const USAGE_SCHEMA = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});

export const RAW_METADATA_ENVELOPE_SCHEMA = z.strictObject({
  classification: z.literal(ROOT_POLICY.contracts.unknownMetadataClassification),
  forwarding: z.literal(ROOT_POLICY.contracts.unknownMetadataForwarding),
  sourceProtocol: PROTOCOL_ID_SCHEMA,
  raw: JSON_OBJECT_SCHEMA,
});

export const CONTRACT_ERROR_SCHEMA = z.strictObject({
  kind: z.enum(["malformed", "ordering", "provider", "schema", "unsupported"]),
  code: z.string().min(1).max(LIMITS.maximumIdentifierCharacters).regex(/^[a-z0-9_]+$/u),
  message: z.string().min(1).max(512),
  retryable: z.literal(false),
  metadata: RAW_METADATA_ENVELOPE_SCHEMA.optional(),
});

const EVENT_BASE = {
  sequence: z.number().int().nonnegative(),
  protocol: MODEL_PROTOCOL_ID_SCHEMA,
} as const;

export const MODEL_EVENT_SCHEMA = z.discriminatedUnion("type", [
  z.strictObject({ ...EVENT_BASE, type: z.literal("start"), responseId: IDENTIFIER.optional() }),
  z.strictObject({ ...EVENT_BASE, type: z.literal("text_delta"), outputIndex: z.number().int().nonnegative(), delta: TEXT }),
  z.strictObject({ ...EVENT_BASE, type: z.literal("reasoning_delta"), outputIndex: z.number().int().nonnegative(), delta: TEXT }),
  z.strictObject({
    ...EVENT_BASE,
    type: z.literal("tool_call_start"),
    outputIndex: z.number().int().nonnegative(),
    callId: IDENTIFIER,
    name: TOOL_NAME,
  }),
  z.strictObject({
    ...EVENT_BASE,
    type: z.literal("tool_call_delta"),
    outputIndex: z.number().int().nonnegative(),
    callId: IDENTIFIER,
    argumentsDelta: TEXT,
  }),
  z.strictObject({
    ...EVENT_BASE,
    type: z.literal("tool_call_done"),
    outputIndex: z.number().int().nonnegative(),
    callId: IDENTIFIER,
    arguments: JSON_OBJECT_SCHEMA,
  }),
  z.strictObject({ ...EVENT_BASE, type: z.literal("usage"), usage: USAGE_SCHEMA }),
  z.strictObject({
    ...EVENT_BASE,
    type: z.literal("finish"),
    outputIndex: z.number().int().nonnegative().optional(),
    reason: z.enum(["stop", "length", "tool_calls", "content_filter", "cancelled", "unknown"]),
  }),
  z.strictObject({ ...EVENT_BASE, type: z.literal("error"), error: CONTRACT_ERROR_SCHEMA }),
]);

export const TRANSPORT_CONTRACT_SCHEMA = z.strictObject({
  protocol: PROTOCOL_ID_SCHEMA,
  method: z.enum(["POST", "JSON-RPC"]),
  path: z.string().min(1).max(512),
  framing: z.enum(["json", "json-chunks", "sse"]),
  stream: z.boolean(),
  executionAuthorized: z.literal(false),
});

const CAPABILITY_NAME_SCHEMA = z.enum([
  "text",
  "reasoning",
  "streaming",
  "tools",
  "parallel_tool_calls",
  "tool_choice_required",
  "usage",
  "structured_tool_results",
]);

export const CAPABILITY_OFFER_SCHEMA = z.strictObject({
  protocol: PROTOCOL_ID_SCHEMA,
  supported: z.array(CAPABILITY_NAME_SCHEMA).max(CAPABILITY_NAME_SCHEMA.options.length),
});

export const CAPABILITY_REQUIREMENT_SCHEMA = z.strictObject({
  required: z.array(CAPABILITY_NAME_SCHEMA).max(CAPABILITY_NAME_SCHEMA.options.length),
  preferred: z.array(CAPABILITY_NAME_SCHEMA).max(CAPABILITY_NAME_SCHEMA.options.length),
});

const LOSS_ITEM_SCHEMA = z.strictObject({
  capability: CAPABILITY_NAME_SCHEMA,
  disposition: z.enum(["required-unsupported", "preferred-unavailable"]),
  protocol: PROTOCOL_ID_SCHEMA.optional(),
});

export const CAPABILITY_NEGOTIATION_SCHEMA = z.strictObject({
  accepted: z.boolean(),
  selectedProtocol: PROTOCOL_ID_SCHEMA.nullable(),
  losses: z.array(LOSS_ITEM_SCHEMA).max(LIMITS.maximumLosses),
});

export const TOOL_RESULT_SCHEMA = z.strictObject({
  callId: IDENTIFIER,
  text: TEXT.optional(),
  structured: JSON_OBJECT_SCHEMA.optional(),
  isError: z.boolean(),
  metadata: RAW_METADATA_ENVELOPE_SCHEMA.optional(),
});

const CONTRACT_SCHEMA_SOURCES = {
  capability: CAPABILITY_OFFER_SCHEMA,
  capabilityNegotiation: CAPABILITY_NEGOTIATION_SCHEMA,
  error: CONTRACT_ERROR_SCHEMA,
  event: MODEL_EVENT_SCHEMA,
  modelRequest: MODEL_REQUEST_SCHEMA,
  rawMetadataEnvelope: RAW_METADATA_ENVELOPE_SCHEMA,
  tool: MODEL_TOOL_SCHEMA,
  toolContract: TOOL_CONTRACT_SCHEMA,
  toolResult: TOOL_RESULT_SCHEMA,
  transport: TRANSPORT_CONTRACT_SCHEMA,
  usage: USAGE_SCHEMA,
} as const;

export const GENERATED_CONTRACT_SCHEMAS = deepFreeze(Object.fromEntries(
  Object.entries(CONTRACT_SCHEMA_SOURCES).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      cycles: "ref",
      reused: "ref",
    }),
  ]),
));

export const CONTRACT_BUNDLE_HASH = canonicalHash(GENERATED_CONTRACT_SCHEMAS);
export const CONTRACT_SCHEMA_ARTIFACT_VERSION = schemaId("contract-schemas", 1);

export type ModelRequest = Readonly<z.infer<typeof MODEL_REQUEST_SCHEMA>>;
export type ModelEvent = Readonly<z.infer<typeof MODEL_EVENT_SCHEMA>>;
export type ModelTool = Readonly<z.infer<typeof MODEL_TOOL_SCHEMA>>;
export type ToolContract = Readonly<z.infer<typeof TOOL_CONTRACT_SCHEMA>>;
export type HarnessToolControl = Readonly<z.infer<typeof HARNESS_TOOL_CONTROL_SCHEMA>>;
export type Usage = Readonly<z.infer<typeof USAGE_SCHEMA>>;
export type RawMetadataEnvelope = Readonly<z.infer<typeof RAW_METADATA_ENVELOPE_SCHEMA>>;
export type ContractError = Readonly<z.infer<typeof CONTRACT_ERROR_SCHEMA>>;
export type CapabilityName = z.infer<typeof CAPABILITY_NAME_SCHEMA>;
export type CapabilityOffer = Readonly<z.infer<typeof CAPABILITY_OFFER_SCHEMA>>;
export type CapabilityRequirement = Readonly<z.infer<typeof CAPABILITY_REQUIREMENT_SCHEMA>>;
export type CapabilityNegotiation = Readonly<z.infer<typeof CAPABILITY_NEGOTIATION_SCHEMA>>;
export type ToolResult = Readonly<z.infer<typeof TOOL_RESULT_SCHEMA>>;
