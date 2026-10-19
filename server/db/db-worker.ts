/**
 * ONE DATABASE THREAD.
 *
 * Started by `thread-backend.ts`, either as the single WRITER (a read-write
 * connection that runs the migrations and owns the checkpoint timer) or as
 * one of the READERS (a connection SQLite opened read-only). It does one
 * thing: take a call off the port, run it against its own `DbClient`, and
 * post the result back.
 *
 * ── Why the handler is synchronous, and must stay that way ──
 *
 * The writer's ordering guarantee rests on it. `DbClient` methods are
 * synchronous, so a synchronous `message` handler runs calls in exactly the
 * order the port delivered them, which is the order the facade posted them,
 * which is the order the caller issued them. Introduce an `await` anywhere in
 * this handler and two writes can interleave — and the ledger's chain hash
 * depends on write order, so that is not a latency bug, it is a
 * tamper-evidence bug. There is nothing to gain here from being async: the
 * whole point of this file is that the blocking happens on THIS thread.
 *
 * ── What this thread may not do ──
 *
 * It may not touch the timeline ledger. `assertNotInDbWorker` (installed via
 * `HARNESS_DB_WORKER`) makes the attempt throw rather than quietly succeed,
 * because succeeding is the dangerous outcome: a second writer extending the
 * same hash chain, and events recorded with no ambient causality because a
 * worker has no AsyncLocalStorage context to merge. See
 * `DbClient.createAutoCheckReturningTransition`.
 */

import { parentPort, workerData } from "node:worker_threads";
import { guarded } from "../kernel/canonical.ts";
// The fault policy is this thread's before this module loads (the spawn's
// prelude, `bootstrappedWorker(…, "server-thread")`): a lost fault is counted and the
// thread lives; an uncaught one ends the THREAD (exit 70) and its supervisor in
// thread-backend.ts respawns it (SCALE-CR1 C2/C4, SCALE-CR1-FIX H2).

import { createDbCryptoFromKey } from "./db-crypto.ts";
import type { PersistedKey } from "../kernel/canonical.ts";
import { DbClient } from "./client.ts";
import { methodKind } from "./method-kinds.ts";
import { encodeError, type DbCall, type DbReply, type DbReady, type DbFailedToOpen } from "./wire.ts";
import { ValidationError } from "../kernel/errors.ts";

export type DbWorkerData = Readonly<{
  path: string;
  role: "writer" | "reader";
  admittedKey: PersistedKey;
  synchronous?: string;
  busyTimeoutMs?: number;
  durabilityWindowMs?: number;
}>;

const port = parentPort;
if (port === null) {
  throw new ValidationError("db-worker.ts must be started as a worker thread.", "db_worker_no_port");
}

const data = workerData as DbWorkerData;
let client: DbClient;

try {
  client = new DbClient({
    path: data.path,
    readOnly: data.role === "reader",
    crypto: createDbCryptoFromKey(data.admittedKey),
    ...(data.busyTimeoutMs !== undefined ? { busyTimeoutMs: data.busyTimeoutMs } : {}),
    ...(data.synchronous !== undefined ? { synchronous: data.synchronous } : {}),
    ...(data.durabilityWindowMs !== undefined ? { durabilityWindowMs: data.durabilityWindowMs } : {}),
  });
} catch (err) {
  // Say so rather than dying quietly. A worker that exits without a word
  // leaves the facade waiting on a promise that will never settle, and the
  // process then looks healthy while serving nothing — the exact "correct and
  // unplugged" shape this codebase refuses elsewhere.
  const failed: DbFailedToOpen = { ready: false, error: encodeError(err) };
  port.postMessage(failed);
  throw err;
}

const ready: DbReady = {
  ready: true,
  schemaVersion: client.schemaVersion,
  path: client.path,
  durability: client.durability,
  keyPersisted: client.keyPersisted,
  keyFilePath: client.keyFilePath,
  provenance: client.provenance,
};
port.postMessage(ready);

/** Call one classified method. Unclassified names are refused here as well as
 * at the facade, because this thread is reachable by anything that can post to
 * the port and "the caller already checked" is not a guarantee a boundary
 * should rely on. */
function invoke(method: string, args: readonly unknown[]): unknown {
  const kind = methodKind(method);
  if (kind === null) {
    throw new ValidationError(
      `DbClient method "${method}" is not classified as a read or a write ` +
        "(server/db/method-kinds.ts) — refusing to dispatch it.",
      "db_method_unclassified",
    );
  }
  if (kind === "write" && data.role === "reader") {
    throw new ValidationError(
      `write method "${method}" reached a READ worker; SQLite would refuse it ` +
        "and the facade should never have routed it here.",
      "db_write_on_reader",
    );
  }
  const fn = (client as unknown as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new ValidationError(`DbClient has no method "${method}".`, "db_method_missing");
  }
  return Reflect.apply(fn, client, args);
}

port.on("message", guarded("db.worker.message", (call: DbCall) => {
  // A graceful close lets the writer attempt a TRUNCATE checkpoint before
  // releasing its connection. Contention or I/O failure can prevent completion;
  // the shared checkpoint owner reports that outcome without a durability claim.
  if (call.method === "__close") {
    try {
      client.close();
    } finally {
      port.postMessage({ id: call.id, ok: true, value: null } satisfies DbReply);
    }
    return;
  }
  let reply: DbReply;
  try {
    const value =
      call.tx !== undefined
        ? client.withTransaction(() => call.tx!.map((op) => invoke(op.method, op.args)))
        : invoke(call.method!, call.args ?? []);
    reply = { id: call.id, ok: true, value };
  } catch (err) {
    reply = { id: call.id, ok: false, error: encodeError(err) };
  }
  port.postMessage(reply);
}));
