import { deepFreeze } from "../kernel/integrity.ts";
import type { SyntaxDiagnostic } from "./syntax-validator.ts";

/**
 * Structured edit feedback for model retries.
 *
 * Per delivery map item 8: "When an edit fails (preimage mismatch,
 * syntax error, write failure), generate structured feedback for the model."
 *
 * The feedback is sent back to the model so it can retry with correct
 * information. It contains the error type, file path, expected vs actual
 * values, syntax errors with line/column, and a suggested correction when
 * determinable.
 */

export type EditErrorType =
  | "preimage_mismatch"
  | "preimage_missing"
  | "syntax_error"
  | "write_set_denied"
  | "write_failed"
  | "postwrite_mismatch"
  | "rollback_performed"
  | "rollback_failed"
  | "zero_delta_verification"
  | "operation_invalid"
  | "path_invalid"
  | "file_not_found"
  | "file_oversized"
  | "patch_invalid";

export type EditFeedback = Readonly<{
  errorType: EditErrorType;
  path: string;
  message: string;
  expectedPreimageHash?: string;
  actualPreimageHash?: string;
  expectedPostimageHash?: string;
  actualPostimageHash?: string;
  syntaxDiagnostics?: readonly SyntaxDiagnostic[];
  suggestedCorrection?: string;
  recoverable: boolean;
  retryable: boolean;
}>;

export function createPreimageMismatchFeedback(
  path: string,
  expectedPreimageHash: string,
  actualPreimageHash: string,
): EditFeedback {
  // A non-64-hex `expected` (a truncated preview echoed back, a fabricated
  // fragment) can never equal any real digest — say so plainly instead of
  // "file changed", which would send the model re-reading a file that is not
  // stale. The full actual hash travels in `actualPreimageHash` regardless,
  // so the model's retry datum is always present.
  const formatNote = /^[0-9a-f]{64}$/i.test(expectedPreimageHash)
    ? "File changed since the model last saw it"
    : "The preimage hash provided is not a full 64-character hex SHA-256, so it cannot match the file's current content hash";
  return deepFreeze({
    errorType: "preimage_mismatch",
    path,
    message: `${formatNote}: expected preimage hash ${expectedPreimageHash.slice(0, 12)} but actual is ${actualPreimageHash.slice(0, 12)}`,
    expectedPreimageHash,
    actualPreimageHash,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "Re-read the file to get the current content and hash, then retry with the updated preimage.",
  });
}

export function createPreimageMissingFeedback(
  path: string,
  expectedPreimageHash: string,
): EditFeedback {
  return deepFreeze({
    errorType: "preimage_missing",
    path,
    message: `File does not exist but preimage hash was provided: expected ${expectedPreimageHash.slice(0, 12)}`,
    expectedPreimageHash,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "The file may have been deleted. Re-check the filesystem state and create the file if needed.",
  });
}

export function createSyntaxErrorFeedback(
  path: string,
  diagnostics: readonly SyntaxDiagnostic[],
): EditFeedback {
  const firstError = diagnostics.find((d) => d.severity === "error") ?? diagnostics[0];
  const summary = diagnostics
    .map((d) => `  line ${d.line}, col ${d.column}: ${d.message}`)
    .join("\n");
  return deepFreeze({
    errorType: "syntax_error",
    path,
    message: `Syntax validation failed with ${diagnostics.length} error(s):\n${summary}`,
    syntaxDiagnostics: deepFreeze([...diagnostics]),
    recoverable: true,
    retryable: true,
    suggestedCorrection: firstError !== undefined
      ? `Fix the syntax error at line ${firstError.line}, column ${firstError.column}: ${firstError.message}`
      : "Fix the syntax errors in the proposed content.",
  });
}

export function createWriteSetDeniedFeedback(
  path: string,
  writeSetDescription: string,
): EditFeedback {
  return deepFreeze({
    errorType: "write_set_denied",
    path,
    message: `Path '${path}' is not in the authorized write set (${writeSetDescription})`,
    recoverable: false,
    retryable: false,
    suggestedCorrection: "Only modify files in the authorized write set. Write access is granted by the session write set: start the chat with --write-set <path1,path2,...> (or set the session writeSet option).",
  });
}

export function createWriteFailedFeedback(
  path: string,
  reason: string,
): EditFeedback {
  return deepFreeze({
    errorType: "write_failed",
    path,
    message: `Atomic write failed: ${reason}`,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "The filesystem may be full, read-only, or the path may be invalid. Check filesystem permissions and retry.",
  });
}

export function createPostwriteMismatchFeedback(
  path: string,
  expectedPostimageHash: string,
  actualPostimageHash: string,
): EditFeedback {
  return deepFreeze({
    errorType: "postwrite_mismatch",
    path,
    message: `Post-write verification failed: expected postimage hash ${expectedPostimageHash.slice(0, 12)} but actual is ${actualPostimageHash.slice(0, 12)}`,
    expectedPostimageHash,
    actualPostimageHash,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "The file may have been modified by a concurrent process. Re-read the file and retry.",
  });
}

export function createRollbackFeedback(
  path: string,
  preimageHash: string,
  reason: string,
): EditFeedback {
  return deepFreeze({
    errorType: "rollback_performed",
    path,
    message: `Edit was rolled back after post-write verification failure: ${reason}`,
    expectedPreimageHash: preimageHash,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "The edit failed and was rolled back to the preimage. Re-read the file and retry.",
  });
}

export function createRollbackFailedFeedback(
  path: string,
  preimageHash: string,
  actualPostimageHash: string,
): EditFeedback {
  return deepFreeze({
    errorType: "rollback_failed",
    path,
    message:
      `Post-write verification failed AND rollback failed: file '${path}' may be in a corrupt state. ` +
      `Expected preimage hash ${preimageHash.slice(0, 12)} but the post-write hash was ${actualPostimageHash.slice(0, 12)}, ` +
      `and restoring the original content failed.`,
    expectedPreimageHash: preimageHash,
    actualPostimageHash,
    recoverable: false,
    retryable: false,
    suggestedCorrection:
      "The file may be corrupt. Re-read the file, verify its integrity, and restore from a known-good backup before retrying.",
  });
}

export function createZeroDeltaFeedback(
  path: string,
  preimageHash: string,
): EditFeedback {
  return deepFreeze({
    errorType: "zero_delta_verification",
    path,
    message: `Failed edit verified zero effect: file hash unchanged at ${preimageHash.slice(0, 12)}`,
    expectedPreimageHash: preimageHash,
    recoverable: true,
    retryable: true,
  });
}

export function createOperationInvalidFeedback(
  path: string,
  reason: string,
): EditFeedback {
  return deepFreeze({
    errorType: "operation_invalid",
    path,
    message: `Edit operation is invalid: ${reason}`,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "Check the operation parameters and ensure they are valid for the file content.",
  });
}

export function createPathInvalidFeedback(
  path: string,
  reason: string,
): EditFeedback {
  return deepFreeze({
    errorType: "path_invalid",
    path,
    message: `Path is invalid: ${reason}`,
    recoverable: false,
    retryable: false,
  });
}

export function createFileNotFoundFeedback(
  path: string,
): EditFeedback {
  return deepFreeze({
    errorType: "file_not_found",
    path,
    message: `File not found: ${path}`,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "The file does not exist. Create it first or verify the path.",
  });
}

export function createFileOversizedFeedback(
  path: string,
  size: number,
  max: number,
): EditFeedback {
  return deepFreeze({
    errorType: "file_oversized",
    path,
    message: `File size ${size} exceeds maximum ${max}`,
    recoverable: false,
    retryable: false,
  });
}

export function createPatchInvalidFeedback(
  path: string,
  reason: string,
): EditFeedback {
  return deepFreeze({
    errorType: "patch_invalid",
    path,
    message: `Patch is invalid: ${reason}`,
    recoverable: true,
    retryable: true,
    suggestedCorrection: "Check the patch format and ensure it matches the file content.",
  });
}

export function feedbackToStructured(feedback: EditFeedback): Readonly<Record<string, unknown>> {
  return deepFreeze({
    errorType: feedback.errorType,
    path: feedback.path,
    message: feedback.message,
    ...(feedback.expectedPreimageHash !== undefined ? { expectedPreimageHash: feedback.expectedPreimageHash } : {}),
    ...(feedback.actualPreimageHash !== undefined ? { actualPreimageHash: feedback.actualPreimageHash } : {}),
    ...(feedback.expectedPostimageHash !== undefined ? { expectedPostimageHash: feedback.expectedPostimageHash } : {}),
    ...(feedback.actualPostimageHash !== undefined ? { actualPostimageHash: feedback.actualPostimageHash } : {}),
    ...(feedback.syntaxDiagnostics !== undefined ? { syntaxDiagnostics: feedback.syntaxDiagnostics } : {}),
    ...(feedback.suggestedCorrection !== undefined ? { suggestedCorrection: feedback.suggestedCorrection } : {}),
    recoverable: feedback.recoverable,
    retryable: feedback.retryable,
  });
}
