# Auth domain

The auth domain owns who the caller is and what they may do: passwords,
sessions, CSRF protection, and the per-request user context that scopes every
database read. Routes do not authenticate themselves — they call the one gate.

## What each file does

- `auth.ts` — password hashing (scrypt) and the session-cookie operations, the
  single owner so the algorithm and cookie shape are decided once.
- `session.ts` — session creation, rotation, and scoping.
- `csrf.ts` — the CSRF guard that protects session-cookie routes from
  cross-site request forgery.
- `user-context.ts` — the `requireUserContext` / `requireAdminContext` gate.
  Every authenticated route resolves the user through here; the result scopes
  the database so a route never sees another user's rows.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/auth/`.

- `auth.ts` is consumed by `server/auth/user-context.ts`, `server/router/router.ts`, `server/routes/auth.ts`.
- `csrf.ts` is consumed by `server/router/router.ts`.
- `session.ts` is consumed by `server/auth/user-context.ts`, `server/router/router.ts`.
- `user-context.ts` is consumed by `server/blocks/anatomy.ts`, `server/blocks/arm.ts`, `server/blocks/breaker.ts`, `server/blocks/checks.ts`, `server/blocks/client-telemetry.ts`, `server/blocks/compose.ts` and 38 more.

<!-- /consumers:generated -->
