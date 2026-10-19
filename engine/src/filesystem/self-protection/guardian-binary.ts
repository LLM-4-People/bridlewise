import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createOwnedTemporaryDirectory, ownedTemporaryName, PRIVATE_STATE_FILE_MODE } from "../private-state.ts";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { InputError } from "../../kernel/errors.ts";
import { bestEffort } from "../../shared/best-effort.ts";
import { canonicalJson, deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import {
  DEFAULT_TEMP_DIR_ACCESS,
  GUARDIAN_FAILURE_MARKER,
  GUARDIAN_SPEC_SCHEMA,
  LANDLOCK_ACCESS_FS_FLAG_NAMES,
  PROJECT_ROOT_ACCESS_FLAGS,
  isGuardianPreExecFailure,
  type GuardianBinaryAvailability,
  type GuardianBinaryResult,
  type GuardianSpec,
  type LandlockAccessFsFlagName,
} from "./self-protection-contracts.ts";
import {
  assertResolvesWithinRegion,
  identityOverlapIndex,
  resolveLocation,
  type IdentityOverlapIndex,
  type PathRegion,
  type ResolvedAbsolutePath,
} from "../path-identity.ts";
import { hasSecondName } from "../link-containment.ts";
import { emittedKeepOut, keepOutPolicyFor, type KeepOutFacts, type KeepOutPolicy } from "./keep-out.ts";
import type { SelfProtectionConfig } from "./self-protection-config.ts";

/**
 * Node-side wrapper for the frozen Landlock guardian C binary. This module is
 * the single bridge between the high-level operator config + the root-policy
 * floor and the low-level JSON spec the C binary consumes. It owns:
 *
 * - {@link resolveGuardianBinaryPath}: resolves the binary relative to the
 * harness root using `ROOT_POLICY.selfProtection.binaryRelativePath` (one
 * owner for the relative path; the harness root itself comes from the
 * pinned config snapshot's `repositoryRoot`).
 * - {@link verifyGuardianBinaryAvailability}: a typed, never-throwing probe
 * that verifies the binary exists, its sha256 matches the root-policy pin,
 * and Landlock is available on the running kernel. Reports a typed
 * `code` so the runtime can fail closed with an actionable error.
 * - {@link compileSelfProtectionConfigToSpec}: the single source of truth for
 * compiling the operator config + runtime facts (harness root, project root,
 * node binary path) into the low-level {@link GuardianSpec}. Pulls the
 * non-overridable floor (minimum protected subtrees, minimum allow-set,
 * handled flags) from `ROOT_POLICY.selfProtection`; the operator can only
 * ADD to the floor, never remove floor entries.
 * Where a compiled spec is APPLIED is the host's (the web server's
 * `server/safety/landlock-runner.ts`, per spawn); the engine CLI's own
 * guardian re-exec is gone (user decision C8).
 */


/**
 * Resolve the guardian binary path relative to the harness root. The relative
 * path is the single owner `ROOT_POLICY.selfProtection.binaryRelativePath`;
 * the harness root is the pinned config snapshot's `repositoryRoot` (computed
 * once in `src/config.ts` via `import.meta.url`). Returns `undefined` when the
 * binary is not present so callers can produce a typed `binary_missing` result
 * without throwing.
 */
export function resolveGuardianBinaryPath(harnessRoot: string): string | undefined {
  if (!isAbsolute(harnessRoot)) return undefined;
  const binaryPath = join(harnessRoot, ROOT_POLICY.selfProtection.binaryRelativePath);
  return existsSync(binaryPath) ? binaryPath : undefined;
}

/**
 * Compute the sha256 of a file by reading it whole. The guardian binary is
 * small (~30 KB), so a full read is fine and avoids stream-collision bugs.
 */
function fileSha256(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const bytes = readFileSync(descriptor);
    return sha256(bytes);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Probe the running kernel's Landlock ABI version by running the guardian with
 * single-flag handled sets. For a flag with `minAbi = N`, a spec with
 * `handled_access_fs = [flag]` and `allow_rules = [{/usr, [flag]}]` survives
 * (handled non-empty) only when the kernel ABI >= N; otherwise the flag is
 * masked out, handled becomes empty, and the binary exits 4. The payload
 * `/bin/true` runs whenever handled is non-empty (exec/read are ungoverned
 * because EXECUTE/READ_FILE are not in handled). Returns the highest detected
 * ABI level, or 1 when all higher-level probes fail. Never throws; on any
 * unexpected error returns 0 (unknown).
 */
function probeKernelLandlockAbi(binaryPath: string, tempDir: string): number {
  const probes: readonly Readonly<{ abi: number; flag: LandlockAccessFsFlagName }>[] = [
    { abi: 5, flag: "IOCTL_DEV" },
    { abi: 3, flag: "TRUNCATE" },
    { abi: 2, flag: "REFER" },
  ];
  // Use a floor allow-set path (one owner: ROOT_POLICY.selfProtection.minimumAllowSet)
  // as the probe allow-rule target. It must be a directory so dir-only flags
  // (IOCTL_DEV, REFER) are valid on it. The first floor entry is /usr.
  const floorPath = ROOT_POLICY.selfProtection.minimumAllowSet[0]?.path;
  if (floorPath === undefined) return 0;
  const probeAllowPath = resolveLocation(floorPath, "the ABI probe's allow-rule");
  for (const probe of probes) {
    const spec: GuardianSpec = deepFreeze({
      abi_version_hint: 0,
      handled_access_fs: [probe.flag],
      allow_rules: [{ path: probeAllowPath, access: [probe.flag] }],
      protected_subtrees: [],
      default_deny_outside_allow_rules: true,
    });
    const result = runGuardianSync(binaryPath, spec, "/bin/true", [], tempDir, true);
    if (result.kind === "payload_exited" && result.exitCode === 0) {
      return probe.abi;
    }
  }
  return 1;
}

/**
 * Verify the guardian binary is available and Landlock is enforced on the
 * current host. Never throws; never silently falls back. The returned `code`
 * names the operator action.
 */
export function verifyGuardianBinaryAvailability(
  harnessRoot: string,
): GuardianBinaryAvailability {
  if (process.platform !== "linux") {
    return deepFreeze<GuardianBinaryAvailability>({ available: false, code: "platform_unsupported", fallbackAttempted: false });
  }
  const binaryPath = resolveGuardianBinaryPath(harnessRoot);
  if (binaryPath === undefined) {
    return deepFreeze<GuardianBinaryAvailability>({ available: false, code: "binary_missing", fallbackAttempted: false });
  }
  const actualSha256 = fileSha256(binaryPath);
  if (actualSha256 !== ROOT_POLICY.selfProtection.binarySha256) {
    return deepFreeze<GuardianBinaryAvailability>({ available: false, code: "binary_hash_mismatch", fallbackAttempted: false });
  }
  const tempDir = createOwnedTemporaryDirectory(tmpdir(), "harness-guardian-probe-");
  try {
    const floor = ROOT_POLICY.selfProtection;
    const probeSpec = buildAvailabilityProbeSpec(floor.minimumAllowSet);
    const result = runGuardianSync(binaryPath, probeSpec, "/bin/true", [], tempDir, true);
    if (result.kind === "pre_exec_failure" && result.exitCode === 3) {
      return deepFreeze<GuardianBinaryAvailability>({ available: false, code: "landlock_unavailable", fallbackAttempted: false });
    }
    if (result.kind !== "payload_exited" || result.exitCode !== 0) {
      return deepFreeze<GuardianBinaryAvailability>({ available: false, code: "landlock_unavailable", fallbackAttempted: false });
    }
    const kernelAbi = probeKernelLandlockAbi(binaryPath, tempDir);
    return deepFreeze<GuardianBinaryAvailability>({ available: true, binaryPath, sha256: actualSha256, kernelAbi });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildAvailabilityProbeSpec(
  minimumAllowSet: readonly Readonly<{ path: string; access: readonly LandlockAccessFsFlagName[] }>[],
): GuardianSpec {
  return deepFreeze({
    abi_version_hint: 0,
    handled_access_fs: ROOT_POLICY.selfProtection.handledAccessFs,
    // Resolved like every compiled rule: the guardian opens each path without
    // following links (`/lib` is a link on a merged-/usr host).
    allow_rules: minimumAllowSet.map((entry) => ({ path: resolveLocation(entry.path, "the safety floor's minimum allow-set"), access: entry.access })),
    protected_subtrees: [],
    default_deny_outside_allow_rules: true,
  });
}

/**
 * Compile the operator self-protection config + runtime facts into the
 * low-level {@link GuardianSpec} the C binary consumes. ONE source of truth
 * for the compilation rules. The floor (minimum protected subtrees, minimum
 * allow-set, handled flags, bundle path) comes from `ROOT_POLICY.selfProtection`;
 * the operator can only ADD to the floor. Throws `InputError` on a config
 * error (e.g. an operator allow-rule under a protected subtree).
 */
export function compileSelfProtectionConfigToSpec(
  config: SelfProtectionConfig,
  harnessRoot: string,
  projectRoot: string,
  nodeBinaryPath: string,
  /**
   * The host's half of the ONE keep-out list (`keep-out.ts`): facts only the
   * host knows — its databases (their whole families), its config document —
   * and the registry of the key home it admitted. REQUIRED: a caller that
   * forgot them would silently lose the host's refusals.
   */
  keepOut: Readonly<Omit<KeepOutFacts, "harnessRoot">>,
): GuardianSpec {
  if (!isAbsolute(harnessRoot)) {
    throw new InputError("harnessRoot must be absolute", "self_protection_invalid_root");
  }
  if (!isAbsolute(projectRoot)) {
    throw new InputError("projectRoot must be absolute", "self_protection_invalid_root");
  }
  if (!isAbsolute(nodeBinaryPath)) {
    throw new InputError("nodeBinaryPath must be absolute", "self_protection_invalid_root");
  }
  const floor = ROOT_POLICY.selfProtection;
  // THE REGION EVERY IN-PROJECT PATH MUST STAY INSIDE, computed once and
  // carried to both the allow-rules and the temp directory. Both spellings are
  // kept: see `assertResolvesWithinRegion` for why either one counts as
  // "named inside the project".
  const project: PathRegion = {
    raw: projectRoot,
    resolved: resolveLocation(projectRoot, "projectRoot"),
  };
  // THE ONE KEEP-OUT LIST: the harness floor, every home's stores, the key
  // home and the registered stores, the host's files, the operator's additions.
  const policy = keepOutPolicyFor(config, { ...keepOut, harnessRoot });
  // EVERY entry that exists goes into the spec: the C guardian refuses a rule
  // under or containing any of them physically, by identity.
  const emitted = emittedKeepOut(policy.entries);
  const allowRules = buildAllowRules(config, harnessRoot, project, nodeBinaryPath, floor);
  const handledAccessFs = buildHandledAccessFs(config.additionalHandledAccessFs, floor.handledAccessFs);
  // RESOLVED, like every other path in the spec. The temp directory is an
  // allow-rule in all but name — it carries `DEFAULT_TEMP_DIR_ACCESS`, which
  // is write, create, truncate and remove — and it was the second of the six
  // measured floor bypasses precisely because it was compared as a string.
  //
  // NO DEFAULT: the system temp folder is never granted. A grant of all of
  // `/tmp` handed every confined process every other process's temp files,
  // and it made ONE harness database kept under `/tmp` refuse every spawn
  // (the grant contained a kept-out store). The host names a PRIVATE folder
  // per spawn (the web server's per-spawn folder, an MCP server's home) and
  // points `TMPDIR` into it; with none, the spec carries no temp folder.
  const rawTempDir = config.tempDir;
  const tempDir = rawTempDir === undefined ? undefined : resolveLocation(rawTempDir, "selfProtection.tempDir");
  // …and it is held to the same containment rule as an allow-rule, for the
  // same reason: a temp directory spelled inside the project carries write,
  // create and remove, so a link there would hand those out somewhere else.
  if (rawTempDir !== undefined && tempDir !== undefined) assertResolvesWithinRegion(rawTempDir, tempDir, project, "selfProtection.tempDir", "the project");
  const allowRulePaths = new Set<string>(allowRules.map((rule) => rule.path));
  // The C binary rejects a temp_dir that duplicates an allow_rules path (exit
  // 4). When tempDir is already covered by an allow-rule (e.g. it equals the
  // project root, which already carries the project workspace access set),
  // omit the temp_dir field — the existing allow-rule grants the access. This
  // also handles the operator-config case where tempDir coincides with a
  // floor path or an additional allow-rule.
  const tempDirAlreadyAllowed = tempDir === undefined || allowRulePaths.has(tempDir);
  // JUDGED BY NAME, EMITTED BY PRESENCE: every rule — present or not — is
  // judged below (the keep-out floor, W^X, the harness's subtrees), because
  // the floor refuses a path by NAME (`~/.ssh` before `ssh-keygen` made it):
  // a registration the spawn refuses once a folder appears is refused now.
  // Only then is the spec's list cut to the paths that exist — a rule for a
  // missing path makes the guardian refuse the whole spec (`add_rule` needs
  // something to open) — and a missing path grants nothing to lose.
  const emittedAllowRules = allowRules.filter((rule) => existsSync(rule.path));
  const spec = deepFreeze({
    abi_version_hint: 0,
    handled_access_fs: handledAccessFs,
    allow_rules: emittedAllowRules,
    protected_subtrees: emitted.protectedSubtrees,
    ...(emitted.keepOut.length === 0 ? {} : { keep_out: emitted.keepOut, keep_out_retries: ROOT_POLICY.selfProtection.keepOutRetries }),
    default_deny_outside_allow_rules: true as const,
    ...(tempDirAlreadyAllowed || tempDir === undefined ? {} : { temp_dir: tempDir, temp_dir_access: [...DEFAULT_TEMP_DIR_ACCESS] }),
  });
  validateCompiledSpec(spec, allowRules, policy, tempDirAlreadyAllowed ? undefined : tempDir);
  // The second-name walk covers the HARNESS's own code — the files whose
  // tampering means code in the unconfined server. Every other entry is kept
  // OUT (never granted), not walked: a browser profile, a credential FILE or
  // an operator's addition is not ours to walk.
  assertProtectedFilesHaveOneName(emitted.protectedSubtrees);
  return spec;
}

/**
 * NO PROTECTED FILE MAY HAVE A SECOND NAME.
 *
 * ── WHY THIS IS ANSWERABLE AT ALL, WHICH WAS PREVIOUSLY GOT WRONG ─────────
 *
 * Landlock authorises by PATH HIERARCHY. A hard link inside the project that
 * points at a file outside it is a name inside the allowed hierarchy for an
 * inode that lives outside — so a confined command reads and writes it, and
 * every surface still reports the sandbox as enforced. The confined process
 * cannot create one (the kernel refuses a cross-hierarchy link, measured), but
 * a project can arrive with one already in it.
 *
 * This was previously written off as unaffordable, on the strength of two
 * options that both scanned the PROJECT: a per-command walk of an arbitrary
 * tree, and refusing any project containing a hard link, which rejects most
 * `pnpm` workspaces. The reasoning missed that `nlink` IS A PROPERTY OF THE
 * INODE and is readable from either name. Asking "does any protected file have
 * a second name anywhere on this filesystem" therefore needs no project scan
 * at all — only a walk of the protected set, which is small, ours, and has no
 * `pnpm` problem because package stores are not in it.
 *
 * ── THE POPULATION IS RETURNED, NOT DESCRIBED ─────────────────────────────
 *
 * This comment used to state the measurement as prose — "654 files across the
 * two protected subtrees" — and it was made false four commits later, in the
 * same step, by a change that took the web repository's contribution from one
 * subtree to four. Nothing could have caught it: the number lived in English,
 * and the walk returned `string | null`, so no test could assert a population
 * it was never told.
 *
 * So the walk REPORTS what it covered, {@link assertProtectedFilesHaveOneName}
 * refuses a walk that covered nothing, and the only numbers anybody reads come
 * out of the walk itself. A safety check that walks a population and does not
 * return its size cannot tell "found nothing wrong" from "looked at nothing" —
 * and both of those used to pass here, silently: an empty subtree list and a
 * subtree that does not exist were both a clean bill of health.
 *
 * ── WHY THIS ONE DOES NOT CONSULT THE HARDLINK POLICY ─────────────────────
 *
 * `link-containment.ts` owns the second-name question, and its policy-aware
 * door honours the operator's dev-mode opt-out. This check takes the FACT
 * (`hasSecondName`) and not the policy, deliberately: a self-protection compile
 * check that an environment variable can switch off is a self-protection check
 * an attacker can switch off, and the harness's own protected files are not the
 * `cp -rl` workspaces that opt-out exists for. The repository readers consult
 * the policy because a dev workspace legitimately has two names for every file;
 * nothing legitimately has two names for the guardian's own source.
 *
 * MEASURED ON THIS HOST: the walk is a few milliseconds warm, memoised after
 * the first spawn, and every protected file has exactly one name.
 *
 * ── WHAT IT DOES AND DOES NOT CLOSE, PRECISELY ────────────────────────────
 *
 * CLOSES: a second name for a file the harness protects — the half the
 * subsystem is named for, and the one whose consequence is arbitrary code in
 * the unconfined server.
 *
 * DOES NOT CLOSE: a hard link in the project to some OTHER file outside it
 * (the user's keys, another project). Answering that genuinely does need a
 * project-side scan of an arbitrary tree, and refusing it remains sound.
 * `CONFINED_SENTENCE` in the web server says so in plain words rather than
 * claiming a protection that is not there.
 *
 * MEMOISED PER PROCESS, and the reason is stated because a cache on a safety
 * check is a claim: creating a link does not change any directory's
 * modification time, so a directory-mtime cache would silently miss exactly
 * the event it exists to notice. The honest key is therefore "this process has
 * asked", and the residual is precise — a link created after the first spawn,
 * by an actor outside the sandbox, is not seen. That actor already holds the
 * authority the link would grant, so the check loses nothing it could have had.
 */
const protectedNameCheckCache = new Map<string, ProtectedNameWalk>();

/**
 * What a second-name walk covered and what it found. The size is not
 * diagnostics: it is the difference between "every protected file has one
 * name" and "no protected file was looked at", which are the same verdict
 * until the population is stated.
 */
export type ProtectedNameWalk = Readonly<{
  /** Regular files whose link count was actually read. */
  filesWalked: number;
  /** Directories successfully listed. */
  directoriesWalked: number;
  /** Declared subtrees that exist on this machine and yielded no file. */
  emptyExistingSubtrees: readonly string[];
  /** The first protected file found to have a second name, or null. */
  offender: string | null;
}>;

export function assertProtectedFilesHaveOneName(
  protectedSubtrees: readonly string[],
): ProtectedNameWalk {
  const key = [...protectedSubtrees].sort().join("\0");
  let cached = protectedNameCheckCache.get(key);
  if (cached === undefined) {
    cached = findProtectedFileWithSecondName(protectedSubtrees);
    protectedNameCheckCache.set(key, cached);
  }
  if (cached.offender !== null) {
    throw new InputError(
      `a protected file has a second name on this filesystem and could be reached through it: ${cached.offender}. `
      + "A hard link is authorised by the hierarchy it is reached through, so a second name inside an allowed directory would give a confined command the file itself.",
      "self_protection_protected_file_has_second_name",
    );
  }
  // A WALK THAT SAW NOTHING IS NOT A CLEAN RESULT. A subtree that EXISTS and
  // yielded no file was walked and proved nothing about itself, which reads as
  // protection and is the absence of it — the shape that let this check pass
  // on an empty set and on an unreadable one alike.
  //
  // SCOPED TO SUBTREES THAT ARE THERE, and the scope is the honest part: a
  // declared subtree that does not exist on this machine is a different and
  // larger question (an operator naming something not installed, or a spec
  // compiled for another host), and answering it here would turn compiling a
  // spec for a machine you are not on into a refusal. That question belongs to
  // whoever declared the subtree; this function answers only about the files it
  // was actually able to see.
  if (cached.emptyExistingSubtrees.length > 0) {
    throw new InputError(
      `these protected subtrees exist but yielded no file to check: ${cached.emptyExistingSubtrees.join(", ")}. `
      + "A check that reports no violation because it examined nothing is indistinguishable from a check that passed, which is why it refuses instead.",
      "self_protection_protected_subtree_empty",
    );
  }
  return cached;
}

/** Drop the memoised answer. Exported so a test can measure a changed world. */
export function invalidateProtectedNameCheck(): void {
  protectedNameCheckCache.clear();
}

/**
 * Walk the protected set, reporting what was covered and the first file found
 * to have a second name.
 *
 * It stops at the first offender, so `filesWalked` is a lower bound on a
 * FAILING walk and the exact population on a passing one — which is the only
 * case whose number anybody relies on.
 */
function findProtectedFileWithSecondName(protectedSubtrees: readonly string[]): ProtectedNameWalk {
  let filesWalked = 0;
  let directoriesWalked = 0;
  const emptyExistingSubtrees: string[] = [];
  for (const root of protectedSubtrees) {
    const filesBefore = filesWalked;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      // A protected directory this process cannot list is not evidence of a
      // second name; the floor's own comparisons still hold for it. Routed
      // through the shared best-effort owner so the failure is visible in
      // diagnostics rather than swallowed.
      const entries = bestEffort(
        () => readdirSync(dir, { withFileTypes: true }),
      );
      if (entries === undefined) continue;
      directoriesWalked += 1;
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        // Regular files only. A symbolic link is a NAME, not a second hard
        // name, and where a link may point is bounded elsewhere.
        if (!entry.isFile()) continue;
        const stat = bestEffort(() => lstatSync(full));
        if (stat === undefined) continue;
        filesWalked += 1;
        // THE FACT, from the shared owner, and not the policy — see the note on
        // `assertProtectedFilesHaveOneName` for why this one check is not
        // switchable by the operator's dev-mode opt-out.
        if (hasSecondName(stat.nlink)) {
          return { filesWalked, directoriesWalked, emptyExistingSubtrees, offender: full };
        }
      }
    }
    if (filesWalked === filesBefore && existsSync(root)) emptyExistingSubtrees.push(root);
  }
  return { filesWalked, directoriesWalked, emptyExistingSubtrees, offender: null };
}

/**
 * An allow-rule as the compiler carries it internally: the path is RESOLVED
 * by type, so the floor's comparison below cannot be handed a spelling.
 */
type ResolvedAllowRule = Readonly<{
  path: ResolvedAbsolutePath;
  access: readonly LandlockAccessFsFlagName[];
}>;

function buildAllowRules(
  config: SelfProtectionConfig,
  harnessRoot: string,
  project: PathRegion,
  nodeBinaryPath: string,
  floor: RootPolicySelfProtectionView,
): readonly ResolvedAllowRule[] {
  const rules: ResolvedAllowRule[] = [];
  const seen = new Map<string, number>();
  // THE ONLY DOOR INTO THE ALLOW-SET, and it takes a raw string and resolves
  // it here rather than accepting a resolved one from each caller. Both
  // shapes make forgetting impossible; this one also means there is exactly
  // one `resolveLocation` call to read, and the `what` label it produces
  // names the operator-facing field the bad path came from.
  //
  // IT IS ALSO WHERE THE CONTAINMENT RULE LIVES, and it has to be here rather
  // than at any caller: every rule this compiler emits — the floor's, the
  // server's derived ones, the operator's — arrives through this one function,
  // so a rule that names a place inside the project and resolves outside it
  // cannot be built at all. Putting the check at the callers would have meant
  // three copies and one of them eventually forgotten, which is precisely how
  // the derived scratch rule came to have no bound of its own.
  // TWO RULES FOR ONE LOCATION ARE ONE RULE WITH BOTH GRANTS. Keeping the
  // first and dropping the second discarded access silently — a read+execute
  // tool path equal to a writable root lost its EXECUTE and with it the W^X
  // refusal below; the union keeps what was asked for visible to the floor.
  const addRule = (raw: string, what: string, access: readonly LandlockAccessFsFlagName[]): void => {
    const path = resolveLocation(raw, what);
    assertResolvesWithinRegion(raw, path, project, what, "the project");
    const index = seen.get(path);
    if (index !== undefined) {
      const existing = rules[index]!;
      const merged = LANDLOCK_ACCESS_FS_FLAG_NAMES.filter((flag) => existing.access.includes(flag) || access.includes(flag));
      rules[index] = { path, access: merged };
      return;
    }
    seen.set(path, rules.length);
    rules.push({ path, access: [...access] });
  };
  for (const entry of floor.minimumAllowSet) {
    addRule(entry.path, "the safety floor's minimum allow-set", entry.access);
  }
  // A floor file behind a link is granted at the link's RESOLVED target
  // (`addRule` resolves every rule), read-only; like every rule it is judged
  // by name and emitted only when present (the compiler's one emission cut).
  for (const file of floor.minimumLinkedReadFiles) {
    addRule(file, "the safety floor's linked read files", ["READ_FILE"]);
  }
  addRule(nodeBinaryPath, "nodeBinaryPath", ["EXECUTE", "READ_FILE"]);
  addRule(join(harnessRoot, floor.bundleRelativePath), "the harness bundle", ["READ_FILE"]);
  addRule(project.raw, "projectRoot", PROJECT_ROOT_ACCESS_FLAGS);
  if (config.additionalAllowRules !== undefined) {
    for (const rule of config.additionalAllowRules) {
      addRule(rule.path, "selfProtection.additionalAllowRules[].path", rule.access);
    }
  }
  return rules;
}

function buildHandledAccessFs(
  additional: readonly LandlockAccessFsFlagName[] | undefined,
  floor: readonly LandlockAccessFsFlagName[],
): readonly LandlockAccessFsFlagName[] {
  const ordered = new Set<LandlockAccessFsFlagName>(floor);
  if (additional !== undefined) {
    for (const flag of additional) ordered.add(flag);
  }
  const result: LandlockAccessFsFlagName[] = [];
  for (const flag of LANDLOCK_ACCESS_FS_FLAG_NAMES) {
    if (ordered.has(flag)) result.push(flag);
  }
  return result;
}

/**
 * THE FLOOR: an allow-rule may not overlap a protected subtree IN EITHER
 * DIRECTION.
 *
 * The downward half was here from the start — an allow-rule *under* a
 * protected path is obviously a hole, and the C binary refuses it too. The
 * UPWARD half was missing from both (the binary refuses it too since SEC-c), and it
 * is the more dangerous of the two, because Landlock's allow-rules are
 * hierarchical and "protection" here is only deny-by-omission. Allowing an
 * ANCESTOR of a protected subtree therefore grants everything inside it, and
 * nothing anywhere reports a problem.
 *
 * MEASURED, not reasoned about: with one operator entry allowing `$HOME`, the
 * compiler accepted the config, the guardian exited 0 having applied the
 * restriction it was asked for, and the payload read the harness's own
 * `src/root-policy.ts` — a file the same spec listed as protected. Every
 * surface reported the protection as enabled. That is the failure this
 * project keeps rediscovering in other forms: a control that looks live and
 * covers nothing.
 *
 * The rule is DERIVED from the protected set rather than naming paths. `/`,
 * the harness installation and (in the ordinary layout) `$HOME` are all
 * ancestors of the harness's protected `src`, so all three are refused
 * without any of them being written down — and a protected subtree added
 * tomorrow gets the same defence with no edit here.
 *
 * WHY IT REFUSES RATHER THAN WARNING. A warning leaves the operator with a
 * working command and a message, which is the state in which the message is
 * ignored. The difference between "the allow-set is editable" and "there is
 * an off switch" is exactly whether a widening that would subsume the
 * protected set can succeed.
 *
 * IT COMPARES LOCATIONS, NOT SPELLINGS, and that is not a refinement — it is
 * the difference between this rule working and not. Every argument below is a
 * `ResolvedAbsolutePath`, so `<harnessRoot>/guardian/..`, `//home/x`,
 * `/home/x/.` and a symbolic link to the harness root all arrive here as the
 * one directory they actually name. Each of those four compiled cleanly while
 * the comparison was made on strings, and three of them reached a WRITE inside
 * the protected subtree. A resolved string is still not a location: a bind
 * mount (WSL's `/mnt/wslg/distro`) is a second spelling no realpath removes,
 * so every comparison here is by (device, inode) — `identityOverlapIndex`.
 *
 * STRENGTH LADDER — where this stopped, and why (§3), all five rungs answered
 * because two of them were previously left silent:
 *
 *   1. PHYSICALLY IMPOSSIBLE — reached for the protected subtrees (SEC-c).
 *      The C guardian opens every path ONCE without following links, refuses
 *      a rule under OR containing a protected subtree by (device, inode) of
 *      the location and every ancestor, and adds the rule from the very
 *      descriptor it checked — so a hand-written spec, a bind-mount alias and
 *      a swap between check and use are all refused by the binary itself.
 *      The refused paths and W^X below are this compiler's (the binary knows
 *      no access semantics beyond the spec).
 *   2. UNREPRESENTABLE — not available. "An allow-rule that subsumes a
 *      protected subtree" is a relationship between two values, not a shape;
 *      no type can exclude it, because both values are individually legal and
 *      only their combination is not.
 *   3. UNREACHABLE BY SHAPE — reached for the half that failed. The bug was
 *      never the relationship test; it was that the test ran on unresolved
 *      input. That IS a shape, and it is now enforced by the type: this
 *      function cannot be called with a path that has not been through
 *      `resolveLocation`, and neither can the rule builders that feed it.
 *   4. RUNTIME CHOKE POINT — reached, for the relationship itself, at the one
 *      door every compiled spec passes through, so the CLI bootstrap and the
 *      web server are both covered and neither had to remember.
 *   5. SOURCE SCAN — not used here and not needed; nothing about this rule
 *      depends on scanning a universe of files.
 */
function validateCompiledSpec(
  spec: GuardianSpec,
  allowRules: readonly ResolvedAllowRule[],
  keepOut: KeepOutPolicy,
  tempDir: ResolvedAbsolutePath | undefined,
): void {
  // BY IDENTITY, NOT SPELLING (`path-identity.ts`): a bind-mount alias names
  // the same protected place by another string.
  // One operation: a grant must not meet a listed entry nor CONTAIN an
  // install still keeping its key beside its database (looked for below it).
  const questions = keepOut.operation();
  const verdicts = new Map<string, ReturnType<KeepOutPolicy["verdict"]>>();
  const verdictOf = (path: ResolvedAbsolutePath, access?: readonly string[]): ReturnType<KeepOutPolicy["verdict"]> => {
    const key = `${path}\u0000${(access ?? []).join(",")}`;
    if (!verdicts.has(key)) verdicts.set(key, questions.grantVerdict(path, access));
    return verdicts.get(key);
  };
  // The HARNESS's own code first, in its own vocabulary (the wire code tells a
  // person "this folder is the harness"): a rule under it or containing it.
  const assertClearOfHarness = (path: ResolvedAbsolutePath, what: string, codes: Readonly<{ under: string; subsumes: string }>): void => {
    const verdict = verdictOf(path);
    if (verdict?.entry.source !== "harness") return;
    if (verdict.relation === "under") {
      throw new InputError(`${what} must not be under a protected subtree: ${path} under ${verdict.entry.path}`, codes.under);
    }
    throw new InputError(
      `${what} must not contain a protected subtree — allowing it would grant access to everything inside: ${path} contains ${verdict.entry.path}`,
      codes.subsumes,
    );
  };
  for (const rule of allowRules) {
    assertClearOfHarness(rule.path, "allow-rule path", {
      under: "self_protection_allow_rule_under_protected_subtree",
      subsumes: "self_protection_allow_rule_subsumes_protected_subtree",
    });
  }
  if (tempDir !== undefined) {
    assertClearOfHarness(tempDir, "tempDir", {
      under: "self_protection_temp_dir_under_protected_subtree",
      subsumes: "self_protection_temp_dir_subsumes_protected_subtree",
    });
  }
  // Every rule the spec carries — the floor's, the derived ones, the
  // operator's, the project root and the temp directory — for every consumer.
  const granted: readonly ResolvedAllowRule[] = tempDir === undefined
    ? allowRules
    : [...allowRules, { path: tempDir, access: [...DEFAULT_TEMP_DIR_ACCESS] }];
  assertWriteXorExecute(identityOverlapIndex(), granted);
  for (const rule of granted) {
    const verdict = verdictOf(rule.path, rule.access);
    if (verdict !== undefined) {
      throw new InputError(
        `a confined process may never be granted ${rule.path}: it ${verdict.relation === "under" ? "lies inside" : "contains"} ${verdict.entry.path}, which holds credentials, keys or the harness's own state`,
        "self_protection_rule_overlaps_refused_path",
      );
    }
  }
  const parsed = GUARDIAN_SPEC_SCHEMA.safeParse(spec);
  if (!parsed.success) {
    // A compiled spec the guardian contract refuses is the compiler's own
    // fault (a bound outgrown, a field mis-emitted): typed, never a raw
    // schema error out of every confined spawn.
    const issue = parsed.error.issues[0];
    throw new InputError(`the compiled confinement spec breaks the guardian contract at ${issue?.path.join(".") || "the spec"}: ${issue?.message ?? "invalid"}`, "self_protection_spec_invalid");
  }
}

/** Flags that only read, list or execute; any other flag makes a rule a WRITE rule. */
const NON_WRITING_ACCESS: ReadonlySet<LandlockAccessFsFlagName> = new Set(["READ_FILE", "READ_DIR", "EXECUTE"]);

/**
 * W^X AT THE FLOOR: no rule granting EXECUTE may overlap (by identity) a rule
 * granting any write flag — the payload, the interpreter, the server's tool
 * paths and the operator's rules alike, for every consumer. Otherwise a
 * confined process could write a program and then `execve` it.
 *
 * PRECISE RESIDUAL: Landlock's EXECUTE gates `execve` only. An allowed
 * interpreter (node, python) still RUNS a script it can read, including one
 * the process just wrote — so what this guarantees is "no writable file is
 * directly executable", not "no written code runs".
 */
function assertWriteXorExecute(identity: IdentityOverlapIndex, granted: readonly ResolvedAllowRule[]): void {
  const writable = granted.filter((rule) => rule.access.some((flag) => !NON_WRITING_ACCESS.has(flag)));
  for (const rule of granted) {
    if (!rule.access.includes("EXECUTE")) continue;
    const written = writable.find((other) => identity.overlaps(rule.path, other.path));
    if (written !== undefined) {
      throw new InputError(
        `a path a confined process may execute (${rule.path}) overlaps one it may write (${written.path}); a path it can write must never also be one it can execute`,
        "self_protection_execute_overlaps_writable",
      );
    }
  }
}

type RootPolicySelfProtectionView = Readonly<{
  minimumAllowSet: readonly Readonly<{ path: string; access: readonly LandlockAccessFsFlagName[] }>[];
  minimumLinkedReadFiles: readonly string[];
  bundleRelativePath: string;
  handledAccessFs: readonly LandlockAccessFsFlagName[];
}>;

/**
 * Synchronous guardian runner used by the availability/ABI probes. Uses
 * `execFileSync` with ignored stdio (except stderr for error classification).
 * Never throws; returns a typed result.
 */
function runGuardianSync(
  binaryPath: string,
  spec: GuardianSpec,
  payloadExecutable: string,
  payloadArgs: readonly string[],
  tempDir: string,
  silentStderr: boolean,
): GuardianBinaryResult {
  const specPath = join(tempDir, `${ownedTemporaryName("probe-")}.json`);
  writeFileSync(specPath, canonicalJson(spec), { mode: PRIVATE_STATE_FILE_MODE });
  try {
    const stderrBuffers: Buffer[] = [];
    const result = spawnSyncGuardian(binaryPath, specPath, payloadExecutable, payloadArgs, silentStderr, stderrBuffers);
    const stderr = stderrBuffers.map((b) => b.toString("utf8")).join("");
    return classifyGuardianResult(result.exitCode, stderr);
  } finally {
    rmSync(specPath, { force: true });
  }
}

function spawnSyncGuardian(
  binaryPath: string,
  specPath: string,
  payloadExecutable: string,
  payloadArgs: readonly string[],
  silentStderr: boolean,
  stderrBuffers: Buffer[],
): Readonly<{ exitCode: number }> {
  const result = spawnSync(
    binaryPath,
    ["apply", "--spec", specPath, "--exec", payloadExecutable, ...payloadArgs],
    {
      stdio: ["ignore", "ignore", silentStderr ? "pipe" : "inherit"],
      encoding: null,
    },
  );
  if (Buffer.isBuffer(result.stderr)) stderrBuffers.push(result.stderr);
  const exitCode = result.status ?? -1;
  return { exitCode };
}

/**
 * Classify a guardian exit code + stderr into a typed result. The guardian
 * prints `landlock-guardian: <code>: <message>` to stderr before exec on
 * failure; the marker disambiguates a pre-exec failure from a payload that
 * happens to exit with a documented code (e.g. 64).
 *
 * Exported because the distinction it draws — "the guardian refused, so the
 * payload never ran" versus "the payload ran and exited with this" — is the
 * difference between a refusal and a result, and every caller that spawns the
 * guardian has to draw it. A second caller re-deriving it from the exit code
 * alone would call a payload that legitimately exits 4 a spec failure.
 */
export function classifyGuardianResult(exitCode: number, stderr: string): GuardianBinaryResult {
  if (isGuardianPreExecFailure(exitCode)) {
    const line = guardianFailureLine(stderr, exitCode);
    if (line !== undefined) {
      return deepFreeze<GuardianBinaryResult>({ kind: "pre_exec_failure", exitCode, message: line });
    }
  }
  return deepFreeze<GuardianBinaryResult>({ kind: "payload_exited", exitCode });
}

/**
 * The prefix the guardian writes when it refuses: the marker, the exit code it
 * is about to exit with, and a colon — `landlock-guardian: 4: `. One owner,
 * consumed by the classifier and by the notice stripper in the web server, so
 * the two cannot drift into recognising different things.
 */
export function guardianFailureLinePrefix(exitCode: number): string {
  return `${GUARDIAN_FAILURE_MARKER} ${exitCode}: `;
}

/**
 * A fresh matcher for a WHOLE LINE the guardian itself wrote — the marker, a
 * decimal code and a colon, anchored at the start. The guardian's success
 * notice (`landlock-guardian: 0: default_deny…`) matches too, which is the
 * point: the same shape identifies every line the guardian is responsible for.
 *
 * ONE OWNER because there are two consumers with the same question and
 * different jobs: this module classifies a refusal, and the web server removes
 * the guardian's chatter from what the model is shown. Two independently
 * written spellings of "a line the guardian wrote" is precisely how one of
 * them starts recognising something the other does not.
 *
 * NARROW ON PURPOSE. Matching the bare marker anywhere in a line deleted a
 * program's OWN words from its output whenever they happened to start with it.
 * Requiring the full documented shape leaves anything else the program said
 * intact, which is the correct default for output that is not ours.
 *
 * A FRESH RegExp EACH CALL, not a shared constant: a module-level literal
 * would be shared mutable state through `lastIndex` if any caller ever added
 * the global flag, and the allocation is nothing next to what a caller does
 * with the answer.
 */
export function guardianNoticeLinePattern(): RegExp {
  return new RegExp(`^${GUARDIAN_FAILURE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+: `);
}

/**
 * The guardian's own refusal line for `exitCode`, or `undefined` when the
 * captured stderr does not contain one.
 *
 * ANCHORED AT THE START OF A LINE, AND CARRYING THE EXIT CODE. Accepting the
 * marker ANYWHERE in stderr — which is what this did — let a payload
 * manufacture its own refusal: print a line mentioning `landlock-guardian:`,
 * exit with any documented code, and the run is recorded as "the command never
 * ran, stdout empty" while it ran and had effects. That is a false negative in
 * the ledger, which is the worse direction, because nothing downstream ever
 * looks again at a command that did not run.
 *
 * Both halves are needed and neither is sufficient. The anchor alone still
 * accepts a payload whose own first-column output begins with the marker; the
 * exit code alone still accepts the marker quoted mid-line. Together the
 * payload must reproduce the guardian's exact prefix at the start of a line
 * AND exit with the matching code — a coincidence it has to be trying for.
 *
 * PRECISE RESIDUAL, since a security claim wider than the measurement is the
 * defect this file exists to refuse: a payload that does exactly that is still
 * misread, and so is the one case where the guardian itself prints a coded
 * line and then continues (`warn(5, …)` when `setenv` fails, after which the
 * restriction IS applied and the payload DOES run). Closing those needs a
 * channel the payload cannot write to — a pipe of the guardian's own — which
 * is a change to the pinned binary.
 */
function guardianFailureLine(stderr: string, exitCode: number): string | undefined {
  const prefix = guardianFailureLinePrefix(exitCode);
  for (const line of stderr.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return undefined;
}
