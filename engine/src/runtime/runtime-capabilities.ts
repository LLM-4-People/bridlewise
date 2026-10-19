import { deepFreeze } from "../kernel/integrity.ts";

export type NodeRuntimeCapabilities = Readonly<{
  unicodeVersion: string | undefined;
  icuVersion: string | undefined;
}>;

export type AdmittedNodeRuntime = Readonly<{
  admissionRecord: Readonly<{
    schemaVersion: string;
    path: string;
    sha256: string;
  }>;
  executable: Readonly<{
    byteLength: number;
    sha256: string;
  }>;
  modeledPrincipalWriteIsolationEvidenceSha256: string;
}>;

/** The sole production owner of direct Node Unicode capability reads. */
export function readNodeRuntimeCapabilities(): NodeRuntimeCapabilities {
  return deepFreeze({
    unicodeVersion: process.versions.unicode,
    icuVersion: process.versions.icu,
  });
}
