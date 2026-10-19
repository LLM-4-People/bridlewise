import { InputError } from "./errors.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import {
  defineCompleteStructuralSnapshotErrorCodes,
  snapshotJsonValue,
  snapshotPlainRecord,
  type CompleteStructuralSnapshotErrorCodes,
} from "./safe-structural.ts";

export type LedgerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LedgerJsonValue[]
  | Readonly<{ [key: string]: LedgerJsonValue }>;

export type LedgerCanonicalLimits = Readonly<{
  maximumInputBytes: number;
  maximumCanonicalBytes: number;
  maximumDepth: number;
  maximumNodes: number;
}>;

export const LEDGER_CANONICAL_REVISION = "rfc8785-erratum-7920-bounded/v2";

export const DEFAULT_LEDGER_CANONICAL_LIMITS: LedgerCanonicalLimits = Object.freeze({
  maximumInputBytes: ROOT_POLICY.forensics.limits.maximumInputBytes,
  maximumCanonicalBytes: ROOT_POLICY.forensics.limits.maximumCanonicalBytes,
  maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth,
  maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes,
});

const LEDGER_STRUCTURAL_ERROR_CODES = defineCompleteStructuralSnapshotErrorCodes({
  maximumDepth: "ledger_json_depth_exceeded",
  maximumNodes: "ledger_json_nodes_exceeded",
  nonFiniteNumber: "ledger_json_number_invalid",
  nonJsonValue: "ledger_json_value_invalid",
  proxy: "ledger_json_object_invalid",
  cycle: "ledger_json_cycle",
  arrayPrototype: "ledger_json_array_invalid",
  sparseArray: "ledger_json_sparse_array",
  arrayProperty: "ledger_json_array_invalid",
  objectPrototype: "ledger_json_object_invalid",
  symbolKey: "ledger_json_key_invalid",
  objectProperty: "ledger_json_object_invalid",
} as const satisfies CompleteStructuralSnapshotErrorCodes);

/** RFC 8785 canonical UTF-8, with verified erratum 7920's negative-zero rejection. */
export function canonicalizeLedgerJson(
  value: unknown,
  limits: LedgerCanonicalLimits = DEFAULT_LEDGER_CANONICAL_LIMITS,
): Buffer {
  const safeLimits = normalizeCanonicalLimits(limits);
  const safeValue = snapshotJsonValue(value, {
    maximumDepth: safeLimits.maximumDepth,
    maximumNodes: safeLimits.maximumNodes,
  }, "ledger_json_structure_invalid", LEDGER_STRUCTURAL_ERROR_CODES);
  const writer = new BoundedWriter(safeLimits.maximumCanonicalBytes);
  const state = { nodes: 0, ancestors: new Set<object>() };
  encode(safeValue, 0, safeLimits, state, writer);
  return Buffer.from(writer.finish(), "utf8");
}

export function canonicalizeLedgerJsonText(
  value: unknown,
  limits: LedgerCanonicalLimits = DEFAULT_LEDGER_CANONICAL_LIMITS,
): string {
  return canonicalizeLedgerJson(value, limits).toString("utf8");
}

/** Parses JSON without losing duplicate-key or negative-zero evidence before canonicalizing it. */
export function parseAndCanonicalizeLedgerJson(
  text: string,
  limits: LedgerCanonicalLimits = DEFAULT_LEDGER_CANONICAL_LIMITS,
): Readonly<{ value: LedgerJsonValue; canonicalUtf8: Buffer }> {
  const safeLimits = normalizeCanonicalLimits(limits);
  if (typeof text !== "string") throw new InputError("Ledger JSON text must be a string", "ledger_json_syntax_invalid");
  if (Buffer.byteLength(text, "utf8") > safeLimits.maximumInputBytes) {
    throw new InputError("Ledger JSON exceeds the input byte ceiling", "ledger_json_input_too_large");
  }
  const value = new StrictJsonParser(text, safeLimits).parse();
  return Object.freeze({ value, canonicalUtf8: canonicalizeLedgerJson(value, safeLimits) });
}

function normalizeCanonicalLimits(limits: LedgerCanonicalLimits): LedgerCanonicalLimits {
  const value = snapshotPlainRecord(
    limits,
    ["maximumInputBytes", "maximumCanonicalBytes", "maximumDepth", "maximumNodes"],
    { maximumDepth: 1, maximumNodes: 8 },
    "ledger_json_limits_invalid",
  );
  for (const field of ["maximumInputBytes", "maximumCanonicalBytes", "maximumDepth", "maximumNodes"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) {
      throw new InputError(`Ledger canonical limit ${field} is invalid`, "ledger_json_limits_invalid");
    }
  }
  return Object.freeze({
    maximumInputBytes: value.maximumInputBytes as number,
    maximumCanonicalBytes: value.maximumCanonicalBytes as number,
    maximumDepth: value.maximumDepth as number,
    maximumNodes: value.maximumNodes as number,
  });
}

function encode(
  value: unknown,
  depth: number,
  limits: LedgerCanonicalLimits,
  state: { nodes: number; ancestors: Set<object> },
  writer: BoundedWriter,
): void {
  state.nodes += 1;
  if (state.nodes > limits.maximumNodes) {
    throw new InputError("Ledger JSON exceeds the node ceiling", "ledger_json_nodes_exceeded");
  }
  if (depth > limits.maximumDepth) {
    throw new InputError("Ledger JSON exceeds the depth ceiling", "ledger_json_depth_exceeded");
  }
  if (value === null || typeof value === "boolean") {
    writer.push(String(value));
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarSequence(value);
    writer.push(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InputError("Ledger JSON contains a non-finite number", "ledger_json_number_invalid");
    }
    if (Object.is(value, -0)) {
      throw new InputError("Ledger JSON contains negative zero", "ledger_json_negative_zero");
    }
    writer.push(JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") {
    throw new InputError("Ledger JSON contains a non-JSON value", "ledger_json_value_invalid");
  }
  if (state.ancestors.has(value)) {
    throw new InputError("Ledger JSON contains a cycle", "ledger_json_cycle");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      encodeArray(value, depth, limits, state, writer);
    } else {
      encodeObject(value, depth, limits, state, writer);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function encodeArray(
  value: readonly unknown[],
  depth: number,
  limits: LedgerCanonicalLimits,
  state: { nodes: number; ancestors: Set<object> },
  writer: BoundedWriter,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol") ||
    keys.some((key) => typeof key !== "string" || (key !== "length" && !isArrayIndex(key, value.length))) ||
    value.length > limits.maximumNodes) {
    throw new InputError("Ledger JSON contains an unsupported array shape", "ledger_json_array_invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new InputError("Ledger JSON contains a sparse array", "ledger_json_sparse_array");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new InputError("Ledger JSON contains an accessor array entry", "ledger_json_array_invalid");
    }
  }
  writer.push("[");
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) writer.push(",");
    encode(value[index], depth + 1, limits, state, writer);
  }
  writer.push("]");
}

function encodeObject(
  value: object,
  depth: number,
  limits: LedgerCanonicalLimits,
  state: { nodes: number; ancestors: Set<object> },
  writer: BoundedWriter,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError("Ledger JSON contains an arbitrary class instance", "ledger_json_object_invalid");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new InputError("Ledger JSON contains a symbol key", "ledger_json_key_invalid");
  }
  const keys = (ownKeys as string[]).toSorted(compareUtf16);
  for (const key of keys) {
    assertUnicodeScalarSequence(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new InputError("Ledger JSON contains a hidden or accessor property", "ledger_json_object_invalid");
    }
  }
  writer.push("{");
  for (const [index, key] of keys.entries()) {
    if (index > 0) writer.push(",");
    writer.push(JSON.stringify(key));
    writer.push(":");
    encode((value as Readonly<Record<string, unknown>>)[key], depth + 1, limits, state, writer);
  }
  writer.push("}");
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InputError("Ledger JSON contains a lone surrogate", "ledger_json_unicode_invalid");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new InputError("Ledger JSON contains a lone surrogate", "ledger_json_unicode_invalid");
    }
  }
}

class BoundedWriter {
  readonly #parts: string[] = [];
  #bytes = 0;
  readonly #maximumBytes: number;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  push(value: string): void {
    this.#bytes += Buffer.byteLength(value, "utf8");
    if (this.#bytes > this.#maximumBytes) {
      throw new InputError("Canonical ledger JSON exceeds the output byte ceiling", "ledger_json_output_too_large");
    }
    this.#parts.push(value);
  }

  finish(): string {
    return this.#parts.join("");
  }
}

class StrictJsonParser {
  #index = 0;
  #nodes = 0;
  readonly #text: string;
  readonly #limits: LedgerCanonicalLimits;

  constructor(text: string, limits: LedgerCanonicalLimits) {
    this.#text = text;
    this.#limits = limits;
  }

  parse(): LedgerJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.#index !== this.#text.length) this.fail("ledger_json_syntax_invalid");
    return value;
  }

  private parseValue(depth: number): LedgerJsonValue {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maximumNodes) this.fail("ledger_json_nodes_exceeded");
    if (depth > this.#limits.maximumDepth) this.fail("ledger_json_depth_exceeded");
    const current = this.#text[this.#index];
    if (current === '"') return this.parseString();
    if (current === "{") return this.parseObject(depth);
    if (current === "[") return this.parseArray(depth);
    if (current === "t" && this.consumeLiteral("true")) return true;
    if (current === "f" && this.consumeLiteral("false")) return false;
    if (current === "n" && this.consumeLiteral("null")) return null;
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) {
      return this.parseNumber();
    }
    return this.fail("ledger_json_syntax_invalid");
  }

  private parseObject(depth: number): LedgerJsonValue {
    this.#index += 1;
    const result: Record<string, LedgerJsonValue> = Object.create(null) as Record<string, LedgerJsonValue>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return result;
    while (true) {
      if (this.#text[this.#index] !== '"') this.fail("ledger_json_syntax_invalid");
      const key = this.parseString();
      if (keys.has(key)) this.fail("ledger_json_duplicate_key");
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("ledger_json_syntax_invalid");
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      if (this.consume("}")) return result;
      if (!this.consume(",")) this.fail("ledger_json_syntax_invalid");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): LedgerJsonValue {
    this.#index += 1;
    const result: LedgerJsonValue[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return result;
    while (true) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume("]")) return result;
      if (!this.consume(",")) this.fail("ledger_json_syntax_invalid");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index]!;
      const code = this.#text.charCodeAt(this.#index);
      if (character === '"') {
        this.#index += 1;
        let value: string;
        try {
          value = JSON.parse(this.#text.slice(start, this.#index)) as string;
        } catch {
          return this.fail("ledger_json_string_invalid");
        }
        assertUnicodeScalarSequence(value);
        return value;
      }
      if (code < 0x20) this.fail("ledger_json_string_invalid");
      if (character === "\\") {
        this.#index += 1;
        const escape = this.#text[this.#index];
        if (escape === "u") {
          const hexadecimal = this.#text.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) this.fail("ledger_json_string_invalid");
          this.#index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) this.fail("ledger_json_string_invalid");
      }
      this.#index += 1;
    }
    return this.fail("ledger_json_string_invalid");
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.#text.slice(this.#index));
    if (!match) return this.fail("ledger_json_number_invalid");
    this.#index += match[0].length;
    const next = this.#text[this.#index];
    if (next !== undefined && !/[\s,\]}]/u.test(next)) this.fail("ledger_json_number_invalid");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("ledger_json_number_invalid");
    if (Object.is(value, -0)) this.fail("ledger_json_negative_zero");
    return value;
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.#text.startsWith(literal, this.#index)) return false;
    this.#index += literal.length;
    return true;
  }

  private consume(character: string): boolean {
    if (this.#text[this.#index] !== character) return false;
    this.#index += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (this.#text[this.#index] === " " || this.#text[this.#index] === "\n" ||
      this.#text[this.#index] === "\r" || this.#text[this.#index] === "\t") this.#index += 1;
  }

  private fail(code: string): never {
    throw new InputError(`Invalid ledger JSON at UTF-16 offset ${this.#index}`, code);
  }
}
