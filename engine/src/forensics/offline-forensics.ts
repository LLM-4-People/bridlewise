import {
  FORENSIC_CONTRACTS_REVISION,
  FORENSIC_SCHEMA_BUNDLE_HASH,
} from "./forensic-contracts.ts";
import { FORENSIC_CRYPTO_REVISION } from "./forensic-crypto.ts";
import { FORENSIC_NORMALIZATION_REVISION } from "./forensic-normalization.ts";
import { FORENSIC_PROJECTION_REVISION } from "./forensic-projection.ts";
import { FORENSIC_STATE_REVISION } from "./forensic-state.ts";
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { LEDGER_CANONICAL_REVISION } from "../kernel/ledger-canonical.ts";
import { REQUIREMENTS_REGISTRY_IDENTITY_HASH } from "../kernel/requirements.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { SAFE_STRUCTURAL_REVISION } from "../kernel/safe-structural.ts";

export type S3OfflineForensicIdentityInput = Readonly<{
  implementation: string;
  policyHash: string;
  schemaBundleHash: string;
  requirementsRegistryIdentityHash: string;
  modules: Readonly<{
    canonicalization: string;
    contracts: string;
    crypto: string;
    normalization: string;
    projection: string;
    safeStructural: string;
    state: string;
  }>;
}>;

export function createS3OfflineForensicIdentity(input: S3OfflineForensicIdentityInput) {
  return deepFreeze({
    implementation: input.implementation,
    policyHash: input.policyHash,
    schemaBundleHash: input.schemaBundleHash,
    requirementsRegistryIdentityHash: input.requirementsRegistryIdentityHash,
    modules: input.modules,
    effectsAuthorized: false as const,
    durableAuditAvailable: false as const,
    storageAvailable: false as const,
    transportAvailable: false as const,
    modelInvocationAvailable: false as const,
    toolExecutionAvailable: false as const,
  });
}

export const S3_OFFLINE_FORENSIC_IDENTITY = createS3OfflineForensicIdentity({
  implementation: ROOT_POLICY.forensics.implementation,
  policyHash: canonicalHash(ROOT_POLICY.forensics),
  schemaBundleHash: FORENSIC_SCHEMA_BUNDLE_HASH,
  requirementsRegistryIdentityHash: REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  modules: {
    canonicalization: LEDGER_CANONICAL_REVISION,
    contracts: FORENSIC_CONTRACTS_REVISION,
    crypto: FORENSIC_CRYPTO_REVISION,
    normalization: FORENSIC_NORMALIZATION_REVISION,
    projection: FORENSIC_PROJECTION_REVISION,
    safeStructural: SAFE_STRUCTURAL_REVISION,
    state: FORENSIC_STATE_REVISION,
  },
});

export const S3_OFFLINE_FORENSIC_HASH = canonicalHash(S3_OFFLINE_FORENSIC_IDENTITY);
