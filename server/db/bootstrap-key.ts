/** One process web-key admission. Consumers receive the same opaque capability,
 * including when the configured source is ephemeral. This owner has no database
 * or timeline imports, so their existing dependency direction is preserved. */
import { resolve } from "node:path";
import { admitHarnessKeyHome, openStoreRegistry, registerHarnessStore, type AdmittedKeyHome, type HarnessStoreRegistry, type PersistedKey } from "../kernel/canonical.ts";
import { resolveDatabaseKey } from "./db-crypto.ts";
import { serverConfig, DEFAULT_DB_PATH } from "../kernel/config.ts";
import { ConfigError } from "../kernel/errors.ts";

type KeySource = Readonly<{ dbPath: string; passphrase?: string }>;
let admitted: Readonly<{ source: KeySource; key: PersistedKey }> | undefined;

/** A configured database path as this server means it (`:memory:` stays itself). */
function storePath(path: string): string {
  return path === ":memory:" ? path : resolve(path);
}

let keyHome: AdmittedKeyHome | undefined;

/**
 * THE KEY HOME OF THIS SERVER, admitted ONCE (the one admission,
 * `admitHarnessKeyHome`): private, ours, and sharing nothing — by identity —
 * with the harness checkout, the system temp folder, either database's folder,
 * this repository or any declared project root. Its registry holds the web
 * database and the timeline, which shares the web database's key wherever it
 * lives (the pairing the key tool asks for).
 */
export function serverKeyHome(): AdmittedKeyHome {
  if (keyHome !== undefined) return keyHome;
  const web = storePath(serverConfig.dbPath.length > 0 ? serverConfig.dbPath : DEFAULT_DB_PATH);
  const timeline = storePath(serverConfig.timelineDbPath);
  const admittedHome = admitHarnessKeyHome([web, timeline], [
    { path: resolve(serverConfig.projectRoot), what: "the harness repository" },
    ...serverConfig.allowedProjectRoots.map((root) => ({ path: resolve(root), what: `the declared project root ${root}` })),
  ]);
  if (timeline !== ":memory:") registerHarnessStore(admittedHome, timeline, web === ":memory:" ? timeline : web);
  keyHome = admittedHome;
  return keyHome;
}

let registry: HarnessStoreRegistry | undefined;

/** The registry of this server's key home — the explicit dependency of its keep-out list and its key tool. */
export function serverStoreRegistry(): HarnessStoreRegistry {
  registry ??= openStoreRegistry(serverKeyHome());
  return registry;
}

/** The configured source is captured once; conflicting owners cannot silently
 * inherit another database's key. No key bytes enter request/worker replies. */
export function getDatabaseKey(source: KeySource = {
  dbPath: serverConfig.dbPath,
  passphrase: serverConfig.dbEncryptionKey,
}): PersistedKey {
  const path = source.dbPath.length > 0 ? source.dbPath : DEFAULT_DB_PATH;
  const normalized: KeySource = Object.freeze({
    dbPath: storePath(path),
    passphrase: source.passphrase ?? "",
  });
  if (admitted !== undefined) {
    const previous = admitted.source;
    if (previous.dbPath !== normalized.dbPath || previous.passphrase !== normalized.passphrase) {
      throw new ConfigError("The database key source conflicts with the admitted process owner", "database_key_owner_conflict");
    }
    return admitted.key;
  }
  const key = resolveDatabaseKey({
    dbPath: normalized.dbPath,
    ...(normalized.dbPath === ":memory:" ? {} : { keyHome: serverKeyHome() }),
    ...(normalized.passphrase ? { passphrase: normalized.passphrase } : {}),
  });
  admitted = Object.freeze({ source: normalized, key });
  return key;
}
