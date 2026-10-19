/**
 * Memory route — searches and retrieves from the real harness memory store
 * with rich provenance.
 *
 * Routes:
 * POST /api/memory/search — memory search (text/source/toolName/chatId/
 * tier/tags/time)
 * GET /api/memory — list entries (?tier=)
 * GET /api/memory/:id — retrieve a single memory entry
 * GET /api/memory/count — entry count
 * POST /api/memory — store a memory entry with provenance
 *
 * Memory is per-USER (v12): the SERVER-RESOLVED authenticated user id scopes
 * list/search/get/store so User B never sees User A's memories. The prior
 * design accepted a caller-supplied session id (a cross-user leak — a
 * caller could pass any id and read another's memories); that is GONE. The
 * user is resolved from the session cookie via requireUserContext and
 * threads through every bridge call. Each entry carries full provenance
 * (source, toolName, originalRequest, chatId, how, userId). The content
 * is encrypted at rest (server/db-crypto.ts, same key as web.db).
 */

import { z } from "zod";

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { assertValidBody } from "../router/validate.ts";
import {
  searchMemory,
  getMemoryEntry,
  listMemoryEntries,
  memoryCount,
  storeProvenance,
  MEMORY_SOURCES,
} from "../context/memory-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { NotFoundError } from "../kernel/errors.ts";
import { MEMORY_TIERS } from "../kernel/canonical.ts";
import { MAX_PATH_LENGTH, MAX_PROMPT_LENGTH } from "../../shared/constants.ts";
import { getMemorySearchMaxLimit } from "../kernel/harness-config.ts";

/**
 * The tier vocabulary, DERIVED from the harness memory owner rather than
 * restated. The three strings appeared twice here as hand-written enums; a
 * tier added upstream would have been accepted by the store and rejected by
 * these schemas.
 */
const TIER_ENUM = z.enum(MEMORY_TIERS);

/**
 * The `?tier=` query param. Deny-by-default: an unrecognised tier is a 400,
 * not a silent widening. `GET /api/memory?tier=nonsense` used to fall through
 * the bridge's if/else chain to `all()` and return EVERY tier — a response
 * that answered a different question than the one asked, with nothing to
 * signal it. `invalid_tier` follows the `invalid_*` naming convention, so
 * `resolveStatus` maps it to 400 without a new CODE_STATUS_MAP entry.
 */
const MEMORY_TIER_QUERY_SCHEMA = z.object({ tier: TIER_ENUM.optional() });

const MEMORY_SEARCH_SCHEMA = z.strictObject({
  text: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  source: z.enum(["tool", "conversation", "llm", "user"]).optional(),
  toolName: z.string().min(1).max(256).optional(),
  chatId: z.string().min(1).max(256).optional(),
  tier: TIER_ENUM.optional(),
  tags: z.array(z.string().min(1).max(128)).max(64).optional(),
  fromTime: z.string().min(1).optional(),
  toTime: z.string().min(1).optional(),
  limit: z.number().int().positive().max(getMemorySearchMaxLimit()).optional(),
});

const MEMORY_STORE_SCHEMA = z.strictObject({
  content: z.string().min(1).max(MAX_PROMPT_LENGTH),
  source: z.enum(["tool", "conversation", "llm", "user"]),
  toolName: z.string().min(1).max(256).optional(),
  originalRequest: z.string().min(1).max(4096).optional(),
  chatId: z.string().min(1).max(256).optional(),
  how: z.enum(["automatic", "manual"]).optional(),
  tier: TIER_ENUM.optional(),
});

export function registerMemoryRoutes(router: Router, db: AsyncDbClient): void {
  router.post("/api/memory/search", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const query = assertValidBody(MEMORY_SEARCH_SCHEMA, ctx.body, "invalid_memory_search");
    const results = searchMemory(query, user.userId);
    sendJson(ctx.res, { results, count: results.length, sources: MEMORY_SOURCES });
  });

  router.post("/api/memory", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const input = assertValidBody(MEMORY_STORE_SCHEMA, ctx.body, "invalid_memory_store");
    const id = storeProvenance(
      input.content,
      {
        source: input.source,
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.originalRequest !== undefined ? { originalRequest: input.originalRequest } : {}),
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        how: input.how ?? "automatic",
        userId: user.userId,
      },
      input.tier ?? "short-term",
    );
    sendJson(ctx.res, { id }, 201);
  });

  router.get("/api/memory", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const raw = ctx.query.get("tier");
    const { tier } = assertValidBody(
      MEMORY_TIER_QUERY_SCHEMA,
      raw === null ? {} : { tier: raw },
      "invalid_tier",
    );
    const entries = listMemoryEntries(tier, user.userId);
    sendJson(ctx.res, { entries, count: entries.length, sources: MEMORY_SOURCES });
  });

  router.get("/api/memory/count", async (ctx) => {
    // v12: scoped to the authenticated user — User B's count never reflects A.
    const user = await requireUserContext(ctx, db);
    sendJson(ctx.res, { count: memoryCount(user.userId) });
  });

  router.get("/api/memory/:id", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const id = ctx.params["id"]!;
    const entry = getMemoryEntry(id, user.userId);
    if (entry === null) {
      throw new NotFoundError(`Memory entry ${id} not found`);
    }
    sendJson(ctx.res, entry);
  });
}
