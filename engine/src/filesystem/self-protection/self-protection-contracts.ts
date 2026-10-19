import { z } from "zod";

import { canonicalHash, deepFreeze, type DeepReadonly } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";

/**
 * Central self-protection (Landlock guardian) contracts.
 *
 * ONE canonical owner for the Landlock access-fs flag vocabulary, the guardian
 * ruleset-spec schema, the guardian binary error codes, and the typed result
 * of a guardian invocation. Every consumer imports from here; the C binary's
 * `guardian/landlock-guardian.h` `LANDLOCK_FS_FLAGS` table is a mirror of
 * {@link LANDLOCK_ACCESS_FS_FLAG_NAMES} (contract-tested by
 * `test/filesystem/self-protection/contract/guardian-spec-contract.test.ts`,
 * not a parallel truth).
 *
 * This module deliberately does NOT import `root-policy.ts`: the non-overridable
 * safety floor lives in `root-policy.ts` and consumes this vocabulary, so the
 * dependency direction is `root-policy -> contracts` (no cycle). The
 * operator-facing config schema lives in `self-protection-config.ts` and
 * imports this module for the flag-name enums.
 */

export const GUARDIAN_SPEC_SCHEMA_VERSION = schemaId("self-protection-spec", 1);

/**
 * The 16 canonical `LANDLOCK_ACCESS_FS_*` short names (Landlock ABI 1-5), in
 * the canonical order the C binary's `LANDLOCK_FS_FLAGS` table uses. Short
 * names are the spec-facing strings WITHOUT the `LANDLOCK_ACCESS_FS_` prefix.
 * This is the single authority consumed by the spec schema, the config schema
 * enums, the root-policy floor, and the contract test.
 */
export const LANDLOCK_ACCESS_FS_FLAG_NAMES = deepFreeze([
  "EXECUTE", "WRITE_FILE", "READ_FILE", "READ_DIR",
  "REMOVE_DIR", "REMOVE_FILE", "MAKE_CHAR", "MAKE_DIR",
  "MAKE_REG", "MAKE_SOCK", "MAKE_FIFO", "MAKE_BLOCK",
  "MAKE_SYM", "REFER", "TRUNCATE", "IOCTL_DEV",
] as const);
export type LandlockAccessFsFlagName = typeof LANDLOCK_ACCESS_FS_FLAG_NAMES[number];

export type LandlockFlagAppliesTo = "any" | "dir-only";

/**
 * Per-flag metadata: the minimum Landlock ABI that supports the flag, and the
 * inode types the flag may govern in an allow-rule's `access`. `any` flags are
 * valid on both file-targeted and directory-targeted rules; `dir-only` flags
 * are valid only on directory-targeted rules (a file rule with a `dir-only`
 * flag is rejected at validation, mirroring the C binary's exit 4). This table
 * mirrors `guardian/landlock-guardian.h` `LANDLOCK_FS_FLAGS` exactly.
 */
export const LANDLOCK_FLAG_METADATA = deepFreeze({
  EXECUTE:     { minAbi: 1, appliesTo: "any" as const },
  WRITE_FILE:  { minAbi: 1, appliesTo: "any" as const },
  READ_FILE:   { minAbi: 1, appliesTo: "any" as const },
  READ_DIR:    { minAbi: 1, appliesTo: "dir-only" as const },
  REMOVE_DIR:  { minAbi: 1, appliesTo: "dir-only" as const },
  REMOVE_FILE: { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_CHAR:   { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_DIR:    { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_REG:    { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_SOCK:   { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_FIFO:   { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_BLOCK:  { minAbi: 1, appliesTo: "dir-only" as const },
  MAKE_SYM:    { minAbi: 1, appliesTo: "dir-only" as const },
  REFER:       { minAbi: 2, appliesTo: "dir-only" as const },
  TRUNCATE:    { minAbi: 3, appliesTo: "any" as const },
  IOCTL_DEV:   { minAbi: 5, appliesTo: "dir-only" as const },
} as const) as Readonly<Record<LandlockAccessFsFlagName, Readonly<{ minAbi: number; appliesTo: LandlockFlagAppliesTo }>>>;

/** The file-level flags valid on a file-targeted allow-rule. */
export const FILE_LEVEL_FLAGS = deepFreeze(
  LANDLOCK_ACCESS_FS_FLAG_NAMES.filter(
    (name) => LANDLOCK_FLAG_METADATA[name].appliesTo === "any",
  ) as readonly LandlockAccessFsFlagName[],
);
/** The directory-only flags rejected on a file-targeted allow-rule. */
export const DIR_ONLY_FLAGS = deepFreeze(
  LANDLOCK_ACCESS_FS_FLAG_NAMES.filter(
    (name) => LANDLOCK_FLAG_METADATA[name].appliesTo === "dir-only",
  ) as readonly LandlockAccessFsFlagName[],
);

/**
 * The access flags granted on the user's project root: the model may read,
 * write, create, truncate, and remove files/dirs there. This is the realistic
 * "project workspace" surface from the EXECUTE-vs-READ research. ONE owner;
 * consumed by `compileSelfProtectionConfigToSpec`.
 */
export const PROJECT_ROOT_ACCESS_FLAGS = deepFreeze([
  "READ_FILE", "WRITE_FILE", "READ_DIR",
  "MAKE_REG", "MAKE_DIR", "MAKE_SYM",
  "TRUNCATE", "REMOVE_FILE", "REMOVE_DIR",
] as const);
export type ProjectRootAccessFlag = typeof PROJECT_ROOT_ACCESS_FLAGS[number];

/**
 * The default temp-dir access set (the C binary's default `temp_dir_access`
 * when the operator omits it): read, list, write, create, truncate, and
 * remove files/dirs inside the temp dir. Matches the C binary's documented
 * default so the compiled spec and the binary agree.
 */
export const DEFAULT_TEMP_DIR_ACCESS = deepFreeze([
  "READ_FILE", "READ_DIR", "WRITE_FILE",
  "TRUNCATE", "MAKE_REG", "MAKE_DIR", "MAKE_SYM",
  "REMOVE_FILE", "REMOVE_DIR",
] as const);
export type DefaultTempDirAccessFlag = typeof DEFAULT_TEMP_DIR_ACCESS[number];

const flagNameEnum = z.enum(LANDLOCK_ACCESS_FS_FLAG_NAMES);

/**
 * The Zod schema for the JSON ruleset spec the C binary consumes. This is the
 * authoritative shape; `compileSelfProtectionConfigToSpec` produces values that
 * satisfy it, and the contract test verifies the C binary agrees on the
 * semantic rules (flag names, subset, file-vs-dir). `strictObject` catches
 * harness compiler bugs that emit undocumented keys; the C binary itself
 * ignores unknown keys, so the contract test only exercises rejections both
 * sides agree on (flag names, subset, temp_dir_access-without-temp_dir).
 */
/**
 * The most protected subtrees one spec carries. The keep-out list grows with
 * the registry of harness stores (every checkout, lab and backup on the host,
 * each database with its family): 64 was reached on a real workstation once
 * its installs were registered, and a spec over the bound refused EVERY
 * confined spawn. The guardian itself has no count bound (it reads up to
 * 64 MiB of spec and opens each entry once).
 */
export const MAXIMUM_PROTECTED_SUBTREES = 4096;

export const GUARDIAN_SPEC_SCHEMA = z.strictObject({
  abi_version_hint: z.number().int().nonnegative().max(64),
  handled_access_fs: z.array(flagNameEnum).min(1).max(16),
  allow_rules: z.array(
    z.strictObject({
      path: z.string().min(1).max(4096),
      access: z.array(flagNameEnum).min(1).max(16),
    }),
  ).min(1).max(256),
  protected_subtrees: z.array(z.string().min(1).max(4096)).max(MAXIMUM_PROTECTED_SUBTREES),
  /** The rest of the keep-out list present at compile time; an entry gone by the time the guardian opens it is kept by its folder and its name. */
  keep_out: z.array(z.string().min(1).max(4096)).max(MAXIMUM_PROTECTED_SUBTREES).optional(),
  /** How many times the guardian re-locates a keep-out entry that changed while it was located (ESTALE); required with `keep_out`. */
  keep_out_retries: z.number().int().min(0).max(16).optional(),
  default_deny_outside_allow_rules: z.boolean().optional(),
  temp_dir: z.string().min(1).max(4096).optional(),
  temp_dir_access: z.array(flagNameEnum).max(16).optional(),
}).superRefine((spec, ctx) => {
  if (spec.keep_out !== undefined && spec.keep_out_retries === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["keep_out_retries"], message: "keep_out_retries is required with keep_out" });
  }
  if (spec.temp_dir_access !== undefined && spec.temp_dir === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["temp_dir_access"],
      message: "temp_dir_access specified without temp_dir",
    });
  }
});

export type GuardianSpec = DeepReadonly<z.infer<typeof GUARDIAN_SPEC_SCHEMA>>;

/**
 * Mask a set of flag names to the flags valid at the given ABI version, dropping
 * any flag whose `minAbi` exceeds `abi`. This mirrors the C binary's
 * `mask_flags_to_abi` helper and is the kernel-docs-recommended pattern: never
 * pass flags the running kernel does not know.
 */
export function maskFlagNamesToAbi(
  flags: readonly LandlockAccessFsFlagName[],
  abi: number,
): readonly LandlockAccessFsFlagName[] {
  return flags.filter((name) => LANDLOCK_FLAG_METADATA[name].minAbi <= abi);
}

/** The set of flag names valid on a file-targeted allow-rule. */
export function isFileLevelFlag(name: LandlockAccessFsFlagName): boolean {
  return LANDLOCK_FLAG_METADATA[name].appliesTo === "any";
}

/** Whether `name` is valid on a rule targeting the given inode kind. */
export function flagValidForRuleKind(
  name: LandlockAccessFsFlagName,
  ruleKind: "file" | "directory",
): boolean {
  if (ruleKind === "directory") return true;
  return isFileLevelFlag(name);
}

/**
 * Guardian binary exit codes (before exec). From `guardian/README.md`:
 * 2=spec_parse, 3=landlock_unavailable, 4=spec_invalid, 5=prctl, 6=create_ruleset,
 * 7=add_rule, 8=restrict_self, 9=exec_failed, 10=keep_out_exposed (a keep-out
 * entry's link hop, target or would-be target, or a mount showing it, lies in
 * a grant of THIS spawn), 64=usage. Any other exit code is
 * the payload's exit code (the guardian execvp'd the payload).
 */
export const GUARDIAN_BINARY_ERROR_CODES = deepFreeze({
  2: "spec_parse_error",
  3: "landlock_unavailable",
  4: "spec_invalid",
  5: "prctl_failed",
  6: "create_ruleset_failed",
  7: "add_rule_failed",
  8: "restrict_self_failed",
  9: "exec_failed",
  10: "keep_out_exposed",
  64: "usage",
} as const);
export type GuardianBinaryExitCode = keyof typeof GUARDIAN_BINARY_ERROR_CODES;
export type GuardianBinaryErrorCode = typeof GUARDIAN_BINARY_ERROR_CODES[GuardianBinaryExitCode];

const PRE_EXEC_FAILURE_CODES: readonly GuardianBinaryExitCode[] =
  Object.keys(GUARDIAN_BINARY_ERROR_CODES).map((n) => Number(n) as GuardianBinaryExitCode);

/** True if an exit code is a documented guardian pre-exec failure. */
export function isGuardianPreExecFailure(exitCode: number): exitCode is GuardianBinaryExitCode {
  return (PRE_EXEC_FAILURE_CODES as readonly number[]).includes(exitCode);
}

/** The stderr marker the guardian prints before exec on failure: `landlock-guardian: <code>:`. */
export const GUARDIAN_FAILURE_MARKER = "landlock-guardian:";

/**
 * Typed result of a guardian invocation. When the guardian successfully
 * execs the payload, the guardian process is replaced by the payload and the
 * child's exit code is the payload's. When the guardian fails BEFORE exec, it
 * prints `landlock-guardian: <code>: <message>` to stderr and exits with a
 * documented code. `classifyGuardianResult` tells the two cases apart by exit
 * code and the stderr marker.
 */
export type GuardianBinaryResult =
  | Readonly<{ kind: "payload_exited"; exitCode: number }>
  | Readonly<{ kind: "pre_exec_failure"; exitCode: GuardianBinaryExitCode; message: string }>;

/**
 * Typed availability of the guardian binary + Landlock on the current host.
 * Never throws; never silently falls back. `available: false` carries a typed
 * `code` naming the operator action.
 */
export type GuardianBinaryAvailability =
  | Readonly<{
    available: true;
    binaryPath: string;
    sha256: string;
    kernelAbi: number;
  }>
  | Readonly<{
    available: false;
    code:
      | "binary_missing"
      | "binary_hash_mismatch"
      | "landlock_unavailable"
      | "platform_unsupported";
    fallbackAttempted: false;
  }>;

/**
 * Generated Draft 2020-12 JSON schema projection of {@link GUARDIAN_SPEC_SCHEMA},
 * for publication to `traceability/self-protection/guardian-spec-schema.json`.
 * Mirrors the contract/forensic schema artifacts: one Zod authority, one
 * generated projection with a stable `schemaHash`.
 */
export const GENERATED_GUARDIAN_SPEC_SCHEMAS = deepFreeze(
  z.toJSONSchema(GUARDIAN_SPEC_SCHEMA, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    cycles: "ref",
    reused: "inline",
  }),
);
export const GUARDIAN_SPEC_SCHEMA_HASH = canonicalHash(GENERATED_GUARDIAN_SPEC_SCHEMAS);
