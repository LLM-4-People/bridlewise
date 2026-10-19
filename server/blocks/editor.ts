/**
 * Editor block — the read/action surface AROUND the single `edit` tool.
 *
 * The model-facing `edit` tool itself stays a tool (manifest + executor). What
 * lives here is the surface a UI or another module reads: a preview of what an
 * edit WOULD change (resolve the string preimage, compute the postimage,
 * without writing), the retained edit history, and the rollback verb. All of
 * it enters through `defineBlock` — route, zod validation, client binding and
 * schema entry are derived, never hand-wired — and registers through the
 * router, inheriting auth/CSRF/rate-limit/error mapping.
 *
 * The resolution runs through the ONE resolver owner
 * (`engine/src/editor/edit-resolve.ts`) and the postimage through the ONE
 * compute owner (`edit-operations.ts`) — nothing here re-implements a heal or
 * a byte-range. Reads/writes go through the fs-gate bridge (the bytes owner),
 * so a preview cannot read a file the caller cannot see.
 */

import { z } from "zod";
import { join } from "node:path";

import { resolvePreimageToRange, isWholeFileSentinel } from "../../engine/src/editor/edit-resolve.ts";
import { computeEdit } from "../../engine/src/editor/edit-operations.ts";
import { executeAction } from "../kernel/canonical.ts";
import { editorState } from "../../engine/src/shared/exposure/registrations/editor.ts";
import { sha256 } from "../kernel/digest.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { readFileRaw } from "../filesystem/editor-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { makeFsGate, assertProjectPathOwnership } from "../filesystem/fs-gate.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

const ProjectFileScope = z.strictObject({
  /** The project root (absolute path on the server's host). */
  path: z.string().min(1),
  /** The file to edit, relative to the project root. */
  file: z.string().min(1),
});

const PreviewInput = ProjectFileScope.extend({
  /** The exact text to replace, `"<all>"` for the whole file, or "" to create. */
  oldString: z.string(),
  /** The replacement text ("" to delete the matched text). */
  newString: z.string(),
});

const PreviewOutput = z.strictObject({
  ok: z.boolean(),
  /** Which cascade level resolved the preimage (exact/whitespace/escape/fuzzy). */
  strategy: z.string().nullable(),
  /** The SHA-256 of the content the edit WOULD produce (null when refused). */
  expectedPostimageHash: z.string().nullable(),
  /** Byte length of the would-be postimage (null when refused). */
  postimageBytes: z.number().nullable(),
  /** The refusal reason, when refused. */
  reason: z.string().nullable(),
  detail: z.string().nullable(),
});

const HistoryOutput = z.strictObject({
  editCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  rollbackCount: z.number(),
  jsonRepairCount: z.number(),
  refusalCount: z.number(),
  lastEditAt: z.number(),
  historyDepth: z.number(),
});

const RollbackOutput = z.strictObject({
  rolledBack: z.boolean(),
  reason: z.string().nullable(),
});

/** Register the editor blocks. */
export function defineEditorBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "editor.history",
    title: "Edit history",
    description:
      "The retained counters for the edit tool: how many edits ran, healed, were refused, repaired from malformed JSON, or rolled back.",
    read: {
      input: z.strictObject({}),
      output: HistoryOutput,
      ttlMs: 5_000,
      handler: async (_input, { ctx }: BlockHandlerContext) => {
        await requireUserContext(ctx, db);
        return {
        editCount: editorState.editCount,
        successCount: editorState.successCount,
        failureCount: editorState.failureCount,
        rollbackCount: editorState.rollbackCount,
        jsonRepairCount: editorState.jsonRepairCount,
        refusalCount: editorState.refusalCount,
        lastEditAt: editorState.lastEditAt,
        historyDepth: editorState.history.length,
        };
      },
    },
  });

  defineBlock({
    id: "editor.preview",
    title: "Preview an edit",
    description:
      "Compute what an edit would change — the matched text range and the resulting content hash — without writing anything to the file.",
    actions: {
      preview: {
        input: PreviewInput,
        output: PreviewOutput,
        title: "Preview",
        consequence:
          "Computes the result of the edit you describe and reports the matched range and resulting content hash. Nothing is written to the file.",
        handler: async (input, { ctx }: BlockHandlerContext): Promise<z.infer<typeof PreviewOutput>> => {
          const user = await requireUserContext(ctx, db);
          const gate = await makeFsGate(user.userId, db, input.path);
          // Ownership is gated BEFORE any path is reasoned about — a whole-file
          // preview computes no read, but it must still refuse a path the caller
          // does not own (otherwise the block leaks "this path is editable" for
          // someone else's project). `assertProjectPathOwnership` throws a typed
          // refusal the router maps to 403/404.
          assertProjectPathOwnership(input.path, gate);
          // Whole-file / create: the postimage is newString directly.
          if (isWholeFileSentinel(input.oldString)) {
            return {
              ok: true,
              strategy: "exact",
              expectedPostimageHash: sha256(input.newString),
              postimageBytes: Buffer.byteLength(input.newString, "utf8"),
              reason: null,
              detail: null,
            };
          }
          let content: string;
          try {
            content = readFileRaw(join(input.path, input.file), input.path, gate).content;
          } catch {
            return { ok: false, strategy: null, expectedPostimageHash: null, postimageBytes: null, reason: "file_not_found", detail: `The file "${input.file}" does not exist in this project.` };
          }
          const resolved = resolvePreimageToRange(content, input.oldString, {
            healCascadeEnabled: editorState.healCascadeEnabled,
            fuzzyThreshold: editorState.fuzzyThreshold,
          });
          if (!resolved.ok) {
            return { ok: false, strategy: null, expectedPostimageHash: null, postimageBytes: null, reason: resolved.reason, detail: resolved.detail };
          }
          const computed = computeEdit(content, { kind: "replaceRange", startByte: resolved.startByte, endByte: resolved.endByte, text: input.newString });
          return {
            ok: true,
            strategy: resolved.strategy,
            expectedPostimageHash: computed.expectedPostimageHash,
            postimageBytes: Buffer.byteLength(computed.newContent, "utf8"),
            reason: null,
            detail: null,
          };
        },
      },
      rollback: {
        input: z.strictObject({}),
        output: RollbackOutput,
        title: "Roll back last edit",
        consequence:
          "Restores the most recent retained edit snapshot. If no snapshot was kept (backups off, or none yet), it reports that nothing was restored.",
        invalidates: ["editor:changed"],
        handler: async (_input, { ctx }: BlockHandlerContext): Promise<z.infer<typeof RollbackOutput>> => {
          await requireUserContext(ctx, db);
          const result = await executeAction("editor.rollback");
          const r = result as Readonly<Record<string, unknown>>;
          return {
            rolledBack: r["rolledBack"] === true,
            reason: typeof r["reason"] === "string" ? r["reason"] : null,
          };
        },
      },
    },
    signals: ["editor.editCount", "editor.refusalCount", "editor.jsonRepairCount"],
  });
}
