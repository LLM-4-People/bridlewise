#!/usr/bin/env node
/**
 * The database-key CLI — move THIS install's key into the key home, register
 * the installs that still keep one beside their database, forget a deleted
 * store, and re-key.
 *
 *   npm run db-key -- relocate --db <database> [--from <old key file>] [--force-empty]
 *   npm run db-key -- scan <folder>... [--apply]
 *   npm run db-key -- forget --db <database>
 *   npm run db-key -- rekey --db <database>
 *
 * `scan` lists the installs under the folders that still keep a key beside
 * their database; `--apply` REGISTERS them (every file of each is then kept
 * away from confined processes, projects and the file door, at any depth) —
 * it NEVER moves a key: another checkout's code still reads its key where it
 * is, and moving it would lock that checkout out. Each install moves its own
 * key with `relocate`, run by its own new code. One outcome per install; a
 * refusal never stops the scan.
 *
 * Passphrase installs (`HARNESS_WEB_DB_KEY` in the environment) move their
 * salt and re-key to a new random salt — which retires the old shared salt a
 * pre-v20 database adopted. The key home is `HARNESS_KEY_HOME`, else
 * `$XDG_CONFIG_HOME/bridlewise/keys`, else `~/.config/bridlewise/keys`. Stop
 * the server before `rekey` (it refuses a database another process holds).
 *
 * A THIN SHELL OVER THE EXPOSURE ACTIONS `database.key.relocate|scan|
 * forget|rekey` (the same actions an admin runs from the settings surface,
 * over this host's key tool, `server/db/key-tool.ts`): argument parsing and
 * the exit code (0 done, 1 refused or invalid arguments). Every decision
 * lives in `server/db/key-rotation.ts`. The result is one JSON line.
 */


import { parseArgs } from "node:util";

import { executeAction, registerDatabaseExposure } from "../server/kernel/canonical.ts";
import { installServerKeyTool } from "../server/db/key-tool.ts";
import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";

const USAGE = "usage: db-key relocate --db <database> [--from <old key file>] [--force-empty] | scan <folder>... [--apply] | forget --db <database> | rekey --db <database>";

/** The action a command line names, with its arguments; undefined when it names none. */
function actionOf(argv: readonly string[]): Readonly<{ id: string; args: Readonly<Record<string, unknown>> }> | undefined {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: { db: { type: "string" }, from: { type: "string" }, apply: { type: "boolean" }, "force-empty": { type: "boolean" } },
    allowPositionals: true,
  });
  if (command === "relocate" && values.db !== undefined) {
    return { id: "database.key.relocate", args: { database: values.db, ...(values.from !== undefined ? { from: values.from } : {}), forceEmpty: values["force-empty"] === true } };
  }
  if (command === "scan" && positionals.length > 0) return { id: "database.key.scan", args: { folders: positionals.join("\n"), apply: values.apply === true } };
  if (command === "forget" && values.db !== undefined) return { id: "database.key.forget", args: { database: values.db } };
  if (command === "rekey" && values.db !== undefined) return { id: "database.key.rekey", args: { database: values.db } };
  return undefined;
}

export async function runDbKeyCli(argv: readonly string[]): Promise<number> {
  const action = actionOf(argv);
  if (action === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  registerDatabaseExposure();
  installServerKeyTool("shell");
  const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  try {
    print(await executeAction(action.id, action.args));
    return 0;
  } catch (error) {
    // A typed refusal (engine or server) is an answer; anything else is a bug.
    if (!(error instanceof Error) || typeof (error as { code?: unknown }).code !== "string") throw error;
    print({ refused: (error as Error & { code: string }).code, message: error.message });
    return 1;
  }
}

// Run when invoked as the main module (an import runs nothing).
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runDbKeyCli(process.argv.slice(2));
}
