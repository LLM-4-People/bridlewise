/**
 * The Broker — the single place the client performs I/O.
 *
 * Binding guideline: "feel instant everywhere", "the whole app must be very
 * efficient".
 *
 * WHY THIS IS ONE MODULE AND NOT NINETY-THREE
 *
 * `client.ts` grew 93 exported functions, each doing its own `fetch`. None of
 * them cached, deduplicated, revalidated conditionally, or cancelled a
 * superseded request — `fetchJson` wired an AbortController solely to a
 * timeout. That is not an oversight so much as an inevitability: adding
 * caching to ninety-three call sites is never worth it individually, so it
 * never happened at all.
 *
 * Because every Block answers in ONE envelope shape, those behaviours can be
 * implemented once here and apply to every capability at once. Uniformity is
 * what makes them affordable; that is the whole argument for the Block
 * contract.
 *
 * WHAT THIS OWNS
 *   - the response cache, keyed by (block, params)
 *   - in-flight deduplication: concurrent callers share one request
 *   - superseded-request cancellation via a per-key generation counter
 *   - conditional revalidation (`If-None-Match`) using the envelope's etag
 *   - TTL with stale-while-revalidate
 *   - invalidation on bus events
 *   - prefetch on intent
 *
 * WHAT THIS DOES NOT OWN
 *   Auth, CSRF and rate limiting stay server-side. The Broker sends the CSRF
 *   header at the single fetch choke point, exactly as `fetchJson` did.
 */

import {
  CONTENT_TYPE_JSON,
  CSRF_CUSTOM_HEADER,
} from "../../shared/constants.ts";
import {
  blockActionPath,
  blockReadPath,
  type BlockResponse,
} from "../../shared/block-contract.ts";
import { PRINCIPLED_REFUSAL_STATUSES } from "../../shared/errors.ts";
import type { ActionOrigin } from "../../shared/provenance.ts";
import {
  BROKER_DEFAULT_TTL_MS,
  DEFAULT_API_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../client-config.ts";
import { refusalReason } from "./absence.ts";
import { ClientError, ClientTimeoutError } from "./errors.ts";
// THE CONNECTION IS DECIDED HERE, at the one door every request already
// passes through, and nowhere else. See src/data/connection.ts for why
// reachability cannot be a per-call-site judgement.
import {
  installConnectionRevalidation,
  requestBudgetMs,
  watchRequest,
} from "./connection.ts";
// Provenance is captured HERE, at the single door all data comes through, and
// nowhere else. Asking call sites to pass provenance in would make it
// forgettable — the exact failure mode this architecture exists to remove.
// The import is static and unconditional for the same reason: a registration
// step is a step someone can skip. See src/data/ledger.ts.
import { recordAction, recordRead } from "./ledger.ts";
// The ambient `asOf` (§6.2). Applied HERE for the same reason provenance is:
// a parameter every call site must remember to pass is a parameter that will
// be forgotten, and a forgotten `until` is a live answer wearing a past
// timestamp. See src/data/asof.ts.
import { asOfHead, assertLiveForWrite, paramsWithAsOf } from "./asof.ts";

const API_BASE = DEFAULT_API_BASE;

/**
 * The raw JSON fetch — the single choke point through which every request
 * passes, which is why the CSRF header is attached here.
 *
 * ── THE CSRF DEAD-END, ENDED AT THE DOOR ────────────────────────
 *
 * A `csrf_blocked` 403 used to surface straight to the user as "reload the
 * page and try again" — a manual remedy for something this choke point can
 * do itself. The guard (server/csrf.ts) rejects the request BEFORE any
 * handler runs, so a blocked request changed nothing and re-issuing the
 * identical request once is safe by construction, whatever its method.
 *
 * There is deliberately NO token to refetch: the protection is the stateless
 * OWASP pattern (same-origin evidence OR the custom header, both attached
 * below), so the retry presents the same evidence again on a fresh request.
 * That recovers the transient class — a request whose Origin/Referer was
 * stripped in flight, a proxy that dropped one header — and a second
 * `csrf_blocked` is a real refusal, which propagates and only THEN reaches
 * the user-facing sentence (src/data/error-messages.ts) as the fallback.
 * Exactly one retry: a loop over a genuine origin mismatch would hammer a
 * server that has already said no twice.
 */
export async function fetchJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  // `attempt` exists solely for the csrf retry below — every other failure
  // leaves on its first throw. A loop rather than a second function, so the
  // one raw `fetch` and the CSRF header stay INSIDE the one named choke
  // point the client-api guard certifies.
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? requestBudgetMs(DEFAULT_REQUEST_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // One watch per request, ended by exactly one of `responded` / `failed` /
    // `release`. This is the ONLY place in the client that gets to have an
    // opinion about whether the server is reachable.
    const watch = watchRequest();
    // A WRITE ASKS TO JUMP THE QUEUE (UIE-044). When the browser's
    // per-origin HTTP/1.1 pool is full, pending requests wait in a
    // priority-ordered queue — a steer POST must not sit behind observer
    // reads that can be revalidated anyway. Every client-initiated write
    // crosses this door as a POST (block actions, run start/steer/cancel,
    // chat sends), so the method is the one rule, applied here at the choke
    // point rather than remembered per call site. THE DOOR OWNS THE FIELD:
    // the caller's priority is stripped below in both directions (a POST is
    // always high, a GET always the browser's default), so the rule cannot
    // be contradicted from a call site. HONEST CAVEAT: priority REORDERS the
    // queue; it does not add sockets — the socket count itself is the
    // liveness share's fix (src/data/liveness-share.ts).
    const { priority: _callerPriority, ...callerInit } = init ?? {};

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...callerInit,
        signal: init?.signal ?? controller.signal,
        ...(init?.method === "POST" ? { priority: "high" as const } : {}),
        headers: {
          "Content-Type": CONTENT_TYPE_JSON,
          [CSRF_CUSTOM_HEADER]: "1",
          ...init?.headers,
        },
      });
      // Reported BEFORE the status is inspected, because reachability is
      // answered by the fact of a response and not by what it says. A 401 and
      // a 500 both prove the API is there.
      watch.responded(res);

      if (!res.ok) {
        let body: unknown;
        try { body = await res.json(); } catch { body = undefined; }
        const obj = typeof body === "object" && body !== null
          ? (body as { message?: unknown; error?: unknown })
          : undefined;
        const msg = obj !== undefined && "message" in obj
          ? String(obj.message)
          : `HTTP ${res.status}`;
        // Preserve the server's typed code; `http_<status>` is the fallback for
        // a response with no typed code.
        const code = typeof obj?.error === "string" && obj.error.length > 0
          ? obj.error
          : `http_${res.status}`;
        throw new ClientError(code, msg, res.status);
      }

      const parsed = (await res.json()) as T;
      // A PRINCIPLED REFUSAL THAT TRAVELED IN A 200 ENVELOPE is reconstructed
      // HERE, at the one door every request already passes — block reads and
      // the hand routes alike (the git-ops family joined the envelope after
      // this). The alternative was per-consumer reconstruction at every hand
      // door, which is exactly the per-call-site shape this architecture
      // refuses: a consumer added tomorrow reads its refusals for free. For
      // the block door the bookkeeping is unchanged — a rejected fetch lands
      // in the caller's rejection handler, which runs the SAME
      // `settleFailure` the in-then check used to.
      const refusal = blockRefusalOf(parsed);
      if (refusal !== null) throw refusal;
      return parsed;
    } catch (err) {
      if (err instanceof ClientError) {
        // The csrf retry (see the header): exactly one, for exactly this
        // code, on a fresh request through this same door.
        if (err.code === "csrf_blocked" && attempt === 0) continue;
        throw err;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        // OUR abort is the timeout; a CALLER's abort is a cancellation and
        // says nothing about the server. Distinguished by which controller
        // fired, because "the user navigated away" and "the API stopped
        // answering" must not produce the same banner.
        if (controller.signal.aborted) watch.failed("timeout");
        else watch.release();
        throw new ClientTimeoutError();
      }
      // A rejection that is neither typed nor an abort is a refused socket, a
      // DNS failure or a dropped connection: no response was produced at all.
      // The watch is idempotent, so a malformed-JSON failure AFTER a real
      // response cannot rewrite an answered request into an outage.
      watch.failed("refused");
      throw new ClientError("network", String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── The refusal, reconstructed at the door ─────────────────────────────────

/**
 * Narrow a block response into the typed error its REFUSAL carries — or null
 * when the response is a measured answer.
 *
 * A principled refusal (428/503, typed code, the server's own sentence)
 * travels in the 200 envelope as data, so a DESIGNED refusal does not land
 * in the browser's console as a resource error on every boot — the browser
 * logs the STATUS itself, before any page code runs, and no client code can
 * unsay that. This is the single reader that turns the envelope back into
 * the typed `ClientError` every consumer already understands: the
 * refusal-holding below, `refusalReason`'s REFUSED state, and the absence
 * wording all see exactly what they saw when the refusal traveled as a 503.
 *
 * The status is re-validated against the shared refusal family, never
 * trusted: an envelope claiming a refusal status outside 428/503 is a
 * malformed answer, not a refusal, and must not be silenced here.
 */
export function blockRefusalOf(response: unknown): ClientError | null {
  if (response === null || typeof response !== "object") return null;
  const refusal = (response as Readonly<{ refusal?: unknown }>).refusal;
  if (refusal === null || typeof refusal !== "object") return null;
  const r = refusal as Readonly<{ code?: unknown; message?: unknown; status?: unknown }>;
  if (typeof r.code !== "string" || r.code.length === 0) return null;
  if (typeof r.message !== "string" || r.message.length === 0) return null;
  if (
    typeof r.status !== "number" ||
    !(PRINCIPLED_REFUSAL_STATUSES as readonly number[]).includes(r.status)
  ) {
    return null;
  }
  // The refusal's subject rides along when it has one (`chat_run_live` names
  // the run already live) so the send path can adopt that run. Validated with
  // the same narrowness as the rest: a non-string subject is dropped, not
  // guessed at.
  const liveRunId = (r as Readonly<{ liveRunId?: unknown }>).liveRunId;
  return new ClientError(
    r.code,
    r.message,
    r.status,
    undefined,
    typeof liveRunId === "string" && liveRunId.length > 0 ? liveRunId : undefined,
  );
}

// ── Cache ───────────────────────────────────────────────────────────────────

type CacheEntry = {
  /** The last successful envelope. */
  response: BlockResponse<unknown>;
  /** When it was stored (epoch ms). */
  storedAt: number;
  /** TTL in ms; 0 means always revalidate. */
  ttlMs: number;
  /** Monotonic generation, bumped when a newer request supersedes an older. */
  generation: number;
};

const cache = new Map<string, CacheEntry>();
/**
 * STANDING PRINCIPLED REFUSALS, per key — the negative half of the cache.
 *
 * A typed 428/503 is the server DECLINING a read on purpose, with its own
 * sentence, and it is DETERMINISTIC: the identical request gets the
 * identical refusal until something changes on the server's side of the
 * question. Without this map every revalidation pass (a head move, a
 * reconnection, a TTL expiry) re-asked anyway — measured at 130+ identical
 * 503s in one session, each one a real request for an answer known in
 * advance.
 *
 * So a held refusal is served (re-thrown) without a network trip, and it is
 * dropped by exactly the events that can change the answer:
 *   - `force: true` — the caller's explicit retry;
 *   - `invalidate` / `fireInvalidation` — a write declared it falsified
 *     this data (the entry registered its events like any read);
 *   - `clearCache` — context switch / sign-out.
 * A TRANSPORT failure (network, timeout, untyped 5xx) is never held: it
 * says nothing about the next attempt. The classifier is the one owner in
 * src/data/absence.ts.
 */
const refusals = new Map<string, ClientError>();
/** In-flight requests, so concurrent callers share one network trip. */
const inflight = new Map<string, Promise<BlockResponse<unknown>>>();
/** Per-key generation counter — the superseded-request guard. */
const generations = new Map<string, number>();
/** Block ids to invalidate when a bus event fires. */
const invalidators = new Map<string, Set<string>>();

/**
 * Stable cache key: params sorted so key order never splits the cache.
 *
 * TIME IS PART OF IDENTITY. The ambient `until` is a normal param by the time
 * it reaches here, so a read at a planted head keys as
 * `tools.breaker?chatId=c1&until=1700000000000` and a live read keys as
 * `tools.breaker?chatId=c1`. They are different entries: a past answer can
 * never be handed to a live reader, and returning to now cannot be served the
 * past bytes. Getting this wrong is the fastest way to corrupt the app, which
 * is why `readKey` below — not this function — is what a caller should use to
 * NAME the read it is displaying.
 */
export function cacheKey(block: string, params?: Readonly<Record<string, string>>): string {
  if (params === undefined) return block;
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return block;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${block}?${entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/** Options for a single read. */
export type ReadOptions = Readonly<{
  params?: Readonly<Record<string, string>>;
  /** Override the default cache lifetime. */
  ttlMs?: number;
  /** Bypass the cache and force a network round trip. */
  force?: boolean;
  /** Bus events that should drop this entry when they fire. */
  invalidateOn?: readonly string[];
}>;

function isFresh(entry: CacheEntry, now: number): boolean {
  return entry.ttlMs > 0 && now - entry.storedAt < entry.ttlMs;
}

/**
 * The request path for a block read, RELATIVE to `API_BASE`.
 *
 * `blockReadPath` (contract-owned) is absolute — it already contains the
 * `/api` prefix — while `fetchJson` prefixes every path with `API_BASE`.
 * Composing them verbatim produced `/api/api/b/<id>`, so EVERY Broker read
 * 404'd against a route that exists (browser-verified: `/api/b/…` answers
 * 200, `/api/api/b/…` answers 404). The de-duplication lives here, at the
 * single choke point, so no caller can rebuild the doubled prefix.
 */
export function blockRequestPath(
  block: string,
  params?: Readonly<Record<string, string>>,
): string {
  const absolute = blockReadPath(block) + (params !== undefined ? queryString(params) : "");
  return relativeToApiBase(absolute);
}

/** Strip the `API_BASE` prefix from a contract-owned absolute path. The ONE
 *  de-duplication rule, shared by the read and action paths so neither side
 *  can rebuild the doubled `/api/api/` prefix the other already fixed. */
function relativeToApiBase(absolute: string): string {
  return absolute.startsWith(`${API_BASE}/`) ? absolute.slice(API_BASE.length) : absolute;
}

/** The request path for one of a block's actions, RELATIVE to `API_BASE`. */
export function blockActionRequestPath(block: string, actionName: string): string {
  return relativeToApiBase(blockActionPath(block, actionName));
}

// ── Freshness subscribers (the "patched in place" half of SWR) ─────────────

/**
 * Notified when a key's cache entry is replaced by DIFFERENT bytes.
 *
 * This is the half that makes stale-while-revalidate honest rather than
 * merely fast. Serving the last-known value instantly is only defensible if
 * the fresh answer, when it lands, reaches the pixels — otherwise the surface
 * would be frozen at a value it can never leave. A subscriber patches the
 * changed values in place; nothing re-mounts, so there is no flash and no
 * layout shift.
 *
 * UNCHANGED bytes fire NOTHING. That is the no-flash guarantee at its root:
 * the overwhelmingly common revalidation outcome is "same answer", and a
 * notification then would push every surface through a needless update for a
 * value that did not move. The comparison is the envelope's own etag, which
 * the server derives from the payload (server/blocks/define.ts).
 *
 * Deliberately NOT cleared by `clearCache()`, for the same reason
 * `invalidationListeners` is not: these are standing subscriptions ("when
 * this key changes, patch these pixels"), not cached data.
 */
type FreshListener = (data: unknown, meta: BlockResponse<unknown>["meta"]) => void;
const freshListeners = new Map<string, Set<FreshListener>>();

/**
 * Subscribe to fresh bytes for ONE cache key — the key `readKey()` names, so
 * a surface subscribes to exactly the entry it is displaying. Returns the
 * unsubscribe.
 *
 * A past-view key and a live key are different entries (see `cacheKey`), so a
 * surface watching the live key is not woken by a past read, and vice versa.
 */
export function onFreshRead(key: string, listener: FreshListener): () => void {
  let set = freshListeners.get(key);
  if (set === undefined) {
    set = new Set();
    freshListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    freshListeners.get(key)?.delete(listener);
  };
}

function notifyFresh(key: string, response: BlockResponse<unknown>): void {
  const set = freshListeners.get(key);
  if (set === undefined || set.size === 0) return;
  for (const listener of [...set]) {
    try {
      listener(response.data, response.meta);
    } catch (err) {
      // One subscriber must not stop the others, and it must not turn a
      // successful cache write into a rejected read. Re-thrown out of band so
      // the failure is still loud — instrumentation never swallows an error.
      setTimeout(() => {
        throw err;
      }, 0);
    }
  }
}

/**
 * Issue the network half of a read: generation guard, invalidation
 * registration, conditional request, cache write, provenance record.
 *
 * Shared by the cold path (nothing known yet — the caller awaits this) and by
 * the stale-while-revalidate path (something IS known — the caller already
 * returned it and this runs underneath). One function, so a background
 * revalidation and a foreground fetch cannot acquire different semantics.
 */
function issue<T>(
  block: string,
  key: string,
  params: Readonly<Record<string, string>> | undefined,
  ttlMs: number,
  opts: ReadOptions,
  requestedAt: number,
): Promise<BlockResponse<T>> {
  // Deduplicate: a second caller (or a revalidation racing a cold read) while
  // a request is open joins it rather than opening a parallel connection for
  // the same data. `force` deliberately bypasses this — a read-back after an
  // act must observe the world AFTER the act, not join a request issued
  // before it.
  const pending = inflight.get(key);
  if (pending !== undefined && opts.force !== true) {
    return pending as Promise<BlockResponse<T>>;
  }

  // Bump the generation BEFORE issuing, so a response from an older request
  // that lands later can be recognised as superseded and discarded.
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);

  for (const event of opts.invalidateOn ?? []) {
    let set = invalidators.get(event);
    if (set === undefined) {
      set = new Set();
      invalidators.set(event, set);
    }
    set.add(key);
  }

  const path = blockRequestPath(block, params);
  const headers: Record<string, string> = {};
  const known = cache.get(key);
  if (known !== undefined) {
    headers["If-None-Match"] = known.response.meta.etag;
    // A conditional request is open over data that is already on screen. This
    // is a live state, not history, so it is deliberately not logged for
    // reconstruction — only surfaced as the current cache state.
    recordRead({
      key, block, params, cacheState: "revalidating",
      requestedAt, settledAt: requestedAt, ttlMs, meta: known.response.meta,
    });
  }

  /**
   * The ONE failure bookkeeping for a read, shared by the transport-rejection
   * path and by a refusal that traveled in a 200 envelope — one behaviour,
   * never two opinions about what a failed read records.
   *
   * A failed read is provenance too: "this value is missing BECAUSE the read
   * failed with <code>" is an explanation, and leaving the last successful
   * record standing would let a stale value look current. Rethrown unchanged
   * — instrumentation must never swallow an error.
   *
   * THE CACHED ENTRY IS DELIBERATELY NOT DROPPED. A failed revalidation does
   * not un-measure what the server already said; the last-known value stands
   * with its own `asOf` and the ledger records the failure, which is exactly
   * what LENS reads. Blanking here would be the app forgetting something it
   * truly knows because the network hiccuped.
   *
   * A PRINCIPLED refusal is held (see `refusals`): deterministic, so
   * re-asking on every revalidation pass is a request for an answer known in
   * advance. Transport failures are never held.
   */
  const settleFailure = (err: unknown): never => {
    recordRead({
      key, block, params, cacheState: "failed",
      requestedAt, settledAt: Date.now(), ttlMs,
      errorCode: err instanceof ClientError ? err.code : "network",
    });
    if (err instanceof ClientError && refusalReason(err) !== null) {
      refusals.set(key, err);
    }
    throw err;
  };

  const request = fetchJson<BlockResponse<T>>(path, { headers })
    .then((response) => {
      // Discard a superseded response: a newer request for the same key was
      // issued while this one was open, so writing this into the cache would
      // move the data backwards.
      if ((generations.get(key) ?? 0) !== generation) {
        return (cache.get(key)?.response ?? response) as BlockResponse<unknown>;
      }
      // A PRINCIPLED REFUSAL that traveled in the 200 envelope never gets
      // here: `fetchJson` reconstructs the typed error at its own door (the
      // one choke point every request passes), so it lands in the rejection
      // handler below and settles through the SAME failure bookkeeping a
      // thrown refusal always had — recorded as a failed read, held as a
      // standing refusal, re-thrown to the caller.
      const settledAt = Date.now();
      // A landed answer ends any standing refusal for this key: the server
      // just proved the question is answerable again.
      refusals.delete(key);
      const previous = cache.get(key);
      cache.set(key, {
        response: response as BlockResponse<unknown>,
        storedAt: settledAt,
        ttlMs,
        generation,
      });
      recordRead({
        key, block, params, cacheState: "fresh",
        requestedAt, settledAt, ttlMs, meta: response.meta,
      });
      // Only a CHANGED answer wakes the surfaces (see `freshListeners`).
      if (previous === undefined || previous.response.meta.etag !== response.meta.etag) {
        notifyFresh(key, response as BlockResponse<unknown>);
      }
      return response as BlockResponse<unknown>;
    },
    (err: unknown) => settleFailure(err))
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });

  inflight.set(key, request as Promise<BlockResponse<unknown>>);
  return request as Promise<BlockResponse<T>>;
}

/**
 * Read a block — STALE-WHILE-REVALIDATE.
 *
 * THE THIRD STATE. Absence-first answered fabrication ("never invent data")
 * but it was applied as though a surface had only two states, "nothing" and
 * "fresh". The state that makes an app feel instant is the third one:
 * LAST-KNOWN, shown immediately, revalidated underneath, patched in place.
 * Showing a previously-fetched value is not fabrication — it was true when
 * the server said it, and every envelope carries the `asOf` that dates it.
 *
 * So this resolves, in order:
 *   1. FRESH cached entry (inside its TTL) — served, no request;
 *   2. STALE cached entry — served IMMEDIATELY, and a revalidation is issued
 *      underneath; when different bytes land, `onFreshRead` subscribers patch
 *      the changed values in place. The caller never waits on the network for
 *      something it already knows;
 *   3. nothing known (or `force`) — the cold path: await the network. This is
 *      the FIRST-EVER load, and it stays absence-first, because you cannot
 *      show what was never known and inventing a placeholder is the
 *      prohibited class.
 *
 * `force` skips straight to (3) and bypasses in-flight dedup: a read-back
 * after an act has to see the world after the act.
 *
 * Concurrent callers for the same key share ONE request; a superseded
 * response is discarded; a failed revalidation leaves the last-known value
 * standing (see `issue`).
 */
export async function read<T>(block: string, opts: ReadOptions = {}): Promise<T> {
  // The ambient head is folded in BEFORE anything else happens: the key, the
  // path, the provenance record and the conditional request all have to
  // describe the same instant, and the only way to guarantee that is to
  // resolve it once, here. Throws when the block cannot answer for a past
  // instant — a refusal a surface renders as an honest absence, never a
  // silent substitution of now.
  const params = paramsWithAsOf(block, opts.params);
  const key = cacheKey(block, params);
  const now = Date.now();
  const cached = cache.get(key);
  const ttlMs = opts.ttlMs ?? BROKER_DEFAULT_TTL_MS;

  // A STANDING REFUSAL answers without a network trip. `force` is the
  // explicit-retry door and bypasses it. A last-known value still outranks
  // the refusal for DISPLAY (it was true when the server said it — the
  // keep-last-known rule); what the refusal suppresses is the re-ask.
  if (opts.force !== true) {
    const held = refusals.get(key);
    if (held !== undefined) {
      if (cached !== undefined) {
        recordRead({
          key, block, params, cacheState: "cached",
          requestedAt: now, settledAt: now, ttlMs, meta: cached.response.meta,
        });
        return cached.response.data as T;
      }
      recordRead({
        key, block, params, cacheState: "refused",
        requestedAt: now, settledAt: now, ttlMs, errorCode: held.code,
      });
      throw held;
    }
  }

  if (opts.force !== true && cached !== undefined) {
    if (isFresh(cached, now)) {
      // A cache hit is still an answered read, so it is still explainable. The
      // age reported comes from the envelope's `asOf` (when the SERVER produced
      // the data), never from this moment — which is what makes staleness
      // visible instead of hidden by the hit.
      recordRead({
        key, block, params, cacheState: "cached",
        requestedAt: now, settledAt: now, ttlMs, meta: cached.response.meta,
      });
      return cached.response.data as T;
    }
    // Past TTL: serve what is known, revalidate underneath. The rejection is
    // swallowed HERE and only here — the caller did not ask to wait on this
    // request, and the failure is already in the ledger as `failed`.
    //
    // `ttlMs: 0` OPTS OUT. It has always meant "always revalidate", and the
    // honest reading of a value with NO lifetime at all is that there is no
    // such thing as a valid last-known one — so that caller still awaits the
    // network. It is the deliberate escape hatch from warmth, not an
    // oversight; every production read declares a real TTL.
    if (ttlMs > 0) {
      void issue<T>(block, key, params, ttlMs, opts, now).catch(() => undefined);
      return cached.response.data as T;
    }
  }

  return (await issue<T>(block, key, params, ttlMs, opts, now)).data as T;
}

function queryString(params: Readonly<Record<string, string>>): string {
  const usable = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (usable.length === 0) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of usable) qs.set(k, v);
  return `?${qs.toString()}`;
}

/**
 * Warm the cache without awaiting the result.
 *
 * Used for prefetch-on-intent (hover, focus). Failures are swallowed
 * deliberately: a speculative fetch that fails must never surface an error the
 * user did not ask for. A real read of the same key will report it properly.
 */
export function prefetch(block: string, opts: ReadOptions = {}): void {
  // Same ambient resolution as `read`, or there would be two opinions about
  // which entry is warm: a live-keyed prefetch during a past view would warm
  // the wrong key and the real read would miss anyway. A block that cannot
  // answer in the past throws here and the speculative fetch is simply not
  // made — the real read is what states the refusal.
  let key: string;
  try {
    key = readKey(block, opts.params);
  } catch {
    return;
  }
  const cached = cache.get(key);
  if (cached !== undefined && isFresh(cached, Date.now())) return;
  if (inflight.has(key)) return;
  void read(block, opts).catch(() => undefined);
}

/**
 * The cache key a read WILL use under the ambient head — the name a surface
 * stamps on the pixels it drew (`data-prov`, the LENS callout).
 *
 * A stamp built with `cacheKey` alone would name the LIVE entry while the
 * screen showed the past one, so the callout would explain a record the user
 * is not looking at. That is the same class of defect as fabricating the
 * value: a true-looking sentence about the wrong row.
 *
 * Never throws: a block that cannot answer in the past has no entry to name,
 * and the caller is naming, not fetching — the refusal belongs to `read`.
 */
export function readKey(
  block: string,
  params?: Readonly<Record<string, string>>,
): string {
  try {
    return cacheKey(block, paramsWithAsOf(block, params));
  } catch {
    return cacheKey(block, params);
  }
}

/**
 * The envelope meta of what the cache currently holds for `key` — above all
 * its `asOf`, the instant the SERVER produced the data.
 *
 * STALE-WHILE-REVALIDATE MAKES THIS LOAD-BEARING. Once a surface can be shown
 * a last-known value, "when was this true" stops being decoration and becomes
 * the thing that keeps the display honest. A surface that stamped
 * `Date.now()` on a value the Broker served from cache would be dating a
 * sixty-second-old number as this instant — a true value under a false
 * timestamp, which is the fabrication class this project bans, arrived at by
 * accident.
 *
 * So the age comes from the envelope, through this door, and never from the
 * moment the caller happened to receive the bytes. `undefined` when nothing is
 * cached under the key: no entry, no claim.
 */
export function readMeta(key: string): BlockResponse<unknown>["meta"] | undefined {
  return cache.get(key)?.response.meta;
}

/** Drop one block's cached entries (all params) — held refusals included:
 *  an action on the block may have changed the very condition behind them. */
export function invalidate(block: string): void {
  for (const key of [...cache.keys()]) {
    if (key === block || key.startsWith(`${block}?`)) cache.delete(key);
  }
  for (const key of [...refusals.keys()]) {
    if (key === block || key.startsWith(`${block}?`)) refusals.delete(key);
  }
}

/**
 * Subscribers to invalidation events — the client half of `invalidateOn`.
 *
 * Broker reads register their cache keys per event (the `invalidators` map
 * above); stores that live OUTSIDE the Broker (fed by `client.ts`) subscribe
 * here with a refresh function, so a state change reaches every surface that
 * displays it regardless of which door its data came through.
 *
 * Deliberately NOT cleared by `clearCache()`: these are standing
 * subscriptions ("when checks change, reload them"), not cached data. A
 * logout clears what is remembered, not what the app knows how to do.
 */
const invalidationListeners = new Map<string, Set<() => void>>();

/** Subscribe to an invalidation event. Returns the unsubscribe. */
export function onInvalidation(event: string, listener: () => void): () => void {
  let set = invalidationListeners.get(event);
  if (set === undefined) {
    set = new Set();
    invalidationListeners.set(event, set);
  }
  set.add(listener);
  return () => {
    invalidationListeners.get(event)?.delete(listener);
  };
}

/**
 * Fire an invalidation event: drop every cached read registered under it and
 * notify subscribers. Registrations are kept — a re-read re-registers anyway,
 * and deleting an already-absent cache key is free, so keeping them can only
 * ever drop MORE staleness, never less.
 */
export function fireInvalidation(event: string): void {
  const keys = invalidators.get(event);
  if (keys !== undefined) {
    for (const key of keys) {
      cache.delete(key);
      // The write that fired this event may have changed the condition a
      // held refusal rests on — the refusal's tenure ends with the data's.
      refusals.delete(key);
    }
  }
  for (const listener of invalidationListeners.get(event) ?? []) listener();
}

/**
 * MOVING THE HEAD RE-DATES EVERYTHING ON SCREEN.
 *
 * This is the half that was missing, and it is why "the timeline is not
 * working" was the honest report: planting a head changed the read PARAMETERS
 * but nothing asked for a re-read, so every surface kept its last live answer
 * and the banner said 16:00:53 over data from now.
 *
 * A head change is not like a normal invalidation — no single capability went
 * stale, the QUESTION changed for all of them at once — so every standing
 * refresh subscription is notified, whatever event it registered under. Each
 * feed then does what it always does: re-read, and render what comes back.
 * For a ranged block that is the state at the planted instant; for a block
 * that cannot answer in the past the Broker refuses and the feed renders the
 * honest absence.
 *
 * CACHED ENTRIES ARE DELIBERATELY NOT DROPPED. `until` is part of the cache
 * key, so the live entries and the past entries are different rows that
 * cannot be served for one another. Keeping the live rows is what makes
 * "return to now restores exactly the prior state" true rather than a
 * re-fetch that merely looks like it.
 *
 * ── THE SECOND CALLER: RECONNECTION ──
 *
 * Coming back from an outage is the same shape and therefore uses the same
 * mechanism, not a parallel one. A head move says "the QUESTION changed for
 * all of them at once"; a reconnection says "the ANSWERS may have changed
 * for all of them at once, because we could not ask". Both remedies are
 * identical: notify every standing refresh subscription, let each feed
 * re-read and render what comes back. That is why this function is named for
 * what it DOES rather than for the head, and why the connection owner was
 * given this and not a second refresh bus of its own.
 */
export function revalidateAll(): void {
  // DEDUPLICATED BY IDENTITY, and this is not a nicety. A feed commonly
  // registers ONE refresh function under several events (the desk registers
  // `refreshAllLoaded` under `compose:changed`, `tools:changed` and
  // `run:done`), and each of those refreshes FORCES its reads — which
  // bypasses the in-flight dedup on purpose. Calling the listener once per
  // event therefore opened three identical requests per head move; browser-
  // measured before this Set was added. One move, one re-read per feed.
  const called = new Set<() => void>();
  for (const listeners of invalidationListeners.values()) {
    for (const listener of listeners) {
      if (called.has(listener)) continue;
      called.add(listener);
      listener();
    }
  }
}

// Standing subscription, bound at module load for the same reason the
// provenance import is static: a wiring step that a surface has to remember
// is a wiring step that gets skipped, and the skipped case here is a screen
// that lies about what time it is showing. `listen` (not `subscribe`) so
// binding does not itself count as a head move.
asOfHead.listen(revalidateAll);

// THE CONNECTION OWNER'S REVALIDATION WIRE, bound at module load for exactly
// the reason above — and the skipped case here is a screen that reconnects
// and goes on showing what it knew while it was cut off.
//
// This is the ONLY thing the Broker hands the connection owner. Liveness
// itself is a held SSE socket opened by the application entry, not anything
// the Broker polls; see `src/data/connection.ts`. What the Broker still
// contributes is detection-on-use — every `fetchJson` above reports its own
// outcome — which is what makes an outage visible from any code path that
// talks to the server, whether or not the stream has noticed yet.
installConnectionRevalidation(revalidateAll);

/**
 * Perform a block ACTION — the single door for client-initiated writes.
 *
 * POST, always: the path comes from `blockActionPath`, so a client cannot
 * invoke a verb the server does not mount (an undeclared action 404s at the
 * route table, not at some handler's discretion). Input travels as the JSON
 * body and is validated server-side by the action's declared zod schema —
 * deny-by-default at the mount choke point, never here (a client-side
 * pre-check would be a second validator that can drift from the real one).
 *
 * WHAT SUCCESS MEANS MECHANICALLY
 *
 * An action that succeeds has changed state the block's reads display, so the
 * block's cached reads are dropped and the action's declared invalidation
 * events fire (`opts.invalidates`, straight from the declaration) — cached
 * data a successful action falsified must not outlive it. A FAILED action
 * invalidates nothing: nothing changed, and dropping caches would disguise
 * the failure as a refresh.
 *
 * Recorded in the action ledger either way, from the response envelope's own
 * causality — which is what lets LENS explain a result ("you, at 12:01,
 * trace …") exactly as it explains a value.
 */
export async function action<T>(
  block: string,
  actionName: string,
  input: Readonly<Record<string, unknown>> = {},
  opts: Readonly<{ invalidates?: readonly string[]; origin?: ActionOrigin }> = {},
): Promise<T> {
  // A PAST VIEW IS READ-ONLY (§6.2). Refused here, at the one write door, so
  // the guarantee does not depend on every surface remembering to disable
  // every button: a control that slipped through still cannot change the
  // world. Refused BEFORE the ledger record, because nothing happened —
  // recording a refused write would put an act in the record that never ran.
  assertLiveForWrite();
  const requestedAt = Date.now();
  try {
    const response = await fetchJson<BlockResponse<T>>(
      blockActionRequestPath(block, actionName),
      { method: "POST", body: JSON.stringify(input) },
    );
    recordAction({
      origin: opts.origin ?? "operator",
      block, action: actionName, state: "done",
      requestedAt, settledAt: Date.now(), meta: response.meta, input,
    });
    invalidate(block);
    for (const event of opts.invalidates ?? []) fireInvalidation(event);
    return response.data;
  } catch (err) {
    // A failed action is provenance too — and instrumentation must never
    // swallow an error, so it is rethrown unchanged.
    recordAction({
      origin: opts.origin ?? "operator",
      block, action: actionName, state: "failed",
      requestedAt, settledAt: Date.now(), input,
      errorCode: err instanceof ClientError ? err.code : "network",
    });
    throw err;
  }
}


/** Drop everything. Used on logout and on context switch.
 *
 *  `freshListeners` is deliberately NOT cleared, for the same reason
 *  `invalidationListeners` is not: a subscription is "when this key changes,
 *  patch these pixels", which is a capability, not remembered data. A logout
 *  clears what is known, not what the app knows how to do. */
export function clearCache(): void {
  cache.clear();
  refusals.clear();
  inflight.clear();
  generations.clear();
  invalidators.clear();
}
