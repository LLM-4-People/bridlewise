# Workflow

The workflow domain: the harness commands, module registrar, the generation
and verification pipeline, and ISOLATED WORKSPACES — how a change is made,
gated and landed (`harness workspace`, development root alias `ws`).

## Workspaces (`harness workspace`)

Run these commands from the engine package root of the development checkout.

```bash
node src/cli.ts harness workspace create --agent <name> --write-set <path…> [--target <branch>] [--base <ref>]
node src/cli.ts harness workspace create --agent <name> --overlay [--write-set <path…>]
node src/cli.ts harness workspace create --agent <name> --read-only [--base <ref>]
node src/cli.ts harness workspace extend <id> --write-set <path…>
node src/cli.ts harness workspace validate <id> [--full]
node src/cli.ts harness workspace merge <id>
node src/cli.ts harness workspace recover <id>
node src/cli.ts harness workspace abort <id> [--quarantine]
node src/cli.ts harness workspace snapshot <id> --label <label>
node src/cli.ts harness workspace list | status <id> | sweep
```

Every command prints one JSON result (`{"result":{…}}`: the record, the
validation report, the merge receipt) and its progress on stderr. The flow is
stated once, in `workspace-manager.ts`'s header and in
[WORKFLOW.md, Isolated workspaces](../../../docs/process/WORKFLOW.md#isolated-workspaces-binding);
the refusals and the land in [MERGE-GUIDE.md §1b](../../../docs/process/MERGE-GUIDE.md).

- **Registry**: `<git common dir>/bridlewise/` (`repository-registry.ts`, the one derivation; the records in `workspace-registry.ts`):
  `workspaces/<id>.json`, `locks/` (the admission and merge locks),
  `timeline/` (the shards and the integrator's ledger) — one per repository,
  the same from every worktree. The `workspaceGit.workspaces` signal reads it;
  the `workspaceGit.sweepWorkspaces` action sweeps it (and recovers a dead
  integrator's workspace). Every record write is a compare-and-swap on its
  `revision` (`workspace_record_changed`).
- **Configuration**: `workspaceIsolation` (`engine/bridlewise.config.json`):
  `workspaceRoot` (relative to the repository home), `branchNamespace`,
  `baseStalenessCommits`, `preserveOnFailure`, `quarantineTtlMs`,
  `leaseTtlMs`, `admissionLock`, `mergeLock`, `landTargets` (the only
  branches a workspace lands on; not writable over HTTP), `killGraceMs`,
  `links`, `commands` (`cwd`, `argv`, `timeoutMs`, setup `inputs`, gate
  `changed`, gate `ledger`: the suite (`engine`|`web`, its path owned by
  `suiteLedgerPaths`) whose run is judged against the target tip's clean
  baseline — measured like for like in the workspace when none exists — no
  new or changed failure) and
  `phases` (`setup`, `validate`, `regenerate`, `merge`); the timeouts of the
  git operations are `workspaceGit.timeouts` (`commitMs` bounds the merge
  commit, whose hooks run the commit guard).

The test result collector owns the redacted native error projection shared by inventory accounting and immutable result receipts. It preserves outer and nested causes, failure type, assertion values and source location while keeping historical failure identities stable. Native timeout/abort outcomes count as cancellations once; saved diagnostic details must correspond exactly to the named failed or cancelled outcomes.

## Promotion (`harness promote`)

```bash
node src/cli.ts harness promote status  [--profile <name>] [--source <rev>] [--json|--text]
node src/cli.ts harness promote plan    [--profile <name>] [--source <rev>] [--diff] [--patch] [--json|--text]
node src/cli.ts harness promote explain [--profile <name>] [--source <rev>] [--json|--text] <path>…
node src/cli.ts harness promote apply   [--profile <name>] [--source <rev>] [--no-publish | --no-push]
                           [--accept-target-edits <path>… --reason <text>] [--allow-deletions --reason <text>]
                           [--release-hold --reason <text>]
node src/cli.ts harness promote rollback [--profile <name>] --to <promotion commit> --reason <text>
node src/cli.ts harness promote hold | release-hold [--profile <name>] --reason <text>
node src/cli.ts harness promote auto --refs <ref>…        # the reference-transaction hook's entry
```

A promotion carries a source branch to a target branch through a declared,
versioned PROFILE (`<promotion.profileDirectory>/<name>.json` on the source,
always read from the source commit): the target's tree is a projection of the
source's, never a merge — `promotion/` (`profile.ts`, `projection.ts`,
`transforms.ts`, `codes.ts`, `context.ts`, `apply.ts`, `promotion-run.ts`,
`publication.ts`, `rollback.ts`, `trailers.ts`, `last-run.ts`, `trigger.ts`,
`trigger-hook.ts`, `promoter-home.ts`, `promote-arguments.ts`,
`promote-cli.ts`; its README; the runbook `docs/process/MERGE-GUIDE.md`). The read verbs are pure: `plan` writes objects (the derived blobs, the tree
P — built in a private index of its own per call and read back before it is
answered), the lockfile memo and per-call scratch and the target-edit patch
under the registry's `promotion/<profile>/` area, and no ref, index or
checkout. Every answer is the harness envelope whose `result` is `{ok, code,
class, message, remedy, data}`; the exit code is the class's (`codes.ts`;
several refusals: the most severe class answers). Every git call goes through
the tree readers' one door with the configured executable and ceiling
(`configuredGitRepository`). Configuration: `promotion.profileDirectory`; the
commands are the ONE registry's (`workspaceIsolation.commands`: `lockfile`,
`web-build` and the workspace gates); the refs and trailers are
`ROOT_POLICY.workflow.promotion`. Exposure: `registrations/promotion.ts`.

`apply` (`apply.ts`), under the target ref's lock (the registry's `locks/`, a
live holder never broken; the wait is `resourceLock`; an unattended run never
waits): the remote reconciled (`publication.ts`: the remote's source, target
and hold fetched — a target behind is fast-forwarded, one ahead carried, one
apart refused), the hold, the pending ref reconciled (one the remote already
carries is finished, never rebuilt), the plan's refusals except the two a
reasoned flag accepts (the target's direct edits with EXACTLY the plan's
list; the deletion budget); then the TREE LANDING (`tree-landing.ts`) builds
a candidate worktree in the repository-scoped promotion folder
`promote-<repository id>/<profile>-<plan id>` under
`workspaceIsolation.workspaceRoot` (on the repository's filesystem), settles
it (the profile's `setup`, `converge` to a fixed point, the declared-writes
check, `verify`) and makes ONE commit there — the repository's hooks run on
the exact tree — with parents `[T, S]`, S's committer identity and date (the
same inputs give the same commit, with no git identity configured) and the
trailers `Promoted-From`, `Promotion-Profile` (and
`Promotion-Accepted-Target-Edits`). It is pinned by
`<namespace>/<profile>/pending` and described by a receipt blob
(`promotion-receipt/v1`, each command's evidence, no timing) at
`<namespace>/<profile>/receipts/<C>`. `--no-publish` answers there. Then the
publication (`publishCommit`): ONE `git push --atomic` of C, its receipt and
a lagging source (never forced; one rejection because the remote moved
re-plans once), verified by `ls-remote` (C, or a tip that carries it); then the checkout holding the target
fast-forwarded — a fast-forward a crash left torn is completed, edits of its
own on the changed paths PARK it (exit 7; nothing there touched), a locked
index is `promotion_target_index_locked` — and finished (`finishPromotion`:
the config mode, the candidate's pinned build outputs installed as one
journaled transaction, the index baseline, the setup the new tree needs
named, `depsStale`). `--no-push` publishes locally. A rerun is the resume:
every decision is derived from the refs and trailers. A rollback
(`rollback.ts`) is a new commit restoring an earlier promotion's tree
(`Promotion-Restores`), built and published the same way, with the hold
pushed atomically beside it; `hold`/`release-hold` pause and resume. The
trigger: `.githooks/reference-transaction` (`trigger-hook.ts`) runs `promote
auto` in the background when a push or fetch moves a remote-tracking ref;
`trigger.ts` starts one unattended `apply --auto` per profile whose source
moved and whose `trigger` is `on-source-publish` (each with a log of its own),
and prints ONE line for a profile whose last run (`last-run.ts`) did not end
ok; every top-level `apply` then owes the chain (latest wins: once it ended
and its locks are released, a remote source tip its S does not contain goes
through the same trigger rules; never from the promoter home's child, never after a hold
or a coalesced run). Every failure is typed
(a git step's too: `promotion_git_errored` when the machine ended it,
`promotion_git_failed` otherwise; an error no code names is
`promotion_unexpected`), and the sweep and the `promotion.refused` audit
always run: a failed candidate is kept (alone) while
`workspaceIsolation.preserveOnFailure`, and always when the answer is
integrity's (the evidence). The plan's memos and patches the latest plan did
not use are swept under the lock. `apply` runs S's own promoter
(`promoter-home.ts`): here when this engine's checkout is clean at S (or
`HARNESS_PROMOTER_HOME` names it, or the promoted repository does not host
this engine), else re-executed through the engine's CLI entry (`src/cli.ts
harness promote … --source <S>`) in the detached home `<profile>-home` in the
promotion folder at S, under the home's lock (`promotion-home-<profile>`),
prepared with the setup commands whose inputs lie under the engine's folder
— re-run when their inputs changed since the last source whose preparation
PASSED (recorded in the promotion area only after it passed).

## Tree landing (`tree-landing.ts`)

The one owner of how a computed tree becomes a commit on a branch: the
promotion's candidate, settle and commit, and the land, branch lookup,
undeclared-write rule and filesystem check `harness workspace merge` shares (its
merge runs its own phase order — the regenerate phase once, which `harness sync`
converges itself — and judges what it wrote by the one rule,
`refuseUndeclaredWrites`, PROMO2FIX-M3): the candidate
(`createCandidate`: a detached worktree at T, `merge -s ours --no-commit S`,
`read-tree -u --reset P`, checked), the settle (`settleCandidate`: the checkout
files, setup, converge until a pass changes nothing — an oscillation or the
bound (one pass per generated output plus one: `convergeUntilStable`, the one fixed-point loop `harness sync` runs too) is `not_converged` — the
declared-writes check over the staged tree (`refuseUndeclaredWrites`), verify, and verify wrote nothing),
the commit (`commitCandidate`: hooks run; its tree, parents and objects
checked; the hooks' words answered — the workspace merge's commit too), the
land (`landCommit`: fast-forward in the checkout that has the branch — one a
crash left torn mid fast-forward is completed with git alone (the commit's
entries staged for the paths already holding them and staged as the old tip
or the commit records them — a version staged there that is neither is the
checkout's own work, never overwritten —, then `read-tree -m -u` and a
compare-and-swap of the ref) —, else a compare-and-swap `update-ref`;
git's refusal is data, with the overlapping paths and a locked index named —
the workspace merge lands through it), the push verdict (`pushVerdict`: a
`git push --porcelain` answer read per ref: pushed, rejected because the
remote moved, refused by the remote, or errored), and the sweep
(`sweepCandidates`). Every phase runs in `runLandingPhase` (one log line at its
start and end, with its duration and code); a refusal is a `LandingError` of a
`LandingFailure` kind the consumer maps to its own code, a git step's failure
included (`landingGitFailure`, over both git doors: the machine's — a ceiling,
a signal, an environmental error in git's words, by the command runner's own
rule — is `git_errored`, git's refusal `git_failed`).

## What each file does

- `auto-generator.ts` — the auto-generator module; `currentConfigContractArtifact`
  builds the config-contract artifact from the ON-DISK root-policy pins, so a
  regenerate that re-pins the contract source converges in one pass.
- `format-command.ts` — the format-command module.
- `command-result.ts` — THE HARNESS COMMAND ENVELOPE (`wrapResult`, `parseHarnessCommandResult`, `HarnessCommandResult`, the schema id, `resultHasFail`) and THE ONE OUTPUT OPTION of every verb (`takeOutputFormat`: `--json`, the default, or `--text`, taken out of every verb's argv by the dispatch; `CommandAnswer`, `renderCommandAnswer`, `commandExitCode`, the generic `envelopeText` report): a leaf, so the command doors (`workspace-cli.ts`, `promotion/promote-cli.ts`) never import `harness-commands.ts` back — that module is an entry point with a top-level await, and the cycle made it exit 13 with no output.
- `harness-commands.ts` — the harness-commands module. `harness check` also
  verifies convergence: the config-schema artifact and the source-authority
  pins must already be what `harness regenerate` would write. The checkout's
  git-state verbs are thin doors over their owners in `src/git/`:
  `harness index status|record|repair` (the live index baseline) and
  `harness deletions declare [--paths-file <file>] <path>… | status | clear`
  (the declared deletions the commit guard's move-loss check accepts).
- `hash-binding-registry.ts` — the hash-binding-registry module; also the generated-output sets
  (`generatedOutputPaths`, `wholesaleGeneratedPaths`) and THE answer to "is this change regeneration only?"
  (`isGenerationOnlyChange` over `stripGeneratedParts`: pins and generated blocks blanked), which the
  workspace lease, its merge checks and its conflict resolution share.
- `evidence-store.ts` — THE EVIDENCE STORE, a manifest layer and nothing more: the store is a per-user private home of the one private-home owner (`src/filesystem/private-home.ts`; `ROOT_POLICY.workflow.evidenceStore`: `$HARNESS_EVIDENCE_HOME`, else `$XDG_DATA_HOME`/`~/.local/share` + `bridlewise/evidence`; kept out of every confined process wherever it is) and its objects are the immutable owner's content-addressed files (`src/filesystem/immutable-receipt.ts`: 0600 in 0700, never replaced, a link anywhere refused). A committed, generated manifest (`evidence-manifest.json`, wherever git tracks one, one entry per line) records each file's path, sha256, size and git mode; every path lies in the manifest's own `evidence/` folder (never `.git` or the hooks), refused when the manifest is read. `harness evidence ingest --manifest <file> <path>…` stores and records (idempotent; a recorded path never takes other bytes), `verify` proves every recorded object present, private and byte-exact, `materialize <path>…` writes recorded files back through folders reached without following a link (a different file is never overwritten). The root `.gitignore`'s evidence block is GENERATED from the manifests (`syncEvidenceIgnore`: ingest and `harness sync` write it, `harness check`'s `evidence-ignore` step fails when stale, materialize refuses while it is). Exposed as the `workspaceGit.evidence` and `workspaceGit.evidenceStore` signals and the `verifyEvidence` / `materializeEvidence` actions; every verb is an audit event.
- `record-links.ts` — RECORD LINKS: the one Markdown link extraction (`markdownLinks`) and resolution (`deadLinkReason`: a file or folder of the tree, or `evidence:<recorded path>`), and the repository scan (`deadMarkdownLinks`) of the `dead-markdown-links` ratchet — `harness check`'s `ratchet-baselines` step fails on a new dead link.
- `module-contract-blocks.ts` — reads the architecture manifest's `moduleContract({...})` blocks as data from its TEXT (AST; any property order; only module blocks): the registrar's composition-root derivation and any guard that needs module ids use it, so nothing imports the ~480 KB generated manifest just to read its identities.
- `module-registrar.ts` — the module-registrar module: registers every source module in the architecture manifest, corrects drift (exports, dependencies) and derives the `compositionRoots` lists from the blocks. A module the detector sees as a direct-execution entrypoint (`import.meta.url === …process.argv…`) is marked a composition root whenever it became one, not only at its first registration; roots the detector cannot see (top-level programs, worker entries) are declared and never unmarked.
- `resource-lock.ts` — named resource locks (the test lock, the workspace lock, a promotion's target lock): where a resource's lock lives, its typed timeout (`LockAcquisitionTimeout`) and handle, and the options the configuration declares (`configuredLockOptions`: `resourceLock`), and which resources are locked in a directory now (`lockedResources`: `harness check`'s promotions step); the lock itself is the one file lock (`src/filesystem/file-lock.ts`: a live holder is never broken).
- `tree-landing.ts` — THE TREE LANDING (see its section above): candidate, settle, commit, land, sweep, the phase runner and `LandingError`.
- `test-inventory-binding.ts` — the test-inventory-binding module.
- `test-result-collector.ts` — the test-result-collector module.
- `timeline-shard.ts` — a workspace's timeline shard and its bounded import into the integrator's ledger.
- `workflow-config.ts` — Workflow operational defaults — the single source of truth for all; also the readers `commandRetryPolicy` and `worktreeOperationTimeouts` (the git ceilings of a worktree's owner: the workspace CLI and the promotion).
- `slot-cli.ts` — `harness slot run -- <command>`: the shell's door to the host's one instrument lock (src/process/instrument-lock.ts); the command runs under the native supervisor, adopted into the hold.
- `flaky-burn-down.ts` — THE FLAKY MEMORY'S SHRINK-ONLY BURN-DOWN LIST (UR-19): a red suspect passes the guard only as an entry owned by an open task row naming its test and the guard, added by the commit that added that row; a new suspect, a closed or mis-naming owner, or an entry added without its row fails; nothing ages out.
- `flake-cli.ts` — `harness flake`: THE ONE DOOR that records what explains a flaky suspect (FLAKE-REPRO). `reproduce` refuses a fix that changed no declared cause's meaning, then runs the tests at the fix's parent and at the fix in a private worktree set up by `prepareCheckout`, inside the instrument lock, every run under one set of conditions (environment, setup, a command alongside, a preloaded shim, an order seed), once per side or N times (`--statistical`, the configured N), and records each test that failed on the parent and passed every run on the fix. `move` records a test's move to the live suite after reading the test inventories.
- `workspace-cli.ts` — `harness workspace <subcommand>`: the composition root (the pinned git port, the supervised command runner, the registry's timeline).
- `workspace-contracts.ts` — the closed, versioned records: the lease (feature, overlay, read-only), the validation report, the conflict report, the hashed merge receipt; the state machine; the derived never-leasable set.
- `workspace-manager.ts` — the lifecycle and the integrator: land targets, admission, create (+ overlay, read-only), extend, validate (`--full`), the like-for-like ledger baseline, merge in the workspace, the land (fast-forward, compare-and-swap, overlay adoption), recover (a dead integrator), abort, sweep, snapshot.
- `workspace-registry.ts` — the workspace records (the registry's `workspaces/` area) and their store; `workspaceRegistrySummary` for the signal.
- `repository-registry.ts` — THE REPOSITORY REGISTRY: one home per repository for the state every checkout shares, `<git common dir>/<product name>/` (`repositoryRegistry`, `resolveRepositoryRegistry` asked through the pinned port), and its areas (`workspaces/`, `locks/`, `timeline/`, `promotion/`: `repositoryRegistryArea`); `workspaceRootOf`, where the worktrees live (workspaces, a promotion's candidates and its promoter home). Runs no process.
- `reachability.ts` — the reachability walk (moved from the testing floor's census; the census calls it): which files entry points (and `seeds`: modules shipped without an edge) reach through import, `require`, URL, glob (arrays, `{a,b}`, `**` at any depth), stylesheet, symbolic-link and declared spawn edges, read from tokens (`src/intelligence/js-tokenizer.ts`), batched by rounds; what it cannot follow is reported (unresolved, into an excluded path, missing entries, packages, and OPAQUE edges: a computed `import()`/`require()`/glob/spawn argument, a glob matching nothing); tsconfig path aliases; `reachabilityChain` for an explanation; `isWalkableModule`.
- `checkout-setup.ts` — the ONE owner of what a private checkout runs: the checkout files (`links`, the config mode: `applyCheckoutFiles`, also the commit guard's), the ONE supervised command runner (`runCheckoutCommand`: `{changed}`, the ceiling; a failed step's class, `errored` — the environment ended it, or a line of its output REPORTS an environmental error (`ROOT_POLICY.workflow.commandRunner.environmentalErrorCodes`: npm's `code`/`errno` line, an uncaught `Error: <code>`) — or `failed`; an errored run retried by the runner's own policy with a doubling backoff; every attempt logged once), its ONE construction `configuredCheckoutCommandRunner` (the supervisor, the kill grace, the gate tail and `commandRetryPolicy(document)`: `harness.commandErroredRetries` / `commandRetryBackoffMs` — used by the workspace CLI, the candidate checkout and the promotion, so every phase, gate and lockfile derivation rides out an errored run alike), the dead-command rule (`unconsumedCommands`: run by no phase and no promotion profile; judged by `harness check`'s `dead-commands` step), fail-fast sequences of declared commands (`runDeclaredCommands`, the one sequencer: a workspace phase `runCheckoutPhase`, a promotion profile's phases), the setup (`prepareCheckout`) and its re-run on changed `inputs` (`rerunChangedSetup`, optionally narrowed: the promoter home runs the engine's own), and where a private checkout may live (`assertSameFilesystem`: the candidate checkout, the workspace root, a promotion's candidate and home); used by `harness workspace`, the candidate checkout and the promotion. It owns the ONE fixed-point loop (`convergeUntilStable`, its bound `convergeBound`, `NotConvergedError`, the convergence report) the candidate's settle and `harness sync` both run, and each step's evidence (argv, cwd, attempts, duration, the load it met).
- Generators write through the shared write primitive `atomicWriteFile`, whose checkout write door (`src/filesystem/checkout-write-door.ts`) refuses a test process — or any descendant of one — writing a file the checkout under test owns.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/`.

- `auto-generator.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `checkout-setup.ts` is consumed by `engine/scripts/commit-guard.ts`, `engine/scripts/tooling/candidate-checkout.ts`, `engine/src/workflow/flake-cli.ts`, `engine/src/workflow/harness-commands.ts`, `engine/src/workflow/promotion/apply.ts`, `engine/src/workflow/promotion/context.ts` and 8 more.
- `command-result.ts` is consumed by `engine/scripts/commit-guard.ts`, `engine/src/evaluation/cli.ts`, `engine/src/performance/benchmark-cli.ts`, `engine/src/performance/diagnostic-cli.ts`, `engine/src/workflow/auto-generator.ts`, `engine/src/workflow/flake-cli.ts` and 5 more.
- `evidence-store.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `engine/src/workflow/flake-cli.ts`, `engine/src/workflow/harness-commands.ts`, `engine/src/workflow/record-links.ts`.
- `failure-owners.ts` is consumed by `engine/src/workflow/flaky-burn-down.ts`, `engine/src/workflow/workspace-manager.ts`.
- `flake-cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `flaky-burn-down.ts` is consumed by nothing yet.
- `format-command.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `harness-commands.ts` is consumed by `engine/scripts/tooling/candidate-checkout.ts`, `engine/src/cli.ts`.
- `hash-binding-registry.ts` is consumed by `engine/scripts/build-bundle.ts`, `engine/scripts/commit-guard.ts`, `engine/scripts/tooling/candidate-checkout.ts`, `engine/src/shared/tree-identity.ts`, `engine/src/workflow/auto-generator.ts`, `engine/src/workflow/harness-commands.ts` and 5 more.
- `module-contract-blocks.ts` is consumed by `engine/src/workflow/module-registrar.ts`.
- `module-registrar.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `reachability.ts` is consumed by `engine/src/workflow/promotion/projection.ts`, `engine/src/workflow/promotion/transforms.ts`.
- `record-links.ts` is consumed by `engine/scripts/commit-guard.ts`, `engine/scripts/verification/ratchet-baselines.ts`, `engine/src/workflow/harness-commands.ts`, `engine/src/workflow/workspace-manager.ts`.
- `repository-registry.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `engine/src/workflow/flake-cli.ts`, `engine/src/workflow/harness-commands.ts`, `engine/src/workflow/promotion/context.ts`, `engine/src/workflow/promotion/promotion-run.ts`, `engine/src/workflow/workspace-cli.ts` and 2 more.
- `resource-lock.ts` is consumed by `engine/src/workflow/harness-commands.ts`, `engine/src/workflow/promotion/apply.ts`, `engine/src/workflow/promotion/promotion-run.ts`, `engine/src/workflow/workspace-manager.ts`.
- `slot-cli.ts` is consumed by `engine/scripts/tooling/coverage.ts`, `engine/src/workflow/harness-commands.ts`.
- `test-inventory-binding.ts` is consumed by `engine/src/workflow/test-result-collector.ts`.
- `test-result-collector.ts` is consumed by `engine/scripts/tooling/flake-reproduction-reporter.ts`, `engine/scripts/tooling/inventory-test-run.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/test-guards.ts`, `engine/scripts/tooling/test-receipt.ts`, `engine/scripts/tooling/test-run-lock.ts` and 6 more.
- `timeline-shard.ts` is consumed by `engine/src/workflow/workspace-manager.ts`.
- `tree-landing.ts` is consumed by `engine/src/workflow/promotion/apply.ts`, `engine/src/workflow/promotion/promoter-home.ts`, `engine/src/workflow/promotion/promotion-run.ts`, `engine/src/workflow/promotion/publication.ts`, `engine/src/workflow/workspace-manager.ts`.
- `workflow-config.ts` is consumed by `engine/scripts/tooling/inventory-test-run.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/verification/governed-source.ts`, `engine/scripts/verification/architecture.ts`, `engine/scripts/verification/static-source.ts`, `engine/src/git/worktree-port.ts` and 18 more.
- `workspace-cli.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `engine/src/workflow/harness-commands.ts`.
- `workspace-contracts.ts` is consumed by `engine/src/workflow/workspace-cli.ts`, `engine/src/workflow/workspace-manager.ts`, `engine/src/workflow/workspace-registry.ts`.
- `workspace-manager.ts` is consumed by `engine/src/workflow/workspace-cli.ts`.
- `workspace-registry.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `engine/src/workflow/workspace-manager.ts`.

<!-- /consumers:generated -->

Workspace shard import supports standalone events only. It captures the initial last
sequence, walks ascending keyset pages through that tip using the existing timeline
query limit, and refuses nonprogressing pages or observed source growth. Matching
IDs skip only when the canonical logical projection agrees, including exact raw
attachment fields and order. Other record kinds and invalid non-null outcomes
refuse before identity comparison. Each admitted event commits separately; a later
refusal preserves that prefix and never rewrites source history.

Workspace hooks capture scalar timeline configuration once and forward the same
selection to both stores and the importer. The manager closes acquired handles on
partial-open or close failures and retains source shards after success and failure:
appenders do not share its merge lock, so a last-tip check cannot authorize source
deletion. Worktree teardown still precedes the terminal `merged` state. Git can
already be merged when import, teardown or receipt persistence fails; partial
teardown is not rolled back nor retried by `merge`: `ws recover <id>` (or the
sweep) finishes it once no integrator holds the merge lock.

Before any destination lookup or append, import verifies source-chain integrity
through the store's local synchronous SQLite iterator, then requires the captured
tip to remain unchanged. The iterator is explicitly returned on exhaustion, early
failure and native-step errors. Every projected document receives shared exact
integrity admission before comparison, including historical matches; a skip does
not impose the current target byte cap on old content. New writes retain that cap.

Unkeyed hash consistency is not cryptographic authentication, and event chains
exclude attachment bytes. Verification and later page reads are separate passes;
they do not prevent hostile rewrites between passes or establish writer quiescence.
The iterator bounds row materialization, not total CPU or snapshot lifetime.
Retention preserves the original for diagnosis and does not repair history.
