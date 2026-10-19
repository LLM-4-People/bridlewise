import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { InputError } from "./errors.ts";
import { schemaId } from "./product-identity.ts";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | Readonly<{ [key: string]: CanonicalValue }>;

export type DeepReadonly<T> =
  T extends (...arguments_: never[]) => unknown ? T
    : T extends readonly (infer Entry)[] ? readonly DeepReadonly<Entry>[]
    : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export const CANONICAL_DOMAIN_HASH_ENCODING = schemaId("canonical-domain-envelope", 1);

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Raw 32-byte SHA-256 digest. Use when a caller needs the raw hash bytes
 * (for example sharding an id by its first byte) instead of the hex string
 * returned by {@link sha256}. Centralizing both forms here means a
 * prevention test can deny direct `createHash` imports from `node:crypto`
 * outside this owner module.
 */
export function sha256Bytes(bytes: string | Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

/**
 * The id git gives the blob holding `bytes` in a repository whose object ids
 * look like `like` (SHA-1 or SHA-256: their length says) — for bytes git
 * cannot be asked to hash from a path, such as a symbolic link's target.
 */
export function gitBlobId(bytes: Uint8Array, like: string): string {
  return createHash(like.length === 64 ? "sha256" : "sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function canonicalDomainHash(domain: string, payload: unknown): string {
  if (!/^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/u.test(domain)) {
    throw new InputError("Canonical hash domain is invalid");
  }
  return sha256(canonicalJson({
    domain,
    encoding: CANONICAL_DOMAIN_HASH_ENCODING,
    payload,
  }));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Prefixed canonical identifier using a full 128-bit UUID. Every entity
 * identifier in the harness (run, turn, agent, attempt, task, event, tool
 * call, command, mistake, snapshot, trace, ...) MUST be produced by this
 * function so the identifier carries a self-describing domain prefix and
 * routes through the single canonical owner. A prevention test denies
 * `randomUUID` imports from `node:crypto` outside this module, so a new
 * caller that bypasses the owner is caught automatically.
 */
export function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Prefixed short identifier using the first 8 hex characters of a UUID
 * (32 bits of entropy). Use for short-lived or composite identifiers where
 * the full 128-bit UUID is unnecessary and a sibling key already disambiguates
 * (for example a file-effect event id that already carries an effect id, or
 * a delegated-task id scoped within a single run). The prefix keeps the
 * identifier self-describing and auto-discoverable as a canonical-owner
 * consumer. The 8-hex suffix length is this owner's format contract for
 * short identifiers; it is not a configurable value.
 */
export function generateShortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Raw cryptographically-secure UUID for non-identifier uniqueness uses
 * (temporary file paths, nonces). Entity identifiers MUST use
 * {@link generateId} or {@link generateShortId} so they carry a domain
 * prefix; this wrapper exists only for cases where a prefix would be
 * nonsensical. Centralizing the access here means a single prevention test
 * can deny direct `randomUUID` imports from `node:crypto` outside this
 * owner module.
 */
export function randomUuid(): string {
  return randomUUID();
}

/**
 * Cryptographically-secure random byte sequence. Centralizing the access
 * here means a single prevention test can deny direct `randomBytes` imports
 * from `node:crypto` outside this owner module, so a new caller that
 * bypasses the owner is caught automatically. The byte length is validated
 * at this trust boundary (a non-negative safe integer) so a malformed
 * request from a caller cannot reach the underlying primitive.
 */
export function randomBytes(byteLength: number): Buffer {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new InputError("Random byte length must be a non-negative safe integer", "invalid_random_byte_length");
  }
  return cryptoRandomBytes(byteLength);
}

/**
 * The single canonical SHA-256 hex-digest regular expression. Every module
 * that validates a 64-character lowercase hex digest (`/^[0-9a-f]{64}$/u`)
 * must import this constant or the derived `sha256HexSchema` instead of
 * re-declaring an inline copy — inline copies have drifted before (missing
 * `u` flag, mismatched anchors). The canonical hashing module owns it.
 */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/u;

/**
 * Derived Zod schema for a 64-character lowercase SHA-256 hex digest.
 * Consumers that need a Zod validator should use this instead of
 * `z.string.regex(/^[0-9a-f]{64}$/u)` so the pattern has one owner.
 */
export const sha256HexSchema = z.string().regex(SHA256_HEX_REGEX);

/**
 * Type guard: `true` when `value` is a safe integer and `>= 0`. Replaces the
 * repeated `!Number.isSafeInteger(v) || v < 0` guard across trust boundaries.
 */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Type guard: `true` when `value` is a finite, safe, positive number (`> 0`).
 * Replaces the repeated `Number.isSafeInteger(v) && v > 0` bound check.
 */
export function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError("Canonical data contains a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new InputError("Canonical data contains an unsupported value");
  if (ancestors.has(value)) throw new InputError("Canonical data contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new InputError("Canonical data contains a sparse array");
        entries.push(encode(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new InputError("Canonical data contains an unsupported object");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new InputError("Canonical data contains an unsupported key");
    }
    const object = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(object).toSorted().map((key) =>
      `${JSON.stringify(key)}:${encode(object[key]!, ancestors)}`
    );
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
