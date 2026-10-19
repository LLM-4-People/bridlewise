/**
 * THE KEY TOOL AS A HOST RUNS IT — the database module's key actions
 * (`database.key.relocate|scan|forget|rekey`) and signals over the one
 * key-rotation owner (`key-rotation.ts`), with this host's admitted key home
 * and its passphrase. Installed by the web server at boot (`server/index.ts`)
 * and by the `npm run db-key` shell (`scripts/db-key.ts`), which runs the
 * same actions.
 *
 * WHAT EACH HOST OFFERS (sec-e-design H3): the scan's walk runs in a worker
 * thread on both (the one pool, `runWorkerTask`; a home folder is a million
 * folders), bounded by `legacyInstalls.scanFolderBudget`; registration and
 * `forget` are quick and stay on the calling thread. `relocate` and `rekey`
 * are the SHELL's only: a running server never holds a key beside its own
 * database (it would not have started) and its own database is always busy,
 * so in the server both refuse typed, naming the command to run with the
 * server stopped — and a whole-database re-encryption never runs on the web
 * server's event loop.
 */
import { installDatabaseKeyTool, installDatabaseShellOperations, ROOT_POLICY, type LegacyInstallSearch } from "../kernel/canonical.ts";
import { serverConfig } from "../kernel/config.ts";
import { ServiceUnavailableError } from "../kernel/errors.ts";
import { runWorkerTask } from "../run/worker-pool.ts";
import { serverKeyHome, serverStoreRegistry } from "./bootstrap-key.ts";
import { forgetDatabase, registerLegacyInstalls, rekeyDatabase, relocateDatabaseKey } from "./key-rotation.ts";

let legacyInstallsFound = 0;

/** The bounded walk for installs keeping a key beside their database, in a worker thread. */
function searchOffTheLoop(roots: readonly string[]): Promise<LegacyInstallSearch> {
  const folderBudget = ROOT_POLICY.selfProtection.legacyInstalls.scanFolderBudget;
  return runWorkerTask<LegacyInstallSearch>({
    workerUrl: new URL("./key-scan-worker.ts", import.meta.url),
    workerData: { roots: [...roots], folderBudget },
    errorClass: ServiceUnavailableError,
    label: "key_scan",
    dedupKey: JSON.stringify([roots, folderBudget]),
    validateOk: (message) => (message as { search?: LegacyInstallSearch }).search,
  });
}

export function installServerKeyTool(host: "server" | "shell"): void {
  const passphrase = serverConfig.dbEncryptionKey;
  installDatabaseKeyTool({
    keyHome: () => serverKeyHome(),
    registeredStores: () => serverStoreRegistry().records().length,
    legacyInstallsFound: () => legacyInstallsFound,
    scan: async ({ folders, apply }) => {
      const search = await searchOffTheLoop(folders);
      legacyInstallsFound = search.installs.length;
      return apply ? { ...search, installs: registerLegacyInstalls(search.installs, serverKeyHome()) } : search;
    },
    forget: ({ database }) => forgetDatabase(database, serverKeyHome()),
  });
  // What only the stopped-server shell runs: the one shell-operation slot.
  if (host === "shell") {
    installDatabaseShellOperations({
      relocate: ({ database, from, forceEmpty }) => relocateDatabaseKey({ dbPath: database, ...(from === undefined ? {} : { from }), passphrase, keyHome: serverKeyHome(), ...(forceEmpty === true ? { forceEmpty } : {}) }),
      rekey: ({ database }) => rekeyDatabase({ dbPath: database, passphrase, keyHome: serverKeyHome() }),
    });
  }
}
