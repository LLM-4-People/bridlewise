/**
 * nanostores shared state: structured error log.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts.
 *
 * Distinct from `./chat-messages.ts::appendErrorMessage`, which appends a
 * visible error message to the chat transcript (role="error"). This
 * store is the structured error log: each entry has a `kind` (stream,
 * parse, run_start, model, network, timeout, http) so the UI can
 * group/filter. Entries are capped at `MAX_ERROR_ENTRIES` (oldest
 * dropped) so the log can't grow unbounded in a long session.
 *
 * Both surfaces are valid: the chat transcript shows errors inline;
 * this store is the inspectable log for an error panel / debugging.
 *
 * @global-store structured error log (server-wide, not chat-scoped; errors across all chats)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { ERROR_LOG_MAX_ENTRIES as MAX_ERROR_ENTRIES } from "../client-config";
import { registerReset } from "./store-registry";

// Re-export the cap so existing consumers (components/tests) that import
// `MAX_ERROR_ENTRIES` from this module keep working — the VALUE owner is
// `client-config.ts` (the single client config owner, ); this
// module is the consumer that enforces the cap on append.
export { ERROR_LOG_MAX_ENTRIES as MAX_ERROR_ENTRIES } from "../client-config";

// ── Types ──

/**
 * The error-kind vocabulary. THE ARRAY IS THE OWNER, the type is derived, so
 * there is no second declaration a new kind can be added to and forgotten in.
 *
 * Exported because the guard over `errorsByKind` needs a universe that does
 * not come from the object it is checking. It used to write the seven kinds
 * out by hand under the title "all ErrorKind values are present", and a
 * hand-written `ErrorKind[]` accepts a SUBSET — so an eighth kind would have
 * left that test asserting "all" over seven of eight, green.
 */
export const ERROR_KINDS = [
  "stream",
  "parse",
  "run_start",
  "model",
  "network",
  "timeout",
  "http",
] as const;

export type ErrorKind = typeof ERROR_KINDS[number];

export type ErrorEntry = Readonly<{
  readonly id: string;
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly statusCode: number | undefined;
  readonly timestamp: number;
}>;

// ── Stores ──

export const errors = atom<readonly ErrorEntry[]>([]);

export const errorCount: ReadableAtom<number> = computed(
  errors,
  (list) => list.length,
);

export const latestError: ReadableAtom<ErrorEntry | null> = computed(
  errors,
  (list) => list[list.length - 1] ?? null,
);

export const errorsByKind: ReadableAtom<Readonly<Record<ErrorKind, readonly ErrorEntry[]>>> = computed(
  errors,
  (list) => {
    const grouped: Record<ErrorKind, ErrorEntry[]> = {
      stream: [],
      parse: [],
      run_start: [],
      model: [],
      network: [],
      timeout: [],
      http: [],
    };
    for (const e of list) grouped[e.kind].push(e);
    return grouped;
  },
);

// ── Internal id generation ──

let errorCounter = 0;

function newErrorId(): string {
  errorCounter += 1;
  return `err-${errorCounter.toString(36)}-${Date.now().toString(36)}`;
}

// ── Ingestion (called only by client.ts) ──

/**
 * Append an error entry. Returns the new entry's id. When the store
 * exceeds `MAX_ERROR_ENTRIES`, the oldest entry is dropped.
 */
export function pushError(
  kind: ErrorKind,
  code: string,
  message: string,
  statusCode?: number,
): string {
  const entry: ErrorEntry = {
    id: newErrorId(),
    kind,
    code,
    message,
    statusCode,
    timestamp: Date.now(),
  };
  const next = [...errors.get(), entry];
  // Drop oldest if over the cap. `splice` would mutate; slice preserves
  // immutability for store subscribers.
  if (next.length > MAX_ERROR_ENTRIES) {
    errors.set(next.slice(next.length - MAX_ERROR_ENTRIES));
  } else {
    errors.set(next);
  }
  return entry.id;
}

/**
 * Remove an error entry by id. No-op if the id is not present.
 */
export function dismissError(id: string): void {
  errors.set(errors.get().filter((e) => e.id !== id));
}

export function clearErrors(): void {
  errors.set([]);
  // Reset the id counter so a re-login starts from a clean id sequence
  // (the counter is module-level mutable state `errors.set([])` does NOT
  // touch). clearMessages mirrors this for messageCounter.
  errorCounter = 0;
}

registerReset("errors", clearErrors);

// ── Back-compat shim for client.ts callers that use (kind, message, code?) ──
// The chat-messages style `(code, message)` and the errors-store style
// `(kind, code, message)` differ in argument order. This wrapper lets
// client.ts call `appendError(kind, message, code?)` (kind-first, code
// optional) which is more natural when the code is sometimes unknown
// (e.g. parse errors have no canonical code).
export function appendError(
  kind: ErrorKind,
  message: string,
  code: string | null = null,
): string {
  return pushError(kind, code ?? `unknown_${kind}`, message);
}
