/**
 * The PROVENANCE contract — the shape of "where did this value come from".
 *
 * WHY THIS EXISTS
 *
 * Three facts already hold in this system that do not hold in a normal app:
 * recording is structurally unavoidable (`recordEffect` + the ambient
 * `AsyncLocalStorage` context), data origin is DECLARED rather than
 * conventional (`SourceBinding.block`, `BlockResponse.meta`), and causality is
 * recorded (`trace_id` / `parent_event_id` on `event_log`). Together they make
 * a fourth thing possible: the running app can explain any value on screen.
 *
 * This module owns the VOCABULARY for that explanation and every pure
 * function over it. It holds no state, touches no DOM and performs no I/O, so
 * every rule below is unit-testable without a browser and both sides of the
 * wire agree on one definition.
 *
 * THE ONE RULE THAT OUTRANKS THE REST
 *
 * LENS may never invent an origin. A value with no declared source must
 * report `absent` — loudly — rather than a plausible guess. A provenance
 * display that fabricates is worse than no provenance display at all, because
 * it converts an architectural hole into a false assurance. Every type here is
 * built so that "unknown" is representable and distinguishable from "known";
 * there is no field whose absence is papered over with a default.
 *
 * @see src/data/broker.ts — the single choke point that produces records
 * @see server/blocks/provenance.ts — the causal-ancestry read
 */

// ── The DOM binding ────────────────────────────────────────────────────────

/**
 * The attribute that binds a rendered subtree to its provenance.
 *
 * A plain `data-*` attribute was chosen over a Svelte action deliberately. The
 * action would have to be imported, invoked and torn down at every binding
 * site to achieve exactly what `data-prov={key}` achieves with no import, no
 * lifecycle object and no per-node allocation — and it would still be one
 * edit per site, so it buys no reduction in maintenance surface. The
 * attribute is also inspectable in devtools and survives a component rewrite,
 * which an action does not. Doctrine 11: prefer the simple built-in
 * mechanism.
 *
 * Resolution walks ANCESTORS, so one stamp covers a whole subtree: the
 * binding surface is one attribute per data-bound region, not one per value.
 */
export const PROVENANCE_ATTR = "data-prov";

/** The CSS selector form of the binding attribute. Derived, never authored. */
export const PROVENANCE_SELECTOR = `[${PROVENANCE_ATTR}]`;

// ── Cache state ────────────────────────────────────────────────────────────

/**
 * What the Broker did to answer a read.
 *
 * These are the only five things the Broker can truthfully report, and each
 * corresponds to a distinct branch in `broker.read`. `revalidating` is a live
 * state (a conditional request is open for a key that already has a cached
 * answer); it is not a summary of the past. `refused` is a HELD principled
 * refusal: the server declined this read on purpose (a typed 428/503 with
 * its own sentence), and the Broker answers from that standing refusal —
 * without a network trip — until something changes (an invalidation, a
 * forced retry, a context switch).
 */
export const CACHE_STATES = ["fresh", "cached", "revalidating", "failed", "refused"] as const;
export type CacheState = (typeof CACHE_STATES)[number];

// ── Causality carried by the envelope ──────────────────────────────────────

/**
 * The causal identity of a response, when the server chose to carry it.
 *
 * Every field is optional because the envelope does not carry them TODAY (see
 * `BlockMeta`, which declares only `etag`/`asOf`/`cursor`/`partial`). That is
 * an honest gap, not a placeholder: when the meta grows these fields, LENS
 * picks them up with no client change; until then LENS reports that the
 * causal id was not carried rather than inventing one.
 */
export type EnvelopeCausality = Readonly<{
  /** Ledger `trace_id` for the whole causal chain. */
  traceId?: string;
  /** Ledger `event_id` of the event this response was produced by. */
  eventId?: string;
  /** `actor_kind:actor_id` of whoever caused the work. */
  actor?: string;
}>;

/**
 * Extract causal ids from an arbitrary envelope `meta`, without fabricating.
 *
 * Deny-by-default: a field is carried through ONLY when it is a non-empty
 * string. A number, a null, an empty string or a missing key all resolve to
 * `undefined`, which LENS renders as "not carried" — never as a blank that
 * could be mistaken for a real value.
 */
export function readEnvelopeCausality(meta: unknown): EnvelopeCausality {
  if (typeof meta !== "object" || meta === null) return Object.freeze({});
  const m = meta as Record<string, unknown>;
  const out: { traceId?: string; eventId?: string; actor?: string } = {};
  const traceId = m["traceId"];
  const eventId = m["eventId"];
  const actor = m["actor"];
  if (typeof traceId === "string" && traceId.length > 0) out.traceId = traceId;
  if (typeof eventId === "string" && eventId.length > 0) out.eventId = eventId;
  if (typeof actor === "string" && actor.length > 0) out.actor = actor;
  return Object.freeze(out);
}

// ── The record ─────────────────────────────────────────────────────────────

/**
 * One answered read, as the Broker saw it.
 *
 * This is produced at the choke point and never by a call site. A call site
 * that could pass provenance in could also pass it in WRONG, or forget — the
 * exact "remember to code it" failure the architecture exists to eliminate.
 */
export type ProvenanceRecord = Readonly<{
  /** Broker cache key — `block` or `block?a=1&b=2`. The binding identity. */
  key: string;
  /** Registered block id that produced the value, e.g. `"code.graph"`. */
  block: string;
  /** The params the read was issued with, already normalised into the key. */
  params?: Readonly<Record<string, string>>;
  /** What the Broker did to answer. */
  cacheState: CacheState;
  /** Epoch ms when the read was issued. */
  requestedAt: number;
  /** Epoch ms when the read settled. Equal to `requestedAt` for a cache hit. */
  settledAt: number;
  /** Wall-clock cost of the read in ms. Zero for a cache hit — truthfully. */
  latencyMs: number;
  /**
   * `meta.asOf` — when the SERVER produced the data. This, not `settledAt`, is
   * what age must be measured from: a cache hit at t+60s still describes data
   * produced at t, and showing the hit time would hide exactly the staleness
   * LENS exists to reveal.
   */
  asOf?: number;
  etag?: string;
  /** True when the server marked the payload partial/degraded. */
  partial?: boolean;
  /** The TTL this read was governed by; staleness is measured against it. */
  ttlMs: number;
  /** Causal ids, when the envelope carried them. */
  causality: EnvelopeCausality;
  /** Typed error code when `cacheState === "failed"`. */
  errorCode?: string;
}>;

/**
 * Build a record. The ONLY constructor — freezing here means no consumer can
 * mutate a record after the fact and no consumer has to remember to freeze.
 */
export function makeProvenanceRecord(
  input: Readonly<{
    key: string;
    block: string;
    // `| undefined` is explicit because `exactOptionalPropertyTypes` is on:
    // the Broker passes `opts.params` straight through, and that value is
    // legitimately `undefined` for a parameterless read.
    params?: Readonly<Record<string, string>> | undefined;
    cacheState: CacheState;
    requestedAt: number;
    settledAt: number;
    ttlMs: number;
    meta?: unknown;
    errorCode?: string | undefined;
  }>,
): ProvenanceRecord {
  const meta =
    typeof input.meta === "object" && input.meta !== null
      ? (input.meta as Record<string, unknown>)
      : undefined;
  const asOf = meta?.["asOf"];
  const etag = meta?.["etag"];
  const partial = meta?.["partial"];
  return Object.freeze({
    key: input.key,
    block: input.block,
    ...(input.params !== undefined ? { params: input.params } : {}),
    cacheState: input.cacheState,
    requestedAt: input.requestedAt,
    settledAt: input.settledAt,
    // Never negative: a clock that steps backwards must not read as a
    // negative latency, which would look like a bug in the app rather than in
    // the clock.
    latencyMs: Math.max(0, input.settledAt - input.requestedAt),
    ...(typeof asOf === "number" && Number.isFinite(asOf) ? { asOf } : {}),
    ...(typeof etag === "string" && etag.length > 0 ? { etag } : {}),
    ...(partial === true ? { partial: true } : {}),
    ttlMs: input.ttlMs,
    causality: readEnvelopeCausality(input.meta),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
  });
}

// ── Actions: the write-side record ─────────────────────────────────────────

/**
 * What the Broker can truthfully say about an action it performed.
 *
 * Deliberately NOT the read-side `CacheState` vocabulary: an action is never
 * cached, never revalidated and never served stale, so reusing those words
 * would let a viewer render "cached" for something that provably went to the
 * server. Two states, each corresponding to exactly one branch in
 * `broker.action`.
 */
export const ACTION_STATES = ["done", "failed"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/**
 * One performed action, as the Broker saw it — the write-side twin of
 * `ProvenanceRecord`, produced at the same choke point and never by a call
 * site. This is what lets LENS explain a RESULT the same way it explains a
 * value: who asked (`causality.actor`), which trace the server recorded the
 * work under (`causality.traceId`), when, and whether it finished.
 */
/**
 * WHO INITIATED AN ACTION — recorded, distinct from the authenticated
 * transport actor: `operator` is a person acting through a control,
 * `automatic` is the client acting on its own (e.g. the telemetry flush).
 * There is no "unknown": the one write door (`broker.action`) always knows
 * which it is, so every record states it and no consumer filters a guess.
 */
export type ActionOrigin = "operator" | "automatic";

export type ActionProvenanceRecord = Readonly<{
  /** Recorded initiation, distinct from the authenticated transport actor. */
  origin: ActionOrigin;
  /** `block/action` — the path identity, e.g. `"checks.auto/rerun"`. */
  key: string;
  /** Registered block id the action belongs to. */
  block: string;
  /** Action name within the block. */
  action: string;
  state: ActionState;
  /** Epoch ms when the action was issued. */
  requestedAt: number;
  /** Epoch ms when it settled. */
  settledAt: number;
  /** Wall-clock cost in ms. */
  latencyMs: number;
  /** `meta.asOf` from the response envelope — when the server produced it. */
  asOf?: number;
  /** Causal ids, when the envelope carried them. */
  causality: EnvelopeCausality;
  /** Typed error code when `state === "failed"`. */
  errorCode?: string;
  /**
   * THE INPUT THE ACTION WAS ISSUED WITH, as the Broker sent it.
   *
   * It is recorded rather than reconstructed, and it is recorded HERE because
   * here is the one place that has it: `broker.action` is the single write
   * door, so a record made anywhere else would be a guess. Without it a
   * surface can say that a breaker was flipped but not WHICH tool — and a
   * surface that needs to name the target would have to invent it, which is
   * exactly what §1.1 forbids. Optional because a record restored from an
   * older session may not carry one; absent renders as absent.
   */
  input?: unknown;
}>;

/** Build an action record. The ONLY constructor; frozen for the same reason
 *  `makeProvenanceRecord` freezes. */
export function makeActionRecord(
  input: Readonly<{
    origin: ActionOrigin;
    block: string;
    action: string;
    state: ActionState;
    requestedAt: number;
    settledAt: number;
    meta?: unknown;
    errorCode?: string | undefined;
    input?: unknown;
  }>,
): ActionProvenanceRecord {
  const meta =
    typeof input.meta === "object" && input.meta !== null
      ? (input.meta as Record<string, unknown>)
      : undefined;
  const asOf = meta?.["asOf"];
  return Object.freeze({
    origin: input.origin,
    key: `${input.block}/${input.action}`,
    block: input.block,
    action: input.action,
    state: input.state,
    requestedAt: input.requestedAt,
    settledAt: input.settledAt,
    latencyMs: Math.max(0, input.settledAt - input.requestedAt),
    ...(typeof asOf === "number" && Number.isFinite(asOf) ? { asOf } : {}),
    causality: readEnvelopeCausality(input.meta),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
  });
}

// ── Staleness ──────────────────────────────────────────────────────────────

/**
 * Staleness is expressed as a FRACTION OF THE READ'S OWN TTL, not against a
 * global threshold. A 15s-TTL search result and a 60s-TTL dependency graph
 * are not equally stale at 30s old, and a single hardcoded "stale after N
 * seconds" would lie about one of them. The declared TTL is the only honest
 * yardstick, and it already exists per block.
 */
export const STALENESS_AGING_RATIO = 0.75;

/**
 * How often the open lens re-samples the clock.
 *
 * Age has to be SEEN to advance — a staleness readout that only refreshes
 * when you re-hover is a screenshot, not an instrument. One second is the
 * coarsest cadence at which a human reads a number as counting rather than
 * jumping. The timer exists only while LENS is open.
 */
export const LENS_TICK_MS = 1000;

export const FRESHNESS_STATES = ["live", "aging", "stale", "unknown"] as const;
export type Freshness = (typeof FRESHNESS_STATES)[number];

/**
 * How old the data is, in ms — measured from server production time.
 *
 * `undefined` when the envelope carried no `asOf`. Age is NOT inferred from
 * the response time in that case: the two are different quantities and
 * substituting one for the other would understate staleness.
 */
export function ageMs(record: ProvenanceRecord, now: number): number | undefined {
  if (record.asOf === undefined) return undefined;
  return Math.max(0, now - record.asOf);
}

/** Classify an age against the TTL that governed the read. */
export function freshnessOf(age: number | undefined, ttlMs: number): Freshness {
  if (age === undefined) return "unknown";
  // A zero/negative TTL means "always revalidate" — there is no window during
  // which the value is defensibly live, so any age is stale.
  if (ttlMs <= 0) return "stale";
  if (age >= ttlMs) return "stale";
  if (age >= ttlMs * STALENESS_AGING_RATIO) return "aging";
  return "live";
}

/** The freshness of a record right now. The one call a view should need. */
export function freshnessOfRecord(record: ProvenanceRecord, now: number): Freshness {
  return freshnessOf(ageMs(record, now), record.ttlMs);
}

// ── Absence: the enforcement half ──────────────────────────────────────────

/**
 * Why an element has no provenance.
 *
 * `unbound` is the doctrine violation LENS exists to surface: the element
 * renders a value that came through no declared source. `unresolved` is
 * different and must not be conflated — the element IS bound, but the Broker
 * has no record for that key yet (nothing has read it). Collapsing the two
 * would either cry wolf on a cold cache or hide a real hole.
 */
export const ABSENCE_REASONS = ["unbound", "unresolved"] as const;
export type AbsenceReason = (typeof ABSENCE_REASONS)[number];

/** The result of asking "what produced this?" — a record, or an honest gap. */
export type ProvenanceAnswer =
  | Readonly<{ kind: "record"; record: ProvenanceRecord }>
  | Readonly<{ kind: "absent"; reason: AbsenceReason; key?: string }>;

/**
 * Resolve a binding key plus a lookup into an answer.
 *
 * Written as a pure function over `(key, lookup)` rather than over a DOM node
 * so the decision table — the part that can be wrong — is testable with no
 * browser. The DOM walk that finds the key is a separate, trivial step.
 */
export function answerFor(
  key: string | undefined,
  lookup: (key: string) => ProvenanceRecord | undefined,
): ProvenanceAnswer {
  if (key === undefined || key.length === 0) {
    return Object.freeze({ kind: "absent", reason: "unbound" as const });
  }
  const record = lookup(key);
  if (record === undefined) {
    return Object.freeze({ kind: "absent", reason: "unresolved" as const, key });
  }
  return Object.freeze({ kind: "record", record });
}

// ── Causal ancestry ────────────────────────────────────────────────────────

/**
 * Why a walk stopped. Every terminating condition is NAMED, because "the
 * chain ended" and "we were not allowed to look further" and "causality was
 * never recorded for this event" are three completely different statements
 * about the system, and a viewer that renders them identically is lying about
 * two of them.
 */
export const ANCESTRY_STATUSES = [
  /** Walked to a genuine root (an event with a trace but no parent). */
  "complete",
  /** The event exists but carries neither a parent nor a trace id — the
   *  recorder did not persist causality for it. NOT the same as a root. */
  "unrecorded",
  /** A hop was not owned by the caller; the walk stopped rather than leak. */
  "denied",
  /** The depth cap was hit; more ancestors exist. */
  "truncated",
  /** The starting event id is not in the ledger. */
  "not_found",
] as const;
export type AncestryStatus = (typeof ANCESTRY_STATUSES)[number];

/** One event on the causal path, reduced to what an explanation needs. */
export type AncestryHop = Readonly<{
  eventId: string;
  parentEventId?: string;
  traceId?: string;
  /** `event_type` — what happened. */
  eventType: string;
  /** `description` — the human sentence the recorder wrote. */
  description: string;
  /** `actor_kind:actor_id` — who is responsible. */
  actor?: string;
  /** ISO-8601 `wall_time`. */
  at?: string;
  outcome?: string;
  /** `error_code` when the event recorded a failure. */
  errorCode?: string;
}>;

/** A completed walk: the path, nearest-first, plus why it ended. */
export type AncestryChain = Readonly<{
  status: AncestryStatus;
  /** Nearest cause first, ultimate cause last. */
  hops: readonly AncestryHop[];
  /** Set when `status === "denied"` — the id we refused to walk into. */
  deniedAt?: string;
  /**
   * How many events sharing the trace were withheld because they belong to
   * another user's runs. A COUNT and nothing else — no ids, no descriptions —
   * present only when it is positive, so a viewer can state the ownership
   * boundary ("part of this trace is not yours") instead of presenting a
   * partial answer as a whole one. Only trace-entered walks can carry it.
   */
  withheld?: number;
}>;

/**
 * Whether an event carries recorded causality at all.
 *
 * A genuine root and an event whose causality was dropped on the write path
 * BOTH have a null `parent_event_id`. They are distinguished by `trace_id`: an
 * event that participates in a recorded trace but has no parent is the root of
 * that trace; an event with neither is one whose causality was never written.
 * This distinction is the whole reason LENS can report the recorder's own
 * defects instead of silently absorbing them.
 */
export function classifyTerminal(hop: AncestryHop): "complete" | "unrecorded" {
  if (hop.parentEventId !== undefined && hop.parentEventId.length > 0) return "complete";
  return hop.traceId !== undefined && hop.traceId.length > 0 ? "complete" : "unrecorded";
}

/**
 * Assemble hops into a chain, deciding the terminating status.
 *
 * Pure so the decision table is testable without a database. `hitCap` is
 * passed in rather than re-derived from `hops.length` so the cap policy lives
 * with the walker and the classification lives here.
 */
export function buildAncestryChain(
  hops: readonly AncestryHop[],
  opts: Readonly<{ hitCap?: boolean; deniedAt?: string }> = {},
): AncestryChain {
  if (opts.deniedAt !== undefined) {
    return Object.freeze({ status: "denied" as const, hops: Object.freeze([...hops]), deniedAt: opts.deniedAt });
  }
  if (hops.length === 0) {
    return Object.freeze({ status: "not_found" as const, hops: Object.freeze([]) });
  }
  if (opts.hitCap === true) {
    return Object.freeze({ status: "truncated" as const, hops: Object.freeze([...hops]) });
  }
  const last = hops[hops.length - 1] as AncestryHop;
  return Object.freeze({ status: classifyTerminal(last), hops: Object.freeze([...hops]) });
}

/**
 * Attach a withheld count to a finished chain.
 *
 * A separate pure step rather than a `buildAncestryChain` option because the
 * count is only known by the TRACE entry (`ownedTraceEvents`), after the walk
 * has already been classified — threading it through the walker would hand
 * every walk a parameter only one caller can supply.
 *
 * Zero or invalid is an IDENTITY, not a `withheld: 0` field: "nothing was
 * withheld" must render as the absence of a boundary statement, and a
 * fabricated zero would invite the UI to print "0 events withheld", which
 * reads as a claim about other users where no such claim is being made.
 */
export function withWithheld(chain: AncestryChain, withheld: number): AncestryChain {
  if (!Number.isInteger(withheld) || withheld <= 0) return chain;
  return Object.freeze({ ...chain, withheld });
}

/**
 * The depth cap for a causal walk.
 *
 * `parent_event_id` is a self-referencing foreign key with no cycle
 * constraint, so an unbounded walk is a hang waiting to happen. The cap is
 * also what makes `truncated` a real, reportable state rather than a silent
 * stop.
 */
export const ANCESTRY_MAX_DEPTH = 64;

/**
 * How much of the RECORDER's causality actually reached the ledger.
 *
 * The client-side coverage number below measures whether a surface declares a
 * source. This is its server-side twin: of the events that were written, how
 * many carry the causal columns at all. Both are needed, because a fully bound
 * UI sitting on a recorder that drops `trace_id` still cannot explain
 * anything — and without this number that failure is invisible, which is
 * exactly how it survived until now.
 */
export type CausalityCoverage = Readonly<{
  sampled: number;
  withTrace: number;
  withParent: number;
  withActor: number;
}>;

/**
 * Summarise causal completeness over a sample of ledger rows.
 *
 * Deliberately counts what IS there rather than asserting what should be: a
 * genuine root legitimately has no parent, so `withParent < sampled` is not by
 * itself a defect. The number that indicts the write path is `withTrace`,
 * because every recorded event inside a span should carry a trace id.
 */
export function summarizeCausality(
  events: readonly Readonly<{
    traceId?: string | null;
    parentEventId?: string | null;
    actorId?: string | null;
  }>[],
): CausalityCoverage {
  let withTrace = 0;
  let withParent = 0;
  let withActor = 0;
  for (const e of events) {
    if (typeof e.traceId === "string" && e.traceId.length > 0) withTrace++;
    if (typeof e.parentEventId === "string" && e.parentEventId.length > 0) withParent++;
    if (typeof e.actorId === "string" && e.actorId.length > 0) withActor++;
  }
  return Object.freeze({ sampled: events.length, withTrace, withParent, withActor });
}

// ── Coverage: LENS as an enforcement instrument ────────────────────────────

/**
 * One thing that COULD have a declared source.
 *
 * Subjects are discovered, never enumerated by hand — from the module
 * registry, the block registry, or the live DOM. A coverage test that needs
 * editing when a module is added is itself a defect (doctrine 10).
 */
export type CoverageSubject = Readonly<{
  /** Stable identity — a module id, a component key, a DOM path. */
  id: string;
  /** Which population it belongs to, so a report can be read per-kind. */
  kind: string;
  /** The block id backing it, or `undefined` for "no declared source". */
  block?: string;
}>;

export type CoverageReport = Readonly<{
  total: number;
  bound: number;
  /** 0..1. Defined as 1 for an empty population — see below. */
  ratio: number;
  /** Ids with no declared source, sorted. THE list the ratchet names. */
  unbound: readonly string[];
  /** Per-kind breakdown so a regression can be attributed. */
  byKind: Readonly<Record<string, Readonly<{ total: number; bound: number }>>>;
}>;

/**
 * Compute coverage over a discovered population.
 *
 * An empty population yields ratio 1, NOT 0. This is deliberate and is the
 * only defensible choice for a ratchet: 0/0 rendered as 0% would make an
 * empty discovery (a broken walker, a registry that failed to load) look like
 * a catastrophic coverage collapse and would block every commit until someone
 * lowered the floor — training the team to lower floors, which is the one
 * thing a ratchet must never teach. The vacuity risk is covered separately by
 * asserting the population is non-empty, which is a different assertion with a
 * different failure message.
 */
export function computeCoverage(subjects: readonly CoverageSubject[]): CoverageReport {
  const unbound: string[] = [];
  const byKind = new Map<string, { total: number; bound: number }>();
  let bound = 0;
  for (const s of subjects) {
    const isBound = s.block !== undefined && s.block.length > 0;
    if (isBound) bound++;
    else unbound.push(s.id);
    let k = byKind.get(s.kind);
    if (k === undefined) {
      k = { total: 0, bound: 0 };
      byKind.set(s.kind, k);
    }
    k.total++;
    if (isBound) k.bound++;
  }
  unbound.sort();
  const byKindOut: Record<string, Readonly<{ total: number; bound: number }>> = {};
  for (const [kind, v] of [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byKindOut[kind] = Object.freeze({ total: v.total, bound: v.bound });
  }
  return Object.freeze({
    total: subjects.length,
    bound,
    ratio: subjects.length === 0 ? 1 : bound / subjects.length,
    unbound: Object.freeze(unbound),
    byKind: Object.freeze(byKindOut),
  });
}

/**
 * Coverage as a whole percent, rounded DOWN.
 *
 * Rounding down matters for a ratchet: rounding to nearest lets a real
 * regression from 60.4% to 59.6% both display as 60% and slip past a floor
 * expressed in whole percent. Truncation can only ever understate.
 */
export function coveragePercent(report: CoverageReport): number {
  return Math.floor(report.ratio * 100);
}

// ── Scrub: reconstructing a past view ──────────────────────────────────────

/**
 * How many records the client keeps for reconstruction.
 *
 * Bounded on purpose. An unbounded provenance log is a memory leak with a
 * good excuse, and the value of a fourth-oldest superseded response is
 * essentially nil.
 */
export const PROVENANCE_HISTORY_LIMIT = 512;

/**
 * The state of a value at an instant, as reconstructed from the log.
 *
 * `displayed` is the honest scope of this feature: what the app HAD received
 * and was showing at that instant. It is not the server's state at that
 * instant, and it is not a rerun of anything. The type name says so.
 */
export type DisplayedAt = Readonly<{
  key: string;
  record: ProvenanceRecord;
}>;

/**
 * Reconstruct which record was in force for each key at `instant`.
 *
 * Pure, and deliberately simple: for every key, the newest record whose
 * `settledAt` is at or before the instant. A key with no such record is
 * ABSENT from the result rather than represented by its first future value —
 * showing a value the app had not yet received would be the exact
 * fabrication this feature must never commit.
 */
export function displayedAt(
  history: readonly ProvenanceRecord[],
  instant: number,
): readonly DisplayedAt[] {
  const newest = new Map<string, ProvenanceRecord>();
  for (const r of history) {
    if (r.settledAt > instant) continue;
    const prev = newest.get(r.key);
    if (prev === undefined || r.settledAt >= prev.settledAt) newest.set(r.key, r);
  }
  return Object.freeze(
    [...newest.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, record]) => Object.freeze({ key, record })),
  );
}

/**
 * The time span the log can honestly reconstruct.
 *
 * Returned so the scrub handle can bound itself to REAL data instead of
 * offering a timeline that extends into regions where it would have nothing
 * to say. `undefined` for an empty log — there is no span, and inventing
 * `[now, now]` would put a handle on an axis that means nothing.
 */
export function reconstructableSpan(
  history: readonly ProvenanceRecord[],
): Readonly<{ fromMs: number; toMs: number }> | undefined {
  if (history.length === 0) return undefined;
  let from = Infinity;
  let to = -Infinity;
  for (const r of history) {
    if (r.settledAt < from) from = r.settledAt;
    if (r.settledAt > to) to = r.settledAt;
  }
  return Object.freeze({ fromMs: from, toMs: to });
}
