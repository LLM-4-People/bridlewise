/**
 * Shared WIRE-INPUT zod schemas + derived types — the single source of
 * truth for the request-body shapes the CLIENT sends over the HTTP
 * boundary. NO `@harness/*` imports so the SERVER (NodeNext module
 * resolution, no path aliases) can import this file exactly like the
 * client (mirrors `shared/ui-schema.ts` + `shared/wire-types.ts`).
 *
 * SPO (zod-schema-vs-client-type drift): before  each wire-
 * input type had THREE parallel definitions:
 *  - the ROUTE zod schema (`server/routes/<x>.ts` — `z.strictObject({...})`)
 *    validating the client's request body (the wire contract),
 *  - the DB zod schema (`server/db/schema.ts` — `z.object({...})` with
 *    snake_case field names + extra fields like `project_id` derived
 *    from the URL path; a DIFFERENT shape used by the DB-layer
 *    validation),
 *  - the CLIENT type (`src/state/<x>.ts` — a manual `Readonly<{...}>`
 *    mirror of the route schema).
 * A field added to the route schema without updating the client mirror
 * would silently break the wire (the client would not send the new
 * required field, but the server would reject it; OR the server would
 * add an optional field the client never reads). moves the ROUTE
 * schema (the wire contract) HERE so both the server route + the client
 * derive from the ONE schema. The DB schema stays in `server/db/schema.ts`
 * (it is a different shape — the DB-layer validation — and its types are
 * now suffixed `*DbInput` to avoid the naming collision with these wire
 * types).
 *
 * The DB schemas are intentionally NOT consolidated here: they are a
 * different concern (DB-layer validation with snake_case field names +
 * path-derived fields like `project_id`). The route maps the wire shape
 * (camelCase, no `project_id`) → DB shape (snake_case + `project_id`)
 * before calling the DB client. Consolidating the DB schemas here would
 * couple the wire contract to the DB layout (a layering violation).
 *
 * Adding a new wire-input type: define the zod schema HERE (the single
 * owner), derive the type via `z.infer`, and import it on both sides. The
 * `frontend-contracts-owner` prevention test pins this file as the
 * single owner (Class C — no parallel `export type X =` in `server/` or
 * `src/`; Class D — no `@harness/*` imports; Class G — the client
 * `src/state/*.ts` imports the type from here, no local
 * `export type X = Readonly<{...}>` re-definition).
 *
 * `Readonly<z.infer<...>>` wrapper: the client treats request inputs as
 * immutable (a client-side refinement). The server uses the mutable
 * `z.infer<...>` for its own call-site construction (assignable to the
 * readonly form). Both derive from the SAME schema — one definition.
 */

import { z } from "zod";

import { MAX_PATH_LENGTH } from "./constants.ts";

// ── Project create (POST /api/projects) ──

/**
 * Wire contract for creating a project. Single owner — was mirrored as
 * `server/routes/projects.ts` `PROJECT_CREATE_SCHEMA` (strict) +
 * `server/db/schema.ts` `PROJECT_CREATE_INPUT` (non-strict DB-layer
 * validation — a different concern, now `ProjectCreateDbInput`) +
 * `src/state/projects.ts` `ProjectCreateInput` (manual
 * `Readonly<{...}>`). The DB schema for a project happens to share the
 * same field names (name/path) because the route passes the body through
 * unchanged; the DB schema still validates independently at the DB
 * layer (defense-in-depth).
 */
export const PROJECT_CREATE_SCHEMA = z.strictObject({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
});

/** The client-facing project-create input shape (immutable view of the
 * zod-inferred wire type). */
export type ProjectCreateInput = Readonly<z.infer<typeof PROJECT_CREATE_SCHEMA>>;

// ── Project update (PATCH /api/projects/:id) ──

/**
 * Wire contract for updating a project. Both fields optional, at least one
 * required: `name` renames, `path` RE-LINKS the project to a folder that
 * exists (the way out of a wiped project folder). The path is validated
 * against the same project-path rules as creation (server side, one owner).
 */
export const PROJECT_UPDATE_SCHEMA = z
  .strictObject({
    name: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  })
  .refine((v) => v.name !== undefined || v.path !== undefined, {
    message: "At least one of name or path must be provided",
  });

/** The client-facing project-update input shape. */
export type ProjectUpdateInput = Readonly<z.infer<typeof PROJECT_UPDATE_SCHEMA>>;

// ── Chat create (POST /api/projects/:projectId/chats) ──

/**
 * Wire contract for creating a chat under a project. Single owner — was
 * mirrored as `server/routes/chats.ts` `CHAT_CREATE_SCHEMA` (the nested-
 * resource form the client uses) + `server/db/schema.ts`
 * `CHAT_CREATE_INPUT` (a DIFFERENT shape with `project_id` + snake_case
 * `model_id`; now `ChatCreateDbInput`) + `src/state/chats.ts`
 * `ChatCreateInput` (manual `Readonly<{...}>`).
 *
 * The `projectId` is in the URL path (not the body); the route injects it
 * before calling the DB client. The flat compat form
 * (`CHAT_CREATE_FLAT_SCHEMA` with `projectId` in the body) stays local to
 * the route — it is a server-internal compat surface, not a client
 * contract.
 */
export const CHAT_CREATE_SCHEMA = z.strictObject({
  title: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256).optional(),
});

/** The client-facing chat-create input shape. */
export type ChatCreateInput = Readonly<z.infer<typeof CHAT_CREATE_SCHEMA>>;

// ── Auto-check create (POST /api/projects/:id/auto-checks) ──

/**
 * Wire contract for running/registering an auto-check under a project.
 * Single owner — was mirrored as `server/routes/auto-checks.ts`
 * `AUTO_CHECK_CREATE_SCHEMA` + `server/db/schema.ts`
 * `AUTO_CHECK_CREATE_INPUT` (a DIFFERENT shape with `project_id` +
 * snake_case `chat_id`/`check_name` + REQUIRED `status`/`output`; now
 * `AutoCheckDbInput`) + `src/state/auto-checks.ts`
 * `AutoCheckCreateInput` (manual `Readonly<{...}>`).
 *
 * The route defaults `status` to `"running"` + `output` to `{}` when the
 * client omits them (the DB schema requires them). The `projectId` is in
 * the URL path; the `chatId` is optional in the body.
 */
export const AUTO_CHECK_CREATE_SCHEMA = z.strictObject({
  checkName: z.string().min(1).max(256),
  status: z.enum(["running", "passed", "failed", "warning"]).optional(),
  output: z.unknown().optional(),
  chatId: z.string().min(1).optional(),
});

/** The client-facing auto-check-create input shape. */
export type AutoCheckCreateInput = Readonly<z.infer<typeof AUTO_CHECK_CREATE_SCHEMA>>;
