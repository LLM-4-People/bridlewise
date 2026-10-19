import { closeSync, constants, lstatSync, openSync } from "node:fs";

import { HarnessError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import {
  repositoryRootCapabilityAdapterAvailabilityForObservedState,
  type RepositoryRootCapabilityAdapterAvailability,
} from "./repository-root-capability-contracts.ts";

const POLICY = ROOT_POLICY.verification.testFixtures.repositoryRootCapability;

/** Probes only the centrally configured Linux adapter path. */
export function inspectRepositoryRootCapabilityAdapterAvailability():
  RepositoryRootCapabilityAdapterAvailability {
  if (arguments.length !== 0) throw adapterError("safe_path_root_capability_adapter_probe_invalid");
  if (process.platform !== POLICY.platform) {
    return repositoryRootCapabilityAdapterAvailabilityForObservedState("platform-unsupported");
  }
  const procFileDescriptorRoot = ROOT_POLICY.verification.safeRepositoryRead.procFileDescriptorRoot;
  let root;
  try {
    root = lstatSync(procFileDescriptorRoot, { bigint: true, throwIfNoEntry: false });
  } catch {
    return repositoryRootCapabilityAdapterAvailabilityForObservedState("procfs-unavailable");
  }
  if (!root) return repositoryRootCapabilityAdapterAvailabilityForObservedState("procfs-unavailable");
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return repositoryRootCapabilityAdapterAvailabilityForObservedState("procfs-invalid");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      procFileDescriptorRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorPath = `${procFileDescriptorRoot}/${descriptor}`;
    const descriptorStats = lstatSync(descriptorPath, { bigint: true, throwIfNoEntry: false });
    return repositoryRootCapabilityAdapterAvailabilityForObservedState(
      descriptorStats?.isSymbolicLink() === true ? "available" : "procfs-invalid",
    );
  } catch {
    return repositoryRootCapabilityAdapterAvailabilityForObservedState("procfs-unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function adapterError(code: string): HarnessError {
  return new HarnessError("Repository root capability denied", code, false);
}
