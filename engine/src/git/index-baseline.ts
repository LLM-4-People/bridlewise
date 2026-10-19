/**
 * THE LIVE INDEX'S BASELINE — a staged blob that exists nowhere else is
 * never lost silently, and is restored exactly.
 *
 * A dirty checkout's INDEX can hold work that exists nowhere else: in this
 * repository, three inherited staged files whose staged blobs are in no
 * commit. Two slips in one day changed it without anyone noticing at once (a
 * `git rm --cached` meant as "delete the file", then a proposed repair,
 * `git restore --staged`, that resets an entry to HEAD and so drops the
 * staged blob's only reference). The hazard is exactly that class: **a staged
 * blob that exists nowhere else is lost.** So only those entries are
 * recorded — never the whole index, which every ordinary `git add` or commit
 * changes (a whole-index record was red after every legitimate commit, and a
 * tool that cries wolf trains the reflex that blesses the next real slip):
 *
 * - PROTECTED: a stage-0 entry whose (mode, object) differs from HEAD's for
 *   that path, or that HEAD does not hold — `git diff --cached --raw`'s own
 *   answer — minus intent-to-add entries (`git add -N` carries no blob) and
 *   staged deletions. Unmerged stages (1-3) are not protected: their blobs
 *   live in the merge's commits.
 * - {@link recordIndexBaseline} writes them, with HEAD's version of each path
 *   at that moment, to the checkout's private state
 *   (`ROOT_POLICY.verification.liveIndexBaseline.path`), and PINS their blobs
 *   with a ref (`…liveIndexBaseline.pinRefNamespace`/<digest of its git dir>) to a tree of
 *   them, so `git gc` never prunes a blob only the index held.
 * - {@link indexBaselineDrift}: a recorded entry is HELD while the index
 *   still stages it (a real entry, not intent-to-add); SUPERSEDED once a
 *   commit changed its path (HEAD's version differs from the recorded one —
 *   committing the entry itself is the commonest case); otherwise LOST, and
 *   only a lost entry is drift. A stray `git add` is not drift (nothing is
 *   lost), nor is any commit.
 * - {@link checkIndexBaseline} (every candidate tool run, `harness check`):
 *   when HEAD moved and nothing is lost, the record ADVANCES by itself
 *   (superseded entries leave it, newly staged at-risk entries join it), so no
 *   ordinary commit ever asks anyone to re-record. A READ never writes:
 *   `harness index status`, the `workspaceGit.liveIndexState` signal and the
 *   commit guard use {@link indexBaselineDrift}, which reports `headMoved`
 *   and leaves the advance to the next writer (step6-readiness F-6: a status
 *   query rewrote the record and its pin).
 * - {@link repairIndexToBaseline} (`harness index repair`) re-stages ONLY the
 *   lost entries, from the record, in one `git update-index -z --index-info`
 *   (paths travel raw). It never removes an entry, and it can never stage the
 *   reversal of a commit: an entry whose path a commit changed is superseded,
 *   never lost. It refuses when a blob to restore is missing from the store
 *   (`index_baseline_objects_missing`), before touching the index.
 *
 * The record's digest is a self-consistency check against a torn or garbled
 * file, not a MAC: an edit that recomputes it is accepted. `git restore
 * --staged`, `git reset` and `git rm --cached` of a protected path are the
 * slips it catches; the process rule (never use them on this checkout's
 * index) lives in the process documentation (docs/process/WORKFLOW.md).
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { ensurePrivateStateDirectory, ownedTemporaryName, sweepAbandonedTemporaries } from "../filesystem/private-state.ts";
import { HarnessError } from "../kernel/errors.ts";
import { sha256 } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { readCheckoutStateRecord, writeCheckoutStateRecord } from "./checkout-state-record.ts";
import { indexEntries, intentToAddPaths } from "./index-entries.ts";
import { GIT_OBJECT_NAME } from "./git-port.ts";
import { directoryGitEnvironment, gitNulRecords, headCommit, headVersions, repositoryToplevel, requiredRepositoryToplevel } from "./repository-ownership.ts";

const BASELINE_SCHEMA_VERSION = schemaId("live-index-baseline", 2);
const OBJECT_ID = z.string().regex(GIT_OBJECT_NAME);
const MODE = z.string().regex(/^[0-7]{6}$/u);
const VERSION_SCHEMA = z.strictObject({ mode: MODE, objectId: OBJECT_ID });

const ENTRY_SCHEMA = z.strictObject({
  path: z.string().min(1),
  mode: MODE,
  objectId: OBJECT_ID,
  /** HEAD's version of the path when recorded; `null` when HEAD did not hold it. */
  head: VERSION_SCHEMA.nullable(),
});

const BASELINE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
  /** The commit HEAD named when recorded (`null`: an unborn branch). */
  head: OBJECT_ID.nullable(),
  /** The tree pinning every protected blob (`null`: nothing protected). */
  pin: OBJECT_ID.nullable(),
  entriesDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(ENTRY_SCHEMA),
});

/** One protected entry: a staged blob HEAD does not hold at that path. */
export type ProtectedEntry = z.infer<typeof ENTRY_SCHEMA>;
type Baseline = z.infer<typeof BASELINE_SCHEMA>;

/** The one repair, as data: the engine CLI verb that restores every lost entry. */
const INDEX_REPAIR_VERB = Object.freeze(["harness", "index", "repair"] as const);
/** The one deliberate re-record, as data. */
export const INDEX_RECORD_VERB = Object.freeze(["harness", "index", "record"] as const);

/** What {@link indexBaselineDrift} found. */
export type IndexBaselineState =
  | Readonly<{ state: "unrecorded"; baselinePath: string }>
  | Readonly<{ state: "clean"; baselinePath: string; protected: number; superseded: readonly string[]; headMoved: boolean }>
  | Readonly<{
      state: "drifted";
      baselinePath: string;
      protected: number;
      /** Recorded entries the index no longer stages, whose path no commit changed since. */
      lost: readonly string[];
      superseded: readonly string[];
      headMoved: boolean;
      /** The one repair (an engine CLI verb, run from the engine folder). */
      repair: readonly string[];
    }>;

function topLevel(root: string): string {
  return requiredRepositoryToplevel(root, "index_baseline_not_a_repository", "directory");
}

/** The recorded baseline's location in the checkout whose top level is `top`. */
export function indexBaselinePath(top: string): string {
  return join(top, ROOT_POLICY.verification.liveIndexBaseline.path);
}

function git(top: string, argv: readonly string[], options: Readonly<{ input?: string; environment?: Readonly<Record<string, string>> }> = {}): string {
  return execFileSync("git", ["-c", "gc.auto=0", ...argv], {
    cwd: top, encoding: "utf8", maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
    env: { ...directoryGitEnvironment(), ...(options.environment ?? {}) },
    ...(options.input === undefined ? {} : { input: options.input }),
  }).trim();
}

/** The at-risk entries of the checkout's REAL index (see the header). */
function protectedEntries(top: string): readonly ProtectedEntry[] {
  // `:<old mode> <new mode> <old> <new> <status>\0<path>\0` — old = HEAD, new = the index.
  const fields = gitNulRecords(top, ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"], "directory");
  const intents = new Set(intentToAddPaths(top, "directory"));
  const entries: ProtectedEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, oldObject, newObject, status] = fields[index]!.replace(/^:/u, "").split(" ");
    const path = fields[index + 1]!;
    if (status === "U" || newMode === "000000" || intents.has(path)) continue;
    entries.push({ path, mode: newMode!, objectId: newObject!, head: oldMode === "000000" ? null : { mode: oldMode!, objectId: oldObject! } });
  }
  return entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function indexInfo(entries: readonly ProtectedEntry[]): string {
  return entries.map((entry) => `${entry.mode} ${entry.objectId} 0\t${entry.path}\0`).join("");
}

function pinRef(top: string): string {
  const gitDirectory = git(top, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  return `${ROOT_POLICY.verification.liveIndexBaseline.pinRefNamespace}/${sha256(gitDirectory)}`;
}

/** Pins every protected blob with one ref to a tree of them (a private index builds it; the real index is untouched). */
function pinEntries(top: string, entries: readonly ProtectedEntry[]): string | null {
  const ref = pinRef(top);
  if (entries.length === 0) {
    git(top, ["update-ref", "-d", ref]);
    return null;
  }
  const directory = ensurePrivateStateDirectory(dirname(indexBaselinePath(top)));
  sweepAbandonedTemporaries(directory, PIN_INDEX_PREFIX);
  const privateIndex = join(directory, ownedTemporaryName(PIN_INDEX_PREFIX));
  try {
    const environment = { GIT_INDEX_FILE: privateIndex };
    git(top, ["update-index", "-z", "--index-info"], { input: indexInfo(entries), environment });
    const tree = git(top, ["write-tree"], { environment });
    git(top, ["update-ref", "-m", "live index baseline pin", ref, tree]);
    return tree;
  } finally {
    rmSync(privateIndex, { force: true });
  }
}

const PIN_INDEX_PREFIX = "index-baseline-pin-";

/** Records the at-risk entries of the live index as the checkout's baseline and pins their blobs. */
export function recordIndexBaseline(root: string): Readonly<{ baselinePath: string; protected: number; pin: string | null }> {
  const top = topLevel(root);
  const entries = protectedEntries(top);
  const pin = pinEntries(top, entries);
  const baselinePath = indexBaselinePath(top);
  writeCheckoutStateRecord<Baseline>(baselinePath, { schemaVersion: BASELINE_SCHEMA_VERSION, head: headCommit(top, "directory"), pin, entries: [...entries] }, "index_baseline_unwritable");
  return { baselinePath, protected: entries.length, pin };
}

/** The recorded baseline, or `null` when none is recorded (a torn or garbled one is a typed refusal). */
function readBaseline(baselinePath: string): Baseline | null {
  return readCheckoutStateRecord(baselinePath, BASELINE_SCHEMA, (reason) => new HarnessError(
    `the index baseline at ${baselinePath} cannot be read (${reason}; schema ${BASELINE_SCHEMA_VERSION}); check the index by hand, then record it again (${INDEX_RECORD_VERB.join(" ")})`,
    "index_baseline_unreadable",
  ));
}

const sameVersion = (a: z.infer<typeof VERSION_SCHEMA> | null | undefined, b: z.infer<typeof VERSION_SCHEMA> | null | undefined): boolean =>
  (a ?? null) === null ? (b ?? null) === null : b !== null && b !== undefined && a!.mode === b.mode && a!.objectId === b.objectId;

type Classified = Readonly<{ baseline: Baseline; held: readonly ProtectedEntry[]; superseded: readonly ProtectedEntry[]; lost: readonly ProtectedEntry[]; headMoved: boolean }>;

function classify(top: string, baseline: Baseline): Classified {
  const intents = new Set(intentToAddPaths(top, "directory"));
  const live = new Map(indexEntries(top, "directory").filter((entry) => entry.stage === 0 && !intents.has(entry.path)).map((entry) => [entry.path, entry]));
  const heads = headVersions(top, baseline.entries.map((entry) => entry.path), "directory");
  const held: ProtectedEntry[] = [];
  const superseded: ProtectedEntry[] = [];
  const lost: ProtectedEntry[] = [];
  for (const entry of baseline.entries) {
    const now = live.get(entry.path);
    if (now !== undefined && now.mode === entry.mode && now.objectId === entry.objectId) held.push(entry);
    else if (!sameVersion(entry.head, heads.get(entry.path))) superseded.push(entry);
    else lost.push(entry);
  }
  return { baseline, held, superseded, lost, headMoved: headCommit(top, "directory") !== baseline.head };
}

/** Compares the live index with the recorded baseline (see the header). Never writes. */
export function indexBaselineDrift(root: string): IndexBaselineState {
  const top = topLevel(root);
  const baselinePath = indexBaselinePath(top);
  const recorded = readBaseline(baselinePath);
  if (recorded === null) return { state: "unrecorded", baselinePath };
  const { baseline, superseded, lost, headMoved } = classify(top, recorded);
  const common = { baselinePath, protected: baseline.entries.length, superseded: superseded.map((entry) => entry.path), headMoved };
  return lost.length === 0
    ? { state: "clean", ...common }
    : { state: "drifted", ...common, lost: lost.map((entry) => entry.path), repair: INDEX_REPAIR_VERB };
}

/**
 * {@link indexBaselineDrift}, and when HEAD moved with nothing lost, the
 * record ADVANCES to the index as it is now (see the header). The answer
 * describes the index after any advance.
 */
export function checkIndexBaseline(root: string): IndexBaselineState & Readonly<{ advanced?: true }> {
  const state = indexBaselineDrift(root);
  if (state.state !== "clean" || !state.headMoved) return state;
  recordIndexBaseline(root);
  return { ...indexBaselineDrift(root), advanced: true };
}

/** The refusal every tool raises on a drifted index (one wording). */
export function assertIndexAtBaseline(root: string): void {
  const drift = checkIndexBaseline(root);
  if (drift.state !== "drifted") return;
  throw new HarnessError(
    `staged blobs recorded in the live index baseline (${drift.baselinePath}) are no longer staged, and no commit took their place: ` +
      `${JSON.stringify(drift.lost)}. Restore them exactly with \`${drift.repair.join(" ")}\` (engine CLI); if dropping them was deliberate, ` +
      `record the index as it is with \`${INDEX_RECORD_VERB.join(" ")}\`. A reset of an entry to HEAD (git restore --staged, git reset, git rm --cached) ` +
      "drops a staged blob that exists nowhere else.",
    "live_index_drifted",
  );
}

/**
 * Re-stages every LOST entry exactly, from the record, in ONE
 * `update-index -z --index-info`; refuses (index untouched) when a blob to
 * restore is missing from the store. Returns what it restored.
 */
export function repairIndexToBaseline(root: string): Readonly<{ restored: readonly string[] }> {
  const top = topLevel(root);
  const baselinePath = indexBaselinePath(top);
  const recorded = readBaseline(baselinePath);
  if (recorded === null) throw new HarnessError(`no index baseline is recorded at ${baselinePath}`, "index_baseline_unrecorded");
  const { lost } = classify(top, recorded);
  if (lost.length === 0) return { restored: [] };
  const checked = git(top, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${lost.map((entry) => entry.objectId).join("\n")}\n` }).split("\n");
  const missing = lost.filter((entry, position) => checked[position] !== `${entry.objectId} blob`);
  if (missing.length > 0) {
    throw new HarnessError(
      `the index cannot be repaired: the object store no longer holds the recorded blob of ${JSON.stringify(missing.map((entry) => entry.path))} ` +
        "(its pin ref was removed and git gc pruned it); the index was left as it is",
      "index_baseline_objects_missing",
    );
  }
  git(top, ["update-index", "-z", "--index-info"], { input: indexInfo(lost) });
  const after = indexBaselineDrift(top);
  if (after.state !== "clean") throw new HarnessError(`the index still differs from its baseline after the repair: ${JSON.stringify(after)}`, "index_baseline_repair_failed");
  return { restored: lost.map((entry) => entry.path) };
}

/** One line for the checkout's baseline state (the `workspaceGit.liveIndexState` signal's words). Never writes. */
export function indexBaselineSummary(root: string): string {
  if (repositoryToplevel(root, "directory") === undefined) return "not a git checkout";
  const state = indexBaselineDrift(root);
  if (state.state === "unrecorded") return "unrecorded";
  if (state.state === "clean") return `clean: ${String(state.protected)} protected staged blob(s)`;
  return `drifted: lost ${state.lost.join(", ")}`;
}
