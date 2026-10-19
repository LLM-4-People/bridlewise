/**
 * THE ONE TOTAL DESCRIPTION OF A THROWN OR REJECTED VALUE.
 *
 * Anything can be thrown: an `Error`, `undefined`, a Symbol, an object with no
 * prototype (`String()` of it throws), an object whose `message` or `stack`
 * GETTER throws. The process-level handlers used to format the reason with
 * `String(reason)` / `err.stack ?? err.message`; each of those shapes threw
 * INSIDE the handler, and a throw there ends the process with the cause lost
 * (SCALE-CR1 C2, reproduced). This function never throws and never calls
 * user code it cannot survive: every read is guarded, every conversion falls
 * back to a fixed spelling.
 *
 * Leaf module (no imports): the fault policy, `guarded` and the debug system
 * all describe faults through it without an import cycle.
 */

/** What a fault was, in plain fields; every field is a string that was safe to produce. */
export type FaultDescription = Readonly<{
  /** `error` for an object with an Error-like shape, `value` for anything else. */
  kind: "error" | "value";
  /** The constructor/`name` of an error, or the `typeof` of a value. */
  name: string;
  /** A typed error's `code`, when it carries a string one. */
  code?: string;
  message: string;
  stack?: string;
}>;

/** The longest message or stack a description carries (a fault line, never a dump). */
const MAXIMUM_FAULT_TEXT = 4096;

function clip(text: string): string {
  return text.length <= MAXIMUM_FAULT_TEXT ? text : `${text.slice(0, MAXIMUM_FAULT_TEXT)}…`;
}

/** An own or inherited property's value, or `undefined` when reading it throws (a hostile getter, a revoked proxy). */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A string spelling of anything, without trusting its `toString`/`Symbol.toPrimitive`. */
function spell(value: unknown): string {
  try {
    switch (typeof value) {
      case "string": return value;
      case "number": case "boolean": case "bigint": return String(value);
      case "undefined": return "undefined";
      case "symbol": return Symbol.prototype.toString.call(value);
      case "function": return "[function]";
      default: return value === null ? "null" : Object.prototype.toString.call(value);
    }
  } catch {
    return "[unprintable]";
  }
}

/** Describe `value` without ever throwing. */
export function describeFault(value: unknown): FaultDescription {
  try {
    if (value === null || typeof value !== "object") {
      return Object.freeze({ kind: "value", name: typeof value, message: clip(spell(value)) });
    }
    const message = read(value, "message");
    const stack = read(value, "stack");
    const code = read(value, "code");
    const name = read(value, "name");
    const errorLike = value instanceof Error || typeof message === "string";
    return Object.freeze({
      kind: errorLike ? "error" : "value",
      name: typeof name === "string" && name.length > 0 ? clip(name) : spell(value),
      ...(typeof code === "string" ? { code: clip(code) } : {}),
      message: clip(typeof message === "string" ? message : spell(value)),
      ...(typeof stack === "string" ? { stack: clip(stack) } : {}),
    });
  } catch {
    return Object.freeze({ kind: "value", name: "unknown", message: "[undescribable fault]" });
  }
}

/** One line for a fault: `Name [code]: message` — what a report or a refusal reason states. */
export function faultLine(fault: FaultDescription): string {
  return `${fault.name}${fault.code === undefined ? "" : ` [${fault.code}]`}: ${fault.message}`;
}

/** {@link faultLine} of any thrown or rejected value, never throwing. */
export function describeFaultLine(value: unknown): string {
  return faultLine(describeFault(value));
}
