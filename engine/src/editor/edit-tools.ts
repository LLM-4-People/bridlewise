import { deepFreeze } from "../kernel/integrity.ts";
import {
  createTransactionalEditor,
  feedbackToStructured,
  type EditRequest,
  type EditResult,
  type TransactionalEditor,
  type TransactionalEditorOptions,
} from "./transactional-editor.ts";
import { readFileSync } from "node:fs";
import { isWholeFileSentinel, resolvePreimageToRange, type ResolveOptions } from "./edit-resolve.ts";
import { createDefaultSyntaxValidatorRegistry, detectLanguage, validateSyntax } from "./syntax-validator.ts";
import { sha256 } from "../kernel/integrity.ts";
import type { ToolDefinition } from "../runtime/provider-adapter.ts";
import { editorState } from "../shared/exposure/registrations/editor.ts";

/**
 * Editor tool integration — registers the ONE model-facing edit tool with the
 * tool-registry so the model can call it.
 *
 * There is exactly ONE edit tool, `edit(path, oldString, newString)`. Every
 * edit shape collapses to it: replace (oldString → newString), insert
 * (oldString = anchor, newString = anchor + inserted), delete (newString =
 * `""`), whole-file (oldString = the `<all>` sentinel), and create (a path
 * that does not exist yet + empty oldString + newString = content). The model
 * supplies a STRING preimage — never a hash it cannot compute or a byte offset
 * it cannot count. The resolver (`edit-resolve.ts`) turns the preimage into a
 * byte range and computes the preimage hash itself; the transactional editor
 * keeps governance (preimage verify → syntax → atomic write → post-write
 * verify → rollback).
 *
 * This handler is also the ONE place edit telemetry is recorded: every edit
 * the model can make converges here, so the exposure counters the UI serves
 * (`editor.editCount`, `editor.refusalCount`, `editor.healTriggerCount`, …)
 * are incremented at the point the event actually happens — never by a
 * synthetic demo action standing in for the real path.
 */

export type EditorToolArgs = Readonly<{
  path: string;
  oldString?: string;
  newString?: string;
}>;

export type EditorToolResult = Readonly<{
  success: boolean;
  path: string;
  operation: string;
  preimageHash: string | null;
  postimageHash: string | null;
  /** Which cascade level resolved the preimage (`exact`/`whitespace`/`escape`/`fuzzy`). */
  strategy: string | null;
  feedback: Readonly<Record<string, unknown>> | null;
  durationMs: number;
  rolledBack: boolean;
  zeroDeltaVerified: boolean;
}>;

export function createEditorToolDefinitions(): readonly ToolDefinition[] {
  return [editToolDefinition];
}

/**
 * The plain-words imperative label the UI shows for one `edit` call. The
 * tool's `ToolDefinition` (the LLM wire shape) has no label field, so the
 * label is owned here — beside the definition it describes — and the web
 * bridge reads it when it converts the definition into a manifest entry.
 * A consumer never re-answers "what is edit called in plain words" by hand.
 */
export const EDIT_TOOL_LABEL = "edit file";

export function createEditorTools(
  options: TransactionalEditorOptions,
  resolveOptions?: ResolveOptions,
): Readonly<{
  editor: TransactionalEditor;
  definitions: readonly ToolDefinition[];
  handlers: Readonly<Record<string, (args: EditorToolArgs) => EditorToolResult>>;
}> {
  const editor = createTransactionalEditor(options);
  const definitions = createEditorToolDefinitions();
  const handlers: Record<string, (args: EditorToolArgs) => EditorToolResult> = {
    edit: (args) => executeEdit(editor, args, resolveOptions),
  };
  return deepFreeze({ editor, definitions, handlers: deepFreeze(handlers) });
}

/**
 * The safety contract for `edit`, locked by tests:
 * - Empty/missing `oldString` on an EXISTING file → refused (never wipes a file).
 * - Empty/missing `oldString` on a NON-existent file → create (nothing to wipe);
 *   the content is syntax-validated for the target language.
 * - Empty `newString` → delete (safe: the preimage was verified present first).
 * - Ambiguous `oldString` (matches more than once) → refused, no wrong guess.
 * - Whole-file (`<all>`) and create content are syntax-validated; invalid → refused.
 */
function executeEdit(
  editor: TransactionalEditor,
  args: EditorToolArgs,
  resolveOptions?: ResolveOptions,
): EditorToolResult {
  const path = args.path;
  const oldString = args.oldString;
  const newString = args.newString ?? "";

  // Telemetry lives at this choke point: every path an edit can take —
  // whole-file, create, refusal, or a ranged apply — converges on one of the
  // two returns below, so the counters the signals read measure the real
  // pipeline. A counter no path ever increments is not declared at all
  // (honest absence over a fake zero).
  const fail = (message: string, errorType?: string, syntax = false): EditorToolResult => {
    editorState.editCount += 1;
    editorState.lastEditAt = Date.now();
    editorState.failureCount += 1;
    editorState.refusalCount += 1;
    if (syntax) editorState.syntaxRefusalCount += 1;
    return errorResult(path ?? "", message, errorType);
  };
  const succeed = (
    request: EditRequest,
    operation: string,
    strategy: string | null = null,
  ): EditorToolResult => {
    // Capture the pre-edit state BEFORE the write — after `apply` returns the
    // file already holds the postimage, so a snapshot read then would record
    // the new bytes and "rollback" would re-apply the edit it claims to undo.
    const existedBefore = readCurrent(editor, request.path);
    const result: EditorToolResult = apply(editor, request, operation, strategy);
    editorState.editCount += 1;
    editorState.lastEditAt = Date.now();
    if (operation === "replaceFile") editorState.wholeFileReplaceCount += 1;
    if (strategy === "exact") editorState.healExactCount += 1;
    else if (strategy === "whitespace") editorState.healWhitespaceCount += 1;
    else if (strategy === "escape") editorState.healEscapeCount += 1;
    else if (strategy === "fuzzy") editorState.healFuzzyCount += 1;
    if (result.success) {
      editorState.successCount += 1;
      editorState.totalEditsApplied += 1;
      editorState.lastFailureReason = "";
    } else {
      editorState.failureCount += 1;
      // A refusal the syntax gate produced is reported as one, whether it was
      // caught pre-write or by the editor's own post-compute validation.
      if (result.feedback?.["errorType"] === "syntax_error") {
        editorState.refusalCount += 1;
        editorState.syntaxRefusalCount += 1;
      }
      const reason = result.feedback?.["message"];
      editorState.lastFailureReason = typeof reason === "string" ? reason : "edit failed";
    }
    // Retain the pre-edit state so `editor.rollback` has something real to
    // restore — a pop of an empty history was a fake refusal. Only a SUCCESSFUL
    // edit changes the file, so only one gets a snapshot; a failed edit is a
    // zero-delta and restoring it would resurrect stale bytes. A create's
    // snapshot is `existed: false` — restoring it removes the file. Snapshots
    // are kept only while `backupOnEdit` is on and bounded by
    // `historyRetention`, exactly the knobs the `editor.history` block
    // describes. The restore goes through `editor.rollback`'s action, which
    // replays the snapshot through a governed whole-file write.
    if (result.success && editorState.backupOnEdit) {
      editorState.history.push({
        repositoryRoot: editor.getRepositoryRoot(),
        path: request.path,
        previousContent: existedBefore ?? "",
        existed: existedBefore !== null,
        operation,
        strategy,
        outcome: "applied",
        at: editorState.lastEditAt,
        contextLines: existedBefore === null ? 0 : existedBefore.split("\n").length,
        hunks: 1,
      });
      while (editorState.history.length > editorState.historyRetention) {
        editorState.history.shift();
      }
    }
    return result;
  };

  if (typeof path !== "string" || path.length === 0) {
    return fail("missing path — the file to edit is required");
  }
  if (typeof newString !== "string") {
    return fail("missing newString — the replacement text is required (use \"\" to delete the matched text)");
  }

  const exists = fileExistsInWriteSet(editor, path);

  // Whole-file replace — EXPLICIT sentinel only.
  if (isWholeFileSentinel(oldString)) {
    const syntax = validateWholeFileSyntax(editor, path, newString);
    if (syntax !== null) return fail(syntax, undefined, true);
    return succeed({
      path,
      preimageHash: exists ? hashOfCurrent(editor, path) : sha256(""),
      operation: { kind: "replaceFile", newContent: newString },
    }, exists ? "replaceFile" : "createFile");
  }

  // Create — the target does NOT exist and no preimage was supplied.
  if (!exists && (oldString === undefined || oldString === null || oldString === "")) {
    const syntax = validateWholeFileSyntax(editor, path, newString);
    if (syntax !== null) return fail(syntax, undefined, true);
    return succeed({
      path,
      preimageHash: sha256(""),
      operation: { kind: "replaceFile", newContent: newString },
    }, "createFile");
  }

  // Existing file, no usable preimage → refused (never silently wipe).
  if (typeof oldString !== "string" || oldString.length === 0) {
    return fail(
      'missing or empty oldString. To replace the whole file pass oldString:"<all>"; to create a new file target a path that does not exist; to insert, anchor on the exact line before/after the insertion point.',
    );
  }
  if (!exists) {
    return fail(
      `The file "${path}" does not exist. To CREATE it, retry with oldString set to "" (empty) and newString set to the full file content.`,
      "file_not_found",
    );
  }

  // Partial edit: resolve the string preimage → byte range, then replaceRange.
  const current = readCurrent(editor, path);
  if (current === null) {
    return fail(`The file "${path}" could not be read; re-read it and retry.`);
  }
  const resolved = resolvePreimageToRange(current, oldString, resolveOptions);
  if (!resolved.ok) {
    return fail(resolved.detail, resolved.reason);
  }
  return succeed({
    path,
    preimageHash: sha256(current),
    operation: { kind: "replaceRange", startByte: resolved.startByte, endByte: resolved.endByte, text: newString },
  }, "replaceRange", resolved.strategy);
}

function apply(
  editor: TransactionalEditor,
  request: EditRequest,
  operation: string,
  strategy: string | null = null,
): EditorToolResult {
  const result: EditResult = editor.applyEdit(request);
  return deepFreeze({
    success: result.success,
    path: result.path,
    operation,
    preimageHash: result.preimageHash,
    postimageHash: result.postimageHash,
    strategy,
    feedback: result.feedback !== null ? feedbackToStructured(result.feedback) : null,
    durationMs: result.durationMs,
    rolledBack: result.rolledBack,
    rollbackFailed: result.rollbackFailed,
    zeroDeltaVerified: result.zeroDeltaVerified,
  });
}

function errorResult(
  path: string,
  message: string,
  errorType = "operation_invalid",
): EditorToolResult {
  return deepFreeze({
    success: false,
    path,
    operation: "edit",
    preimageHash: null,
    postimageHash: null,
    strategy: null,
    feedback: deepFreeze({
      errorType,
      path,
      message,
      recoverable: true,
      retryable: true,
    }),
    durationMs: 0,
    rolledBack: false,
    rollbackFailed: false,
    zeroDeltaVerified: false,
  });
}

// ── File-state probes (read through the editor's own root) ──

function joinPath(root: string, path: string): string {
  return root.endsWith("/") ? root + path : root + "/" + path;
}

function fileExistsInWriteSet(editor: TransactionalEditor, path: string): boolean {
  return readCurrent(editor, path) !== null;
}

function readCurrent(editor: TransactionalEditor, path: string): string | null {
  try {
    // The editor's root is the only path base; the transactional editor
    // enforces the write set, path safety, and binary refusal on the real write.
    const content: unknown = readFileSync(joinPath(editor.getRepositoryRoot(), path), "utf8");
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

function hashOfCurrent(editor: TransactionalEditor, path: string): string {
  const current = readCurrent(editor, path);
  return sha256(current ?? "");
}

function validateWholeFileSyntax(
  _editor: TransactionalEditor,
  path: string,
  content: string,
): string | null {
  const result = validateSyntax(path, content, createDefaultSyntaxValidatorRegistry(), { skipUnknown: true });
  if (!result.valid) {
    const first = result.diagnostics[0]?.message ?? "not valid for its language";
    return `The content produced invalid syntax. Check that newString is balanced (braces, quotes, parens) and that escape sequences (\\n, \\") are intact. ${first}`;
  }
  return null;
}

const editToolDefinition: ToolDefinition = deepFreeze({
  type: "function",
  function: {
    name: "edit",
    description:
      "Edit a file by replacing an exact text range. Express every change as oldString (the exact existing text) " +
      "and newString (its replacement). REPLACE: oldString = the exact text, newString = the replacement. INSERT: " +
      "oldString = an existing anchor line, newString = that SAME anchor plus the new lines. DELETE: newString = \"\" " +
      "(empty). REPLACE THE WHOLE FILE: oldString = \"<all>\", newString = the complete new content. CREATE a new " +
      "file: path must NOT exist yet, oldString = \"\" (or omit it), newString = the file content. oldString must " +
      "match EXACTLY ONCE. If the text appears more than once, widen it with the unique surrounding lines (e.g. the " +
      "function signature). Copy oldString verbatim, including indentation and newlines. The result is syntax-checked, " +
      "written atomically, and verified after the write.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the repository root." },
        oldString: { type: "string", description: "The exact text to replace (must occur exactly once), \"<all>\" for the whole file, or \"\" to create a new file." },
        newString: { type: "string", description: "The replacement text, \"\" to delete the matched text, or the full content for a whole-file replace / create." },
      },
      required: ["path", "newString"],
    },
  },
});

// `detectLanguage` is re-exported for hosts that heal on the language question
// without re-deriving it from the path.
export { detectLanguage };
