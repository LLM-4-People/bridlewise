import { types as nodeTypes } from "node:util";
import { snapshotJsonValue } from "../kernel/safe-structural.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { canonicalHash, generateId } from "../kernel/integrity.ts";
import { bindRecordingContext } from "./recording-context.ts";
import { projectEffectDocuments } from "./effect-documents.ts";
import { truncateForLedger } from "./ledger-primitives.ts";
import { eventTypeForEffectKind, EFFECT_KIND_EVENT_TYPES } from "./timeline-types.ts";
import type { TimelineRecorder } from "./timeline-recorder.ts";
import { RequiredRecordingError, type EffectRecord, type EffectIntentRecord, type EffectSink } from "./recorded-effect.ts";

type SinkTarget = Readonly<{
  recorder: TimelineRecorder;
  documentOptions: Parameters<typeof projectEffectDocuments>[1];
}>;

type SinkOptions = Readonly<{
  /** Synchronous decoration suppression around individual ledger transitions. */
  transition?: <T>(work: () => T) => T;
  onUnmappedKind?: (record: EffectRecord | EffectIntentRecord) => void;
}>;

function errorOf(record: EffectRecord) {
  return record.error === undefined ? {} : {
    error: {
      category: record.kind,
      code: record.error.code ?? "effect_failed",
      message: truncateForLedger(record.error.message),
      retryable: false,
    },
  };
}

/** Snapshot once before hashing and projection; no caller accessors or toJSON execute. */
function snapshotRecord<T extends EffectRecord | EffectIntentRecord>(input: T): T {
  if (input === null || typeof input !== "object" || nodeTypes.isProxy(input)) throw new RequiredRecordingError();
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const [key, field] of Object.entries(fields)) {
    if (!("value" in field)) throw new RequiredRecordingError();
    if (field.value === undefined) delete fields[key];
  }
  const value = Object.create(Object.getPrototypeOf(input), fields) as unknown;
  return snapshotJsonValue(value, { maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth, maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes }) as T;
}

function evidenceHash(record: EffectRecord | EffectIntentRecord): string {
  return canonicalHash({
    kind: record.kind, name: record.name,
    ...("outcome" in record ? { outcome: record.outcome } : {}),
    ...("error" in record && record.error !== undefined ? { error: record.error } : {}),
    ...(record.args !== undefined ? { args: record.args } : {}),
    ...(record.documents !== undefined ? { documents: record.documents } : {}),
  });
}

/** One installed sink mapping for optional completions and required intent/terminal pairs. */
export function createTimelineEffectSink(resolve: () => SinkTarget | undefined, options: SinkOptions = {}): EffectSink {
  const transition = options.transition ?? (<T>(work: () => T): T => work());
  const lane = (record: EffectRecord | EffectIntentRecord) => {
    if (EFFECT_KIND_EVENT_TYPES[record.kind] === undefined) options.onUnmappedKind?.(record);
    return eventTypeForEffectKind(record.kind);
  };
  const sink: EffectSink = (record) => transition(() => {
    const target = resolve();
    if (target === undefined) return undefined;
    return target.recorder.recordEvent({
      eventType: lane(record), description: `${record.kind}:${record.name}`,
      outcome: record.outcome,
      documents: projectEffectDocuments(record, target.documentOptions),
      ...errorOf(record),
    });
  });
  return Object.freeze(Object.assign(sink, {
    begin(record: EffectIntentRecord) {
      return transition(() => {
        const target = resolve();
        if (target === undefined) throw new RequiredRecordingError();
        const recorder = target.recorder;
        const documentOptions = Object.freeze({ maxDocumentBytes: target.documentOptions.maxDocumentBytes, resourceDeltasEnabled: target.documentOptions.resourceDeltasEnabled });
        const prepared = snapshotRecord(record);
        lane(prepared);
        const effectId = generateId("effect");
        const intent = recorder.beginEffect({
          effectId, kind: prepared.effectKind, actor: prepared.actor,
          description: `${prepared.kind}:${prepared.name}`, intentHash: evidenceHash(prepared),
        }, { documents: projectEffectDocuments(prepared, documentOptions) });
        const inScope = bindRecordingContext();
        let finished = false;
        return Object.freeze({
          receipt: intent.receipt,
          finish(completion: EffectRecord) {
            if (finished) throw new RequiredRecordingError();
            finished = true;
            return inScope(() => transition(() => {
              const terminal = snapshotRecord(completion);
              return recorder.endEffect(effectId, {
                outcome: terminal.outcome, resultHash: evidenceHash(terminal), ...errorOf(terminal),
              }, { documents: projectEffectDocuments(terminal, documentOptions) }).receipt;
            }));
          },
        });
      });
    },
  }));
}
