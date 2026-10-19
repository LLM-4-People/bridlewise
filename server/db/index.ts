/**
 * Singleton DbClient instance for the web-slice server process.
 *
 * One DbClient owns one DatabaseSync handle and one schema version.
 * Route files receive this instance via dependency injection (the
 * registration function takes `(router, db)`); they never import this
 * module directly. This keeps routes testable with an in-memory DbClient.
 *
 * The DB path is configurable via:
 * 1. `HARNESS_WEB_DB_PATH` env var (resolved in server/config.ts)
 * 2. argument to `getOrCreateDb(path)`
 * 3. `DEFAULT_DB_PATH` (`.bridlewise/web.db` under cwd)
 */

import { getDatabaseKey } from "./bootstrap-key.ts";
import { createDbCryptoFromKey } from "./db-crypto.ts";
import { DbClient } from "./client.ts";
import { AsyncDbClient } from "./async-client.ts";
import { serverConfig, DEFAULT_DB_PATH } from "../kernel/config.ts";

let instance: DbClient | null = null;
let asyncInstance: AsyncDbClient | null = null;

/**
 * Return the shared DbClient, creating it on first call. The path is
 * resolved once and bound to the admitted key for the process; a subsequent
 * conflicting path or key source is refused.
 *
 * The encryption-at-rest key is resolved from the server config:
 * - HARNESS_WEB_DB_KEY (passphrase) → scrypt-derived key (salt in the key home)
 * - default → a key file in the key home (persisted; `HARNESS_KEY_HOME` relocates it)
 * The key SURVIVES reboots (server/db-crypto.ts) so all `enc:` data
 * remains decryptable across server restarts.
 */
export function getOrCreateDb(path: string = serverConfig.dbPath): DbClient {
  if (instance !== null) { getDatabaseKey({ dbPath: path, passphrase: serverConfig.dbEncryptionKey }); return instance; }
  const resolved = path.length > 0 ? path : DEFAULT_DB_PATH;
  instance = new DbClient({
    path: resolved,
    crypto: createDbCryptoFromKey(getDatabaseKey({ dbPath: resolved, passphrase: serverConfig.dbEncryptionKey })),
  });
  return instance;
}

/**
 * THE ASYNC FACADE FOR THE SERVER PROCESS — now threaded, and why it may be.
 *
 * ── The constraint this used to be waiting on ──
 *
 * A server that is HALF converted cannot use the threaded backend, and that
 * was never a preference. A call site holding the synchronous `DbClient` needs
 * `getOrCreateDb()`, which opens a read-write connection on the main thread;
 * the threaded backend opens another on its writer thread. That is TWO WRITERS
 * on one SQLite file — and the whole ordering argument in `thread-backend.ts`
 * (W1, and through it the ledger's chain hash) rests on there being exactly
 * one. WAL would not corrupt the file; it would simply stop being true that
 * "the entry before this one" is well-defined.
 *
 * So the migration order was forced, and it is the order §2 states: every call
 * site moves to the facade first, the synchronous door closes, and only then
 * does the backend become threaded. That is what happened. No module outside
 * `server/db/` holds a `DbClient` any more, `getOrCreateDb` is internal to
 * this file, and the facade below is a read pool plus one writer thread.
 *
 * `tests/prevention/async-db-facade-owner.test.ts` held the constraint and has
 * INVERTED on its own: with no synchronous call site left, it now REQUIRES the
 * threaded backend rather than forbidding it.
 *
 * ── Opened lazily, warmed at boot ──
 *
 * This function is synchronous, so it cannot await an open. It declares the
 * backend and the connections open on first use; `warmAsyncDb()` makes that
 * first use the boot rather than somebody's request. See
 * `async-client.ts::DeferredThreadBackend`.
 */
export function getOrCreateAsyncDb(path: string = serverConfig.dbPath): AsyncDbClient {
  if (asyncInstance !== null) { getDatabaseKey({ dbPath: path, passphrase: serverConfig.dbEncryptionKey }); return asyncInstance; }
  const resolved = path.length > 0 ? path : DEFAULT_DB_PATH;
  asyncInstance = AsyncDbClient.deferred({
    path: resolved,
    admittedKey: getDatabaseKey({ dbPath: resolved, passphrase: serverConfig.dbEncryptionKey }),
    synchronous: serverConfig.dbSynchronous,
    busyTimeoutMs: serverConfig.dbBusyTimeoutMs,
    durabilityWindowMs: serverConfig.dbDurabilityWindowMs,
    restartMax: serverConfig.dbThreadRestartMax,
    restartWindowMs: serverConfig.dbThreadRestartWindowMs,
  });
  return asyncInstance;
}

/**
 * Open the process facade's connections before anything asks it a question.
 *
 * Called by the bootstrap before the socket listens. Without it the first HTTP
 * request would pay for spawning nine threads and running the migrations, and
 * the health route could be asked for a schema version nobody had read yet.
 */
export async function warmAsyncDb(): Promise<void> {
  await getOrCreateAsyncDb().warm();
}

export type { DbClient } from "./client.ts";
export { databaseThreadSupervision } from "./thread-backend.ts";
