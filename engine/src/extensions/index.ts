/**
 * Extensions module — controlled self-evolution and extension lifecycle.
 *
 * This is the governed surface for harness self-modification per * delivery map item 12 and canonical requirement DER-030 / REQ-026. It
 * combines:
 * the versioned extension manifest registry (one canonical registry),
 * the compatibility checker (version/capability/dependency/conflict),
 * the lifecycle state machine (add/edit/deprecate/delete/upgrade/
 * downgrade/enable/disable/rollback),
 * the approval workflow (propose → approve → apply → review → activate/
 * rollback),
 * the self-modification tools (the ONLY entry points).
 *
 * Per root-policy `runtimeEnforcementAvailable: false`, the OS-enforced
 * privileged update broker is a documented future slice; this module is the
 * target-invariant authority and typed tool surface.
 */

export {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  EXTENSION_TYPES,
  EXTENSION_STATUSES,
  EXTENSION_OPERATIONS,
  createExtensionManifest,
  extensionEntryHash,
  isExtensionType,
  isExtensionStatus,
  validateExtensionManifestEntry,
  normalizeEntryForDiff,
  ExtensionManifestError,
} from "./extension-manifest.ts";
export type {
  ExtensionType,
  ExtensionStatus,
  ExtensionOperation,
  ExtensionDependency,
  ExtensionProvenance,
  ExtensionManifestEntry,
  ExtensionManifestSnapshot,
  ExtensionManifest,
} from "./extension-manifest.ts";

export {
  parseSemver,
  compareSemver,
  semverEqual,
  isPrerelease,
  parseComparator,
  satisfiesComparator,
  parseVersionRange,
  satisfiesRange,
  isValidSemver,
  isValidRange,
} from "./semver.ts";
export type { Semver, Comparator, ComparatorOperator, VersionRange, RangeToken } from "./semver.ts";

export {
  checkCompatibility,
  checkBackwardCompatibility,
  assertCompatible,
  isBlocking,
  COMPATIBILITY_SEVERITY,
} from "./compatibility-checker.ts";
export type {
  CompatibilitySeverity,
  CompatibilityFinding,
  CompatibilityReport,
  BackwardCompatibilityReport,
  HarnessApiContract,
  CapabilityOwnership,
  CompatibilityCheckOptions,
} from "./compatibility-checker.ts";

export {
  LIFECYCLE_TRANSITIONS,
  isLegalTransition,
  legalTransitionsFor,
  legalTargetsFrom,
  proposeAdd,
  proposeEdit,
  proposeStatusChange,
  proposeVersionChange,
  proposeDelete,
  proposeRollback,
  LifecycleError,
} from "./extension-lifecycle.ts";
export type {
  LifecycleTransition,
  LifecycleResult,
  LifecycleContext,
  AddOptions,
  EditOptions,
  StatusChangeOptions,
  VersionChangeOptions,
  DeleteOptions,
  RollbackOptions,
} from "./extension-lifecycle.ts";

export {
  createApprovalWorkflow,
  createMemoryApprovalStateStore,
  assessRisk,
  RISK_LEVELS,
  PROPOSAL_STATUSES,
  ApprovalError,
} from "./approval-workflow.ts";
export type {
  RiskLevel,
  RiskAssessment,
  ModificationScope,
  ModificationProposal,
  ProposalStatus,
  ApprovalPrincipal,
  ApprovalGrant,
  ReviewVerdict,
  ReviewResult,
  ActivationOutcome,
  ActivationApplier,
  ExtensionEffectRecorder,
  ApprovalWorkflow,
  ApprovalWorkflowOptions,
  ApprovalStateStore,
  ProposeOptions,
} from "./approval-workflow.ts";

export {
  SELF_MODIFICATION_TOOL_IDS,
  SELF_MODIFICATION_TOOL_MANIFEST,
  isSelfModificationTool,
  extensionTypeForTool,
  operationForTool,
  invokeAddTool,
  invokeEditTool,
  invokeDeleteTool,
  invokeEnableDisableTool,
  invokeUpgradeDowngradeTool,
  invokeRollbackTool,
  dispatchAdd,
  dispatchEdit,
  dispatchDelete,
  validateWriteSetForTool,
  writeSetIdentity,
  SelfModificationError,
} from "./self-modification-tools.ts";
export type {
  SelfModificationToolId,
  AddToolInput,
  EditToolInput,
  DeleteToolInput,
  EnableDisableToolInput,
  UpgradeDowngradeToolInput,
  RollbackToolInput,
  ToolContext,
  DispatchResult,
  ToolManifestEntry,
} from "./self-modification-tools.ts";
