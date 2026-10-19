/**
 * TREE IDENTITY — the answers a measurement record binds to: WHICH commit the
 * tree is at, WHAT content the measurement covered, and WHETHER the working
 * tree carries anything that commit does not.
 *
 * ── WHY THIS IS ONE MODULE, AND WHY IT IS THREE KINDS OF READ ────────────
 *
 * A report or run record that labels itself with the tree it measured needs
 * all three. A sha alone cannot name a dirty tree: two runs against the same
 * commit, one clean and one carrying uncommitted edits, measured different
 * code. And a sha alone cannot answer the question a freshness gate actually
 * means — "is the code this report describes still the code at HEAD" —
 * because a commit can move HEAD without touching the measured surface (a
 * merge-door commit over `scripts/`/`tests/`/docs), and staling the report
 * over it is a recurring cost that carries no signal. The measured-surface
 * hash is that answer: the content identity of the paths the dev server
 * serves and executes, so a non-surface commit leaves the report fresh.
 *
 * The sha half is a FILESYSTEM read (no subprocess) — `.git/HEAD` resolves
 * through loose refs and packed-refs. It lives in `run-history.ts`, which is
 * reachable from the server's import graph, and is re-exported here so a
 * consumer of tree identity has ONE door.
 *
 * The dirty and surface halves have NO filesystem form — only `git` knows —
 * so both are subprocesses. A subprocess cannot live in `run-history.ts`:
 * that module is reachable from the server, and every subprocess reachable
 * from the server must be a confinement owner (the server's model-directed
 * spawns are Landlock-confined; a stray `execFileSync("git", …)` in a
 * reachable module is unconfined by construction). This module is imported
 * ONLY by the runners' tooling and the perf profile — never by the server —
 * so the subprocesses here are out of the server's reach by construction. The
 * surface hash goes through the canonical `sha256` owner (`integrity.ts`),
 * never a direct `node:crypto` import — the one-owner rule the architecture
 * guard enforces.
 *
 * ONE SPELLING. The dirty reads are `--porcelain` (v1, the stable format),
 * in two widths because the two consumers ask two different questions. The
 * STRICT question (`--untracked-files=all`, the profile's): ANY entry — a
 * modified tracked file, a staged change, an untracked scratch file — means
 * the run's outputs are not reproducible from HEAD alone. The TRACKED
 * question (`--untracked-files=no`, the run-history ledger's): has the
 * COMMITTED SOURCE been edited — an untracked scratch note or a gitignored
 * build cache is not a work-in-progress edit of the code the next writer
 * inherits, so the ledger's provisional marking must not count it. A caller
 * that wants a third width narrows the answer itself; the owner reports the
 * tree as it is. No consumer parses porcelain itself — that is the drift this
 * module exists to prevent. The surface read is a WORKING-TREE FILE WALK
 * over the measured paths — the bytes the dev server actually serves —
 * hashed through the canonical digest owner, never a subprocess.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { stripRegeneratedPins, suiteRegeneratedPaths } from "../workflow/hash-binding-registry.ts";
import { workingTreeId } from "../git/working-copy.ts";
import { handleError } from "./debug/debug-system.ts";
import { readRepositoryHeadSha } from "./run-history.ts";

export { readRepositoryHeadSha };

/**
 * THE MEASURED SURFACE — the tracked paths whose content the profile actually
 * measures.
 *
 * The profile measures the app the dev server SERVES: the built web UI plus
 * the server runtime. A commit's freshness question is therefore not "did
 * HEAD move" but "did HEAD move IN A PATH THE PROFILE MEASURES" — a merge
 * door commit that touches only `scripts/` + `tests/` + docs moves HEAD while
 * leaving every measured byte alone, and staling the report over it is the
 * recurring cost this hash exists to end. Freshness binds to the SURFACE
 * hash; HEAD is still recorded for provenance.
 *
 * The set is DERIVED from what the dev server loads, never a hand-maintained
 * list of everything it might:
 *
 *   - `src/`, `public/`, `shared/` — the client tree vite serves: the entry
 *     documents' module graph (`index.html` → `/src/main.ts`, the dev pages),
 *     the static assets, and the shared contracts the client imports.
 *   - `server/` — the API runtime: every route handler and its local import
 *     graph. The profile's API timings measure exactly this code.
 *   - `engine/src/` — the canonical harness source the SERVER imports
 *     (`server/canonical.ts`, the bridges, the awareness worker). The CLIENT
 *     never loads a byte of `engine/` (the vite config's own words), but the
 *     server's answers are computed from it, so it is measured through the
 *     API half.
 *   - `engine/bridlewise.config.json` — the runtime config the server reads
 *     (`server/config.ts` resolves exactly this path).
 *   - the root entry + toolchain declarations — `index.html`,
 *     `cockpit-dev.html` (the vite `optimizeDeps.entries` universe),
 *     `svelte.config.ts`, `vite.config.ts` (the build/toolchain inputs that
 *     shape the served bundle), `package.json` + `package-lock.json` (the
 *     dependency closure the served code is built from).
 *
 * The honest bound, stated: this is a CONSERVATIVE SUPERSET of the measured
 * bytes, not the exact module graph. A full load-graph derivation (every
 * transitive import of the two entry points) is itself a build, and a change
 * to a file that is IN one of these directories but NOT actually imported
 * (dead code) will stale a report whose measurements did not move — that
 * direction is safe (a spurious stale costs a regeneration, never a false
 * green). The other direction is the one that must not happen, and it is
 * closed by construction: every path the dev server serves or executes is
 * inside one of these roots. The TSConfig include sets and the vite
 * declarations agree with this set (the client tsconfig includes `src/**` +
 * `shared/**`, the server tsconfig `server/**`, the server reads
 * `engine/src/**` + `engine/bridlewise.config.json`).
 *
 * A NEW served surface (a new root page directory, a new runtime root) is a
 * structural claim — it must be added here deliberately, which is the
 * deny-by-default posture: the safe default is that an unlisted path does NOT
 * stale the report, and widening the set is an explicit act.
 *
 * THE LEDGER'S PROVISIONAL JUDGEMENT LIVES HERE, NOT IN THE LEDGER OWNER.
 * `run-history.ts` is reachable from the server's import graph, so no spelling
 * of `node:child_process` may appear there — not even a dynamic one: the
 * subprocess-reachability guard walks dynamic edges, and a deferred
 * `await import("./tree-identity.ts")` from that module would put THIS
 * module's porcelain spawn one hop from the server, which is the escape the
 * confinement boundary exists to refuse. The runners therefore ask THIS
 * module — already subprocess-owning, already unreachable from the server —
 * for the dirty-tree verdict directly.
 */
const MEASURED_SURFACE_PATHS: readonly string[] = [
  "index.html",
  "cockpit-dev.html",
  "svelte.config.ts",
  "vite.config.ts",
  "package.json",
  "package-lock.json",
  "src",
  "public",
  "shared",
  "server",
  "engine/src",
  "engine/bridlewise.config.json",
];

/**
 * THE SURFACE HASH — one content identity over the measured surface, read
 * from the WORKING TREE: the bytes the dev server actually serves and
 * executes, which is what a profile measures.
 *
 * ── WHY THE WORKING TREE AND NOT HEAD'S COMMITTED CONTENT ────────────────
 *
 * The profile runs against the dev server, and the dev server serves the
 * working tree — uncommitted edits included. A hash read from git's object
 * store (`ls-tree HEAD`) answers a different question ("what is committed")
 * and disagrees with the measurements in BOTH directions, each observed:
 *
 *   - FALSE RED: the round flow profiles LAST, against a tree that carries
 *     the round's uncommitted work; committing that same work afterwards
 *     changes no served byte, yet moved the HEAD-read hash and staled the
 *     brand-new report — "profiled against d2b99435 but the surface is now
 *     05cf342f, no source change in between".
 *   - FALSE GREEN (worse): an UNCOMMITTED edit to a served file changes the
 *     measurements while the HEAD-read hash stays put — the gate then
 *     certifies a report about bytes it never named.
 *
 * Hashing the working tree makes the hash a pure function of the served
 * content: a commit of identical bytes leaves it put (the report survives
 * the commit), an edit moves it immediately (the report stales the moment
 * the measured content changes, committed or not). HEAD's sha and the
 * dirty flag still ride the report for provenance.
 *
 * ONE DERIVED VALUE IS NOT A CONTENT CHANGE: a file in the suite-regenerated
 * set carries pin literals the suite re-derives from the tree (the bundle
 * pin in root-policy.ts, the registry pins in the trace files), and the
 * close-out convergence restates them on the measured surface AFTER a
 * round's last mint — a restatement moved this hash and staled the standing
 * report with it, so every round inherited a freshness red on arrival for a
 * change no measurement observed. Such a file is hashed with its pin
 * literals normalized away (the same `stripRegeneratedPins` normalization
 * the cross-branch drift audit already uses to judge the same class, both
 * consuming the one `suiteRegeneratedPaths` derivation from the binding
 * registry), so a restatement is not a surface move. The normalization is
 * SCOPED: files outside the regenerated set hash their raw bytes, and a
 * non-pin byte in a regenerated file is a real edit — the gate stays blind
 * to nothing.
 *
 * The population is exactly the declared measured paths — deny-by-default
 * the other way: everything outside the declaration is excluded BY
 * CONSTRUCTION, including every artifact the act of profiling writes
 * (`.bridlewise/`, `test-results/`, the report itself). No hand-maintained
 * artifact exclusion list that rots the day a new artifact appears: a path
 * is hashed iff the dev server serves or executes it, and the profile's
 * own outputs are not served to the browser. Untracked files under a
 * declared root ARE included — vite serves them exactly like tracked ones.
 * Symlinks are skipped: a served tree is plain files, and a link cycle
 * must not be able to loop the walk.
 *
 * Returns null when the surface cannot be read (none of the declared
 * paths exist — a wrong root, a non-repository) — absence, never a
 * fabricated hash, so the gate refuses rather than judges against a guess.
 */
/** A filesystem error that means ABSENCE (the path is not there) rather
 * than a failure to read — for a declared measured path, absence is the
 * tree's honest content for that path, not an error. */
function isAbsence(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function readMeasuredSurfaceHash(repositoryRoot: string): string | null {
  const entries: string[] = [];
  let unreadable = false;
  // The pin-normalization population, derived once from the binding registry
  // — never a local list of paths (a binding retargeted tomorrow is covered
  // with no edit here).
  const regenerated = suiteRegeneratedPaths();
  const collect = (absolute: string, declared: string): void => {
    let stats: Stats;
    try {
      stats = statSync(absolute);
    } catch (err) {
      // Absence contributes nothing — the path's content is that it is not
      // there. Anything else (permissions, a broken mount) means the surface
      // cannot be named, and the whole read refuses rather than narrowing.
      if (isAbsence(err)) return;
      unreadable = true;
      return;
    }
    if (stats.isDirectory()) {
      let names: readonly Dirent[];
      try {
        names = readdirSync(absolute, { withFileTypes: true });
      } catch (err) {
        // A directory that cannot be listed is a surface that cannot be
        // named; skipping it would silently narrow the hash. The failure is
        // routed through the centralized error system — a hash that quietly
        // ignored a directory would be a false identity, and silence is how
        // that ships.
        handleError(err, { module: "tree-identity", operation: "read measured surface" });
        unreadable = true;
        return;
      }
      for (const entry of names) {
        if (entry.isSymbolicLink()) continue;
        collect(join(absolute, entry.name), `${declared}/${entry.name}`);
      }
      return;
    }
    if (!stats.isFile()) return;
    try {
      const bytes = readFileSync(absolute);
      // A suite-regenerated file's pin literals are values the suite
      // re-derives, so they hash with the pins normalized away (a restatement
      // is not a content change); every other file hashes its raw bytes.
      const digest = regenerated.has(declared)
        ? sha256(stripRegeneratedPins(bytes.toString("utf8")))
        : sha256(bytes);
      entries.push(`${declared}\u0000${digest}`);
    } catch (err) {
      // An unreadable file is a surface that cannot be named; skipping it
      // would silently narrow the hash, so the whole read refuses instead —
      // routed through the same centralized error system as the directory
      // case above.
      handleError(err, { module: "tree-identity", operation: "read measured surface" });
      unreadable = true;
    }
  };
  for (const declared of MEASURED_SURFACE_PATHS) {
    if (unreadable) break;
    collect(join(repositoryRoot, declared), declared);
  }
  if (unreadable) return null;
  if (entries.length === 0) return null; // an empty surface is a wrong root, not a real tree
  entries.sort();
  // The canonical hash owner (a direct `node:crypto` createHash here is the
  // bypass the architecture guard refuses).
  return sha256(entries.join("\n") + "\n");
}

/** The porcelain v1 lines for a working tree, or null when unreadable. */
function readStatusPorcelain(
  repositoryRoot: string,
  untracked: "all" | "no",
): readonly string[] | null {
  try {
    const out = execFileSync("git", ["status", "--porcelain", `--untracked-files=${untracked}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      // A dirty tree's porcelain can be large (one line per untracked file).
      // The bound is the single owner's git-output limit, not a local number.
      maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
    });
    return out.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }
}

/**
 * IS THE WORKING TREE DIRTY — true when the tree carries anything HEAD does
 * not. Returns `null` when the answer cannot be learned (a non-repository, an
 * unreadable git) — absence, never a fabricated "clean", so a consumer that
 * cannot learn the answer refuses rather than guesses.
 */
export function readWorkingTreeDirty(repositoryRoot: string): boolean | null {
  const entries = readStatusPorcelain(repositoryRoot, "all");
  if (entries === null) return null;
  return entries.length > 0;
}

/**
 * DOES THE TRACKED TREE DIFFER FROM HEAD — true when the COMMITTED SOURCE is
 * being modified: a tracked file edited in the worktree, staged, renamed,
 * deleted. Untracked files do NOT count — a scratch note, a downloaded
 * fixture or a gitignored generated artifact is not a work-in-progress edit
 * of the code a commit would carry, so a run measured beside one still
 * measured the committed tree. This is the question the run-history ledger's
 * provisional marking asks; the strict question above (untracked counts) is
 * the profile's reproducibility question, and the two stay distinct readings
 * of the one porcelain spelling. Returns `null` when the answer cannot be
 * learned — absence, never a fabricated "clean".
 */
export function readTrackedTreeDirty(repositoryRoot: string): boolean | null {
  const entries = readStatusPorcelain(repositoryRoot, "no");
  if (entries === null) return null;
  return entries.length > 0;
}

/**
 * THE LEDGER'S PROVISIONAL MARKER, READY TO SPREAD INTO A JUDGED-RUN RECORD —
 * `{}` when the run's tracked tree is the committed one (or the answer could
 * not be learned: an unknown-provenance row, which the flaky verdict counts
 * as a real failure), `{ provisionalFailures: true }` when the run measured
 * mid-edit code. The runners spread the result, so "no marker" and "marked
 * provisional" are the only two shapes a record can carry — a `false` literal
 * is never written, which keeps a legacy row and a fresh clean-tree row
 * byte-indistinguishable.
 *
 * One spelling, shared by both runners, beside the porcelain it derives from:
 * a second derivation of the same judgement is the drift this module exists
 * to prevent.
 */
export function provisionalFailureMark(
  repositoryRoot: string,
): Readonly<{ provisionalFailures: true }> | Readonly<Record<string, never>> {
  return readTrackedTreeDirty(repositoryRoot) === true
    ? { provisionalFailures: true }
    : {};
}

/**
 * THE TREE A RUN STARTS ON — the id of the tree `git add -A` would commit in
 * the repository holding `directory` (`workingTreeId`, the working-copy
 * owner's one recipe: the WHOLE repository from any folder of it, a private
 * index and private objects, nothing written a reader sees), or null when it
 * cannot be read (routed through the central error system). A runner reads it
 * once before its first test and hands it to {@link measuredTreeMark} at the
 * end; its git work precedes the run's CPU baseline, so it is not the
 * suite's cost.
 */
export function readMeasuredTree(directory: string): string | null {
  try {
    return workingTreeId(directory);
  } catch (error) {
    handleError(error, { module: "tree-identity", operation: "read the measured tree" });
    return null;
  }
}

/**
 * THE TREE THE RUN MEASURED, READY TO SPREAD INTO A JUDGED-RUN RECORD —
 * `{ treeId }` when the tree at the end of the run is the tree it started on
 * (`atStart`, {@link readMeasuredTree}): the key a later commit of exactly
 * that tree finds this run by, wherever it was taken (a candidate's
 * qualification is the baseline of the commit that lands its tree). `{}`
 * when either read failed or the tree CHANGED during the run (a concurrent
 * edit of a shared checkout): the run measured no one tree, and a key read
 * at one end would name a tree it only partly measured (WF-1b3c-FIX MED-1).
 * Such a row is not an exact-tree test reference; a HEAD sha cannot supply
 * the missing measured-tree identity.
 */
export function measuredTreeMark(directory: string, atStart: string | null): Readonly<{ treeId: string }> | Readonly<Record<string, never>> {
  if (atStart === null) return {};
  return readMeasuredTree(directory) === atStart ? { treeId: atStart } : {};
}

/**
 * THE LEDGER'S DELIBERATE-MUTATION MARKER, READY TO SPREAD INTO A JUDGED-RUN
 * RECORD — `{ mutationRun: true }` when the run was launched with
 * `HARNESS_MUTATION_RUN=1`, `{}` when it was not.
 *
 * The channel is the ENVIRONMENT, like `RUN_SLOW` before it: a deliberate
 * mutation-verification run is identified by how the OPERATOR LAUNCHED it
 * (the agent plants a defect, runs the owning suite with the flag set, and
 * restores), not by anything the tree can derive — the tree IS the mutation
 * while the run is measuring it. `mutationRunMark()` and
 * `provisionalFailureMark()` are the two provenances a run's failure rows
 * can carry, both derived here so the runners spread one spelling of each
 * and a second derivation cannot drift.
 *
 * WHY THE FLAKY MEMORY MUST SKIP THESE ROWS ENTIRELY. A deliberate
 * mutation-verify run is EXPECTED to red — the red IS the verification
 * working — so its failures are evidence about the planted defect, never
 * about the committed code; and its PASSES are equally worthless as a mute,
 * because the tree it measured was deliberately wrong. The standing 2026-08-24
 * flaky suspect (a module-load failure that healed within minutes and never
 * recurred) was recorded by exactly such a run: an operator's verification
 * red read as the suite's flakiness for the whole lookback window.
 *
 * The exclusion is HONEST BY DEFAULT: a row that does not carry the marker —
 * an ordinary failure, a legacy entry recorded before the marker existed, a
 * malformed flag — counts as a REAL failure in both directions, exactly as
 * it always did. The marker can only ever be set by the operator who wants
 * their own deliberate red excluded; nothing in the tree sets it for them.
 */
export function mutationRunMark(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<{ mutationRun: true }> | Readonly<Record<string, never>> {
  return env.HARNESS_MUTATION_RUN === "1" ? { mutationRun: true } : {};
}
