import { CAPABILITY_NEGOTIATION_REVISION } from "../runtime/capability-negotiation.ts";
import { CONTRACT_BUNDLE_HASH } from "../kernel/contracts.ts";
import { EVENT_STATE_REVISION } from "../runtime/event-state.ts";
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { PROTOCOL_PROJECTION_REVISION } from "../kernel/protocol-projections.ts";
import { REQUIREMENTS_REGISTRY_IDENTITY_HASH } from "../kernel/requirements.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { SCHEMA_SUBSET_REVISION } from "../kernel/schema-subset.ts";

export type S2OfflineContractIdentityInput = Readonly<{
  implementation: string;
  schemaBundleHash: string;
  requirementsRegistryIdentityHash: string;
  modules: Readonly<{
    capabilityNegotiation: string;
    eventState: string;
    protocolProjection: string;
    schemaSubset: string;
  }>;
}>;

export function createS2OfflineContractIdentity(input: S2OfflineContractIdentityInput) {
  return deepFreeze({
    implementation: input.implementation,
    schemaBundleHash: input.schemaBundleHash,
    requirementsRegistryIdentityHash: input.requirementsRegistryIdentityHash,
    modules: input.modules,
    effectsAuthorized: false as const,
    transportAvailable: false as const,
    modelInvocationAvailable: false as const,
    toolExecutionAvailable: false as const,
  });
}

export const S2_OFFLINE_CONTRACT_IDENTITY = createS2OfflineContractIdentity({
  implementation: ROOT_POLICY.contracts.implementation,
  schemaBundleHash: CONTRACT_BUNDLE_HASH,
  requirementsRegistryIdentityHash: REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  modules: {
    capabilityNegotiation: CAPABILITY_NEGOTIATION_REVISION,
    eventState: EVENT_STATE_REVISION,
    protocolProjection: PROTOCOL_PROJECTION_REVISION,
    schemaSubset: SCHEMA_SUBSET_REVISION,
  },
});

export const S2_OFFLINE_CONTRACT_HASH = canonicalHash(S2_OFFLINE_CONTRACT_IDENTITY);
