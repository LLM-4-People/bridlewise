import { z } from "zod";

import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { SLICE_PROJECTION_PATHS } from "./slice-projection-paths.ts";

export const S2_RESEARCH_MANIFEST_PATH = SLICE_PROJECTION_PATHS.s2ResearchManifest;

export const S2_RESEARCH_SOURCE_SCHEMA = z.strictObject({
  id: z.string().min(1),
  url: z.string().url(),
  ref: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  finding: z.string().min(1),
});

export const S2_RESEARCH_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-s2-research-sources/v1"),
  accessedOn: z.literal("2026-07-11"),
  sources: z.array(S2_RESEARCH_SOURCE_SCHEMA).length(5),
});

export const S31_STANDARD_SOURCE_SCHEMA = z.strictObject({
  id: z.enum([
    "rfc8785-jcs",
    "rfc8785-verified-erratum-7920",
    "nist-sp800-38d",
    "nist-sp800-38d-2026-revision-status",
    "nist-fips-198-1",
    "node-24.18-crypto",
    "node-24.18-util-types",
    "nist-gcm-cavp-vectors",
    "json-schema-draft-2020-12-core",
  ]),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  finding: z.string().min(1),
});

export const S31_REFERENCE_SOURCE_SCHEMA = z.strictObject({
  id: z.literal("jcs-author-reference-vectors"),
  url: z.string().url(),
  ref: z.literal("19d51d7fe467d4706a3ff08adf8a748f29fc21e0"),
  license: z.strictObject({
    spdx: z.literal("Apache-2.0"),
    fullSourceSha256: z.literal("6821faaddedf2d78c95bb6d98b127e9e616097afd2f6bcc34389f000d13ab12d"),
    localPath: z.literal("traceability/sources/s3.1/jcs-LICENSE"),
    localSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  fragments: z.array(z.strictObject({
    sourcePath: z.string().regex(/^testdata\/(?:input|output)\/(?:values|unicode)\.json$/u),
    fullSourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    localPath: z.string().regex(/^traceability\/sources\/s3\.1\/jcs-(?:values|unicode)-(?:input|output)\.json$/u),
    localSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })).length(4),
});

export const S31_SOURCE_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-s3.1-primary-sources/v1"),
  accessedOn: z.literal("2026-07-12"),
  sources: z.tuple([
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_STANDARD_SOURCE_SCHEMA,
    S31_REFERENCE_SOURCE_SCHEMA,
  ]),
});

export type S2ResearchManifest = Readonly<z.infer<typeof S2_RESEARCH_MANIFEST_SCHEMA>>;
export type S31SourceManifest = Readonly<z.infer<typeof S31_SOURCE_MANIFEST_SCHEMA>>;

export function parseS2ResearchManifestText(text: string): S2ResearchManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "S2 research manifest contains a duplicate key",
    "s2_research_manifest_key_duplicate",
  );
  return S2_RESEARCH_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown);
}

export function parseS31SourceManifestText(text: string): S31SourceManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "S3.1 source manifest contains a duplicate key",
    "s31_source_manifest_key_duplicate",
  );
  return S31_SOURCE_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown);
}
