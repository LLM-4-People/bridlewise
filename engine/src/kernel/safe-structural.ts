import { types } from "node:util";

import { InputError } from "./errors.ts";

export type StructuralSnapshotLimits = Readonly<{
  maximumDepth: number;
  maximumNodes: number;
}>;

export const STRUCTURAL_SNAPSHOT_ERROR_KINDS = Object.freeze([
  "maximumDepth",
  "maximumNodes",
  "nonFiniteNumber",
  "nonJsonValue",
  "proxy",
  "cycle",
  "arrayPrototype",
  "sparseArray",
  "arrayProperty",
  "objectPrototype",
  "symbolKey",
  "objectProperty",
] as const);

export type StructuralSnapshotErrorKind = typeof STRUCTURAL_SNAPSHOT_ERROR_KINDS[number];
export type StructuralSnapshotErrorCodes = Readonly<Partial<Record<StructuralSnapshotErrorKind, string>>>;
export type CompleteStructuralSnapshotErrorCodes = Readonly<Record<StructuralSnapshotErrorKind, string>>;

export type SnapshotJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SnapshotJsonValue[]
  | Readonly<{ [key: string]: SnapshotJsonValue }>;

export const SAFE_STRUCTURAL_REVISION = "trap-free-structural-snapshot/v2";

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = requiredGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const TYPED_ARRAY_BYTE_LENGTH_GETTER = requiredGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const TYPED_ARRAY_BYTE_OFFSET_GETTER = requiredGetter(TYPED_ARRAY_PROTOTYPE, "byteOffset");
const ARRAY_BUFFER_DETACHED_GETTER = requiredGetter(ArrayBuffer.prototype, "detached");
const ARRAY_BUFFER_RESIZABLE_GETTER = requiredGetter(ArrayBuffer.prototype, "resizable");
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

export function defineCompleteStructuralSnapshotErrorCodes(
  errorCodes: CompleteStructuralSnapshotErrorCodes,
): CompleteStructuralSnapshotErrorCodes {
  const snapshot = snapshotPlainRecord(
    errorCodes,
    STRUCTURAL_SNAPSHOT_ERROR_KINDS,
    { maximumDepth: 1, maximumNodes: STRUCTURAL_SNAPSHOT_ERROR_KINDS.length + 1 },
    "unsafe_structural_error_codes",
  );
  for (const kind of STRUCTURAL_SNAPSHOT_ERROR_KINDS) {
    const value = snapshot[kind];
    if (typeof value !== "string" || value.length === 0) {
      throw new InputError("Structural snapshot error codes are invalid", "unsafe_structural_error_codes");
    }
  }
  return Object.freeze(errorCodes);
}

/** Rejects proxies before reflection and copies data descriptors exactly once. */
export function snapshotJsonValue(
  input: unknown,
  limits: StructuralSnapshotLimits,
  code = "unsafe_structural_input",
  errorCodes: StructuralSnapshotErrorCodes = {},
): SnapshotJsonValue {
  assertSnapshotLimits(limits);
  return snapshot(input, 0, { nodes: 0, ancestors: new Set<object>() }, limits, code, errorCodes);
}

export function snapshotPlainRecord(
  input: unknown,
  allowedKeys: readonly string[],
  limits: StructuralSnapshotLimits,
  code = "unsafe_structural_record",
  errorCodes: StructuralSnapshotErrorCodes = {},
): Readonly<Record<string, SnapshotJsonValue>> {
  const snapshotValue = snapshotJsonValue(input, limits, code, errorCodes);
  if (snapshotValue === null || typeof snapshotValue !== "object" || Array.isArray(snapshotValue)) {
    throw new InputError("A plain data record is required", code);
  }
  const keys = Object.keys(snapshotValue);
  const allowed = new Set(allowedKeys);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new InputError("Plain data record fields are invalid", code);
  }
  return snapshotValue as Readonly<Record<string, SnapshotJsonValue>>;
}

export function snapshotPlainArray(
  input: unknown,
  limits: StructuralSnapshotLimits,
  code = "unsafe_structural_array",
  errorCodes: StructuralSnapshotErrorCodes = {},
): readonly SnapshotJsonValue[] {
  const snapshotValue = snapshotJsonValue(input, limits, code, errorCodes);
  if (!Array.isArray(snapshotValue)) throw new InputError("A plain data array is required", code);
  return snapshotValue;
}

/** Copies an exact Uint8Array or Buffer without invoking caller-controlled traps or accessors. */
export function snapshotUint8Array(
  input: unknown,
  maximumBytes: number,
): Uint8Array {
  const code = "unsafe_byte_input";
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new InputError("Byte snapshot limit is invalid", "unsafe_byte_snapshot_limit");
  }
  assertNotProxy(input, code);
  if (!types.isUint8Array(input)) {
    throw new InputError("An exact Uint8Array or Buffer is required", code);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
    throw new InputError("Uint8Array subclasses and wrappers are forbidden", code);
  }
  const backing = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, input, []) as unknown;
  if (types.isSharedArrayBuffer(backing)) {
    throw new InputError("Shared byte backing is forbidden", code);
  }
  if (!types.isArrayBuffer(backing) || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype) {
    throw new InputError("Exact ArrayBuffer backing is required", code);
  }
  if (Reflect.apply(ARRAY_BUFFER_DETACHED_GETTER, backing, []) === true) {
    throw new InputError("Detached byte backing is forbidden", code);
  }
  if (Reflect.apply(ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true) {
    throw new InputError("Resizable byte backing is forbidden", code);
  }
  const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, input, []) as number;
  const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, input, []) as number;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes ||
    !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new InputError("Byte snapshot exceeds its byte bound", code);
  }
  assertExactByteProperties(input, byteLength, code);
  const result = new Uint8Array(byteLength);
  try {
    Reflect.apply(TYPED_ARRAY_SET, result, [input]);
  } catch {
    throw new InputError("Byte snapshot copy failed", code);
  }
  return result;
}

export function assertNotProxy(input: unknown, code = "proxy_forbidden"): void {
  if ((typeof input === "object" && input !== null) || typeof input === "function") {
    if (types.isProxy(input)) throw new InputError("Proxy values are forbidden", code);
  }
}

export function isProxyValue(input: unknown): boolean {
  return ((typeof input === "object" && input !== null) || typeof input === "function") && types.isProxy(input);
}

function snapshot(
  value: unknown,
  depth: number,
  state: { nodes: number; ancestors: Set<object> },
  limits: StructuralSnapshotLimits,
  code: string,
  errorCodes: StructuralSnapshotErrorCodes,
): SnapshotJsonValue {
  state.nodes += 1;
  if (state.nodes > limits.maximumNodes) {
    throw new InputError("Structural snapshot exceeds its node bound", errorCodes.maximumNodes ?? code);
  }
  if (depth > limits.maximumDepth) {
    throw new InputError("Structural snapshot exceeds its depth bound", errorCodes.maximumDepth ?? code);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new InputError("Non-finite numbers are forbidden", errorCodes.nonFiniteNumber ?? code);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    throw new InputError("Non-JSON value is forbidden", errorCodes.nonJsonValue ?? code);
  }
  assertNotProxy(value, errorCodes.proxy ?? code);
  if (state.ancestors.has(value)) throw new InputError("Cyclic input is forbidden", errorCodes.cycle ?? code);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) return snapshotArray(value, depth, state, limits, code, errorCodes);
    return snapshotObject(value, depth, state, limits, code, errorCodes);
  } finally {
    state.ancestors.delete(value);
  }
}

function snapshotArray(
  value: object,
  depth: number,
  state: { nodes: number; ancestors: Set<object> },
  limits: StructuralSnapshotLimits,
  code: string,
  errorCodes: StructuralSnapshotErrorCodes,
): readonly SnapshotJsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InputError("Array subclasses are forbidden", errorCodes.arrayPrototype ?? code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 || keys.length !== lengthDescriptor.value + 1) {
    throw new InputError("Sparse or exotic arrays are forbidden", errorCodes.sparseArray ?? code);
  }
  const result: SnapshotJsonValue[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new InputError("Array accessors and holes are forbidden", errorCodes.arrayProperty ?? code);
    }
    result.push(snapshot(descriptor.value, depth + 1, state, limits, code, errorCodes));
  }
  return Object.freeze(result);
}

function snapshotObject(
  value: object,
  depth: number,
  state: { nodes: number; ancestors: Set<object> },
  limits: StructuralSnapshotLimits,
  code: string,
  errorCodes: StructuralSnapshotErrorCodes,
): Readonly<Record<string, SnapshotJsonValue>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError("Class instances are forbidden", errorCodes.objectPrototype ?? code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new InputError("Symbol keys are forbidden", errorCodes.symbolKey ?? code);
  }
  const result = Object.create(null) as Record<string, SnapshotJsonValue>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new InputError("Accessors and hidden properties are forbidden", errorCodes.objectProperty ?? code);
    }
    result[key] = snapshot(descriptor.value, depth + 1, state, limits, code, errorCodes);
  }
  return Object.freeze(result);
}

function assertSnapshotLimits(limits: StructuralSnapshotLimits): void {
  assertNotProxy(limits, "unsafe_structural_limits");
  if (Object.getPrototypeOf(limits) !== Object.prototype && Object.getPrototypeOf(limits) !== null) {
    throw new InputError("Structural snapshot limits are invalid", "unsafe_structural_limits");
  }
  const descriptors = Object.getOwnPropertyDescriptors(limits);
  for (const name of ["maximumDepth", "maximumNodes"] as const) {
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
      !Number.isSafeInteger(descriptor.value) || descriptor.value < 1) {
      throw new InputError("Structural snapshot limits are invalid", "unsafe_structural_limits");
    }
  }
  if (Reflect.ownKeys(descriptors).length !== 2) {
    throw new InputError("Structural snapshot limits are invalid", "unsafe_structural_limits");
  }
}

function assertExactByteProperties(
  input: Uint8Array,
  byteLength: number,
  code: string,
): void {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== byteLength) {
    throw new InputError("Byte view properties are invalid", code);
  }
  for (let index = 0; index < byteLength; index += 1) {
    const key = String(index);
    if (keys[index] !== key) {
      throw new InputError("Byte view properties are invalid", code);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
      !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) {
      throw new InputError("Byte view properties are invalid", code);
    }
  }
}

function requiredGetter(owner: object, property: PropertyKey): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(owner, property)?.get;
  if (!getter) throw new InputError(`Required intrinsic getter is unavailable: ${String(property)}`, "safe_structural_intrinsic_getter_unavailable");
  return getter;
}
