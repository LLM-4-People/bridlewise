import { z } from "zod";

import { InputError } from "../../src/kernel/errors.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { compareUtf8Bytes } from "../../src/kernel/ordered.ts";
import { relativePathViolationKinds } from "../../src/filesystem/path-boundary.ts";
import { snapshotJsonValue } from "../../src/kernel/safe-structural.ts";
import { SLICE_PROJECTION_ARTIFACT_PATHS, SLICE_PROJECTION_PATHS } from "./slice-projection-paths.ts";

export const SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION =
  "bridlewise-slice-projection-captured-values/v1" as const;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const STRUCTURAL_LIMITS = { maximumDepth: 8, maximumNodes: 20_000 } as const;
const DOWNSTREAM_ONLY_PATHS: ReadonlySet<string> = new Set([
  SLICE_PROJECTION_PATHS.downstreamArtifactManifest,
  SLICE_PROJECTION_PATHS.downstreamCandidateReceipt,
]);
const GENERATED_SLICE_PATHS: ReadonlySet<string> = new Set(SLICE_PROJECTION_ARTIFACT_PATHS);

const CAPTURED_FILE_SCHEMA = z.strictObject({
  path: z.string().min(1),
  contentBase64: z.string(),
});
const CAPTURED_VALUES_SCHEMA = z.strictObject({
  schemaVersion: z.literal(SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION),
  files: z.array(CAPTURED_FILE_SCHEMA).min(1),
});
const PROJECTION_INPUT_SCHEMA = z.strictObject({ captured: CAPTURED_VALUES_SCHEMA });

export type SliceProjectionCapturedFile = Readonly<{
  path: string;
  contentBase64: string;
}>;

export type SliceProjectionCapturedValues = Readonly<{
  schemaVersion: typeof SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION;
  files: readonly SliceProjectionCapturedFile[];
}>;

export type SliceProjectionInput = Readonly<{
  captured: SliceProjectionCapturedValues;
}>;

export function createSliceProjectionCapturedValues(input: unknown): SliceProjectionCapturedValues {
  const snapshot = snapshotJsonValue(input, STRUCTURAL_LIMITS, "slice_captured_values_unsafe");
  const parsed = CAPTURED_VALUES_SCHEMA.safeParse(snapshot);
  if (!parsed.success) {
    throw new InputError("Captured values shape is invalid", "slice_captured_values_invalid");
  }
  return validateCapturedValues(parsed.data);
}

export function normalizeSliceProjectionInput(input: unknown): SliceProjectionInput {
  const snapshot = snapshotJsonValue(input, STRUCTURAL_LIMITS, "slice_projection_input_unsafe");
  const parsed = PROJECTION_INPUT_SCHEMA.safeParse(snapshot);
  if (!parsed.success) {
    throw new InputError("Slice projection input shape is invalid", "slice_projection_input_invalid");
  }
  return deepFreeze({ captured: validateCapturedValues(parsed.data.captured) });
}

export const compareSliceProjectionPaths = compareUtf8Bytes;

function validateCapturedValues(input: SliceProjectionCapturedValues): SliceProjectionCapturedValues {
  const files = input.files.map((file) => {
    if (relativePathViolationKinds(file.path).length > 0) {
      throw new InputError("Captured path is not canonical", `slice_captured_path_invalid:${file.path}`);
    }
    if (DOWNSTREAM_ONLY_PATHS.has(file.path) || GENERATED_SLICE_PATHS.has(file.path)) {
      throw new InputError("Generated destination is an input", `slice_projection_self_input:${file.path}`);
    }
    if (!BASE64.test(file.contentBase64)) {
      throw new InputError("Captured bytes are not canonical base64", `slice_captured_base64_invalid:${file.path}`);
    }
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== file.contentBase64) {
      throw new InputError("Captured bytes are not canonical base64", `slice_captured_base64_invalid:${file.path}`);
    }
    return { path: file.path, contentBase64: file.contentBase64 };
  }).toSorted((left, right) => compareSliceProjectionPaths(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new InputError("Values must be unique", "slice_captured_path_duplicate");
  }
  return deepFreeze({ schemaVersion: SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION, files });
}
