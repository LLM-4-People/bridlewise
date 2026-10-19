import { HarnessError, InputError, SecurityError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import {
  type ExtensionManifest,
  type ExtensionManifestEntry,
  type ExtensionOperation,
  type ExtensionType,
} from "./extension-manifest.ts";
import {
  type CompatibilityReport,
  type CapabilityOwnership,
  type HarnessApiContract,
  type CompatibilityCheckOptions,
  checkCompatibility,
} from "./compatibility-checker.ts";
import {
  type LifecycleResult,
  type LifecycleContext,
  proposeAdd,
  proposeEdit,
  proposeDelete,
  proposeStatusChange,
  proposeVersionChange,
  proposeRollback,
} from "./extension-lifecycle.ts";
import {
  type ApprovalWorkflow,
  type ModificationProposal,
  type ProposeOptions,
} from "./approval-workflow.ts";

/**
 * Self-modification tools — the ONLY entry points for harness
 * self-modification.
 *
 * Per delivery map item 12: "Harness self-modification goes only
 * through dedicated tools, explicit user approval, exact backups,
 * independent review, and rollback; other in-harness entry points must not
 * edit installation files." Per root-policy selfEvolutionArchitecture:
 * `generalInstalledFileWriteToolAllowed: false`,
 * `generalProcessToolForMutationAllowed: false`, and
 * `llmFacingTools: ["inspect","list","validate","plan","add","edit","deprecate","delete","rollback"]`.
 *
 * The tools are typed proposal generators: each takes a manifest + an input
 * describing the desired change, runs the lifecycle proposal (which validates
 * compatibility, capabilities, dependencies, conflicts, and the transition),
 * and returns a `ModificationProposal` to the approval workflow. They NEVER
 * write directly — the approval workflow and the transactional editor (via
 * the `ActivationApplier` port) own persistence and atomic activation.
 *
 * The tools cover the seven extension types from root-policy, mapped to the
 * nine lifecycle operations:
 * provider-adapter -> add/edit/delete/enable/disable/upgrade/downgrade/rollback
 * model-profile -> add/edit/delete/enable/disable/upgrade/downgrade/rollback
 * mcp-tool-or-adapter -> same
 * agent-profile -> same
 * quality-pack -> same
 * editor-repository-or-search-capability -> same
 * cohesive-product-module -> same
 *
 * The `SELF_MODIFICATION_TOOL_IDS` constant is the closed registry of
 * authorized self-modification tool entry points. Any other in-harness entry
 * point that attempts to edit installation files must be rejected by central
 * policy (per `bypassPolicy.unregisteredOrDirectLowLevelEntrypointsAllowed: false`).
 */

export const SELF_MODIFICATION_TOOL_IDS = deepFreeze([
  "add_provider",
  "edit_provider",
  "delete_provider",
  "add_model",
  "edit_model",
  "delete_model",
  "add_tool",
  "edit_tool",
  "delete_tool",
  "add_quality_pack",
  "edit_quality_pack",
  "delete_quality_pack",
  "add_agent_type",
  "edit_agent_type",
  "delete_agent_type",
  "add_module",
  "edit_module",
  "delete_module",
] as const);

export type SelfModificationToolId = typeof SELF_MODIFICATION_TOOL_IDS[number];

const TOOL_TO_TYPE: Readonly<Record<SelfModificationToolId, ExtensionType>> = deepFreeze({
  add_provider: "provider-adapter",
  edit_provider: "provider-adapter",
  delete_provider: "provider-adapter",
  add_model: "model-profile",
  edit_model: "model-profile",
  delete_model: "model-profile",
  add_tool: "mcp-tool-or-adapter",
  edit_tool: "mcp-tool-or-adapter",
  delete_tool: "mcp-tool-or-adapter",
  add_quality_pack: "quality-pack",
  edit_quality_pack: "quality-pack",
  delete_quality_pack: "quality-pack",
  add_agent_type: "agent-profile",
  edit_agent_type: "agent-profile",
  delete_agent_type: "agent-profile",
  add_module: "cohesive-product-module",
  edit_module: "cohesive-product-module",
  delete_module: "cohesive-product-module",
} as const);

const TOOL_TO_OPERATION: Readonly<Record<SelfModificationToolId, ExtensionOperation>> = deepFreeze({
  add_provider: "add",
  edit_provider: "edit",
  delete_provider: "delete",
  add_model: "add",
  edit_model: "edit",
  delete_model: "delete",
  add_tool: "add",
  edit_tool: "edit",
  delete_tool: "delete",
  add_quality_pack: "add",
  edit_quality_pack: "edit",
  delete_quality_pack: "delete",
  add_agent_type: "add",
  edit_agent_type: "edit",
  delete_agent_type: "delete",
  add_module: "add",
  edit_module: "edit",
  delete_module: "delete",
} as const);

export type AddToolInput = Readonly<{
  toolId: "add_provider" | "add_model" | "add_tool" | "add_quality_pack" | "add_agent_type" | "add_module";
  entry: ExtensionManifestEntry;
  targetStatus?: ExtensionManifestEntry["status"];
  description: string;
  rationale: string;
  writeSet: readonly string[];
  requiredCapabilities?: readonly string[];
}>;

export type EditToolInput = Readonly<{
  toolId: "edit_provider" | "edit_model" | "edit_tool" | "edit_quality_pack" | "edit_agent_type" | "edit_module";
  id: string;
  changes: Partial<Omit<ExtensionManifestEntry, "id" | "type" | "createdAt">>;
  description: string;
  rationale: string;
  writeSet: readonly string[];
  requiredCapabilities?: readonly string[];
}>;

export type DeleteToolInput = Readonly<{
  toolId: "delete_provider" | "delete_model" | "delete_tool" | "delete_quality_pack" | "delete_agent_type" | "delete_module";
  id: string;
  description: string;
  rationale: string;
  writeSet: readonly string[];
  updatedAt: string;
}>;

export type EnableDisableToolInput = Readonly<{
  toolId: string;
  id: string;
  operation: "enable" | "disable";
  targetStatus: ExtensionManifestEntry["status"];
  description: string;
  rationale: string;
  writeSet: readonly string[];
  updatedAt: string;
}>;

export type UpgradeDowngradeToolInput = Readonly<{
  toolId: string;
  id: string;
  operation: "upgrade" | "downgrade";
  newVersion: string;
  description: string;
  rationale: string;
  writeSet: readonly string[];
  updatedAt: string;
  newCompatibilityRange?: string;
  newEntryPoint?: string;
  newCapabilities?: readonly string[];
  newDependencies?: ExtensionManifestEntry["dependencies"];
  newProvenance?: ExtensionManifestEntry["provenance"];
}>;

export type RollbackToolInput = Readonly<{
  toolId: string;
  id: string;
  description: string;
  rationale: string;
  writeSet: readonly string[];
  updatedAt: string;
}>;

export class SelfModificationError extends HarnessError {
  constructor(message: string, code = "self_modification_invalid") {
    super(message, code);
  }
}

function assertToolId(value: string): asserts value is SelfModificationToolId {
  if (!SELF_MODIFICATION_TOOL_IDS.includes(value as SelfModificationToolId)) {
    throw new SecurityError(
      `Tool id '${value}' is not a registered self-modification tool`,
      "self_modification_unregistered_tool",
    );
  }
}

function assertToolTypeMatch(toolId: SelfModificationToolId, entryType: ExtensionType): void {
  const expected = TOOL_TO_TYPE[toolId];
  if (entryType !== expected) {
    throw new SelfModificationError(
      `Tool '${toolId}' expects extension type '${expected}', got '${entryType}'`,
      "self_modification_type_mismatch",
    );
  }
}

export type ToolContext = Readonly<{
  manifest: ExtensionManifest;
  workflow: ApprovalWorkflow;
  harness?: HarnessApiContract;
  capabilityOwnerships?: readonly CapabilityOwnership[];
}>;

function buildLifecycleContext(context: ToolContext): LifecycleContext {
  return {
    manifest: context.manifest,
    ...(context.harness !== undefined ? { harness: context.harness } : {}),
    ...(context.capabilityOwnerships !== undefined ? { capabilityOwnerships: context.capabilityOwnerships } : {}),
  };
}

function buildAddCompatOptions(input: AddToolInput, manifest: ExtensionManifest, entry: ExtensionManifestEntry): CompatibilityCheckOptions {
  return {
    manifest,
    entry,
    ...(input.requiredCapabilities !== undefined ? { requiredCapabilities: input.requiredCapabilities } : {}),
  };
}
void buildAddCompatOptions;

export function isSelfModificationTool(toolId: string): boolean {
  return SELF_MODIFICATION_TOOL_IDS.includes(toolId as SelfModificationToolId);
}

export function extensionTypeForTool(toolId: SelfModificationToolId): ExtensionType {
  return TOOL_TO_TYPE[toolId];
}

export function operationForTool(toolId: SelfModificationToolId): ExtensionOperation {
  return TOOL_TO_OPERATION[toolId];
}

function toProposeOptions(
  lifecycle: LifecycleResult,
  context: ToolContext,
  description: string,
  rationale: string,
  writeSet: readonly string[],
): ProposeOptions {
  const dependents = context.manifest.dependents(lifecycle.extensionId);
  return {
    scope: {
      extensionId: lifecycle.extensionId,
      operation: lifecycle.operation,
      writeSet: [...writeSet],
    },
    lifecycle,
    description,
    rationale,
    compatibility: lifecycle.compatibility,
    dependents,
    reversible: lifecycle.operation !== "delete",
  };
}

export function invokeAddTool(input: AddToolInput, context: ToolContext): ModificationProposal {
  assertToolId(input.toolId);
  assertToolTypeMatch(input.toolId, input.entry.type);
  const lifecycleContext: LifecycleContext = buildLifecycleContext(context);
  const lifecycle = proposeAdd({
    context: lifecycleContext,
    entry: input.entry,
    ...(input.targetStatus !== undefined ? { targetStatus: input.targetStatus } : {}),
    ...(input.requiredCapabilities !== undefined ? { requiredCapabilities: input.requiredCapabilities } : {}),
  });
  const opts = toProposeOptions(lifecycle, context, input.description, input.rationale, input.writeSet);
  return context.workflow.propose(opts);
}

export function invokeEditTool(input: EditToolInput, context: ToolContext): ModificationProposal {
  assertToolId(input.toolId);
  const existing = context.manifest.get(input.id);
  if (existing === undefined) {
    throw new InputError(`Extension '${input.id}' is not registered`, "self_modification_not_found");
  }
  assertToolTypeMatch(input.toolId, existing.type);
  const lifecycleContext: LifecycleContext = buildLifecycleContext(context);
  const lifecycle = proposeEdit({
    context: lifecycleContext,
    id: input.id,
    changes: input.changes,
    ...(input.requiredCapabilities !== undefined ? { requiredCapabilities: input.requiredCapabilities } : {}),
  });
  const opts = toProposeOptions(lifecycle, context, input.description, input.rationale, input.writeSet);
  return context.workflow.propose(opts);
}

export function invokeDeleteTool(input: DeleteToolInput, context: ToolContext): ModificationProposal {
  assertToolId(input.toolId);
  const existing = context.manifest.get(input.id);
  if (existing === undefined) {
    throw new InputError(`Extension '${input.id}' is not registered`, "self_modification_not_found");
  }
  assertToolTypeMatch(input.toolId, existing.type);
  const lifecycleContext: LifecycleContext = buildLifecycleContext(context);
  const lifecycle = proposeDelete({
    context: lifecycleContext,
    id: input.id,
    updatedAt: input.updatedAt,
  });
  const opts = toProposeOptions(lifecycle, context, input.description, input.rationale, input.writeSet);
  return context.workflow.propose(opts);
}

export function invokeEnableDisableTool(input: EnableDisableToolInput, context: ToolContext): ModificationProposal {
  assertToolId(input.toolId);
  const existing = context.manifest.get(input.id);
  if (existing === undefined) {
    throw new InputError(`Extension '${input.id}' is not registered`, "self_modification_not_found");
  }
  const lifecycleContext: LifecycleContext = buildLifecycleContext(context);
  const lifecycle = proposeStatusChange({
    context: lifecycleContext,
    id: input.id,
    operation: input.operation,
    targetStatus: input.targetStatus,
    updatedAt: input.updatedAt,
  });
  const opts = toProposeOptions(lifecycle, context, input.description, input.rationale, input.writeSet);
  return context.workflow.propose(opts);
}

export function invokeUpgradeDowngradeTool(input: UpgradeDowngradeToolInput, context: ToolContext): ModificationProposal {
  assertToolId(input.toolId);
  const existing = context.manifest.get(input.id);
  if (existing === undefined) {
    throw new InputError(`Extension '${input.id}' is not registered`, "self_modification_not_found");
  }
  const lifecycleContext: LifecycleContext = buildLifecycleContext(context);
  const lifecycle = proposeVersionChange({
    context: lifecycleContext,
    id: input.id,
    operation: input.operation,
    newVersion: input.newVersion,
    updatedAt: input.updatedAt,
    ...(input.newCompatibilityRange !== undefined ? { newCompatibilityRange: input.newCompatibilityRange } : {}),
    ...(input.newEntryPoint !== undefined ? { newEntryPoint: input.newEntryPoint } : {}),
    ...(input.newCapabilities !== undefined ? { newCapabilities: input.newCapabilities } : {}),
    ...(input.newDependencies !== undefined ? { newDependencies: input.newDependencies } : {}),
    ...(input.newProvenance !== undefined ? { newProvenance: input.newProvenance } : {}),
  });
  const opts = toProposeOptions(lifecycle, context, input.description, input.rationale, input.writeSet);
  return context.workflow.propose(opts);
}

export function invokeRollbackTool(input: RollbackToolInput, context: ToolContext): ModificationProposal {
  assertToolId(input.toolId);
  const existing = context.manifest.get(input.id);
  if (existing === undefined) {
    throw new InputError(`Extension '${input.id}' is not registered`, "self_modification_not_found");
  }
  const lifecycleContext: LifecycleContext = buildLifecycleContext(context);
  const lifecycle = proposeRollback({
    context: lifecycleContext,
    id: input.id,
    updatedAt: input.updatedAt,
  });
  const opts = toProposeOptions(lifecycle, context, input.description, input.rationale, input.writeSet);
  return context.workflow.propose(opts);
}

export type DispatchResult = ModificationProposal;

export function dispatchAdd(
  toolId: AddToolInput["toolId"],
  input: Omit<AddToolInput, "toolId">,
  context: ToolContext,
): DispatchResult {
  return invokeAddTool({ ...input, toolId }, context);
}

export function dispatchEdit(
  toolId: EditToolInput["toolId"],
  input: Omit<EditToolInput, "toolId">,
  context: ToolContext,
): DispatchResult {
  return invokeEditTool({ ...input, toolId }, context);
}

export function dispatchDelete(
  toolId: DeleteToolInput["toolId"],
  input: Omit<DeleteToolInput, "toolId">,
  context: ToolContext,
): DispatchResult {
  return invokeDeleteTool({ ...input, toolId }, context);
}

export type ToolManifestEntry = Readonly<{
  toolId: SelfModificationToolId;
  extensionType: ExtensionType;
  operation: ExtensionOperation;
  description: string;
}>;

export const SELF_MODIFICATION_TOOL_MANIFEST: readonly ToolManifestEntry[] = deepFreeze(
  SELF_MODIFICATION_TOOL_IDS.map((toolId) => deepFreeze({
    toolId,
    extensionType: TOOL_TO_TYPE[toolId],
    operation: TOOL_TO_OPERATION[toolId],
    description: describeTool(toolId),
  })),
);

function describeTool(toolId: SelfModificationToolId): string {
  const type = TOOL_TO_TYPE[toolId];
  const op = TOOL_TO_OPERATION[toolId];
  return `${op} a ${type} extension through the governed approval workflow`;
}

export function validateWriteSetForTool(
  toolId: SelfModificationToolId,
  writeSet: readonly string[],
): readonly string[] {
  const violations: string[] = [];
  if (!Array.isArray(writeSet) || writeSet.length === 0) {
    violations.push("writeSet must be a non-empty array of authorized paths");
    return violations;
  }
  const seen = new Set<string>();
  for (const path of writeSet) {
    if (typeof path !== "string" || path.length === 0) {
      violations.push(`writeSet path '${String(path)}' must be a non-empty string`);
      continue;
    }
    if (path.includes("..")) {
      violations.push(`writeSet path '${path}' must not contain parent traversal`);
    }
    if (path.startsWith("/")) {
      violations.push(`writeSet path '${path}' must be relative, not absolute`);
    }
    if (seen.has(path)) {
      violations.push(`duplicate writeSet path '${path}'`);
    }
    seen.add(path);
  }
  void toolId;
  return violations;
}

export function writeSetIdentity(writeSet: readonly string[]): string {
  return canonicalHash([...writeSet].sort());
}

export { sha256 };
export type { ExtensionManifest, ExtensionManifestEntry, ExtensionType, ExtensionOperation, CompatibilityReport, HarnessApiContract, CapabilityOwnership };

void checkCompatibility;
