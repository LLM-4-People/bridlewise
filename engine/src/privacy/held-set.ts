/**
 * THE VALUES ONE OPERATION HOLDS — a typed, labelled, frozen set (cred-final
 * §2.1). A provider key minted for a run, the credential slots of the request
 * it sends, a parent response's held values: each enters with a LABEL that
 * says where it came from (`provider:<id>`, `request:credential`, …), and the
 * label is all that ever surfaces. Held values are PER OPERATION, never
 * process-wide (CRED-F2/F3): one user's key never masks another user's text.
 *
 * Every egress and storage path of the operation masks with the SAME set:
 *   - `scrub` for a whole text (the redactor's own held layer, through
 *     `knownSecretSpans`, so every escape form is matched);
 *   - `scrubStrings` for a structured value (a tool call's arguments, a raw
 *     response resource) — every string, keys included;
 *   - `streamingScrubber` for text that arrives in pieces (a tool call's
 *     argument deltas): a value split across two pieces is still masked,
 *     because the scrubber releases nothing a later piece could complete.
 *
 * This replaces the hand-threaded `readonly string[]` held lists: a set knows
 * its labels, merges without losing them, and cannot be mutated by a holder.
 *
 * THE HELD FLOOR LIVES HERE (a2b-design H1): a set is built with the held
 * population's floor (`DEFAULT_HELD_MINIMUM_LENGTH`, or the policy's
 * `privacy.heldCredentialMinimumLength` where the producer has one), so
 * every producer inherits it. A value below the floor stays in `values()`
 * (a slot that carried it is replaced exactly there) but is never searched
 * for in text (`matched()`); each is counted (`privacy.heldSlotOnlyCount`)
 * and reported to the central audit by its LABEL, never its value. A merged
 * set keeps the RECEIVER's floor (the request mint's set carries the
 * policy's, so the provider's and the parent's values it merges obey it).
 */
import { auditEvent } from "../shared/debug/debug-system.ts";
import { privacyCounters } from "./pii-registry.ts";
import { DEFAULT_HELD_MINIMUM_LENGTH, knownSecretSpans, heldScanVariants, type HeldMatch } from "./secret-intelligence.ts";

export type HeldEntry = Readonly<{ label: string; value: string }>;

export type StreamingScrubber = Readonly<{
  /** Append a piece; returns the masked text that no later piece can change. */
  push(text: string): string;
  /** The masked remainder (the stream ended). */
  flush(): string;
}>;

/**
 * Several interleaved streams of pieces, each keyed (one per tool call, one
 * per native delta family and index): `push` returns the released masked
 * text of that stream; `release` flushes one stream (or every stream whose
 * key starts with a prefix, or all) and returns the tails, in push order.
 */
export type PieceStreams = Readonly<{
  push(key: string, text: string): string;
  release(match?: (key: string) => boolean): readonly (readonly [string, string])[];
}>;

export type HeldSet = Readonly<{
  entries: readonly HeldEntry[];
  size: number;
  /** The held population's floor this set searches text with. */
  minimumLength: number;
  /** The held values (deduplicated), every one — the exact-slot view. */
  values(): readonly string[];
  /** The values searched for in text: those at or above the floor. */
  matched(): readonly string[];
  /** This set and `other`, labels kept (a value held under two labels is held once). */
  merge(other: HeldSet | undefined): HeldSet;
  /** `text` with every held value (in every escape form) replaced by `marker`. */
  scrub(text: string, marker: string): string;
  /** `value` with every string (object keys included) scrubbed. */
  scrubStrings<T>(value: T, marker: string): T;
  /**
   * `value` with every string scrubbed AND every held value that runs ACROSS
   * its text parts (the `text` fields, in document order: one output item's
   * text, then the next's) masked in each part it spans — a value the model
   * split between two output items or two content parts.
   */
  scrubAcrossTextParts<T>(value: T, marker: string): T;
  /** A scrubber for one stream of pieces. */
  streamingScrubber(marker: string): StreamingScrubber;
  /** Keyed scrubbers for interleaved streams of pieces. */
  pieceStreams(marker: string): PieceStreams;
}>;

/**
 * A set holding `entries`, searching text for those at or above
 * `minimumLength` (the held population's floor; the policy's where the
 * producer has one). The values below it are counted and audited once, here.
 */
export function heldSetOf(entries: Iterable<HeldEntry>, minimumLength: number = DEFAULT_HELD_MINIMUM_LENGTH): HeldSet {
  return buildHeldSet(entries, minimumLength, true);
}

function buildHeldSet(entries: Iterable<HeldEntry>, minimumLength: number, report: boolean): HeldSet {
  const kept: HeldEntry[] = [];
  const seen = new Set<string>();
  for (const { label, value } of entries) {
    if (typeof value !== "string" || value.length === 0) continue;
    const key = `${label}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(Object.freeze({ label, value }));
  }
  const values = Object.freeze([...new Set(kept.map((entry) => entry.value))]);
  const matchedValues = Object.freeze(values.filter((value) => value.length >= minimumLength));
  if (report && matchedValues.length < values.length) {
    privacyCounters.heldSlotOnly += values.length - matchedValues.length;
    const labels = [...new Set(kept.filter((entry) => entry.value.length < minimumLength).map((entry) => entry.label))];
    auditEvent("privacy.held-slot-only", { labels, count: values.length - matchedValues.length, minimumLength });
  }
  const match: HeldMatch = Object.freeze({ values: matchedValues, minimumLength });
  const variants = matchedValues.length === 0 ? [] : heldScanVariants(match);
  /** The longest suffix of `text` that could still grow into a held form (a proper prefix of a variant). */
  const growing = (text: string): number => {
    let hold = 0;
    for (const variant of variants) {
      for (let length = Math.min(variant.length - 1, text.length); length > hold; length -= 1) {
        if (text.endsWith(variant.slice(0, length))) { hold = length; break; }
      }
    }
    return hold;
  };
  const scrub = (text: string, marker: string): string => matchedValues.length === 0 || text.length === 0 ? text : replaceSpans(text, marker, match);
  const set: HeldSet = Object.freeze({
    entries: Object.freeze(kept),
    size: values.length,
    minimumLength,
    values: () => values,
    matched: () => matchedValues,
    // The receiver's floor; the other set's entries were reported when it was built.
    merge: (other: HeldSet | undefined) => other === undefined || other.size === 0 ? set
      : values.length === 0 && other.minimumLength === minimumLength ? other
        : buildHeldSet([...kept, ...other.entries], minimumLength, false),
    scrub,
    scrubStrings: <T>(value: T, marker: string): T => matchedValues.length === 0 ? value : scrubDeep(value, (text) => scrub(text, marker)) as T,
    scrubAcrossTextParts: <T>(value: T, marker: string): T => matchedValues.length === 0 ? value : scrubDeep(maskAcrossTextParts(value, marker, match), (text) => scrub(text, marker)) as T,
    streamingScrubber: (marker: string): StreamingScrubber => {
      let pending = "";
      return Object.freeze({
        push(text: string): string {
          pending += text;
          if (matchedValues.length === 0) { const out = pending; pending = ""; return out; }
          // Release everything but the suffix that could still grow into a
          // held form (so text is delayed only while it may be one) — moved
          // past any complete match that straddles that point.
          let release = pending.length - growing(pending);
          for (const span of knownSecretSpans(pending, [], match)) {
            if (span.startUtf16 < release && span.endUtf16 > release) release = span.endUtf16;
          }
          const out = scrub(pending.slice(0, release), marker);
          pending = pending.slice(release);
          return out;
        },
        flush(): string {
          const out = scrub(pending, marker);
          pending = "";
          return out;
        },
      });
    },
    pieceStreams: (marker: string): PieceStreams => {
      const streams = new Map<string, StreamingScrubber>();
      return Object.freeze({
        push(key: string, text: string): string {
          let scrubber = streams.get(key);
          if (scrubber === undefined) streams.set(key, scrubber = set.streamingScrubber(marker));
          return scrubber.push(text);
        },
        release(match: (key: string) => boolean = () => true): readonly (readonly [string, string])[] {
          const tails: (readonly [string, string])[] = [];
          for (const [key, scrubber] of streams) {
            if (!match(key)) continue;
            streams.delete(key);
            tails.push([key, scrubber.flush()]);
          }
          return tails;
        },
      });
    },
  });
  return set;
}

/** The empty set (nothing held). */
export const EMPTY_HELD_SET: HeldSet = heldSetOf([]);

/** `values` held under one label (a request's credential slots, a legacy list), searched for at or above `minimumLength`. */
export function heldValues(label: string, values: Iterable<string>, minimumLength: number = DEFAULT_HELD_MINIMUM_LENGTH): HeldSet {
  return heldSetOf([...values].map((value) => ({ label, value })), minimumLength);
}

function replaceSpans(text: string, marker: string, held: HeldMatch): string {
  const spans = [...knownSecretSpans(text, [], held)].sort((a, b) => a.startUtf16 - b.startUtf16 || b.endUtf16 - a.endUtf16);
  if (spans.length === 0) return text;
  let out = "", at = 0;
  for (const span of spans) {
    if (span.startUtf16 < at) { at = Math.max(at, span.endUtf16); continue; }
    out += text.slice(at, span.startUtf16) + marker;
    at = span.endUtf16;
  }
  return out + text.slice(at);
}

/**
 * `value` (cloned) with the held values found in the CONCATENATION of its
 * `text` fields masked in every part they cover: each covered run of a part
 * becomes one `marker`, so neither half of a split value survives.
 */
function maskAcrossTextParts(value: unknown, marker: string, held: HeldMatch): unknown {
  const parts: { holder: Record<string, unknown>; text: string }[] = [];
  const clone = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(clone);
    if (current !== null && typeof current === "object" && (Object.getPrototypeOf(current) === Object.prototype || Object.getPrototypeOf(current) === null)) {
      const copy: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) copy[key] = clone(entry);
      if (typeof copy["text"] === "string") parts.push({ holder: copy, text: copy["text"] });
      return copy;
    }
    return current;
  };
  const copied = clone(value);
  if (parts.length < 2) return copied;
  const joined = parts.map((part) => part.text).join("");
  const spans = knownSecretSpans(joined, [], held);
  if (spans.length === 0) return copied;
  let offset = 0;
  for (const part of parts) {
    const start = offset, end = offset + part.text.length;
    offset = end;
    const covered = spans.filter((span) => span.startUtf16 < end && span.endUtf16 > start)
      .map((span) => [Math.max(span.startUtf16, start) - start, Math.min(span.endUtf16, end) - start] as const)
      .sort((a, b) => a[0] - b[0]);
    if (covered.length === 0) continue;
    let out = "", at = 0;
    for (const [from, to] of covered) {
      if (to <= at) continue;
      out += part.text.slice(at, Math.max(at, from)) + marker;
      at = to;
    }
    part.holder["text"] = out + part.text.slice(at);
  }
  return copied;
}

function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => scrubDeep(entry, scrub));
  if (value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [scrub(key), scrubDeep(entry, scrub)]));
  }
  return value;
}
