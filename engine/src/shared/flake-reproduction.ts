/**
 * THE EVIDENCE A FLAKY SUSPECT IS EXPLAINED BY — a recorded reproduction of
 * its cause, or a recorded move of its test to the live suite (the
 * FLAKE-REPRO decision; src/shared/run-history.ts `flakyVerdictWithin`).
 *
 * A REPRODUCTION backs a `Flake-cause:` declaration ("commit F fixed the
 * cause of test T; the cause lives at these paths"). It records the runs
 * that prove it, the fix's parent's and the fix's, all under ONE stated set
 * of conditions (environment entries, a setup command, a command run
 * alongside — the hog or the churner —, a preload module of this repository
 * and the runner's order seed):
 *
 * - DETERMINISTIC: on the parent T failed EVERY run with a digest (the one
 *   digest both suites' ledgers keep, `failureDigest`); on the fix it passed
 *   every run.
 * - STATISTICAL, for a cause that needs load or a race: N runs on each side,
 *   N at least the configured `testExecution.flakeReproduction.statisticalRuns`,
 *   with a command alongside. On the parent T failed at least once (each
 *   digest with how often it was seen); on the fix it passed all N times.
 *   The host's one-minute load after each run is recorded.
 *
 * EITHER WAY THE COUNTS MUST BE STRONG (design NH-C, correctness F-N3): the
 * one-sided Fisher probability that a fix which changed NOTHING shows them
 * ({@link noOpFixProbability}) is at most the configured
 * `testExecution.flakeReproduction.significance` (α). One run per side is
 * strong only for a deterministic SHIM (a preloaded module that makes the
 * failure happen every time); any other record needs the runs the observed
 * failure rate demands ({@link runsNeeded}).
 *
 * EVERY ATTEMPT IS KEPT, the refused ones too: one file per attempt in
 * `attempts/` beside the records, NAMED BY THE SHA256 OF ITS BYTES, each
 * naming the run outputs it kept in the evidence store by digest. A record
 * counts only when an attempt recorded exactly its bytes
 * ({@link readFlakeReproductions}): a record no attempt wrote, or one edited
 * after, explains nothing. Each attempt is checked on its own (its name is its
 * hash, its bytes are the one serializer's): a damaged or renamed attempt is
 * refused ALONE, and two branches' attempts are two files, so a merge is their
 * union and can never break the store.
 * WHAT IT PROVES, exactly: the bytes of a record are the bytes an attempt
 * file names, and an attempt file was not edited after it was named. It is
 * NOT signed: a same-user process can write a well-formed attempt and record
 * on purpose (the lock token's limit), and removing a committed attempt is
 * seen only by git.
 *
 * The verdict then explains a ledger failure only when that failure measured
 * F's parent's bytes at the paths AND failed with a digest the parent's runs
 * saw — so a failure for another reason, on the same bytes, stays red.
 *
 * A MOVE says a test left the hermetic suite for the live suite in commit M:
 * the hermetic identity on M's parent, the live identity it became. The
 * verdict clears a suspect by a move only while the hermetic identity is
 * absent from the hermetic suite and the live identity is present in the
 * live suite's manifest. A test that merely vanished has no move, and stays
 * red.
 *
 * WRITTEN BY ONE DOOR, `harness flake` (src/workflow/flake-cli.ts), which ran
 * the trees or read the inventories: one canonical JSON file per (test, fix)
 * or per moved identity, under `ROOT_POLICY.workflow.flakeReproductions.directory`
 * (engine-relative), named by its key. Nobody writes one by hand; a record
 * the schema refuses is reported and explains nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { z } from "zod";

import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { USER_FOLDER_BOOT_VARIABLES } from "../filesystem/user-folders.ts";

export const FLAKE_REPRODUCTION_SCHEMA_VERSION = schemaId("flake-reproduction", 3);
/** The records the door wrote before it kept its attempt log: read, said, and never used. */
const UNLOGGED_REPRODUCTION_SCHEMA_VERSION = schemaId("flake-reproduction", 2);
export const FLAKE_ATTEMPT_SCHEMA_VERSION = schemaId("flake-attempt", 2);
/** An attempt's id: 32 hex characters. */
const ATTEMPT_ID = z.string().regex(/^[0-9a-f]{32}$/u);
export const IDENTITY_MOVE_SCHEMA_VERSION = schemaId("identity-move", 1);

const COMMIT = z.string().regex(/^[0-9a-f]{40}$/u);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/u);
const FAILURE_DIGEST = z.string().regex(/^[0-9a-f]{16}$/u);
const REPOSITORY_PATH = z.string().min(1).refine((path) => !path.startsWith("/") && path.split("/").every((segment) => segment !== "" && segment !== ".."), "a repository-relative path");
const RUN_COUNT = z.number().int().min(0);
/** The host's one-minute load after each run; null only on a record made before the door measured it (a deterministic one). */
const LOADS = z.array(z.number().finite().min(0).nullable());

/** The variables the door sets for every run itself (the fresh world, the output folder, and the web runner's pinned preload). */
const DOOR_SET_VARIABLES: ReadonlySet<string> = new Set(["HOME", "TMPDIR", "FLAKE_REPRODUCTION_OUTPUT", "NODE_OPTIONS"]);

/**
 * A variable THE DOOR OWNS: one it sets for every run, any `GIT_*` (every
 * run gets a git environment of its own; `GIT_COMMON_DIR`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_CONFIG_*` would reach another repository's
 * objects or configuration), or any `XDG_*` (the base folders are the fresh
 * world's: `XDG_DATA_HOME` places the evidence store, `XDG_CONFIG_HOME` and
 * `XDG_STATE_HOME` the configuration and the state; the door scrubs them, so
 * each defaults under the world's HOME), or any variable that places a
 * per-user folder (`USER_FOLDER_BOOT_VARIABLES`, the one list: every private
 * home's own variable — `HARNESS_KEY_HOME`, `HARNESS_EVIDENCE_HOME` — and its
 * base, which take precedence over XDG and would lead the world back to the
 * real stores). Never a request's `--env`, never a record's condition
 * (security F-2, F-3): one predicate for both, and the one the door scrubs by.
 */
export function isDoorOwnedVariable(name: string): boolean {
  return DOOR_SET_VARIABLES.has(name) || name.startsWith("GIT_") || name.startsWith("XDG_") || USER_FOLDER_BOOT_VARIABLES.includes(name);
}

/** The one set of conditions every run of a reproduction ran under, the parent's and the fix's alike. */
const CONDITIONS_SCHEMA = z.strictObject({
  environment: z.record(z.string(), z.string()).refine((environment) => !Object.keys(environment).some(isDoorOwnedVariable), "names a variable the door owns (HOME, TMPDIR, its output folder, NODE_OPTIONS, any GIT_* or XDG_*, a per-user folder's place)"),
  /** A shell command run before the tests, in the test's own suite root. */
  setup: z.string().nullable(),
  /** A shell command run alongside the tests (the hog, the churner), stopped when they end. */
  during: z.string().nullable(),
  /** A module of THIS repository preloaded into every test file's process (`--import`), with the sha256 of its bytes. */
  preload: z.strictObject({ path: REPOSITORY_PATH, sha256: DIGEST }).nullable(),
  /** The runner's order seed; null is the declared order, never randomized. */
  seed: z.string().regex(/^[0-9]{1,10}$/u).nullable(),
  /** Only the named tests of their files ran (`--only-named`); else every test of the files. */
  onlyNamed: z.boolean().default(false),
});

export type ReproductionConditions = z.infer<typeof CONDITIONS_SCHEMA>;

const FLAKE_REPRODUCTION_SCHEMA = z.strictObject({
  schemaVersion: z.literal(FLAKE_REPRODUCTION_SCHEMA_VERSION),
  /** The ledger identity reproduced (`<file>::<test name>`, as its suite's ledger spells it). */
  identity: z.string().min(1),
  suite: z.enum(["engine", "web"]),
  /** The repository paths the failure depended on: the test's own file first, then the other causes. */
  paths: z.array(REPOSITORY_PATH).min(1),
  /** The causes the declaration names (the test's own file may be one): their change in the fix was semantic. */
  causes: z.array(REPOSITORY_PATH).min(1),
  /** The door's attempt that wrote this record (its line in the attempt log names this record's bytes). */
  attempt: ATTEMPT_ID,
  /** The fix commit and its parent, each with the sha256 of the content key of `paths` there. */
  fix: z.strictObject({ commit: COMMIT, contentDigest: DIGEST }),
  parent: z.strictObject({ commit: COMMIT, contentDigest: DIGEST }),
  conditions: CONDITIONS_SCHEMA,
  mode: z.enum(["deterministic", "statistical"]),
  /** How many times each side ran. */
  runs: z.number().int().min(1),
  /**
   * On the parent: each failure digest with how many runs failed so, where
   * each such failure happened (`failureLocation`; "" for one that named no
   * place), and how many runs passed.
   */
  parentRuns: z.strictObject({
    failed: z.record(FAILURE_DIGEST, z.number().int().min(1)),
    locations: z.record(FAILURE_DIGEST, z.array(z.union([FAILURE_DIGEST, z.literal("")])).min(1)),
    passed: RUN_COUNT,
    loads: LOADS,
  }),
  /** On the fix: how many runs passed (every one). */
  fixRuns: z.strictObject({ passed: RUN_COUNT, loads: LOADS }),
  recordedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "an ISO instant"),
}).superRefine((record, context) => {
  const failed = Object.values(record.parentRuns.failed).reduce((sum, count) => sum + count, 0);
  const problem = (message: string): void => { context.addIssue({ code: "custom", message }); };
  if (failed === 0) problem("the parent's runs show no failure: nothing was reproduced");
  if (failed + record.parentRuns.passed !== record.runs) problem("the parent's runs do not add up to `runs`");
  if (record.fixRuns.passed !== record.runs) problem("a fix run did not pass");
  if (record.parentRuns.loads.length !== record.runs || record.fixRuns.loads.length !== record.runs) problem("a run's load is not recorded");
  if (record.mode === "deterministic" && failed !== record.runs) problem("a deterministic reproduction failed on the parent every run");
  if (record.mode === "statistical" && record.conditions.during === null && record.conditions.preload === null) problem("a statistical reproduction runs under a condition: a command alongside (the hog or the churner) or a preloaded shim");
  if (record.mode === "statistical" && [...record.parentRuns.loads, ...record.fixRuns.loads].includes(null)) problem("a statistical reproduction records the load of every run");
  if (record.causes.some((cause) => !record.paths.includes(cause))) problem("every cause is among `paths`");
  if (Object.keys(record.parentRuns.locations).sort().join() !== Object.keys(record.parentRuns.failed).sort().join()) problem("every failure digest of the parent has its locations, and only those");
});

export type FlakeReproduction = z.infer<typeof FLAKE_REPRODUCTION_SCHEMA>;

const IDENTITY_MOVE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(IDENTITY_MOVE_SCHEMA_VERSION),
  suite: z.enum(["engine", "web"]),
  /** The hermetic identity on the move commit's parent. */
  from: z.string().min(1),
  /** The live identity it became (`<live file>::<test name>`). */
  to: z.string().min(1),
  /** The commit the test left the hermetic suite in. */
  commit: COMMIT,
  recordedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "an ISO instant"),
});

export type IdentityMove = z.infer<typeof IDENTITY_MOVE_SCHEMA>;

/** One attempt of the door, recorded or refused: what ran, what each run printed (kept in the evidence store, by digest), and what came of each test. */
const FLAKE_ATTEMPT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(FLAKE_ATTEMPT_SCHEMA_VERSION),
  attempt: ATTEMPT_ID,
  suite: z.enum(["engine", "web"]),
  fix: COMMIT,
  parent: COMMIT,
  conditions: CONDITIONS_SCHEMA,
  mode: z.enum(["deterministic", "statistical"]),
  runs: z.number().int().min(1),
  /** Every run's output, as the evidence store keeps it. */
  outputs: z.array(z.strictObject({ revision: z.enum(["parent", "fix"]), run: z.number().int().min(1), sha256: DIGEST })),
  /** Each test: the sha256 of the record written for it, or why it was refused. */
  outcomes: z.array(z.union([
    z.strictObject({ identity: z.string().min(1), recorded: DIGEST }),
    z.strictObject({ identity: z.string().min(1), refused: z.string().min(1) }),
  ])).min(1),
  recordedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "an ISO instant"),
});

export type FlakeAttempt = z.infer<typeof FLAKE_ATTEMPT_SCHEMA>;

/** The attempts' folder, beside the records. */
export function flakeAttemptDirectory(engineRoot: string): string {
  return join(flakeReproductionDirectory(engineRoot), ROOT_POLICY.workflow.flakeReproductions.attemptDirectory);
}

/** An attempt's bytes: the one canonical serializer, one trailing newline (a tracked text file ends with one, like a record). */
export function serializeFlakeAttempt(attempt: FlakeAttempt): string {
  return `${canonicalJson(FLAKE_ATTEMPT_SCHEMA.parse(attempt))}\n`;
}

/** An attempt's file name: the sha256 of its bytes. */
export function flakeAttemptFileName(bytes: string): string {
  return `${sha256(bytes)}.json`;
}

/**
 * Every attempt under `engineRoot`, each checked ON ITS OWN: its name is the
 * sha256 of its bytes, its bytes are the one serializer's, and no other
 * attempt claims its id. `attempts` (by time, then id) are the ones that
 * hold; `refused` names each that does not and why — it alone is ignored.
 * `looks` is every attempt the door wrote (its name the sha256 of its bytes),
 * those a later schema refuses included: a tightened schema never lowers a
 * claim's look count (every look counts, FLAKE-REPRO).
 */
export function readFlakeAttempts(engineRoot: string): Readonly<{ attempts: readonly FlakeAttempt[]; refused: readonly IgnoredFlakeReproduction[]; looks: readonly AttemptLook[] }> {
  const directory = flakeAttemptDirectory(engineRoot);
  if (!existsSync(directory)) return deepFreeze({ attempts: [], refused: [], looks: [] });
  const held: FlakeAttempt[] = [];
  const refused: IgnoredFlakeReproduction[] = [];
  const looks: AttemptLook[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const file = join(directory, name);
    const text = readFileSync(file, "utf8");
    if (name !== flakeAttemptFileName(text)) {
      refused.push({ file, why: "its name is not the sha256 of its bytes: edited or renamed after the door named it" });
      continue;
    }
    const look = ATTEMPT_LOOK_SCHEMA.safeParse(safeJson(text));
    if (look.success) looks.push({ fix: look.data.fix, identities: look.data.outcomes.map((outcome) => outcome.identity) });
    let parsed: FlakeAttempt;
    try {
      parsed = FLAKE_ATTEMPT_SCHEMA.parse(JSON.parse(text));
    } catch (error) {
      refused.push({ file, why: `not an attempt (${(error as Error).message.split("\n")[0]})` });
      continue;
    }
    if (serializeFlakeAttempt(parsed) !== text) {
      refused.push({ file, why: "not the one serializer's bytes" });
      continue;
    }
    held.push(parsed);
  }
  // An id two attempts claim proves neither.
  const claims = new Map<string, number>();
  for (const attempt of held) claims.set(attempt.attempt, (claims.get(attempt.attempt) ?? 0) + 1);
  const attempts = held.filter((attempt) => {
    if (claims.get(attempt.attempt) === 1) return true;
    refused.push({ file: join(directory, flakeAttemptFileName(serializeFlakeAttempt(attempt))), why: `another attempt claims its id ${attempt.attempt}` });
    return false;
  }).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.attempt.localeCompare(b.attempt));
  return deepFreeze({ attempts, refused, looks });
}

/** What every attempt the door wrote says about its claims, whatever the schema later decides: its fix, and the tests it ran. */
export type AttemptLook = Readonly<{ fix: string; identities: readonly string[] }>;
const ATTEMPT_LOOK_SCHEMA = z.object({ fix: z.string().min(1), outcomes: z.array(z.object({ identity: z.string().min(1) })) });

/** `text` parsed as JSON, or `undefined` when it is not JSON. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * THE NO-OP PROBABILITY: the one-sided Fisher exact probability that a fix
 * which changed nothing shows the counts — the parent failed `failed` of
 * `runs`, the fix none of `runs` — under the same failure rate on both sides:
 * C(runs, failed) / C(2·runs, failed).
 */
export function noOpFixProbability(failed: number, runs: number): number {
  let probability = 1;
  for (let index = 0; index < failed; index += 1) probability *= (runs - index) / (2 * runs - index);
  return probability;
}

/** The runs per side a failure rate needs so a no-op fix passes with probability at most `alpha` (Infinity when the rate is 0). */
export function runsNeeded(rate: number, alpha: number): number {
  if (!(rate > 0)) return Number.POSITIVE_INFINITY;
  for (let runs = 1; runs <= ROOT_POLICY.workflow.flakeReproductions.maximumRunsPerSide; runs += 1) {
    if (noOpFixProbability(Math.ceil(rate * runs - 1e-9), runs) <= alpha) return runs;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * WHETHER A RECORD'S COUNTS ARE STRONG ENOUGH TO EXPLAIN ANYTHING: one run
 * per side only for a deterministic shim (a preloaded module), otherwise a
 * no-op probability at most `alpha`; `why` not, with the runs the rate needs.
 */
export function reproductionStrength(record: Pick<FlakeReproduction, "mode" | "runs" | "parentRuns" | "conditions">, alpha: number, deterministicShims: readonly string[], looks = 1): Readonly<{ strong: true } | { why: string }> {
  const failed = Object.values(record.parentRuns.failed).reduce((sum, count) => sum + count, 0);
  if (record.runs === 1 && record.mode === "deterministic" && record.conditions.preload !== null && deterministicShims.includes(record.conditions.preload.path) && failed === 1) return { strong: true };
  // EVERY LOOK COUNTS: a (test, fix) attempted `looks` times — the refused attempts
  // included — is judged at α / looks, so re-attempting until one passes never inflates the error of the claim.
  const bar = alpha / Math.max(1, looks);
  const probability = noOpFixProbability(failed, record.runs);
  if (probability <= bar) return { strong: true };
  const needed = runsNeeded(failed / record.runs, bar);
  return { why: `a fix that changed nothing would show ${String(failed)} of ${String(record.runs)} parent failure(s) and none on the fix with probability ${probability.toPrecision(3)}, above α ${String(alpha)}${looks > 1 ? ` over ${String(looks)} attempts of this test and fix (${bar.toPrecision(3)})` : ""}${Number.isFinite(needed) ? `: at this failure rate ${String(needed)} runs per side are needed` : ""}${record.runs === 1 ? " (one run per side is strong only for a deterministic shim registered in testExecution.flakeReproduction.deterministicShims)" : ""}` };
}

/** How many attempts (recorded or refused, schema-refused included) a (test, fix) claim has had: every one is a look the claim's bar pays for. */
export function claimLooks(looks: readonly AttemptLook[], identity: string, fixCommit: string): number {
  return looks.filter((look) => look.fix === fixCommit && look.identities.includes(identity)).length;
}

/** A record with the number of attempts its claim had (see {@link claimLooks}). */
export type CountedFlakeReproduction = FlakeReproduction & Readonly<{ looks: number }>;

/** A record the schema refused: said, never used. */
export type IgnoredFlakeReproduction = Readonly<{ file: string; why: string }>;

/** The sha256 a record keeps of a content key (`ContentKeyAt`'s answer). */
export function contentKeyDigest(contentKey: string): string {
  return sha256(contentKey);
}

/** How many hex characters of the key's sha256 a record's file name keeps. */
const RECORD_NAME_HEX_DIGITS = 24;

/** A reproduction's file name: its key (test and fix), so one (test, fix) has one record. */
export function flakeReproductionFileName(identity: string, fixCommit: string): string {
  return `${sha256(`${identity}\u0000${fixCommit}`).slice(0, RECORD_NAME_HEX_DIGITS)}.json`;
}

/** A move's file name: its key (the hermetic identity), so one identity has one move. */
export function identityMoveFileName(from: string): string {
  return `move-${sha256(`move\u0000${from}`).slice(0, RECORD_NAME_HEX_DIGITS)}.json`;
}

/** The folder the records live in, under the engine root. */
export function flakeReproductionDirectory(engineRoot: string): string {
  return join(engineRoot, ...ROOT_POLICY.workflow.flakeReproductions.directory.split("/"));
}

/** A reproduction's bytes: the one canonical serializer, one trailing newline. */
export function serializeFlakeReproduction(record: FlakeReproduction): string {
  return `${canonicalJson(FLAKE_REPRODUCTION_SCHEMA.parse(record))}\n`;
}

/** A move's bytes: the one canonical serializer, one trailing newline. */
export function serializeIdentityMove(record: IdentityMove): string {
  return `${canonicalJson(IDENTITY_MOVE_SCHEMA.parse(record))}\n`;
}

/** The records under `engineRoot`: reproductions, moves, and every file the schemas refused (said by the reader's caller). */
export function readFlakeReproductions(engineRoot: string): Readonly<{
  records: readonly CountedFlakeReproduction[];
  moves: readonly IdentityMove[];
  ignored: readonly IgnoredFlakeReproduction[];
}> {
  const directory = flakeReproductionDirectory(engineRoot);
  if (!existsSync(directory)) return deepFreeze({ records: [], moves: [], ignored: [] });
  const records: CountedFlakeReproduction[] = [];
  const moves: IdentityMove[] = [];
  const ignored: IgnoredFlakeReproduction[] = [];
  const log = readFlakeAttempts(engineRoot);
  ignored.push(...log.refused);
  const logged = new Map<string, Set<string>>();
  for (const attempt of log.attempts) {
    for (const outcome of attempt.outcomes) if ("recorded" in outcome) logged.set(attempt.attempt, (logged.get(attempt.attempt) ?? new Set()).add(`${outcome.identity}\u0000${outcome.recorded}`));
  }
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const file = join(directory, name);
    let parsed: unknown;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
      parsed = JSON.parse(text);
    } catch (error) {
      ignored.push({ file, why: `not JSON: ${(error as Error).message}` });
      continue;
    }
    if ((parsed as { schemaVersion?: unknown } | null)?.schemaVersion === UNLOGGED_REPRODUCTION_SCHEMA_VERSION) {
      ignored.push({ file, why: "written before the door kept its attempt log: no attempt shows it (re-run harness flake reproduce)" });
      continue;
    }
    const isMove = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion === IDENTITY_MOVE_SCHEMA_VERSION;
    const result = isMove ? IDENTITY_MOVE_SCHEMA.safeParse(parsed) : FLAKE_REPRODUCTION_SCHEMA.safeParse(parsed);
    if (!result.success) {
      ignored.push({ file, why: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      continue;
    }
    const expected = isMove
      ? identityMoveFileName((result.data as IdentityMove).from)
      : flakeReproductionFileName((result.data as FlakeReproduction).identity, (result.data as FlakeReproduction).fix.commit);
    if (name !== expected) {
      ignored.push({ file, why: `named ${name}, but its key names ${expected}` });
      continue;
    }
    if (isMove) {
      moves.push(result.data as IdentityMove);
      continue;
    }
    const reproduction = result.data as FlakeReproduction;
    if (logged.get(reproduction.attempt)?.has(`${reproduction.identity}\u0000${sha256(text)}`) !== true) {
      ignored.push({ file, why: `no attempt the door kept recorded these bytes (attempt ${reproduction.attempt}): written or edited by hand` });
      continue;
    }
    records.push({ ...reproduction, looks: claimLooks(log.looks, reproduction.identity, reproduction.fix.commit) });
  }
  return deepFreeze({ records, moves, ignored });
}

/**
 * WHAT A RECORD SHOWS ON THE PARENT: the failure digests its runs saw, or
 * why it shows nothing — a statistical record of fewer runs than the
 * configured N (`statisticalRuns`), or counts a no-op fix would show with
 * probability above `significance` ({@link reproductionStrength}), show
 * nothing.
 */
export function reproducedDigests(record: CountedFlakeReproduction, statisticalRuns: number, significance: number, deterministicShims: readonly string[]): Readonly<{ digests: ReadonlySet<string>; locations: Readonly<Record<string, readonly string[]>> } | { why: string }> {
  if (record.mode === "statistical" && record.runs < statisticalRuns) {
    return { why: `a statistical reproduction of ${String(record.runs)} run(s), below the configured ${String(statisticalRuns)}` };
  }
  const strength = reproductionStrength(record, significance, deterministicShims, record.looks);
  if ("why" in strength) return strength;
  return { digests: new Set(Object.keys(record.parentRuns.failed)), locations: record.parentRuns.locations };
}

/**
 * A RECURSIVE REMOVAL OF AN UNCONFINED PLACE in a shell command — the one
 * detector the reproduction door (at its argument parse) and the whole-tree
 * guard (engine/test/prevention/no-unconfined-recursive-removal.test.ts) ask.
 * An `rm` with a recursive flag whose target is rooted at `$HOME`, `~`, or a
 * variable the same command did not create with `mktemp -d` (directly, or as
 * a path under such a variable) is unconfined: if the variable is not what
 * the author believed — an override that failed — it removes a real place.
 * `$HOME` is never confined, whatever the command assigns to it. Answers the
 * offending removal, or null.
 */
export function unconfinedRecursiveRemoval(command: string): string | null {
  const confined = new Set<string>();
  const variable = /^["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/u;
  // Where a relative target lands: the run's own folder until a `cd` leads elsewhere (`cd ~ && rm -rf .`).
  let relativeConfined = true;
  /** Whether `target` names a place the command made with `mktemp -d` (or under one), or the run's own folder when relative. */
  const isConfined = (target: string): boolean => {
    const bare = target.replace(/^["']/u, "");
    const root = variable.exec(target);
    if (bare.startsWith("~") || bare.startsWith("/")) return false;
    if (root !== null) return root[1] !== "HOME" && confined.has(root[1]!);
    return relativeConfined;
  };
  for (const segment of command.split(/&&|\|\||[;\n]/u).map((part) => part.trim())) {
    const assignment = /^(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(segment);
    if (assignment !== null) {
      const [, name, value] = assignment as unknown as [string, string, string];
      const root = variable.exec(value.trim());
      // A REASSIGNMENT DROPS what was confined (F7: `X=$(mktemp -d) || X="$HOME"; rm -rf "$X"`).
      if (name !== "HOME" && (/\bmktemp\s+(?:-[a-zA-Z]*d|--directory)/u.test(value) || (root !== null && confined.has(root[1]!)))) confined.add(name);
      else confined.delete(name);
      continue;
    }
    // A pipe into `xargs rm -r…` removes what it is fed, which no word of the command names: never confined.
    for (const stage of segment.split("|").map((part) => part.trim())) {
      const words = commandWords(stage);
      if (words[0] === "cd") {
        relativeConfined = words[1] === undefined ? false : isConfined(words[1]);
        continue;
      }
      if (words[0] === "xargs" && commandWords(words.slice(1).join(" "))[0] === "rm" && recursiveFlags(words.slice(1))) return segment;
      if (words[0] === "find" && words.includes("-delete")) {
        const start = words[1];
        if (start === undefined || start.startsWith("-") || !isConfined(start)) return segment;
        continue;
      }
      if (words[0] !== "rm" || !recursiveFlags(words.slice(1))) continue;
      const targets = words.slice(1).filter((word) => !word.startsWith("-"));
      if (targets.some((target) => !isConfined(target))) return segment;
    }
  }
  return null;
}

/** A command's words with its wrappers taken off (`sudo`, `command`, `exec`, `env` and its assignments, `nice`, `nohup`, a `trap` quote, a leading `\`, a path): the program first. */
function commandWords(stage: string): readonly string[] {
  const words = stage.split(/\s+/u).filter((word) => word.length > 0);
  for (;;) {
    const first = words[0]?.replace(/^["'\\]/u, "");
    if (first === undefined) return words;
    if (first === "sudo" || first === "command" || first === "exec" || first === "nohup" || first === "trap") { words.shift(); continue; }
    if (first === "env") { words.shift(); while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0])) words.shift(); continue; }
    if (first === "nice") { words.shift(); if (words[0] === "-n") words.splice(0, 2); else if (/^-\d+$/u.test(words[0] ?? "")) words.shift(); continue; }
    // The program's own name, its folder dropped (`/bin/rm` is `rm`).
    words[0] = posix.basename(first);
    return words;
  }
}

/** Whether `words` (a command's arguments) carry a recursive removal flag. */
function recursiveFlags(words: readonly string[]): boolean {
  return words.filter((word) => word.startsWith("-")).some((flag) => flag === "--recursive" || (/^-[a-zA-Z]+$/u.test(flag) && /[rR]/u.test(flag)));
}
