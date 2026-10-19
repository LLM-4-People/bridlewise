/**
 * Regenerate the canonical handoff protocol manifest from its authority.
 *
 * The committed `traceability/canonical/handoff-protocol-manifest.json` is a
 * conformance projection of `HANDOFF_PROTOCOL_AUTHORITY`. The semantic-owner
 * byte-pins, the current lineage fingerprint and the integrity hash are all
 * fold-sensitive: a move or re-touch of a semantic-owner source changes them,
 * and a manifest that is not re-derived then mismatches the authority and the
 * four handoff suites fail at module load. This script is the owner-side
 * regeneration path — re-deriving is one command, never a hand-edit of a pin.
 *
 * Every derived field is recomputed through the authority's own functions, not
 * restated here: the semantic-owner set comes from the authority (which holds
 * the truthful pins), the current fingerprint from
 * `deriveCurrentHandoffExecutableSchemaFingerprint`, and each ordered identity
 * and the integrity hash from the shared `canonicalHash`.
 *
 * Usage: node --experimental-strip-types scripts/regenerate-handoff-manifest.ts
 * Writes the manifest in place. Run from the engine root.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash } from "../src/kernel/integrity.ts";
import { atomicWriteFile } from "../src/filesystem/atomic-write.ts";
import { InputError } from "../src/kernel/errors.ts";
import {
  recomputeSemanticOwnerPins,
} from "../src/modules/tasks-agents/domain/handoff-protocol-authority.ts";
import { deriveCurrentHandoffExecutableSchemaFingerprint } from "../src/modules/tasks-agents/domain/handoff-contracts.ts";
import { bootstrapProcess, isEntryPoint } from "../src/runtime/cli-debug.ts";

const MANIFEST_PATH = "traceability/canonical/handoff-protocol-manifest.json";

interface OrderedIdentity {
  count: number;
  sha256: string;
}

function orderIdentity(values: readonly unknown[]): OrderedIdentity {
  return { count: values.length, sha256: canonicalHash(values) };
}

/**
 * Compute the manifest text the authority currently implies — the PURE half of
 * the regeneration, separated from the write so a check can compare without
 * touching the file. The committed
 * `traceability/canonical/handoff-protocol-manifest.json` is a conformance
 * projection of `HANDOFF_PROTOCOL_AUTHORITY`: the semantic-owner set, the
 * current lineage fingerprint and the integrity hash are all fold-sensitive.
 */
export function computeHandoffManifestText(manifestPath: string = MANIFEST_PATH): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & {
    semanticOwners: { values: readonly unknown[]; identity: OrderedIdentity };
    lineage: Array<Record<string, unknown> & {
      semanticOwnerSetIdentity: OrderedIdentity;
      executableSchemaFingerprint: string;
    }>;
  };

  // Mirror the authority's semantic-owner set exactly — recomputed from the
  // CURRENT tree bytes (never the process-start static import), so a manifest
  // regenerated in the same run that re-pinned the authority reads the FRESH
  // pins, not the stale module-load snapshot. The authority owns the paths and
  // roles; only the byte measurements are recomputed.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const semanticOwnerValues = recomputeSemanticOwnerPins(root).map((owner) => ({
    role: owner.role,
    path: owner.path,
    byteLength: owner.byteLength,
    sha256: owner.sha256,
  }));
  const semanticOwnerSetIdentity = orderIdentity(semanticOwnerValues);

  const lineage = manifest.lineage.map((entry, index, all) =>
    index === all.length - 1
      ? {
          ...entry,
          semanticOwnerSetIdentity,
          executableSchemaFingerprint: deriveCurrentHandoffExecutableSchemaFingerprint(),
        }
      : entry,
  );

  const unsigned = {
    ...manifest,
    semanticOwners: { values: semanticOwnerValues, identity: semanticOwnerSetIdentity },
    lineage,
  };
  delete (unsigned as { integrityHash?: unknown }).integrityHash;
  const integrityHash = canonicalHash(unsigned);
  return `${JSON.stringify({ ...unsigned, integrityHash }, null, 2)}\n`;
}

export function regenerateHandoffManifest(manifestPath: string = MANIFEST_PATH): void {
  // Through the shared write primitive (and so the checkout write door).
  const result = atomicWriteFile(manifestPath, computeHandoffManifestText(manifestPath));
  if (!result.success) {
    throw new InputError(`could not write the handoff manifest ${manifestPath}: ${result.reason ?? "unknown"}`, "handoff_manifest_write_failed");
  }
}

/**
 * Whether the committed manifest already matches the authority's projection —
 * the read-only half of the regeneration. Used by the pin-authority choke
 * point's `--check` mode so a stale manifest is reported, not silently left.
 */
export function handoffManifestIsCurrent(manifestPath: string = MANIFEST_PATH): boolean {
  return readFileSync(manifestPath, "utf8") === computeHandoffManifestText(manifestPath);
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  regenerateHandoffManifest();
  console.log(`regenerated ${MANIFEST_PATH}`);
}
