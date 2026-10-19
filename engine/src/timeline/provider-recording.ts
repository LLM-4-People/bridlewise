import {
  recordRequiredEffectAsync,
  requireRecordedEffect,
  RequiredRecordingError,
  type EffectDocument,
  type EffectIntent,
  type EffectSink,
  type EffectOutcome,
  type EffectSettlement,
  type RequiredEffectResult,
} from "./recorded-effect.ts";
import { bindRecordingContext } from "./recording-context.ts";
import { HarnessError } from "../kernel/errors.ts";

export type ProviderStreamCapture = Readonly<{
  /** The protocol owner supplies the outcome; natural EOF proves no protocol status. */
  outcome: EffectOutcome;
  documents?: readonly EffectDocument[];
  args?: unknown;
}>;

export type RecordedProviderStream<T> = Readonly<{
  stream: AsyncGenerator<T, void, unknown>;
  /** Private evidence after the close/recording attempts; may contain raw thrown values. Never publish or log this object. */
  readonly settlement: RequiredEffectResult<void> | undefined;
}>;

/**
 * Paired evidence for a provider stream: intent is acknowledged before invoking
 * its lazy factory. The caller owns protocol admission. Source close precedes terminal recording;
 * exhausting, returning or throwing all settle once. There is no detached receipt
 * callback or detached lifetime wait. Raw thrown values, including pre-start
 * abort reasons, stay private: composing hosts must use their canonical safe
 * error projection before public egress.
 */
export function recordProviderStream<T>(
  source: () => AsyncIterable<T>,
  options: Readonly<{
    name: string;
    capture: () => ProviderStreamCapture;
    intent?: Omit<EffectIntent, "effectKind">;
    sink?: EffectSink;
    signal?: AbortSignal;
  }>,
): RecordedProviderStream<T> {
  let settlement: RequiredEffectResult<void> | undefined;
  async function* stream(): AsyncGenerator<T, void, unknown> {
    const finished = Promise.withResolvers<EffectSettlement<void>>();
    // The capture, or the private value its factory threw. The failure travels to
    // the recorder's required-capture path, which reports one fixed diagnostic.
    let capture: Readonly<{ value: ProviderStreamCapture }> | Readonly<{ error: unknown }> | undefined;
    const captured = (): ProviderStreamCapture | undefined => {
      if (capture !== undefined && "error" in capture) throw capture.error;
      return capture?.value;
    };
    let exhausted = false;
    let admitted = false;
    let sourceStarted = false;
    let iterator: AsyncIterator<T> | undefined;
    let inScope = bindRecordingContext();
    let work: EffectSettlement<void> = { status: "returned", value: undefined };
    const recording = recordRequiredEffectAsync("llm", options.name, async () => {
      admitted = true;
      inScope = bindRecordingContext();
      const result = await finished.promise;
      if (result.status !== "returned") throw result.error;
    }, {
      intent: { ...options.intent, effectKind: "provider" },
      ...(options.sink !== undefined ? { sink: options.sink } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      // A capture that failed is a FAILED outcome here, not a second throw:
      // `documentsOf` below reports the one capture failure (a2-design L3: it
      // was reported twice, once per callback).
      outcomeOf: () => options.signal?.aborted ? "cancelled"
        : work.status === "threw" || (capture !== undefined && "error" in capture) ? "failed" : !exhausted ? "cancelled" : captured()!.outcome,
      documentsOf: () => captured()?.documents,
      argsOf: () => capture !== undefined && "value" in capture ? capture.value.args : undefined,
    }).then(
      (result) => ({ status: "settled" as const, result }),
      () => ({ status: "unavailable" as const }),
    );
    if (!admitted) {
      const result = await recording;
      const error = new RequiredRecordingError();
      settlement = result.status === "settled" ? result.result : Object.freeze({
        work: Object.freeze({ status: "not-started", error }),
        intent: Object.freeze({ status: "failed", error }),
        recording: Object.freeze({ status: "not-attempted" }),
      });
      requireRecordedEffect(settlement);
      return;
    }
    try {
      options.signal?.throwIfAborted();
      sourceStarted = true;
      iterator = inScope(() => source()[Symbol.asyncIterator]());
      for (;;) {
        const next = await inScope(async () => {
          const result = await iterator!.next();
          if (result === null || (typeof result !== "object" && typeof result !== "function")) {
            throw new HarnessError("Provider iterator result is invalid", "provider_iterator_result_invalid");
          }
          return result.done ? { done: true as const } : { done: false as const, value: result.value };
        });
        if (next.done) { exhausted = true; break; }
        yield next.value;
      }
    } catch (error) {
      work = { status: sourceStarted ? "threw" : "not-started", error };
    } finally {
      // for-await does not close an iterator whose next() rejects. Own the
      // lifetime explicitly, including rejected next/done/value access paths.
      if (!exhausted && iterator !== undefined) {
        try {
          await inScope(async () => {
            const close = iterator!.return;
            if (close === undefined) return;
            const result = await close.call(iterator);
            if (result === null || (typeof result !== "object" && typeof result !== "function")) {
              throw new HarnessError("Provider iterator close result is invalid", "provider_iterator_close_result_invalid");
            }
            // A generator may yield from finally. One return then does not
            // certify closure; refuse instead of draining unbounded work.
            if (!result.done) throw new HarnessError("Provider stream teardown is incomplete", "provider_stream_teardown_incomplete");
          });
        } catch (error) {
          if (work.status === "returned") work = { status: "threw", error };
        }
      }
      try { capture = { value: inScope(options.capture) }; } catch (error) { capture = { error }; }
      finished.resolve(work);
      const result = await recording;
      settlement = result.status === "settled" ? result.result : Object.freeze({
        work: Object.freeze(work),
        recording: Object.freeze({ status: "failed", error: new RequiredRecordingError() }),
      });
      requireRecordedEffect(settlement);
    }
  }
  return Object.freeze({ stream: stream(), get settlement() { return settlement; } });
}
