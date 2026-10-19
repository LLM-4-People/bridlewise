/**
 * Auth state — multi-user dashboard login/session (v12; authentication).
 *
 * PURE STORE (SPO): this module owns the `authState` atom + the
 * `AuthStatus` shape ONLY. ALL HTTP calls (checkAuthStatus, submitRegister,
 * submitLogin, submitLogout, submitChangePassword) live in `src/client.ts`
 * the SINGLE fetch owner. Components and stores MUST NOT call fetch
 * directly; they go through `src/client.ts`. This file is a pure state
 * owner (no I/O, no fetch) so a future gate (e.g. a CSRF header, an auth-
 * token rotation) cannot be bypassed by reaching into the store module.
 *
 * The boot probes read `authState` to decide whether to show the
 * registration surface or the cockpit. On boot, Cockpit.svelte calls
 * `checkAuthStatus` (from client.ts) which writes the resolved status
 * into `authState` here; when not authenticated, the boot surface renders
 * the registration gate.
 *
 * v12: multi-user. `setupRequired` now means NO users are registered yet
 * (the frontend shows the register form to create the first admin). Login
 * takes a username + password. The backend `/api/auth/status` endpoint is
 * the canonical source (it also returns the logged-in username + admin flag).
 *
 * `offline` is set by the client (network error during the auth check) so
 * App.svelte can render a dedicated offline screen instead of a misleading
 * login form the user can never complete.
 *
 * @global-store user auth session state (not chat-scoped; resetting on chat switch would log the user out)
 */
import { atom } from "nanostores";

import { registerReset } from "./store-registry";

export type AuthStatus = Readonly<{
  /** True when no users are registered yet (show the register form). */
  readonly setupRequired: boolean;
  /** True when the current session cookie is valid (show the main app). */
  readonly authenticated: boolean;
  /** The logged-in username (empty string when not authenticated). */
  readonly username: string;
  /** Whether the logged-in user is the admin. */
  readonly isAdmin: boolean;
  /** True while a login/register request is in flight (disable the form). */
  readonly loading: boolean;
  /** A login/register error message (empty string when none). */
  readonly error: string;
  /** True when the server is unreachable (network error on the auth
   * status check — show an offline screen instead of a blank
   * page or a misleading login form the user can never complete). */
  readonly offline: boolean;
}>;

/** Initial auth state — exported so the client (the fetch owner) can reset
 * the store to a pristine state on logout, and so the offline-state
 * spread uses the same baseline as the atom's initial value (no parallel
 * literal that could drift). */
export const initialAuth: AuthStatus = {
  setupRequired: false,
  authenticated: false,
  username: "",
  isAdmin: false,
  loading: false,
  error: "",
  offline: false,
};

/** The single auth-state atom. Owned here; mutated ONLY by `src/client.ts`
 * (the fetch owner). Components read via `$authState` (Svelte auto-sub) —
 * they never call `authState.set` directly. */
export const authState = atom<AuthStatus>(initialAuth);

/**
 * Reset the auth store to its pristine initial value. Called by the
 * single store-reset owner (`resetAllStores` in `state/reset-all.ts`) so
 * logout clears the auth state through the SAME canonical path as every
 * other store — not a one-off `authState.set(initialAuth)` in the logout
 * handler (SPO: one reset pattern for all stores, no ad-hoc resets).
 * `src/client.ts::submitLogout` calls `resetAllStores` (which calls this).
 */
export function resetAuth(): void {
  authState.set(initialAuth);
}

// Self-register into the store-reset registry (SPO"Relieve
// Responsibilities": the store registers its own reset fn; `resetAllStores`
// iterates the registry dynamically; adding a store = automatically covered
// by logout reset, no manual list to remember).
registerReset("auth", resetAuth);
