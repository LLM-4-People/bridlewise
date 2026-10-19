import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { InputError, interruptedWaitExitCode, safeError } from "./kernel/errors.ts";
import { canonicalJson } from "./kernel/integrity.ts";
import { createPreflightContext } from "./kernel/preflight.ts";
import { ROOT_POLICY } from "./kernel/root-policy.ts";
import { loadPinnedConfigSnapshotIfPresent } from "./kernel/config.ts";
import { initializeHarnessRuntime } from "./runtime/harness-bootstrap.ts";
import { generateIdentifier } from "./timeline/ledger-primitives.ts";
import { withRecordingContext } from "./timeline/recording-context.ts";
import { resolveSelfProtectionConfig } from "./filesystem/self-protection/self-protection-config.ts";
import { SAFE_READ_REJECT_ENV_VARS } from "./shared/source-scan.ts";
import { bootstrapProcess, isEntryPoint } from "./runtime/cli-debug.ts";

/**
 * CLI entry point.
 *
 * Global flags (--help/-h, --version/-v, --verbose/--debug) may appear
 * anywhere BEFORE a `--`, and are stripped before command dispatch;
 * everything after `--` is the command's own, passed on verbatim (`harness
 * slot run -- echo -v` runs `echo -v`). `--help` after a command prints that
 * command's help, never the top-level one. The interactive chat
 * command was removed (the web UI is the sole chat surface now); this entry
 * dispatches preflight, quality, and harness workflow commands.
 */

let verboseEnabled = false;

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    applySafeReadPolicy();
    const { cleanArgv, helpRequested, versionRequested, verbose } = parseGlobalFlags(argv);
    verboseEnabled = verbose;
    if (helpRequested) {
      // The command words before the flags: the command, and the harness's verb.
      const [command, verb] = cleanArgv.filter((arg) => !arg.startsWith("-"));
      await printHelp(command === undefined ? [] : verb === undefined ? [command] : [command, verb]);
      return 0;
    }
    if (versionRequested) {
      printVersion();
      return 0;
    }
    const command = await parseCommand(cleanArgv);
    if (command === undefined) {
      await printHelp();
      return 0;
    }
    // Make the harness's own machinery live BEFORE any command work runs:
    // the exposure catalog is populated and the effect sink appends to the
    // harness's canonical ledger. Idempotent, so the direct harness-commands
    // entry initializing again (when dispatched below) is a no-op, and
    // non-clobbering when an embedder (the web server) installed a sink
    // first. This is the choke point: every command dispatch passes here.
    initializeHarnessRuntime();
    // Every command runs inside a recording boundary whose actor is REAL —
    // derived from the actual invocation, never a hardcoded default. Effects
    // recorded anywhere below are attributed to this CLI command; outside a
    // boundary they would carry the visible `unattributed` marker instead.
    return await withRecordingContext(
      { actor: { kind: "cli", id: command }, runId: generateIdentifier("run") },
      async () => {
        if (command === ROOT_POLICY.protocol.preflightCommand) {
          return runPreflight();
        }
        if (command === ROOT_POLICY.protocol.qualityCommand) {
          const { runQualityCli } = await import("./quality-packs/cli.ts");
          return await runQualityCli(cleanArgv.slice(1));
        }
        if (command === ROOT_POLICY.protocol.harnessCommand) {
          const { runHarnessCli } = await import("./workflow/harness-commands.ts");
          return await runHarnessCli(cleanArgv.slice(1));
        }
        throw await unknownCommandError(command);
      },
    );
  } catch (error) {
    const safe = safeError(error);
    process.stderr.write(`${canonicalJson(safe)}\n`);
    if (verboseEnabled && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    // A door whose wait for the instrument lock a signal ended exits as the signal would have (by type).
    const interrupted = interruptedWaitExitCode(error);
    if (interrupted !== undefined) return interrupted;
    return 1;
  }
}

function parseGlobalFlags(argv: readonly string[]): {
  cleanArgv: string[];
  helpRequested: boolean;
  versionRequested: boolean;
  verbose: boolean;
} {
  let helpRequested = false;
  let versionRequested = false;
  let verbose = false;
  const cleanArgv: string[] = [];
  const end = argv.indexOf("--");
  for (const arg of end === -1 ? argv : argv.slice(0, end)) {
    if (arg === "--help" || arg === "-h") {
      helpRequested = true;
    } else if (arg === "--version" || arg === "-v") {
      versionRequested = true;
    } else if (arg === "--verbose" || arg === "--debug") {
      verbose = true;
    } else {
      cleanArgv.push(arg);
    }
  }
  // After `--`, the command's own arguments: verbatim, the `--` included (a door that runs a command reads it).
  if (end !== -1) cleanArgv.push(...argv.slice(end));
  return { cleanArgv, helpRequested, versionRequested, verbose };
}

async function parseCommand(argv: readonly string[]): Promise<string | undefined> {
  if (argv.length === 0) return undefined;
  const command = argv[0];
  if (command === undefined) return undefined;
  if (command === ROOT_POLICY.protocol.preflightCommand) {
    if (argv.length !== 1) {
      throw new InputError("preflight takes no additional arguments", "command_unavailable");
    }
    return command;
  }
  if (
    command === ROOT_POLICY.protocol.qualityCommand ||
    command === ROOT_POLICY.protocol.harnessCommand
  ) {
    return command;
  }
  throw await unknownCommandError(command);
}

/**
 * Build the `command_unavailable` error for an unrecognized top-level
 * command. When the token is a known harness workflow subcommand invoked
 * without its `harness` parent (the S73-W2 friction: `node src/cli.ts sync`
 * → `command_unavailable`), the message names the parent so the user reaches
 * the right invocation on the first try. The known-subcommand set is read
 * from the single owner (`HARNESS_SUBCOMMANDS` in harness-commands.ts) — a
 * subcommand added there tomorrow is recognized here automatically. The
 * import is dynamic and reached only on this error path so the heavy
 * harness-commands module graph stays lazy on the happy path.
 */
async function unknownCommandError(command: string): Promise<InputError> {
  const { HARNESS_SUBCOMMANDS } = await import("./workflow/harness-commands.ts");
  const parent = ROOT_POLICY.protocol.harnessCommand;
  if ((HARNESS_SUBCOMMANDS as readonly string[]).includes(command)) {
    return new InputError(
      `Unknown command: ${command} — harness workflow commands ride the \`${parent}\` parent: ` +
        `\`node src/cli.ts ${parent} ${command} …\` (run \`node src/cli.ts ${parent}\` to list subcommands)`,
      "command_unavailable",
    );
  }
  const topLevel = [
    ROOT_POLICY.protocol.preflightCommand,
    ROOT_POLICY.protocol.qualityCommand,
    parent,
  ];
  return new InputError(
    `Unknown command: ${command} (top-level commands: ${topLevel.join(", ")})`,
    "command_unavailable",
  );
}

/**
 * The safe repository reader's policy for this process, from the one owner of
 * the self-protection semantics (`resolveSelfProtectionConfig`: an ABSENT
 * section is production). It is propagated through the two env contracts
 * (`HARNESS_REJECT_HARDLINKS` + `HARNESS_REJECT_SYMLINKS`, named by
 * `SAFE_READ_REJECT_ENV_VARS` in `src/shared/source-scan.ts`) that
 * `shouldRejectHardlinks` / `shouldRejectSymlinks` read, so the test
 * inventory's subprocess scans inherit it: dev mode (`enabled: false`, written
 * down) accepts a `cp -rl` tree's hard links and the `node_modules` symlink;
 * production enforces the floor. Dev mode is announced once.
 *
 * THERE IS NO CLI RE-EXEC UNDER THE GUARDIAN ANY MORE (user decision C8).
 * It confined only the removed `chat` command, so every real command ran
 * unconfined while the code claimed a sandbox; the model-facing runtime is the
 * web server, whose commands and MCP servers are confined per spawn
 * (`server/safety/landlock-runner.ts`). Its config-snapshot env fast path
 * (`HARNESS_CONFIG_SNAPSHOT`, which silently replaced the config file in any
 * process that inherited it) and the guardian's "already inside" sentinel
 * (`HARNESS_LANDLOCK_GUARDIAN=applied`, which skipped the sandbox on an env
 * value anyone could set) went with it.
 */
function applySafeReadPolicy(): void {
  // Only an ABSENT document (e.g. preflight in a tree that has none yet) means
  // "nothing to decide from"; a document the loader REFUSES propagates.
  const config = loadPinnedConfigSnapshotIfPresent();
  if (config === undefined) return;
  const selfProtection = resolveSelfProtectionConfig(config.document);
  process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = selfProtection.enabled ? "1" : "0";
  process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = selfProtection.enabled ? "1" : "0";
  if (!selfProtection.enabled) {
    process.emitWarning(
      "self-protection disabled (dev mode); set selfProtection.enabled=true in bridlewise.config.json for production",
      { code: "self_protection_disabled_dev_mode", type: "SelfProtectionWarning" },
    );
  }
}

function runPreflight(): number {
  const context = createPreflightContext();
  process.stdout.write(`${canonicalJson(context.receipt)}\n`);
  return 0;
}

/** The help for `path` (the command words before `--help`: none is the top level). */
async function printHelp(path: readonly string[] = []): Promise<void> {
  if (path[0] === ROOT_POLICY.protocol.harnessCommand) {
    // Loaded only for this help, as the dispatch loads it only for its commands.
    const { HARNESS_SUBCOMMANDS } = await import("./workflow/harness-commands.ts");
    printHarnessHelp(HARNESS_SUBCOMMANDS, path[1]);
    return;
  }
  const commands: ReadonlyArray<readonly [string, string]> = [
    [ROOT_POLICY.protocol.preflightCommand, "Run preflight checks and print the receipt"],
    [ROOT_POLICY.protocol.qualityCommand, "Run language quality pack checks"],
    [ROOT_POLICY.protocol.harnessCommand, "Run harness workflow subcommands (sync, check, test, register, ...)"],
  ];
  const width = Math.max(...commands.map(([name]) => name.length));
  const commandLines = commands.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc}`);
  const lines = [
    "Usage: bridlewise <command> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Options:",
    "  --help, -h         Show this help message",
    "  --version, -v      Print the version and exit",
    "  --verbose, --debug Print full stack traces on errors",
    "",
    "Run `bridlewise harness` (no subcommand) to list harness subcommands.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * The harness's own help: its subcommands, or for one subcommand where its
 * usage is said. A subcommand's own usage lives in its parser today (it is
 * printed when its arguments are wrong); one usage registry every verb
 * declares is the guard catalog's CLI-OUT row (UX-0-SUBCOMMAND-HELP).
 */
function printHarnessHelp(subcommands: readonly string[], subcommand: string | undefined): void {
  const parent = ROOT_POLICY.protocol.harnessCommand;
  // The help of a subcommand that does not exist is the dispatch's own typed refusal, never the general list (design LOW 13).
  if (subcommand !== undefined && !subcommands.includes(subcommand)) {
    throw new InputError(`unknown harness subcommand: ${subcommand} (${subcommands.join(", ")})`, "unknown_harness_subcommand");
  }
  const lines = subcommand === undefined
    ? [
      `Usage: bridlewise ${parent} <subcommand> [options]`,
      "",
      "Subcommands:",
      ...subcommands.map((name) => `  ${name}`),
      "",
      "Options every subcommand takes:",
      "  --json (default), --text   How the answer is printed",
    ]
    : [
      `Usage: bridlewise ${parent} ${subcommand} [arguments]`,
      "",
      `The arguments \`${parent} ${subcommand}\` takes are named in its usage line, printed when its arguments are wrong;`,
      "the workflow is described in docs/process/WORKFLOW.md.",
    ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printVersion(): void {
  process.stdout.write(`bridlewise ${readVersion()}\n`);
}

function readVersion(): string {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const root = dirname(dirname(modulePath));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runCli();
}
