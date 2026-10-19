/**
 * Canonical optional-operation boundary. Failures return undefined and report
 * a fixed diagnostic through the central debug owner. Caller labels and caught
 * values are deliberately absent: logging failures must not expose credentials
 * or replace the primary outcome. Successful operations do no diagnostic work.
 */
import { types as nodeTypes } from "node:util";
import { reportBestEffortFailure } from "./debug/debug-system.ts";

/** Run an optional synchronous operation without replacing its caller's outcome. */
export function bestEffort<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    reportBestEffortFailure();
    return undefined;
  }
}

/** bestEffort for an operation whose `undefined` result is meaningful: the value boxed, or undefined on failure. */
export function bestEffortBoxed<T>(fn: () => T): Readonly<{ value: T }> | undefined {
  return bestEffort(() => ({ value: fn() }));
}

/** Async equivalent of bestEffort; no promise of recovering the original caller stack. */
export async function bestEffortAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    reportBestEffortFailure();
    return undefined;
  }
}

/** Observe an unexpected native promise without awaiting it or trusting then/species hooks. */
export function observeUnexpectedPromise(value: unknown): boolean {
  if (!nodeTypes.isPromise(value)) return false;
  bestEffort(() => { Promise.prototype.then.call(value, undefined, () => undefined); });
  return true;
}
