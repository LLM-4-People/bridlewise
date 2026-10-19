/**
 * `defineBlock` — the ONLY way a capability enters the system.
 *
 * One declaration emits the route, its validation, its client binding, its
 * schema entry and its contract tests. Per the doctrine, if a capability can
 * reach the wire by another path, that other path is the defect — which is
 * what the `LEGACY_ROUTES` ratchet in `block-contract-owner.test.ts` exists
 * to drain.
 *
 * WHAT A BLOCK AUTHOR WRITES, AND WHAT THEY DO NOT
 *
 * They write: an id, a zod input schema, a zod output schema, and a handler.
 * They do NOT write: a route registration, a validation call, an error
 * mapping, a response envelope, a cache header, a client function, or a test
 * that the input rejects garbage. Those are derived here, uniformly, so they
 * cannot be forgotten or done differently twice.
 *
 * OWNERSHIP THIS DOES NOT TAKE
 *
 * `server/router.ts` remains the sole owner of auth, CSRF, rate limiting and
 * error→status mapping. Blocks register THROUGH the router and inherit all of
 * it; nothing here re-implements a guard. That boundary is deliberate: the
 * router is already the choke point every request crosses, and adding a
 * second one would be the exact duplication this contract exists to remove.
 *
 * THE `until` CONVENTION — ranged reads for the SWEEP head (asOf)
 *
 * DESIGN-COCKPIT-V2.md §6.2/§6.6: planting the sweep head sets a global
 * `asOf`, and every HISTORY-BEARING read renders its state at that instant.
 * The uniform, ADDITIVE read parameter for this is:
 *
 *     until?: epoch-milliseconds   (`RANGED_UNTIL_PARAM` below — reads
 *                                   arrive as query strings, so it coerces)
 *
 * Semantics every adopter follows identically:
 *   - INCLUSIVE upper bound on the event/record time the read may consider;
 *   - OMITTED means live ("now") — the parameter must never be required;
 *   - it bounds WHAT IS READ, never what is stored — no write path accepts it;
 *   - a block whose data has no history dimension (e.g. a next-turn
 *     projection) does NOT take the parameter, rather than accepting and
 *     ignoring it.
 * Ledger-backed blocks implement it by mapping to the store's `toWallTime`
 * (`new Date(until).toISOString()`). Adopted so far: `tools.breaker`,
 * `sweep.spectrum`, `arm.flags`. History-bearing blocks OWNED ELSEWHERE that
 * still need retrofitting by their owners: `lens.ancestry`, `lens.recorder`,
 * `coverage.darkfield`, `coverage.annunciator`, `synthesis.*`, `checks.auto`.
 *
 * @see shared/block-contract.ts — the wire shape
 * @see DESIGN-SPEC-BLOCKS-ADDENDUM
 */

import { z } from "zod";

import {
  blockActionPath,
  blockReadPath,
  type BlockActionDescriptor,
  type BlockActionsManifest,
  type BlockDescriptor,
  type BlockMeta,
  type BlockReadSpec,
  type BlockRefusal,
  type BlockResponse,
} from "../../shared/block-contract.ts";
import { PRINCIPLED_REFUSAL_STATUSES } from "../../shared/errors.ts";

import {
  currentRecordingContext,
  isValidExposureId,
  randomUuid,
  recordEffectAsync,
  withSpan,
} from "../kernel/canonical.ts";
import { BadRequestError, ConflictError, WebError } from "../kernel/errors.ts";
import type { RouteContext, Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";

/** What a handler receives: validated input plus the raw route context. */
export type BlockHandlerContext = Readonly<{
  /** The originating route context — session, req/res, raw query. */
  ctx: RouteContext;
}>;

/**
 * THE `until` PARAM, declared ONCE (the ranged-read convention above). Every
 * history-bearing block's read schema consumes THIS value instead of
 * restating a zod expression — one declaration, so the convention cannot
 * drift per block.
 *
 * Sub-millisecond precision is part of the contract, not a tolerance: the
 * planted sweep head is a position on the band, computed between recorded
 * instants, and arrives as a FRACTIONAL epoch (measured live:
 * `until=1787826816836.9668`). An integer-only schema refused the client's
 * own head as a malformed request — a typed 400 logged as a browser console
 * error on every past view, for a read the block was built to answer. The
 * bound is a time comparison; the comparison does not care about the
 * fraction, so the schema accepts any positive epoch-ms number. Garbage
 * still refuses (coerce), and the read stays an INCLUSIVE upper bound.
 */
export const RANGED_UNTIL_PARAM = z.coerce.number().positive();


/** A block's read side: validated input → output. */
export type BlockRead<I, O> = Readonly<{
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler: (input: I, ctx: BlockHandlerContext) => O | Promise<O>;
}> &
  BlockReadSpec;

/**
 * One named action on a block. Always POST.
 *
 * `title` and `consequence` are REQUIRED: they are the words a surface
 * renders on the affordance, and an action declared without its language
 * would force every surface to invent a label — which is how twelve controls
 * come to say twelve different things about one verb. Declaring the handler
 * and the sentence together is what keeps them true of each other.
 */
export type BlockAction<I, O> = Readonly<{
  input: z.ZodType<I>;
  output?: z.ZodType<O>;
  /** Plain-language verb for the control, e.g. `"Run again"`. */
  title: string;
  /** Full sentence: what invoking this does and when it takes effect. */
  consequence: string;
  /** Input template for zero-knowledge surfaces (`$sel.<key>` grammar). */
  params?: Readonly<Record<string, string>>;
  /** Invalidation events this action fires on success (client-consumed). */
  invalidates?: readonly string[];
  handler: (input: I, ctx: BlockHandlerContext) => O | Promise<O>;
}>;

/** The declaration an author writes. */
export type BlockDefinition = Readonly<{
  /** `namespace.name`, e.g. `"code.graph"`. The route derives from it. */
  id: string;
  title: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous per block
  read?: BlockRead<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous per action
  actions?: Readonly<Record<string, BlockAction<any, any>>>;
  /** Exposure registry ids this block surfaces. */
  signals?: readonly string[];
  customizations?: readonly string[];
}>;

/** A registered block: its definition plus its derived descriptor. */
export type RegisteredBlock = Readonly<{
  definition: BlockDefinition;
  descriptor: BlockDescriptor;
}>;

const blocks = new Map<string, RegisteredBlock>();

/** The module segment of a block id (`code.graph` → `code`). */
function moduleOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * Declare a capability.
 *
 * Validation here is deny-by-default and deliberately strict: an id that does
 * not match the shared exposure grammar, a block with neither a read nor an
 * action, or a duplicate registration all throw at startup rather than
 * producing a route that silently does nothing.
 */
export function defineBlock(definition: BlockDefinition): RegisteredBlock {
  const { id } = definition;
  if (!isValidExposureId(id)) {
    throw new BadRequestError(
      `block: invalid id "${id}" (expected namespace.name)`,
      "invalid_block_id",
    );
  }
  if (definition.title.length === 0 || definition.description.length === 0) {
    throw new BadRequestError(`block "${id}" needs a title and description`, "invalid_block_id");
  }
  const actionNames = Object.keys(definition.actions ?? {});
  if (definition.read === undefined && actionNames.length === 0) {
    throw new BadRequestError(
      `block "${id}" declares neither a read nor an action`,
      "invalid_block_id",
    );
  }
  // Deny-by-default on the affordance language, at startup: an action whose
  // name cannot form a route segment, or that arrives without the words a
  // surface must render, is refused before it can mount — a control with no
  // declared meaning must not exist rather than exist blank.
  for (const [name, act] of Object.entries(definition.actions ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) {
      throw new BadRequestError(
        `block "${id}": action name "${name}" is not a valid route segment`,
        "invalid_block_id",
      );
    }
    if (act.title.trim().length === 0 || act.consequence.trim().length === 0) {
      throw new BadRequestError(
        `block "${id}": action "${name}" needs a title and a consequence sentence`,
        "invalid_block_id",
      );
    }
  }
  if (blocks.has(id)) {
    throw new ConflictError(`block "${id}" already registered`);
  }

  const actionDescriptors: readonly BlockActionDescriptor[] = Object.freeze(
    Object.entries(definition.actions ?? {}).map(([name, act]) =>
      Object.freeze({
        name,
        title: act.title,
        consequence: act.consequence,
        ...(act.params !== undefined ? { params: act.params } : {}),
        ...(act.invalidates !== undefined ? { invalidates: act.invalidates } : {}),
      }),
    ),
  );

  const descriptor: BlockDescriptor = Object.freeze({
    id,
    module: moduleOf(id),
    title: definition.title,
    description: definition.description,
    hasRead: definition.read !== undefined,
    actions: Object.freeze([...actionNames]),
    ...(actionDescriptors.length > 0 ? { actionDescriptors } : {}),
    ...(definition.read !== undefined
      ? {
          read: Object.freeze({
            ttlMs: definition.read.ttlMs,
            invalidateOn: definition.read.invalidateOn,
            page: definition.read.page,
            priority: definition.read.priority,
            redact: definition.read.redact,
          }) as BlockReadSpec,
        }
      : {}),
    ...(definition.signals !== undefined ? { signals: definition.signals } : {}),
    ...(definition.customizations !== undefined
      ? { customizations: definition.customizations }
      : {}),
  });

  const registered: RegisteredBlock = Object.freeze({ definition, descriptor });
  blocks.set(id, registered);
  return registered;
}

/** All registered blocks, in registration order. */
export function listBlocks(): readonly RegisteredBlock[] {
  return Array.from(blocks.values());
}

/**
 * The action manifest a client renders affordances from: block id → declared
 * action descriptors, DERIVED from the registry so a surface cannot offer a
 * verb no handler serves. Blocks without actions are omitted entirely — an
 * empty list per read-only block would invite "0 actions" chrome.
 */
export function blockActionsManifest(): BlockActionsManifest {
  const out: Record<string, readonly BlockActionDescriptor[]> = {};
  for (const { descriptor } of listBlocks()) {
    if (descriptor.actionDescriptors !== undefined && descriptor.actionDescriptors.length > 0) {
      out[descriptor.id] = descriptor.actionDescriptors;
    }
  }
  return Object.freeze(out);
}



/** Test seam: drop every registration. */
export function clearBlocks(): void {
  blocks.clear();
}

/**
 * Causal identity, read from the ambient recording context.
 *
 * WHY AMBIENT AND NOT A PARAMETER
 *
 * A parameter can be passed wrongly, and it can be forgotten — and a
 * provenance system that can be forgotten is a provenance system that is
 * absent exactly when someone needed it. `server/router.ts` already enters a
 * recording context for EVERY request, so by the time a handler returns the
 * actor is known without anyone threading it. This function only reads.
 *
 * ABSENCE IS PRESERVED, NEVER DEFAULTED
 *
 * A missing trace id yields NO `traceId` key rather than an empty string or a
 * freshly-minted id. A synthesised trace would point at nothing in
 * `event_log` while looking exactly like one that points at something — the
 * single worst lie this envelope could tell. `unattributed:unknown` is the one
 * "default" that survives, and only because the harness chose it precisely to
 * be a visible admission that something recorded outside any boundary.
 */
function ambientCausality(): Readonly<{ actor?: string; traceId?: string }> {
  const ctx = currentRecordingContext();
  if (ctx === undefined) return {};
  const actor = ctx.actor;
  return {
    ...(actor.id.length > 0 ? { actor: `${actor.kind}:${actor.id}` } : {}),
    ...(ctx.traceId !== undefined && ctx.traceId.length > 0 ? { traceId: ctx.traceId } : {}),
  };
}

/**
 * Build the uniform response envelope.
 *
 * The etag is derived from the payload so conditional requests work without
 * each block inventing a versioning scheme. It is a content hash, not a
 * timestamp: two identical payloads produce the same tag, which is what makes
 * `If-None-Match` actually save a transfer.
 *
 * `extra` CANNOT carry causality, and that is enforced twice. The parameter
 * type excludes the causal fields, so an attempt to pass one is a compile
 * error; and they are stripped at runtime as well, so a cast or a JavaScript
 * caller cannot sneak past the type. Ordering alone was not enough — with no
 * ambient context there is nothing to overwrite a forged value WITH, so a
 * spread-last would have let `extra` supply causality precisely in the case
 * where the server knows least. That hole was found by its own test.
 */
export function envelope<T>(
  data: T,
  extra?: Partial<Omit<BlockMeta, "actor" | "traceId" | "eventId">>,
): BlockResponse<T> {
  const serialized = JSON.stringify(data) ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Runtime strip — the second lock. `extra` is typed to exclude these, so
  // reaching this code means someone cast around the type.
  const safeExtra: { -readonly [K in keyof BlockMeta]?: BlockMeta[K] } = { ...extra };
  delete safeExtra.actor;
  delete safeExtra.traceId;
  delete safeExtra.eventId;

  return Object.freeze({
    data,
    meta: Object.freeze({
      etag: `W/"${hash.toString(16)}"`,
      asOf: Date.now(),
      ...safeExtra,
      ...ambientCausality(),
    }),
  });
}

/** Turn a URLSearchParams into a plain object for schema parsing. */
function queryToObject(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of query.entries()) out[k] = v;
  return out;
}

/**
 * A PRINCIPLED REFUSAL, as the read route serves it — or null when the error
 * is a real failure and must keep its error status.
 *
 * The family is the typed 428/503 WebErrors (shared/errors.ts owns the pair):
 * a typed class carrying a typed code and the server's own sentence, thrown
 * ON PURPOSE — `git_not_run` self-protection, `provider_not_configured`
 * guided state. Everything else (a 500, an untyped throw, a zod 400) stays
 * an error: this door exists so a DESIGNED refusal stops surfacing as a
 * browser console error at every boot, and widening it by one status would
 * swallow real failures into looking like answers.
 */
export function principledRefusalOf(err: unknown): BlockRefusal | null {
  if (!(err instanceof WebError)) return null;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (
    typeof status !== "number" ||
    !(PRINCIPLED_REFUSAL_STATUSES as readonly number[]).includes(status)
  ) {
    return null;
  }
  // The refusal's own subject, when it has one: `chat_run_live` names the run
  // that is already live so the client can adopt it (open its stream, plant
  // its view) and the sentence's steer remedy names a reachable run. Copied
  // at this one builder so every door that serves the envelope — the run
  // start route, the block reads — serves the same fact, and a refusal with
  // nothing to name stays exactly as it was.
  const liveRunId = (err as { liveRunId?: unknown }).liveRunId;
  return Object.freeze({
    code: err.code,
    message: err.message,
    status: status as BlockRefusal["status"],
    ...(typeof liveRunId === "string" && liveRunId.length > 0 ? { liveRunId } : {}),
  });
}

/**
 * Validate input, throwing a typed 400 on failure.
 *
 * Every block gets identical input handling: a malformed request is always a
 * `400` with a typed code, never a `500` from an unguarded handler. That
 * uniformity is what lets the generated contract tests assert it once for
 * every block rather than per route.
 */
function parseInput<I>(schema: z.ZodType<I>, raw: unknown, id: string): I {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BadRequestError(`block "${id}": ${detail}`, "invalid_block_input");
  }
  return result.data;
}

/**
 * Mount every registered block on the router.
 *
 * Reads are GET (so they are exempt from the rate limiter, which charges
 * mutations only) and actions are POST (so CSRF and rate limiting apply
 * without a per-verb table). Both inherit the router's auth gate.
 */
/**
 * Run one block's work inside a span, so its causality is real.
 *
 * The router already enters a recording context per request, which supplies
 * the ACTOR. It does not open a span, so without this every block response
 * would carry an actor and no trace — and a trace id is the join key between
 * a value on screen and the `event_log` rows that explain it. `withSpan` also
 * means anything the handler records inherits this trace, so "everything that
 * happened while producing this value" is a single query rather than a guess.
 *
 * The span id is a UUID rather than the `kind:name:counter` label
 * `recordEffect` uses. A counter restarts with the process, so two runs would
 * mint the same id and silently merge two unrelated causal chains — a
 * collision that reads as a real relationship. An id that lands in a database
 * has to be unique for longer than a process lives.
 */
function inBlockSpan<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(`block:${id}:${randomUuid()}`, fn);
}

export function mountBlockRoutes(router: Router): void {
  for (const { definition, descriptor } of listBlocks()) {
    const { id } = definition;

    if (definition.read !== undefined) {
      const read = definition.read;
      router.get(blockReadPath(id), async (ctx: RouteContext) => {
        const input = parseInput(read.input, queryToObject(ctx.query), id);
        // The envelope is built INSIDE the span: it reads the ambient context,
        // so building it outside would step back out of the trace it is
        // meant to report and every response would lose its trace id.
        await inBlockSpan(id, async () => {
          try {
            const data = await read.handler(input, { ctx });
            sendJson(ctx.res, envelope(data));
          } catch (err) {
            // A PRINCIPLED REFUSAL IS AN ANSWER, not a failure: a typed 428/503
            // the server raised on purpose, with its own sentence. It travels
            // in the 200 envelope as data so the browser does not log a
            // standing console error for a designed refusal (the browser logs
            // the status itself, before any page code runs) — the 202
            // "indexing" contract's sibling. The client's Broker reconstructs
            // the typed error at its single read door, so every consumer sees
            // the refusal it always saw. Everything else propagates to the
            // router's error mapping untouched.
            const refusal = principledRefusalOf(err);
            if (refusal !== null) {
              sendJson(ctx.res, { ...envelope(null), refusal });
              return;
            }
            throw err;
          }
        });
      });
    }

    for (const [name, action] of Object.entries(definition.actions ?? {})) {
      router.post(blockActionPath(id, name), async (ctx: RouteContext) => {
        // Validation happens BEFORE the effect record: a request refused for
        // malformed input performed no work, and recording it as a failed
        // effect would fill the ledger with things that never happened.
        const input = parseInput(action.input, ctx.body ?? {}, `${id}/${name}`);
        await inBlockSpan(`${id}/${name}`, async () => {
          // The effect wrapper is the recording choke point for EVERY block
          // action: performing the verb IS recording it, with the actor from
          // the router's ambient boundary and the trace from the block span.
          // A handler cannot opt out, which is the whole point — an action
          // that ran with no ledger row would be a state change the system
          // cannot explain. Errors propagate unchanged (recorded as a failed
          // effect first), so the router's error mapping is untouched.
          try {
            const data = await recordEffectAsync("action", `${id}/${name}`, () =>
              Promise.resolve(action.handler(input, { ctx })),
            );
            sendJson(ctx.res, envelope(data));
          } catch (err) {
            // A PRINCIPLED REFUSAL IS AN ANSWER HERE TOO, for the same
            // reason it is on the read door above: a typed 428/503 the
            // server raised ON PURPOSE, with its own sentence, is a designed
            // refusal the client expects to render (a settings write the
            // declared bounds declined — the sheet answers the Save press
            // with the sentence), and the browser logs every non-2xx STATUS
            // itself, before any page code runs. So the refusal travels in
            // the 200 envelope as data and the client's single fetch door
            // reconstructs the typed error. The failed-effect record above
            // has already been written — a refused action performed no work,
            // and the ledger says so. Everything else propagates untouched.
            const refusal = principledRefusalOf(err);
            if (refusal !== null) {
              sendJson(ctx.res, { ...envelope(null), refusal });
              return;
            }
            throw err;
          }
        });
      });
    }

    void descriptor;
  }
}

