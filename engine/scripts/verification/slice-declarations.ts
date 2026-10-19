import { z } from "zod";

import { deepFreeze } from "../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { SLICE_PROJECTION_PATHS } from "./slice-projection-paths.ts";

const SHA1 = z.string().regex(/^[0-9a-f]{40}$/u);
const REFERENCE = z.string().regex(/^(?:REQ|DER)-[0-9]{3}$/u);
const COMMON = {
  outputSchemaVersion: z.literal(1),
  name: z.string().min(1),
  supersedes: z.strictObject({ commit: SHA1, reason: z.string().min(1) }),
  testSourceId: z.string().regex(/^test\/[A-Za-z0-9./-]+\.test\.ts$/u),
  applicability: z.array(REFERENCE).min(1),
} as const;
const S2_BEHAVIOR = z.strictObject({
  id: z.string().regex(/^S2-B0[1-7]$/u),
  name: z.string().min(1),
  testName: z.string().min(1),
  fixtureNamespace: z.string().regex(/^b0[1-7]-[a-z0-9-]+$/u),
});
const PLANNED_BEHAVIOR_FIELDS = {
  name: z.string().min(1),
  testName: z.string().min(1),
  scenarioSuffixes: z.array(z.string().regex(/^[A-Z0-9-]+$/u)).min(3),
} as const;

export const SLICE_DECLARATIONS_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-slice-declarations/v1"),
  slices: z.tuple([
    z.strictObject({
      slice: z.literal("S2.3"),
      outputPath: z.literal(SLICE_PROJECTION_PATHS.s2Trace),
      ...COMMON,
      behaviors: z.array(S2_BEHAVIOR).length(7),
      acceptance: z.strictObject({
        minimumDistinctFixturesPerBehavior: z.literal(3),
        serializedFixtureFormat: z.literal("json-containing-real-wire-shapes"),
        unknownRawMetadataForwarding: z.literal("forbidden"),
        responsesSequencePolicy: z.literal("strictly-increasing-unique-gaps-allowed"),
        responsesIndexPolicy: z.literal("nonnegative-identity-bound-unique-per-scope-gaps-allowed"),
        gapPolicyEvidence: z.literal(
          "official event fields define sequence and index identity but do not require contiguity",
        ),
        modelMayNotScoreItself: z.literal(true),
        candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
      }),
    }),
    z.strictObject({
      slice: z.literal("S2.4"),
      outputPath: z.literal(SLICE_PROJECTION_PATHS.s24Trace),
      ...COMMON,
      behaviors: z.array(z.strictObject({
        id: z.string().regex(/^S2\.4-B0[1-5]$/u),
        ...PLANNED_BEHAVIOR_FIELDS,
      })).length(5),
      acceptance: z.strictObject({
        minimumDistinctScenariosPerBehavior: z.literal(3),
        futureRequirementPolicy: z.literal("explicitly-unassessed-may-remain-unlinked-to-implementation"),
        satisfiedClaimPolicy: z.literal(
          "implemented-requirements-require-authority-implementation-test-and-evidence-links",
        ),
        secretPolicy: z.literal("literal-secret-like-values-forbidden"),
        modelMayNotScoreItself: z.literal(true),
        candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
      }),
    }),
    z.strictObject({
      slice: z.literal("S3.1"),
      outputPath: z.literal(SLICE_PROJECTION_PATHS.s31Trace),
      ...COMMON,
      behaviors: z.array(z.strictObject({
        id: z.string().regex(/^S3\.1-B0[1-7]$/u),
        ...PLANNED_BEHAVIOR_FIELDS,
      })).length(7),
      acceptance: z.strictObject({
        minimumIndependentCausalScenariosPerBehavior: z.literal(3),
        syntheticCanariesOnly: z.literal(true),
        constantTimeMacAndDigestComparison: z.literal(true),
        rawKeysInSchemasProjectionsReceipts: z.literal("forbidden"),
        hostileBoundaryPolicy: z.literal("proxy-accessor-subclass-rejected-before-observation"),
        proxyTrapInvocationCount: z.literal(0),
        runtimeFaultMatrixDisposition: z.literal(
          "deferred-until-storage-anchor-and-dispatch-authority-exist",
        ),
        modelMayNotScoreItself: z.literal(true),
        candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
      }),
    }),
  ]),
}).superRefine((catalog, context) => {
  for (const slice of catalog.slices) {
    if (new Set(slice.applicability).size !== slice.applicability.length) {
      context.addIssue({ code: "custom", message: `${slice.slice} applicability contains duplicates` });
    }
    const behaviorIds = slice.behaviors.map((behavior) => behavior.id);
    const testNames = slice.behaviors.map((behavior) => behavior.testName);
    if (new Set(behaviorIds).size !== behaviorIds.length || new Set(testNames).size !== testNames.length) {
      context.addIssue({ code: "custom", message: `${slice.slice} behavior bindings are not unique` });
    }
    for (const behavior of slice.behaviors) {
      if ("scenarioSuffixes" in behavior &&
        new Set(behavior.scenarioSuffixes).size !== behavior.scenarioSuffixes.length) {
        context.addIssue({ code: "custom", message: `${behavior.id} scenario suffixes are not unique` });
      }
    }
  }
});

export type SliceDeclarations = z.infer<typeof SLICE_DECLARATIONS_SCHEMA>;

export function parseSliceDeclarationsText(text: string): SliceDeclarations {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Slice declarations contain a duplicate key",
    "slice_declarations_key_duplicate",
  );
  return deepFreeze(SLICE_DECLARATIONS_SCHEMA.parse(JSON.parse(text) as unknown));
}
