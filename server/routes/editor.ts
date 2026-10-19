/**
 * Editor routes — file reading, writing, and editing within the project root.
 *
 * Routes:
 * GET /api/editor/read?path=<file>&root=<project> — read file content
 * PUT /api/editor/write — write file content
 * PUT /api/editor/edit — transactional edit (preimage match)
 *
 * (filesystem access owner): project-ownership is now enforced at
 * the BRIDGE (editor-bridge.ts via server/fs-gate.ts), NOT in the route.
 * The route resolves the authenticated user (`requireUserContext`) + passes
 * the `FsGate` to the bridge; the bridge calls `assertProjectPathOwnership`
 * at the choke point. A route that forgets the gate cannot leak — the
 * mechanical test (`filesystem-owner.test.ts`) verifies the gate is passed.
 * The per-route `requireProjectByPath` is removed (the bridge owns it).
 */

import { z } from "zod";

import type { Router } from "../router/router.ts";
import { sendJson, sendJsonRaw } from "../router/router.ts";
import { assertValidBody } from "../router/validate.ts";
import { resolve } from "node:path";
import {
  readFile,
  writeFile,
  editFile,
  createFile,
  createDirectory,
  deleteFile,
  listRecycledFiles,
  restoreFile,
  probeFile,
  readFileBytes,
  imageMediaType,
  type FileReadResult,
} from "../filesystem/editor-bridge.ts";
import { BadRequestError } from "../kernel/errors.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate, effectiveProjectRoot, assertProjectPathOwnership } from "../filesystem/fs-gate.ts";
import { MAX_FILE_CONTENT_LENGTH } from "../../shared/constants.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

/**
 * The bound on an image this route will hand back inline.
 *
 * It is deliberately SMALLER than the text read cap: a data URL is base64, so
 * the JSON body is ~4/3 of the file, and the whole thing is held in memory on
 * both sides. 4 MiB covers every screenshot and diagram in a source tree; past
 * it the surface states the size and does not pretend it could show it.
 */
const MEDIA_MAX_BYTES = 4 * 1024 * 1024;

const WRITE_SCHEMA = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(MAX_FILE_CONTENT_LENGTH),
  root: z.string().min(1).max(4096).optional(),
});

const EDIT_SCHEMA = z.strictObject({
  path: z.string().min(1).max(4096),
  oldContent: z.string().max(MAX_FILE_CONTENT_LENGTH),
  newContent: z.string().max(MAX_FILE_CONTENT_LENGTH),
  root: z.string().min(1).max(4096).optional(),
});

// create file (empty or with content), create folder, delete.
const CREATE_FILE_SCHEMA = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(MAX_FILE_CONTENT_LENGTH).optional(),
  root: z.string().min(1).max(4096).optional(),
});

const CREATE_DIR_SCHEMA = z.strictObject({
  path: z.string().min(1).max(4096),
  root: z.string().min(1).max(4096).optional(),
});

const DELETE_SCHEMA = z.strictObject({
  path: z.string().min(1).max(4096),
  root: z.string().min(1).max(4096).optional(),
});

const RESTORE_SCHEMA = z.strictObject({
  id: z.string().uuid(),
});

export function registerEditorRoutes(router: Router, db: AsyncDbClient): void {
  // the FsGate is constructed from the authenticated user + the
  // ownership decision this request resolved on the read pool, and passed to
  // the bridge. The bridge enforces project-ownership
  // (assertProjectPathOwnership) + path-traversal (resolveWithinProject) at
  // the choke point — the route no longer calls the per-route project-path
  // gate; the gate is in the bridge, the lowest level.
  //
  // The root each route primes is `effectiveProjectRoot(root)`, NOT the raw
  // `root`, because that is the string the bridge's `resolveAndCheckGate`
  // gates against when the caller omits a root. Both sides derive it from the
  // one owner in fs-gate.ts, so a request cannot prime one path and be asked
  // about another.
  /**
   * READ — the ONE door onto "what is at this path", in three
   * representations chosen by `what`:
   *
   *   text   (default) the file's content, as the editor edits it;
   *   probe            metadata ONLY — size, whether the bytes are text,
   *                    the declared image type — read from a bounded 8KB
   *                    head so nothing has to be decoded to answer;
   *   media            an image's real bytes, as a data URL.
   *
   * ONE ROUTE, NOT THREE. Each of these is the same question about the same
   * path under the same gate, and a new capability in this system is a BLOCK
   * (server/blocks/) rather than another hand-written route — so the two new
   * representations extend the door that already exists instead of opening
   * two more beside it. `what` defaults to `text`, so every existing caller
   * is unchanged.
   *
   * WHY `probe` EXISTS AT ALL. Without it a viewer has to READ a file to find
   * out whether it should have, which produces the two dishonest states this
   * editor must not have: a binary file decoded as UTF-8 and painted as
   * mojibake, and a 40MB file pulled into memory to discover it was too big
   * to show. The probe answers first, so the surface can state the size and
   * ask before it loads anything.
   */
  router.get("/api/editor/read", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const filePath = ctx.query.get("path");
    const root = ctx.query.get("root") ?? undefined;
    const what = ctx.query.get("what") ?? "text";
    const gate = await makeFsGate(user.userId, db, effectiveProjectRoot(root));
    if (filePath === null || filePath.length === 0) {
      throw new BadRequestError("File path is required", "missing_path");
    }
    if (filePath.includes("\0")) {
      throw new BadRequestError("Path contains invalid characters", "invalid_path");
    }

    if (what === "probe") {
      // Metadata only — no file content — so this answer goes through the
      // REDACTING egress like every other non-content response.
      sendJson(ctx.res, probeFile(filePath, root, gate));
      return;
    }

    if (what === "media") {
      // The media type is DECLARED from the file's own extension against the
      // bridge's closed allowlist — never sniffed from the content — so a
      // file cannot talk this route into serving it as something it is not.
      const mediaType = imageMediaType(filePath);
      if (mediaType === null) {
        throw new BadRequestError("This file is not an image this server can show.", "not_an_image");
      }
      // The bytes come back as a data URL inside the body rather than as a
      // raw response: the caller renders it with a plain image element, which
      // needs no second auth path and no second content type. The bound is
      // checked against the STAT before the read, so an oversized image is
      // refused rather than loaded to find out.
      const { abs, bytes, size } = readFileBytes(filePath, MEDIA_MAX_BYTES, root, gate);
      sendJsonRaw(ctx.res, {
        path: abs,
        mediaType,
        size,
        dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
      });
      return;
    }

    if (what !== "text") {
      throw new BadRequestError(
        `Unknown representation "${what}" — ask for text, probe or media.`,
        "invalid_query",
      );
    }

    const result: FileReadResult = readFile(filePath, root, gate);
    // The editor read route returns USER-OWNED file content verbatim — the
    // user opened the file to view/edit it, so the content must NOT be
    // redacted (redacting would mask their secrets AND corrupt the file on
    // save when the [REDACTED:...] marker is written back). This is the
    // explicit `sendJsonRaw` opt-out from the `sendJson` egress choke point;
    // a prevention test verifies this call site is a genuine file-content
    // route (it calls `readFile`) so a route that merely forgets to redact
    // cannot use `sendJsonRaw` to bypass the choke point.
    sendJsonRaw(ctx.res, result);
  });

  router.put("/api/editor/write", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const body = assertValidBody(WRITE_SCHEMA, ctx.body, "invalid_write_body");
    const gate = await makeFsGate(user.userId, db, effectiveProjectRoot(body.root));
    const result = writeFile(body.path, body.content, body.root, gate);
    sendJson(ctx.res, result);
  });

  router.put("/api/editor/edit", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const body = assertValidBody(EDIT_SCHEMA, ctx.body, "invalid_edit_body");
    const gate = await makeFsGate(user.userId, db, effectiveProjectRoot(body.root));
    const result = editFile(body.path, body.oldContent, body.newContent, body.root, gate);
    sendJson(ctx.res, result);
  });

  // create a new file (empty or with optional content). Rejects if a
  // file/folder already exists at the path (409) so "add file" never silently
  // overwrites an existing file.
  router.post("/api/editor/create-file", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const body = assertValidBody(CREATE_FILE_SCHEMA, ctx.body, "invalid_create_body");
    const gate = await makeFsGate(user.userId, db, effectiveProjectRoot(body.root));
    const result = createFile(body.path, body.content ?? "", body.root, gate);
    sendJson(ctx.res, result);
  });

  // create a new folder (mkdir). Non-recursive — the parent must
  // exist (the file tree creates folders under a selected directory).
  router.post("/api/editor/create-folder", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const body = assertValidBody(CREATE_DIR_SCHEMA, ctx.body, "invalid_create_dir_body");
    const gate = await makeFsGate(user.userId, db, effectiveProjectRoot(body.root));
    const result = createDirectory(body.path, body.root, gate);
    sendJson(ctx.res, result);
  });

  // delete a file or folder (recursive). Explicit file-tab action
  // Confined to
  // the project root (traversal guard).
  router.delete("/api/editor/delete", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const body = assertValidBody(DELETE_SCHEMA, ctx.body, "invalid_delete_body");
    const gate = await makeFsGate(user.userId, db, effectiveProjectRoot(body.root));
    const result = deleteFile(body.path, body.root, gate);
    sendJson(ctx.res, result);
  });

  router.get("/api/editor/recycle", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const requestedRoot = ctx.query.get("root") ?? undefined;
    if (requestedRoot !== undefined) {
      if (requestedRoot.includes("\0")) {
        throw new BadRequestError("Path contains invalid characters", "invalid_path");
      }
      // The fleet-wide `?root=` contract: an unowned root is a 403 answered
      // by the one gate every sibling route primes — never a quiet 200 that
      // answers as though somebody else's tree had not been named.
      const requestedGate = await makeFsGate(user.userId, db, effectiveProjectRoot(requestedRoot));
      assertProjectPathOwnership(effectiveProjectRoot(requestedRoot), requestedGate);
    }
    const [live, trash] = await Promise.all([db.listProjects(user.userId), db.listTrash(user.userId)]);
    const roots = new Set(
      [...live, ...trash.projects].map((p) => resolve(p.path)),
    );
    const files = listRecycledFiles().filter((f) => roots.has(resolve(f.projectRoot)));
    sendJson(ctx.res, { files });
  });

  router.post("/api/editor/restore", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const body = assertValidBody(RESTORE_SCHEMA, ctx.body, "invalid_restore_body");
    const listed = listRecycledFiles().find((f) => f.id === body.id);
    if (listed === undefined) {
      throw new BadRequestError("That recycle entry is gone", "recycle_not_found");
    }
    const gate = await makeFsGate(user.userId, db, listed.projectRoot);
    const result = restoreFile(body.id, gate);
    sendJson(ctx.res, result);
  });
}
