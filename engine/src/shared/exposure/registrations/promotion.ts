/**
 * Shared exposure registrations — `promotion` module.
 *
 * Shipping finished, verified work from a development branch to the branch
 * that ships (`harness promote`, src/workflow/promotion/): which pairs are
 * declared, what each one is doing and how its last run ended, what is
 * waiting to ship, what is held, what the target checkout needs, and what
 * the projection advises; and the verbs — the read-only ones (status, plan,
 * explain) and the ones that move refs (apply, rollback, hold, release-hold).
 *
 * Every signal answers one entry per declared profile. The state-like rows
 * (state, last result, target checkout, target edits, advisories, last run's
 * duration) read the run's own record (`last-run.json`: a cache, never a
 * decision) and say when it was measured; the ref-like rows (last promoted,
 * pending, hold) read the refs.
 *
 * THE INSTALLED-SOURCE PATTERN (as `workspace-git.ts`): this registration
 * imports no process or filesystem code — it is also loaded by the web server
 * and the browser build — so the answers arrive through a source the host
 * installs. The engine CLI installs one that reads the repository with git
 * (src/runtime/harness-bootstrap.ts); the web server installs none (it runs
 * no git, and resolving the repository's common directory without git would
 * be a second derivation of it, a5-design M6), so the rows read `unmeasured`
 * and the actions refuse typed (`promotion_source_unavailable`) until the
 * generic "run a maintenance command from the UI" owner exists.
 */

import { optionalStringArg, registerAction, registerExposureModule, registerSignal } from "../index.ts";
import { HarnessError } from "../../../kernel/errors.ts";

/** What an `apply` action asks (the CLI's flags, by name; the target-edit list comma-separated). */
export type PromotionApplyRequest = Readonly<{
  profile?: string;
  source?: string;
  noPublish?: boolean;
  noPush?: boolean;
  acceptTargetEdits?: readonly string[];
  allowDeletions?: boolean;
  releaseHold?: boolean;
  reason?: string;
}>;

/** The answers a host installs (see the header). Each signal is one line, one entry per declared profile. */
export type PromotionSource = Readonly<{
  /** Each declared profile (name@blob: source → target, trigger, boundary counts), or none. */
  profiles: () => string;
  /** Each profile's state: idle, running:<phase>, interrupted:<phase>, held, parked, blocked, errored, failed. */
  state: () => string;
  /** Each profile's last answer: its code, class and message, when. */
  lastResult: () => string;
  /** Each profile's last promotion on its target: the commit, the source it carries, when. */
  lastPromoted: () => string;
  /** Each profile's source commits not yet promoted, the oldest one's age, and whether they change what ships. */
  pending: () => string;
  /** Each profile's hold: who held which source, when and why — or not held. */
  held: () => string;
  /** Each profile's target checkout after its last run: its path and the setup commands it needs re-run. */
  targetCheckout: () => string;
  /** Each profile's target edits found by its last plan. */
  targetEdits: () => string;
  /** The advisories of each profile's last plan, by kind. */
  advisories: () => string;
  /** How long each profile's last run took. */
  lastRunDurationMs: () => string;
  /** `harness promote status` (`--profile`, `--source` optional). */
  status: (profile: string | undefined, source: string | undefined) => Promise<unknown>;
  /** `harness promote plan`. */
  plan: (profile: string | undefined, source: string | undefined) => Promise<unknown>;
  /** `harness promote explain <path>…`. */
  explain: (paths: readonly string[], profile: string | undefined, source: string | undefined) => Promise<unknown>;
  /** `harness promote apply …`. */
  apply: (request: PromotionApplyRequest) => Promise<unknown>;
  /** `harness promote rollback --to <commit> --reason <text>`. */
  rollback: (to: string, reason: string, profile: string | undefined) => Promise<unknown>;
  /** `harness promote hold --reason <text>`. */
  hold: (reason: string, profile: string | undefined) => Promise<unknown>;
  /** `harness promote release-hold --reason <text>`. */
  releaseHold: (reason: string, profile: string | undefined) => Promise<unknown>;
}>;

let promotionSource: PromotionSource | null = null;

/** Install the repository's promotion source (the engine CLI, at boot). */
export function installPromotionSource(source: PromotionSource): void {
  promotionSource = source;
}

const NO_PROMOTION_SOURCE = "unmeasured";

function requirePromotionSource(): PromotionSource {
  if (promotionSource === null) throw new HarnessError("no host installed the promotion source in this process (the web server does not run git; the engine CLI does): use `npm run promote`", "promotion_source_unavailable");
  return promotionSource;
}

/** The registered signals: id, name, description, and which installed answer reads it. */
const PROMOTION_SIGNALS: readonly Readonly<{ id: string; name: string; description: string; read: (source: PromotionSource) => string }>[] = [
  { id: "promotion.profiles", name: "Declared promotions", description: "Every promotion profile the repository declares (a data file on the source branch, read from the source commit): its name and blob, the source and target branches, how it is triggered, and how many entry points, includes and excludes its boundary holds.", read: (source) => source.profiles() },
  { id: "promotion.state", name: "What each promotion is doing", description: "Each profile's state: idle, running (with the phase), interrupted (a run that never ended), held, parked (published, the local checkout has overlapping edits), blocked (a refusal to fix on the source or by a flag), errored (the machine's), failed (a defect).", read: (source) => source.state() },
  { id: "promotion.lastResult", name: "How the last promotion run ended", description: "Each profile's last answer: its code and class, its message, and when.", read: (source) => source.lastResult() },
  { id: "promotion.lastPromoted", name: "The last promotion", description: "Each profile's last promotion (or rollback) on its target: the commit, the source commit it carries, and when it was made.", read: (source) => source.lastPromoted() },
  { id: "promotion.pending", name: "Waiting to ship", description: "How many source commits each declared promotion has not yet carried to its target, how old the oldest is (abnormal past 72 h), and whether they change what ships.", read: (source) => source.pending() },
  { id: "promotion.held", name: "Held promotions", description: "Each profile's hold (set by a rollback or by hold): who held which source, when and why — automatic promotion stays paused until it is released.", read: (source) => source.held() },
  { id: "promotion.targetCheckout", name: "The checkout that holds the target", description: "Where each profile's target is checked out, and the setup commands its new tree needs re-run there (never run by the promoter: it may be serving).", read: (source) => source.targetCheckout() },
  { id: "promotion.targetEdits", name: "Direct edits of the target", description: "The paths each profile's last plan found edited on the target since its last promotion (land the written patch on the source, or accept the exact list once).", read: (source) => source.targetEdits() },
  { id: "promotion.advisories", name: "What the projection advises", description: "The advisories of each profile's last plan (never failures): new source files nothing ships, documents naming scripts the shipped manifest lacks, build recipes naming files that do not ship, stale generated outputs, the source's suite evidence.", read: (source) => source.advisories() },
  { id: "promotion.lastRunDurationMs", name: "How long the last promotion run took", description: "Each profile's last run's duration, in milliseconds.", read: (source) => source.lastRunDurationMs() },
];

let promotionRegistered = false;
export function registerPromotionExposure(): void {
  if (promotionRegistered) return;
  promotionRegistered = true;

  registerExposureModule({
    id: "promotion",
    title: "Shipping to the product branch",
    purpose: "Carries finished, verified work from a development branch to the branch that ships, and says what is waiting and why.",
  });

  for (const signal of PROMOTION_SIGNALS) {
    registerSignal({
      id: signal.id,
      module: "promotion",
      name: signal.name,
      description: signal.description,
      type: "string",
      value: () => (promotionSource === null ? NO_PROMOTION_SOURCE : signal.read(promotionSource)),
    });
  }

  const profileArg = { profile: { type: "string" as const, required: false, description: "The promotion profile's name (omit when the repository declares exactly one)." } };
  const profileArgs = {
    ...profileArg,
    source: { type: "string" as const, required: false, description: "The source revision to read the profile from and promote (default: the tip of the profile's source branch)." },
  };
  const reasonArg = { reason: { type: "string" as const, required: true, description: "Why: recorded in the receipt or the hold, and the log." } };
  registerAction({
    id: "promotion.status",
    module: "promotion",
    name: "Show the promotion's status",
    description: "The source and target tips, the commits waiting, the pending and hold refs, the last run's state, and the tools a promotion needs — `harness promote status`. Changes nothing.",
    args: profileArgs,
    execute: async (args) => requirePromotionSource().status(optionalStringArg(args?.["profile"]), optionalStringArg(args?.["source"])),
  });
  registerAction({
    id: "promotion.plan",
    module: "promotion",
    name: "Plan the promotion",
    description: "Compute what the target would become — every added, changed and deleted path with its reason, the derived manifests and lockfiles, the target's direct edits, the refusals and the advisories — `harness promote plan`. Writes no ref, index or checkout.",
    args: profileArgs,
    execute: async (args) => requirePromotionSource().plan(optionalStringArg(args?.["profile"]), optionalStringArg(args?.["source"])),
  });
  registerAction({
    id: "promotion.explain",
    module: "promotion",
    name: "Explain why a path ships or not",
    description: "For a repository path: whether the promotion carries it, and the reason chain (the import chain from an entry point, the include, the companion rule, the exclusion) — `harness promote explain`.",
    args: {
      ...profileArgs,
      path: { type: "string", required: true, description: "The repository-relative path to explain." },
    },
    execute: async (args) => requirePromotionSource().explain([String(args?.["path"])], optionalStringArg(args?.["profile"]), optionalStringArg(args?.["source"])),
  });
  registerAction({
    id: "promotion.apply",
    module: "promotion",
    name: "Promote",
    description: "Build, certify, commit, push and land the promotion — `harness promote apply`: one atomic, never-forced push, a fast-forward of the target's checkout (parked when it holds overlapping edits); a rerun resumes. Overrides need a reason.",
    contract: { audience: "advanced", effect: "immediate" },
    args: {
      ...profileArgs,
      noPublish: { type: "boolean", required: false, description: "Stop after the commit (pinned by the pending ref; nothing published)." },
      noPush: { type: "boolean", required: false, description: "Publish locally only (the next run pushes)." },
      acceptTargetEdits: { type: "string", required: false, description: "The plan's exact list of target edits to overwrite, comma-separated (needs a reason)." },
      allowDeletions: { type: "boolean", required: false, description: "Exceed the profile's deletion budget (needs a reason)." },
      releaseHold: { type: "boolean", required: false, description: "Release the profile's hold first (needs a reason)." },
      reason: { type: "string", required: false, description: "Why an override was granted: recorded in the receipt and the log." },
    },
    execute: async (args) => {
      const edits = optionalStringArg(args?.["acceptTargetEdits"]);
      const profile = optionalStringArg(args?.["profile"]);
      const source = optionalStringArg(args?.["source"]);
      const reason = optionalStringArg(args?.["reason"]);
      return requirePromotionSource().apply({
        ...(profile === undefined ? {} : { profile }),
        ...(source === undefined ? {} : { source }),
        noPublish: args?.["noPublish"] === true,
        noPush: args?.["noPush"] === true,
        ...(edits === undefined ? {} : { acceptTargetEdits: edits.split(",").map((path) => path.trim()).filter((path) => path.length > 0) }),
        allowDeletions: args?.["allowDeletions"] === true,
        releaseHold: args?.["releaseHold"] === true,
        ...(reason === undefined ? {} : { reason }),
      });
    },
  });
  registerAction({
    id: "promotion.rollback",
    module: "promotion",
    name: "Roll the target back",
    description: "Restore the target to an earlier promotion's tree with a new forward commit (never a forced push) and hold automatic promotion — `harness promote rollback`.",
    contract: { audience: "advanced", effect: "immediate" },
    args: { ...profileArg, to: { type: "string", required: true, description: "The promotion commit whose tree to restore." }, ...reasonArg },
    execute: async (args) => requirePromotionSource().rollback(String(args?.["to"]), String(args?.["reason"]), optionalStringArg(args?.["profile"])),
  });
  registerAction({
    id: "promotion.hold",
    module: "promotion",
    name: "Hold automatic promotion",
    description: "Pause automatic promotion of a profile until it is released — `harness promote hold`.",
    contract: { audience: "advanced", effect: "immediate" },
    args: { ...profileArg, ...reasonArg },
    execute: async (args) => requirePromotionSource().hold(String(args?.["reason"]), optionalStringArg(args?.["profile"])),
  });
  registerAction({
    id: "promotion.releaseHold",
    module: "promotion",
    name: "Release the hold",
    description: "Resume automatic promotion of a profile (after the defect a rollback undid is fixed) — `harness promote release-hold`.",
    contract: { audience: "advanced", effect: "immediate" },
    args: { ...profileArg, ...reasonArg },
    execute: async (args) => requirePromotionSource().releaseHold(String(args?.["reason"]), optionalStringArg(args?.["profile"])),
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetPromotionRegistration(): void {
  promotionRegistered = false;
}
