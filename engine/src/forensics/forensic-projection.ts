import { InputError, SecurityError } from "../kernel/errors.ts";
import { computeBlindIndex, type BlindIndexCapability } from "./forensic-crypto.ts";
import {
  FORENSIC_EVENT_SCHEMA,
  FORENSIC_PROJECTION_SCHEMA,
  type ForensicEvent,
  type ForensicProjection,
} from "./forensic-contracts.ts";
import { canonicalizeLedgerJson } from "../kernel/ledger-canonical.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "../kernel/root-policy.ts";
import { FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS } from "./forensic-structural.ts";
import { isProxyValue, snapshotJsonValue, snapshotPlainArray } from "../kernel/safe-structural.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { schemaId } from "../kernel/product-identity.ts";

export const FORENSIC_PROJECTION_REVISION = "s3.1-redacted-projection/v2";

const ISSUED_PROJECTIONS = new WeakSet<object>();

export function projectForensicEvent(
  eventInput: unknown,
  blindIndexCapability?: BlindIndexCapability,
): ForensicProjection {
  let safeEvent: unknown;
  try {
    safeEvent = snapshotJsonValue(eventInput, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_projection_invalid");
  } catch {
    throw new InputError("Forensic projection input is invalid", "forensic_projection_invalid");
  }
  const parsedEvent = FORENSIC_EVENT_SCHEMA.safeParse(safeEvent);
  if (!parsedEvent.success) {
    throw new InputError("Forensic projection input is invalid", "forensic_projection_invalid");
  }
  const event = deepFreeze(parsedEvent.data) as ForensicEvent;
  const blindIndexes = blindIndexesFor(event, blindIndexCapability);
  const candidate = {
    schemaVersion: schemaId("forensic-projection", 1),
    eventId: event.eventId,
    timeBucket: `${event.timestamp.wallTime.slice(0, 16)}:00Z`,
    eventKind: event.eventKind,
    outcome: event.outcome,
    classification: event.classification,
    retention: retentionFor(event.classification),
    protocolFamily: protocolFamilyFor(event),
    sizeBucket: sizeBucketFor(event),
    ...(event.error === undefined ? {} : {
      safeError: {
        category: event.error.category,
        code: safeErrorCodeFor(event.error.category),
        retryable: event.error.retryable,
      },
    }),
    blindIndexes,
    policy: {
      rootPolicyHash: ROOT_POLICY_HASH,
      projectionRevision: FORENSIC_PROJECTION_REVISION,
    },
  };
  const parsed = FORENSIC_PROJECTION_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    throw new InputError("Forensic projection input is invalid", "forensic_projection_invalid");
  }
  const projection = deepFreeze(parsed.data) as ForensicProjection;
  ISSUED_PROJECTIONS.add(projection);
  const bytes = canonicalizeLedgerJson(projection);
  if (bytes.byteLength > ROOT_POLICY.forensics.limits.maximumProjectionBytes) {
    throw new InputError("Forensic projection exceeds its byte ceiling", "forensic_projection_too_large");
  }
  const leakage = inspectProjectionLeakage(projection);
  if (!leakage.safe) {
    throw new SecurityError("Forensic projection failed the independent leakage oracle", "forensic_projection_leakage");
  }
  return projection;
}

/** Independent deny-list oracle: it intentionally does not reuse projector field selection. */
export function inspectProjectionLeakage(
  candidate: unknown,
  forbiddenCanaries: readonly string[] = [],
): Readonly<{ safe: boolean; violations: readonly string[] }> {
  const violations: string[] = [];
  if (isProxyValue(candidate)) return deepFreeze({ safe: false, violations: ["projection-proxy-forbidden"] });
  const issued = typeof candidate === "object" && candidate !== null && ISSUED_PROJECTIONS.has(candidate);
  let safeCandidate: unknown;
  let safeCanaries: readonly unknown[];
  try {
    safeCandidate = snapshotJsonValue(candidate, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "projection-structure-invalid");
    safeCanaries = snapshotPlainArray(forbiddenCanaries, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "projection-canaries-invalid");
  } catch {
    return deepFreeze({ safe: false, violations: ["projection-structure-invalid"] });
  }
  const parsedProjection = FORENSIC_PROJECTION_SCHEMA.safeParse(safeCandidate);
  if (!parsedProjection.success) violations.push("projection-schema-invalid");
  else if (parsedProjection.data.blindIndexes.length > 0 && !issued) violations.push("blind-index-unissued");
  inspectNode(safeCandidate, "$", violations, new Set<object>());
  let serialized = "";
  try {
    serialized = canonicalizeLedgerJson(safeCandidate).toString("utf8");
  } catch (e) {handleError(e, { module: "forensic-projection", operation: "catch" });
    violations.push("projection-not-canonical-json");
  }
  for (const [index, canary] of safeCanaries.entries()) {
    if (typeof canary !== "string" || canary.length === 0) {
      violations.push(`canary-empty:${index}`);
      continue;
    }
    const representations = new Set([
      canary,
      Buffer.from(canary, "utf8").toString("base64"),
      encodeURIComponent(canary),
    ]);
    if ([...representations].some((representation) => serialized.includes(representation))) {
      violations.push(`canary-leaked:${index}`);
    }
  }
  const unique = [...new Set(violations)].toSorted();
  return deepFreeze({ safe: unique.length === 0, violations: unique });
}

function blindIndexesFor(
  event: ForensicEvent,
  capability: BlindIndexCapability | undefined,
): readonly Readonly<{ purpose: "request-correlation" | "session-correlation" | "actor-correlation"; digest: string }>[] {
  if (capability === undefined) return [];
  const values: Array<Readonly<{
    purpose: "request-correlation" | "session-correlation" | "actor-correlation";
    value: string;
  }>> = [];
  if (event.correlation.requestId !== undefined) {
    values.push({ purpose: "request-correlation", value: event.correlation.requestId });
  }
  if (event.correlation.sessionId !== undefined) {
    values.push({ purpose: "session-correlation", value: event.correlation.sessionId });
  }
  values.push({ purpose: "actor-correlation", value: event.actor.id });
  return Object.freeze(values.map(({ purpose, value }) => Object.freeze({
    purpose,
    digest: computeBlindIndex(purpose, value, capability),
  })));
}

function inspectNode(
  value: unknown,
  path: string,
  violations: string[],
  ancestors: Set<object>,
): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    violations.push(`${path}:cycle`);
    return;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) inspectNode(child, `${path}[${index}]`, violations, ancestors);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      violations.push(`${path}:class-instance`);
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        violations.push(`${path}:symbol-key`);
        continue;
      }
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
      if (FORBIDDEN_PROJECTION_FIELDS.has(normalized)) violations.push(`${path}.${key}:forbidden-field`);
      inspectNode((value as Readonly<Record<string, unknown>>)[key], `${path}.${key}`, violations, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

const FORBIDDEN_PROJECTION_FIELDS = new Set([
  "arguments",
  "authenticationtag",
  "captures",
  "ciphertext",
  "content",
  "contentbase64",
  "contentsha256",
  "headers",
  "message",
  "nonce",
  "output",
  "prompt",
  "raw",
  "reasoning",
  "result",
  "secret",
  "stack",
  "stderr",
  "stdout",
  "text",
  "value",
]);

function protocolFamilyFor(event: ForensicEvent): ForensicProjection["protocolFamily"] {
  const protocol = event.tool?.protocol.toLowerCase() ?? "";
  if (event.eventKind.startsWith("mcp.") || protocol.includes("mcp")) return "mcp";
  if (protocol.includes("openai") || protocol.includes("responses") || protocol.includes("chat-completions")) {
    return "openai-compatible";
  }
  if (protocol === "local-process") return "local-process";
  return "unknown";
}

function retentionFor(classification: ForensicEvent["classification"]): ForensicProjection["retention"] {
  if (classification === "credential-secret") return "secret";
  if (classification === "sensitive" || classification === "regulated-restricted") return "restricted";
  return "standard";
}

function safeErrorCodeFor(category: NonNullable<ForensicEvent["error"]>["category"]): NonNullable<ForensicProjection["safeError"]>["code"] {
  return `${category}_error`;
}

function sizeBucketFor(event: ForensicEvent): ForensicProjection["sizeBucket"] {
  let bytes = 0;
  const addText = (value: string | undefined): void => {
    if (value !== undefined) bytes += Buffer.byteLength(value, "utf8");
  };
  for (const capture of event.captures) {
    if ("byteLength" in capture) bytes += capture.byteLength;
    if (capture.kind === "headers") {
      for (const entry of capture.entries) {
        addText(entry.name);
        addText(entry.value);
      }
    }
    if (capture.kind === "error") {
      addText(capture.error.message);
      addText(capture.error.stack);
      for (const cause of capture.error.causes) {
        addText(cause.message);
        addText(cause.stack);
      }
    }
  }
  if (bytes === 0) return "empty";
  if (bytes < 1_024) return "under-1k";
  if (bytes < 16_384) return "under-16k";
  if (bytes < 262_144) return "under-256k";
  if (bytes < 1_048_576) return "under-1m";
  return "at-ceiling";
}
