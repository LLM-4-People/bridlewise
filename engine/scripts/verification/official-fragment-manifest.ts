import { z } from "zod";

import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";

// The schema id derives from the product-identity owner (the single source of
// the namespace prefix), so a product rename rotates this literal at the owner
// rather than leaving a stale spelling here that desynchronises the authority
// manifest from the candidate-format exemption gate.
export const S2_OFFICIAL_FRAGMENT_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal(schemaId("official-fragments", 1)),
  accessedOn: z.literal("2026-07-11"),
  sources: z.array(z.strictObject({
    id: z.enum(["openai-openapi-2.3.0", "mcp-schema-2025-11-25"]),
    url: z.string().url(),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    fullSourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    license: z.strictObject({
      spdx: z.literal("MIT"),
      url: z.string().url(),
      path: z.string().regex(/^traceability\/sources\/s2\/[A-Za-z0-9.-]+$/u),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
    fragments: z.array(z.strictObject({
      path: z.string().regex(/^traceability\/sources\/s2\/[A-Za-z0-9.-]+$/u),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      purpose: z.string().min(1),
    })).min(2).max(8),
  })).length(2),
});

export type S2OfficialFragmentManifest = Readonly<z.infer<typeof S2_OFFICIAL_FRAGMENT_MANIFEST_SCHEMA>>;

export function parseS2OfficialFragmentManifestText(text: string): S2OfficialFragmentManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Official fragment manifest contains a duplicate key",
    "official_fragment_manifest_key_duplicate",
  );
  return S2_OFFICIAL_FRAGMENT_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown);
}
