/**
 * Server typed error hierarchy — mirrors the harness's `src/errors.ts`
 * pattern. All server errors must use these typed errors, not raw `Error`.
 * This enables structured error handling and consistent error codes.
 *
 * Enforces: "No `throw new Error(...)` — use `src/errors.ts` typed
 * hierarchy." The web UI server has its own hierarchy to stay modular
 * and independent from the harness runtime.
 */

export class WebError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ConfigError extends WebError {
  constructor(message: string, code = "config_invalid") {
    super(message, code, false);
    this.name = "ConfigError";
  }
}

/**
 * No usable model provider is saved for this user — the GUIDED state, not a
 * crash and not an emptiness.
 *
 * 428 Precondition Required, deliberately, and it is the whole point of the
 * class. 503 says "try again later", which is false: nothing this server can
 * do will make a provider appear, and a client that retries a 503 spins
 * forever against a condition only the USER can clear. 428 says "you must do
 * something first", which is exactly true, and it is what lets the UI tell a
 * transient outage apart from an unconfigured account without parsing prose.
 *
 * The message always names the remedy. There is no second phrasing of it
 * anywhere: `server/providers.ts` owns the sentence, the run path throws this
 * error with it, and the models route hands the SAME sentence to the setup
 * surface — so what the user reads before a run and what they read in
 * Settings cannot drift apart.
 */
export class ProviderNotConfiguredError extends WebError {
  readonly statusCode = 428;
  constructor(message: string, code = "provider_not_configured") {
    super(message, code, false);
    this.name = "ProviderNotConfiguredError";
  }
}

/**
 * A run start on a conversation that already has a run in flight. Two
 * executors writing one transcript race each other and corrupt the history
 * both are reading — the cockpit's composer routes a plain send under a live
 * run to STEERING, and this error is the server's own backstop for every
 * other door (a second window on the same chat, a hand-rolled API call, the
 * race where the client's run view retired a moment before the POST).
 *
 * A 428 of the GUIDED family (the same status `provider_not_configured`
 * uses): the state is real, named, and carries its remedy — steer the live
 * run or let it settle — so the client renders it as a principled refusal
 * with this sentence, not as a broken send.
 */
export class ChatRunLiveError extends WebError {
  readonly statusCode = 428;
  /**
   * The run the refusal is about — the one already live in this
   * conversation. The gate holds it when it refuses (it looked the run up to
   * know there was one), so the refusal can name its own subject and the
   * client can adopt the run the sentence tells the reader to steer.
   * Absent when the gate raced a run that settled between the lookup and
   * the throw — then there is nothing live to name and the sentence's other
   * half ("let it settle") has already happened.
   */
  readonly liveRunId?: string;
  constructor(message: string, code = "chat_run_live", liveRunId?: string) {
    super(message, code, false);
    this.name = "ChatRunLiveError";
    if (liveRunId !== undefined) this.liveRunId = liveRunId;
  }
}

/**
 * A steer pressed while the run's turn loop is done but the run is still
 * settling — its registry entry is alive (the reader's run view still says
 * "running"), yet no further turn will read the steering queue, so
 * accepting the message would be an acknowledged delivery that never
 * happens.
 *
 * A 428 of the GUIDED family, like `chat_run_live` beside it: the state is
 * real, named, and carries its remedy — let the run settle (or stop it) and
 * send again — so the client renders it as a principled refusal on its own
 * sentence, never a raw 404 about a run the reader can still see.
 */
export class RunFinishingError extends WebError {
  readonly statusCode = 428;
  constructor(message: string, code = "run_finishing") {
    super(message, code, false);
    this.name = "RunFinishingError";
  }
}

/** A recorded conversation stop refuses new work; it has no implicit reset. */
export class ConversationStoppedError extends WebError {
  readonly statusCode = 428;
  constructor(message: string, code: string) {
    super(message, code, false);
    this.name = "ConversationStoppedError";
  }
}

/**
 * A settings write the setting's own declared bounds refused. The value is
 * the USER's answer to a question the registry asked — min, max, enum — and
 * a value outside them is not a malformed request but a DECLINED answer
 * with its remedy in the sentence: fix the value and save again. The client
 * EXPECTS to render this sentence in the sheet (the standing value stands),
 * so it is a 428 of the GUIDED family, not a 400: a designed refusal travels
 * in the refusal envelope and never logs as a browser console error, while a
 * malformed body (`invalid_customization_body`, `invalid_block_input`) keeps
 * its raw 400 — a caller that cannot even shape the request is a real
 * failure.
 */
export class SettingValueRefusedError extends WebError {
  readonly statusCode = 428;
  constructor(message: string, code = "invalid_customization_value") {
    super(message, code, false);
    this.name = "SettingValueRefusedError";
  }
}

/**
 * An armed-trigger predicate the record's own grammar declined. The same
 * family and the same line as `SettingValueRefusedError`: the request BODY
 * parsed and passed the block's zod schema — the predicate string IS the
 * user's answer to a question the arm door asked — so an expression that
 * will not parse, or roots a vocabulary the live stream cannot bind, is a
 * DECLINED answer with its remedy in the sentence (fix the expression and
 * arm again), not a malformed request. A 428 of the GUIDED family: the
 * designed refusal travels in the 200 envelope and never logs a browser
 * console error, while the malformed-body class (`invalid_block_input`)
 * keeps its raw 400.
 */
export class ArmPredicateRefusedError extends WebError {
  readonly statusCode = 428;
  constructor(message: string, code = "invalid_arm_predicate") {
    super(message, code, false);
    this.name = "ArmPredicateRefusedError";
  }
}

export class ValidationError extends WebError {
  constructor(message: string, code = "validation_failed") {
    super(message, code, false);
    this.name = "ValidationError";
  }
}

/**
 * A value wearing the `ProviderCredential` shape that the mint never made —
 * an object spread copies the brand symbol with no cast, so shape proves
 * nothing; membership in the mint's own WeakSet is the credential, and the
 * bridge consults it before a credential becomes a network client. Not a
 * user-facing state: a forged credential is a defect (or an attack) inside
 * the process, so this carries no remedy sentence and no status override.
 */
export class ForgedProviderCredentialError extends WebError {
  constructor() {
    super(
      "this provider credential was not minted by server/providers.ts — a copy " +
        "(an object spread copies the brand) or a hand-built lookalike. No client " +
        "is built from it: resolve a credential through resolveProviderCredential, " +
        "which reads the user's saved provider from the database.",
      "provider_credential_not_minted",
      false,
    );
    this.name = "ForgedProviderCredentialError";
  }
}

export class FileSystemError extends WebError {
  constructor(message: string, code = "filesystem_error") {
    super(message, code, false);
    this.name = "FileSystemError";
  }
}

/**
 * Authentication / authorization failure — wrong password, missing/expired
 * session, setup already completed, etc. Carries HTTP 401 to the router
 * (the auth middleware checks for this). Used by the auth module + routes.
 */
export class AuthError extends WebError {
  readonly statusCode = 401;
  constructor(message: string, code = "auth_failed") {
    super(message, code, false);
    this.name = "AuthError";
  }
}

/**
 * A CSRF check blocked an unsafe request (HTTP 403). Thrown by the CSRF
 * guard (`server/csrf.ts::checkCsrf`) when a POST/PUT/PATCH/DELETE lacks a
 * same-origin Origin/Referer header OR the custom `X-Requested-With` header.
 * The router (`server/router.ts`) maps it to a 403 response via the
 * centralized error-mapping choke point — Single-Party-Owner (
 * -V8): the CSRF guard THROWS a typed error instead of writing its own
 * 403 response, so the router owns ALL error responses (consistent with
 * / routes + guards throw, the router maps). A 403 (not 401) signals
 * "you are authenticated but this request is forbidden as a CSRF" —
 * distinct from auth failures.
 */
export class CsrfError extends WebError {
  readonly statusCode = 403;
  constructor(message: string, code = "csrf_blocked") {
    super(message, code, false);
    this.name = "CsrfError";
  }
}

/**
 * A user-data operation was attempted on a resource the authenticated
 * user does not own (Single-Party-Owner enforcement). Thrown by the database
 * CREATE methods when the parent resource (project/chat/message) does not
 * belong to the caller's `userId` — the DB layer enforces the gate at the
 * choke point so a route that forgets to pre-check ownership can never
 * write into another user's data. Carries HTTP 403 to the router (which
 * honors the `statusCode` contract). Reads return null/empty instead
 * (hiding existence); only writes that would mutate another user's data
 * throw this — a silent null on a create would look like success.
 */
export class ForbiddenError extends WebError {
  readonly statusCode = 403;
  constructor(message: string, code = "forbidden") {
    super(message, code, false);
    this.name = "ForbiddenError";
  }
}

/**
 * A conflict with the current state of the target resource (HTTP 409) —
 * e.g. a username collision on register, a "create" on a path that already
 * exists, a preimage mismatch on a transactional edit. Carries HTTP 409 to
 * the router (which honors the `statusCode` contract). The single owner of
 * the 409 contract — previously a local `ConflictError` lived ad-hoc in
 * routes/auth.ts (an SPO violation; typed errors live in ONE
 * hierarchy).
 */
export class ConflictError extends WebError {
  readonly statusCode = 409;
  constructor(message: string, code = "conflict") {
    super(message, code, false);
    this.name = "ConflictError";
  }
}

/**
 * A resource was not found (HTTP 404). Thrown by the project-path ownership
 * gate (`requireProjectByPath`) when a supplied project path does not
 * resolve to a project owned by the authenticated user, and by filesystem
 * bridges when a path does not exist. Carries HTTP 404 to the router.
 */
export class NotFoundError extends WebError {
  readonly statusCode = 404;
  constructor(message: string, code = "not_found") {
    super(message, code, false);
    this.name = "NotFoundError";
  }
}

/**
 * The request was malformed or failed input validation (HTTP 400). Used by
 * route-level guards for missing/invalid query params (path, query, symbol)
 * BEFORE the zod body schema runs, and by the editor/filesystem bridges for
 * non-validation client errors that are still the caller's fault (not_a_file,
 * not_a_directory). Carries HTTP 400 to the router.
 */
export class BadRequestError extends WebError {
  readonly statusCode = 400;
  constructor(message: string, code = "bad_request") {
    super(message, code, false);
    this.name = "BadRequestError";
  }
}

/**
 * The request attempted to access a resource outside the allowed scope
 * (HTTP 403) — e.g. a project path outside the configured allowed roots, a
 * path traversal escape. Distinct from ForbiddenError (which is about
 * user-data ownership); this is about path/scope confinement. Carries
 * HTTP 403 to the router.
 */
export class PathTraversalError extends WebError {
  readonly statusCode = 403;
  constructor(message: string, code = "path_traversal") {
    super(message, code, false);
    this.name = "PathTraversalError";
  }
}

/**
 * Map a WebError's `code` to an HTTP status code. This is the single owner
 * of the code→status mapping for the typed-error codes that do NOT carry
 * their own `statusCode` property (e.g. the editor/filesystem bridges throw
 * `ValidationError` with codes like `path_traversal`, `file_not_found`,
 * `already_exists`). The router's `statusForError` consults this so a
 * route that throws a typed error does NOT need to catch+remap it itself
 * (Single-Party-Owner: error mapping lives in the router, not each route).
 *
 * Codes that already carry `statusCode` (AuthError=401, ForbiddenError=403,
 * ConflictError=409, NotFoundError=404, BadRequestError=400,
 * PathTraversalError=403, BodySizeLimitError=413) bypass this map — their
 * declared status always wins.
 */
// The code→status table moved to `shared/errors.ts` so the CLIENT shares
// the same taxonomy. It previously lived here alone, which is why the client
// never had the vocabulary and fell back to `http_<status>`. Re-exported so
// every existing server consumer keeps importing it from the error owner.
export { CODE_STATUS_MAP, statusForCode, resolveStatus, isClientInputCode } from "../../shared/errors.ts";

/**
 * A project path is missing, inaccessible, or a stale encrypted ciphertext
 * (the `enc:` prefix from the unrecoverable per-process random key era).
 * Thrown by intelligence/quality/git bridges so callers surface a clear,
 * typed error instead of silently returning empty results (the root cause
 * of "get_repository_map returns empty" — the bridge walked a non-existent
 * directory and returned zero counts with no explanation).
 */
export class ProjectPathError extends WebError {
  constructor(message: string, code = "project_path_invalid") {
    super(message, code, false);
    this.name = "ProjectPathError";
  }
}

/**
 * The repository map is not ready yet — the background worker thread is
 * still building it (or a build has not been triggered). Thrown by the
 * intelligence bridge's synchronous accessors when a caller asks for the
 * map before the off-thread build has completed.
 *
 * Root cause this guards: the previous `getCachedMap` built the map
 * SYNCHRONOUSLY on the main thread on a cache miss, blocking the Node
 * event loop for tens of seconds on a 475+ module codebase. Every HTTP
 * request queued behind it timed out → HTTP 502 on chat runs. The map is
 * now built in a `node:worker_threads` Worker off the event loop; the
 * synchronous accessors return the cached map instantly on a hit and
 * throw this typed error on a miss/pending so callers can skip map
 * injection (the run route) or return a 202 "indexing" status (the
 * intelligence routes) instead of wedging the server.
 */
export class MapNotReadyError extends WebError {
  /** HTTP 202 "indexing" — the worker is still building; the client polls. */
  readonly statusCode = 202;
  constructor(message: string, code = "map_not_ready") {
    super(message, code, true);
    this.name = "MapNotReadyError";
  }
}

/**
 * The service is temporarily unavailable (HTTP 503) — e.g. no LLM providers
 * are configured, or a required backend dependency is not initialized. Used
 * by the models route when the harness config has no providers (the service
 * cannot serve model data until configured). Carries HTTP 503 to the router.
 *
 * (No Scattered Helpers): this replaces the ad-hoc
 * `sendError(res, 503, "unavailable",...)` helper that was duplicated across
 * route files. A route now `throw new ServiceUnavailableError(message, code)`
 * and the router's centralized error mapping (statusForError + errorBody)
 * produces the 503 `{ error, message }` body — Single-Party-Owner: error
 * mapping lives in the router, not each route.
 */
export class ServiceUnavailableError extends WebError {
  readonly statusCode = 503;
  constructor(message: string, code = "service_unavailable") {
    super(message, code, true);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * The awareness snapshot is not ready yet — the background worker thread
 * is still computing it (complexity, clones, drift, hotspots). Thrown by
 * the awareness bridge's synchronous accessor when a caller asks for the
 * snapshot before the off-thread compute has completed.
 *
 * Root cause this guards: the awareness engine's `compute` is a long
 * synchronous pass over every source file; run on the main thread (the
 * post-run quality call at run.ts:1133) it wedged the HTTP server for
 * tens of seconds on a large codebase (the second 502 chat-run wedge).
 * The compute now runs in a worker; the sync accessor throws this typed
 * error on a miss/pending so the run route can skip the quality event
 * (or await the async variant) instead of wedging the server.
 */
export class AwarenessNotReadyError extends WebError {
  /** HTTP 202 "indexing" — the awareness worker is still computing. */
  readonly statusCode = 202;
  constructor(message: string, code = "awareness_not_ready") {
    super(message, code, true);
    this.name = "AwarenessNotReadyError";
  }
}

/**
 * The request body exceeded the configured byte cap (HTTP 413). Thrown by
 * the router's `readBody` BEFORE JSON parsing — either the declared
 * Content-Length or the accumulated byte count exceeded `maxBodyBytes`.
 * Carries HTTP 413 to the router.
 *
 * Single-Party-Owner: previously defined ad-hoc in router.ts
 * (extending `Error` directly, outside the typed hierarchy). Moved here so
 * the ENTIRE error hierarchy lives in ONE owner module (errors.ts).
 * The router re-exports these for its test; the canonical home is
 * here.
 */
export class BodySizeLimitError extends WebError {
  readonly statusCode = 413;
  constructor(message = "Request body exceeds size limit") {
    super(message, "body_too_large", false);
    this.name = "BodySizeLimitError";
  }
}

/**
 * The request body was not valid JSON (HTTP 400). Thrown by the router's
 * `readBody` when `JSON.parse` fails. Carries HTTP 400 to the router.
 *
 * Single-Party-Owner: moved from router.ts into the typed
 * hierarchy (errors.ts) so the error hierarchy has ONE owner.
 */
export class BodyParseError extends WebError {
  readonly statusCode = 400;
  constructor(message = "Invalid JSON body") {
    super(message, "invalid_json", false);
    this.name = "BodyParseError";
  }
}

/**
 * The session has exhausted its rate-limit budget (HTTP 429). Thrown by the
 * router's dispatch when `checkRateLimit` returns false for a mutating
 * route. The router catches it + maps it to a 429 response with a
 * `Retry-After` header (derived from the rate-limiter's refill rate, NOT a
 * hardcoded literal). Single-Party-Owner: the rate-limit check
 * THROWS instead of writing its own 429 response — consistent with the
 * authGate + checkCsrf consolidation (-V8/V9): ALL guards throw typed
 * errors, the router owns ALL error responses. Carries `retryAfterSeconds`
 * so the router can emit the `Retry-After` header from the single
 * rate-limit-timing owner (rate-limiter.ts), fixing the prior hardcoded
 * `Retry-After: "60"` (which was also WRONG — the refill rate yields ~1s,
 * not 60s).
 */
export class RateLimitError extends WebError {
  readonly statusCode = 429;
  /** Seconds the client should wait before retrying (emitted as
   * `Retry-After`). Derived from the rate-limiter's refill rate. */
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number, code = "rate_limited") {
    super(message, code, true);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
