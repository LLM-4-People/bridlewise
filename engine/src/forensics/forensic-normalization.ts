import { types } from "node:util";

import { InputError } from "../kernel/errors.ts";
import {
  FORENSIC_ERROR_SCHEMA,
  FORENSIC_RAW_CAPTURE_SCHEMA,
  type ForensicError,
  type ForensicRawCapture,
} from "./forensic-contracts.ts";
import { canonicalizeLedgerJson } from "../kernel/ledger-canonical.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS } from "./forensic-structural.ts";
import { assertNotProxy, snapshotJsonValue, snapshotPlainArray } from "../kernel/safe-structural.ts";
import { isPlainObject } from "../shared/type-guards.ts";

export const FORENSIC_NORMALIZATION_REVISION = "s3.1-exact-byte-normalization/v2";

export type PlainErrorInput = Readonly<{
  category: ForensicError["category"];
  code: string;
  message: string;
  stack?: string;
  retryable: boolean;
  causes?: readonly Readonly<{
    name: string;
    message: string;
    code?: string;
    stack?: string;
  }>[];
}>;

export function normalizeBytesCapture(bytes: Uint8Array, mediaType: string): ForensicRawCapture {
  const copy = exactBytes(bytes);
  return parseCapture({
    kind: "bytes",
    mediaType,
    contentBase64: copy.toString("base64"),
    byteLength: copy.byteLength,
    contentSha256: sha256(copy),
  });
}

export function normalizeOrderedHeaders(
  entries: readonly (readonly [string, string])[],
): ForensicRawCapture {
  const normalized = snapshotPlainArray(entries, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_headers_invalid", {
    arrayPrototype: "forensic_class_forbidden",
    arrayProperty: "forensic_class_forbidden",
  }).map((entry) => {
    const pair = snapshotPlainArray(entry, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_headers_invalid", {
      arrayPrototype: "forensic_class_forbidden",
      arrayProperty: "forensic_class_forbidden",
    });
    if (pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new InputError("Headers must be ordered string pairs", "forensic_headers_invalid");
    }
    assertUtf8Ceiling(pair[0], ROOT_POLICY.forensics.limits.maximumHeaderNameBytes, "forensic_header_name_too_large");
    assertUtf8Ceiling(pair[1], ROOT_POLICY.forensics.limits.maximumHeaderValueBytes, "forensic_header_value_too_large");
    return { name: pair[0], value: pair[1] };
  });
  return parseCapture({ kind: "headers", entries: normalized });
}

export function normalizeStreamCapture(
  stream: "stdout" | "stderr",
  bytes: Uint8Array,
  mediaType = "application/octet-stream",
): ForensicRawCapture {
  const copy = exactBytes(bytes);
  return parseCapture({
    kind: "stream",
    stream,
    mediaType,
    contentBase64: copy.toString("base64"),
    byteLength: copy.byteLength,
    contentSha256: sha256(copy),
  });
}

export function normalizeToolBytesCapture(
  direction: "arguments" | "result",
  callId: string,
  bytes: Uint8Array,
  mediaType: string,
): ForensicRawCapture {
  const copy = exactBytes(bytes);
  return parseCapture({
    kind: "tool-payload",
    direction,
    callId,
    mediaType,
    contentBase64: copy.toString("base64"),
    byteLength: copy.byteLength,
    contentSha256: sha256(copy),
  });
}

export function normalizeToolJsonCapture(
  direction: "arguments" | "result",
  callId: string,
  value: unknown,
): ForensicRawCapture {
  return normalizeToolBytesCapture(direction, callId, canonicalizeLedgerJson(value), "application/json");
}

export function normalizePlainErrorCapture(input: unknown): ForensicRawCapture {
  const safeInput = snapshotJsonValue(input, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_object_invalid", {
    objectPrototype: "forensic_class_forbidden",
    arrayPrototype: "forensic_class_forbidden",
  });
  if (!isPlainObject(safeInput)) return rejectClass();
  assertOnlyKeys(safeInput, ["category", "code", "message", "stack", "retryable", "causes"]);
  const causes = (safeInput.causes === undefined
    ? []
    : snapshotPlainArray(safeInput.causes, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_error_invalid")).map((cause: unknown) => {
    if (!isPlainObject(cause)) return rejectClass();
    assertOnlyKeys(cause, ["name", "message", "code", "stack"]);
    return copyDefinedStrings(cause, ["name", "message", "code", "stack"]);
  });
  const candidate = {
    ...copyDefinedStrings(safeInput, ["category", "code", "message", "stack"]),
    retryable: safeInput.retryable,
    causes,
  };
  const parsed = FORENSIC_ERROR_SCHEMA.safeParse(candidate);
  if (!parsed.success) throw new InputError("Plain error capture is invalid", "forensic_error_invalid");
  for (const field of [parsed.data.message, parsed.data.stack, ...parsed.data.causes.flatMap((cause) => [cause.message, cause.stack])]) {
    if (field !== undefined) assertUtf8Ceiling(field, ROOT_POLICY.forensics.limits.maximumTextBytes, "forensic_text_too_large");
  }
  return parseCapture({ kind: "error", error: parsed.data });
}

function exactBytes(bytes: Uint8Array): Buffer {
  assertNotProxy(bytes, "forensic_class_forbidden");
  if (!(bytes instanceof Uint8Array) || !types.isUint8Array(bytes) ||
    (Buffer.isBuffer(bytes)
      ? Object.getPrototypeOf(bytes) !== Buffer.prototype
      : Object.getPrototypeOf(bytes) !== Uint8Array.prototype)) {
    return rejectClass();
  }
  if (bytes.byteLength > ROOT_POLICY.forensics.limits.maximumTextBytes) {
    throw new InputError("Raw capture exceeds the byte ceiling", "forensic_capture_too_large");
  }
  return Buffer.from(bytes);
}

function parseCapture(candidate: unknown): ForensicRawCapture {
  const parsed = FORENSIC_RAW_CAPTURE_SCHEMA.safeParse(candidate);
  if (!parsed.success) throw new InputError("Raw forensic capture is invalid", "forensic_capture_invalid");
  return deepFreeze(parsed.data) as ForensicRawCapture;
}

function assertUtf8Ceiling(value: string, maximum: number, code: string): void {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new InputError("Forensic text exceeds its UTF-8 byte ceiling", code);
  }
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedSet.has(key)) ||
    Object.entries(Object.getOwnPropertyDescriptors(value)).some(([, descriptor]) =>
      !("value" in descriptor) || !descriptor.enumerable
    )) {
    throw new InputError("Plain forensic object has unsupported fields", "forensic_object_invalid");
  }
}

function copyDefinedStrings(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new InputError("Plain forensic text field is invalid", "forensic_error_invalid");
    }
    result[field] = value;
  }
  return result;
}

function rejectClass(): never {
  throw new InputError("Arbitrary class instances are forbidden in forensic normalization", "forensic_class_forbidden");
}
