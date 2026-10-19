import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadPinnedConfigSnapshot, type ConfigSnapshot } from "./config.ts";
import { getConfigContractArtifact } from "./config-contracts.ts";
import {
  classifyData,
  decideEgress,
  mostRestrictiveClassification,
  type ClassificationDecision,
  type DataClassification,
  type EgressDecision,
} from "../privacy/data-policy.ts";
import { SecurityError } from "./errors.ts";
import { hasSecondName } from "../filesystem/link-containment.ts";
import { canonicalHash, deepFreeze } from "./integrity.ts";
import { hasTraversalSegment, readLinuxMountPoints } from "../filesystem/linux-path.ts";
import { S2_OFFLINE_CONTRACT_HASH } from "../forensics/offline-contracts.ts";
import { S3_OFFLINE_FORENSIC_HASH } from "../forensics/offline-forensics.ts";
import { decideFilesystemBoundary } from "../filesystem/path-boundary.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "./root-policy.ts";
import { sameIdentity } from "../shared/identity.ts";

const INSPECTION_GRANT_BRAND: unique symbol = Symbol("s1-provisional-path-inspection");
const ISSUED_CONTEXTS = new WeakSet<object>();

export type PrincipalBinding = Readonly<{
  id: string;
  authentication: "local-os-effective-user";
  uid: number;
  gid: number;
}>;

export type ProjectReceiptBinding = Readonly<{
  id: string;
  rootIdentityHash: string;
  ownerUid: number;
  ownerGid: number;
  mode: string;
}>;

export type PathDecision = Readonly<{
  decision: "allow" | "deny";
  code: string;
  operation: "inspect";
  requestedPath: string;
  provisional: true;
  effectAuthorized: false;
  canonicalPath?: string;
}>;

export type CapabilityDecision = Readonly<{
  capability: keyof typeof ROOT_POLICY.capabilities;
  decision: "allow" | "deny";
  effectAuthorized: false;
  code: string;
}>;

export type PreflightIntegrityReceipt = Readonly<{
  schemaVersion: typeof ROOT_POLICY.receipts.preflightSchemaVersion;
  stage: "s1-preflight-only";
  harnessReady: false;
  trust: Readonly<{
    claim: "integrity-only-not-authenticity";
    authenticityEstablished: false;
    trustedBootstrapVerifier: Readonly<{
      required: true;
      available: false;
      status: "trusted_bootstrap_verifier_unavailable";
    }>;
  }>;
  rootPolicyHash: string;
  requirementsRegistry: Readonly<{
    schemaVersion: typeof ROOT_POLICY.requirements.registrySchemaVersion;
    expectedFileSha256: string;
    schemaHash: string;
    identityHash: string;
    directRuntimeRead: false;
    repositoryManifestBound: true;
  }>;
  offlineContracts: Readonly<{
    stage: "s2.3-offline-contracts-only";
    contractHash: string;
    transportAvailable: false;
    modelInvocationAvailable: false;
    toolExecutionAvailable: false;
  }>;
  offlineForensics: Readonly<{
    stage: "s3.1-offline-forensic-primitives-only";
    bundleHash: string;
    durableAuditAvailable: false;
    storageAvailable: false;
    forwardingAvailable: false;
  }>;
  config: Readonly<{
    contractIdentityHash: string;
    contractSchemaHash: string;
    contractSourceSha256: string;
    canonicalHash: string;
    sourceHash: string;
    sourceIdentityHash: string;
    repositoryManifestHash: string;
  }>;
  principal: PrincipalBinding;
  project: ProjectReceiptBinding;
  pathInspection: Readonly<{ rootDecision: PathDecision }>;
  data: Readonly<{
    defaultClassification: DataClassification;
    configDecision: ClassificationDecision;
    egressDecision: EgressDecision;
  }>;
  capabilities: readonly CapabilityDecision[];
  integrityPurpose: "corruption-detection-and-correlation-only";
  integrityHash: string;
}>;

export type PreflightContext = Readonly<{
  receipt: PreflightIntegrityReceipt;
  inspectPath: (path: string) => PathDecision;
  classify: (payload: unknown, declared?: Exclude<DataClassification, "credential-secret">) => ClassificationDecision;
  decideEgress: (destination: string, classification: ClassificationDecision) => EgressDecision;
}>;

type RootBinding = Readonly<{
  projectId: string;
  canonicalRoot: string;
  principal: PrincipalBinding;
  device: bigint;
  inode: bigint;
  mode: bigint;
  ownerUid: bigint;
  ownerGid: bigint;
  links: bigint;
  modifiedNanoseconds: bigint;
  changedNanoseconds: bigint;
}>;

type InspectionGrant = Readonly<{
  [INSPECTION_GRANT_BRAND]: true;
  binding: RootBinding;
}>;

export function createPreflightContext(): PreflightContext {
  const config = loadPinnedConfigSnapshot();
  const principal = authenticatePrincipal(config);
  const binding = bindProject(config, principal);
  const inspectPath = createProvisionalInspector(binding);
  const rootDecision = inspectPath(".");
  if (rootDecision.decision !== "allow") {
    throw new SecurityError("Project root descriptor verification failed", "path_preflight_failed");
  }
  const defaultClassification = config.document.data.defaultClassification;
  const configDecision = classifyData({
    schemaVersion: config.document.schemaVersion,
    projectId: config.document.project.id,
    projectRoot: config.document.project.root,
  }, defaultClassification);
  const egressDecision = decideEgress("external-destination", configDecision);
  const unsigned = {
    schemaVersion: ROOT_POLICY.receipts.preflightSchemaVersion,
    stage: "s1-preflight-only",
    harnessReady: false,
    trust: {
      claim: "integrity-only-not-authenticity",
      authenticityEstablished: false,
      trustedBootstrapVerifier: {
        required: true,
        available: false,
        status: "trusted_bootstrap_verifier_unavailable",
      },
    },
    rootPolicyHash: ROOT_POLICY_HASH,
    requirementsRegistry: {
      schemaVersion: ROOT_POLICY.requirements.registrySchemaVersion,
      expectedFileSha256: ROOT_POLICY.requirements.registryFileSha256,
      schemaHash: ROOT_POLICY.requirements.registrySchemaHash,
      identityHash: ROOT_POLICY.requirements.registryIdentityHash,
      directRuntimeRead: false,
      repositoryManifestBound: true,
    },
    offlineContracts: {
      stage: "s2.3-offline-contracts-only",
      contractHash: S2_OFFLINE_CONTRACT_HASH,
      transportAvailable: false,
      modelInvocationAvailable: false,
      toolExecutionAvailable: false,
    },
    offlineForensics: {
      stage: "s3.1-offline-forensic-primitives-only",
      bundleHash: S3_OFFLINE_FORENSIC_HASH,
      durableAuditAvailable: false,
      storageAvailable: false,
      forwardingAvailable: false,
    },
    config: {
      contractIdentityHash: getConfigContractArtifact().identityHash,
      contractSchemaHash: getConfigContractArtifact().schemaHash,
      contractSourceSha256: ROOT_POLICY.configuration.contract.sourceSha256,
      canonicalHash: config.canonicalHash,
      sourceHash: config.sourceHash,
      sourceIdentityHash: canonicalHash(config.source),
      repositoryManifestHash: config.repositoryManifestHash,
    },
    principal,
    project: projectReceipt(binding),
    pathInspection: { rootDecision },
    data: { defaultClassification, configDecision, egressDecision },
    capabilities: capabilityDecisions(),
    integrityPurpose: "corruption-detection-and-correlation-only",
  } as const;
  const receipt = deepFreeze({ ...unsigned, integrityHash: canonicalHash(unsigned) });
  const context = Object.freeze({
    receipt,
    inspectPath,
    classify: (
      payload: unknown,
      declared: Exclude<DataClassification, "credential-secret"> = defaultClassification,
    ) => classifyData(payload, mostRestrictiveClassification(defaultClassification, declared)),
    decideEgress,
  });
  ISSUED_CONTEXTS.add(context);
  return context;
}

export function isIssuedPreflightContext(value: unknown): value is PreflightContext {
  return typeof value === "object" && value !== null && ISSUED_CONTEXTS.has(value);
}

function authenticatePrincipal(config: ConfigSnapshot): PrincipalBinding {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || config.source.ownerUid !== uid ||
    config.source.ownerGid !== gid) {
    throw new SecurityError("A matching local OS principal is required", "principal_authentication_failed");
  }
  return deepFreeze({
    id: `local-uid:${uid}:gid:${gid}`,
    authentication: "local-os-effective-user",
    uid,
    gid,
  });
}

function bindProject(config: ConfigSnapshot, principal: PrincipalBinding): RootBinding {
  if (config.document.project.root !== ROOT_POLICY.configuration.projectRootLiteral) {
    throw new SecurityError("Only the pinned repository root is accepted", "project_root_invalid");
  }
  const stats = lstatSync(config.repositoryRoot, { bigint: true, throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SecurityError("Project root identity is invalid", "project_root_invalid");
  }
  if (stats.uid !== BigInt(principal.uid) || stats.gid !== BigInt(principal.gid)) {
    throw new SecurityError("Project owner does not match the authenticated principal", "project_owner_mismatch");
  }
  return Object.freeze({
    projectId: config.document.project.id,
    canonicalRoot: config.repositoryRoot,
    principal,
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    ownerUid: stats.uid,
    ownerGid: stats.gid,
    links: stats.nlink,
    modifiedNanoseconds: stats.mtimeNs,
    changedNanoseconds: stats.ctimeNs,
  });
}

function createProvisionalInspector(binding: RootBinding): (path: string) => PathDecision {
  const grant: InspectionGrant = Object.freeze({ [INSPECTION_GRANT_BRAND]: true, binding });
  return (path: string): PathDecision => inspectWithGrant(grant, path);
}

function inspectWithGrant(grant: InspectionGrant, requestedPath: string): PathDecision {
  const base = {
    operation: "inspect" as const,
    requestedPath,
    provisional: true as const,
    effectAuthorized: false as const,
  };
  if (grant[INSPECTION_GRANT_BRAND] !== true) return deepFreeze({ ...base, decision: "deny", code: "grant_invalid" });
  const binding = grant.binding;
  if (process.getuid?.() !== binding.principal.uid || process.getgid?.() !== binding.principal.gid) {
    return deepFreeze({ ...base, decision: "deny", code: "principal_mismatch" });
  }
  if (requestedPath.includes("\0") || isAbsolute(requestedPath) || requestedPath.trim() === "") {
    return deepFreeze({ ...base, decision: "deny", code: "path_invalid" });
  }
  if (hasTraversalSegment(requestedPath)) {
    return deepFreeze({ ...base, decision: "deny", code: "path_traversal_denied" });
  }
  if (!rootIdentityMatches(binding)) {
    return deepFreeze({ ...base, decision: "deny", code: "root_identity_changed" });
  }
  let mountPoints: ReadonlySet<string>;
  try {
    mountPoints = readLinuxMountPoints();
  } catch {
    return deepFreeze({ ...base, decision: "deny", code: "mount_information_unavailable" });
  }
  const components = requestedPath === "." ? [] : requestedPath.split(/[\\/]/u).filter((entry) => entry !== "" && entry !== ".");
  let target = binding.canonicalRoot;
  try {
    for (const component of components) {
      target = join(target, component);
      const stats = lstatSync(target, { bigint: true, throwIfNoEntry: false });
      if (!stats) return deepFreeze({ ...base, decision: "deny", code: "path_unavailable" });
      if (stats.isSymbolicLink()) return deepFreeze({ ...base, decision: "deny", code: "path_symlink_denied" });
      const boundaryCode = decideFilesystemBoundary(binding.device, stats.dev, mountPoints.has(target));
      if (boundaryCode) return deepFreeze({ ...base, decision: "deny", code: boundaryCode });
      if (!stats.isDirectory() && hasSecondName(stats.nlink)) {
        return deepFreeze({ ...base, decision: "deny", code: "path_hardlink_denied" });
      }
    }
    const before = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!before || before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
      return deepFreeze({ ...base, decision: "deny", code: "path_type_denied" });
    }
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0);
    let descriptor: number;
    try {
      descriptor = openSync(target, flags);
    } catch {
      return deepFreeze({ ...base, decision: "deny", code: "path_descriptor_open_denied" });
    }
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      const after = lstatSync(target, { bigint: true, throwIfNoEntry: false });
      if (!after || !sameIdentity(before, opened) || !sameIdentity(before, after)) {
        return deepFreeze({ ...base, decision: "deny", code: "path_identity_changed" });
      }
    } finally {
      closeSync(descriptor);
    }
    return deepFreeze({
      ...base,
      decision: "allow",
      code: "path_descriptor_verified_provisional",
      canonicalPath: target,
    });
  } catch {
    return deepFreeze({ ...base, decision: "deny", code: "path_inspection_failed" });
  }
}

function rootIdentityMatches(binding: RootBinding): boolean {
  try {
    const stats = lstatSync(binding.canonicalRoot, { bigint: true, throwIfNoEntry: false });
    return !!stats && stats.isDirectory() && !stats.isSymbolicLink() &&
      stats.dev === binding.device && stats.ino === binding.inode && stats.mode === binding.mode &&
      stats.uid === binding.ownerUid && stats.gid === binding.ownerGid && stats.nlink === binding.links &&
      stats.mtimeNs === binding.modifiedNanoseconds && stats.ctimeNs === binding.changedNanoseconds;
  } catch {
    return false;
  }
}

function projectReceipt(binding: RootBinding): ProjectReceiptBinding {
  return deepFreeze({
    id: binding.projectId,
    rootIdentityHash: canonicalHash({
      device: binding.device.toString(10),
      inode: binding.inode.toString(10),
      mode: binding.mode.toString(8),
      ownerUid: binding.ownerUid.toString(10),
      ownerGid: binding.ownerGid.toString(10),
      links: binding.links.toString(10),
      modifiedNanoseconds: binding.modifiedNanoseconds.toString(10),
      changedNanoseconds: binding.changedNanoseconds.toString(10),
    }),
    ownerUid: Number(binding.ownerUid),
    ownerGid: Number(binding.ownerGid),
    mode: (binding.mode & 0o7777n).toString(8),
  });
}

function capabilityDecisions(): readonly CapabilityDecision[] {
  return (Object.entries(ROOT_POLICY.capabilities) as Array<
    [keyof typeof ROOT_POLICY.capabilities, boolean]
  >).map(([capability, enabled]) => deepFreeze({
    capability,
    decision: enabled ? "allow" : "deny",
    effectAuthorized: false,
    code: enabled ? "integrity_preflight_only" : "s1_effects_disabled",
  }));
}
