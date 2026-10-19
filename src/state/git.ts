/**
 * nanostores shared state: the latest git status snapshot.
 *
 * Fed ONLY by client.ts (`setGitStatus`) at the `getGitStatus` fetch — the
 * SAME response the GitPanel renders, so the module readout and the panel
 * describe one fetch, never two paths that can drift. This store is the
 * seam whose absence used to keep `legacy.git-panel` on the headline
 * exemption list.
 *
 * The snapshot records WHICH repository path it describes (`path`).
 * Consumers (the git readout projection) compare it to the currently
 * selected project, so a snapshot fetched for a previously selected
 * project is treated as "not checked yet" rather than presented as the
 * current project's state — staleness handled by data, not by timing.
 *
 * @global-store per-project, not per-chat: the snapshot is keyed by the
 * repository path it was fetched for, and consumers compare that path to
 * the current project — a chat switch changes nothing about the working
 * tree, and a project switch is handled by the path mismatch reading as
 * "not checked yet" rather than by a timing-dependent reset.
 *
 * Plain .ts — Node-testable via Vitest.
 */

import { atom, type WritableAtom } from "nanostores";

import { registerReset } from "./store-registry";

/** One changed file in the working tree, as the server reports it. */
export type GitStatusEntry = Readonly<{
  status: string;
  path: string;
  staged: boolean;
}>;

/** The git status the server returned, tagged with the repo path asked. */
export type GitStatusView = Readonly<{
  /** The project path this status was fetched FOR (identifies the repo). */
  path: string;
  /**
   * FALSE when the path is not a git repository at all — a different fact
   * from the zeroed counts beside it. A reader that maps `branch: null` to
   * "detached" and `dirtyFiles: 0` to "clean" fabricates two facts about a
   * folder with no repository; this field is what lets the surface say the
   * honest "not under version control" instead (the custody room's own
   * wording for the same state).
   */
  repository: boolean;
  branch: string | null;
  dirtyFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  entries: readonly GitStatusEntry[];
}>;

/** `null` until the first successful fetch — "not checked yet", which is a
 * DIFFERENT fact from a clean working tree. */
export const gitStatus: WritableAtom<GitStatusView | null> = atom<GitStatusView | null>(null);

/**
 * The established words for the no-repository fact — the single owner of the
 * sentence on the client. A wire names the fact (`repository: false`) and
 * may serve none of its own words; a surface then renders these instead of
 * inventing a local copy (the custody room and the run pane render the same
 * fact, and the effect beat's diff face joins them here rather than
 * forking the words a third time).
 */
export const NOT_A_REPOSITORY = "this project's folder is not under version control";

export function setGitStatus(view: GitStatusView | null): void {
  gitStatus.set(view);
  // One path has exactly one standing read state: a measured answer retires
  // the refusal that was standing for THE SAME path (a refusal for another
  // path is not this path's answer and must survive a project switch).
  const standing = gitRefusal.get();
  if (standing !== null && (view === null || standing.path === view.path)) {
    gitRefusal.set(null);
  }
}

// ── The refused read ─────────────────────────────────────────────────────────
//
// A refused git read (self-protection's typed 503) is a DIFFERENT fact from
// "not checked yet": the read was attempted, and the server said no, with a
// sentence. Rendering it as the generic absence would claim nobody looked;
// the pane renders the server's own words instead (the same honesty the
// custody room holds for its refusal). Keyed by path like the measured view,
// so the same staleness-by-data rule applies: a refusal for a previous
// project never reads as the current project's answer.

/** The typed refusal a git read answered with, tagged with the path asked. */
export type GitRefusalView = Readonly<{
  /** The project path this refusal was fetched FOR. */
  path: string;
  /** The server's own sentence (the way out is inside it). */
  reason: string;
}>;

/** The latest refused git read, or null when none is standing. */
export const gitRefusal: WritableAtom<GitRefusalView | null> = atom<GitRefusalView | null>(null);

export function setGitRefusal(view: GitRefusalView | null): void {
  gitRefusal.set(view);
}

/**
 * Reset to the unfetched state. Called by the single store-reset owner
 * (`resetAllStores`) on logout so a re-login as a different user never
 * sees the previous user's repository state.
 */
export function resetGitStatus(): void {
  gitStatus.set(null);
  gitRefusal.set(null);
}

registerReset("git", resetGitStatus);
