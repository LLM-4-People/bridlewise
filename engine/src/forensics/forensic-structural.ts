import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import type { StructuralSnapshotLimits } from "../kernel/safe-structural.ts";

export const FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS: StructuralSnapshotLimits = deepFreeze({
  maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth,
  maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes,
});
