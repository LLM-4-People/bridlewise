/**
 * The BLOCK contract — one declaration emits every projection.
 *
 * A Block is the single unit of backend capability. From one declaration the
 * system derives the route, its validation, its client binding, its schema
 * entry and its contract tests. There is no second way to add an API.
 *
 * WHAT THIS REPLACES
 *
 * Measured before this landed, each capability was four hand-maintained
 * artifacts: a route registration (102 of them across 27 files), inline zod
 * validation (121 usages), a client function (93 exports in a 2,458-line
 * `client.ts`), and a bespoke panel. 102 routes against 93 client functions
 * means they had already drifted — some routes had no client, some clients
 * did things no single route did.
 *
 * THE ENVELOPE IS THE POINT
 *
 * Every block read answers in the same shape. Because the shape is uniform,
 * the Broker implements caching, conditional requests, in-flight dedup,
 * superseded-request cancellation, batch coalescing, cursor pagination and
 * prefetch ONCE, for every capability. Adding those per-endpoint across 93
 * functions is precisely why none of them exist today.
 *
 * @see DESIGN-SPEC-BLOCKS-ADDENDUM
 */

// Type-only import from the harness, which OWNS the exposure vocabulary.
// `import type` is erased at compile time, so this adds no runtime dependency
// and no bundle weight — but it keeps ONE definition of the metadata rather
// than a web-side mirror that could drift from the registry it describes.
import type { ExposureContract } from "../engine/src/shared/exposure/contract.ts";
// The principled-refusal status family (428/503) — the taxonomy owns it, and
// this wire type derives from it rather than restating the pair.
import type { PrincipledRefusalStatus } from "./errors.ts";

/**
 * Response metadata carried by every block read.
 *
 * CAUSALITY TRAVELS IN THE ENVELOPE
 *
 * The last three fields are what let the client explain a value rather than
 * merely display it. They are populated in `envelope()` from the AMBIENT
 * recording context and are never accepted as a parameter — a value a caller
 * can supply is a value a caller can supply wrongly, and the point of ambient
 * attribution is that it can be neither forged nor forgotten.
 *
 * All three are optional, and their absence is meaningful: it says the server
 * genuinely did not know, not that it declined to say. A consumer must render
 * absence as absence. Synthesising a plausible id here would convert an
 * architectural gap into a false assurance, which is worse than the gap.
 *
 * @see server/blocks/define.ts — `ambientCausality()`, the single populator
 * @see shared/provenance.ts — `readEnvelopeCausality()`, the single reader
 */
export type BlockMeta = Readonly<{
  /** Entity tag for conditional requests. */
  etag: string;
  /** When the data was produced (epoch ms). */
  asOf: number;
  /** Opaque cursor for the next page, when paginated and more remains. */
  cursor?: string;
  /** True when the payload is a partial/degraded answer rather than complete. */
  partial?: boolean;

  /**
   * `actor_kind:actor_id` of whoever caused this work — the authenticated
   * user for a normal request, `anonymous` for an unauthenticated one, and
   * `unattributed:unknown` for anything that ran outside a recording
   * boundary (a visible admission of a wiring bug, not a plausible default).
   */
  actor?: string;

  /**
   * Ledger `trace_id` shared by every event recorded while producing this
   * value. This is the join key between a value on screen and the rows in
   * `event_log` that explain it.
   */
  traceId?: string;

  /**
   * Ledger `event_id` of the event this response was produced by.
   *
   * PERMANENTLY ABSENT for block reads, by decision rather than by omission.
   *
   * A block read appends no ledger event, so there is no id to carry. A span
   * id is a call-structure label (`block:code.graph:<uuid>`), NOT a foreign
   * key into `event_log`, and deriving one from the other is exactly the
   * conflation the timeline recorder refuses to make.
   *
   * CARRYING IT AMBIENTLY WAS INVESTIGATED AND REJECTED. Adding `eventId` to
   * `RecordingContext` would not unblock anything — a read still appends no
   * event, so `meta.eventId` would stay absent for precisely the responses
   * this feature is entered from. And it would actively corrupt causality:
   * `amendRecordingContext` uses `storage.enterWith`, which persists for the
   * remainder of the boundary, so sequential SIBLING appends would each
   * become the child of the previous one. `server/routes/run.ts` records
   * turn → message → usage and deliberately parents `usage` to the run event,
   * not to the message; ambient carriage would silently overwrite that with a
   * false linear chain. A plausible-looking parent is worse than a null,
   * because a null is visibly missing and a wrong parent is not.
   *
   * If it is ever needed it must be a SCOPED `withEventContext(eventId, fn)`,
   * nested like `withSpan` and entered only by a call site holding a row it
   * actually inserted — never an amend that leaks past its own append.
   *
   * Layer 2 is entered by `traceId` instead, which the envelope carries
   * truthfully. A test asserts this field stays absent, so the gap cannot be
   * quietly filled with a synthetic id.
   */
  eventId?: string;
}>;

/** The one response shape. Uniform so the Broker is capability-agnostic. */
export type BlockResponse<T> = Readonly<{
  data: T;
  meta: BlockMeta;
  /**
   * A PRINCIPLED REFUSAL, as data — present exactly when the block DECLINED
   * the read on purpose (a typed 428/503 refusal: `git_not_run` for a
   * self-protected project, `provider_not_configured` for a guided state).
   *
   * A refusal is an ANSWER, not a transport failure: it is deterministic,
   * it carries the server's own sentence, and the response grammar renders
   * it as the REFUSED state. Serving it in the 200 envelope (instead of an
   * error status) is what keeps a DESIGNED refusal from surfacing as a
   * browser console error on every boot — the browser logs the status
   * itself, before any page code runs, and no client code can unsay it.
   * This is the 202 "indexing" contract's sibling: a designed non-answer
   * travels as data.
   *
   * `data` is null when a refusal is present — nothing was measured. The
   * client's Broker reconstructs the typed error at its single read door, so
   * every consumer (refusal rendering, refusal-holding, absence wording)
   * sees the same typed refusal it always saw. UNTYPED failures (a 500, a
   * proxy outage, a dropped socket) are NOT refusals and keep their error
   * statuses — this field is for the typed refusal family only.
   */
  refusal?: BlockRefusal;
}>;

/** One typed refusal, as it travels in the envelope. */
export type BlockRefusal = Readonly<{
  /** The typed code (`git_not_run`, `provider_not_configured`, …). */
  code: string;
  /** The server's own sentence, with its remedy. */
  message: string;
  /** The status this refusal carries as an error response — 428 or 503. */
  status: PrincipledRefusalStatus;
  /**
   * For `chat_run_live` only: the id of the run the refusal is ABOUT — the
   * run that is already live in this conversation. A fact naming the
   * refusal's own subject, never a success payload: a refused start
   * started nothing, and this field says so by naming the run that DID.
   * The client uses it to adopt the live run (open its stream, plant its
   * view) so the refusal's remedy — "steer it with your next message" —
   * names something the composer can actually reach; without it, a run the
   * client did not start is invisible and unsteerable from the cockpit.
   */
  liveRunId?: string;
}>;

/**
 * A targeted change to a block's data.
 *
 * Deltas travel in ONE shape so no capability invents its own. This is what
 * makes "only what changed updates" a property of the pipeline rather than
 * something each screen hand-optimises — which is why it has never been done
 * before: per-screen it is never worth it, and uniformly it is written once.
 *
 * Three operations, deliberately not a full JSON Patch implementation: the
 * machinery budget says custom mechanisms must retire more than they add.
 */
export type PatchOp =
  | Readonly<{ op: "set"; path: string; value: unknown }>
  /** Used for token streaming — appends without rewriting the container. */
  | Readonly<{ op: "append"; path: string; value: unknown }>
  | Readonly<{ op: "remove"; path: string }>;

export type BlockPatch = Readonly<{
  /** Block id the patch applies to. */
  block: string;
  /** Serialised params identifying the cache entry, when parameterised. */
  params?: string;
  ops: readonly PatchOp[];
  asOf: number;
}>;

/** Fetch priority; governs batching and prefetch order. */
export const READ_PRIORITIES = ["critical", "visible", "idle"] as const;
export type ReadPriority = (typeof READ_PRIORITIES)[number];

/**
 * Declarative description of a block's read side.
 *
 * The handler and schemas are server-only values; this type describes the
 * SHAPE both sides agree on. The client never imports handlers — it imports
 * the block id and the output type.
 */
export type BlockReadSpec = Readonly<{
  /** Cache lifetime in ms. */
  ttlMs?: number;
  /** Bus events that invalidate cached responses. */
  invalidateOn?: readonly string[];
  /** Cursor pagination settings. */
  page?: Readonly<{ limit: number; cursorParam: string }>;
  priority?: ReadPriority;
  /**
   * Opt OUT of response redaction. Deny-by-default: redaction applies unless
   * a block states otherwise, and a prevention test enumerates the exceptions
   * so `redact: false` is always a visible, reviewed decision rather than an
   * omission.
   */
  redact?: false;
}>;

/**
 * What one block action publishes about itself — the affordance a surface
 * renders, verbatim.
 *
 * `title` and `consequence` are DECLARED next to the handler, not authored in
 * a component, so the words a user reads come from the one place that knows
 * what the verb actually does. A surface may not invent, translate or
 * embellish them: rendering a verb the declaration does not carry is the
 * action-side form of fabricating data.
 *
 * `consequence` is a plain sentence stating what pressing the control does
 * AND when it takes effect — unknown-timing honesty applies: if the effect
 * lands later ("on your next run"), the sentence says so rather than
 * implying immediacy.
 */
export type BlockActionDescriptor = Readonly<{
  /** Action name — the final path segment of `blockActionPath`. */
  name: string;
  /** Plain-language verb shown on the control, e.g. `"Run again"`. */
  title: string;
  /** Full sentence: what this does and when it takes effect. */
  consequence: string;
  /**
   * Declared input template for a zero-knowledge surface: `$sel.<key>` values
   * resolve from the selection bus exactly as a read source's `params` do
   * (same grammar, same resolver — `resolveParams`). A surface that cannot
   * resolve every reference must NOT offer the verb: an affordance whose
   * input cannot be built is an inert control wearing a working one's label.
   * Absent when the action needs input no generic surface can supply — such
   * an action is invoked by a bespoke caller, not rendered from this field.
   */
  params?: Readonly<Record<string, string>>;
  /**
   * Bus events this action makes stale on success — the write-side twin of a
   * read's `invalidateOn`. A client that performs the action drops every
   * cached read registered under these events, so a value on screen cannot
   * outlive the state change that falsified it.
   */
  invalidates?: readonly string[];
}>;

/**
 * The per-block action manifest a client can render affordances from:
 * block id → its declared actions. Derived from the registry, never authored,
 * so a surface cannot offer a verb no handler serves.
 */
export type BlockActionsManifest = Readonly<
  Record<string, readonly BlockActionDescriptor[]>
>;

/** The metadata a block publishes about itself, mirroring the exposure vocabulary. */
export type BlockDescriptor = Readonly<{
  /** `namespace.name`, e.g. `"code.graph"`. The route derives from it. */
  id: string;
  /** Owning module id. */
  module: string;
  title: string;
  description: string;
  /** Whether the block has a read side. */
  hasRead: boolean;
  /** Names of the block's actions, if any. */
  actions: readonly string[];
  /** Full affordance descriptors for those actions, same order as `actions`. */
  actionDescriptors?: readonly BlockActionDescriptor[];
  /** Read-side settings, when the block reads. */
  read?: BlockReadSpec;
  /** Exposure registry ids this block surfaces. */
  signals?: readonly string[];
  customizations?: readonly string[];
  /** Shared metadata: determinism, effect timing, audience, visibility. */
  contract?: ExposureContract;
}>;

// ── Route derivation — one function, both sides ────────────────────────────

/** Prefix for every generated block route. */
export const BLOCK_ROUTE_PREFIX = "/api/b";

/**
 * The GET path for a block's read side. Derived, never authored, so a client
 * binding cannot point at a path the server does not serve.
 */
export function blockReadPath(id: string): string {
  return `${BLOCK_ROUTE_PREFIX}/${id}`;
}

/**
 * The POST path for one of a block's actions.
 *
 * Actions are always POST. REST verb semantics (PATCH/DELETE) are
 * deliberately not used: a named action carries intent that a verb cannot
 * ("rollback", "duplicate", "reindex"), and one method keeps the CSRF and
 * rate-limit story uniform — POST is unsafe, so both apply without a
 * per-verb table.
 */
export function blockActionPath(id: string, action: string): string {
  return `${BLOCK_ROUTE_PREFIX}/${id}/${action}`;
}

/** Whether a path belongs to the generated block surface. */
export function isBlockPath(path: string): boolean {
  return path.startsWith(`${BLOCK_ROUTE_PREFIX}/`);
}

/**
 * Parse a block route back into its parts. Returns `undefined` for a
 * non-block path, or when the id/action segments are malformed.
 */
export function parseBlockPath(
  path: string,
): Readonly<{ id: string; action?: string }> | undefined {
  if (!isBlockPath(path)) return undefined;
  const rest = path.slice(BLOCK_ROUTE_PREFIX.length + 1);
  if (rest.length === 0) return undefined;
  const parts = rest.split("/");
  const id = parts[0];
  if (id === undefined || id.length === 0) return undefined;
  if (parts.length === 1) return { id };
  const action = parts[1];
  if (parts.length > 2 || action === undefined || action.length === 0) return undefined;
  return { id, action };
}
