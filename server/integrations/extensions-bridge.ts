/**
 * Extensions bridge — reads the harness config to list configured extensions
 * and their manifest metadata. Uses the canonical extension manifest module
 * to create and validate extension manifests.
 */

import { createExtensionManifest, EXTENSION_TYPES, EXTENSION_STATUSES } from "../kernel/canonical.ts";
import { getExtensions } from "../kernel/harness-config.ts";

export type ExtensionSummary = Readonly<{
  name: string;
  type: string;
  status: string;
  version: string;
  description: string | null;
}>;

export function listExtensions(): readonly ExtensionSummary[] {
  const exts = getExtensions();
  return exts.map((e) => ({
    name: e.name,
    type: e.type,
    status: e.enabled === false ? "disabled" : "active",
    version: e.version,
    description: e.description ?? null,
  }));
}

export function getExtensionTypes(): readonly string[] {
  return EXTENSION_TYPES;
}

export function getExtensionStatuses(): readonly string[] {
  return EXTENSION_STATUSES;
}

export function getExtensionManifestInfo(): Readonly<{
  schemaVersion: string;
  entryCount: number;
  types: readonly string[];
  statuses: readonly string[];
}> {
  const manifest = createExtensionManifest([]);
  const snapshot = manifest.snapshot();
  return {
    schemaVersion: snapshot.schemaVersion,
    entryCount: listExtensions().length,
    types: EXTENSION_TYPES,
    statuses: EXTENSION_STATUSES,
  };
}
