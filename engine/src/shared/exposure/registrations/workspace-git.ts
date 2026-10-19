/**
 * Shared exposure registrations — `workspaceGit` module.
 *
 * The workspace git doors: how long the harness's own git operations may run
 * when the workspace command acts on the user's files, and —
 * shown read-only — which git executable those doors pin and execute.
 *
 * THE DISPOSITION DOCTRINE (this section's census, tests/prevention/
 * exposure-reachable.test.ts): the section declares 57 leaves; exactly four
 * have file-fed consumers reachable from a production door today. The three
 * timeout run bounds register as writable rows — no verdict depends on them,
 * a shorter bound fails closed (the typed git-failed error), the same class
 * the benchmark run bounds belong to. The executable path is served as a
 * READ-ONLY signal and pinned never-writable: it names the binary the
 * harness pins through the TOCTOU guard and executes on the user's workspace,
 * and the pinned-process machinery protects against the binary being swapped
 * after resolution, not against the path naming something else — the
 * executable-path settings class (VS Code restricts exactly this shape:
 * "paths to executables … if set to point to malicious code, could cause
 * damage"), so choosing it stays a write-the-file decision made by somebody
 * with access to the machine. Every other leaf is FILED with its reader
 * evidence by the census — most are declared-but-unconsumed, and the
 * transport/never-push/credential families additionally need their own safety
 * review before any of them could become writable rows.
 *
 * THE HONEST TIMING: every consumer of these rows is an engine command door
 * (the workspace command) — a fresh process that
 * resolves the pinned config document once per invocation, so a settings
 * write lands in the file and the NEXT run of the consuming command reads it
 * (the benchmark/diagnostic precedent for the tier).
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import {
  readNumberCustomization,
  readStringCustomization,
  writeConfigCustomization,
} from "../config-binding.ts";
import { DEFAULT_GIT_INSPECT_TIMEOUT_MS } from "../../../git/git-config.ts";
import { GIT_COMMIT_TIMEOUT_MAX_MS } from "../../../kernel/config-contracts.ts";
import { HarnessError } from "../../../kernel/errors.ts";
import {
  DEFAULT_GIT_ADD_TIMEOUT_MS,
  DEFAULT_GIT_COMMIT_TIMEOUT_MS,
} from "../../../workflow/workflow-config.ts";

/**
 * The honest absence for the pinned-executable fact. When the config leaf is
 * absent, the next command run resolves git from the machine's PATH — a
 * discovery that belongs to the consuming process, not to this registration.
 * Reading it HERE would import the resolver (which spawns `which`) into
 * every host that registers the exposure surface, widening the server's
 * process-capable import closure for a fact only a fresh run can know; the
 * signal states the absence in words instead, the same honest-absence
 * contract as a lane that recorded nothing reading zero.
 */
const GIT_EXECUTABLE_DISCOVERED_AT_RUN_TIME = "discovered from the machine's PATH at run time";

/**
 * The harness checkout's own git state, installed by the host that owns the
 * checkout (the engine's own processes: `src/git/index-baseline.ts`,
 * `src/git/declared-deletions.ts` and `src/filesystem/journaled-commit.ts`
 * over its own checkout). The
 * registration itself imports no process or filesystem code — it is also
 * loaded by the browser build — so the answers arrive through this source;
 * with none installed the rows read `unmeasured` and the actions refuse.
 */
export type WorkspaceGitStateSource = Readonly<{
  /** One line: unrecorded, clean with the protected count, or drifted with the lost paths. */
  liveIndexState: () => string;
  /** One line: none, or each journal by name with its state. */
  journals: () => string;
  /** `harness index record` over the checkout. */
  recordIndex: () => unknown;
  /** `harness index repair` over the checkout. */
  repairIndex: () => unknown;
  /** One line: none, or how many deletion declarations are pending, stale, mismatched, expired or consumed. */
  declaredDeletions: () => string;
  /** `harness deletions declare <path>` over the checkout (one literal path). */
  declareDeletion: (path: string) => unknown;
  /** `harness deletions clear` over the checkout. */
  clearDeclaredDeletions: () => unknown;
  /** One line: none, or how many files the evidence manifests record and how many of their objects the store lacks. */
  evidence: () => string;
  /** One line: where the evidence store is and what named it (`HARNESS_EVIDENCE_HOME`, or the default). */
  evidenceStore: () => string;
  /** `harness evidence verify` over the repository (every tracked manifest). */
  verifyEvidence: () => unknown;
  /** `harness evidence materialize <path>` over the repository (one recorded path, or a folder of them). */
  materializeEvidence: (path: string) => unknown;
  /** One line: none, or the repository's unfinished and quarantined workspaces by state (the registry in its git common dir). */
  workspaces: () => string;
  /** `harness workspace sweep` over the repository. */
  sweepWorkspaces: () => Promise<unknown>;
}>;

let gitStateSource: WorkspaceGitStateSource | null = null;

/** Install the checkout's git-state source (the web server, at boot). */
export function installWorkspaceGitStateSource(source: WorkspaceGitStateSource): void {
  gitStateSource = source;
}

const NO_GIT_STATE_SOURCE = "unmeasured";

/** The installed source, or the typed refusal an action raises without one. */
function requireGitStateSource(): WorkspaceGitStateSource {
  if (gitStateSource === null) throw new HarnessError("no host installed the checkout's git state in this process (the web server does not; the engine CLI does)", "workspace_git_state_unavailable");
  return gitStateSource;
}

let workspaceGitRegistered = false;
export function registerWorkspaceGitExposure(): void {
  if (workspaceGitRegistered) return;
  workspaceGitRegistered = true;

  registerExposureModule({
    id: "workspaceGit",
    title: "How the harness works with git on your machine",
    purpose:
      "The bounds on the harness's own git operations when it acts on your workspace, and the git executable those operations pin.",
  });

  // --- Customizations (3: the live timeout run bounds) ---
  // Each consuming door resolves the pinned config document once per command
  // invocation (a fresh process per run), so a settings write lands in the
  // file and the NEXT run of the consuming command reads it — which is what
  // each row's `next-run` effect states.
  registerCustomization({
    id: "workspaceGit.timeoutsInspectMs",
    module: "workspaceGit",
    name: "How long one repository inspection may run",
    description:
      "Every workspace command inspects a repository before acting on it — worktree checks, status reads, head lookups. Lower = a stuck git call is abandoned sooner; higher = a slow repository still gets its answer. Takes effect on the next workspace run.",
    type: "number",
    default: DEFAULT_GIT_INSPECT_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
    current: () => readNumberCustomization("workspaceGit.timeouts.inspectMs", DEFAULT_GIT_INSPECT_TIMEOUT_MS),
    set: (v) => writeConfigCustomization("workspaceGit.timeouts.inspectMs", v),
    contract: { effect: "next-run" },
    configPath: "workspaceGit.timeouts.inspectMs",
  });
  registerCustomization({
    id: "workspaceGit.timeoutsAddMs",
    module: "workspaceGit",
    name: "How long one worktree operation may run",
    description:
      "Adding, removing and switching a workspace's worktree, and landing it, is bounded by this. Lower = a stuck worktree operation is abandoned sooner; higher = a large checkout still completes. Takes effect on the next run.",
    type: "number",
    default: DEFAULT_GIT_ADD_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
    current: () => readNumberCustomization("workspaceGit.timeouts.addMs", DEFAULT_GIT_ADD_TIMEOUT_MS),
    set: (v) => writeConfigCustomization("workspaceGit.timeouts.addMs", v),
    contract: { effect: "next-run" },
    configPath: "workspaceGit.timeouts.addMs",
  });
  registerCustomization({
    id: "workspaceGit.timeoutsCommitMs",
    module: "workspaceGit",
    name: "How long one commit may run",
    description:
      "Creating a commit — the workspace command's merge commit, which runs the repository's commit hooks — is bounded by this. Lower = a hung commit is abandoned sooner, leaving the step uncommitted and reported; higher = a slow hook or large change still completes. Takes effect on the next run.",
    type: "number",
    default: DEFAULT_GIT_COMMIT_TIMEOUT_MS,
    min: 1,
    max: GIT_COMMIT_TIMEOUT_MAX_MS,
    unit: "milliseconds",
    current: () => readNumberCustomization("workspaceGit.timeouts.commitMs", DEFAULT_GIT_COMMIT_TIMEOUT_MS),
    set: (v) => writeConfigCustomization("workspaceGit.timeouts.commitMs", v),
    contract: { effect: "next-run" },
    configPath: "workspaceGit.timeouts.commitMs",
  });

  // --- Signals (1: the pinned executable, read-only) ---
  // The path names the binary the git doors pin and execute on the user's
  // workspace. The room shows which binary the next run will pin; choosing a
  // different one stays a deliberate file edit by somebody with access to
  // the machine — the executable-path settings class, where a writable row
  // would let a settings cookie point the harness at arbitrary code.
  registerSignal({
    id: "workspaceGit.gitExecutablePath",
    module: "workspaceGit",
    name: "Git executable the workspace doors pin",
    description:
      "The git binary the workspace command pins through the tamper-guard and execute. Shown read-only: choosing a different executable is a machine-admin decision made in the config file, not a settings-room write.",
    type: "string",
    value: () => readStringCustomization("workspaceGit.gitExecutablePath", GIT_EXECUTABLE_DISCOVERED_AT_RUN_TIME),
  });

  // --- The harness checkout's own git state (src/git/index-baseline.ts,
  // src/filesystem/journaled-commit.ts): the same answers as
  // `harness index status` and `harness check`'s `journals` step. ---
  registerSignal({
    id: "workspaceGit.liveIndexState",
    module: "workspaceGit",
    name: "Staged work only the index holds",
    description:
      "Whether every staged blob HEAD does not hold (recorded in the index baseline) is still staged: unrecorded, clean with how many are protected, or drifted with the paths lost. A commit never makes it drift; after HEAD moves the record advances by itself.",
    type: "string",
    value: () => gitStateSource?.liveIndexState() ?? NO_GIT_STATE_SOURCE,
  });
  registerSignal({
    id: "workspaceGit.declaredDeletions",
    module: "workspaceGit",
    name: "Deletions declared on purpose",
    description:
      "Deletions declared deliberate for the next commit (src/git/declared-deletions.ts): none, or how many are pending (the commit guard accepts exactly that path with that blob while HEAD has not moved, the path is still gone and no copy nobody declared appeared), stale (HEAD moved since, even back to the same commit: refused for good), mismatched (the file changed since: refused), expired (something is at the path again: refused) or consumed (the commit landed).",
    type: "string",
    value: () => gitStateSource?.declaredDeletions() ?? NO_GIT_STATE_SOURCE,
  });
  registerSignal({
    id: "workspaceGit.journals",
    module: "workspaceGit",
    name: "Multi-file writes left for recovery",
    description:
      "Journaled multi-file writes under the harness checkout: none, or each by name as in-progress (its owner is running), abandoned (the owning tool recovers it on its next run) or unreadable (needs a person).",
    type: "string",
    value: () => gitStateSource?.journals() ?? NO_GIT_STATE_SOURCE,
  });
  registerSignal({
    id: "workspaceGit.evidence",
    module: "workspaceGit",
    name: "Evidence kept outside git",
    description:
      "Raw evidence the repository's records cite but git does not hold (src/workflow/evidence-store.ts): none, or how many files the evidence manifests record and whether each one's bytes are in the evidence store (a presence check; the verify action proves the bytes).",
    type: "string",
    value: () => gitStateSource?.evidence() ?? NO_GIT_STATE_SOURCE,
  });

  registerSignal({
    id: "workspaceGit.evidenceStore",
    module: "workspaceGit",
    name: "Where the evidence store is",
    description:
      "The evidence store's folder and what named it — the boot setting HARNESS_EVIDENCE_HOME (an absolute folder), or the default $XDG_DATA_HOME/bridlewise/evidence, else ~/.local/share/bridlewise/evidence. Read-only: set it before the process starts. Wherever it is, it is kept out of every confined command (src/filesystem/private-home.ts).",
    type: "string",
    value: () => gitStateSource?.evidenceStore() ?? NO_GIT_STATE_SOURCE,
  });

  registerSignal({
    id: "workspaceGit.workspaces",
    module: "workspaceGit",
    name: "Isolated workspaces of this repository",
    description:
      "The repository's workspaces (`harness workspace`, `npm run ws`; the registry lives in its git common directory): none, or each unfinished one by state — admitted, active, validating, merging — and each quarantined one kept for inspection, with its id.",
    type: "string",
    value: () => gitStateSource?.workspaces() ?? NO_GIT_STATE_SOURCE,
  });

  // --- Actions (7): the operator verbs of `harness index`, `harness deletions`, `harness evidence` and `harness workspace sweep` ---
  registerAction({
    id: "workspaceGit.recordIndexBaseline",
    module: "workspaceGit",
    name: "Record the staged work to protect",
    description: "Record the staged blobs HEAD does not hold as the index baseline, and pin them so git gc keeps them — after a deliberate change to what is staged.",
    execute: async () => requireGitStateSource().recordIndex(),
  });
  registerAction({
    id: "workspaceGit.repairIndex",
    module: "workspaceGit",
    name: "Restore lost staged work",
    description: "Re-stage exactly the recorded blobs that were dropped from the index with no commit taking their place. Never removes an entry and never reverses a commit.",
    execute: async () => requireGitStateSource().repairIndex(),
  });
  registerAction({
    id: "workspaceGit.declareDeletion",
    module: "workspaceGit",
    name: "Declare a deletion deliberate",
    description:
      "Record that the file at this exact repository-relative path is deleted on purpose, with the blob HEAD holds there and its ignored copies, so the next commit that stages exactly that deletion (while HEAD has not moved and no other copy appeared) passes the move-loss check even though the ignored copies stay on disk. The file must already be gone from the disk; a folder or a pattern is refused.",
    args: { path: { type: "string", required: true, description: "The repository-relative path of the deleted file, exactly as git prints it." } },
    execute: async (args) => requireGitStateSource().declareDeletion(String(args?.["path"])),
  });
  registerAction({
    id: "workspaceGit.sweepWorkspaces",
    module: "workspaceGit",
    name: "Sweep the workspaces",
    description: "End every workspace whose lease expired (quarantined when failures are preserved), recover every workspace whose integrator died mid-merge (finish a land that happened, else back to active), and remove the quarantined worktrees past their retention — `harness workspace sweep`.",
    execute: async () => requireGitStateSource().sweepWorkspaces(),
  });
  registerAction({
    id: "workspaceGit.verifyEvidence",
    module: "workspaceGit",
    name: "Check the stored evidence",
    description: "Prove that every file the evidence manifests record is in the evidence store, readable only by you, with exactly the recorded bytes and size — `harness evidence verify`. Names each missing, damaged or unsafe file (a link, a widened mode or a second name in the store is refused, never followed).",
    execute: async () => requireGitStateSource().verifyEvidence(),
  });
  registerAction({
    id: "workspaceGit.materializeEvidence",
    module: "workspaceGit",
    name: "Bring stored evidence back into the checkout",
    description: "Write a recorded evidence file (or every recorded file under a folder) back at its recorded path, from verified bytes and with its recorded mode — `harness evidence materialize`. Only paths inside a tracked manifest's own evidence folder are ever written (never .git or the hooks), through folders reached without following a link; git ignores the copy (the generated rule, refused while stale); a different file already at the path is never overwritten.",
    args: { path: { type: "string", required: true, description: "A recorded repository-relative path, or a folder of recorded paths, as the evidence manifest spells it." } },
    execute: async (args) => requireGitStateSource().materializeEvidence(String(args?.["path"])),
  });
  registerAction({
    id: "workspaceGit.clearDeclaredDeletions",
    module: "workspaceGit",
    name: "Withdraw every declared deletion",
    description: "Remove every deletion declaration of the checkout, whatever its state (pending, stale, mismatched or an unreadable record).",
    execute: async () => requireGitStateSource().clearDeclaredDeletions(),
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetWorkspaceGitRegistration(): void {
  workspaceGitRegistered = false;
}
