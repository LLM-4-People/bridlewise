/**
 * CUSTODY — git as verbs (DESIGN-COCKPIT-V2.md §7).
 *
 * The product speaks CUSTODY OF WORK, never git nouns: every changed file is
 * held by the run that produced it, and the verbs are `keep` (commit), `undo`
 * (restore), `see what changed` (diff). Three exposures:
 *
 *   - `custody.state` (read) — the current REAL `git status` joined against
 *     the ledger's file-effect events: each changed file → the producing
 *     run → its conversation (title + turn + the request's own words), or
 *     the honest "not from a recorded conversation" bucket. The join is
 *     EXACT string equality on the recorded absolute path (the editor
 *     bridge records absolute paths; git reports repo-relative — the repo
 *     root maps one onto the other, no globbing, no guessing).
 *
 *   - `custody.state/keep` (action) — a REAL `git add` + `git commit` of
 *     exactly the named files, through the git bridge's recording choke
 *     point (a mutating git invocation is recorded as a `git` effect with
 *     the acting user — nothing here re-implements that). Proof, not hope:
 *     the handler verifies the branch tip really moved and returns the new
 *     commit's own measured numbers.
 *
 *   - `custody.state/undo` (action) — `git checkout <tip> -- <files>`: the
 *     files return to their last saved state. What will be lost is MEASURED
 *     first (the real ±counts from the real diff) and returned, and the
 *     handler verifies the files are actually clean afterwards. New
 *     (never-saved) files are REFUSED: there is no earlier version to
 *     return to, and silently deleting a file is not "undo".
 *
 *   - `custody.history` (read) — recent commits × producing-conversation
 *     join: a commit is attributed to the conversation whose recorded
 *     file-effects overlap the commit's own files at or before the commit
 *     instant. Where the join is empty the commit says so honestly.
 *
 * OWNERSHIP: everything enters through `await db.getProject(projectId, userId)`
 * (null → 404, existence hidden) and the fs-gate the git bridges consume
 * (`assertProjectPathOwnership` at the bridge choke points). Run→conversation
 * resolution uses ONLY the caller's own chats in the named project; a
 * matching run the caller does not own is COUNTED, never itemised (the same
 * count-not-content rule synthesis.echoes applies).
 *
 * HONESTY: every number is measured (git's own numstat, the store's own
 * facts) or absent with its reason. The unattributed bucket is stated, never
 * papered over; the join's denominators (events examined, undecodable,
 * truncated) ride along on every read.
 */

import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { TimelineFileEffectFacts, TimelineFileEffectFactsFilter } from "../kernel/canonical.ts";
import { identityOverlapIndex, resolveLocation } from "../kernel/canonical.ts";
import { BadRequestError, NotFoundError } from "../kernel/errors.ts";
import { gitTextOrRefuse, isGitRepo } from "../intelligence/git-bridge.ts";
import { getGitStatus, getLog, type GitLogEntry } from "../intelligence/git-ops-bridge.ts";
import { assertProjectPathOwnership, makeFsGate, type FsGate } from "../filesystem/fs-gate.ts";
import { GIT_COMMIT_TIME_RESOLUTION_MS, serverConfig } from "../kernel/config.ts";
import { getTimelineStore } from "../observability/timeline-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { RouteContext } from "../router/router.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

// ── Ceilings ───────────────────────────────────────────────────────────────

/** Most changed files one keep/undo may name (and the join's path cap — the
 * store port itself caps a `paths` filter at 200). */
export const CUSTODY_MAX_FILES = 200;
/** Longest commit message accepted (bytes are the ledger's concern; this is
 * a UI sanity bound). */
export const CUSTODY_MAX_MESSAGE = 500;
/** Most commits custody.history examines per read. */
export const CUSTODY_HISTORY_DEFAULT = 20;
/** Cap on the request-text snippet carried per parcel. */
const REQUEST_TEXT_CAP = 200;

// ── Wire shapes ────────────────────────────────────────────────────────────

export type CustodyFile = Readonly<{
  /** Repo-relative path, exactly as git reports it. */
  path: string;
  /** Plain words: "changed" | "new" | "deleted" | "renamed" | git's raw word. */
  state: string;
  /** Real ±counts vs the last save (git's own numstat), or null with reason. */
  insertions: number | null;
  deletions: number | null;
  countsAbsentReason?: string;
  /** Wall time of the newest recorded file-effect for this path (attribution
   * evidence), absent for unattributed files. */
  lastRecordedTouch?: string;
}>;

export type ParcelAttribution =
  | Readonly<{
      kind: "conversation";
      runId: string;
      chatId: string;
      chatTitle: string;
      /** 1-based ordinal of the producing user turn, or null if the run has
       * no persisted user message. */
      turn: number | null;
      /** The producing turn's own words (capped), or null — the honest
       * absence when no user message carries this run. */
      requestText: string | null;
      /** Newest recorded touch across the parcel's files. */
      lastTouchedAt: string;
    }>
  | Readonly<{ kind: "outside"; reason: string }>;

export type Parcel = Readonly<{
  /** The producing run id, or "outside" for the unattributed bucket. */
  id: string;
  attribution: ParcelAttribution;
  files: readonly CustodyFile[];
  /** Sums over the files whose counts are measured. */
  insertions: number;
  deletions: number;
  derivation: string;
}>;

export type CustodyJoinStats = Readonly<{
  changedFiles: number;
  attributedFiles: number;
  /** Files the join could not send to the store (over the path cap). They
   * land in the outside bucket, counted here so the cap is visible. */
  filesBeyondPathCap: number;
  fileEffectEventsExamined: number;
  undecodableEffects: number;
  truncated: boolean;
  /** Matching runs owned by OTHER users — a count, never ids or titles. */
  withheldRuns: number;
}>;

export type CustodyState = Readonly<{
  repository: boolean;
  /** Present exactly when repository is false. */
  reason?: string;
  branch: string | null;
  parcels: readonly Parcel[];
  join: CustodyJoinStats;
}>;

export type SavedWork = Readonly<{
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  when: string;
  /** Measured from the commit's own numstat. */
  files: number;
  insertions: number;
  deletions: number;
  filePaths: readonly string[];
  conversation:
    | Readonly<{
        chatId: string;
        chatTitle: string;
        /** How many of the commit's files recorded effects attribute. */
        overlapFiles: number;
        matchedRecords: number;
      }>
    | null;
  derivation: string;
}>;

export type CustodyHistory = Readonly<{
  repository: boolean;
  reason?: string;
  commits: readonly SavedWork[];
  /** True when fetched remote branches exist (the "share" affordance's
   * honest gate). */
  remoteConfigured: boolean;
}>;

// ── The ledger capability this module needs (injectable in tests) ──────────

export type CustodyPort = Readonly<{
  fileEffectFacts(filter: TimelineFileEffectFactsFilter): TimelineFileEffectFacts;
}>;

function liveCustodyPort(): CustodyPort {
  return getTimelineStore();
}

// ── Attribution resolution (pure with respect to the resolver) ─────────────

/**
 * What a run id resolves to: one of the caller's conversations in this
 * project, "foreign" (a real run the caller does not own — counted, never
 * shown), or null (no conversation of this project carries the run).
 */
export type AttributionResolver = (runId: string) => Readonly<{
  chatId: string;
  chatTitle: string;
  turn: number | null;
  requestText: string | null;
}> | "foreign" | null;

const OUTSIDE_REASON =
  "these changes are not attributed to any recorded conversation — they were " +
  "made outside the assistant, or before file changes carried their run";

/** Plain word for a porcelain status. */
function plainState(status: string): string {
  switch (status) {
    case "modified":
    case "staged":
      return "changed";
    case "untracked":
    case "added":
      return "new";
    case "deleted":
    case "staged-delete":
      return "deleted";
    case "moved":
      return "moved";
    default:
      return status;
  }
}

export type StatusEntry = Readonly<{ status: string; path: string; staged: boolean }>;
export type CountsByPath = ReadonlyMap<string, Readonly<{ insertions: number; deletions: number }>>;

/**
 * The word porcelain uses to join a move's two paths on ONE status line
 * (`R  old.ts -> new.ts`). It is not part of either path.
 */
const PORCELAIN_MOVE_JOIN = " -> ";
/** The same pairing in `--numstat`, which spells it with a fat arrow. */
const NUMSTAT_MOVE_JOIN = " => ";

/**
 * The DESTINATION path of a `--numstat` line, or null when the line names
 * no move.
 *
 * numstat writes a move two different ways and both are real:
 *   `gamma.ts => delta.ts`                       — no shared path parts
 *   `src/rooms/{Room1.ts => Moved1.ts}`          — shared head/tail folded
 * Reading only the first form left every move inside a directory — which
 * is nearly all of them — reported as "not counted" on a row whose counts
 * git had measured perfectly well.
 */
export function numstatDestination(path: string): string | null {
  const at = path.indexOf(NUMSTAT_MOVE_JOIN);
  if (at === -1) return null;
  const open = path.lastIndexOf("{", at);
  const close = path.indexOf("}", at);
  if (open === -1 || close === -1) {
    return path.slice(at + NUMSTAT_MOVE_JOIN.length);
  }
  const head = path.slice(0, open);
  const to = path.slice(at + NUMSTAT_MOVE_JOIN.length, close);
  const tail = path.slice(close + 1);
  // A folded part can be empty on either side (a file moved up or down a
  // level), which is where the seam would double its separator.
  return `${head}${to}${tail}`.replace("//", "/");
}

/**
 * Normalise ONE status entry so its `path` is a path.
 *
 * A move arrives as a single entry whose "path" is `old -> new` and whose
 * status is the raw letter `R`. Both leaked straight through: the room
 * printed the git letter, `see what changed` asked the diff route for a
 * file named "old -> new" (empty patch → the false "matches its last saved
 * state" sentence), and `undo` posted the same non-path and came back
 * `400 the restore did not complete — the files are unchanged`, which
 * described neither the cause nor the file. The entry now carries the
 * DESTINATION — the path that exists on disk now, the one both verbs can
 * actually address — under the plain word "moved".
 */
export function normalizeStatusEntry(entry: StatusEntry): StatusEntry {
  const at = entry.path.indexOf(PORCELAIN_MOVE_JOIN);
  if (at === -1) return entry;
  const destination = entry.path.slice(at + PORCELAIN_MOVE_JOIN.length);
  if (destination.length === 0) return entry;
  return Object.freeze({ status: "moved", path: destination, staged: entry.staged });
}

/**
 * The §7.3 join: current changed files × recorded file-effects, grouped by
 * producing run. Pure over its inputs so the whole grouping is testable
 * against a real temp ledger without a git subprocess.
 *
 * Rules, in order:
 *  - a file's producer is the NEWEST decoded file-effect fact on its exact
 *    absolute path that carries a run id;
 *  - a producer run resolving to one of the caller's conversations groups
 *    the file under that conversation (newest touch first);
 *  - a producer the caller does not own is counted (`withheldRuns`) and the
 *    file lands in the outside bucket — count, never content;
 *  - no producer, an unresolvable producer, or a file beyond the path cap →
 *    the outside bucket, LAST, with the honest reason.
 */
export function computeParcels(
  port: CustodyPort,
  repoPath: string,
  entries: readonly StatusEntry[],
  counts: CountsByPath,
  resolveRun: AttributionResolver,
): Readonly<{ parcels: readonly Parcel[]; join: CustodyJoinStats }> {
  const addressable = entries.map(normalizeStatusEntry);
  const queried = addressable.slice(0, CUSTODY_MAX_FILES);
  const beyondCap = addressable.slice(CUSTODY_MAX_FILES);
  const absOf = (p: string): string => resolve(repoPath, p);
  const result =
    queried.length > 0
      ? port.fileEffectFacts({ paths: queried.map((e) => absOf(e.path)) })
      : { facts: [], fileEffectEventsExamined: 0, undecodableEffects: 0, truncated: false };

  // Newest attributed fact per absolute path (facts arrive in ledger order).
  const newestByPath = new Map<string, Readonly<{ runId: string; wallTime: string }>>();
  for (const fact of result.facts) {
    if (fact.runId === null) continue;
    newestByPath.set(fact.path, { runId: fact.runId, wallTime: fact.wallTime });
  }

  type Group = {
    attribution: Extract<ParcelAttribution, { kind: "conversation" }>;
    files: CustodyFile[];
    insertions: number;
    deletions: number;
  };
  const groups = new Map<string, Group>();
  const outside: CustodyFile[] = [];
  let outsideIns = 0;
  let outsideDel = 0;
  const withheld = new Set<string>();
  let attributedFiles = 0;

  const fileOf = (entry: StatusEntry, touch?: string): CustodyFile => {
    const measured = counts.get(entry.path);
    const state = plainState(entry.status);
    return Object.freeze({
      path: entry.path,
      state,
      insertions: measured?.insertions ?? null,
      deletions: measured?.deletions ?? null,
      ...(measured === undefined
        ? {
            countsAbsentReason:
              state === "new"
                ? "a new file has no earlier saved version to count against — every line is new"
                : "no measured difference is available for this file right now",
          }
        : {}),
      ...(touch !== undefined ? { lastRecordedTouch: touch } : {}),
    });
  };

  for (const entry of queried) {
    const hit = newestByPath.get(absOf(entry.path));
    const resolved = hit === undefined ? null : resolveRun(hit.runId);
    if (hit === undefined || resolved === null || resolved === "foreign") {
      if (resolved === "foreign" && hit !== undefined) withheld.add(hit.runId);
      const f = fileOf(entry);
      outside.push(f);
      outsideIns += f.insertions ?? 0;
      outsideDel += f.deletions ?? 0;
      continue;
    }
    attributedFiles += 1;
    const f = fileOf(entry, hit.wallTime);
    const group = groups.get(hit.runId);
    if (group === undefined) {
      groups.set(hit.runId, {
        attribution: Object.freeze({
          kind: "conversation" as const,
          runId: hit.runId,
          chatId: resolved.chatId,
          chatTitle: resolved.chatTitle,
          turn: resolved.turn,
          requestText: resolved.requestText,
          lastTouchedAt: hit.wallTime,
        }),
        files: [f],
        insertions: f.insertions ?? 0,
        deletions: f.deletions ?? 0,
      });
    } else {
      group.files.push(f);
      group.insertions += f.insertions ?? 0;
      group.deletions += f.deletions ?? 0;
      if (hit.wallTime > group.attribution.lastTouchedAt) {
        group.attribution = Object.freeze({ ...group.attribution, lastTouchedAt: hit.wallTime });
      }
    }
  }
  for (const entry of beyondCap) {
    const f = fileOf(entry);
    outside.push(f);
    outsideIns += f.insertions ?? 0;
    outsideDel += f.deletions ?? 0;
  }

  const conversationParcels = [...groups.values()]
    .sort((a, b) => (a.attribution.lastTouchedAt < b.attribution.lastTouchedAt ? 1 : -1))
    .map((g): Parcel =>
      Object.freeze({
        id: g.attribution.runId,
        attribution: g.attribution,
        files: Object.freeze([...g.files]),
        insertions: g.insertions,
        deletions: g.deletions,
        derivation:
          `${g.files.length} changed file${g.files.length === 1 ? "" : "s"} whose newest recorded ` +
          `file change carries this conversation's run; ±counts are git's own numbers against the last save`,
      }),
    );

  const parcels: Parcel[] = [...conversationParcels];
  if (outside.length > 0) {
    parcels.push(
      Object.freeze({
        id: "outside",
        attribution: Object.freeze({ kind: "outside" as const, reason: OUTSIDE_REASON }),
        files: Object.freeze(outside),
        insertions: outsideIns,
        deletions: outsideDel,
        derivation:
          `${outside.length} changed file${outside.length === 1 ? "" : "s"} with no recorded producing ` +
          `conversation (no attributed file-change record on the exact path` +
          `${beyondCap.length > 0 ? `; ${beyondCap.length} beyond the ${CUSTODY_MAX_FILES}-path bound were not queried` : ""})`,
      }),
    );
  }

  return Object.freeze({
    parcels: Object.freeze(parcels),
    join: Object.freeze({
      changedFiles: entries.length,
      attributedFiles,
      filesBeyondPathCap: beyondCap.length,
      fileEffectEventsExamined: result.fileEffectEventsExamined,
      undecodableEffects: result.undecodableEffects,
      truncated: result.truncated,
      withheldRuns: withheld.size,
    }),
  });
}

/**
 * Commits × producing-conversation join: a commit is attributed to the
 * conversation whose recorded file effects overlap the commit's own files at
 * or before the commit instant; the run with the widest file overlap wins.
 * An empty join is stated, never guessed.
 */
export function joinHistory(
  port: CustodyPort,
  repoPath: string,
  commits: readonly Readonly<{
    entry: GitLogEntry;
    files: readonly Readonly<{ path: string; insertions: number; deletions: number }>[];
  }>[],
  resolveRun: AttributionResolver,
): readonly SavedWork[] {
  const allPaths = new Set<string>();
  for (const c of commits) for (const f of c.files) allPaths.add(resolve(repoPath, f.path));
  const paths = [...allPaths].slice(0, CUSTODY_MAX_FILES);
  const result =
    paths.length > 0
      ? port.fileEffectFacts({ paths })
      : { facts: [], fileEffectEventsExamined: 0, undecodableEffects: 0, truncated: false };

  /**
   * The NEWEST commit in this window that touches each path, by log index.
   *
   * `getLog` returns commits newest-first, so index 0 is the newest and a
   * SMALLER index is strictly later in history. Because the window is always
   * the most recent N commits, every commit later than one in the window is
   * also in the window — so "no later commit touches this path" is a question
   * this map can answer completely, never a question the bound cut off.
   *
   * It exists to break the one tie the clocks cannot: see `sameSecond` below.
   */
  const newestCommitIndexByPath = new Map<string, number>();
  for (const [i, c] of commits.entries()) {
    for (const f of c.files) {
      const abs = resolve(repoPath, f.path);
      if (!newestCommitIndexByPath.has(abs)) newestCommitIndexByPath.set(abs, i);
    }
  }

  return commits.map((c, commitIndex): SavedWork => {
    const commitMs = Date.parse(c.entry.date);
    /**
     * THE END OF THE COMMIT'S OWN INSTANT — compared at the resolution the
     * COARSER source actually has.
     *
     * The two clocks in this comparison do not agree on precision. A git
     * commit time is a whole number of seconds (`GIT_COMMIT_TIME_RESOLUTION_MS`
     * states why); a ledger `wallTime` is milliseconds. Comparing them
     * directly asks "is the effect after the START of the commit's second",
     * which drops every effect recorded in the SAME second as the commit it
     * belongs to — the ordinary case, because a save follows its edit by
     * milliseconds.
     *
     * That is not a near miss. The join then reports "no recorded
     * conversation … an absence, not a guess" for a save whose conversation
     * IS recorded: a fabricated absence, produced by the mechanism that
     * exists to make absence trustworthy, and stated in the register reserved
     * for measured emptiness. The whole claim that an empty cell is provably
     * empty rests on this comparison being made at the coarser clock's
     * resolution.
     *
     * A commit stamped at second S covers [S, S + 1s). An effect at S.437 is
     * WITHIN that commit's instant, not after it — so the bound is exclusive
     * at the END of the second, never at its start. It is not widened beyond
     * that: an effect at S+1.000 is genuinely a later second and is still
     * refused.
     */
    const commitInstantEndMs = commitMs + GIT_COMMIT_TIME_RESOLUTION_MS;
    const commitPaths = new Set(c.files.map((f) => resolve(repoPath, f.path)));
    // Overlap per run: distinct commit files this run touched at/before the
    // commit instant.
    const overlap = new Map<string, { paths: Set<string>; records: number }>();
    for (const fact of result.facts) {
      if (fact.runId === null) continue;
      if (!commitPaths.has(fact.path)) continue;
      const factMs = Date.parse(fact.wallTime);
      if (Number.isFinite(commitMs)) {
        // Unambiguously a LATER second than this commit: it cannot be in it.
        if (factMs >= commitInstantEndMs) continue;
        /**
         * THE ONE TIE THE TWO CLOCKS CANNOT BREAK, broken by ancestry instead.
         *
         * Inside the commit's own second the coarse clock has nothing left to
         * say: an effect at S.437 and a commit stamped S may have happened in
         * either order, and BOTH ways of guessing are wrong somewhere. Taking
         * the whole second as "before" makes a `base` commit — written
         * milliseconds before the run that later edited the same file — claim
         * work that did not exist when it ran. Taking it as "after" is the
         * fabricated absence above.
         *
         * Ancestry does discriminate, and it is a fact rather than a
         * tie-break: an effect on a path is saved ONCE, by a commit at or
         * after it. If a strictly LATER commit in this window also touches
         * this path, that commit is unambiguously after the effect, so it is
         * the save — and this same-second commit is not. Only when no later
         * commit touches the path is this commit the sole candidate, and
         * refusing it there is the absence that was being fabricated.
         *
         * This is deliberately narrow: it applies ONLY inside the ambiguous
         * second. An effect strictly before the commit's second is included
         * exactly as it always was, later commits or not.
         */
        const sameSecond = factMs >= commitMs;
        if (sameSecond && newestCommitIndexByPath.get(fact.path) !== commitIndex) continue;
      }
      const g = overlap.get(fact.runId) ?? { paths: new Set<string>(), records: 0 };
      g.paths.add(fact.path);
      g.records += 1;
      overlap.set(fact.runId, g);
    }
    let best: Readonly<{ runId: string; paths: number; records: number }> | null = null;
    for (const [runId, g] of overlap) {
      if (resolveRun(runId) === null || resolveRun(runId) === "foreign") continue;
      if (best === null || g.paths.size > best.paths) {
        best = { runId, paths: g.paths.size, records: g.records };
      }
    }
    const resolved = best === null ? null : resolveRun(best.runId);
    const conversation =
      best !== null && resolved !== null && resolved !== "foreign"
        ? Object.freeze({
            chatId: resolved.chatId,
            chatTitle: resolved.chatTitle,
            overlapFiles: best.paths,
            matchedRecords: best.records,
          })
        : null;
    const insertions = c.files.reduce((n, f) => n + f.insertions, 0);
    const deletions = c.files.reduce((n, f) => n + f.deletions, 0);
    return Object.freeze({
      hash: c.entry.hash,
      shortHash: c.entry.shortHash,
      message: c.entry.message,
      author: c.entry.author,
      when: c.entry.date,
      files: c.files.length,
      insertions,
      deletions,
      filePaths: Object.freeze(c.files.map((f) => f.path)),
      conversation,
      derivation:
        conversation !== null
          ? `${conversation.overlapFiles} of this save's ${c.files.length} files have recorded file changes ` +
            `from "${conversation.chatTitle}" at or before the save instant (${conversation.matchedRecords} records; exact path equality)`
          : `no recorded conversation's file changes overlap this save's ${c.files.length} file${c.files.length === 1 ? "" : "s"} at or before its instant — an absence, not a guess`,
    });
  });
}

// ── Run → conversation resolution (the ownership choke points) ─────────────

/**
 * Build the caller-scoped resolver for one project: run ids of the caller's
 * own chats in this project resolve to the chat (+ producing turn facts);
 * a run the caller does not own resolves "foreign"; anything else null.
 * All lookups go through the user-scoped DB owners.
 */
export async function attributionResolverFor(
  db: AsyncDbClient,
  userId: string,
  projectId: string,
): Promise<AttributionResolver> {
  const [attributions, ownedRunIds] = await Promise.all([
    db.runAttributionsForProject(projectId, userId),
    db.allRunIdsForUser(userId),
  ]);
  const ownedRuns = new Set(ownedRunIds);
  const byRun = new Map(attributions.map((row) => {
    const text = row.requestContent?.trim() ?? "";
    return [row.runId, Object.freeze({ chatId: row.chatId, chatTitle: row.chatTitle,
      turn: row.turn, requestText: text.length === 0 ? null : text.slice(0, REQUEST_TEXT_CAP) })] as const;
  }));
  return (runId: string) => byRun.get(runId) ?? (ownedRuns.has(runId) ? null : "foreign");
}

// ── Git measurement helpers (real subprocess reads via the bridge) ─────────

/** Parse `--numstat` output into per-file measured counts. Binary files
 * report "-" and are carried with 0/0 (their change is real; their line
 * counts genuinely do not exist). */
export function parseNumstat(
  output: string,
): readonly Readonly<{ path: string; insertions: number; deletions: number }>[] {
  const files: Readonly<{ path: string; insertions: number; deletions: number }>[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : parseInt(parts[0] ?? "0", 10) || 0;
    const del = parts[1] === "-" ? 0 : parseInt(parts[1] ?? "0", 10) || 0;
    const path = parts.slice(2).join("\t");
    if (path.length === 0) continue;
    files.push(Object.freeze({ path, insertions: ins, deletions: del }));
  }
  return files;
}

/** Working-tree ±counts vs the last save, staged + unstaged in ONE view.
 * Exported for the real-repo tests (the handler's own measurement path). */
export function workingCounts(repoPath: string, options: Readonly<{ async: true }>): Promise<CountsByPath>;
export function workingCounts(repoPath: string): CountsByPath;
export function workingCounts(repoPath: string, options?: Readonly<{ async: true }>): CountsByPath | Promise<CountsByPath> {
  return options?.async === true
    ? gitTextOrRefuse(repoPath, ["diff", "--numstat", "HEAD"], "unsaved change counts", [], options).then(countsFromNumstat)
    : countsFromNumstat(gitTextOrRefuse(repoPath, ["diff", "--numstat", "HEAD"], "unsaved change counts"));
}

function countsFromNumstat(out: string | null): CountsByPath {
  const map = new Map<string, Readonly<{ insertions: number; deletions: number }>>();
  if (out !== null) {
    for (const f of parseNumstat(out)) {
      map.set(f.path, f);
      // numstat pairs a move's two paths on one line; the status side calls
      // the same file by its destination alone. Key it BOTH ways so a moved
      // file's counts are found instead of reported absent.
      const destination = numstatDestination(f.path);
      if (destination !== null && destination.length > 0) map.set(destination, f);
    }
  }
  return map;
}

/** Runs one git invocation and returns its stdout (null on failure). Injected
 * so `commitFilesByHash` can be held to an INVOCATION COUNT by a test — the
 * property under guard is "one spawn, not one per commit", and only the
 * caller of the runner can see that. */
export type GitRunner = (args: readonly string[]) => string | null;

/**
 * Per-commit changed files for a whole page of history, in ONE git call.
 *
 * This was `git show --numstat --format= <hash>` per commit, inside a `.map`
 * over the log — so a default history read (20 commits) issued **~24
 * sequential blocking `spawnSync` calls**, each with git's ~30-50ms process
 * startup, all on the event loop. That is the demonstrated cause of
 * head-of-line blocking: `/api/health` measures p50 1.31ms and **max 4,814ms**
 * with one heavy custody read in flight, and every SSE token and keystroke
 * acknowledgement waits behind it too.
 *
 * `git log --numstat` reports the same numbers for a list of commits in a
 * single invocation. Commits are separated by RS (0x1e) so a commit whose
 * message or paths contain anything at all cannot be mistaken for a boundary,
 * and the format carries only the hash — the log entries themselves already
 * came from `getLog`.
 *
 * Merge commits report no numstat here, exactly as `git show --numstat` did
 * for them; they map to an empty file list rather than to a guess.
 *
 * Getting this scan OFF the event loop is the facade's work. Making it two
 * spawns instead of twenty-four is this one's.
 */
export function commitFilesByHash(
  repoPath: string,
  hashes: readonly string[],
  run: GitRunner = (args) => gitTextOrRefuse(repoPath, args, "the saved history"),
): ReadonlyMap<string, readonly Readonly<{ path: string; insertions: number; deletions: number }>[]> {
  const out = new Map<string, readonly Readonly<{ path: string; insertions: number; deletions: number }>[]>();
  for (const hash of hashes) out.set(hash, []);
  if (hashes.length === 0) return out;
  // `--no-walk` takes the listed commits themselves rather than their
  // ancestry, so the answer is exactly the page `getLog` returned — a
  // `-N` window could drift from it whenever the history is not linear.
  const raw = run(["log", "--no-walk", "--numstat", "--format=%x1e%H", ...hashes]);
  if (raw === null) return out;
  // The RS is written as an escape, not as a literal control character: an
  // invisible byte in source is a delimiter nobody can review.
  const RECORD_SEPARATOR = "\u001e";
  for (const record of raw.split(RECORD_SEPARATOR)) {
    if (record.trim().length === 0) continue;
    const newline = record.indexOf("\n");
    const hash = (newline === -1 ? record : record.slice(0, newline)).trim();
    if (!out.has(hash)) continue;
    out.set(hash, newline === -1 ? [] : parseNumstat(record.slice(newline + 1)));
  }
  return out;
}

/** Whether fetched remote branches exist (read-only probe — `git remote`
 * would be classified mutating by the bridge's deny-by-default recorder). */
function hasRemoteBranches(repoPath: string): boolean {
  const out = gitTextOrRefuse(repoPath, ["branch", "-a", "--format=%(refname)"], "the list of branches");
  return out !== null && out.split("\n").some((l) => l.startsWith("refs/remotes/"));
}

// ── Input validation (deny-by-default) ─────────────────────────────────────

/**
 * Normalise one requested file to a repo-relative path, refusing anything
 * that could read as a git flag or escape the repository. Absolute paths are
 * accepted ONLY when they resolve inside the repo (the recorded tool args
 * carry absolute paths).
 */
export function normalizeRepoFile(repoPath: string, file: string): string {
  if (file.length === 0 || file.length > 1024 || file.includes("\0") || file.includes("\n")) {
    throw new BadRequestError(`invalid file path`, "invalid_custody_file");
  }
  if (file.startsWith("-")) {
    throw new BadRequestError(
      `invalid file path "${file}" — a path must not start with '-'`,
      "invalid_custody_file",
    );
  }
  const abs = isAbsolute(file) ? resolve(file) : resolve(repoPath, file);
  const root = resolve(repoPath);
  // At or under the project root BY IDENTITY (a link or bind-mount alias is where it points).
  if (!identityOverlapIndex().atOrUnder(resolveLocation(abs, "a custody file"), resolveLocation(root, "the project"))) {
    throw new BadRequestError(
      `file "${file}" is outside the project`,
      "invalid_custody_file",
    );
  }
  const rel = relative(root, abs);
  if (rel.length === 0) {
    throw new BadRequestError(`file "${file}" names the project root, not a file`, "invalid_custody_file");
  }
  return rel;
}

const ReadInput = z.strictObject({
  projectId: z.string().min(1).max(256),
});

const HistoryInput = z.strictObject({
  projectId: z.string().min(1).max(256),
  max: z.coerce.number().int().min(1).max(serverConfig.gitMaxLogEntries).optional(),
});

const FilesInput = z
  .array(z.string().min(1).max(1024))
  .min(1)
  .max(CUSTODY_MAX_FILES);

const KeepInput = z.strictObject({
  projectId: z.string().min(1).max(256),
  files: FilesInput,
  message: z
    .string()
    .trim()
    .min(1)
    .max(CUSTODY_MAX_MESSAGE)
    // Argument-injection guard, same rule the git bridge applies to refs: a
    // message that could parse as a git flag is refused at the door.
    .refine((m) => !m.startsWith("-"), { message: "a message must not start with '-'" }),
});

const UndoInput = z.strictObject({
  projectId: z.string().min(1).max(256),
  files: FilesInput,
});

// ── Handler wiring ─────────────────────────────────────────────────────────

async function requireRepo(
  db: AsyncDbClient,
  ctx: RouteContext,
  projectId: string,
): Promise<Readonly<{ userId: string; repoPath: string; gate: FsGate }>> {
  const user = await requireUserContext(ctx, db);
  const project = await db.getProject(projectId, user.userId);
  if (project === null) {
    throw new NotFoundError(`Project ${projectId} not found`);
  }
  const gate = await makeFsGate(user.userId, db, project.path);
  // Gate enforcement at THIS choke point too (defense-in-depth over the
  // per-bridge checks): every custody entry crosses the ownership probe
  // before any git subprocess sees the path.
  assertProjectPathOwnership(project.path, gate);
  return { userId: user.userId, repoPath: project.path, gate };
}

const NOT_A_REPO_REASON =
  "this project's folder is not under version control, so there is no saved history to keep work in";

function emptyJoin(changedFiles: number): CustodyJoinStats {
  return Object.freeze({
    changedFiles,
    attributedFiles: 0,
    filesBeyondPathCap: 0,
    fileEffectEventsExamined: 0,
    undecodableEffects: 0,
    truncated: false,
    withheldRuns: 0,
  });
}

/** The changed-path set from a status read (repo-relative). */
function changedPathSet(repoPath: string, gate: FsGate): ReadonlyMap<string, StatusEntry> {
  const status = getGitStatus(repoPath, gate);
  const map = new Map<string, StatusEntry>();
  // Keyed by the SAME addressable path the room offered the verbs on — a
  // move is keyed by its destination, not by porcelain's "old -> new".
  for (const e of status.entries) {
    const entry = normalizeStatusEntry(e);
    map.set(entry.path, entry);
  }
  return map;
}

export function defineCustodyBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "custody.state",
    title: "Custody of current work",
    description:
      "Every uncommitted change in the project, grouped by the conversation whose recorded file changes produced it (exact path join over the recorded history), with the honest 'not from a recorded conversation' bucket for everything else. All counts are git's own numbers; actions really commit and really restore, and are recorded.",
    read: {
      input: ReadInput,
      output: z.unknown(),
      ttlMs: 5_000,
      invalidateOn: ["run:done", "custody:changed"],
      handler: async (input, { ctx }: BlockHandlerContext): Promise<CustodyState> => {
        const { userId, repoPath, gate } = await requireRepo(db, ctx, input.projectId);
        const status = await getGitStatus(repoPath, gate, { async: true });
        if (!status.repository) {
          return Object.freeze({
            repository: false,
            reason: NOT_A_REPO_REASON,
            branch: null,
            parcels: Object.freeze([]),
            join: emptyJoin(0),
          });
        }
        const { parcels, join } = computeParcels(
          liveCustodyPort(),
          repoPath,
          status.entries,
          await workingCounts(repoPath, { async: true }),
          await attributionResolverFor(db, userId, input.projectId),
        );
        return Object.freeze({
          repository: true,
          branch: status.branch,
          parcels,
          join,
        });
      },
    },
    actions: {
      keep: {
        input: KeepInput,
        title: "Keep this work",
        consequence:
          "Saves these files' changes into the project's history under your message, right away; the files themselves stay exactly as they are now.",
        params: { projectId: "$sel.projectId" },
        invalidates: ["custody:changed"],
        handler: async (input: z.infer<typeof KeepInput>, { ctx }: BlockHandlerContext) => {
          const { repoPath, gate } = await requireRepo(db, ctx, input.projectId);
          if (!isGitRepo(repoPath)) {
            throw new BadRequestError(NOT_A_REPO_REASON, "not_a_repository");
          }
          const files = input.files.map((f) => normalizeRepoFile(repoPath, f));
          const changed = changedPathSet(repoPath, gate);
          for (const f of files) {
            if (!changed.has(f)) {
              throw new BadRequestError(
                `nothing to save for "${f}" — it has no uncommitted changes`,
                "custody_file_unchanged",
              );
            }
          }
          const beforeTip = gitTextOrRefuse(repoPath, ["rev-parse", "HEAD"], "the current save point");
          if (gitTextOrRefuse(repoPath, ["add", "--", ...files], "the files being saved") === null) {
            throw new BadRequestError(
              "the project refused to take these files — nothing was saved",
              "custody_keep_failed",
            );
          }
          if (gitTextOrRefuse(repoPath, ["commit", "-m", input.message, "--", ...files], "the save") === null) {
            throw new BadRequestError(
              "the save did not complete — nothing new was added to the project's history " +
                "(a common cause is a repository with no author name configured)",
              "custody_keep_failed",
            );
          }
          // PROOF, measured: the branch tip really moved, and the new commit
          // itself carries exactly these files with git's own counts.
          const tip = gitTextOrRefuse(repoPath, ["rev-parse", "HEAD"], "the new save point");
          if (tip === null || tip === beforeTip) {
            throw new BadRequestError(
              "the save did not complete — the project's history is unchanged",
              "custody_keep_failed",
            );
          }
          const committed = commitFilesByHash(repoPath, [tip]).get(tip) ?? [];
          const after = changedPathSet(repoPath, gate);
          return Object.freeze({
            kept: true as const,
            hash: tip,
            shortHash: tip.slice(0, serverConfig.gitShortHashLength),
            message: input.message,
            files: Object.freeze(committed.map((f) => f.path)),
            insertions: committed.reduce((n, f) => n + f.insertions, 0),
            deletions: committed.reduce((n, f) => n + f.deletions, 0),
            /** Files still carrying changes afterwards (e.g. edited during
             * the save) — honest, usually empty. */
            stillChanged: Object.freeze(files.filter((f) => after.has(f))),
          });
        },
      },
      undo: {
        input: UndoInput,
        title: "Undo these changes",
        consequence:
          "Returns these files to their last saved state — unsaved edits leave the working tree.",
        params: { projectId: "$sel.projectId" },
        invalidates: ["custody:changed"],
        handler: async (input: z.infer<typeof UndoInput>, { ctx }: BlockHandlerContext) => {
          const { repoPath, gate } = await requireRepo(db, ctx, input.projectId);
          if (!isGitRepo(repoPath)) {
            throw new BadRequestError(NOT_A_REPO_REASON, "not_a_repository");
          }
          const files = input.files.map((f) => normalizeRepoFile(repoPath, f));
          const changed = changedPathSet(repoPath, gate);
          for (const f of files) {
            const entry = changed.get(f);
            if (entry === undefined) {
              throw new BadRequestError(
                `nothing to undo for "${f}" — it has no uncommitted changes`,
                "custody_file_unchanged",
              );
            }
            if (entry.status === "untracked") {
              throw new BadRequestError(
                `"${f}" is a new file with no earlier saved version to return to — deleting it is not something undo will do`,
                "custody_file_new",
              );
            }
            if (entry.status === "moved") {
              // `git checkout HEAD -- <destination>` cannot succeed: the
              // last save has no file at this path. Refused HERE with the
              // real reason instead of one path further on, where the
              // failure read "the restore did not complete — the files are
              // unchanged" and named neither the move nor the cause.
              throw new BadRequestError(
                `"${f}" was moved here, so the last save holds no file at this path to return to — undo will not put it back by itself`,
                "custody_file_moved",
              );
            }
          }
          // MEASURED loss, from the real diff, BEFORE anything is touched.
          const counts = workingCounts(repoPath);
          let insertions = 0;
          let deletions = 0;
          for (const f of files) {
            const c = counts.get(f);
            insertions += c?.insertions ?? 0;
            deletions += c?.deletions ?? 0;
          }
          if (gitTextOrRefuse(repoPath, ["checkout", "HEAD", "--", ...files], "the files being restored") === null) {
            throw new BadRequestError(
              "the restore did not complete — the files are unchanged",
              "custody_undo_failed",
            );
          }
          // PROOF: the named files are genuinely clean now.
          const after = changedPathSet(repoPath, gate);
          const stillChanged = files.filter((f) => after.has(f));
          if (stillChanged.length > 0) {
            throw new BadRequestError(
              `the restore did not fully complete for: ${stillChanged.join(", ")}`,
              "custody_undo_failed",
            );
          }
          return Object.freeze({
            undone: true as const,
            files: Object.freeze(files),
            discarded: Object.freeze({ insertions, deletions }),
          });
        },
      },
    },
  });

  defineBlock({
    id: "custody.history",
    title: "Saved work",
    description:
      "Recent saves in the project's history, each joined to the conversation whose recorded file changes overlap the save's own files at or before its instant — with an honest 'no recorded conversation' where the join is empty. Counts are git's own numbers per save.",
    read: {
      input: HistoryInput,
      output: z.unknown(),
      ttlMs: 10_000,
      invalidateOn: ["run:done", "custody:changed"],
      handler: async (input, { ctx }: BlockHandlerContext): Promise<CustodyHistory> => {
        const { userId, repoPath, gate } = await requireRepo(db, ctx, input.projectId);
        if (!isGitRepo(repoPath)) {
          return Object.freeze({
            repository: false,
            reason: NOT_A_REPO_REASON,
            commits: Object.freeze([]),
            remoteConfigured: false,
          });
        }
        const log = getLog(repoPath, input.max ?? CUSTODY_HISTORY_DEFAULT, gate);
        // ONE git call for the whole page — see `commitFilesByHash`. This was
        // one `git show` per commit, so the default read spawned ~24 blocking
        // subprocesses in sequence.
        const filesByHash = commitFilesByHash(repoPath, log.map((e) => e.hash));
        const withFiles = log.map((entry) => ({
          entry,
          files: filesByHash.get(entry.hash) ?? [],
        }));
        const commits = joinHistory(
          liveCustodyPort(),
          repoPath,
          withFiles,
          await attributionResolverFor(db, userId, input.projectId),
        );
        return Object.freeze({
          repository: true,
          commits,
          remoteConfigured: hasRemoteBranches(repoPath),
        });
      },
    },
  });
}
