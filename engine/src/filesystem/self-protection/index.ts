/**
 * Self-protection public barrel. Explicit named re-exports only — no
 * `export *` — so the public surface stays discoverable and tree-shakeable,
 * matching `src/performance/index.ts` and the barrel convention enforced by
 * `test/index-exports.test.ts`.
 */

export {
  GUARDIAN_SPEC_SCHEMA_VERSION,
  GUARDIAN_SPEC_SCHEMA,
  GUARDIAN_SPEC_SCHEMA_HASH,
  GENERATED_GUARDIAN_SPEC_SCHEMAS,
  GUARDIAN_BINARY_ERROR_CODES,
  GUARDIAN_FAILURE_MARKER,
  LANDLOCK_ACCESS_FS_FLAG_NAMES,
  LANDLOCK_FLAG_METADATA,
  FILE_LEVEL_FLAGS,
  DIR_ONLY_FLAGS,
  PROJECT_ROOT_ACCESS_FLAGS,
  DEFAULT_TEMP_DIR_ACCESS,
  maskFlagNamesToAbi,
  isFileLevelFlag,
  flagValidForRuleKind,
  isGuardianPreExecFailure,
  type GuardianSpec,
  type GuardianBinaryResult,
  type GuardianBinaryAvailability,
  type GuardianBinaryExitCode,
  type GuardianBinaryErrorCode,
  type LandlockAccessFsFlagName,
  type LandlockFlagAppliesTo,
  type ProjectRootAccessFlag,
  type DefaultTempDirAccessFlag,
} from "./self-protection-contracts.ts";

export {
  SELF_PROTECTION_CONFIG_SCHEMA_VERSION,
  SELF_PROTECTION_CONFIG_SCHEMA,
  SELF_PROTECTION_CONFIG_SCHEMA_HASH,
  DEFAULT_SELF_PROTECTION_CONFIG,
  parseSelfProtectionConfig,
  resolveSelfProtectionConfig,
  selfProtectionConfigViolations,
  type SelfProtectionConfig,
} from "./self-protection-config.ts";

export {
  resolveGuardianBinaryPath,
  verifyGuardianBinaryAvailability,
  compileSelfProtectionConfigToSpec,
  classifyGuardianResult,
  guardianFailureLinePrefix,
  guardianNoticeLinePattern,
  assertProtectedFilesHaveOneName,
  invalidateProtectedNameCheck,
  type ProtectedNameWalk,
} from "./guardian-binary.ts";

export {
  keepOutInForce,
  keepOutPolicyFor,
  keepOutListBuilds,
  hostHomes,
  type KeepOutEntry,
  type KeepOutFacts,
  type KeepOutPolicy,
  type KeepOutQuestions,
  type KeepOutSource,
  type KeepOutVerdict,
} from "./keep-out.ts";

export {
  keyHomeLocation,
  admitKeyHome,
  admitHarnessKeyHome,
  databaseKeyName,
  databaseKeyFile,
  databaseSaltFile,
  registerHarnessStore,
  forgetHarnessStore,
  openStoreRegistry,
  type AdmittedKeyHome,
  type HarnessStoreRecord,
  type HarnessStoreRegistry,
  type KeyHomeNeighbour,
} from "./key-home.ts";

// The second-name question has ONE owner and it is not this subsystem — the
// repository readers and the web UI's filesystem gate ask it too. Re-exported
// here so a consumer that already speaks to self-protection does not acquire a
// second import path to the same answer.
export {
  hasSecondName,
  pathHasSecondName,
  refusesSecondNames,
  pathIsRefusedSecondName,
} from "../link-containment.ts";

export {
  resolveLocation,
  identityOverlapIndex,
  createPathLocator,
  assertResolvesWithinRegion,
  staysWithinRegion,
  type PathRegion,
  type ResolvedAbsolutePath,
} from "../path-identity.ts";
