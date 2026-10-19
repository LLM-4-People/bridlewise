import { z } from "zod";

import { canonicalHash, deepFreeze, sha256, sha256HexSchema } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { schemaId } from "../kernel/product-identity.ts";

const LIMITS = ROOT_POLICY.forensics.limits;
const IDENTIFIER = z.string().min(1).max(LIMITS.maximumIdentifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const CODE = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const UTF8_TEXT = utf8String(LIMITS.maximumTextBytes);
const SHA256_HEX = sha256HexSchema;
const BASE64 = z.string()
  .max(Math.ceil(LIMITS.maximumTextBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  .refine((value) => canonicalBase64Bytes(value) !== undefined, "Base64 must be canonical and bounded");
const NONNEGATIVE_SAFE_INTEGER = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MEDIA_TYPE = utf8String(256, 1)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[^\r\n]*)?$/u);
const BYTE_LENGTH = NONNEGATIVE_SAFE_INTEGER.max(LIMITS.maximumTextBytes);

export const FORENSIC_CONTRACTS_REVISION = "s3.1-forensic-contracts/v2";

export const FORENSIC_SEQUENCE_SCHEMA = boundedCanonicalDecimal(
  ROOT_POLICY.forensics.limits.maximumSequenceDecimal,
  false,
);

const FORENSIC_MONOTONIC_NANOSECONDS_SCHEMA = boundedCanonicalDecimal(
  ROOT_POLICY.forensics.limits.maximumMonotonicNanosecondsDecimal,
  true,
);

export const FORENSIC_TIMESTAMP_SCHEMA = z.strictObject({
  wallTime: z.iso.datetime({ offset: false, local: false })
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
  monotonicNanoseconds: FORENSIC_MONOTONIC_NANOSECONDS_SCHEMA.optional(),
});

export const FORENSIC_ACTOR_SCHEMA = z.strictObject({
  kind: z.enum(ROOT_POLICY.forensics.actorKinds),
  id: IDENTIFIER,
  role: IDENTIFIER.optional(),
});

export const FORENSIC_CORRELATION_SCHEMA = z.strictObject({
  requestId: IDENTIFIER.optional(),
  sessionId: IDENTIFIER.optional(),
  turnId: IDENTIFIER.optional(),
  messageId: IDENTIFIER.optional(),
  partId: IDENTIFIER.optional(),
  toolCallId: IDENTIFIER.optional(),
  agentId: IDENTIFIER.optional(),
  taskId: IDENTIFIER.optional(),
  attemptId: IDENTIFIER.optional(),
  featureId: IDENTIFIER.optional(),
  parentEventId: IDENTIFIER.optional(),
  replayId: IDENTIFIER.optional(),
});

export const FORENSIC_HEADER_ENTRY_SCHEMA = z.strictObject({
  name: z.string().min(1).max(LIMITS.maximumHeaderNameBytes).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
  value: utf8String(LIMITS.maximumHeaderValueBytes).regex(/^[^\r\n]*$/u),
});

export const FORENSIC_HEADERS_SCHEMA = z.strictObject({
  entries: z.array(FORENSIC_HEADER_ENTRY_SCHEMA).max(LIMITS.maximumHeaders),
});

export const FORENSIC_USAGE_SCHEMA = z.strictObject({
  inputTokens: NONNEGATIVE_SAFE_INTEGER,
  outputTokens: NONNEGATIVE_SAFE_INTEGER,
  totalTokens: NONNEGATIVE_SAFE_INTEGER,
  cachedInputTokens: NONNEGATIVE_SAFE_INTEGER.optional(),
  reasoningTokens: NONNEGATIVE_SAFE_INTEGER.optional(),
  providerReported: z.boolean(),
});

export const FORENSIC_ERROR_CAUSE_SCHEMA = z.strictObject({
  name: utf8String(256, 1),
  message: UTF8_TEXT,
  code: CODE.optional(),
  stack: UTF8_TEXT.optional(),
});

export const FORENSIC_ERROR_SCHEMA = z.strictObject({
  category: z.enum(["input", "policy", "protocol", "provider", "model", "tool", "process", "storage", "integrity", "internal"]),
  code: CODE,
  message: UTF8_TEXT,
  stack: UTF8_TEXT.optional(),
  retryable: z.boolean(),
  causes: z.array(FORENSIC_ERROR_CAUSE_SCHEMA).max(LIMITS.maximumErrorCauses),
});

const FORENSIC_TOOL_BASE = {
  callId: IDENTIFIER,
  name: IDENTIFIER,
  protocol: IDENTIFIER,
  phase: z.enum(["requested", "started", "completed", "failed", "denied"]),
} as const;

export const FORENSIC_TOOL_SCHEMA = z.union([
  z.strictObject(FORENSIC_TOOL_BASE),
  exactPayloadSchema(z.strictObject({
    ...FORENSIC_TOOL_BASE,
    mediaType: MEDIA_TYPE,
    contentBase64: BASE64,
    byteLength: BYTE_LENGTH,
    contentSha256: SHA256_HEX,
  })),
]);

export const FORENSIC_TURN_SCHEMA = z.strictObject({
  turnId: IDENTIFIER,
  ordinal: NONNEGATIVE_SAFE_INTEGER,
  phase: z.enum(["received", "processing", "waiting", "completed", "failed", "cancelled"]),
});

export const FORENSIC_AGENT_SCHEMA = z.strictObject({
  agentId: IDENTIFIER,
  name: IDENTIFIER,
  taskId: IDENTIFIER,
  parentAgentId: IDENTIFIER.optional(),
  phase: z.enum(["created", "running", "waiting", "completed", "failed", "cancelled"]),
});

const BYTES_CAPTURE_SCHEMA = exactPayloadSchema(z.strictObject({
  kind: z.literal("bytes"),
  mediaType: MEDIA_TYPE,
  contentBase64: BASE64,
  byteLength: BYTE_LENGTH,
  contentSha256: SHA256_HEX,
}));

const HEADERS_CAPTURE_SCHEMA = z.strictObject({
  kind: z.literal("headers"),
  entries: z.array(FORENSIC_HEADER_ENTRY_SCHEMA).max(LIMITS.maximumHeaders),
});

const STREAM_CAPTURE_SCHEMA = exactPayloadSchema(z.strictObject({
  kind: z.literal("stream"),
  stream: z.enum(["stdout", "stderr"]),
  mediaType: MEDIA_TYPE,
  contentBase64: BASE64,
  byteLength: BYTE_LENGTH,
  contentSha256: SHA256_HEX,
}));

const TOOL_PAYLOAD_CAPTURE_SCHEMA = exactPayloadSchema(z.strictObject({
  kind: z.literal("tool-payload"),
  direction: z.enum(["arguments", "result"]),
  callId: IDENTIFIER,
  mediaType: MEDIA_TYPE,
  contentBase64: BASE64,
  byteLength: BYTE_LENGTH,
  contentSha256: SHA256_HEX,
}));

const ERROR_CAPTURE_SCHEMA = z.strictObject({
  kind: z.literal("error"),
  error: FORENSIC_ERROR_SCHEMA,
});

export const FORENSIC_RAW_CAPTURE_SCHEMA = z.discriminatedUnion("kind", [
  BYTES_CAPTURE_SCHEMA,
  HEADERS_CAPTURE_SCHEMA,
  STREAM_CAPTURE_SCHEMA,
  TOOL_PAYLOAD_CAPTURE_SCHEMA,
  ERROR_CAPTURE_SCHEMA,
]);

export const FORENSIC_EVENT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(schemaId("forensic-event", 1)),
  ledgerId: IDENTIFIER,
  eventId: IDENTIFIER,
  sequence: FORENSIC_SEQUENCE_SCHEMA,
  eventKind: z.enum(ROOT_POLICY.forensics.eventKinds),
  timestamp: FORENSIC_TIMESTAMP_SCHEMA,
  actor: FORENSIC_ACTOR_SCHEMA,
  correlation: FORENSIC_CORRELATION_SCHEMA,
  classification: z.enum(ROOT_POLICY.forensics.classifications),
  outcome: z.enum(ROOT_POLICY.forensics.outcomes),
  captures: z.array(FORENSIC_RAW_CAPTURE_SCHEMA).max(LIMITS.maximumCaptures),
  headers: FORENSIC_HEADERS_SCHEMA.optional(),
  usage: FORENSIC_USAGE_SCHEMA.optional(),
  tool: FORENSIC_TOOL_SCHEMA.optional(),
  error: FORENSIC_ERROR_SCHEMA.optional(),
  turn: FORENSIC_TURN_SCHEMA.optional(),
  agent: FORENSIC_AGENT_SCHEMA.optional(),
});

export const FORENSIC_PROJECTION_SCHEMA = z.strictObject({
  schemaVersion: z.literal(schemaId("forensic-projection", 1)),
  eventId: IDENTIFIER,
  timeBucket: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u),
  eventKind: z.enum(ROOT_POLICY.forensics.eventKinds),
  outcome: z.enum(ROOT_POLICY.forensics.outcomes),
  classification: z.enum(ROOT_POLICY.forensics.classifications),
  retention: z.enum(["standard", "restricted", "secret"]),
  protocolFamily: z.enum(["openai-compatible", "mcp", "local-process", "unknown"]),
  sizeBucket: z.enum(["empty", "under-1k", "under-16k", "under-256k", "under-1m", "at-ceiling"]),
  safeError: z.strictObject({
    category: FORENSIC_ERROR_SCHEMA.shape.category,
    code: z.enum(ROOT_POLICY.forensics.safeErrorCodes),
    retryable: z.boolean(),
  }).optional(),
  blindIndexes: z.array(z.strictObject({
    purpose: z.enum(["request-correlation", "session-correlation", "actor-correlation"]),
    digest: SHA256_HEX,
  })).max(3),
  policy: z.strictObject({
    rootPolicyHash: SHA256_HEX,
    projectionRevision: z.literal("s3.1-redacted-projection/v2"),
  }),
});

export const FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA = z.strictObject({
  ledgerId: IDENTIFIER,
  segmentId: IDENTIFIER,
  sequence: FORENSIC_SEQUENCE_SCHEMA,
  previousEntryHash: SHA256_HEX,
  entryHash: SHA256_HEX,
  previousEntryMac: SHA256_HEX,
  entryMac: SHA256_HEX,
  envelope: z.unknown(),
});

const LEDGER_ANCHOR_BASE = {
  ledgerId: IDENTIFIER,
  segmentId: IDENTIFIER,
} as const;

export const FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({
    ...LEDGER_ANCHOR_BASE,
    kind: z.literal("genesis"),
    nextSequence: z.literal("1"),
    previousEntryHash: z.literal("0".repeat(64)),
    previousEntryMac: z.literal("0".repeat(64)),
  }),
  z.strictObject({
    ...LEDGER_ANCHOR_BASE,
    kind: z.literal("continuation"),
    nextSequence: FORENSIC_SEQUENCE_SCHEMA.refine((value) => value !== "1", "Continuation starts after genesis"),
    previousEntryHash: SHA256_HEX,
    previousEntryMac: SHA256_HEX,
  }),
]);

export const FORENSIC_RECEIPT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(schemaId("forensic-receipt", 1)),
  ledgerId: IDENTIFIER,
  segmentId: IDENTIFIER,
  eventId: IDENTIFIER,
  sequence: FORENSIC_SEQUENCE_SCHEMA,
  entryHash: SHA256_HEX,
  entryMac: SHA256_HEX,
  projectionHash: SHA256_HEX,
  sealedPayloadHash: SHA256_HEX,
  committedAt: FORENSIC_TIMESTAMP_SCHEMA,
  integrityClaim: z.literal("cryptographic-correlation-not-external-authenticity"),
  effectAuthorized: z.literal(false),
});

const OUTBOX_EVIDENCE_SCHEMA = z.strictObject({
  ledgerId: IDENTIFIER,
  segmentId: IDENTIFIER,
  sequence: FORENSIC_SEQUENCE_SCHEMA,
  projectionHash: SHA256_HEX,
  sealedPayloadHash: SHA256_HEX,
  entryHash: SHA256_HEX,
  entryMac: SHA256_HEX,
});

const OUTBOX_STATE_BASE = {
  schemaVersion: z.literal(schemaId("forensic-outbox-state", 1)),
  eventId: IDENTIFIER,
  inputHash: SHA256_HEX,
} as const;

export const FORENSIC_OUTBOX_STATE_SCHEMA = z.discriminatedUnion("phase", [
  z.strictObject({ ...OUTBOX_STATE_BASE, phase: z.literal("received") }),
  z.strictObject({ ...OUTBOX_STATE_BASE, phase: z.literal("prepared") }),
  z.strictObject({ ...OUTBOX_STATE_BASE, phase: z.literal("committed"), evidence: OUTBOX_EVIDENCE_SCHEMA }),
  z.strictObject({ ...OUTBOX_STATE_BASE, phase: z.literal("forwardable"), evidence: OUTBOX_EVIDENCE_SCHEMA }),
  z.strictObject({
    ...OUTBOX_STATE_BASE,
    phase: z.literal("receipted"),
    evidence: OUTBOX_EVIDENCE_SCHEMA,
    receipt: FORENSIC_RECEIPT_SCHEMA,
  }),
  z.strictObject({
    ...OUTBOX_STATE_BASE,
    phase: z.literal("failed"),
    evidence: OUTBOX_EVIDENCE_SCHEMA.optional(),
    failureCode: CODE,
  }),
]);

export const FORENSIC_OUTBOX_COMMAND_SCHEMA = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("prepare"), eventId: IDENTIFIER, inputHash: SHA256_HEX }),
  z.strictObject({ type: z.literal("commit"), eventId: IDENTIFIER, inputHash: SHA256_HEX, evidence: OUTBOX_EVIDENCE_SCHEMA }),
  z.strictObject({ type: z.literal("authorize-forward"), eventId: IDENTIFIER, inputHash: SHA256_HEX }),
  z.strictObject({ type: z.literal("record-receipt"), eventId: IDENTIFIER, inputHash: SHA256_HEX, receipt: FORENSIC_RECEIPT_SCHEMA }),
  z.strictObject({ type: z.literal("fail"), eventId: IDENTIFIER, inputHash: SHA256_HEX, failureCode: CODE }),
]);

const FORENSIC_SCHEMA_SOURCES = {
  actor: FORENSIC_ACTOR_SCHEMA,
  agent: FORENSIC_AGENT_SCHEMA,
  correlation: FORENSIC_CORRELATION_SCHEMA,
  error: FORENSIC_ERROR_SCHEMA,
  event: FORENSIC_EVENT_SCHEMA,
  header: FORENSIC_HEADER_ENTRY_SCHEMA,
  headers: FORENSIC_HEADERS_SCHEMA,
  ledgerVerificationAnchor: FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA,
  ledgerVerificationRecord: FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA,
  outboxCommand: FORENSIC_OUTBOX_COMMAND_SCHEMA,
  outboxState: FORENSIC_OUTBOX_STATE_SCHEMA,
  projection: FORENSIC_PROJECTION_SCHEMA,
  rawCapture: FORENSIC_RAW_CAPTURE_SCHEMA,
  receipt: FORENSIC_RECEIPT_SCHEMA,
  sequence: FORENSIC_SEQUENCE_SCHEMA,
  timestamp: FORENSIC_TIMESTAMP_SCHEMA,
  tool: FORENSIC_TOOL_SCHEMA,
  turn: FORENSIC_TURN_SCHEMA,
  usage: FORENSIC_USAGE_SCHEMA,
} as const;

export const GENERATED_FORENSIC_SCHEMAS = deepFreeze(Object.fromEntries(
  Object.entries(FORENSIC_SCHEMA_SOURCES).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      cycles: "ref",
      reused: "ref",
    }),
  ]),
));

export const FORENSIC_SCHEMA_BUNDLE_HASH = canonicalHash(GENERATED_FORENSIC_SCHEMAS);
export const FORENSIC_SCHEMA_ARTIFACT_VERSION = schemaId("forensic-schemas", 1);

export type ForensicTimestamp = Readonly<z.infer<typeof FORENSIC_TIMESTAMP_SCHEMA>>;
export type ForensicSequence = z.infer<typeof FORENSIC_SEQUENCE_SCHEMA>;
export type ForensicActor = Readonly<z.infer<typeof FORENSIC_ACTOR_SCHEMA>>;
export type ForensicCorrelation = Readonly<z.infer<typeof FORENSIC_CORRELATION_SCHEMA>>;
export type ForensicHeaderEntry = Readonly<z.infer<typeof FORENSIC_HEADER_ENTRY_SCHEMA>>;
export type ForensicHeaders = Readonly<z.infer<typeof FORENSIC_HEADERS_SCHEMA>>;
export type ForensicUsage = Readonly<z.infer<typeof FORENSIC_USAGE_SCHEMA>>;
export type ForensicError = Readonly<z.infer<typeof FORENSIC_ERROR_SCHEMA>>;
export type ForensicTool = Readonly<z.infer<typeof FORENSIC_TOOL_SCHEMA>>;
export type ForensicTurn = Readonly<z.infer<typeof FORENSIC_TURN_SCHEMA>>;
export type ForensicAgent = Readonly<z.infer<typeof FORENSIC_AGENT_SCHEMA>>;
export type ForensicRawCapture = Readonly<z.infer<typeof FORENSIC_RAW_CAPTURE_SCHEMA>>;
export type ForensicEvent = Readonly<z.infer<typeof FORENSIC_EVENT_SCHEMA>>;
export type ForensicProjection = Readonly<z.infer<typeof FORENSIC_PROJECTION_SCHEMA>>;
export type ForensicLedgerVerificationRecord = Readonly<z.infer<typeof FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA>>;
export type ForensicLedgerVerificationAnchor = Readonly<z.infer<typeof FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA>>;
export type ForensicReceipt = Readonly<z.infer<typeof FORENSIC_RECEIPT_SCHEMA>>;
export type ForensicOutboxState = Readonly<z.infer<typeof FORENSIC_OUTBOX_STATE_SCHEMA>>;
export type ForensicOutboxCommand = Readonly<z.infer<typeof FORENSIC_OUTBOX_COMMAND_SCHEMA>>;

function utf8String(maximumBytes: number, minimumCharacters = 0): z.ZodString {
  return z.string().min(minimumCharacters).max(maximumBytes)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes, "UTF-8 byte ceiling exceeded");
}

function boundedCanonicalDecimal(maximum: string, allowZero: boolean): z.ZodString {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u;
  const maximumValue = BigInt(maximum);
  return z.string().max(maximum.length).regex(pattern)
    .refine(
      (value) => pattern.test(value) && BigInt(value) <= maximumValue,
      "Decimal value exceeds its configured ceiling",
    );
}

function canonicalBase64Bytes(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= LIMITS.maximumTextBytes && bytes.toString("base64") === value ? bytes : undefined;
}

type ExactPayload = Readonly<{
  contentBase64: string;
  byteLength: number;
  contentSha256: string;
}>;

function exactPayloadSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<T> {
  return schema.superRefine((value, context) => {
    const payload = value as ExactPayload;
    const bytes = canonicalBase64Bytes(payload.contentBase64);
    if (!bytes || bytes.byteLength !== payload.byteLength || sha256(bytes) !== payload.contentSha256) {
      context.addIssue({ code: "custom", message: "Payload bytes, length, and digest must agree" });
    }
  });
}
