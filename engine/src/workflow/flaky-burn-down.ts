/**
 * THE FLAKY MEMORY'S BURN-DOWN LIST — the guard catalog's moving-forward rule
 * (UR-19; coordinator, LAND-OC-FIX round 11) for the flaky-test memory.
 *
 * A suspect the verdict leaves red (src/shared/run-history.ts
 * `flakyVerdictWithin`: not explained by a recorded reproduction, a move or a
 * regeneration) is either an ENTRY of its suite's shrink-only burn-down list,
 * or a failure of the guard:
 *   - an entry names the suspect's ledger identity and its OWNER: an open task
 *     row of the tracker that names both the test's file and the guard's file;
 *   - an owned entry passes the guard, and is said in its output and in the
 *     burn-down line every run;
 *   - a red suspect no entry names is NEW, and fails;
 *   - an entry whose owner row is closed, or no longer names the test and the
 *     guard, fails (close the row only with its entry);
 *   - an entry can only be added by the commit that also adds its owner row
 *     (read from git: the first commit whose list holds the entry must add the
 *     owner's row line to the tracker), so the list cannot grow by itself;
 *   - nothing ages out: an entry stays until it is removed with its row (and
 *     its suspect's failing rows stay in the ledger or its never-trimmed
 *     suspect archive).
 *
 * One list per suite, engine-relative: `traceability/flaky-burn-down/<suite>.json`
 * (`ROOT_POLICY.workflow.flakyBurnDown`).
 */
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { declaredCauseFixes, ignoredCauseEvidenceMessage } from "../git/flake-cause-fixes.ts";
import { gitOutput, type GitRepository } from "../git/tree-reader.ts";
import { configuredGitRepository } from "../git/worktree-port.ts";
import { debugLog } from "../shared/debug/debug-system.ts";
import {
  failureIdentityFile,
  fixedSuspectsMessage,
  flakySuspectsMessage,
  flakyVerdictWithin,
  movedSuspectsMessage,
  regeneratedSuspectsMessage,
  type ArtifactRegeneration,
  type FlakySuspect,
  type FlakyVerdict,
  type RunFailureRows,
  type SuiteIdentities,
} from "../shared/run-history.ts";
import { ownersOf, taskRows } from "./failure-owners.ts";
import { loadPinnedConfigSnapshot } from "../kernel/config.ts";

export const FLAKY_BURN_DOWN_SCHEMA_VERSION = schemaId("flaky-burn-down", 1);

/** One entry: a red suspect's ledger identity and the open task row that owns it. */
export type BurnDownEntry = Readonly<{ identity: string; owner: string }>;

/** A suite's list. */
export type BurnDownList = Readonly<{ schemaVersion: string; entries: readonly BurnDownEntry[] }>;

/** The list's path, engine-relative. */
export function flakyBurnDownPath(suite: "engine" | "web"): string {
  return join(ROOT_POLICY.workflow.flakyBurnDown.directory, `${suite}.json`);
}

/** Reads a suite's list: required (an absent or malformed list is refused, never read as empty). */
function readFlakyBurnDown(engineRoot: string, suite: "engine" | "web"): BurnDownList {
  const path = join(engineRoot, flakyBurnDownPath(suite));
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BurnDownList>;
  const entries = parsed.entries;
  if (parsed.schemaVersion !== FLAKY_BURN_DOWN_SCHEMA_VERSION || !Array.isArray(entries)
    || !entries.every((entry) => typeof entry?.identity === "string" && entry.identity.length > 0 && typeof entry.owner === "string" && entry.owner.length > 0)) {
    throw new InputError(`${path} is not a flaky burn-down list (${FLAKY_BURN_DOWN_SCHEMA_VERSION}: entries of identity and owner)`, "flaky_burn_down_invalid");
  }
  if (new Set(entries.map((entry) => entry.identity)).size !== entries.length) throw new InputError(`${path} names a suspect twice`, "flaky_burn_down_invalid");
  return deepFreeze(parsed as BurnDownList);
}

/** What the guard reads: each red suspect owned or new, every owned entry, and every problem of an entry. */
export type BurnDownJudgement = Readonly<{
  /** Red suspects no entry names: the guard fails. */
  newSuspects: readonly FlakySuspect[];
  /** Every entry whose owner is in order, red now or not (said every run). */
  owned: readonly Readonly<BurnDownEntry & { red: boolean }>[];
  /** Entries out of order (a closed owner, an owner naming other things, an entry added without its row): the guard fails. */
  problems: readonly string[];
}>;

/**
 * Whether the commit that first held `entry` in the list WITH ITS OWNER also
 * added that owner's row (a NEW open row head, `- [ ] **<owner>**`, that the
 * same diff does not remove: an edited existing row head or a line merely
 * citing the id is no added row, F-L6) to the tracker: the list's history,
 * read from git (`listPath` and `trackerPath` repository-relative). Keyed by
 * the identity AND its owner, so an entry is re-owned only by a commit that
 * adds the new owner's row (a closing owner no longer
 * traps its entries).
 */
export function entryAddedWithOwner(repository: GitRepository, listPath: string, trackerPath: string, entry: BurnDownEntry): boolean {
  // The first commit whose list, PARSED, holds the entry with this owner: a text search would miss a list that spells a
  // character as a JSON escape (`\u2014` for an em dash) and judge an entry added with its row as added without it.
  const commits = gitOutput(repository, ["log", "--reverse", "--format=%H", "--", listPath]).stdout.toString("utf8").split("\n").filter((line) => line.length > 0);
  const first = commits.find((commit) => listOwnersAt(repository, commit, listPath).get(entry.identity) === entry.owner);
  if (first === undefined) return false;
  const diff = gitOutput(repository, ["show", "--format=", "--unified=0", first, "--", trackerPath]).stdout.toString("utf8").split("\n");
  const head = `- [ ] **${entry.owner}**`;
  const removedHead = diff.some((line) => line.startsWith("-") && !line.startsWith("---") && /^-- \[[ x]\] \*\*/u.test(line) && line.includes(`**${entry.owner}**`));
  return !removedHead && diff.some((line) => line.startsWith(`+${head}`));
}

/** The owner each identity has in a list at `commit` (none when it was absent or no list then), memoized per repository, commit and path. */
const listHistory = new Map<string, ReadonlyMap<string, string>>();
function listOwnersAt(repository: GitRepository, commit: string, listPath: string): ReadonlyMap<string, string> {
  const key = `${repository.root}\u0000${commit}\u0000${listPath}`;
  const known = listHistory.get(key);
  if (known !== undefined) return known;
  const found = gitOutput(repository, ["show", `${commit}:${listPath}`], { allowed: [0, 128] });
  let owners: ReadonlyMap<string, string> = new Map();
  if (found.status === 0) {
    try {
      const parsed = JSON.parse(found.stdout.toString("utf8")) as { entries?: unknown };
      if (Array.isArray(parsed.entries)) {
        owners = new Map(parsed.entries.flatMap((entry: unknown) => {
          const { identity, owner } = (entry ?? {}) as { identity?: unknown; owner?: unknown };
          return typeof identity === "string" && typeof owner === "string" ? [[identity, owner] as const] : [];
        }));
      }
    } catch (error) {
      // A list that did not parse at that commit held nothing the guard could read then: said, and judged as holding none.
      debugLog("workflow", "warn", "flaky_burn_down_history_unreadable", () => ({ commit, listPath, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  listHistory.set(key, owners);
  return owners;
}

/**
 * THE JUDGEMENT (see the header): `reds` are the verdict's red suspects,
 * `testPathOf` turns a ledger identity into its test's repository path, and
 * `addedWithOwner` answers the history question for an entry.
 */
export function judgeBurnDown(
  reds: readonly FlakySuspect[],
  list: BurnDownList,
  trackerText: string,
  guardPath: string,
  testPathOf: (identity: string) => string | null,
  addedWithOwner: (entry: BurnDownEntry) => boolean,
): BurnDownJudgement {
  const rows = taskRows(trackerText);
  const listed = new Map(list.entries.map((entry) => [entry.identity, entry]));
  const problems: string[] = [];
  const owned: (BurnDownEntry & { red: boolean })[] = [];
  const redIdentities = new Set(reds.map((suspect) => suspect.identity));
  for (const entry of list.entries) {
    const row = rows.find((candidate) => candidate.id === entry.owner);
    const testPath = testPathOf(entry.identity);
    if (row === undefined) problems.push(`${entry.identity}: its owner ${entry.owner} is no row of the tracker`);
    else if (row.done) problems.push(`${entry.identity}: its owner ${entry.owner} is closed while the entry remains (remove the entry with the row)`);
    else if (testPath === null || !ownersOf([row], testPath, guardPath).includes(row.id)) problems.push(`${entry.identity}: its owner ${entry.owner} does not name both ${testPath ?? "the test's file"} and ${guardPath}`);
    else if (!addedWithOwner(entry)) problems.push(`${entry.identity}: the entry was not added by the commit that added its owner row ${entry.owner}`);
    else owned.push({ ...entry, red: redIdentities.has(entry.identity) });
  }
  return deepFreeze({ newSuspects: reds.filter((suspect) => !listed.has(suspect.identity)), owned, problems });
}

/** The burn-down line a guard prints every run: how many entries remain, each with its owner. */
export function burnDownLine(judgement: BurnDownJudgement): string {
  return `[flaky-burn-down] ${String(judgement.owned.length)} owned entr${judgement.owned.length === 1 ? "y" : "ies"}${judgement.owned.length === 0 ? "" : `: ${judgement.owned.map((entry) => `${entry.identity} (owner ${entry.owner}${entry.red ? ", red now" : ""})`).join("; ")}`}`;
}

/** What one suite's flaky-memory guard is given: its ledger rows and the facts only the suite knows. */
export type FlakyMemoryInput = Readonly<{
  suite: "engine" | "web";
  /** The engine folder (the records, the lists and the config live under it). */
  engineRoot: string;
  /** The suite's ledger rows, oldest first. */
  entries: readonly RunFailureRows[];
  /** The guard's own ledger identities (its prefix): its own rows never indict it. */
  ownPrefix: string;
  /** The guard's own file, as its suite's ledger spells files (an owner row names its repository path beside the test). */
  guardFile: string;
  /** The artifact regenerations the suite proves (web: the profile report's own stamp). */
  regenerated: readonly ArtifactRegeneration[];
  /** The hermetic and live suites now (engine), or null (web: no live suite). */
  suites: SuiteIdentities | null;
}>;

/** The guard's judgement: the verdict, the burn-down, every line it says, and why it fails (null: it passes). */
export type FlakyMemoryJudgement = Readonly<{ verdict: FlakyVerdict; burnDown: BurnDownJudgement; lines: readonly string[]; failure: string | null }>;

/**
 * THE FLAKY MEMORY'S ONE JUDGEMENT, for both suites' LIVE guards (design F11:
 * one assembly, never two copies): the declared and reproduced fixes and the
 * moves (src/git/flake-cause-fixes.ts), the verdict over the WHOLE retained
 * ledger and its suspect archive (src/shared/run-history.ts; nothing ages out: a red
 * suspect stays red until it is explained or owned, design NH-E), and the
 * burn-down list. Every line is said through the one logger and returned;
 * `failure` names the problems and the new suspects.
 */
export async function judgeFlakyMemory(input: FlakyMemoryInput): Promise<FlakyMemoryJudgement> {
  const repository = configuredGitRepository({}, input.engineRoot);
  const top = gitOutput(repository, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").trim();
  const topRepository = configuredGitRepository({}, top);
  const engineRelative = relative(top, input.engineRoot).split(sep).join("/");
  // The reproduction bar is this process's own config (the pinned snapshot), whatever tree is judged.
  const flakeReproduction = loadPinnedConfigSnapshot().document.testExecution?.flakeReproduction;
  if (flakeReproduction === undefined) throw new InputError("testExecution.flakeReproduction is not declared: no reproduction can be judged", "flake_reproduction_config_missing");
  // The engine ledger's files are relative to the engine; the web ledger's are repository paths already.
  const testPathOf = (file: string): string => input.suite === "engine" ? `${engineRelative}/${file}` : file;
  const causes = await declaredCauseFixes(topRepository, testPathOf, input.engineRoot, { flakeReproduction, suites: input.suites });
  const verdict = flakyVerdictWithin(input.entries, Math.max(2, input.entries.length), input.ownPrefix, input.regenerated, causes);
  if (verdict === null) throw new InputError("the flaky verdict refused its window", "flaky_memory_unjudged");
  const trackerPath = ROOT_POLICY.workflow.failureOwners.tracker;
  const burnDown = judgeBurnDown(verdict.reds, readFlakyBurnDown(input.engineRoot, input.suite), readFileSync(join(top, trackerPath), "utf8"), testPathOf(input.guardFile),
    (identity) => { const file = failureIdentityFile(identity); return file === null ? null : testPathOf(file); },
    (entry) => entryAddedWithOwner(topRepository, `${engineRelative}/${flakyBurnDownPath(input.suite)}`, trackerPath, entry));
  const lines = [
    ignoredCauseEvidenceMessage(causes),
    verdict.regenerated.length > 0 ? regeneratedSuspectsMessage(verdict.regenerated) : "",
    verdict.fixed.length > 0 ? fixedSuspectsMessage(verdict.fixed) : "",
    verdict.moved.length > 0 ? movedSuspectsMessage(verdict.moved) : "",
    burnDownLine(burnDown),
  ].filter((line) => line.length > 0);
  for (const line of lines) debugLog("workflow", line === lines.at(-1) ? "info" : "warn", line, () => ({ suite: input.suite }));
  const failure = [
    ...burnDown.problems,
    ...(burnDown.newSuspects.length === 0 ? [] : [flakySuspectsMessage(burnDown.newSuspects, input.entries.length, input.entries)]),
  ].join("\n");
  return deepFreeze({ verdict, burnDown, lines, failure: failure.length === 0 ? null : failure });
}
