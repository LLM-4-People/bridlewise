import {
  lstatSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { relativePathViolationKinds, type RelativePathViolationKind } from "../filesystem/path-boundary.ts";
import { computeEdit, resolveEditorLimits, type ComputedEdit, type EditOperation, type EditorLimits, MAX_PATH_BYTES } from "./edit-operations.ts";
import {
  createOperationInvalidFeedback,
  createPathInvalidFeedback,
  createPostwriteMismatchFeedback,
  createPreimageMismatchFeedback,
  createPreimageMissingFeedback,
  createRollbackFailedFeedback,
  createSyntaxErrorFeedback,
  createWriteFailedFeedback,
  createWriteSetDeniedFeedback,
  feedbackToStructured,
  type EditFeedback,
} from "./edit-feedback.ts";
import {
  createDefaultSyntaxValidatorRegistry,
  detectLanguage,
  validateSyntax,
  type SyntaxValidationResult,
  type SyntaxValidatorRegistry,
} from "./syntax-validator.ts";

/**
 * Transactional editor core — the model-facing file editor.
 *
 * Per delivery map item 8: "Find or build a reliable model-facing
 * editor that uses exact preimages, syntax parsing, write sets, atomic
 * effects, post-write verification, and rollback. Benchmark many models
 * and edit shapes, including partial matches, over-replacement, malformed
 * syntax, concurrency, failed-tool zero-delta proof, and feedback to the
 * model."
 *
 * Per the canonical requirements (REQ-019, REQ-022, REQ-023):
 * Separate planning from mutation: the editor applies only a bounded set.
 * Every filesystem write runs through this gateway.
 * Post-write re-read, hash comparison, and postcondition verification.
 * Rollback on any discrepancy between overlay and committed result.
 * Structured feedback to the model on failure.
 *
 * The editor's transaction protocol:
 * 1. Verify path is in the authorized write set.
 * 2. Read current file content (or detect new-file creation).
 * 3. Compute current hash; verify it matches the expected preimage hash.
 * 4. Compute the new content from the operation + preimage content.
 * 5. Validate syntax of the new content (reject if invalid).
 * 6. Write atomically: write to temp file, fsync, rename to target.
 * 7. Re-read the file and verify its hash matches the expected postimage.
 * 8. If post-write verification fails, restore the preimage (rollback).
 * 9. If any step fails, verify zero-delta (file unchanged from preimage).
 * 10. Record every attempt/success/failure/rollback in the timeline.
 */

// FIX 7: imported from edit-operations.ts (the single owner of the editor
// file-size limit) so the two modules cannot drift on the 64 MiB ceiling.

export type EditRequest = Readonly<{
  path: string;
  preimageHash: string;
  operation: EditOperation;
}>;

export type EditResult = Readonly<{
  success: boolean;
  path: string;
  operation: EditOperation;
  preimageHash: string;
  postimageHash: string | null;
  expectedPostimageHash: string | null;
  feedback: EditFeedback | null;
  durationMs: number;
  rolledBack: boolean;
  rollbackFailed: boolean;
  zeroDeltaVerified: boolean;
  syntaxValidation: SyntaxValidationResult | null;
}>;

export type EditorEffectRecorder = Readonly<{
  recordAttempt(input: Readonly<{
    path: string;
    operationKind: string;
    preimageHash: string;
  }>): void;
  recordSuccess(input: Readonly<{
    path: string;
    operationKind: string;
    preimageHash: string;
    postimageHash: string;
    durationMs: number;
  }>): void;
  recordFailure(input: Readonly<{
    path: string;
    operationKind: string;
    preimageHash: string;
    feedback: EditFeedback;
    durationMs: number;
  }>): void;
  recordRollback(input: Readonly<{
    path: string;
    operationKind: string;
    preimageHash: string;
    reason: string;
  }>): void;
  /**
   * Optional post-write hook invoked after a successful, committed edit
   * (right after {@link recordSuccess}). Used by the chat runtime to auto-run
   * quality checks on the edited file so the model does not have to remember
   * to call `run_quality_check` manually (delivery-map item 9 / FIX 8). The
   * hook is an observer: a throwing hook must never crash the editor, so the
   * editor swallows any error it raises.
   */
  onWriteSuccess?(input: Readonly<{ path: string; operationKind: string }>): void;
}>;

export type TransactionalEditorOptions = Readonly<{
  repositoryRoot: string;
  writeSet: ReadonlySet<string>;
  syntaxValidatorRegistry?: SyntaxValidatorRegistry;
  recorder?: EditorEffectRecorder;
  skipSyntaxValidation?: boolean;
  skipUnknownExtensions?: boolean;
  /**
   * Override the file reader (defaults to `readFileSync(resolvedPath)`).
   * Injected so a host can route the editor's reads through its own gated
   * file owner rather than a bare `readFileSync` — the editor keeps its
   * governance (preimage verify, post-write verify, rollback) while the
   * host keeps ownership of how bytes are read. The returned value is
   * hashed and compared against the expected preimage, so a reader that
   * reads the wrong file fails the edit rather than corrupting it.
   */
  reader?: (resolvedPath: string) => string;
  /**
   * Override the atomic-write primitive (defaults to `atomicWriteFile`).
   * Injected by tests to simulate a write that succeeds for the edit but
   * fails for the rollback, deterministically exercising the
   * post-write-mismatch + rollback-failure path — and by hosts whose
   * writes must pass through a gated owner.
   */
  atomicWriter?: (resolvedPath: string, content: string) => Readonly<{ success: boolean; reason?: string }>;
  editorConfig?: Partial<EditorLimits>;
}>;

export type TransactionalEditor = Readonly<{
  applyEdit(request: EditRequest): EditResult;
  getWriteSet(): readonly string[];
  getRepositoryRoot(): string;
}>;

export function createTransactionalEditor(options: TransactionalEditorOptions): TransactionalEditor {
  if (typeof options.repositoryRoot !== "string" || options.repositoryRoot.length === 0) {
    throw new InputError("Repository root is required", "editor_root_missing");
  }
  if (!options.writeSet || !(options.writeSet instanceof Set)) {
    throw new InputError("Write set is required and must be a Set", "editor_write_set_invalid");
  }
  const root = options.repositoryRoot;
  const writeSet = options.writeSet;
  const syntaxRegistry = options.syntaxValidatorRegistry ?? createDefaultSyntaxValidatorRegistry();
  const recorder = options.recorder;
  const skipSyntax = options.skipSyntaxValidation ?? false;
  const skipUnknown = options.skipUnknownExtensions ?? false;
  const atomicWriter = options.atomicWriter ?? atomicWriteFile;
  const reader = options.reader ?? ((resolvedPath: string): string => readFileSync(resolvedPath, "utf8"));
  const maxFileBytes = resolveEditorLimits(options.editorConfig).maxFileBytes;
  const editorLimits = options.editorConfig;

  return deepFreeze({
    applyEdit(request: EditRequest): EditResult {
      return doApplyEdit(request);
    },
    getWriteSet(): readonly string[] {
      return [...writeSet].sort();
    },
    getRepositoryRoot(): string {
      return root;
    },
  });

  function doApplyEdit(request: EditRequest): EditResult {
    const startMs = performance.now();
    const operationKind = request.operation.kind;

    let pathFeedback: EditFeedback | null = null;
    try {
      validatePath(request.path);
    } catch (error) {
      const reason = extractErrorMessage(error);
      pathFeedback = createPathInvalidFeedback(request.path, reason);
      if (recorder !== undefined) {
        const fb = pathFeedback;
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback: fb, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, null, null, pathFeedback, false, false);
    }

    if (recorder !== undefined) {
      bestEffort(() => recorder.recordAttempt({
        path: request.path,
        operationKind,
        preimageHash: request.preimageHash,
      }));
    }

    if (!writeSet.has(request.path)) {
      const feedback = createWriteSetDeniedFeedback(request.path, `${writeSet.size} authorized path(s)`);
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, null, null, feedback, false, false);
    }

    const resolvedPath = join(root, request.path);
    const preimageResult = readPreimage(resolvedPath, request.preimageHash, isCreateRequest(request));
    if (!preimageResult.ok) {
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback: preimageResult.feedback, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, null, null, preimageResult.feedback, false, false);
    }

    const preimageContent = preimageResult.content;
    const actualPreimageHash = sha256(preimageContent);
    // `sha256` emits lowercase hex; a caller echoing the same digest in
    // uppercase is not stale. Normalize case before comparing so a casing
    // difference cannot masquerade as a content change.
    if (actualPreimageHash !== request.preimageHash.toLowerCase()) {
      const feedback = createPreimageMismatchFeedback(request.path, request.preimageHash, actualPreimageHash);
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, actualPreimageHash, null, feedback, false, false);
    }

    let computed: ComputedEdit;
    try {
      computed = computeEdit(preimageContent, request.operation, editorLimits);
    } catch (error) {
      const reason = extractErrorMessage(error);
      const feedback = createOperationInvalidFeedback(request.path, reason);
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, actualPreimageHash, null, feedback, false, true);
    }

    if (Buffer.byteLength(computed.newContent, "utf8") > maxFileBytes) {
      const feedback = createOperationInvalidFeedback(request.path, `Resulting file exceeds maximum size of ${maxFileBytes} bytes`);
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, actualPreimageHash, null, feedback, false, true);
    }

    let syntaxResult: SyntaxValidationResult | null = null;
    if (!skipSyntax) {
      syntaxResult = validateSyntax(request.path, computed.newContent, syntaxRegistry, { skipUnknown });
      if (!syntaxResult.valid) {
        const feedback = createSyntaxErrorFeedback(request.path, syntaxResult.diagnostics);
        if (recorder !== undefined) {
          bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) }));
        }
        return failResult(request, startMs, actualPreimageHash, null, feedback, false, true);
      }
    }

    const writeResult = atomicWrite(resolvedPath, computed.newContent);
    if (!writeResult.success) {
      const zeroDelta = verifyZeroDelta(resolvedPath, preimageContent);
      const feedback = createWriteFailedFeedback(request.path, writeResult.reason ?? "unknown error");
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) }));
      }
      return failResult(request, startMs, actualPreimageHash, null, feedback, false, zeroDelta);
    }

    const postRead = reader(resolvedPath);
    const actualPostimageHash = sha256(postRead);
    if (actualPostimageHash !== computed.expectedPostimageHash) {
      const rollbackResult = restorePreimage(resolvedPath, preimageContent);
      const zeroDelta = verifyZeroDelta(resolvedPath, preimageContent);
      // When rollback fails the file may be in a corrupt state: the edit
      // was written but the post-write hash mismatched, AND restoring the
      // preimage failed. Surface this explicitly instead of silently
      // reporting rolledBack:true (the prior `feedback;` was a no-op that
      // discarded the rollback failure).
      const feedback = rollbackResult
        ? createPostwriteMismatchFeedback(request.path, computed.expectedPostimageHash, actualPostimageHash)
        : createRollbackFailedFeedback(request.path, request.preimageHash, actualPostimageHash);
      if (recorder !== undefined) {
        bestEffort(() => {
          recorder.recordRollback({ path: request.path, operationKind, preimageHash: request.preimageHash, reason: feedback.message });
          recorder.recordFailure({ path: request.path, operationKind, preimageHash: request.preimageHash, feedback, durationMs: elapsed(startMs) });
        });
      }
      return failResult(request, startMs, actualPreimageHash, null, feedback, rollbackResult, zeroDelta, !rollbackResult);
    }

    const durationMs = elapsed(startMs);
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordSuccess({
        path: request.path,
        operationKind,
        preimageHash: request.preimageHash,
        postimageHash: actualPostimageHash,
        durationMs,
      }));
      // FIX 8: invoke the optional post-write hook so the chat runtime can
      // auto-run quality checks on the edited file. Observer-only: a throwing
      // hook must never crash the editor or lose the successful edit result.
      if (recorder.onWriteSuccess !== undefined) {
        bestEffort(() => recorder.onWriteSuccess!({ path: request.path, operationKind }));
      }
    }

    return deepFreeze({
      success: true,
      path: request.path,
      operation: request.operation,
      preimageHash: request.preimageHash,
      postimageHash: actualPostimageHash,
      expectedPostimageHash: computed.expectedPostimageHash,
      feedback: null,
      durationMs,
      rolledBack: false,
      rollbackFailed: false,
      zeroDeltaVerified: true,
      syntaxValidation: syntaxResult,
    });
  }

type PreimageResult = Readonly<
  | { ok: true; content: string }
  | { ok: false; feedback: EditFeedback }
>;

  /**
   * `true` only when the request is a genuine file CREATE: a whole-file
   * `replaceFile` operation whose supplied preimage hash is the hash of the
   * empty string. A missing file is then the valid starting state. Any other
   * operation, or a non-empty preimage on a missing file, is not a create and
   * the missing-preimage refusal stands (it is the stale-snapshot signal).
   */
  function isCreateRequest(request: EditRequest): boolean {
    return (
      request.operation.kind === "replaceFile" &&
      request.preimageHash.toLowerCase() === sha256("")
    );
  }

  // EXP444 root-cause fix: content-based binary guard in the SHARED read path.
  // The guard existed only in applyAtomicEdit (exp444 experiment) but NOT in the
  // canonical transactional-editor's readPreimage, so binary files (PNG/ELF/JPEG)
  // were read as UTF-8 → decoded → edited → re-encoded, silently corrupting them.
  // This is a DYNAMIC, content-based check (null-byte + >10% non-text control
  // bytes in the first 8KB) — NOT a static extension list (per "no static
  // constants" directive). Reads via openSync+readSync to avoid loading 100MB.
  function looksBinary(filePath: string): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const buf = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buf, 0, 8192, 0);
      closeSync(fd);
      fd = undefined;
      const slice = buf.subarray(0, bytesRead);
      if (slice.length === 0) return false;
      if (slice.indexOf(0x00) !== -1) return true;
      let nonText = 0;
      for (let i = 0; i < slice.length; i++) {
        const b = slice[i] ?? 0;
        if (b < 32 && b !== 9 && b !== 10 && b !== 13) nonText++;
      }
      return nonText / slice.length > 0.10;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) { const fdClose = fd; bestEffort(() => closeSync(fdClose)); }
    }
  }

  function readPreimage(resolvedPath: string, expectedHash: string, allowCreate = false): PreimageResult {
    let stats;
    try {
      stats = lstatSync(resolvedPath, { bigint: true, throwIfNoEntry: false });
    } catch {
      return { ok: false, feedback: createWriteFailedFeedback(resolvedPath, "lstat failed") };
    }
    if (stats === undefined) {
      // CREATE: the file does not exist and the caller supplied the empty
      // preimage (sha256("")) on a whole-file replace. There is nothing to
      // verify against — an absent file is the precondition for a create, and
      // the write itself is still syntax-validated, atomic, and post-write
      // verified. This is the ONLY path that turns a missing preimage into an
      // empty one; any other operation keeps the missing-preimage refusal.
      if (allowCreate) return { ok: true, content: "" };
      return { ok: false, feedback: createPreimageMissingFeedback(resolvedPath, expectedHash) };
    }
    if (stats.isSymbolicLink()) {
      return { ok: false, feedback: createPathInvalidFeedback(resolvedPath, "symlinks are forbidden") };
    }
    if (!stats.isFile()) {
      return { ok: false, feedback: createPathInvalidFeedback(resolvedPath, "not a regular file") };
    }
    if (stats.size > BigInt(maxFileBytes)) {
      return { ok: false, feedback: createPathInvalidFeedback(resolvedPath, `file size exceeds maximum ${maxFileBytes}`) };
    }
    if (looksBinary(resolvedPath)) {
      return { ok: false, feedback: createPathInvalidFeedback(resolvedPath, "file appears to be binary (null bytes or high non-text ratio); text edits are refused to avoid corruption") };
    }
    try {
      const content = reader(resolvedPath);
      return { ok: true, content };
    } catch (error) {
      const reason = extractErrorMessage(error);
      return { ok: false, feedback: createWriteFailedFeedback(resolvedPath, `read failed: ${reason}`) };
    }
  }

  function atomicWrite(resolvedPath: string, content: string): Readonly<{ success: boolean; reason?: string }> {
    return atomicWriter(resolvedPath, content);
  }

  function restorePreimage(resolvedPath: string, preimageContent: string): boolean {
    const writeResult = atomicWrite(resolvedPath, preimageContent);
    if (!writeResult.success) return false;
    const postRead = reader(resolvedPath);
    return sha256(postRead) === sha256(preimageContent);
  }

  function verifyZeroDelta(resolvedPath: string, preimageContent: string): boolean {
    try {
      const current = reader(resolvedPath);
      return sha256(current) === sha256(preimageContent);
    } catch {
      return false;
    }
  }

  function failResult(
    request: EditRequest,
    startMs: number,
    actualPreimageHash: string | null,
    _expectedPostimageHash: string | null,
    feedback: EditFeedback | null,
    rolledBack: boolean,
    zeroDeltaVerified: boolean,
    rollbackFailed = false,
  ): EditResult {
    return deepFreeze({
      success: false,
      path: request.path,
      operation: request.operation,
      preimageHash: request.preimageHash,
      postimageHash: actualPreimageHash,
      expectedPostimageHash: null,
      feedback,
      durationMs: elapsed(startMs),
      rolledBack,
      rollbackFailed,
      zeroDeltaVerified,
      syntaxValidation: null,
    });
  }
}

function elapsed(startMs: number): number {
  return Math.round(performance.now() - startMs);
}

function validatePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new InputError("Path is required", "edit_path_empty");
  }
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    throw new InputError("Path exceeds maximum length", "edit_path_oversized");
  }
  const violations = relativePathViolationKinds(path);
  if (violations.length > 0) {
    throw editPathViolationError(violations);
  }
}

function editPathViolationError(violations: readonly RelativePathViolationKind[]): SecurityError | InputError {
  if (violations.includes("absolute")) {
    return new SecurityError("Absolute paths are forbidden", "edit_path_absolute");
  }
  if (violations.includes("dot-segment")) {
    return new SecurityError("Path traversal is forbidden", "edit_path_traversal");
  }
  if (violations.includes("backslash")) {
    return new SecurityError("Backslash in path is forbidden", "edit_path_backslash");
  }
  if (violations.includes("control-character")) {
    return new SecurityError("Control characters in path are forbidden", "edit_path_control");
  }
  if (violations.includes("empty-segment")) {
    return new SecurityError("Empty path segments are forbidden", "edit_path_empty_segment");
  }
  return new SecurityError("Path is invalid", "edit_path_invalid");
}

export { validatePath };
export { feedbackToStructured };
export { detectLanguage };
