/**
 * THE CHECKOUT WRITE DOOR — A TEST NEVER WRITES A FILE ITS OWN CHECKOUT OWNS.
 *
 * `harness sync`, `harness regenerate`, `harness register --write`, the test
 * inventory, the pin authorities, the handoff manifest, the README consumers
 * and the module scaffold rewrite files of the checkout they are handed
 * whenever that tree disagrees with them. A test that hands one of them the
 * live checkout rewrites the real repository mid-run, and every concurrent
 * test reads the rewritten bytes.
 *
 * History, because each step failed differently: static detectors of "the
 * live root" lost to most spellings; the first runtime door (env markers, a
 * path-string comparison) lost to a symlink, `/proc/self/root`, a scrubbed
 * env and every untracked file (a1b-correctness §3); the second read every
 * ancestor's command line and exec-time ENVIRONMENT and treated any argv
 * holding `/vitest/` or `--test-*` as a test runner — which refused the
 * product editor's own saves under an unrelated ancestry (a project path with
 * a `vitest` segment, `cargo test -- --test-threads=1`), copied the parent
 * shell's secrets into every harness process, and still lost to a detached
 * grandchild, unlisted node options, `--import`/`-e` loaders,
 * `process.title` and a planted `.git` (wf1a-correctness §2).
 *
 * ── WHO IS UNDER TEST ────────────────────────────────────────────────────
 *
 * Decided ONCE, when this module loads (the ancestry is intact then; a
 * process re-parented later keeps its answer), from three facts. Every name
 * below is the root policy's (`ROOT_POLICY.verification.checkoutWriteDoor`).
 *
 * 1. THE ARMING MARKER — explicit, set only by our test runners. The engine
 *    test worker and the root vitest config (vitest's main process) call
 *    {@link armCheckoutUnderTest} on the checkout they test. Arming exports
 *    the marker variable (a JSON list of checkout roots) into the process
 *    env, so every descendant that keeps its env inherits it — a detached
 *    grandchild, one started under `setsid`, one whose test already exited —
 *    and HOLDS THE MARKER FILE OPEN for the process's lifetime. Every process
 *    that loads this module under test re-arms itself the same way, so the
 *    marker travels down the tree.
 * 2. THIS PROCESS'S OWN node command line, read from `process.execArgv` and
 *    `process.argv` — never from `/proc/self/cmdline`, which `process.title`
 *    rewrites. A process runs tests when node's options hold `--test`, its
 *    script is a test file (the root policy's test pattern), or one of node's
 *    options (a preload, a loader, eval code) names a test file: a raw
 *    `node --test`, `node --disable-warning X x.test.ts`, tsx,
 *    `--import ./x.test.ts -e 0`, `-e 'await import("./x.test.ts")'`. No list
 *    of node options is needed, because node already split them off.
 * 3. THE ANCESTORS, walked through procfs (`stat` → parent). An ancestor that
 *    holds a marker file open is under test — a descriptor another process
 *    holds cannot be removed by a scrubbed env, a rewritten title or a
 *    loader, so a child spawned with `env: {}` is still seen. A NODE ancestor
 *    (by its executable, not its argv) whose command line runs tests (fact 2
 *    on its `cmdline`, the script being the first argument that names an
 *    existing file) covers raw runners that never loaded this module. NO
 *    ancestor's environment is read: it holds the parent shell's secrets.
 *
 * A process that is none of these is not under test, and the door is a
 * no-op — whatever strings its ancestors' command lines contain.
 *
 * ── WHAT IS PROTECTED, AND WHAT IS REFUSED ───────────────────────────────
 *
 * Each armed or recognized checkout ROOT (the nearest directory holding a
 * `.git` entry of the runner's working directory, of each test file it runs,
 * or of the armed path), identified by device and inode after `realpath` —
 * never by a path string, so a symlink, a `/proc/self/root/...` spelling or
 * a relative path reach the same answer. A write is refused when a protected
 * root is ANY canonical ancestor of the target (a `.git` planted inside the
 * checkout does not carve out a checkout of its own), unless the target lies
 * in one of the root policy's writable directories (`.bridlewise/`: state,
 * receipts, repository-local fixtures). Tracked files, new untracked files
 * and build output alike are refused. A generator a test drives on a WORKING
 * COPY writes freely: the copy is not a protected root.
 *
 * ── LIMITS, STATED ───────────────────────────────────────────────────────
 *
 * - Without procfs (non-Linux, `hidepid`, a sandbox without `/proc`), fact 3
 *   is unavailable; facts 1 and 2 still hold, and a one-time typed warning
 *   (`HARNESS_CHECKOUT_DOOR_PROCFS_UNAVAILABLE`) says so, loudly.
 * - A descendant that scrubs its env AND outlives every armed ancestor before
 *   it loads this module is not seen.
 * - Only JavaScript/TypeScript test files are recognized (no Python runner).
 * - Playwright runs are armed by their configs (`armPlaywrightRun`,
 *   `tests/setup/real-database-refusal.ts`), their API server included; a
 *   server they REUSE is outside the run's tree — the global setup refuses
 *   one that serves a real database (UD-S15).
 * - A process started OUTSIDE the ancestry is not seen: under `unshare -Urpf`
 *   (a new pid namespace: its procfs shows no armed ancestor) or through
 *   `systemd-run` (the service manager is its parent), with a scrubbed env,
 *   before it loads this module (the marker variable is `HARNESS_*`, which
 *   no child environment projection forwards, so the long-task runner's
 *   `systemd-run` units start without it too). Such a launch leaves the
 *   test's process tree; a test that drives one gives it a working copy.
 *
 * Outside a test run the protected set is empty and the door costs one
 * ancestry walk at load (measured 2.29 ms for 7 ancestors holding 53
 * descriptors: more under an IDE with many open files) and one comparison
 * per write: the real `harness sync`, `npm test`'s auto-heal (its runner is not
 * armed; only its workers are) and the candidate tool write the checkout they
 * run in.
 *
 * The door sits in the shared write primitive (`atomicWriteFile`), so every
 * writer that uses it is covered without knowing this file exists; a
 * primitive that must commit with a raw `rename` (the journaled multi-file
 * commit) asks the door first.
 */
import { lstatSync, mkdirSync, openSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SecurityError } from "../kernel/errors.ts";
import { debugLog } from "../shared/debug/debug-system.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { identityKey } from "./path-identity.ts";
import { ancestorsOf, commandLineOf, executableOf, openFileTargetsOf, procfsAvailable, workingDirectoryOf } from "../process/process-facts.ts";

const POLICY = ROOT_POLICY.verification.checkoutWriteDoor;
const TEST_FILE_PATTERN = new RegExp(ROOT_POLICY.verification.testDiscovery.recognizableSourcePatterns.javaScriptTypeScript, "u");
const PRIVATE_FILE_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode;
const PRIVATE_DIRECTORY_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.directoryMode;
const MARKER_SUFFIX = `${sep}${POLICY.markerFile.split("/").join(sep)}`;

export const CHECKOUT_WRITE_REFUSAL_CODE = "generator_live_checkout_under_test";
const CHECKOUT_MARKER_INVALID_CODE = "checkout_under_test_marker_invalid";
export const PROCFS_UNAVAILABLE_WARNING_CODE = "HARNESS_CHECKOUT_DOOR_PROCFS_UNAVAILABLE";

type CheckoutIdentity = Readonly<{ identity: string; path: string }>;

/** A node command line, split into node's own options, the script it runs, and the script's arguments. */
export type NodeCommandLine = Readonly<{ options: readonly string[]; script: string | undefined; scriptArguments: readonly string[] }>;

function isTestFile(argument: string): boolean {
  return TEST_FILE_PATTERN.test(argument);
}

/** The path-like words of one code value: a preload's path, each word of eval code. */
function codeWords(value: string): readonly string[] {
  return value.split(/[\s"'`()=,;{}[\]]+/u).filter((word) => word.length > 0);
}

/**
 * The VALUES of node's code options (`--import x`, `--require=x`, `-e "…"`):
 * the only option values node runs as code. Any other valued option
 * (`--watch-path test/x.test.ts`) names a file node does not run, and must
 * not turn a process into a test runner (wf1c-correctness §1 F8).
 */
function codeOptionValues(options: readonly string[]): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    const equals = option.indexOf("=");
    const name = equals > 0 && option.startsWith("--") ? option.slice(0, equals) : option;
    if (!(POLICY.nodeCodeOptions as readonly string[]).includes(name)) continue;
    const value = equals > 0 && option.startsWith("--") ? option.slice(equals + 1) : options[index + 1];
    if (value !== undefined) values.push(value);
    if (!(equals > 0 && option.startsWith("--"))) index += 1;
  }
  return values;
}

/**
 * The test files a node command line RUNS, or `undefined` when it runs no
 * tests (an empty list is a runner that names no file: `node --test`). A test
 * path that is merely an ARGUMENT of a script (`harness sync --prune
 * test/x.test.ts`) is not run. Exported for the door's own tests.
 */
export function testFilesRun(command: NodeCommandLine): readonly string[] | undefined {
  if (command.options.includes(POLICY.nodeTestRunnerFlag)) {
    return [command.script ?? "", ...command.scriptArguments].filter(isTestFile);
  }
  if (command.script !== undefined && isTestFile(command.script)) return [command.script];
  const named = codeOptionValues(command.options).flatMap(codeWords).filter(isTestFile);
  return named.length > 0 ? named : undefined;
}

/** `lstat`, or `undefined` when nothing is there — including a path THROUGH a file (ENOTDIR). */
function entryStats(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * A node command line read from procfs: the script is the first argument
 * after the executable that names an existing regular file (resolved against
 * the process's working directory) and is not the separate VALUE of a node
 * option (`--title x`, `--env-file x`: node's own valued options, every one
 * `ROOT_POLICY` classifies) or of a code option (`--import x`, `-e x`);
 * everything before it is node's options. A file
 * value read as the script invented a runner (`node --watch-path
 * test/x.test.ts plain.mjs`: wf1b2-correctness "--watch-path still refused")
 * or hid one (`node --require ./setup.cjs test/y.test.mjs`).
 */
export function nodeCommandLineOf(tokens: readonly string[], workingDirectory: string | undefined): NodeCommandLine {
  const valued = new Set<string>([...POLICY.nodeCodeOptions, ...POLICY.nodeValuedOptions]);
  const index = tokens.findIndex((token, position) => position > 0 && !token.startsWith("-") &&
    !valued.has(tokens[position - 1] ?? "") &&
    isExistingFile(hostPath(token, workingDirectory)));
  if (index < 0) return { options: tokens.slice(1), script: undefined, scriptArguments: [] };
  return { options: tokens.slice(1, index), script: tokens[index], scriptArguments: tokens.slice(index + 1) };
}

/** Whether `path` names an existing regular file; any argument that cannot (eval code, a flag value) does not. */
function isExistingFile(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    // Followed: an npm `.bin/` entry is a symlink to the script it runs.
    return statSync(path).isFile();
  } catch {
    // ENOENT, ENAMETOOLONG (a line of eval code), EACCES: not a file this process runs.
    return false;
  }
}

/** An argument as an absolute path (a `file:` URL or a path relative to `base`). */
function hostPath(argument: string, base: string | undefined): string | undefined {
  if (argument.startsWith("file:")) {
    try {
      return fileURLToPath(argument);
    } catch {
      return undefined;
    }
  }
  if (isAbsolute(argument)) return argument;
  return base === undefined ? undefined : join(base, argument);
}

/** `realpath` of the nearest existing ancestor, with the not-yet-existing rest appended. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...rest.toReversed());
    } catch {
      if (dirname(current) === current) return absolute;
      rest.push(basename(current));
    }
  }
}

/**
 * WHERE A WRITE TO `path` LANDS, for the refusal: its parent's `realpath`
 * plus its own name — the final component is NEVER followed. A write,
 * unlink or rename acts on the name itself, so a checkout-owned link that
 * points outside is judged where it is (inside the checkout), not where it
 * points (secb-security SECB-V-7). `atomicWriteFile` decides separately
 * whether a final link may be written through, and asks with the target.
 */
function writeLocationOf(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
}

/** The checkout holding `path`: the nearest directory with a `.git` entry. */
function checkoutOf(path: string): CheckoutIdentity | undefined {
  const canonical = canonicalPath(path);
  const start = entryStats(canonical)?.isDirectory() === true ? canonical : dirname(canonical);
  for (let directory = start; ; directory = dirname(directory)) {
    if (entryStats(join(directory, ".git")) !== undefined) {
      const identity = identityAt(directory);
      if (identity !== undefined) return { identity, path: directory };
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/** The one `dev:ino` spelling (`path-identity.ts`, bigint), of the entry itself (never through a link). */
function identityAt(path: string): string | undefined {
  try {
    return identityKey(lstatSync(path, { bigint: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

const armed = new Map<string, CheckoutIdentity>();
let markerRefusal: string | undefined;
let procfsWarned = false;

function warnLoudly(code: string, message: string, detail: Readonly<Record<string, string>>): void {
  debugLog("filesystem.checkout-write-door", "warn", message, () => ({ code, ...detail }));
  process.emitWarning(message, { code, detail: JSON.stringify(detail) });
}

/** Adds `identity` to the protected set, exports the marker and holds the marker file open. */
function arm(identity: CheckoutIdentity): void {
  if (armed.has(identity.identity)) return;
  armed.set(identity.identity, identity);
  process.env[POLICY.markerEnvironmentVariable] = JSON.stringify([...armed.values()].map((entry) => entry.path));
  const marker = join(identity.path, ...POLICY.markerFile.split("/"));
  try {
    mkdirSync(dirname(marker), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // Held, never closed: the descriptor IS the marker a scrubbed descendant
    // finds. Node opens it close-on-exec, so no child inherits it — a child
    // is found through this process, or re-arms itself when it loads this module.
    openSync(marker, "a", PRIVATE_FILE_MODE);
  } catch (error) {
    warnLoudly("HARNESS_CHECKOUT_DOOR_MARKER_UNAVAILABLE", "the checkout write door could not hold its marker file; descendants with a scrubbed env will not see this test run", {
      marker, error: (error as Error).message,
    });
  }
}

/**
 * ARMS `root`'s checkout as under test for this process and every
 * descendant. Called by our test runners (the engine test worker, the root
 * vitest config) before any test runs. Refuses a path in no checkout.
 */
export function armCheckoutUnderTest(root: string): void {
  const identity = checkoutOf(root);
  if (identity === undefined) {
    throw new SecurityError(`cannot arm the checkout write door: ${root} is in no checkout`, CHECKOUT_MARKER_INVALID_CODE);
  }
  arm(identity);
}

/** The marker's roots, or `undefined` when it is not a JSON list of absolute paths. */
function parsedMarker(raw: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string" && isAbsolute(entry)) ? parsed as string[] : undefined;
}

function inheritedMarker(): readonly string[] {
  const raw = process.env[POLICY.markerEnvironmentVariable];
  if (raw === undefined) return [];
  const roots = parsedMarker(raw);
  if (roots !== undefined) return roots;
  // Fail CLOSED: the variable is ours, and a process carrying a garbled one
  // descends from a test run whose checkout it can no longer name.
  markerRefusal = raw;
  return [];
}

/** The checkout roots whose marker file `pid` holds open. */
function heldMarkerRoots(pid: number): readonly string[] {
  return openFileTargetsOf(pid).filter((target) => target.endsWith(MARKER_SUFFIX))
    .map((target) => target.slice(0, -MARKER_SUFFIX.length));
}

/** The checkout roots an ancestor tests: the markers it holds, or — a node runner — its working directory and test files. */
function ancestorRoots(pid: number): readonly string[] {
  const held = heldMarkerRoots(pid);
  const executable = executableOf(pid);
  if (executable === undefined || !(POLICY.nodeExecutableNames as readonly string[]).includes(basename(executable))) return held;
  const commandLine = commandLineOf(pid);
  if (commandLine === undefined) return held;
  const workingDirectory = workingDirectoryOf(pid);
  return [...held, ...runnerHosts(nodeCommandLineOf(commandLine, workingDirectory), workingDirectory)];
}

/** The paths whose checkouts a runner tests: its working directory and each test file it runs. */
function runnerHosts(command: NodeCommandLine, workingDirectory: string | undefined): readonly string[] {
  const files = testFilesRun(command);
  if (files === undefined) return [];
  return [workingDirectory, ...files.map((file) => hostPath(file, workingDirectory))]
    .filter((host): host is string => host !== undefined && entryStats(host) !== undefined);
}

/** The ancestors' tested roots; warns once, loudly, when procfs cannot answer. */
function ancestryRoots(): readonly string[] {
  if (!procfsAvailable()) {
    if (!procfsWarned) {
      procfsWarned = true;
      warnLoudly(PROCFS_UNAVAILABLE_WARNING_CODE, "procfs is unavailable: the checkout write door cannot see a test runner among this process's ancestors (only its own command line and the inherited marker)", {
        procfsRoot: ROOT_POLICY.filesystemInfrastructure.procfsRoot, platform: process.platform,
      });
    }
    return [];
  }
  return ancestorsOf(process.pid).flatMap(ancestorRoots);
}

/** Decides, once, what this process is under test for (module load: the ancestry is intact now). */
function armFromFacts(): void {
  const ownCommandLine: NodeCommandLine = { options: process.execArgv, script: process.argv[1], scriptArguments: process.argv.slice(2) };
  // THIS process's own held markers too: a worker thread started with an
  // empty environment (`new Worker(…, { env: {} })`) shares its process's
  // descriptors but not its marker variable, and the ancestry excludes the
  // process itself (wf1c-correctness §1 N3).
  const roots = [...inheritedMarker(), ...runnerHosts(ownCommandLine, process.cwd()), ...heldMarkerRoots(process.pid), ...ancestryRoots()];
  for (const root of roots) {
    const identity = checkoutOf(root);
    if (identity !== undefined) arm(identity);
  }
}

armFromFacts();

/** The checkouts this process may not write (those it or an ancestor tests). */
export function protectedCheckoutsOfThisProcess(): readonly CheckoutIdentity[] {
  return [...armed.values()];
}

/**
 * THE ONE "IS THIS PROCESS UNDER TEST" ANSWER, decided at load from the same
 * facts as the protected checkouts (a marker it cannot read counts: it
 * descends from a test run). The outbound door asks it: a process under test
 * dials nothing but this machine (`src/shared/outbound-http.ts`).
 */
export function processUnderTest(): boolean {
  return armed.size > 0 || markerRefusal !== undefined;
}

/** The protected root among `canonical`'s ancestors, spelled as `canonical` spells it. */
function protectedRootHolding(canonical: string): string | undefined {
  for (let directory = canonical; ; directory = dirname(directory)) {
    if (entryStats(directory)?.isDirectory() === true && armed.has(identityAt(directory) ?? "")) return directory;
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * Whether `relativePath` lies in a writable state root of `root`: the
 * checkout's own (`<root>/.bridlewise/…`) or a package's
 * (`<root>/<package>/.bridlewise/…`, the package holding its own
 * `package.json`). A same-named folder anywhere deeper is not a state root:
 * a planted `engine/src/.bridlewise/x.ts` was writable and broke
 * `harness check` (wf1c-correctness §1 VT15).
 */
function inWritableDirectory(root: string, relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (POLICY.writableDirectoryNames as readonly string[]).some((name) =>
    (segments.length > 1 && segments[0] === name) ||
    (segments.length > 2 && segments[1] === name && entryStats(join(root, segments[0]!, "package.json"))?.isFile() === true));
}

/**
 * Refuses (throws `generator_live_checkout_under_test`) when this process is
 * under test and `path` is a file a protected checkout owns. A no-op otherwise.
 */
export function assertCheckoutWriteAllowed(path: string): void {
  if (markerRefusal !== undefined) {
    throw new SecurityError(
      `the ${POLICY.markerEnvironmentVariable} marker is not a JSON list of absolute checkout roots (${String(markerRefusal.length)} characters); ` +
      "this process descends from a test run whose checkout it cannot name, so every write is refused",
      CHECKOUT_MARKER_INVALID_CODE,
    );
  }
  if (armed.size === 0) return;
  const canonical = writeLocationOf(path);
  const root = protectedRootHolding(canonical);
  if (root === undefined) return;
  const relativePath = relative(root, canonical).split(sep).join("/");
  if (relativePath.length === 0 || inWritableDirectory(root, relativePath)) return;
  debugLog("filesystem.checkout-write-door", "warn", "checkout write refused under test", () => ({ path: relativePath, checkout: root, pid: process.pid }));
  throw new SecurityError(
    `a test process tried to write ${relativePath}, a file the checkout under test (${root}) owns; ` +
    "drive write-mode generators on a working copy (createRepositoryWorkingCopy), never on the checkout a test runs in",
    CHECKOUT_WRITE_REFUSAL_CODE,
  );
}
