---
layout: default
title: 'Workflow Notes — Multi-user (v12) — for future agents'
---

# Workflow Notes — Multi-user (v12) — for future agents

Reference this file when starting work that touches auth, DB scoping, or any
user-data route. Captures the gotchas discovered this round.

## The single source of truth for the authenticated user
- `server/user-context.ts` is the ONLY resolver: `resolveAuthUser(req, db)`
  (returns `{userId, username, isAdmin} | null`, cached per-request via a
  WeakMap) + `requireUserContext(ctx, db)` (the per-route gate — throws
  AuthError 401 if null). The auth middleware in `server/index.ts` calls
  `resolveAuthUser` for the 401 gate; routes call `requireUserContext` for
  the typed userId. ONE lookup per request (the cache).
- The scoping key is `user_id` (NOT the legacy anonymous `session_id`). The
  `harness_session` cookie + `resolveSessionId` remain ONLY for rate-limit
  keying + CSRF (NOT data scoping).
- When adding a NEW user-data route: call `requireUserContext(ctx, db)`
  FIRST, then scope EVERY DB call by `user.userId`. No exceptions. The
  isolation tests (`tests/unit/multi-user-isolation.test.ts`) are the
  contract — extend them for the new route.

## DB layer rules
- Every user-data table has a `user_id` column. Every query that reads/writes
  user data filters by `user_id`. `db.getProject(id)` is UNSCOPED (internal
  only — ownership checks, cascade helpers); routes MUST use
  `getProjectForUser(id, userId)`.
- `db.createProject(input, userId)` REQUIRES a non-empty userId (throws
  `ValidationError("invalid_user_id")` otherwise) — `node:sqlite` throws a
  cryptic error on `undefined` bindings; the guard gives a clear one.
- Chats/messages/tool_calls/metrics/timeline/auto-checks are transitively
  scoped via project ownership (`projectBelongsToUser`). The chat route's
  `checkChatUser` + the auto-checks/timeline routes' ownership checks are
  the gates. Reuse them; do NOT add a parallel scoping path.

## Migration gotchas (v12)
- The prefs tables (`user_model_prefs`, `user_prompt_prefs`) were REBUILT
  to drop `session_id` + add `user_id NOT NULL UNIQUE`. The rebuild DEDUPS
  legacy rows (keeps the latest per key) — multiple legacy sessions mapping
  to one admin would otherwise violate UNIQUE(user_id). Any future
  table-rebuild migration that backfills to a single owner MUST dedup.
- `projects.session_id` + `auth_sessions.session_id` are kept (inert). Do
  NOT add queries that filter by them.
- The admin seed: `HARNESS_WEB_AUTH_PASSWORD` + `HARNESS_WEB_AUTH_USERNAME`
  (default "admin") seed the first admin on a fresh DB. The dev password is
  `harness-test-2026` (AGENTS.md).

## Anti-patterns to avoid
- Do NOT accept a client-supplied userId/sessionId for scoping (the memory
  route used to — it was a cross-user leak). The userId is ALWAYS
  server-resolved from the session cookie.
- Do NOT add an unscoped `db.getX(id)` call in a route — use the `ForUser`
  variant or verify ownership first.
- Do NOT use nanostores `.set()` on a Svelte 5 `$state` rune (reassign with
  `=`).

## Test harness
- `tests/helpers/multi-user.ts` → `createTestUser(db, username)` returns
  `{userId, cookie}`. SYNC (dummy hash — tests don't verify passwords). Use
  it for any route/DB test that needs an authenticated caller. Route tests
  dispatch via `router.dispatch` directly (no auth middleware) — send the
  `harness_auth` cookie in the `req` helper.
- Tests are NOT typechecked (only `src/` + `server/` are). A `listProjects()`
  no-arg call compiles but crashes at runtime — always pass the userId.
