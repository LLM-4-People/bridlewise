/**
 * Shared exposure registrations — `database` module.
 *
 * The web database's upgrade safety net, as signals (secc-design M9): how
 * many verified pre-migration copies are kept (`HARNESS_WEB_DB_BACKUP_RETENTION`,
 * a boot setting, read-only here), and the newest copy present beside the
 * database (its schema version and path). An operator deciding whether an
 * upgrade can be rolled back reads it here instead of listing the folder.
 *
 * The live source is installed by the host that owns the database (the web
 * server, at boot). With no host source both read `unmeasured`.
 *
 * THE KEY'S LIFECYCLE is exposed here too (secd-design M9): the key home's
 * location (admins only), how many harness stores its registry holds and how
 * many installs still keeping a key beside their database the last scan
 * found, and the key tool's four operations as ADMIN actions
 * (`database.key.relocate|scan|forget|rekey`, the same functions
 * `npm run db-key` runs — the CLI is a thin shell over these actions). The
 * tool is installed by the host that owns the key home (the web server at
 * boot, the CLI when it runs); without one the signals read empty and the
 * actions refuse. `relocate` and `rekey` are the shell's only (the server
 * refuses them, naming the command).
 */

import { HarnessError } from "../../../kernel/errors.ts";
import { optionalStringArg, registerAction, registerExposureModule, registerSignal } from "../index.ts";

export type DatabaseSafetyFacts = Readonly<{
  backupRetention: number;
  newestPreMigrationCopy: Readonly<{ path: string; version: number }> | undefined;
}>;

let factsSource: (() => DatabaseSafetyFacts) | null = null;

/** The database threads' supervision (SCALE-CR1 C4), as the host that owns them reads it. */
export type DatabaseThreadFacts = Readonly<{ state: string; restarts: number; readers: number; restartMax: number; restartWindowMs: number }>;
let threadsSource: (() => DatabaseThreadFacts) | null = null;

/** Install the live reading of the database threads' supervision (the web server, at boot). */
export function installDatabaseThreadsSource(source: () => DatabaseThreadFacts): void {
  threadsSource = source;
}
let databaseRegistered = false;

/**
 * The key tool as a host installs it: its facts and the operations any host
 * runs (every decision is the host's key-rotation owner). What only the
 * maintenance shell runs is a {@link DatabaseShellOperations} entry.
 */
export type DatabaseKeyTool = Readonly<{
  keyHome: () => string;
  registeredStores: () => number;
  legacyInstallsFound: () => number;
  scan: (args: Readonly<{ folders: readonly string[]; apply: boolean }>) => unknown;
  forget: (args: Readonly<{ database: string }>) => unknown;
}>;

let keyTool: DatabaseKeyTool | null = null;

/**
 * THE MAINTENANCE SHELL'S OPERATIONS — ONE SLOT (SCALE-CR1-FIX M7): what only
 * a shell with the server STOPPED runs (moving or re-keying a database's key,
 * archiving and removing trashed conversations: UD-S15). The shell that runs
 * one installs it; every other host (the web server) refuses the action
 * `database_action_shell_only`, naming the command to run instead.
 */
export type DatabaseShellOperations = Readonly<{
  relocate: (args: Readonly<{ database: string; from?: string; forceEmpty?: boolean }>) => unknown;
  rekey: (args: Readonly<{ database: string }>) => unknown;
  archiveConversations: (args: Readonly<{ database: string; chatIds: readonly string[] }>) => unknown;
}>;

/** The command a refusal names for each shell operation. */
const SHELL_COMMANDS: Readonly<Record<keyof DatabaseShellOperations, string>> = Object.freeze({
  relocate: "npm run db-key -- relocate --db <database>",
  rekey: "npm run db-key -- rekey --db <database>",
  archiveConversations: "npm run db-archive -- --db <database> --chats-file <file>",
});

let shellOperations: Partial<DatabaseShellOperations> = {};

/** Install shell operations (the `db-key` and `db-archive` shells, for what each runs). */
export function installDatabaseShellOperations(operations: Partial<DatabaseShellOperations>): void {
  shellOperations = { ...shellOperations, ...operations };
}

/** Install the key tool (the web server at boot, the `db-key` CLI when it runs). */
export function installDatabaseKeyTool(tool: DatabaseKeyTool): void {
  keyTool = tool;
}

function requireKeyTool(): DatabaseKeyTool {
  if (keyTool === null) throw new HarnessError("No host owning a key home is running here, so the key tool is unavailable.", "database_key_tool_unavailable");
  return keyTool;
}

/** A shell operation: refused, naming its command, by a host that did not install it (the web server). */
function shellOperation<Name extends keyof DatabaseShellOperations>(name: Name): DatabaseShellOperations[Name] {
  const operation = shellOperations[name];
  if (operation === undefined) {
    throw new HarnessError(`This host does not run that database operation (it needs the server stopped): stop the server and run \`${SHELL_COMMANDS[name]}\` on its host.`, "database_action_shell_only");
  }
  return operation;
}

/** Install the live reading of the database's safety facts (the web server, at boot). */
export function installDatabaseFactsSource(source: () => DatabaseSafetyFacts): void {
  factsSource = source;
}

export function registerDatabaseExposure(): void {
  if (databaseRegistered) return;
  databaseRegistered = true;

  registerExposureModule({
    id: "database",
    title: "The web database's upgrade copies",
    purpose:
      "Before each schema upgrade the database is copied and the copy verified; these signals say how many such copies are kept and which one is the newest, so a failed upgrade's way back is visible before it is needed.",
  });

  registerSignal({
    id: "database.backupRetention",
    module: "database",
    name: "Pre-upgrade copies kept",
    description: "How many verified pre-upgrade copies of the database are kept beside it (older ones are removed after a new one is verified). Set at start by HARNESS_WEB_DB_BACKUP_RETENTION; 0 means this process never opened the database.",
    type: "gauge",
    unit: "copies",
    value: () => factsSource?.().backupRetention ?? 0,
  });
  registerSignal({
    id: "database.newestPreMigrationCopy",
    module: "database",
    name: "Newest pre-upgrade copy",
    description: "The newest pre-upgrade copy beside the database: the schema upgrade it was taken before, and where it is. Empty when there is none (a database never upgraded, or one kept in memory).",
    type: "string",
    value: () => {
      const copy = factsSource?.().newestPreMigrationCopy;
      return copy === undefined ? "" : `before schema ${copy.version}: ${copy.path}`;
    },
    // The path is the host's layout: an admin reads it, anyone else the version.
    visibility: {
      viewer: "admin",
      publicValue: () => {
        const copy = factsSource?.().newestPreMigrationCopy;
        return copy === undefined ? "" : `before schema ${copy.version}`;
      },
    },
  });

  registerSignal({
    id: "database.threads.state",
    module: "database",
    name: "Database threads",
    description: "Whether the database's threads are serving: ready; restarting (a thread stopped and is being replaced — its reads are retried, its in-flight writes were answered 'outcome unknown'); circuit-open (threads kept stopping, so calls are refused as unavailable for a while before restarts resume); closed; or unopened.",
    type: "string",
    value: () => threadsSource?.().state ?? "unmeasured",
  });
  registerSignal({
    id: "database.threads.restarts",
    module: "database",
    name: "Database thread restarts",
    description: "How many times a database thread that stopped was replaced since the server started. Each restart is logged; a rising count is a defect to find (a read that exhausts memory, a crashing query).",
    type: "counter",
    unit: "restarts",
    value: () => threadsSource?.().restarts ?? 0,
  });
  // The restart circuit's budget IN FORCE (boot settings today: the env names
  // HARNESS_WEB_DB_THREAD_RESTART_MAX / _WINDOW_MS; they become registered
  // settings with the configuration tier, CFG-6). Read-only here, never a
  // second copy of the value (SCALE-CR1-FIX M5).
  registerSignal({
    id: "database.threads.restartMax",
    module: "database",
    name: "Thread restarts allowed per window",
    description: "How many database-thread restarts the circuit allows within one window before it opens (calls answered 'unavailable' for a window, then restarts resume). Set at boot (HARNESS_WEB_DB_THREAD_RESTART_MAX).",
    type: "gauge",
    unit: "restarts",
    value: () => threadsSource?.().restartMax ?? 0,
  });
  registerSignal({
    id: "database.threads.restartWindowMs",
    module: "database",
    name: "Thread restart window",
    description: "The restart circuit's window, and how long it stays open once it opens. Set at boot (HARNESS_WEB_DB_THREAD_RESTART_WINDOW_MS).",
    type: "gauge",
    unit: "ms",
    value: () => threadsSource?.().restartWindowMs ?? 0,
  });
  registerSignal({
    id: "database.keyHome",
    module: "database",
    name: "Key home",
    description: "Where every database key, the store registry and the binding records live (HARNESS_KEY_HOME, else $XDG_CONFIG_HOME/bridlewise/keys). Back it up: the database's own copies are useless without it. Admins only.",
    type: "string",
    value: () => keyTool?.keyHome() ?? "",
    visibility: { viewer: "admin" },
  });
  registerSignal({
    id: "database.registeredStores",
    module: "database",
    name: "Registered harness stores",
    description: "How many harness databases the key home's registry holds — each one's files are kept away from confined commands, projects and the file door, by identity, wherever it lives.",
    type: "gauge",
    unit: "stores",
    value: () => keyTool?.registeredStores() ?? 0,
  });
  registerSignal({
    id: "database.legacyKeysFound",
    module: "database",
    name: "Installs keeping a key beside their database",
    description: "How many installs the last key scan found still keeping their key beside their database (the layout before the key home). Each is refused by shape anyway; registering them (the scan action with apply) keeps them out at any depth.",
    type: "gauge",
    unit: "installs",
    value: () => keyTool?.legacyInstallsFound() ?? 0,
  });

  registerAction({
    id: "database.key.relocate",
    module: "database",
    name: "Move one install's key into the key home",
    description: "Moves the key (or passphrase salt) kept beside the named database into the key home after proving it opens the database, then registers the database. Run for THIS install; never for another checkout's (its code still reads its own). The db-key shell's only: the server refuses it.",
    args: {
      database: { type: "string", required: true, description: "The database file whose key moves." },
      from: { type: "string", required: false, description: "The old key file, when not <database folder>/db-key." },
      forceEmpty: { type: "boolean", required: false, description: "Move a key nothing sealed in the database can prove (an empty database)." },
    },
    execute: (args) => shellOperation("relocate")({ database: optionalStringArg(args?.["database"]) ?? "", ...(optionalStringArg(args?.["from"]) === undefined ? {} : { from: optionalStringArg(args?.["from"])! }), forceEmpty: args?.["forceEmpty"] === true }),
  });
  registerAction({
    id: "database.key.scan",
    module: "database",
    name: "Find (and register) installs still keeping their key beside their database",
    description: "Lists the installs under the folders; with apply, REGISTERS them (never moves a key). One outcome per install. The walk runs off the server's event loop and stops at the declared folder budget, saying so (truncated): scan the rest by naming deeper folders.",
    args: {
      folders: { type: "string", required: true, description: "The folders to look under, one per line." },
      apply: { type: "boolean", required: false, description: "Register what is found." },
    },
    execute: (args) => requireKeyTool().scan({ folders: (optionalStringArg(args?.["folders"]) ?? "").split("\n").map((folder) => folder.trim()).filter((folder) => folder.length > 0), apply: args?.["apply"] === true }),
  });
  registerAction({
    id: "database.key.forget",
    module: "database",
    name: "Forget a deleted store",
    description: "Removes one database's record from the key home's registry (a store deleted on purpose). Its place stops being kept out.",
    args: { database: { type: "string", required: true, description: "The database file to forget." } },
    execute: (args) => requireKeyTool().forget({ database: optionalStringArg(args?.["database"]) ?? "" }),
  });
  registerAction({
    id: "database.key.rekey",
    module: "database",
    name: "Re-key a database",
    description: "Re-encrypts every field under a new key (or a new random salt) after a verified copy, keeping the retired key beside it. Refused while any process holds the database. The db-key shell's only: stop the server and use `npm run db-key -- rekey` (the server refuses it).",
    args: { database: { type: "string", required: true, description: "The database file to re-key." } },
    execute: (args) => shellOperation("rekey")({ database: optionalStringArg(args?.["database"]) ?? "" }),
  });
  registerAction({
    id: "database.conversations.archive",
    module: "database",
    name: "Archive and remove conversations",
    description: "Writes every row of the named conversations (trashed ones only) to one archive file beside the database, proves the file whole against the database, then removes them — after a verified copy of the database. Refused while any process holds the database. The db-archive shell's only: stop the server and use `npm run db-archive`.",
    args: {
      database: { type: "string", required: true, description: "The database file." },
      chatIds: { type: "string", required: true, description: "The conversation ids, one per line." },
    },
    execute: (args) => {
      const archive = shellOperation("archiveConversations");
      const chatIds = (optionalStringArg(args?.["chatIds"]) ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      return archive({ database: optionalStringArg(args?.["database"]) ?? "", chatIds });
    },
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetDatabaseRegistration(): void {
  databaseRegistered = false;
}
