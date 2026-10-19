/**
 * THE MESSAGE FORMAT BETWEEN THE FACADE AND ITS DB THREADS.
 *
 * Two things cross this boundary: a call, and its outcome. Rows travel as
 * plain objects, which structured clone handles natively — every value the
 * parse functions in `client.ts` produce is a string, number, null, array or
 * plain object, so nothing here needs a custom encoder.
 *
 * ERRORS are the part that needs care, and the reason is specific: the router
 * maps errors to HTTP statuses with `instanceof` (`ForbiddenError` → 403,
 * `ValidationError` → 400, `ZodError` → 400, anything with a numeric
 * `statusCode` → that). Structured clone preserves an Error's `message` and
 * `stack` but NOT its prototype, so a `ForbiddenError` thrown in a worker
 * would arrive on the main thread as a plain `Error` and every ownership
 * failure in the product would turn from a 403 into a 500. That is a
 * behavioural regression a type checker cannot see, so the class is carried
 * explicitly and rebuilt on arrival.
 */

import { ZodError, type ZodIssue } from "zod";
import type { DatabaseProvenance } from "../../engine/src/filesystem/database-provenance.ts";

import {
  WebError,
  ValidationError,
  ForbiddenError,
  ConfigError,
  FileSystemError,
  AuthError,
  NotFoundError,
} from "../kernel/errors.ts";

export type DbCall = Readonly<{
  id: number;
  /** A single method call. Exactly one of `method` / `tx` is present. */
  method?: string;
  args?: readonly unknown[];
  /** An ordered group executed inside ONE transaction on the writer. */
  tx?: ReadonlyArray<Readonly<{ method: string; args: readonly unknown[] }>>;
}>;

export type WireError = Readonly<{
  kind: "zod" | "web" | "plain";
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
  statusCode?: number;
  stack?: string;
  issues?: readonly ZodIssue[];
}>;

export type DbReply =
  | Readonly<{ id: number; ok: true; value: unknown }>
  | Readonly<{ id: number; ok: false; error: WireError }>;

/** Sent once, unsolicited, when a worker's connection is open and usable. */
export type DbReady = Readonly<{
  ready: true;
  schemaVersion: number;
  path: string;
  durability: Readonly<{ synchronous: string; windowMs: number }>;
  keyPersisted: boolean;
  keyFilePath: string | null;
  /** Whose database this is, as its header states (UD-S15): `product`, `fixture`, `test` (one a test made), `unstamped` or `foreign`. */
  provenance: DatabaseProvenance;
}>;

/** Sent once instead of `ready` when the connection could not be opened. A
 * silent worker would leave the facade waiting forever, which is the worst of
 * the available failures — the process would look alive and serve nothing. */
export type DbFailedToOpen = Readonly<{ ready: false; error: WireError }>;

export function encodeError(err: unknown): WireError {
  if (err instanceof ZodError) {
    return { kind: "zod", name: "ZodError", message: err.message, issues: err.issues };
  }
  if (err instanceof WebError) {
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    return {
      kind: "web",
      name: err.name,
      message: err.message,
      code: err.code,
      retryable: err.retryable,
      ...(typeof statusCode === "number" ? { statusCode } : {}),
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  // A non-Error thrown value still has to cross the boundary intact. Wrapping
  // it in the typed hierarchy rather than a raw Error keeps the router's
  // mapping meaningful and satisfies the no-raw-Error rule on both sides.
  const e = err instanceof Error ? err : new WebError(String(err), "db_worker_threw_non_error");
  return {
    kind: "plain",
    name: e.name,
    message: e.message,
    ...(e.stack !== undefined ? { stack: e.stack } : {}),
  };
}

/** The WebError subclasses that carry meaning to the router. A name absent
 * here rebuilds as a plain `WebError` with its code intact — the status still
 * derives from the code path that threw, and nothing is invented. */
const WEB_ERROR_CLASSES: Readonly<Record<string, new (message: string, code?: string) => WebError>> = {
  ValidationError,
  ForbiddenError,
  ConfigError,
  FileSystemError,
  AuthError,
  NotFoundError,
};

export function decodeError(wire: WireError): Error {
  if (wire.kind === "zod") return new ZodError([...(wire.issues ?? [])]);
  if (wire.kind === "web") {
    const Cls = WEB_ERROR_CLASSES[wire.name];
    const err = Cls
      ? new Cls(wire.message, wire.code)
      : new WebError(wire.message, wire.code ?? "db_worker_error", wire.retryable ?? false);
    // The worker's stack is where the failure actually happened. Keeping it
    // means a 403 can still be traced to the query that refused, rather than
    // to the postMessage that carried the news.
    if (wire.stack !== undefined) err.stack = wire.stack;
    return err;
  }
  const err = new WebError(wire.message, "db_worker_error");
  err.name = wire.name;
  if (wire.stack !== undefined) err.stack = wire.stack;
  return err;
}
