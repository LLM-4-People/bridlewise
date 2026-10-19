/**
 * Canonical shared UTF-16-code-unit <-> UTF-8-byte offset authority.
 *
 * JavaScript strings are UTF-16. AST positions (Babel, TypeScript), regex
 * match indices, and `String.prototype.slice` indices are UTF-16 code-unit
 * offsets. Redaction spans, content-addressed evidence, and stable selectors
 * need UTF-8 byte offsets. The naive conversion
 * `Buffer.byteLength(text.slice(0, offset), "utf8")` is correct only when
 * `offset` lands on a code-point boundary. An offset that splits a surrogate
 * pair makes the slice end in a lone high surrogate, which `Buffer.byteLength`
 * silently rewrites to U+FFFD (3 bytes), producing a phantom byte offset that
 * points into the middle of a 4-byte UTF-8 sequence. This utility detects and
 * rejects such offsets so spans never corrupt astral characters.
 *
 * Two consumption shapes are exported:
 * - standalone `utf8ByteOffset` / `utf8ByteSpan` for low-volume callers
 * (e.g. occurrence selectors, secret-span candidate adapters); strict,
 * O(n) per call.
 * - a precomputed `Utf8OffsetMap` for hot paths (e.g. the qualification
 * inventory, which emits thousands of spans per module); strict, O(1)
 * per lookup, with surrogate-split and lone-surrogate boundaries marked
 * by a sentinel.
 *
 * Boundary rules enforced by every exported converter:
 * - the offset must be a safe integer (or the negative sentinel -1 for
 * `utf8ByteOffset` only, matching the authority-selector convention
 * `node.start?? -1`);
 * - the offset must not split a surrogate pair (a high surrogate at
 * `source[i-1]` immediately followed by a low surrogate at `source[i]`);
 * - the offset must not land on a lone surrogate (defensive: callers that
 * decode bytes with a fatal UTF-8 decoder never produce lone surrogates,
 * but the utility rejects them so a malformed string can never produce a
 * phantom byte offset);
 * - for spans, `start <= end`.
 *
 * This is a low-level leaf. It depends only on `src/errors.ts` (the canonical
 * `InputError` hierarchy) so it can be consumed by both the secret/PII span
 * gateway and the qualification authority selectors without creating a
 * circular dependency.
 */

import { InputError } from "../kernel/errors.ts";

const INVALID_BOUNDARY: number = 0xffffffff;
const HIGH_SURROGATE_START: number = 0xd800;
const HIGH_SURROGATE_END: number = 0xdbff;
const LOW_SURROGATE_START: number = 0xdc00;
const LOW_SURROGATE_END: number = 0xdfff;

export type Utf8OffsetMap = Readonly<Uint32Array>;

export interface ByteSpan {
  readonly startByte: number;
  readonly endByte: number;
}

function offsetError(code: string, detail?: number | string): InputError {
  const message = detail === undefined ? code : `${code}:${String(detail)}`;
  return new InputError(message, code);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END;
}

function utf8ByteLengthOfCodeUnit(codeUnit: number): number {
  if (codeUnit <= 0x7f) return 1;
  if (codeUnit <= 0x7ff) return 2;
  return 3;
}

/**
 * Assert that `offset` is a valid code-point boundary in `source`.
 * Rejects offsets that split a surrogate pair or land on a lone surrogate.
 * A negative or zero offset is always valid (no previous code unit).
 */
function assertCodePointBoundary(source: string, offset: number): void {
  if (offset <= 0) return;
  const previous = source.charCodeAt(offset - 1);
  if (isHighSurrogate(previous)) {
    if (offset < source.length && isLowSurrogate(source.charCodeAt(offset))) {
      throw offsetError("source_byte_offset_splits_surrogate_pair", offset);
    }
    throw offsetError("source_byte_offset_lone_surrogate", offset);
  }
  if (isLowSurrogate(previous)) {
    if (offset >= 2 && isHighSurrogate(source.charCodeAt(offset - 2))) return;
    throw offsetError("source_byte_offset_lone_surrogate", offset);
  }
}

/**
 * Convert a single UTF-16 code-unit offset to a UTF-8 byte offset strictly.
 *
 * A negative safe-integer offset is the explicit "missing/unknown" sentinel
 * and returns -1 (matching the authority-selector convention for absent AST
 * positions such as `node.start?? -1`). Non-safe-integer offsets throw
 * before any other check. An offset that splits a surrogate pair or lands on
 * a lone surrogate throws. An offset greater than `source.length` throws.
 */
export function utf8ByteOffset(source: string, utf16CodeUnitOffset: number): number {
  if (typeof source !== "string") throw offsetError("source_byte_offset_source_not_string");
  if (!Number.isSafeInteger(utf16CodeUnitOffset)) {
    throw offsetError("source_byte_offset_not_integer", utf16CodeUnitOffset);
  }
  if (utf16CodeUnitOffset < 0) return -1;
  if (utf16CodeUnitOffset > source.length) {
    throw offsetError("source_byte_offset_out_of_range", utf16CodeUnitOffset);
  }
  assertCodePointBoundary(source, utf16CodeUnitOffset);
  let bytes = 0;
  for (let i = 0; i < utf16CodeUnitOffset; i += 1) {
    const codeUnit = source.charCodeAt(i);
    if (isHighSurrogate(codeUnit)) {
      if (i + 1 < utf16CodeUnitOffset && isLowSurrogate(source.charCodeAt(i + 1))) {
        bytes += 4;
        i += 1;
        continue;
      }
      bytes += 3;
      continue;
    }
    bytes += utf8ByteLengthOfCodeUnit(codeUnit);
  }
  return bytes;
}

/**
 * Convert a UTF-16 `[start, end)` span to a UTF-8 `[startByte, endByte)` span.
 * Both endpoints must be valid, non-negative safe integers with
 * `start <= end <= source.length`. Negative endpoints throw (spans cannot
 * use the -1 sentinel; use `utf8ByteOffset` individually for that).
 */
export function utf8ByteSpan(source: string, startUtf16: number, endUtf16: number): ByteSpan {
  if (typeof source !== "string") throw offsetError("source_byte_span_source_not_string");
  if (!Number.isSafeInteger(startUtf16)) {
    throw offsetError("source_byte_offset_not_integer", startUtf16);
  }
  if (!Number.isSafeInteger(endUtf16)) {
    throw offsetError("source_byte_offset_not_integer", endUtf16);
  }
  if (startUtf16 < 0 || endUtf16 < 0) {
    throw offsetError("source_byte_span_offset_negative", `${startUtf16}:${endUtf16}`);
  }
  if (startUtf16 > endUtf16) {
    throw offsetError("source_byte_span_inverted", `${startUtf16}:${endUtf16}`);
  }
  if (endUtf16 > source.length) {
    throw offsetError("source_byte_span_end_out_of_range", endUtf16);
  }
  assertCodePointBoundary(source, startUtf16);
  assertCodePointBoundary(source, endUtf16);
  return Object.freeze({
    startByte: utf8ByteOffset(source, startUtf16),
    endByte: utf8ByteOffset(source, endUtf16),
  });
}

/**
 * Precompute a UTF-8 byte-offset map indexed by UTF-16 code-unit offset.
 * `map[i]` is the UTF-8 byte offset of boundary `i`; `map[source.length]` is
 * the total UTF-8 byte length. Positions that split a surrogate pair (the
 * low-surrogate index of an astral pair) or that follow a lone surrogate are
 * marked with the sentinel `0xffffffff` and must never be queried.
 */
export function createUtf8OffsetMap(source: string): Utf8OffsetMap {
  if (typeof source !== "string") throw offsetError("source_byte_offset_map_source_not_string");
  const length = source.length;
  const map = new Uint32Array(length + 1);
  let bytes = 0;
  let skipMapSet = false;
  for (let i = 0; i < length; i += 1) {
    if (!skipMapSet) {
      map[i] = bytes;
    }
    skipMapSet = false;
    const codeUnit = source.charCodeAt(i);
    if (isHighSurrogate(codeUnit)) {
      if (i + 1 < length && isLowSurrogate(source.charCodeAt(i + 1))) {
        bytes += 4;
        i += 1;
        map[i] = INVALID_BOUNDARY;
      } else {
        bytes += 3;
        if (i + 1 < length) {
          map[i + 1] = INVALID_BOUNDARY;
          skipMapSet = true;
        } else {
          map[length] = INVALID_BOUNDARY;
        }
      }
    } else if (isLowSurrogate(codeUnit)) {
      bytes += 3;
      if (i + 1 < length) {
        map[i + 1] = INVALID_BOUNDARY;
        skipMapSet = true;
      } else {
        map[length] = INVALID_BOUNDARY;
      }
    } else {
      bytes += utf8ByteLengthOfCodeUnit(codeUnit);
    }
  }
  if (length === 0) map[0] = 0;
  if (map[length] !== INVALID_BOUNDARY) map[length] = bytes;
  return map;
}

function isInvalidBoundary(map: Uint32Array, offset: number): boolean {
  return map[offset] === INVALID_BOUNDARY;
}

function assertValidMapOffset(map: Uint32Array, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= map.length) {
    throw offsetError("source_byte_offset_map_out_of_range", offset);
  }
  if (isInvalidBoundary(map, offset)) {
    throw offsetError("source_byte_offset_map_invalid_boundary", offset);
  }
}

/**
 * O(1) byte-offset lookup against a precomputed map. The offset must be a
 * valid, non-split, non-lone-surrogate boundary.
 */
export function utf8ByteOffsetFromMap(map: Utf8OffsetMap, utf16CodeUnitOffset: number): number {
  const array = map as Uint32Array;
  assertValidMapOffset(array, utf16CodeUnitOffset);
  return array[utf16CodeUnitOffset] as number;
}

/**
 * O(1) span lookup against a precomputed map. Both endpoints must be valid,
 * non-split, non-lone-surrogate boundaries with `start <= end`.
 */
export function utf8ByteSpanFromMap(
  map: Utf8OffsetMap,
  startUtf16: number,
  endUtf16: number,
): ByteSpan {
  const array = map as Uint32Array;
  assertValidMapOffset(array, startUtf16);
  assertValidMapOffset(array, endUtf16);
  if (startUtf16 > endUtf16) {
    throw offsetError("source_byte_span_map_inverted", `${startUtf16}:${endUtf16}`);
  }
  return Object.freeze({
    startByte: array[startUtf16] as number,
    endByte: array[endUtf16] as number,
  });
}

/**
 * Total UTF-8 byte length of the source, computed once the map is built.
 * Equal to `map[map.length - 1]` and to `Buffer.byteLength(source, "utf8")`
 * for well-formed strings. Throws if the source ended with a lone surrogate.
 */
export function utf8ByteLengthFromMap(map: Utf8OffsetMap): number {
  const array = map as Uint32Array;
  const value = array[array.length - 1] as number;
  if (value === INVALID_BOUNDARY) {
    throw offsetError("source_byte_offset_map_invalid_boundary");
  }
  return value;
}

/**
 * Count the UTF-8 bytes consumed by the code point starting at UTF-16
 * code-unit index `i`, advancing past surrogate pairs. The byte count
 * matches `Buffer.byteLength` for the same code point: astral pairs (a
 * high surrogate immediately followed by a low surrogate) consume 4
 * bytes and advance 2 UTF-16 units; lone surrogates consume 3 bytes
 * (matching the U+FFFD replacement `Buffer.byteLength` applies) and
 * advance 1 unit; BMP characters consume 1/2/3 bytes and advance 1 unit.
 */
function utf8ByteLengthAt(source: string, i: number): Readonly<{ bytes: number; advance: number }> {
  const codeUnit = source.charCodeAt(i);
  if (isHighSurrogate(codeUnit)) {
    if (i + 1 < source.length && isLowSurrogate(source.charCodeAt(i + 1))) {
      return { bytes: 4, advance: 2 };
    }
    return { bytes: 3, advance: 1 };
  }
  if (isLowSurrogate(codeUnit)) {
    return { bytes: 3, advance: 1 };
  }
  return { bytes: utf8ByteLengthOfCodeUnit(codeUnit), advance: 1 };
}

/**
 * Report whether `byteOffset` lands on a valid UTF-8 code-point boundary in
 * `source`. A boundary is byte offset 0, the total UTF-8 byte length, or any
 * offset exactly between two adjacent code points. Offsets that fall inside a
 * multi-byte UTF-8 sequence (including the middle of a 4-byte astral
 * sequence, which corresponds to splitting a surrogate pair in UTF-16) are
 * not boundaries. This is a pure predicate: it never throws and returns
 * `false` for non-string sources, non-safe-integer, negative, or
 * out-of-range offsets. Use {@link utf16OffsetFromUtf8Byte} for the strict
 * converter that returns the UTF-16 offset or throws.
 */
export function isUtf8Boundary(source: string, byteOffset: number): boolean {
  if (typeof source !== "string") return false;
  if (!Number.isSafeInteger(byteOffset)) return false;
  if (byteOffset < 0) return false;
  if (byteOffset === 0) return true;
  let bytes = 0;
  for (let i = 0; i < source.length; ) {
    if (bytes === byteOffset) return true;
    const step = utf8ByteLengthAt(source, i);
    bytes += step.bytes;
    i += step.advance;
  }
  return bytes === byteOffset;
}

/**
 * Convert a UTF-8 byte offset to the corresponding UTF-16 code-unit offset
 * strictly. The byte offset must be a valid code-point boundary (see
 * {@link isUtf8Boundary}); an offset that splits a multi-byte sequence is
 * rejected so callers can never slice into the middle of an astral
 * character. Returns 0 for byte offset 0 and `source.length` for the total
 * UTF-8 byte length. Throws `InputError` for a non-string source, a
 * non-safe-integer offset, a negative offset, an offset beyond the total
 * byte length, or an offset that is not a valid boundary.
 */
export function utf16OffsetFromUtf8Byte(source: string, byteOffset: number): number {
  if (typeof source !== "string") throw offsetError("source_byte_offset_source_not_string");
  if (!Number.isSafeInteger(byteOffset)) {
    throw offsetError("source_byte_offset_not_integer", byteOffset);
  }
  if (byteOffset < 0) {
    throw offsetError("source_byte_offset_out_of_range", byteOffset);
  }
  if (byteOffset === 0) return 0;
  let bytes = 0;
  for (let i = 0; i < source.length; ) {
    if (bytes === byteOffset) return i;
    const step = utf8ByteLengthAt(source, i);
    bytes += step.bytes;
    i += step.advance;
  }
  if (bytes === byteOffset) return source.length;
  if (byteOffset > bytes) {
    throw offsetError("source_byte_offset_out_of_range", byteOffset);
  }
  throw offsetError("source_byte_offset_not_boundary", byteOffset);
}
