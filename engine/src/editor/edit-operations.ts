import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { isUtf8Boundary, utf16OffsetFromUtf8Byte } from "../text/utf8-offsets.ts";
import { EDITOR_DEFAULT_LIMITS } from "../kernel/config-contracts.ts";
import { assertNever } from "../shared/type-guards.ts";

/**
 * Edit operations for the transactional editor.
 *
 * Per delivery map item 8: "Find or build a reliable model-facing
 * editor that uses exact preimages, syntax parsing, write sets, atomic
 * effects, post-write verification, and rollback."
 *
 * Each operation takes the exact preimage hash and computes the new content
 * from the current content + the operation. The preimage hash is verified
 * by the caller (the transactional editor) before applying.
 *
 * Operations are pure functions: they compute the new content from the
 * preimage content and return it with the expected postimage hash. They
 * do not touch the filesystem — that is the transactional editor's job.
 */

export type EditOperationKind =
  | "replaceFile"
  | "applyPatch"
  | "insertText"
  | "deleteRange"
  | "replaceRange";

export type EditOperation =
  | Readonly<{ kind: "replaceFile"; newContent: string }>
  | Readonly<{ kind: "applyPatch"; patch: string }>
  | Readonly<{ kind: "insertText"; byteOffset: number; text: string }>
  | Readonly<{ kind: "deleteRange"; startByte: number; endByte: number }>
  | Readonly<{ kind: "replaceRange"; startByte: number; endByte: number; text: string }>;

export type ComputedEdit = Readonly<{
  newContent: string;
  expectedPostimageHash: string;
}>;

export type PatchHunk = Readonly<{
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: readonly PatchLine[];
}>;

export type PatchLine = Readonly<{
  type: "context" | "add" | "remove";
  text: string;
}>;

/**
 * Editor operational default limits. The single source of truth for these
 * fallback values is `EDITOR_DEFAULT_LIMITS` in `src/config-contracts.ts`
 * (the central configuration contract). The values below mirror that
 * contract via re-export so existing imports (`MAX_FILE_BYTES`) keep working
 * without drifting from the config layer. Overrideable via `EditorLimits`
 * (sourced from the central config document's `editor` section in the chat
 * runtime). The protocol upper bounds (1 GiB file / 64 MiB patch) live in
 * `ROOT_POLICY.editor.limits` — these operational defaults (64 MiB / 4 MiB)
 * are deliberately stricter than the protocol floor.
 */
const MAX_FILE_BYTES: number = EDITOR_DEFAULT_LIMITS.maxFileBytes;
const MAX_PATCH_BYTES: number = EDITOR_DEFAULT_LIMITS.maxPatchBytes;
const MAX_INSERT_TEXT_BYTES: number = EDITOR_DEFAULT_LIMITS.maxInsertTextBytes;
/** R49-V8: max UTF-8 byte length of an editor file PATH. Re-exported from the
 * config-layer owner so `transactional-editor.ts` consumes one canonical
 * value (was a scattered inline `4096`). */
export const MAX_PATH_BYTES: number = EDITOR_DEFAULT_LIMITS.maxPathBytes;

export type EditorLimits = Readonly<{
  maxFileBytes: number;
  maxPatchBytes: number;
  maxInsertTextBytes: number;
}>;

/**
 * THE EDITOR LIMITS IN FORCE, given whatever the caller supplied.
 *
 * One fill-in step, exported so nobody has to read the default constants to
 * find out what a limit is worth. `computeReplaceFile` and the transactional
 * editor both used to fall back to `MAX_FILE_BYTES` separately, which is two
 * readers of a default where there is one resolved answer.
 */
export function resolveEditorLimits(
  limits?: Partial<EditorLimits>,
): EditorLimits {
  return Object.freeze({
    maxFileBytes: limits?.maxFileBytes ?? MAX_FILE_BYTES,
    maxPatchBytes: limits?.maxPatchBytes ?? MAX_PATCH_BYTES,
    maxInsertTextBytes: limits?.maxInsertTextBytes ?? MAX_INSERT_TEXT_BYTES,
  });
}

export function computeReplaceFile(
  _preimageContent: string,
  operation: Readonly<{ kind: "replaceFile"; newContent: string }>,
  limits?: Partial<EditorLimits>,
): ComputedEdit {
  assertIsString(operation.newContent, "newContent");
  const maxFileBytes = resolveEditorLimits(limits).maxFileBytes;
  if (Buffer.byteLength(operation.newContent, "utf8") > maxFileBytes) {
    throw new InputError("Replacement content exceeds maximum file size", "edit_replace_file_oversized");
  }
  return finalizeEdit(operation.newContent);
}

export function computeApplyPatch(
  preimageContent: string,
  operation: Readonly<{ kind: "applyPatch"; patch: string }>,
  limits?: Partial<EditorLimits>,
): ComputedEdit {
  assertIsString(operation.patch, "patch");
  const maxPatchBytes = limits?.maxPatchBytes ?? MAX_PATCH_BYTES;
  if (Buffer.byteLength(operation.patch, "utf8") > maxPatchBytes) {
    throw new InputError("Patch exceeds maximum size", "edit_apply_patch_oversized");
  }
  const hunks = parseUnifiedDiff(operation.patch);
  if (hunks.length === 0) {
    throw new InputError("Patch contains no hunks", "edit_apply_patch_empty");
  }
  const newContent = applyHunks(preimageContent, hunks);
  return finalizeEdit(newContent);
}

export function computeInsertText(
  preimageContent: string,
  operation: Readonly<{ kind: "insertText"; byteOffset: number; text: string }>,
  limits?: Partial<EditorLimits>,
): ComputedEdit {
  assertIsString(operation.text, "text");
  const maxInsertTextBytes = limits?.maxInsertTextBytes ?? MAX_INSERT_TEXT_BYTES;
  if (Buffer.byteLength(operation.text, "utf8") > maxInsertTextBytes) {
    throw new InputError("Insert text exceeds maximum size", "edit_insert_text_oversized");
  }
  const offset = validateByteOffset(operation.byteOffset, preimageContent, "byteOffset");
  const utf16Offset = utf16OffsetFromUtf8Byte(preimageContent, offset);
  const newContent = preimageContent.slice(0, utf16Offset) + operation.text + preimageContent.slice(utf16Offset);
  return finalizeEdit(newContent);
}

export function computeDeleteRange(
  preimageContent: string,
  operation: Readonly<{ kind: "deleteRange"; startByte: number; endByte: number }>,
): ComputedEdit {
  const start = validateByteOffset(operation.startByte, preimageContent, "startByte");
  const end = validateByteOffset(operation.endByte, preimageContent, "endByte");
  if (start > end) {
    throw new InputError("Delete range is inverted: start exceeds end", "edit_delete_range_inverted");
  }
  const utf16Start = utf16OffsetFromUtf8Byte(preimageContent, start);
  const utf16End = utf16OffsetFromUtf8Byte(preimageContent, end);
  const newContent = preimageContent.slice(0, utf16Start) + preimageContent.slice(utf16End);
  return finalizeEdit(newContent);
}

export function computeReplaceRange(
  preimageContent: string,
  operation: Readonly<{ kind: "replaceRange"; startByte: number; endByte: number; text: string }>,
  limits?: Partial<EditorLimits>,
): ComputedEdit {
  assertIsString(operation.text, "text");
  const maxInsertTextBytes = limits?.maxInsertTextBytes ?? MAX_INSERT_TEXT_BYTES;
  if (Buffer.byteLength(operation.text, "utf8") > maxInsertTextBytes) {
    throw new InputError("Replacement text exceeds maximum size", "edit_replace_range_oversized");
  }
  const start = validateByteOffset(operation.startByte, preimageContent, "startByte");
  const end = validateByteOffset(operation.endByte, preimageContent, "endByte");
  if (start > end) {
    throw new InputError("Replace range is inverted: start exceeds end", "edit_replace_range_inverted");
  }
  const utf16Start = utf16OffsetFromUtf8Byte(preimageContent, start);
  const utf16End = utf16OffsetFromUtf8Byte(preimageContent, end);
  const newContent = preimageContent.slice(0, utf16Start) + operation.text + preimageContent.slice(utf16End);
  return finalizeEdit(newContent);
}

export function computeEdit(
  preimageContent: string,
  operation: EditOperation,
  limits?: Partial<EditorLimits>,
): ComputedEdit {
  switch (operation.kind) {
    case "replaceFile":
      return computeReplaceFile(preimageContent, operation, limits);
    case "applyPatch":
      return computeApplyPatch(preimageContent, operation, limits);
    case "insertText":
      return computeInsertText(preimageContent, operation, limits);
    case "deleteRange":
      return computeDeleteRange(preimageContent, operation);
    case "replaceRange":
      return computeReplaceRange(preimageContent, operation, limits);
    default:
      return assertNever(operation, (v) => new SecurityError(`Unknown edit operation kind: ${String(v)}`, "edit_operation_unknown"));
  }
}

export function computeEditFromOperation(operation: EditOperation, preimageContent: string): ComputedEdit {
  return computeEdit(preimageContent, operation);
}

export function parseUnifiedDiff(patch: string): readonly PatchHunk[] {
  const lines = patch.split("\n");
  const hunks: PatchHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("---") || line.startsWith("+++")) {
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/u);
      if (hunkMatch === null) {
        throw new InputError(`Invalid hunk header: ${line}`, "edit_patch_hunk_header_invalid");
      }
      const oldStart = Number.parseInt(hunkMatch[1]!, 10);
      const oldCount = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
      const newStart = Number.parseInt(hunkMatch[3]!, 10);
      const newCount = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
      const patchLines: PatchLine[] = [];
      i++;
      let contextCount = 0;
      let addCount = 0;
      let removeCount = 0;
      while (i < lines.length && lines[i]!.length > 0) {
        const pl = lines[i]!;
        if (pl.startsWith("@@")) break;
        if (pl.startsWith(" ")) {
          patchLines.push(deepFreeze({ type: "context" as const, text: pl.slice(1) }));
          contextCount++;
        } else if (pl.startsWith("+")) {
          patchLines.push(deepFreeze({ type: "add" as const, text: pl.slice(1) }));
          addCount++;
        } else if (pl.startsWith("-")) {
          patchLines.push(deepFreeze({ type: "remove" as const, text: pl.slice(1) }));
          removeCount++;
        } else if (pl === "") {
          patchLines.push(deepFreeze({ type: "context" as const, text: "" }));
          contextCount++;
        } else if (pl.startsWith("\\") && i === lines.length - 1) {
          i++;
          break;
        } else {
          throw new InputError(`Invalid patch line: ${pl}`, "edit_patch_line_invalid");
        }
        i++;
        if (contextCount + removeCount >= oldCount && contextCount + addCount >= newCount) break;
      }
      if (contextCount + removeCount !== oldCount) {
        throw new InputError(
          `Hunk old line count mismatch: expected ${oldCount}, got ${contextCount + removeCount}`,
          "edit_patch_old_count_mismatch",
        );
      }
      if (contextCount + addCount !== newCount) {
        throw new InputError(
          `Hunk new line count mismatch: expected ${newCount}, got ${contextCount + addCount}`,
          "edit_patch_new_count_mismatch",
        );
      }
      hunks.push(deepFreeze({
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: deepFreeze(patchLines),
      }));
    } else if (line.length === 0) {
      i++;
    } else {
      i++;
    }
  }

  return deepFreeze(hunks);
}

function applyHunks(content: string, hunks: readonly PatchHunk[]): string {
  const contentLines = content.split("\n");
  let result: string[] = [];
  let currentLine = 0;

  // AUTO-HEAL Level-1: on an exact-match miss for a context/removed line,
  // retry with whitespace normalization. When the line matches after
  // normalization the drift is whitespace-only (formatting/CRLF/tab-space);
  // accept the match but keep the FILE's actual line in the output so the
  // result preserves the file's real formatting rather than the patch's
  // context spelling. A strict superset of exact matching — an exact match
  // takes the fast path; only a miss falls through to the heal.
  const healedReplacement: Map<number, string> = new Map();

  for (const hunk of hunks) {
    const hunkStart = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
    if (hunkStart < currentLine) {
      throw new InputError(
        `Hunk overlaps with previous hunk at line ${hunkStart + 1}`,
        "edit_patch_hunk_overlap",
      );
    }
    while (currentLine < hunkStart && currentLine < contentLines.length) {
      result.push(contentLines[currentLine]!);
      currentLine++;
    }
    for (const pl of hunk.lines) {
      if (pl.type === "context") {
        if (currentLine >= contentLines.length) {
          throw new InputError(
            `Context line beyond end of file: '${truncateForDisplay(pl.text)}'`,
            "edit_patch_context_beyond_eof",
          );
        }
        const expected = contentLines[currentLine]!;
        if (expected !== pl.text) {
          if (!whitespaceEquivalent(expected, pl.text)) {
            throw new InputError(
              `Context line mismatch at line ${currentLine + 1}: expected '${truncateForDisplay(expected)}', got '${truncateForDisplay(pl.text)}'`,
              "edit_patch_context_mismatch",
            );
          }
          healedReplacement.set(result.length, expected);
        }
        result.push(expected);
        currentLine++;
      } else if (pl.type === "remove") {
        if (currentLine >= contentLines.length) {
          throw new InputError(
            `Remove line beyond end of file: '${truncateForDisplay(pl.text)}'`,
            "edit_patch_remove_beyond_eof",
          );
        }
        const expected = contentLines[currentLine]!;
        if (expected !== pl.text) {
          if (!whitespaceEquivalent(expected, pl.text)) {
            throw new InputError(
              `Remove line mismatch at line ${currentLine + 1}: expected '${truncateForDisplay(expected)}', got '${truncateForDisplay(pl.text)}'`,
              "edit_patch_remove_mismatch",
            );
          }
          healedReplacement.set(result.length, expected);
        }
        currentLine++;
      } else if (pl.type === "add") {
        result.push(pl.text);
      }
    }
  }

  while (currentLine < contentLines.length) {
    result.push(contentLines[currentLine]!);
    currentLine++;
  }

  // Apply any healed replacements: a healed context line keeps the file's
  // real bytes (already pushed), so this map only records where a heal fired.
  // The result already holds the file's actual lines; nothing to substitute.
  void healedReplacement;

  return result.join("\n");
}

function finalizeEdit(newContent: string): ComputedEdit {
  return deepFreeze({
    newContent,
    expectedPostimageHash: sha256(newContent),
  });
}

function validateByteOffset(offset: number, content: string, field: string): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new InputError(`${field} must be a non-negative safe integer`, `edit_${field}_invalid`);
  }
  const maxOffset = Buffer.byteLength(content, "utf8");
  if (offset > maxOffset) {
    throw new InputError(
      `${field} ${offset} exceeds content byte length ${maxOffset}`,
      `edit_${field}_out_of_range`,
    );
  }
  if (!isUtf8Boundary(content, offset)) {
    throw new InputError(
      `${field} ${offset} is not a valid UTF-8 boundary`,
      `edit_${field}_utf8_split`,
    );
  }
  return offset;
}

function assertIsString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new InputError(`${field} must be a string`, `edit_${field}_invalid`);
  }
}

function truncateForDisplay(text: string, maxLength = 80): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

/**
 * Whitespace-tolerant line equality for the Level-1 patch heal: two lines are
 * equivalent when they agree once every whitespace run is collapsed. This is
 * the SINGLE owner of the primitive — the patch path's context/removed-line
 * heal (AUTO-HEAL Level-1) consumes it here, and hosts that heal on the same
 * whitespace-drift question (the web UI's stale-index auto-heal) re-export or
 * import it rather than re-implementing the collapse.
 */
export function whitespaceEquivalent(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

// The local `assertNever` was unified into `src/shared/type-guards.ts` (the
// canonical owner). The import above aliases the shared `assertNever` for
// the call site at the top of this file.
