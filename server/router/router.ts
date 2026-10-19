/**
 * Thin HTTP router — method + path pattern matching with path params.
 *
 * No dependencies. Supports GET, POST, PUT, DELETE, and SSE (GET with
 * upgrade to text/event-stream). Path params use:param syntax.
 *
 * Pattern: router.get("/api/projects/:id", handler)
 * Handler receives { params, query, body, res }.
 *
 * Single-Party-Owner (route registry): the router OWNS the
 * cross-cutting middleware concerns so each route file defines ONLY its
 * handler logic:
 * AUTH middleware (applied to all non-public routes; the public-path
 * set is supplied by the route registry via `isPublicPath`).
 * CSRF guard (applied to all unsafe methods).
 * RATE LIMITING (token bucket per session; mutating methods only).
 * ERROR MAPPING (exception → HTTP status + body; the single owner of
 * the status/code contract — route files throw typed errors, the
 * router maps them).
 * INPUT VALIDATION / BODY PARSING (JSON body with a byte cap; zod
 * schema validation is done in each route via assertValidBody, but the
 * body READ + size limit + JSON parse + 413/400 mapping is here).
 * A route file that needs custom middleware registers it WITH the route in
 * the registry, not inline as a separate concern.
 */

import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";

import { serverConfig } from "../kernel/config.ts";
import { refreshSettingsSnapshot } from "../kernel/harness-config.ts";
import { resolveSessionId } from "../auth/session.ts";

import {
  withRecordingContext,
  amendRecordingContext,
  generateId,
  recordEffectAsync,
  type RecordingActor,
  guarded,
} from "../kernel/canonical.ts";
import { webWarn } from "../observability/debug-bridge.ts";
// SPO: the REST JSON egress choke point (`sendJson`) redacts PII HERE, at
// the lowest level, by reusing the single redaction owner
// (server/redaction.ts — NOT a rebuild). This mirrors the SSE `send`
// choke point (server/sse.ts), so EVERY egress path to the browser —
// live SSE events AND REST JSON responses — redacts at the single point
// all content converges through. No route can bypass it: a route that
// forgets an upstream redaction (or returns a payload with a secret in a
// field the view mappers do not cover, e.g. the config snapshot, MCP
// server config, or a project/chat title) is still caught here. The
// redaction is idempotent (`[REDACTED:...]` does not match the credential
// regex), so a payload already redacted upstream (the view mappers, the
// config key-based redaction) is a fast no-op here. Variable/const/env
// names + structure are preserved so the UI renders correctly.
import { redactForUserDisplay, redactStringValues } from "../llm/redaction.ts";
import { noteLastResortResponse } from "./egress-failures.ts";
import {
  AuthError,
  BadRequestError,
  ServiceUnavailableError,
  statusForCode,
  BodySizeLimitError,
  BodyParseError,
  RateLimitError,
  ForbiddenError,
  NotFoundError,
} from "../kernel/errors.ts";
import { ZodError } from "zod";
import { CONTENT_TYPE_JSON, TRACE_ID_HEADER } from "../../shared/constants.ts";
import { resolveAuthUser, readAuthCookie } from "../auth/user-context.ts";
import { hashSessionToken } from "../auth/auth.ts";
import { checkCsrf } from "../auth/csrf.ts";
import { checkRateLimit, rateLimitRetryAfterSeconds } from "./rate-limiter.ts";
import { webHandleError } from "../observability/debug-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

/**
 * The error response written when the error itself cannot be mapped or
 * redacted: a plain 503 of fixed bytes (the shared `service_unavailable`
 * code, whose sentence the client already carries).
 */
const LAST_RESORT_ERROR = new ServiceUnavailableError("The server could not prepare a safe description of this error.");
const LAST_RESORT_ERROR_STATUS = LAST_RESORT_ERROR.statusCode;
const LAST_RESORT_ERROR_BODY = JSON.stringify({ error: LAST_RESORT_ERROR.code, message: LAST_RESORT_ERROR.message });

/**
 * The request's URL. An unparsable one — a `Host` header that is not a host
 * (`127.0.0.1:abc`), a target the WHATWG parser refuses — is the client's
 * malformed request: a typed 400, never an escape.
 */
function requestUrl(req: IncomingMessage): URL {
  const parsed = URL.parse(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (parsed === null) throw new BadRequestError("The request's address could not be parsed (check the Host header and the path).", "request_host_invalid");
  return parsed;
}

/** One route parameter, percent-decoded; a malformed escape (`%E0%A4%A`) is a typed 400, never a URIError. */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // decodeURIComponent's only failure is a malformed escape: that IS the answer.
    throw new BadRequestError("The request path holds a malformed percent-escape.", "request_path_malformed");
  }
}

// Re-export the body errors so the router test (`tests/unit/router.test.ts`)
// can still `import { BodySizeLimitError, BodyParseError } from "./"`.
// The CANONICAL home is `errors.ts` (Single-Party-Owner the entire
// error hierarchy lives in ONE owner module). This re-export is a
// compatibility seam, not a second definition.
export { BodySizeLimitError, BodyParseError };

export type RouteParams = Record<string, string>;

// ── THE MUTATION WARRANT — a GET that executes work is a COMPILE ERROR ──
//
// `GET /api/run/:runId/stream` used to BE the executor. Every byte of a run —
// the prompt assembly, the provider call, the tool dispatch, the ledger
// writes — ran inside a GET handler. Two connections therefore ran the run
// twice: measured at the wire, two POSTs to `/chat/completions` of 38,429
// bytes each, two executions of the same tool call, two assistant rows under
// one run id. RFC 9110 §9.2.1 defines GET as safe, so every intermediary in
// existence — a proxy's `next_upstream`, an SDK retry, a service worker, a
// speculative browser load — is *entitled* to repeat one. A GET that spends
// money is the defect underneath the defect.
//
// A runtime check at that one handler would have fixed that one handler. This
// is the shape instead: work that changes the world demands a value only a
// mutating verb is given.
//
//   - `MUTATION_WARRANT` is a `unique symbol` and is NOT exported, so no
//     module outside this file can name the brand or write the type down.
//   - `router.get` accepts `RouteHandler`, which takes ONE parameter. A
//     handler written `(ctx, warrant) => …` has MORE parameters than the
//     target signature, which TypeScript refuses — so a GET handler cannot
//     even declare a warrant, let alone hold one.
//   - `router.post`/`put`/`patch`/`delete` accept `MutatingRouteHandler` and
//     are HANDED one at dispatch. Existing single-parameter handlers keep
//     compiling: a function may always ignore trailing parameters.
//   - `startRunExecution(warrant, …)` demands one. From a GET handler there
//     is no such value in scope, so calling it does not typecheck.
//
// ── EXACTLY WHAT THE COMPILER REFUSES, MEASURED, NOT ASSUMED ───────────────
//
// "A GET that executes does not compile" was too strong a sentence for what
// the type system actually does, and the difference is where the runtime
// backstop earns its place. Ten ways of reaching the executor from a GET were
// planted and built on both installed toolchains (tsc 7.0.2 and 5.9.3, which
// agree on every verdict below and disagree only about the exit CODE).
//
//   REFUSED AT COMPILE TIME — 4 of 10:
//     a GET handler declaring `(ctx, warrant)`        TS2345 + TS7006 (arity)
//     a GET calling the executor with nothing in scope           TS2304
//     `const forged: MutationWarrant = {}`                       TS2741
//     a `MutatingRouteHandler` value mounted on `get`            TS2345
//
//   COMPILES — 6 of 10, and each is refused at RUNTIME by the registry below:
//     `{} as MutationWarrant`, `{} as unknown as MutationWarrant`,
//     `null as any`, `@ts-ignore` on the arity error, and a namespace
//     re-export — all forged, none minted, all `ForbiddenError`.
//     The tenth was a GENUINE warrant stashed by an earlier POST, which
//     compiled AND executed. That one was not a forgery, so no forgery check
//     could see it; it is closed by revocation (see `mintedWarrants`).
//
// So the honest statement is: the type system makes the ORDINARY mistake
// impossible — you cannot write a GET that takes a warrant, and you cannot
// call the executor without one — and every remaining route is a deliberate
// cast, which the runtime registry refuses. Neither half is decorative, and
// claiming the first covers everything is how the sixth case survived.
//
// The registry below is that runtime half. A forged object was never minted;
// a real one is revoked when its request ends and when it is spent. The set
// is private to this module and warrants are minted only inside `dispatch`,
// which is the single place that knows the request's verb.
declare const MUTATION_WARRANT: unique symbol;

/**
 * Proof that the caller is running under a request whose method is allowed to
 * change the world. Obtainable only as the second argument of a
 * `MutatingRouteHandler`; unforgeable in practice because the brand is a
 * `unique symbol` this module does not export and the value is checked
 * against a module-private registry.
 */
export type MutationWarrant = { readonly [MUTATION_WARRANT]: true };

/**
 * The warrants that are VALID RIGHT NOW.
 *
 * ── THE CLAIM THIS SET USED TO MAKE, AND WHY IT WAS FALSE ──────────────────
 *
 * It was a `WeakSet`, described as revoking a warrant "with the request that
 * carried it". A `WeakSet` revokes nothing. It permits an UNREACHABLE key to
 * be collected; it has no opinion whatever about a reachable one. Driven: a
 * genuine warrant minted by a real POST, stored in a module-level variable,
 * survived three later requests and a forced `global.gc()` and was still
 * ACCEPTED — and a `router.get` handler holding that variable executed a
 * complete run, a shape that compiles cleanly on both toolchains this project
 * builds with. Not live (no production module stashes one), but the sentence
 * in the source was an argument for a safety that did not exist, which is
 * worse than no argument at all: it is the reason nobody looks again.
 *
 * ── WHAT MAKES IT TRUE ─────────────────────────────────────────────────────
 *
 * Revocation is now explicit and happens twice over, so a stash buys nothing:
 *
 *   - `assertMutationWarrant` DELETES on a successful check, so a warrant
 *     authorises exactly one operation. A copy kept for later is a warrant
 *     that has already been spent.
 *   - `dispatch` revokes in a `finally`, spent or not, so a warrant a handler
 *     kept without using dies when its request ends.
 *
 * Together those are the sentence the old comment only asserted: a warrant
 * does not outlive its verb. The set stays weak so that a value dropped
 * without either path running — a dispatch killed outright — is still
 * collectable; weakness is now about memory only, which is the one thing it
 * was ever able to promise.
 */
const mintedWarrants = new WeakSet<object>();

/** Mint a warrant for one mutating dispatch. */
function mintMutationWarrant(): MutationWarrant {
  const warrant = Object.freeze({});
  mintedWarrants.add(warrant);
  return warrant as unknown as MutationWarrant;
}

/**
 * End a warrant's life at the end of its request, whether or not it was used.
 *
 * Idempotent, and deliberately not conditional on anything: a handler that
 * took a warrant and never spent it has no claim on the next request either.
 */
function revokeMutationWarrant(warrant: MutationWarrant): void {
  mintedWarrants.delete(warrant as unknown as object);
}

/**
 * Refuse a warrant this router did not mint, OR has already honoured.
 *
 * The type is the primary gate; this is what remains true after a cast. A
 * caller that manufactures `{} as unknown as MutationWarrant` to reach a
 * mutating operation from a safe method meets a `ForbiddenError` here rather
 * than a provider bill — and so does a caller replaying a real warrant it
 * kept from an earlier request, because a successful check spends it.
 */
export function assertMutationWarrant(warrant: MutationWarrant): void {
  if (
    typeof warrant !== "object" ||
    warrant === null ||
    !mintedWarrants.has(warrant as unknown as object)
  ) {
    throw new ForbiddenError(
      "This operation changes state and can only run under a request method that is allowed to.",
      "mutation_warrant_required",
    );
  }
  // SINGLE USE. Spending it here — rather than only at the end of dispatch —
  // is what makes a stash worthless instead of merely short-lived: the value
  // a handler squirrels away has already been consumed by the operation it
  // was squirrelled away from.
  revokeMutationWarrant(warrant);
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

/**
 * A handler mounted on a state-changing verb. It receives the request context
 * AND a `MutationWarrant`, which is the token that lets it start work a safe
 * method must never start. Handlers that change nothing simply omit the
 * second parameter — a function may always take fewer arguments than it is
 * given.
 */
export type MutatingRouteHandler = (
  ctx: RouteContext,
  warrant: MutationWarrant,
) => void | Promise<void>;

export type RouteContext = {
  readonly params: RouteParams;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly res: ServerResponse;
  readonly req: IncomingMessage;
  readonly sessionId: string;
};

// ── Typed body errors (carry their HTTP status to dispatch) ──
// BodySizeLimitError (413) and BodyParseError (400) are now imported from
// errors.ts (Single-Party-Owner the error hierarchy has ONE
// owner). See the re-export above for the compatibility seam.

type RouteEntry = {
  readonly method: string;
  /** The registered path pattern (e.g. `/api/chats/:id`) — the effect name's
   *  grouping key, so one route's traffic aggregates under one name instead
   *  of one name per concrete URL. */
  readonly path: string;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
  readonly handler: MutatingRouteHandler;
  /** Whether this entry was mounted through a state-changing verb. Only these
   *  are handed a warrant at dispatch — a safe method is never given one,
   *  which is the runtime half of the compile-time door above. */
  readonly mutating: boolean;
};

function compilePattern(path: string): {
  pattern: RegExp;
  paramNames: string[];
} {
  const paramNames: string[] = [];
  // Escape regex metacharacters in the literal path FIRST, then replace
  //:param placeholders with capture groups. Reversing the order would
  // escape the capture-group syntax introduced by the param replacement.
  const regex = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "/([^/]+)";
    });
  return { pattern: new RegExp(`^${regex}$`), paramNames };
}

export type Router = {
  /** Mount a SAFE handler. It is handed no warrant and cannot declare one, so
   *  an operation that demands a warrant is unreachable from here — a
   *  compile error, not a review comment. */
  readonly get: (path: string, handler: RouteHandler) => void;
  readonly post: (path: string, handler: MutatingRouteHandler) => void;
  readonly put: (path: string, handler: MutatingRouteHandler) => void;
  readonly patch: (path: string, handler: MutatingRouteHandler) => void;
  readonly delete: (path: string, handler: MutatingRouteHandler) => void;
  readonly dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

/** Options for `createRouter`. The router owns auth + CSRF + rate-limit +
 * error-mapping; the caller supplies the DB (for auth resolution) and the
 * public-path predicate (owned by the route registry — which routes are
 * exempt from the auth gate). */
export type RouterOptions = {
  /** The async data facade used to resolve auth sessions + count users
   * (setup mode). Both reads cross the facade, so the gate every request
   * passes through no longer runs SQL on the request thread. */
  readonly db: AsyncDbClient;
  /** Whether a request path is public (exempt from the auth gate). Owned by
   * the route registry (`isPublicPath`). */
  readonly isPublicPath: (path: string) => boolean;
};

/**
 * The actor a request is attributed to BEFORE its identity has resolved —
 * and after resolution fails. The request boundary (see `dispatch`) is
 * entered with this the moment the request arrives, so the auth gate's own
 * database reads are attributed as `anonymous` rather than `unattributed`;
 * once the session resolves to a user, `amendRecordingContext` upgrades the
 * actor in place. One owner for the shape, consumed by both the boundary and
 * `resolveRequestActor`'s fallback, so the two can never disagree on what
 * "not yet known" is called.
 */
function anonymousRequestActor(sessionId: string): RecordingActor {
  return { kind: "anonymous", id: sessionId };
}

/**
 * Who is acting on this request.
 *
 * The authenticated user when there is one; `anonymous` otherwise. Never the
 * harness default — attributing a user's action to the harness is exactly the
 * failure that made `actor_kind` a constant across every recorded event.
 *
 * Resolution failures degrade to `anonymous` rather than throwing: recording
 * attribution must never be able to break a request.
 */
async function resolveRequestActor(
  req: IncomingMessage,
  sessionId: string,
  adb: AsyncDbClient,
): Promise<RecordingActor> {
  try {
    const user = await resolveAuthUser(req, adb);
    if (user !== null) {
      return { kind: "user", id: user.userId, role: user.isAdmin ? "admin" : "member" };
    }
  } catch (err) {
    // Attribution must never break a request, so a resolution failure degrades
    // to anonymous — but it IS a real signal (a corrupt session row, a DB
    // hiccup) and is surfaced through the centralized debug bridge rather than
    // vanishing.
    webWarn("router", "actor resolution failed; recording as anonymous", () => ({
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  return anonymousRequestActor(sessionId);
}

export function createRouter(opts: RouterOptions): Router {
  const { db, isPublicPath } = opts;
  const routes: RouteEntry[] = [];

  function add(
    method: string,
    path: string,
    handler: MutatingRouteHandler,
    mutating: boolean,
  ): void {
    const { pattern, paramNames } = compilePattern(path);
    routes.push({ method, path, pattern, paramNames, handler, mutating });
  }

  function statusForError(err: unknown): number {
    // General: any error carrying an explicit numeric `statusCode` (the
    // typed-error contract — AuthError=401, BodySizeLimitError=413,
    // ConflictError=409, ForbiddenError=403, NotFoundError=404,
    // MapNotReadyError/AwarenessNotReadyError=202). Checked first so a
    // typed error's declared status always wins over the class fallbacks.
    if (
      err !== null &&
      typeof err === "object" &&
      "statusCode" in err &&
      typeof (err as { statusCode: unknown }).statusCode === "number" &&
      Number.isFinite((err as { statusCode: number }).statusCode)
    ) {
      return (err as { statusCode: number }).statusCode;
    }
    if (err instanceof BodySizeLimitError) return err.statusCode;
    if (err instanceof BodyParseError) return err.statusCode;
    if (err instanceof AuthError) return err.statusCode;
    // A zod schema-validation failure is a CLIENT error (bad request body),
    // NOT a server error. Previously these mapped to 500 (zod's ZodError has
    // no `.code` property, so it fell through to the default). Mapping it to
    // 400 is the root-cause fix — every route that uses `.parse(ctx.body)`
    // (setup, login, change-password, config, tools, …) now returns a typed
    // 400 `validation_failed` instead of a misleading 500.
    if (err instanceof ZodError) return 400;
    // Single-Party-Owner: typed errors that carry a `code` but no
    // explicit `statusCode` (e.g. the editor/filesystem bridges throw
    // `ValidationError` with codes `path_traversal`, `file_not_found`,
    // `already_exists`) are mapped via the single code→status table owned
    // by errors.ts (`statusForCode`). This lets a route THROW a typed error
    // and let the router map it — instead of each route catching + remapping
    // (the prior `sendError`-helper duplication across 8 route files). A
    // code starting with `invalid_` is always 400 (the input-validation
    // convention); the code map handles the rest.
    if (
      err instanceof Error &&
      "code" in err &&
      typeof (err as Error & { code: string }).code === "string"
    ) {
      const code = (err as Error & { code: string }).code;
      // The input-validation conventions: codes prefixed `invalid_*` (a
      // body that failed a zod/schema check) and `missing_*` (a required
      // query/body param absent) are always 400 client errors.
      if (code.startsWith("invalid_") || code.startsWith("missing_")) return 400;
      const mapped = statusForCode(code);
      if (mapped !== undefined) return mapped;
    }
    return 500;
  }

  function errorBody(err: unknown): unknown {
    if (err instanceof BodySizeLimitError || err instanceof BodyParseError) {
      return { error: err.code, message: err.message };
    }
    if (err instanceof ZodError) {
      // Concise: the first issue's message, PREFIXED with the path that
      // names where it failed. The full `issues` array can be large + leak
      // schema internals; one clear message is enough for the client to fix
      // the request — but a bare "Too small: expected number to be >0"
      // names nothing, and a body with several per-model rows leaves the
      // user guessing which field of which row was refused. The path holds
      // field names and indices only (never values), so it cannot carry
      // what the body carried.
      const first = err.issues[0];
      const path = first !== undefined && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
      return {
        error: "validation_failed",
        message: `${path}${first?.message ?? "Request body failed validation."}`,
      };
    }
    // Single-Party-Owner: the 202 "indexing" body is a CONTRACT
    // the client depends on (`status === "indexing"` — the code-graph poll
    // loop). MapNotReadyError + AwarenessNotReadyError both carry
    // statusCode=202; their body is `{ status: "indexing", message }`, NOT
    // the generic `{ error, message }`. Centralizing this here (instead of
    // the per-route `handleRouteError`/`handleAwarenessError` helpers) means
    // a route that throws the typed error gets the right body for free.
    if (
      err !== null &&
      typeof err === "object" &&
      "statusCode" in err &&
      (err as { statusCode: unknown }).statusCode === 202
    ) {
      const errObj = err as { code?: unknown };
      const code = typeof errObj.code === "string" ? errObj.code : "indexing";
      return { status: "indexing", code, message: err instanceof Error ? err.message : String(err) };
    }
    if (
      err instanceof Error &&
      "code" in err &&
      typeof (err as Error & { code: string }).code === "string"
    ) {
      return {
        error: (err as Error & { code: string }).code,
        message: err.message,
      };
    }
    // Unknown failures are logged at the catch site; the wire gets a fixed
    // message so an arbitrary Error (which may carry a stack or a foreign
    // provider body) cannot become a response. Typed errors above keep their
    // contract and still pass through the egress redactor.
    return { error: "internal_error", message: "Internal error. See the local log for details." };
  }

  /**
   * THE ERROR RESPONSE, THROUGH THE SAME EGRESS AS EVERY OTHER RESPONSE.
   *
   * `sendJson` redacts because it is the one place successful REST bodies
   * converge — and the ERROR bodies converged nowhere. Three catch blocks each
   * wrote `JSON.stringify(errorBody(err))` straight to the socket, so a failure
   * message left this process without ever meeting the redactor while the
   * success path beside it could not avoid it. One refusing door and one
   * admitting door, pointed at the same bytes.
   *
   * That matters most for the messages nobody writes: `errorBody`'s general
   * branch forwards `err.message` verbatim, and the errors most likely to carry
   * a credential are the ones a FOREIGN endpoint composed — a provider that
   * echoes an `Authorization` header into its own 400 body, arriving here as an
   * exception nobody in this repository worded.
   *
   * So all three catch blocks call this, and there is one place left that can
   * write an error body. `redactForUserDisplay` preserves keys, structure and
   * non-secret strings, so the `{ error, message }` and `{ status: "indexing" }`
   * contracts the client depends on survive unchanged.
   */
  function respondWithError(
    res: ServerResponse,
    err: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): void {
    // THE MAPPER CANNOT THROW. Mapping and redacting run BEFORE a byte is
    // written; if either fails, the answer is the last-resort 503 below —
    // fixed bytes, nothing from the error (the redactor could not clean it),
    // counted (`privacy.lastResortResponses`) and logged. Liveness itself is
    // `dispatch`'s one catch; this is the fallback for a mapper failure.
    let status = LAST_RESORT_ERROR_STATUS;
    let body = LAST_RESORT_ERROR_BODY;
    let headers: Record<string, string> = { "Content-Type": CONTENT_TYPE_JSON };
    try {
      const mapped = JSON.stringify(redactForUserDisplay(errorBody(err)));
      status = statusForError(err);
      body = mapped;
      headers = { ...headers, ...extraHeaders };
    } catch (mappingFailure) {
      noteLastResortResponse();
      webHandleError(mappingFailure, { module: "router", operation: "error-response-last-resort" });
    }
    if (!res.headersSent) {
      res.writeHead(status, headers);
      res.write(body);
    }
    if (!res.writableEnded) res.end();
  }

  /**
   * Auth gate (Single-Party-Owner moved from index.ts into the
   * router so the router OWNS auth, not the bootstrap). Protects every
   * non-public API route. THROWS `AuthError` (HTTP 401) when the request
   * is blocked; returns normally (void) when the request may proceed.
   * The router's dispatch catches the thrown `AuthError` + maps it to the
   * 401 response via the centralized error-mapping choke point
   * (`statusForError` + `errorBody`) — Single-Party-Owner (
   * -V9): the gate THROWS instead of writing its own 401, so the router
   * owns ALL error responses (consistent with / routes + guards
   * throw, the router maps).
   *
   * Setup mode = no users registered yet. In setup mode only the public
   * routes (auth + health) are reachable (the frontend shows the register
   * form); every other route throws `AuthError` (`setup_required`). Once
   * at least one user exists, a valid session cookie is required for
   * every non-public route. Reuses the per-request cache in
   * user-context.ts (one DB lookup per request — the route gate's
   * requireUserContext is then free).
   */
  async function authGate(req: IncomingMessage, path: string): Promise<void> {
    if (isPublicPath(path)) return;
    // Setup mode: no users registered → only the register flow is useful.
    if ((await db.countUsers()) === 0) {
      throw new AuthError(
        "No users registered yet. Please register the first admin account.",
        "setup_required",
      );
    }
    // Protected: require a valid session cookie resolving to a real user.
    const user = await resolveAuthUser(req, db);
    if (user !== null) return;
    // No/invalid/expired cookie → clean up an expired session if present.
    const cookie = readAuthCookie(req);
    if (cookie !== null) await db.deleteAuthSession(hashSessionToken(cookie));
    throw new AuthError(
      "Authentication required. Please log in.",
      "unauthorized",
    );
  }

  /**
   * THE REFUSAL LANE — a request the router turned away BEFORE any handler
   * ran still happened, and the http lane must say so.
   *
   * The dispatch wrapper records every MATCHED handler call, but a request
   * refused at a pre-handler gate (the auth gate, the CSRF guard, a
   * malformed body, the rate limiter, no route at all) crossed the same
   * boundary and left nothing — a hole in the network lane exactly where
   * "what did the server refuse, and why" is the question the lane exists
   * to answer. Reusing the `http` kind (no new vocabulary): the event is
   * named by the raw method + path plus the refusal reason, settles
   * `denied` — the outcome registry's gate-block word, a failure verdict
   * through the disposition table — and carries the typed error's code +
   * message as the record's failure detail. The recording context is
   * already entered at the top of dispatch (anonymous until identity
   * resolves), so attribution is ambient: an unauthenticated 401 reads as
   * the anonymous actor, which is the truth.
   *
   * The wrapper's promise RESOLVES by construction (the closure never
   * rejects), so the caller's `respondWithError` flow below is the only
   * error path — the record can never change the refusal's own control
   * flow, and a recording failure costs the record, never the refusal
   * (the wrapper's observer contract).
   */
  function recordHttpRefusal(
    method: string,
    path: string,
    querySearch: string,
    err: unknown,
    reason: string,
  ): void {
    void recordEffectAsync("http", `${method} ${path} [${reason}]`, async () => ({ refused: true }), {
      outcomeOf: () => "denied",
      errorOf: () => ({
        message: err instanceof Error ? err.message : String(err),
        ...(typeof (err as { code?: unknown } | null)?.code === "string"
          ? { code: (err as { code: string }).code }
          : {}),
      }),
      // THE QUERY IS A CLIENT-CONTROLLED STRING — same redaction as the
      // served-request lane, applied before the args value exists.
      argsOf: () => ({
        method,
        path,
        query: redactStringValues(querySearch),
      }),
    });
  }

  /** Serving one request; {@link dispatch} is its one catch. */
  async function serveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";

    // ── TRACE IDENTITY — minted here, at the one boundary every request
    // crosses, and stamped on the response BEFORE anything else runs, so
    // every API response (200, 401, 403, 404, 429, 500) carries the id a
    // client can quote back. Without it, an HTTP request, its run, its LLM
    // calls and its tool calls were correlated only by runId, and only
    // from the first effect span onward — a request that failed before any
    // effect had NO trace at all. The same id enters the recording context
    // below, so every ledger event written under this request inherits it
    // through ambient provenance; nothing downstream passes it by hand.
    // The id format is the canonical generator's (`trace-<uuid>`), the same
    // owner that mints span and event ids — no second id grammar.
    const traceId = generateId("trace");
    res.setHeader(TRACE_ID_HEADER, traceId);
    const sessionId = resolveSessionId(req, res);

    // ── RECORDING BOUNDARY — the WHOLE dispatch, not just the handler ──
    //
    // The boundary is entered the moment the request is identified (trace
    // id minted, session resolved) and wraps EVERYTHING that can happen
    // while serving it: the auth gate, the CSRF guard, rate limiting,
    // routing, body parsing and the handler. Entering only around the
    // handler left the auth gate's own database reads (countUsers,
    // resolveAuthUser, session cleanup) recording as `unattributed` — real
    // rows in the real chain describing nobody, which is precisely the
    // shape the ledger exists to refuse. A request that never reaches a
    // handler (a 401, a 403, a 404) is still attributed: as `anonymous`
    // until its identity resolves, upgraded in place below.
    //
    // The initial actor is the request's anonymous shape (one owner,
    // `anonymousRequestActor`); `amendRecordingContext` upgrades it to the
    // authenticated user the moment `resolveRequestActor` knows one, so
    // pre-auth effects read as `anonymous` and everything after reads as
    // the user — never `unattributed`, never the harness default.
    return withRecordingContext(
      { actor: anonymousRequestActor(sessionId), sessionId, traceId },
      async () => {
        // ── THE REQUEST'S ADDRESS, parsed INSIDE the boundary: a malformed
        // one (a Host that is not a host, a target the parser refuses) is a
        // typed 400 that carries the trace id above AND leaves its refusal
        // row, like every other refusal — the unauthenticated bad-Host probe
        // used to leave neither (wf1b2-design S-4).
        let url: URL;
        try {
          url = requestUrl(req);
        } catch (err) {
          const [rawPath = "/", rawQuery = ""] = (req.url ?? "/").split("?", 2);
          recordHttpRefusal(method, rawPath, rawQuery.length > 0 ? `?${rawQuery}` : "", err, "refused request");
          webHandleError(err, { module: "router", operation: "request-url" });
          respondWithError(res, err);
          return;
        }
        const path = url.pathname;
        // ── THE SETTINGS SNAPSHOT, RE-RESOLVED ONCE PER REQUEST ── the one
        // point every request crosses, so an edited settings file is in
        // force from the next request on; every read below (and every
        // timer) answers from the snapshot, never the file. It never
        // throws: an unreadable file keeps the last good snapshot in force
        // and is reported as the `settings.storeState` signal.
        refreshSettingsSnapshot();
        // ── AUTH + CSRF GATES (Single-Party-Owner the router owns
        // both; both THROW typed errors, the router maps them). ──
        // The auth gate throws `AuthError` (401) and the CSRF guard throws
        // `CsrfError` (403); the router catches BOTH + maps them to the HTTP
        // status + body via the SAME centralized error-mapping choke point
        // (`statusForError` + `errorBody`) used for route-handler errors.
        // Single-Party-Owner (-V8/V9): the gates THROW instead of writing
        // their own 401/403 responses, so the router is the single owner of
        // ALL error responses (consistent with / routes + guards throw,
        // the router maps). Runs BEFORE route matching + body parsing so a
        // 401/403 never wastes a body read (and a 401 is returned for a
        // non-public path even when the path does not match a route). The
        // auth gate runs BEFORE CSRF (so 401 takes precedence over 403).
        try {
          await authGate(req, path);
          checkCsrf(req);
        } catch (err) {
          // The refusal lane: the request crossed the boundary and was
          // turned away — the http lane records the denial, its reason and
          // the typed error's detail before the response is mapped.
          recordHttpRefusal(method, path, url.search, err, "refused auth");
          webHandleError(err, { module: "router", operation: "auth-csrf-gate" });
          respondWithError(res, err);
          return;
        }

        for (const route of routes) {
          if (route.method !== method) continue;
          const match = route.pattern.exec(path);
          if (!match) continue;

          const params: RouteParams = {};
          try {
            for (let i = 0; i < route.paramNames.length; i++) {
              params[route.paramNames[i]!] = decodePathSegment(match[i + 1]!);
            }
          } catch (err) {
            // A malformed percent-escape: the same refusal lane as every
            // other turned-away request (record, trace id, typed 400).
            recordHttpRefusal(method, path, url.search, err, "refused path");
            webHandleError(err, { module: "router", operation: "path-decode" });
            respondWithError(res, err);
            return;
          }

          let body: unknown = undefined;
          // Parse the JSON body for methods that may carry one. POST/PUT/PATCH
          // always carry a body; DELETE MAY carry a body (HTTP spec allows it —
          // the editor delete route sends { path, root }). GET/HEAD never do.
          // An empty body resolves to `undefined` (no-op for routes that ignore
          // ctx.body, e.g. DELETE /api/chats/:id which uses only the path param).
          if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
            try {
              body = await readBody(req, serverConfig.maxBodyBytes);
            } catch (err) {
              recordHttpRefusal(method, path, url.search, err, "refused body");
              webHandleError(err, { module: "router", operation: "body-read" });
              respondWithError(res, err);
              return;
            }
          }

          try {
            // FIX: rate limiting — check before dispatching the handler.
            // Each identity gets `rateLimitPerMinute` requests per minute.
            //
            // (false "Too many requests" when server offline/busy): ALL
            // read-only GET routes are EXEMPT. The rate limiter's purpose
            // is to protect the LLM quota, which is ONLY consumed by
            // mutating routes (run start, tool toggle, project create, …).
            // Read-only GETs never consume LLM quota, so rate-limiting them
            // serves no protective purpose — it only produces false 429s. The
            // boot burst fires ~8 concurrent GETs at once (projects, config,
            // tools, agents, models, memory, …); the prior fix exempted a
            // hardcoded subset of poll routes but MISSED the boot routes, so
            // a fresh boot (or a server restart with a warm client) could
            // exhaust the bucket and surface "Too many requests" — which the
            // user perceived as the server being "offline" (exp519 root
            // cause). Exempting by HTTP method (GET) is the root-cause fix:
            // no hardcoded path list, and it covers
            // every read route including future ones. Only POST/PUT/PATCH/
            // DELETE (mutations that can exhaust the LLM quota) are limited.
            //
            // (rate-limit session-key bypass): the limiter
            // is now keyed by the authenticated userId (or the un-spoofable
            // client IP for unauthenticated public routes like login), NOT the
            // `harness_session` cookie. The cookie was a bypass vector: an
            // attacker who OMITS it got a fresh bucket every request (infinite
            // budget), and ROTATING it reset the limit. The router passes
            // `(req, db)` — the limiter derives the key INTERNALLY (lowest-
            // level enforcement: a route cannot derive a client-controllable
            // key because it never derives the key at all). `sessionId`
            // remains the isolation scope for the handler; it is no longer the
            // rate-limit key.
              const isReadOnly = method === "GET";
              if (!isReadOnly && !(await checkRateLimit(req, db))) {
                // Single-Party-Owner: the rate-limit check THROWS a
                // typed `RateLimitError` (HTTP 429) instead of writing its own
                // 429 response — consistent with the authGate + checkCsrf
                // consolidation (-V8/V9): ALL guards throw, the router owns
                // ALL error responses. The `Retry-After` is derived from the
                // rate-limiter's refill rate (the single timing owner), NOT a
                // hardcoded "60" (which was scattered + wrong — ~1s, not 60s).
                // The catch below maps it + emits the `Retry-After` header.
                const rateLimited = new RateLimitError(
                  "Too many requests. Please slow down.",
                  rateLimitRetryAfterSeconds(),
                  "rate_limited",
                );
                // The refusal lane fires at the THROW SITE, not in the
                // shared dispatch catch — a handler error that reaches
                // that catch has already been recorded by the dispatch
                // wrapper, and recording it twice would double-count one
                // request in the http lane.
                recordHttpRefusal(method, path, url.search, rateLimited, "refused rate-limit");
                throw rateLimited;
              }
            // ACTOR RESOLUTION — and the in-place upgrade of the boundary the
            // request already runs inside. The context was entered at the top
            // of dispatch (anonymous, so the auth gate's reads were attributed
            // too); the moment the session resolves to a user, the boundary's
            // actor becomes that user for everything recorded from here on —
            // the handler's effects, and the actor resolution's own reads
            // above, which recorded as anonymous. `amendRecordingContext` is
            // the canonical merge (correlation ids are kept, only the actor is
            // replaced), so the request keeps its sessionId and traceId.
            const recordingActor = await resolveRequestActor(req, sessionId, opts.db);
            amendRecordingContext({ actor: recordingActor });
            // A warrant is minted ONLY for a state-changing verb, and only here
            // — the one place that knows the request's method. A safe handler is
            // called with the context alone, so there is nothing for it to pass
            // on to an operation that demands one.
            const warrant = route.mutating
              ? mintMutationWarrant()
              : (undefined as unknown as MutationWarrant);
            try {
              // RECORDING CHOKE POINT for the `http` effect kind: the
              // handler call is the one boundary every matched request
              // crosses, so wrapping it here means a served request cannot
              // go by unrecorded. The effect settles when the handler
              // settles, so `durationMs` (and the resource deltas beside
              // it) is the real cost of serving the request — including an
              // SSE stream's whole lifetime, which is honest: the request
              // WAS being served for that long. The ambient boundary itself
              // was entered at the top of dispatch, so this span — and the
              // handler inside it — sits INSIDE that context with the
              // resolved actor.
              //
              // OUTCOME FROM THE STATUS CLASS, not from return-vs-throw
              // alone: a handler signals failure by WRITING a 5xx response
              // (through the router's own error mapping), which the
              // wrapper cannot see as a throw. `res.statusCode` after the
              // handler settles is the status the client actually got, so
              // that is what classifies: 5xx = the server failed this
              // request; 2xx/3xx/4xx = the server did its job (a 4xx is
              // the client's error to fix, not a server fault). A handler
              // that THROWS records failed through the throw path with the
              // real error — the same error `statusForError` maps to the
              // response status one frame out, so the ledger's outcome and
              // the client's status can never disagree.
              await recordEffectAsync(
                "http",
                `${method} ${route.path}`,
                async () => {
                  await route.handler(
                    { params, query: url.searchParams, body, res, req, sessionId },
                    warrant,
                  );
                  return res.statusCode;
                },
                {
                  failedWhen: (status) => status >= 500,
                  // THE THROW PATH IS CLASSED BY THE SAME STATUS CLASS. A
                  // handler that THROWS has its error mapped by
                  // `statusForError` one frame out — that mapping is the
                  // status the client actually gets, so it is also what
                  // classifies the ledger's outcome: a thrown 4xx (a typed
                  // validation or auth refusal) is the client's error to
                  // fix, exactly like a handler WRITING that status, and
                  // the two must not record opposite outcomes. The thrown
                  // error still travels as the record's detail, so the
                  // refusal keeps its message beside its agreed class.
                  failedWhenError: (err) => statusForError(err) >= 500,
                  errorOf: (status) => ({
                    message: `the handler answered HTTP ${status}`,
                    code: "http_server_error",
                  }),
                  argsOf: () => ({
                    method,
                    path,
                    // THE QUERY IS A CLIENT-CONTROLLED STRING, AND CLIENTS
                    // PUT CREDENTIALS IN QUERIES (`?token=…`, `?api_key=…`).
                    // It is redacted through the single redaction owner —
                    // the same `redactStringValues` walk the tool lane's
                    // args getter uses — BEFORE the args value exists, so
                    // the ledger's bytes never hold it. The walk masks
                    // registered credentials and credential-shaped
                    // assignments while preserving the parameter names and
                    // structure, which is the debugging value; `method` and
                    // `path` stay verbatim because they are structural, not
                    // client payload.
                    query: redactStringValues(url.search),
                  }),
                },
              );
            } finally {
              // THE WARRANT DIES WITH ITS REQUEST. A handler may keep the value
              // — it is an ordinary object and nothing can stop that — but what
              // it keeps is revoked here, so holding one past the dispatch that
              // minted it is holding a token this router no longer recognises.
              // In the `finally` because a handler that THREW is exactly the one
              // whose leftovers nobody would think to collect.
              if (route.mutating) revokeMutationWarrant(warrant);
            }
          } catch (err) {
            webHandleError(err, { module: "router", operation: "dispatch" });
            // A RateLimitError carries a `Retry-After` (seconds) — emit it as
            // the HTTP header so the client knows how long to wait. Other
            // errors have no Retry-After.
            respondWithError(
              res,
              err,
              err instanceof RateLimitError ? { "Retry-After": String(err.retryAfterSeconds) } : undefined,
            );
          }
          return;
        }

        // THE 404 ECHOES THE REQUEST PATH, WHICH IS THE CALLER'S BYTES. A path
        // segment can carry a token (`/api/sk-live-…`), so the last raw error
        // write in this file goes through the same egress as the others rather
        // than being the one exception nobody thought of.
        // No route matched: the request still crossed the boundary, so the
        // refusal lane records it before the 404 is written — a probe for a
        // missing route is an observable fact about the traffic, not noise.
        // The typed 404 error carries the refusal's detail (same code the
        // response body states), through the typed hierarchy — never a raw
        // Error constructed for the record's sake.
        recordHttpRefusal(
          method,
          path,
          url.search,
          new NotFoundError(`No route for ${method} ${path}`),
          "no route",
        );
        sendJson(res, { error: "not_found", message: `No route for ${method} ${path}`, path }, 404);
      },
    );
  }

  return {
    get: (path: string, handler: RouteHandler) => add("GET", path, handler, false),
    post: (path: string, handler: MutatingRouteHandler) => add("POST", path, handler, true),
    put: (path: string, handler: MutatingRouteHandler) => add("PUT", path, handler, true),
    patch: (path: string, handler: MutatingRouteHandler) => add("PATCH", path, handler, true),
    delete: (path: string, handler: MutatingRouteHandler) => add("DELETE", path, handler, true),

    /**
     * EVERY REQUEST IS ANSWERED, at this one boundary: the whole of serving
     * it — URL parsing, the recording boundary, the gates, routing, the
     * handler and the 404 — runs inside ONE catch that maps any escape
     * through `respondWithError` (which cannot throw and writes only while
     * nothing was sent). A bad percent-escape (a URIError) or an unparsable
     * Host header (Invalid URL) used to escape before any catch while
     * `server/index.ts` dropped the promise: the socket was never answered,
     * and the Host shape needs no authentication (wf1b-design H1). Both are
     * typed 400s now; this catch is for what nobody typed. The promise never
     * rejects.
     */
    async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        await serveRequest(req, res);
      } catch (err) {
        webHandleError(err, { module: "router", operation: "dispatch-unhandled" });
        respondWithError(res, err);
      }
    },
  };
}

/**
 * Read and JSON-parse the request body, enforcing a byte-size cap.
 *
 * Rejects with BodySizeLimitError (413) when the declared or accumulated
 * byte count exceeds `maxBytes` — BEFORE parsing. Rejects with
 * BodyParseError (400) on malformed JSON.
 */
export function readBody(
  req: IncomingMessage,
  maxBytes: number = serverConfig.maxBodyBytes,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Pre-check: Content-Length header (when present) allows rejecting
    // before reading a single byte.
    const declared = req.headers["content-length"];
    if (declared !== undefined) {
      const len = Number(declared);
      if (Number.isFinite(len) && len > maxBytes) {
        reject(new BodySizeLimitError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on("data", guarded("http.body.data", (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        reject(new BodySizeLimitError());
        return;
      }
      chunks.push(chunk);
    }));
    req.on("end", guarded("http.body.end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyParseError());
      }
    }));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  // SPO: redact PII at the REST egress choke point BEFORE serializing. This
  // is the single place ALL REST JSON responses converge — no route can
  // bypass it (deny-by-default). Mirrors the SSE `send` choke point. The
  // redaction is idempotent on already-redacted payloads (a no-op for
  // routes that redact upstream via the view mappers or the config
  // key-based redaction), so the cost is bounded to a fast regex pass.
  const redacted = redactForUserDisplay(data);
  res.writeHead(status, { "Content-Type": CONTENT_TYPE_JSON });
  res.end(JSON.stringify(redacted));
}

/**
 * Send a JSON response WITHOUT PII redaction. The EXPLICIT opt-out from the
 * `sendJson` egress choke point, for routes that return USER-OWNED raw
 * content the viewer must see verbatim (e.g. the editor read route returns
 * file contents the user opened to edit — redacting would mask their
 * secrets AND corrupt the file on save when the redacted marker is written
 * back). Deny-by-default: `sendJson` redacts; you must EXPLICITLY choose
 * `sendJsonRaw` to send unredacted content, and a prevention test verifies
 * every `sendJsonRaw` call site is a route that returns file content (so a
 * route that merely forgets to redact cannot use `sendJsonRaw` to bypass
 * the choke point — only a genuine file-content route qualifies).
 */
/**
 * SAY THAT A COLLECTION RESPONSE IS BOUNDED, on the response itself.
 *
 * §4's law is that no route returns an unbounded collection. A route whose
 * body is a bare JSON ARRAY has nowhere in the body to say so — and a bounded
 * array that says nothing is exactly the silent truncation the paging owner
 * exists to prevent: the caller cannot tell "these are all of them" from
 * "these are the newest N of them".
 *
 * So the fact travels in a header. `X-Collection-Bound` names the bound that
 * was applied and whether older rows exist; a caller that needs the rest asks
 * the paged route, which has a body shape that can carry a cursor. Callers
 * that ignore it are no worse off than before, and a caller that reads it can
 * never mistake a page for a whole.
 */
export function noteCollectionBound(
  res: ServerResponse,
  bound: Readonly<{ limit: number; returned: number; hasOlder: boolean }>,
): void {
  res.setHeader(
    "X-Collection-Bound",
    `limit=${bound.limit}; returned=${bound.returned}; more=${bound.hasOlder ? "1" : "0"}`,
  );
}

export function sendJsonRaw(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": CONTENT_TYPE_JSON });
  res.end(JSON.stringify(data));
}
