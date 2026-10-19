import { types as nodeTypes } from "node:util";
import { InputError } from "../kernel/errors.ts";
import { snapshotPlainArray } from "../kernel/safe-structural.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { assertTimelineDocument, assertTimelineDocumentByteLimit } from "./ledger-primitives.ts";
import { sha256 } from "../kernel/integrity.ts";
import {
  TIMELINE_EFFECT_ARGS_DOCUMENT,
  TIMELINE_EFFECT_TIMING_DOCUMENT,
  type TimelineEffectTiming,
} from "../../../shared/constants.ts";
import type { EffectDocument, EffectRecord, EffectIntentRecord } from "./recorded-effect.ts";
import { TRUNCATION_ENVELOPE_OVERHEAD_BYTES } from "./timeline-config.ts";

function boundEffectDocument(doc: unknown, maximumBytes: number): EffectDocument {
  assertTimelineDocument(doc);
  const text = doc.contentJson ?? doc.orderedJson;
  if (text === undefined) return doc;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maximumBytes) return doc;
  const fullPayload = Buffer.from(text, "utf8");
  let take = Math.max(0, maximumBytes - TRUNCATION_ENVELOPE_OVERHEAD_BYTES);
  for (;;) {
    // Streaming decode withholds an incomplete trailing code point instead of
    // manufacturing a replacement character. Preserve a literal leading BOM.
    const preview = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(fullPayload.subarray(0, take), { stream: true });
    const contentJson = JSON.stringify({
      truncated: true,
      fullPayloadDigest: doc.contentDigest,
      fullPayloadBytes: bytes,
      preview,
    });
    const storedBytes = Buffer.byteLength(contentJson, "utf8");
    if (storedBytes <= maximumBytes) {
      const fitted = { name: doc.name, contentJson, contentDigest: sha256(contentJson) };
      assertTimelineDocument(fitted, maximumBytes);
      return fitted;
    }
    if (take === 0) throw new InputError("Effect document envelope exceeds ledger limit", "effect_document_limit");
    take = Math.max(0, take - (storedBytes - maximumBytes));
  }
}

/** One document vocabulary and fitting path for every real effect sink. */
export function projectEffectDocuments(
  record: EffectRecord | EffectIntentRecord,
  options: Readonly<{ maxDocumentBytes: number; resourceDeltasEnabled: boolean }>,
): readonly EffectDocument[] {
  const maximumBytes = options.maxDocumentBytes;
  assertTimelineDocumentByteLimit(maximumBytes);
  // Capture only the document channel: internal effect records intentionally
  // carry optional own-undefined fields outside their public JSON evidence.
  if (record === null || typeof record !== "object" || nodeTypes.isProxy(record)) {
    throw new InputError("Effect document carrier is invalid", "timeline_document_invalid");
  }
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError("Effect document carrier must be plain data", "timeline_document_invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, "documents");
  if (descriptor !== undefined && (!("value" in descriptor) || !descriptor.enumerable)) {
    throw new InputError("Effect documents must be data", "timeline_document_invalid");
  }
  const { maximumDepth, maximumNodes } = ROOT_POLICY.forensics.limits;
  const supplied = descriptor?.value === undefined ? [] : snapshotPlainArray(descriptor.value, { maximumDepth, maximumNodes }, "timeline_document_invalid");
  const documents: unknown[] = [];
  if ("durationMs" in record) {
    const timing: TimelineEffectTiming = {
      durationMs: record.durationMs,
      ...(options.resourceDeltasEnabled && record.cpuMs !== undefined ? { cpuMs: record.cpuMs } : {}),
      ...(options.resourceDeltasEnabled && record.heapDeltaBytes !== undefined ? { heapDeltaBytes: record.heapDeltaBytes } : {}),
    };
    const timingJson = JSON.stringify(timing);
    documents.push({ name: TIMELINE_EFFECT_TIMING_DOCUMENT, contentJson: timingJson, contentDigest: sha256(timingJson) });
  }
  if (record.args !== undefined) {
    const contentJson = JSON.stringify(record.args);
    documents.push({ name: TIMELINE_EFFECT_ARGS_DOCUMENT, contentJson, contentDigest: sha256(contentJson) });
  }
  documents.push(...supplied);
  return documents.map((document) => boundEffectDocument(document, maximumBytes));
}
