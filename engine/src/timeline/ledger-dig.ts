import type { TimelineDocumentRecord } from "./timeline-types.ts";
/**
 * Ledger dig — the READ-ONLY reader behind the trace CLI, answering "what
 * did this run/trace actually do" in one command.
 *
 * THE PROBLEM THIS SOLVES: the ledger already records everything (trace,
 * span, turn and run correlation, per-effect duration + CPU + RAM, redacted
 * provider payloads, redacted arguments, token usage) — but reading it meant
 * hand-writing a node:sqlite script per question. A question that costs a
 * custom script does not get asked, so the recorded evidence sits unread.
 * This module is the standing answer for the recurring question shapes: a
 * run in causal order, a trace, the newest events, the payloads a provider
 * saw, the failures.
 *
 * ── WHY ITS OWN CONNECTION, NOT THE STORE ────────────────────────────────
 *
 * The canonical timeline store (`createTimelineStore`) opens a WRITE handle
 * and is the ledger's single writer. A debugging reader must never become a
 * second writer or depend on the writer being configured — so this module
 * opens its OWN `DatabaseSync` with `readOnly: true` and SELECTs directly.
 * It lives beside the store in the read-owner domain (the timeline ledger is
 * engine-owned; its SQL belongs with the store's SQL, not in the web server
 * tree). The SQL is read-path code: a bounded SELECT over `event_log` plus
 * a chunked SELECT over `event_documents` for the matched events, and the
 * per-run aggregation's three lean grouped SELECTs behind `runs`/`doctor`.
 * Every caller-supplied value is a bound parameter; the only SQL text
 * assembled at run time is the fixed predicate set and the `IN (…)`
 * placeholder list.
 *
 * ── REDACTION IS UPSTREAM, NOT HERE ─────────────────────────────────────
 *
 * Documents are redacted by the single redaction owner BEFORE they are
 * written. This module prints them AS STORED — it neither re-redacts (which
 * would duplicate the masking logic and could drift from it) nor attempts to
 * undo masking (which is impossible by design). What the ledger holds is
 * what you see.
 *
 * ── WHAT THE CONSUMER MUST READ ──────────────────────────────────────────
 *
 * `outcome` is the verdict column. An event can carry populated error fields
 * while its outcome is `succeeded` (a thrown 4xx is classified by its mapped
 * status): consumers must read the outcome, never infer failure from
 * error-field presence.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { InputError } from "../kernel/errors.ts";
import {
  TIMELINE_EFFECT_TIMING_DOCUMENT,
  TIMELINE_EFFECT_ARGS_DOCUMENT,
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
  TIMELINE_GATE_BLOCK_DOCUMENT,
  TIMELINE_RESOURCE_METRIC_DOCUMENT,
  TIMELINE_TOKEN_USAGE_DOCUMENT,
  MS_PER_SECOND,
  type TimelineEffectTiming,
} from "../../../shared/constants.ts";
// Timeline facts from the domain's vocabulary owner: the ONE usage decoder,
// the effect-kind → lane table (which lane is the provider lane, which the
// tool lane), the derived failure-verdict outcome names — never bare
// literals restated beside the SQL that reads them — plus the closed event
// type registry an --event-type value is validated against.
import {
  decodeTokenUsageDocument,
  EFFECT_KIND_EVENT_TYPES,
  eventTypeForEffectKind,
  TIMELINE_EVENT_TYPES,
  TIMELINE_FAILURE_OUTCOME_NAMES,
  type TimelineEventType,
} from "./timeline-types.ts";

// ── Shapes ──────────────────────────────────────────────────────────────────

/** One ledger event, flattened for reading, with its documents attached. */
export type DigEvent = Readonly<{
  eventId: string;
  /** Ledger sequence — the causal total order, as a decimal string. */
  sequence: string;
  wallTime: string;
  eventType: string;
  outcome: string | null;
  traceId: string | null;
  runId: string | null;
  turnId: string | null;
  spanId: string | null;
  description: string;
  errorCategory: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  documents: readonly DigDocument[];
}>;

/** Stored attachment text and metadata; reading does not authenticate historical rows. */
export type DigDocument = Pick<TimelineDocumentRecord, "name" | "contentJson" | "orderedJson" | "contentDigest">;

/** The scope a dig answers: one run, one trace, or the newest N events. */
export type DigScope =
  | Readonly<{ kind: "run"; id: string }>
  | Readonly<{ kind: "trace"; id: string }>
  | Readonly<{ kind: "tail"; limit: number }>;

/** Narrowing filters over any scope. */
export type DigFilter = Readonly<{
  /** Keep only events of this recorded type (validated against the
   * vocabulary through `resolveEventTypeFilter`). */
  eventType?: string;
  /** Keep only events whose recorded outcome is `failed` or `denied`. */
  failedOnly?: boolean;
  /** Lower wall-time bound, inclusive (ISO-8601, normalized by
   * `resolveWallTimeBound`). */
  sinceWallTime?: string;
  /** Upper wall-time bound, inclusive (same grammar as the lower one). */
  untilWallTime?: string;
  /** Opt back in to the resource lane the tail excludes by default. */
  allEventTypes?: boolean;
}>;

/** The document view a dump prints: none, the provider payloads, or all. */
export type DigDocumentView = "none" | "llm" | "all";

/** The rollup header facts for a run/trace dump. */
export type DigSummary = Readonly<{
  events: number;
  firstWallTime: string | null;
  lastWallTime: string | null;
  /** Wall-clock span first→last in ms; null when the times do not parse. */
  durationMs: number | null;
  /** Distinct trace ids in scope (a run is one request — usually exactly 1). */
  traceIds: readonly string[];
  /** Provider calls (the events carrying the llm-request/response documents). */
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Token-usage documents that did not decode through the ONE usage decoder. */
  unparsedUsageDocuments: number;
  /** Tool events grouped by their RECORDED description (the ledger has no
   * tool-name column; parsing one out of the description would be inference). */
  tools: readonly Readonly<{
    description: string;
    total: number;
    byOutcome: Readonly<Record<string, number>>;
  }>[];
  /** Events carrying recorded error detail (`error_code` not null), whatever
   * their outcome — the thrown-4xx shape (succeeded + error fields) is
   * visible here with its outcome, not hidden by a failure-only filter. */
  errors: readonly Readonly<{
    sequence: string;
    description: string;
    outcome: string | null;
    category: string | null;
    code: string | null;
  }>[];
}>;

/** The complete answer to one dig: the matched events + the rollup. */
export type DigResult = Readonly<{
  scope: DigScope;
  /** Whether the SCOPE predicate itself matched at least one event,
   * ignoring every filter — the distinction between "no such run" (a
   * typo: the caller must fix the id) and "this run has no event that
   * matches your filters" (the tool did its job and found nothing).
   * Always true for the tail, which names no id. */
  scopeMatched: boolean;
  events: readonly DigEvent[];
  summary: DigSummary;
}>;

/** One run, rolled up to one line: the cold-start answer of `runs`. */
export type DigRunRollup = Readonly<{
  runId: string;
  /** The harness web session the run's events were recorded under (the
   * `session_id` column — the request boundary's harness_session cookie
   * id), when the ledger recorded one. NOT the chat id: the ledger holds
   * no chat id at all; `--chat` resolves through the web db's
   * messages.run_id into a run-id scope instead. */
  sessionId: string | null;
  events: number;
  firstWallTime: string;
  lastWallTime: string;
  /** Wall-clock span first→last in ms; null when the times do not parse. */
  durationMs: number | null;
  /** Provider-lane calls (the lane the effect-kind table maps `llm` to). */
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Token-usage documents that did not decode through the ONE decoder. */
  unparsedUsageDocuments: number;
  /** Per-outcome event counts over the outcomes the ledger recorded —
   * dynamic over the recorded vocabulary, never a restated outcome list. */
  byOutcome: Readonly<Record<string, number>>;
  /** Events whose outcome carries the registry's failure disposition. */
  failures: number;
  /** Failed/denied tool-lane calls grouped by their recorded description. */
  toolFailures: readonly Readonly<{ description: string; count: number }>[];
}>;

/** The complete answer to `runs`. */
export type DigRunsResult = Readonly<{
  /** The session filter, echoed (null when none was given). */
  sessionId: string | null;
  /** The run-id scope, echoed (null when none was given). `--chat`
   * resolves a chat id to this through the web db before digging; the
   * ledger itself has no chat column to filter by. */
  runIds: readonly string[] | null;
  /** Whether the SCOPE predicate itself matched at least one run — the
   * same absent-vs-empty distinction `DigResult.scopeMatched` makes:
   * false means the named session or run-id set is absent (a typo, or a
   * chat with no runs), not "no runs today". */
  scopeMatched: boolean;
  /** Newest run first. */
  runs: readonly DigRunRollup[];
}>;

/** One gate-block document, parsed to the fields the doctor surfaces. */
export type DigDoctorGateBlock = Readonly<{
  sequence: string;
  toolName: string;
  kind: string;
  failedFields: readonly string[];
  /** Whether the harness escalated the refusal loop. */
  escalated: boolean;
}>;

/** The complete answer to `doctor` — the three taught moves, collapsed. */
export type DigDoctorResult = Readonly<{
  /** `failed-run` — the newest run with failures. `newest-run` — no run
   * has failures, so the newest run period is shown. `none` — the
   * ledger (or the given scope) holds no run at all. */
  verdict: "failed-run" | "newest-run" | "none";
  /** The session filter, echoed (null when none was given). */
  sessionId: string | null;
  /** The run-id scope, echoed (null when none was given) — what `--chat`
   * resolves a chat id to before digging. */
  runIds: readonly string[] | null;
  /** Whether the scope predicate matched at least one run — the same
   * absent-vs-empty distinction as `DigRunsResult.scopeMatched`. False
   * with a scope given means the named session or run-id set is absent. */
  scopeMatched: boolean;
  runId: string | null;
  /** The chosen run's dig summary — the same header `run <id>` prints;
   * null when nothing qualifies. */
  summary: DigSummary | null;
  /** The chosen run's failed/denied events, causal order. */
  failed: readonly DigEvent[];
  /** The gate-block documents found in the run, causal order. */
  gateBlocks: readonly DigDoctorGateBlock[];
  /** The provider payloads + redacted args, per event that carries them. */
  llmPayloads: readonly Readonly<{ event: DigEvent; documents: readonly DigDocument[] }>[];
}>;

/** One new batch for `tail --follow`: the rows after the cursor, in
 * causal order, and the cursor to carry forward. */
export type DigFollowBatch = Readonly<{
  batch: readonly DigEvent[];
  lastSeenSequence: string | null;
}>;

// ── Opening ──────────────────────────────────────────────────────────────────

/**
 * Resolve the configured ledger path so the tool works from ANY cwd.
 *
 * The config owner's default (and any relative `HARNESS_WEB_TIMELINE_DB_PATH`)
 * is relative to the SERVER's cwd — the repo root. A CLI invoked from
 * elsewhere must land on the same file, so a relative configured path is
 * anchored at `anchor` (the CLI passes its own repo root); an absolute path
 * passes through unchanged, exactly like `path.resolve`.
 */
export function resolveLedgerPath(configuredPath: string, anchor: string): string {
  return isAbsolute(configuredPath) ? configuredPath : resolve(anchor, configuredPath);
}

/**
 * Open the ledger READ-ONLY. A path that does not exist is refused loudly
 * rather than created: a read-only SQLite open cannot create a file, and a
 * dig against an absent ledger is a misconfiguration (wrong cwd, wrong env),
 * which deserves the reason, not a SQLITE_CANTOPEN code dump.
 *
 * The code resolves to 404 in the web taxonomy (`timeline_ledger_missing`
 * in `shared/errors.ts`) — a not-found resource, never a 500 leak.
 */
export function openLedgerReadOnly(absolutePath: string): DatabaseSync {
  if (!existsSync(absolutePath)) {
    throw new InputError(
      `timeline ledger not found at ${absolutePath} — start the server once or point ` +
        `HARNESS_WEB_TIMELINE_DB_PATH at the ledger`,
      "timeline_ledger_missing",
    );
  }
  return new DatabaseSync(absolutePath, { readOnly: true });
}

// ── Argument resolvers (validated before any query runs) ────────────────────

/**
 * Resolve an `--event-type` value against the recorded vocabulary.
 *
 * The match is case-insensitive (`TOOL` finds `tool`) and the answer is the
 * registry's own canonical spelling. An unknown value is a caller error
 * that names the whole known vocabulary — a typo should teach the correct
 * word, not return an empty scope that looks like "no such events". The
 * resource lane IS a valid type here (it is excluded from the tail's
 * default scan by its own hygiene rule, not by invalidity).
 */
export function resolveEventTypeFilter(raw: string): TimelineEventType {
  const canonical = TIMELINE_EVENT_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
  if (canonical !== undefined) return canonical;
  throw new InputError(
    `unknown event type '${raw}' — the recorded types are: ${TIMELINE_EVENT_TYPES.join(", ")}`,
    "timeline_dig_event_type_invalid",
  );
}

/** The relative-duration units `resolveWallTimeBound` accepts, derived
 * from the one shared time constant — a unit never restated in ms. */
const RELATIVE_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  s: MS_PER_SECOND,
  m: MS_PER_SECOND * 60,
  h: MS_PER_SECOND * 60 * 60,
  d: MS_PER_SECOND * 60 * 60 * 24,
  w: MS_PER_SECOND * 60 * 60 * 24 * 7,
});

const RELATIVE_DURATION = /^((\d+)([smhdw]))+$/u;
const RELATIVE_SEGMENT = /(\d+)([smhdw])/gu;

/**
 * Resolve a `--since`/`--until` value to the ISO-8601 form the ledger's
 * `wall_time` column compares against: either an ISO-8601 timestamp
 * (normalized through `toISOString`, so `2026-08-31` becomes
 * `2026-08-31T00:00:00.000Z` and lexicographic comparison stays
 * chronological) or a relative duration — `2h`, `30m`, `3d`, and
 * combinations like `1h30m` — resolved against `now` (the call site
 * passes the real clock; tests pass theirs). Bounds are inclusive.
 */
export function resolveWallTimeBound(raw: string, now: Date = new Date()): string {
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    const normalized = new Date(parsed).toISOString();
    // A bare number ("42") parses as a year in some engines and as
    // nothing in others — never a timestamp the caller meant. The
    // relative grammar below is the honest reading of digits.
    if (!/^\d+(\.\d+)?$/u.test(raw)) return normalized;
  }
  if (RELATIVE_DURATION.test(raw)) {
    let deltaMs = 0;
    for (const segment of raw.matchAll(RELATIVE_SEGMENT)) {
      deltaMs += Number(segment[1]) * (RELATIVE_UNIT_MS[segment[2]!] ?? 0);
    }
    return new Date(now.getTime() - deltaMs).toISOString();
  }
  throw new InputError(
    `'${raw}' is not a time bound — pass an ISO-8601 timestamp ` +
      `(e.g. 2026-08-31T12:00:00Z) or a relative duration (e.g. 2h, 30m, 3d, 1h30m)`,
    "timeline_dig_time_bound_invalid",
  );
}

// ── Reading ─────────────────────────────────────────────────────────────────

const EVENT_COLUMNS =
  "event_id, sequence, wall_time, event_type, outcome, trace_id, run_id, " +
  "turn_id, span_id, description, error_category, error_code, error_message";

/**
 * The sampler's lane. The periodic `resource` events are the live ledger's
 * background hum — measured at roughly a third of a live ledger's rows —
 * and they drown the incident scan the tail exists for, so the tail's
 * default scan excludes them. The type stays VALID (an explicit
 * `--event-type resource` asks for it by name and gets it); `--all-types`
 * opts the default scan back in. Typed against the vocabulary registry so
 * a rename or removal is a compile error, never a silent lie.
 */
const TAIL_EXCLUDED_EVENT_TYPE: TimelineEventType = "resource";

/** The fixed predicate set — SQL text is assembled ONLY from these literals. */
function whereFor(scope: DigScope, filter: DigFilter): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (scope.kind === "run") {
    parts.push("run_id = ?");
    params.push(scope.id);
  } else if (scope.kind === "trace") {
    parts.push("trace_id = ?");
    params.push(scope.id);
  }
  if (filter.eventType !== undefined) {
    parts.push("event_type = ?");
    params.push(filter.eventType);
  } else if (scope.kind === "tail" && filter.allEventTypes !== true) {
    // The tail's own hygiene: the sampler lane is excluded from the
    // default scan unless the caller opts back in. An explicit
    // --event-type wins over the exclusion — asking for a type by name
    // is a narrower request than the default scan, not a contradiction.
    parts.push("event_type <> ?");
    params.push(TAIL_EXCLUDED_EVENT_TYPE);
  }
  if (filter.sinceWallTime !== undefined) {
    parts.push("wall_time >= ?");
    params.push(filter.sinceWallTime);
  }
  if (filter.untilWallTime !== undefined) {
    parts.push("wall_time <= ?");
    params.push(filter.untilWallTime);
  }
  if (filter.failedOnly) {
    // The verdict column, never error-field presence: a thrown 4xx carries
    // error fields on a `succeeded` outcome and is NOT a failed event. The
    // failure verdicts are DERIVED from the outcome registry's own
    // disposition (`TIMELINE_FAILURE_OUTCOME_NAMES`) — an outcome added to
    // the vocabulary joins this filter the day it is given a disposition.
    const names = TIMELINE_FAILURE_OUTCOME_NAMES.map(() => "?").join(", ");
    parts.push(`outcome IN (${names})`);
    params.push(...TIMELINE_FAILURE_OUTCOME_NAMES);
  }
  return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

const IN_CHUNK = 400;

/** Every document of the matched events, in recorded position order. */
function documentsOf(db: DatabaseSync, eventIds: readonly string[]): Map<string, DigDocument[]> {
  const byEvent = new Map<string, DigDocument[]>();
  const stmt = (ids: readonly string[]) =>
    db.prepare(
      `SELECT event_id, name, content_json, ordered_json, content_digest FROM event_documents WHERE event_id IN ` +
        `(${ids.map(() => "?").join(", ")}) ORDER BY position`,
    );
  for (let i = 0; i < eventIds.length; i += IN_CHUNK) {
    const chunk = eventIds.slice(i, i + IN_CHUNK);
    if (chunk.length === 0) continue;
    for (const row of stmt(chunk).all(...chunk) as Record<string, unknown>[]) {
      const eventId = String(row["event_id"]);
      const list = byEvent.get(eventId) ?? [];
      list.push({
        name: String(row["name"]),
        contentJson: row["content_json"] === null ? null : String(row["content_json"]),
        orderedJson: row["ordered_json"] === null ? null : String(row["ordered_json"]),
        contentDigest: String(row["content_digest"]),
      });
      byEvent.set(eventId, list);
    }
  }
  return byEvent;
}

/**
 * Dig the ledger. `db` is an OPEN read-only connection (see
 * `openLedgerReadOnly`); tests pass their own so the reader is exercised
 * against a real store-built ledger.
 */
export function digLedger(db: DatabaseSync, scope: DigScope, filter: DigFilter = {}): DigResult {
  const { sql: where, params } = whereFor(scope, filter);
  // A run/trace is a bounded slice in ASCENDING causal order (the story of
  // the request, first cause to last effect). The tail is the newest N in
  // DESCENDING order — "what just happened", not "what happened first".
  const ascending = scope.kind !== "tail";
  const limit = scope.kind === "tail" ? scope.limit : undefined;
  const order = ascending ? "ORDER BY ledger_id, sequence" : "ORDER BY wall_time DESC, ledger_id DESC, sequence DESC";
  const limitSql = limit !== undefined ? " LIMIT ?" : "";
  const rows = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM event_log${where} ${order}${limitSql}`,
  ).all(...params, ...(limit !== undefined ? [limit] : [])) as Record<string, unknown>[];

  // Documents are fetched by the matched ids (one statement, chunked IN) and
  // joined here, so every returned event carries exactly the documents the
  // ledger holds for it.
  const docs = documentsOf(db, rows.map((row) => String(row["event_id"])));
  const events: DigEvent[] = rows.map((row) => {
    const eventId = String(row["event_id"]);
    return {
      eventId,
      sequence: String(row["sequence"]),
      wallTime: String(row["wall_time"]),
      eventType: String(row["event_type"]),
      outcome: row["outcome"] === null ? null : String(row["outcome"]),
      traceId: row["trace_id"] === null ? null : String(row["trace_id"]),
      runId: row["run_id"] === null ? null : String(row["run_id"]),
      turnId: row["turn_id"] === null ? null : String(row["turn_id"]),
      spanId: row["span_id"] === null ? null : String(row["span_id"]),
      description: String(row["description"]),
      errorCategory: row["error_category"] === null ? null : String(row["error_category"]),
      errorCode: row["error_code"] === null ? null : String(row["error_code"]),
      errorMessage: row["error_message"] === null ? null : String(row["error_message"]),
      documents: Object.freeze(docs.get(eventId) ?? []),
    };
  });
  // The absent-vs-empty verdict needs to know whether the SCOPE predicate
  // matched anything on its own. Zero events after filtering says nothing
  // about that, so the empty case is probed once — cheap, and only then.
  const scopeMatched =
    events.length > 0
      ? true
      : scope.kind === "tail"
        ? true
        : db
            .prepare(
              `SELECT 1 FROM event_log WHERE ${scope.kind === "run" ? "run_id" : "trace_id"} = ? LIMIT 1`,
            )
            .get(scope.id) !== undefined;
  return { scope, scopeMatched, events, summary: summarize(events) };
}

/**
 * The exit verdict for a dig: `ok` — events matched; `empty` — the scope
 * exists but the filters matched nothing (the tool did its job; exit 0);
 * `absent` — no run/trace with that id exists at all (a typo; exit 1 —
 * the caller must fix the id, and "nothing found" must not look like a
 * crash either). Pure so the shell's exit mapping is one tested step.
 */
export function digExitVerdict(result: DigResult): "ok" | "empty" | "absent" {
  if (result.events.length > 0) return "ok";
  return result.scopeMatched ? "empty" : "absent";
}

// ── Per-run aggregation (the `runs` command) ─────────────────────────────────

/** The harness web-session column the ledger correlates runs by. */
const RUN_ROLLUP_COLUMNS: Readonly<{ runId: string; sessionId: string; events: string; firstWall: string; lastWall: string }> = Object.freeze({
  runId: "run_id",
  sessionId: "session_id",
  events: "c",
  firstWall: "first_wall",
  lastWall: "last_wall",
});

/**
 * Roll up every run in the ledger to one line each — the cold-start answer
 * ("what ran, what failed, without knowing any id"). Read-only SQL in the
 * reader's own style: three fixed SELECT statements with bound parameters,
 * the failure verdicts and lane names derived from the vocabulary owner,
 * and the per-run folding done here over lean grouped rows.
 *
 * TWO SCOPES, both optional, both absent-vs-empty honest:
 *  · `sessionId` — the ledger's own `session_id` column (the request
 *    boundary's harness_session cookie id). The ledger holds NO chat id;
 *    this is the closest scope it can answer natively.
 *  · `runIds` — an explicit run-id set, which is how a CHAT id reaches
 *    this reader: the CLI resolves the chat through the web db's
 *    messages.run_id (the db owner's `CHAT_RUN_IDS_SQL`) and hands the
 *    resolved ids over. An EMPTY array means the chat resolved to no
 *    runs — the scope is ABSENT, so it matches nothing and
 *    `scopeMatched` is false, never an "all runs" fallback.
 *
 * `failedOnly` keeps runs containing at least one failed/denied event;
 * `last` keeps only the newest N after that. `scopeMatched` answers the
 * absent-vs-empty question for either scope, exactly the way
 * `DigResult.scopeMatched` does for a run/trace id.
 */
export function listRuns(
  db: DatabaseSync,
  opts: Readonly<{ sessionId?: string; runIds?: readonly string[]; failedOnly?: boolean; last?: number }> = {},
): DigRunsResult {
  // The session predicate is table-qualified (`e.session_id`) because the
  // third query below JOINs event_documents — a future `session_id` column
  // on that table would make a bare `session_id` ambiguous and turn the
  // rollup into an SQLite error the day the schema grows. Every event_log
  // reference in the three statements is qualified for the same reason.
  const chatSql = opts.sessionId === undefined ? "" : " AND e.session_id = ?";
  const chatParams = opts.sessionId === undefined ? [] : [opts.sessionId];
  // A resolved-empty run-id scope must match NOTHING — `IN ()` is not SQL,
  // so the empty set is spelled as a predicate that cannot hold.
  const runIdsSql =
    opts.runIds === undefined
      ? ""
      : opts.runIds.length === 0
        ? " AND 1 = 0"
        : ` AND e.run_id IN (${opts.runIds.map(() => "?").join(", ")})`;
  const runIdsParams = opts.runIds === undefined ? [] : [...opts.runIds];
  const scopeSql = `${chatSql}${runIdsSql}`;
  const scopeParams = [...chatParams, ...runIdsParams];

  // One lean row per (run, chat, event type, outcome) group — bounded by
  // runs × types × outcomes, never by events — carrying the per-group
  // count and the group's wall-time extremes.
  const groups = db.prepare(
    `SELECT e.run_id AS run_id, e.session_id AS session_id, e.event_type AS event_type, e.outcome AS outcome, ` +
      `count(*) AS c, min(e.wall_time) AS first_wall, ` +
      `max(e.wall_time) AS last_wall ` +
      `FROM event_log e WHERE e.run_id IS NOT NULL${scopeSql} ` +
      `GROUP BY e.run_id, e.session_id, e.event_type, e.outcome`,
  ).all(...scopeParams) as Record<string, unknown>[];

  // Failed tool-lane calls by their recorded description, per run. The lane
  // comes through the vocabulary owner's own accessor — never a restated
  // literal beside the SQL that reads it.
  const failureNames = TIMELINE_FAILURE_OUTCOME_NAMES.map(() => "?").join(", ");
  const toolParams: (string | number)[] = [eventTypeForEffectKind("tool"), ...TIMELINE_FAILURE_OUTCOME_NAMES, ...scopeParams];
  const toolFailureRows = db.prepare(
    `SELECT e.run_id AS run_id, e.description AS description, count(*) AS c FROM event_log e ` +
      `WHERE e.run_id IS NOT NULL AND e.event_type = ? AND e.outcome IN (${failureNames})${scopeSql} ` +
      `GROUP BY e.run_id, e.description`,
  ).all(...toolParams) as Record<string, unknown>[];

  // Every usage document of the scoped runs, decoded through the ONE
  // usage decoder — the same rule the run summary's token sums follow:
  // only documents that decode count, the rest are reported.
  const usageParams: (string | number)[] = [TIMELINE_TOKEN_USAGE_DOCUMENT, ...scopeParams];
  const usageRows = db.prepare(
    `SELECT e.run_id AS run_id, d.content_json AS content ` +
      `FROM event_log e JOIN event_documents d ON d.event_id = e.event_id ` +
      `WHERE e.run_id IS NOT NULL AND d.name = ?${scopeSql}`,
  ).all(...usageParams) as Record<string, unknown>[];

  type Fold = {
    runId: string; sessionId: string | null; events: number;
    byOutcome: Map<string, number>; llmCalls: number;
    firstWall: string | null; lastWall: string | null;
    prompt: number; completion: number; unparsed: number;
    toolFailures: Map<string, number>;
  };
  const byRun = new Map<string, Fold>();
  const foldOf = (runId: string, sessionId: string | null): Fold => {
    const existing = byRun.get(runId);
    if (existing !== undefined) return existing;
    const fresh: Fold = {
      runId, sessionId, events: 0, byOutcome: new Map(), llmCalls: 0,
      firstWall: null, lastWall: null, prompt: 0, completion: 0, unparsed: 0,
      toolFailures: new Map(),
    };
    byRun.set(runId, fresh);
    return fresh;
  };

  const PROVIDER_LANE = EFFECT_KIND_EVENT_TYPES.llm;
  for (const row of groups) {
    const fold = foldOf(String(row[RUN_ROLLUP_COLUMNS.runId]), row[RUN_ROLLUP_COLUMNS.sessionId] === null ? null : String(row[RUN_ROLLUP_COLUMNS.sessionId]));
    const count = Number(row[RUN_ROLLUP_COLUMNS.events]);
    fold.events += count;
    const outcome = row["outcome"] === null ? "—" : String(row["outcome"]);
    fold.byOutcome.set(outcome, (fold.byOutcome.get(outcome) ?? 0) + count);
    if (String(row["event_type"]) === PROVIDER_LANE) fold.llmCalls += count;
    const first = String(row[RUN_ROLLUP_COLUMNS.firstWall]);
    const last = String(row[RUN_ROLLUP_COLUMNS.lastWall]);
    if (fold.firstWall === null || first < fold.firstWall) fold.firstWall = first;
    if (fold.lastWall === null || last > fold.lastWall) fold.lastWall = last;
  }
  for (const row of usageRows) {
    // The groups pass above owns fold creation — every usage row's run is
    // in that population by construction (the same predicates).
    const fold = byRun.get(String(row[RUN_ROLLUP_COLUMNS.runId]))!;
    const content = row["content"] === null ? null : String(row["content"]);
    if (content === null) continue;
    const usage = decodeTokenUsageDocument(content);
    if (usage !== undefined) {
      fold.prompt += usage.promptTokens;
      fold.completion += usage.completionTokens;
    } else {
      fold.unparsed += 1;
    }
  }
  for (const row of toolFailureRows) {
    const fold = byRun.get(String(row[RUN_ROLLUP_COLUMNS.runId]))!;
    const description = String(row["description"]);
    fold.toolFailures.set(description, (fold.toolFailures.get(description) ?? 0) + Number(row[RUN_ROLLUP_COLUMNS.events]));
  }

  let runs: DigRunRollup[] = [...byRun.values()].map((fold) => {
    const durationMs =
      fold.firstWall !== null && fold.lastWall !== null
        ? Date.parse(fold.lastWall) - Date.parse(fold.firstWall)
        : Number.NaN;
    return {
      runId: fold.runId,
      sessionId: fold.sessionId,
      events: fold.events,
      firstWallTime: fold.firstWall ?? "",
      lastWallTime: fold.lastWall ?? "",
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      llmCalls: fold.llmCalls,
      promptTokens: fold.prompt,
      completionTokens: fold.completion,
      unparsedUsageDocuments: fold.unparsed,
      byOutcome: Object.fromEntries([...fold.byOutcome.entries()].sort(([a], [b]) => a.localeCompare(b))),
      failures: TIMELINE_FAILURE_OUTCOME_NAMES.reduce((n, name) => n + (fold.byOutcome.get(name) ?? 0), 0),
      toolFailures: [...fold.toolFailures.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([description, count]) => ({ description, count })),
    };
  });
  // Newest run first — the same direction the tail faces.
  runs.sort((a, b) => (a.lastWallTime === b.lastWallTime ? a.runId.localeCompare(b.runId) : a.lastWallTime > b.lastWallTime ? -1 : 1));
  // The absent-vs-empty seam sits on the SCOPE predicate only: without a
  // scope there is no id to be absent, so an empty ledger is an honest
  // empty list; with one (session or run-id set), zero runs means the
  // named session or the run-id set itself is absent — the caller must fix
  // the id, not read "no runs today".
  const scoped = opts.sessionId !== undefined || opts.runIds !== undefined;
  const scopeMatched = scoped ? runs.length > 0 : true;
  if (opts.failedOnly) runs = runs.filter((r) => r.failures > 0);
  if (opts.last !== undefined) runs = runs.slice(0, opts.last);
  return Object.freeze({
    sessionId: opts.sessionId ?? null,
    runIds: opts.runIds === undefined ? null : Object.freeze([...opts.runIds]),
    scopeMatched,
    runs: Object.freeze(runs),
  });
}

// ── Doctor (the one-shot diagnostic) ─────────────────────────────────────────

/**
 * Parse one gate-block document into the fields the doctor surfaces. The
 * document's parsed fields are the doctor's whole point: which fields
 * failed and whether the harness escalated, without parsing prose. A
 * document that does not parse is RETURNED as an unreadable verdict — the
 * honest observation rides in the answer itself, never silently dropped.
 */
function gateBlockOf(event: DigEvent, doc: DigDocument): DigDoctorGateBlock {
  let detail: { kind?: unknown; toolName?: unknown; failedFields?: unknown; escalated?: unknown };
  try {
    detail = JSON.parse(doc.contentJson ?? "{}") as typeof detail;
  } catch {
    return { sequence: event.sequence, toolName: "—", kind: "unreadable", failedFields: [], escalated: false };
  }
  return {
    sequence: event.sequence,
    toolName: typeof detail.toolName === "string" ? detail.toolName : "—",
    kind: typeof detail.kind === "string" ? detail.kind : "—",
    failedFields: Array.isArray(detail.failedFields) ? detail.failedFields.filter((f): f is string => typeof f === "string") : [],
    escalated: detail.escalated === true,
  };
}

/**
 * The collapsed three-move answer for "something went wrong, what?": find
 * the NEWEST run with failures (the newest run period when none failed),
 * then present its dig summary header, its failed events, its gate-block
 * documents and its provider payloads — exactly what the walk-through
 * teaches as three commands, in one. An honest `none` verdict when no run
 * qualifies (nothing to diagnose is an answer, not an error).
 */
export function doctorLedger(
  db: DatabaseSync,
  opts: Readonly<{ sessionId?: string; runIds?: readonly string[] }> = {},
): DigDoctorResult {
  const all = listRuns(db, opts);
  const chosen = all.runs.find((r) => r.failures > 0) ?? all.runs[0];
  if (chosen === undefined) {
    return Object.freeze({
      verdict: "none",
      sessionId: all.sessionId,
      runIds: all.runIds,
      scopeMatched: all.scopeMatched,
      runId: null,
      summary: null,
      failed: [],
      gateBlocks: [],
      llmPayloads: [],
    });
  }
  const dig = digLedger(db, { kind: "run", id: chosen.runId });
  const failureNames: readonly string[] = TIMELINE_FAILURE_OUTCOME_NAMES;
  const failed = dig.events.filter((e) => e.outcome !== null && failureNames.includes(e.outcome));
  const gateBlocks: DigDoctorGateBlock[] = [];
  for (const event of dig.events) {
    const doc = event.documents.find((d) => d.name === TIMELINE_GATE_BLOCK_DOCUMENT);
    if (doc === undefined) continue;
    gateBlocks.push(gateBlockOf(event, doc));
  }
  // The third taught move, narrowed to what it teaches: the provider lane's
  // events with their stored payloads + redacted args — what the model was
  // sent and what it answered. Every event carries an effect-args document,
  // so keeping all of them would flood the collapsed answer with db rows;
  // a provider event with no payload documents (a pre-capture run) stays
  // honestly absent from this section.
  const PROVIDER_LANE = EFFECT_KIND_EVENT_TYPES.llm;
  const llmPayloads = dig.events
    .filter((e) => e.eventType === PROVIDER_LANE)
    .map((event) => ({ event, documents: selectDocuments(event, "llm") }))
    .filter((entry) => entry.documents.length > 0);
  return Object.freeze({
    verdict: chosen.failures > 0 ? "failed-run" : "newest-run",
    sessionId: all.sessionId,
    runIds: all.runIds,
    scopeMatched: all.scopeMatched,
    runId: chosen.runId,
    summary: dig.summary,
    failed: Object.freeze(failed),
    gateBlocks: Object.freeze(gateBlocks),
    llmPayloads: Object.freeze(llmPayloads),
  });
}

// ── The follow cursor (tail --follow) ────────────────────────────────────────

/**
 * Each poll of `tail --follow` examines this many of the newest events and
 * keeps the ones after the cursor — the batch the stream prints, in causal
 * order (the story continues forward, it does not rewind to newest-first).
 * Bounded by design: a writer that outpaces this window between two polls
 * can leave gaps in the stream; lower the follow interval on a hot ledger.
 */
export const FOLLOW_WINDOW_EVENTS = 500;

/** The pure half of `tail --follow`: from a fetched window (newest-first,
 * the tail's own order) and the last-seen sequence, the events that are
 * NEW since the last poll — sequence greater than the cursor, ordered
 * causally — and the cursor to carry forward. A null cursor (the first
 * poll establishing the baseline) takes the whole window as new. */
export function nextFollowBatch(events: readonly DigEvent[], lastSeenSequence: string | null): DigFollowBatch {
  const cursor = lastSeenSequence === null ? null : Number(lastSeenSequence);
  const batch = events
    .filter((e) => cursor === null || Number(e.sequence) > cursor)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const newest = batch.length > 0 ? batch[batch.length - 1]! : null;
  return {
    batch: Object.freeze(batch),
    lastSeenSequence: newest !== null ? newest.sequence : lastSeenSequence,
  };
}

// ── Document views ───────────────────────────────────────────────────────────

/** The document names the provider-payload view prints. Derived from the
 * constants the writers use — never restated here. */
const LLM_PAYLOAD_DOCUMENT_NAMES: readonly string[] = Object.freeze([
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
  TIMELINE_EFFECT_ARGS_DOCUMENT,
]);

/**
 * Which of an event's documents a dump prints.
 *
 * `llm` keeps the provider payloads + redacted arguments (the incident view:
 * what the model was sent, what it answered, what it was invoked with).
 * `all` keeps EVERY stored document by NAME-AGNOSTIC passthrough — a new
 * document type a writer starts recording appears in the all-view the day it
 * lands, without a list to update here.
 */
export function selectDocuments(event: DigEvent, view: DigDocumentView): readonly DigDocument[] {
  if (view === "none") return [];
  if (view === "all") return event.documents;
  const keep = new Set(LLM_PAYLOAD_DOCUMENT_NAMES);
  return event.documents.filter((d) => keep.has(d.name));
}

// ── Summary ─────────────────────────────────────────────────────────────────

/** Decode an event's `effect-timing` document; undefined when absent/unreadable. */
function timingOf(event: DigEvent): TimelineEffectTiming | undefined {
  const doc = event.documents.find((d) => d.name === TIMELINE_EFFECT_TIMING_DOCUMENT);
  if (doc === undefined || doc.contentJson === null) return undefined;
  try {
    const parsed = JSON.parse(doc.contentJson) as Record<string, unknown>;
    if (typeof parsed["durationMs"] !== "number" || !Number.isFinite(parsed["durationMs"])) {
      return undefined;
    }
    return {
      durationMs: parsed["durationMs"],
      ...(typeof parsed["cpuMs"] === "number" && Number.isFinite(parsed["cpuMs"])
        ? { cpuMs: parsed["cpuMs"] }
        : {}),
      ...(typeof parsed["heapDeltaBytes"] === "number" && Number.isFinite(parsed["heapDeltaBytes"])
        ? { heapDeltaBytes: parsed["heapDeltaBytes"] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Sum the run's recorded token usage from its `usage` documents — through
 * the ONE usage decoder the timeline's synthesis reads also consume, so a
 * document that decodes here decodes everywhere; only documents that decode
 * count, the rest are reported, never silently folded in as zero. */
function tokenUsageOf(events: readonly DigEvent[]): {
  prompt: number;
  completion: number;
  unparsed: number;
} {
  let prompt = 0;
  let completion = 0;
  let unparsed = 0;
  for (const e of events) {
    for (const doc of e.documents) {
      if (doc.name !== TIMELINE_TOKEN_USAGE_DOCUMENT || doc.contentJson === null) continue;
      // The decoder is TOTAL: a stored document that does not decode is
      // EXPECTED bad material (counted below), represented as `undefined`
      // rather than a throw — the failure stays observable in this summary's
      // own unreadable count.
      const usage = decodeTokenUsageDocument(doc.contentJson);
      if (usage !== undefined) {
        prompt += usage.promptTokens;
        completion += usage.completionTokens;
      } else {
        unparsed += 1;
      }
    }
  }
  return { prompt, completion, unparsed };
}

function summarize(events: readonly DigEvent[]): DigSummary {
  const eventTypeCounts = new Map<string, number>();
  const toolGroups = new Map<string, Map<string, number>>();
  const errors: { sequence: string; description: string; outcome: string | null; category: string | null; code: string | null }[] = [];
  const traceIds = new Set<string>();
  let llmCalls = 0;
  let firstWall: string | null = null;
  let lastWall: string | null = null;

  // The lane names are DERIVED from the effect-kind table's own answers —
  // the provider lane is the event type an `llm` effect maps to, the tool
  // lane the one a `tool` effect maps to — so renaming a lane or re-mapping
  // a kind changes this summary with no literal restated here.
  const PROVIDER_LANE = EFFECT_KIND_EVENT_TYPES.llm;
  const TOOL_LANE = EFFECT_KIND_EVENT_TYPES.tool;

  for (const e of events) {
    eventTypeCounts.set(e.eventType, (eventTypeCounts.get(e.eventType) ?? 0) + 1);
    if (e.traceId !== null) traceIds.add(e.traceId);
    if (e.eventType === PROVIDER_LANE) llmCalls += 1;
    if (e.eventType === TOOL_LANE) {
      const outcomes = toolGroups.get(e.description) ?? new Map<string, number>();
      const key = e.outcome ?? "—";
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
      toolGroups.set(e.description, outcomes);
    }
    if (e.errorCode !== null) {
      errors.push({ sequence: e.sequence, description: e.description, outcome: e.outcome, category: e.errorCategory, code: e.errorCode });
    }
    if (e.wallTime !== null && (firstWall === null || e.wallTime < firstWall)) firstWall = e.wallTime;
    if (e.wallTime !== null && (lastWall === null || e.wallTime > lastWall)) lastWall = e.wallTime;
  }

  const usage = tokenUsageOf(events);
  const durationMs =
    firstWall !== null && lastWall !== null
      ? Date.parse(lastWall) - Date.parse(firstWall)
      : null;

  return {
    events: events.length,
    firstWallTime: firstWall,
    lastWallTime: lastWall,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    traceIds: [...traceIds],
    llmCalls,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    unparsedUsageDocuments: usage.unparsed,
    tools: [...toolGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([description, outcomes]) => ({
        description,
        total: [...outcomes.values()].reduce((n, c) => n + c, 0),
        byOutcome: Object.fromEntries([...outcomes.entries()].sort(([a], [b]) => a.localeCompare(b))),
      })),
    errors,
  };
}

// ── Grouping ────────────────────────────────────────────────────────────────

/** A run/trace dump's turn grouping: run-level events at the top level,
 * turn-correlated events indented under their turn's header. */
export type DigTurnGroup = Readonly<{
  /** The turn id this group holds, or null for the run-level group. */
  turnId: string | null;
  events: readonly DigEvent[];
}>;

/**
 * Group a dump's events by turn, in the dump's own order. A group opens at
 * the first event whose `turnId` differs from the previous one's — the
 * recorded correlation IS the grouping, nothing is inferred from event
 * types or ordering alone.
 */
export function groupByTurn(events: readonly DigEvent[]): readonly DigTurnGroup[] {
  const groups: { turnId: string | null; events: DigEvent[] }[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last === undefined || last.turnId !== e.turnId) {
      groups.push({ turnId: e.turnId, events: [e] });
    } else {
      last.events.push(e);
    }
  }
  return groups.map((g) => Object.freeze({ turnId: g.turnId, events: Object.freeze([...g.events]) }));
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Byte deltas in the unit a person reads: negative = a net release. */
function heapSay(bytes: number): string {
  const kib = Math.round(bytes / 1_024);
  return `${kib >= 0 ? "+" : "−"}${Math.abs(kib)}KiB`;
}

function msSay(ms: number): string {
  return ms < MS_PER_SECOND ? `${Math.round(ms)}ms` : `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

/** The `took` cell: duration, plus CPU/ram when the resource deltas were
 * captured. Absent measurement renders as "—" — never an invented zero. */
function tookOf(event: DigEvent): string {
  const timing = timingOf(event);
  if (timing === undefined) return "—";
  let say = msSay(timing.durationMs);
  if (timing.cpuMs !== undefined) say += ` · cpu ${msSay(timing.cpuMs)}`;
  if (timing.heapDeltaBytes !== undefined) say += ` · ram ${heapSay(timing.heapDeltaBytes)}`;
  return say;
}

/** One event line. `indent` marks a turn-grouped row with the turn gutter
 * (a top-level row carries the same four-character pad, so the columns stay
 * aligned and the gutter is the ONLY thing that differs); `withIds` prints
 * the run/trace ids (the tail view, where a row may come from anywhere).
 * Module-private: the text dump is the public surface; this is its unit. */
function formatEventLine(event: DigEvent, opts: Readonly<{ indent?: boolean; withIds?: boolean }> = {}): string {
  const seq = event.sequence.padStart(6, " ");
  const time = event.wallTime.slice(11, 23);
  const type = event.eventType.padEnd(11, " ");
  const outcome = (event.outcome ?? "—").padEnd(10, " ");
  const took = tookOf(event).padEnd(24, " ");
  const ids = opts.withIds
    ? `  · ${event.runId ?? "—"} · ${event.traceId ?? "—"}`
    : "";
  const err = event.errorCode !== null
    ? `  [error ${event.errorCategory ?? "—"}/${event.errorCode}]`
    : "";
  const prefix = opts.indent === true ? "  │ " : "    ";
  return `${prefix}${seq}  ${time}  ${type} ${outcome} ${took} ${event.description}${ids}${err}`;
}

/** The summary's body — the facts under the scope line, shared verbatim by
 * the run/trace/tail header and the doctor's collapsed header. */
function summaryBodyLines(s: DigSummary): string[] {
  const span =
    s.firstWallTime !== null && s.lastWallTime !== null
      ? `${s.firstWallTime.slice(11, 23)} → ${s.lastWallTime.slice(11, 23)}` +
        (s.durationMs !== null ? ` (${msSay(s.durationMs)} wall)` : "")
      : "no events";
  const lines = [
    `  events    ${s.events} · ${span}`,
    `  trace     ${s.traceIds.length > 0 ? s.traceIds.join(" · ") : "—"}`,
    `  llm       ${s.llmCalls} call${s.llmCalls === 1 ? "" : "s"}` +
      (s.promptTokens + s.completionTokens > 0
        ? ` · ${s.promptTokens.toLocaleString("en-US")} in · ${s.completionTokens.toLocaleString("en-US")} out`
        : "") +
      (s.unparsedUsageDocuments > 0 ? ` · ${s.unparsedUsageDocuments} unreadable usage document(s)` : ""),
    `  tools     ${s.tools.length > 0
      ? s.tools.map((t) => `${t.description} ×${t.total} (${Object.entries(t.byOutcome).map(([o, n]) => `${o} ${n}`).join(" · ")})`).join(" · ")
      : "—"}`,
    `  errors    ${s.errors.length} with recorded error detail`,
  ];
  return lines;
}

function summaryLines(result: DigResult): string[] {
  const scopeSay =
    result.scope.kind === "run" ? `run ${result.scope.id}`
    : result.scope.kind === "trace" ? `trace ${result.scope.id}`
    : `tail of ${result.scope.limit}`;
  return [scopeSay, ...summaryBodyLines(result.summary)];
}

/** Print one event's documents verbatim, under its line. */
function documentLines(event: DigEvent, view: DigDocumentView, indent: boolean): string[] {
  const docs = selectDocuments(event, view);
  const out: string[] = [];
  const gutter = indent ? "  │" : "   ";
  for (const doc of docs) {
    out.push(`${gutter}    ┆ document ${doc.name}`);
    out.push(`${gutter}    ┆ digest ${doc.contentDigest}`);
    if (doc.contentJson === null && doc.orderedJson === null) out.push(`${gutter}    ┆ digest-only (no inline content)`);
    for (const field of ["contentJson", "orderedJson"] as const) {
      const body = doc[field];
      if (body === null) continue;
      out.push(`${gutter}    ┆ ${field}`);
      for (const line of body.split("\n")) out.push(`${gutter}    ┆ ${line}`);
    }
  }
  return out;
}

/**
 * The human-readable dump. Summary header, then the events in causal order —
 * grouped/indented by turn for run/trace scopes, flat with run/trace ids
 * for the tail — then the selected documents under each event.
 */
export function formatDigText(result: DigResult, view: DigDocumentView): string {
  const lines: string[] = [...summaryLines(result), ""];
  const grouped = result.scope.kind !== "tail";
  if (grouped) {
    for (const group of groupByTurn(result.events)) {
      if (group.turnId !== null) {
        lines.push(`turn ${group.turnId}`);
      }
      for (const e of group.events) {
        lines.push(formatEventLine(e, { indent: group.turnId !== null }));
        lines.push(...documentLines(e, view, group.turnId !== null));
      }
    }
  } else {
    for (const e of result.events) {
      lines.push(formatEventLine(e, { withIds: true }));
      lines.push(...documentLines(e, view, false));
    }
  }
  return lines.join("\n");
}

/** One follow batch as text — the tail's own flat, id-carrying line shape,
 * in the batch's causal order (the stream continues the story forward). */
export function formatFollowText(events: readonly DigEvent[], view: DigDocumentView): string {
  const lines: string[] = [];
  for (const e of events) {
    lines.push(formatEventLine(e, { withIds: true }));
    lines.push(...documentLines(e, view, false));
  }
  return lines.join("\n");
}

/** The machine-readable dump: the complete structured result, documents
 * included per the same view the text dump uses. */
export function formatDigJson(result: DigResult, view: DigDocumentView): string {
  return JSON.stringify(
    {
      scope: result.scope,
      scopeMatched: result.scopeMatched,
      summary: result.summary,
      events: result.events.map((e) => ({
        ...e,
        documents: selectDocuments(e, view).map((d) => ({ ...d })),
      })),
    },
    null,
    2,
  );
}

// ── `runs` formatting ────────────────────────────────────────────────────────

/** One rolled-up run as one line: the cold-start scan reads down a list of
 * these and knows which run to dig into. */
function runRollupLine(run: DigRunRollup): string {
  const outcomes = Object.entries(run.byOutcome).map(([o, n]) => `${o} ${n}`).join(" · ");
  const tokens =
    run.llmCalls > 0
      ? `  llm ${run.llmCalls} call${run.llmCalls === 1 ? "" : "s"}` +
        (run.promptTokens + run.completionTokens > 0
          ? ` · ${run.promptTokens.toLocaleString("en-US")} in · ${run.completionTokens.toLocaleString("en-US")} out`
          : "")
      : "";
  const failedTools =
    run.toolFailures.length > 0
      ? `  failed tools: ${run.toolFailures.map((t) => `${t.description} ×${t.count}`).join(", ")}`
      : "";
  const span =
    `${run.firstWallTime.slice(11, 23)} → ${run.lastWallTime.slice(11, 23)}` +
    (run.durationMs !== null ? ` (${msSay(run.durationMs)} wall)` : "");
  const session = run.sessionId === null ? "" : `  session ${run.sessionId}`;
  return `  ${run.runId}  ${span}  ${run.events} events  ${outcomes}${tokens}${failedTools}${session}`;
}

/** The human-readable `runs` dump — newest first, one line per run. */
export function formatRunsText(result: DigRunsResult, failedOnly: boolean): string {
  // The empty answer says WHICH scope came up empty — the absent-vs-empty
  // seam in words: a named session or run-id set that matched nothing is
  // reported as its own case, never as "no runs in the ledger".
  const header =
    result.runs.length === 0
      ? result.sessionId !== null
        ? `runs — no runs for session ${result.sessionId}`
        : result.runIds !== null
          ? result.runIds.length === 0
            ? "runs — the chat resolved to no runs (no message ever recorded one)"
            : `runs — no runs among the given ${result.runIds.length} run id(s)`
          : failedOnly
            ? "runs — no run in the ledger has failed or denied events"
            : "runs — no runs in the ledger"
      : failedOnly
        ? `runs — ${result.runs.length} run(s) with failures, newest first`
        : `runs — ${result.runs.length} run(s), newest first`;
  return [header, ...result.runs.map(runRollupLine)].join("\n");
}

/** The machine-readable `runs` dump. */
export function formatRunsJson(result: DigRunsResult): string {
  return JSON.stringify(result, null, 2);
}

// ── `doctor` formatting ─────────────────────────────────────────────────────

/** The human-readable `doctor` dump — the three taught moves, collapsed
 * into one answer: the header, the failed events, the gate blocks, the
 * provider payloads. */
export function formatDoctorText(result: DigDoctorResult): string {
  if (result.verdict === "none") {
    const scope =
      result.sessionId !== null
        ? `no runs for session ${result.sessionId}`
        : result.runIds !== null
          ? result.runIds.length === 0
            ? "the chat resolved to no runs"
            : `no runs among the given ${result.runIds.length} run id(s)`
          : "no runs in the ledger";
    return `doctor — ${scope}, nothing to diagnose`;
  }
  const headline =
    result.verdict === "failed-run"
      ? "the newest run with failures"
      : "no run has failures; the newest run";
  const lines: string[] = [`doctor — ${headline}`, `run ${result.runId}`, ...summaryBodyLines(result.summary!)];
  // The --failed move: the events themselves, no documents under them —
  // the gate blocks and payloads have their own collapsed sections below.
  lines.push("", `failed events — ${result.failed.length}`);
  for (const e of result.failed) {
    lines.push(formatEventLine(e, { indent: false }));
  }
  lines.push("", `gate blocks — ${result.gateBlocks.length}`);
  for (const block of result.gateBlocks) {
    const fields = block.failedFields.length > 0 ? `failed fields: ${block.failedFields.join(", ")}` : "no failed fields recorded";
    lines.push(`  seq ${block.sequence}  ${block.toolName}  ${block.kind}  ${fields}${block.escalated ? "  escalated" : ""}`);
  }
  lines.push("", `llm payloads — ${result.llmPayloads.length} event(s)`);
  for (const entry of result.llmPayloads) {
    lines.push(formatEventLine(entry.event, { indent: false }));
    lines.push(...documentLines(entry.event, "llm", false));
  }
  return lines.join("\n");
}

/** The machine-readable `doctor` dump. */
export function formatDoctorJson(result: DigDoctorResult): string {
  return JSON.stringify(result, null, 2);
}

// ── The follow stream's constants ────────────────────────────────────────────

/** The `--follow` stream's poll cadence: how often the tail re-reads the
 * newest window for new events when the caller did not name one. A CLI
 * ergonomic owned here — the flag overrides it per invocation — not a
 * runtime config knob. */
export const TAIL_FOLLOW_POLL_MS = 1_000;

// ── The --schema printer (the JSON contract, derived from the shapes) ────────

/** One field of the JSON contract: its type, whether it may be null or be
 * absent, its members (object) or element (array), and the note that says
 * what a consumer must know. */
export type DigSchemaField = Readonly<{
  type: "string" | "number" | "boolean" | "array" | "object";
  nullable?: boolean;
  optional?: boolean;
  fields?: Readonly<Record<string, DigSchemaField>>;
  items?: DigSchemaField;
  note?: string;
}>;

const schemaDocument = (): DigSchemaField => ({
  type: "object",
  fields: {
    name: { type: "string" },
    contentJson: { type: "string", nullable: true, note: "exact stored text; may be empty or non-JSON" },
    orderedJson: { type: "string", nullable: true, note: "exact ordered text, without parsing or reserialization" },
    contentDigest: { type: "string", note: "recorded SHA256 UTF8 digest, or digest-only reference when both inline fields are null" },
  },
});

const schemaEvent = (): DigSchemaField => ({
  type: "object",
  fields: {
    eventId: { type: "string" },
    sequence: { type: "string", note: "decimal string of the causal total order" },
    wallTime: { type: "string", note: "ISO-8601" },
    eventType: { type: "string", note: "a member of the recorded event-type vocabulary" },
    outcome: { type: "string", nullable: true, note: "the verdict column — read this, never error-field presence" },
    traceId: { type: "string", nullable: true },
    runId: { type: "string", nullable: true },
    turnId: { type: "string", nullable: true },
    spanId: { type: "string", nullable: true },
    description: { type: "string" },
    errorCategory: { type: "string", nullable: true },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    documents: { type: "array", items: schemaDocument() },
  },
});

const schemaSummary = (): DigSchemaField => ({
  type: "object",
  fields: {
    events: { type: "number" },
    firstWallTime: { type: "string", nullable: true },
    lastWallTime: { type: "string", nullable: true },
    durationMs: { type: "number", nullable: true },
    traceIds: { type: "array", items: { type: "string" } },
    llmCalls: { type: "number" },
    promptTokens: { type: "number" },
    completionTokens: { type: "number" },
    unparsedUsageDocuments: { type: "number" },
    tools: { type: "array", items: { type: "object", fields: {
      description: { type: "string" },
      total: { type: "number" },
      byOutcome: { type: "object", note: "record: outcome name → count" },
    } } },
    errors: { type: "array", items: { type: "object", fields: {
      sequence: { type: "string" },
      description: { type: "string" },
      outcome: { type: "string", nullable: true },
      category: { type: "string", nullable: true },
      code: { type: "string", nullable: true },
    } } },
  },
});

/**
 * The JSON contract of every command's `--json` output — a table-driven
 * description of the type shapes this module defines (they sit above; this
 * table is their one documentation), kept honest by the owning test, which
 * walks every command's REAL --json output against this table in both
 * directions. The document names are derived from the wire-literal owners
 * the writers use, never restated here.
 */
export const DIG_JSON_SCHEMA: Readonly<Record<string, DigSchemaField>> = Object.freeze({
  "run | trace | tail": Object.freeze({
    type: "object",
    note: "the dig result; scope echoes { kind, id } for run/trace and { kind, limit } for tail",
    fields: Object.freeze({
      scope: Object.freeze({
        type: "object",
        note: "the echoed scope: kind plus id (run/trace) or limit (tail)",
        fields: Object.freeze({
          kind: Object.freeze({ type: "string", note: "run | trace | tail" }),
          id: Object.freeze({ type: "string", optional: true, note: "the run/trace id; absent for the tail scope" }),
          limit: Object.freeze({ type: "number", optional: true, note: "the tail's event budget; absent for run/trace scopes" }),
        }),
      }),
      scopeMatched: Object.freeze({ type: "boolean", note: "whether the scope predicate matched, ignoring filters — false means the id is absent (a typo)" }),
      summary: Object.freeze(schemaSummary()),
      events: Object.freeze({ type: "array", items: Object.freeze(schemaEvent()) }),
    }),
  }),
  runs: Object.freeze({
    type: "object",
    fields: Object.freeze({
      sessionId: Object.freeze({ type: "string", nullable: true, note: "the session filter, echoed; null when none was given" }),
      runIds: Object.freeze({ type: "array", nullable: true, items: Object.freeze({ type: "string" }), note: "the run-id scope, echoed; null when none was given — an empty array means the resolved scope itself is absent" }),
      scopeMatched: Object.freeze({ type: "boolean", note: "false means the named session or run-id set matched no run — the scope is absent, not empty" }),
      runs: Object.freeze({
        type: "array",
        items: Object.freeze({
          type: "object",
          fields: Object.freeze({
            runId: Object.freeze({ type: "string" }),
            sessionId: Object.freeze({ type: "string", nullable: true, note: "the harness web session the run was recorded under — never a chat id" }),
            events: Object.freeze({ type: "number" }),
            firstWallTime: Object.freeze({ type: "string", note: "ISO-8601" }),
            lastWallTime: Object.freeze({ type: "string", note: "ISO-8601" }),
            durationMs: Object.freeze({ type: "number", nullable: true }),
            llmCalls: Object.freeze({ type: "number" }),
            promptTokens: Object.freeze({ type: "number" }),
            completionTokens: Object.freeze({ type: "number" }),
            unparsedUsageDocuments: Object.freeze({ type: "number" }),
            byOutcome: Object.freeze({ type: "object", note: "record: outcome name → event count" }),
            failures: Object.freeze({ type: "number", note: "events whose outcome carries the failure disposition (failed or denied)" }),
            toolFailures: Object.freeze({ type: "array", items: Object.freeze({
              type: "object",
              fields: Object.freeze({
                description: Object.freeze({ type: "string" }),
                count: Object.freeze({ type: "number" }),
              }),
            }) }),
          }),
        }),
      }),
    }),
  }),
  doctor: Object.freeze({
    type: "object",
    fields: Object.freeze({
      verdict: Object.freeze({ type: "string", note: "failed-run | newest-run | none" }),
      sessionId: Object.freeze({ type: "string", nullable: true, note: "the session filter, echoed; null when none was given" }),
      runIds: Object.freeze({ type: "array", nullable: true, items: Object.freeze({ type: "string" }), note: "the run-id scope, echoed; null when none was given" }),
      scopeMatched: Object.freeze({ type: "boolean", note: "false means the named session or run-id set matched no run — the scope is absent, not empty" }),
      runId: Object.freeze({ type: "string", nullable: true }),
      summary: Object.freeze({ ...schemaSummary(), nullable: true, note: "the chosen run's dig summary; null when nothing qualifies" }),
      failed: Object.freeze({ type: "array", items: Object.freeze(schemaEvent()) }),
      gateBlocks: Object.freeze({ type: "array", items: Object.freeze({
        type: "object",
        fields: Object.freeze({
          sequence: Object.freeze({ type: "string" }),
          toolName: Object.freeze({ type: "string" }),
          kind: Object.freeze({ type: "string" }),
          failedFields: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
          escalated: Object.freeze({ type: "boolean" }),
        }),
      }) }),
      llmPayloads: Object.freeze({ type: "array", items: Object.freeze({
        type: "object",
        fields: Object.freeze({
          event: Object.freeze(schemaEvent()),
          documents: Object.freeze({ type: "array", items: Object.freeze(schemaDocument()) }),
        }),
      }) }),
    }),
  }),
  anatomy: Object.freeze({
    type: "object",
    note: "composed by the shell from the census and component-registry owners",
    fields: Object.freeze({
      processes: Object.freeze({ type: "array", items: Object.freeze({ type: "object", note: "the per-process shape lives with the census owner, server/observability/process-census.ts (pinned by its own suite)" }) }),
      components: Object.freeze({ type: "array", nullable: true, items: Object.freeze({ type: "object", note: "the per-component shape lives with the registry owner, server/observability/component-registry.ts; null when the server is down or refused the dev session" }) }),
      componentsUnavailable: Object.freeze({ type: "string", optional: true, note: "the honest reason the registry is absent, present only then" }),
    }),
  }),
});

/** The document names the dig itself understands — derived from the
 * wire-literal owners the writers join on, never a restated list. */
export const DIG_KNOWN_DOCUMENT_NAMES: readonly string[] = Object.freeze([
  TIMELINE_EFFECT_TIMING_DOCUMENT,
  TIMELINE_EFFECT_ARGS_DOCUMENT,
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
  TIMELINE_TOKEN_USAGE_DOCUMENT,
  TIMELINE_GATE_BLOCK_DOCUMENT,
  TIMELINE_RESOURCE_METRIC_DOCUMENT,
]);

/**
 * The `--schema` answer: every command's --json contract (from the table
 * beside the types), the document vocabulary with the exact-text note,
 * and the exit-code contract. JSON by design — the consumer is a script
 * or a model, and the usage screen is the human door.
 */
export function formatSchemaJson(): string {
  return JSON.stringify(
    {
      commands: DIG_JSON_SCHEMA,
      documents: {
        name: "an open vocabulary — the --documents view passes any stored document name through",
        knownNames: DIG_KNOWN_DOCUMENT_NAMES,
        contentJson: "exact stored text, including empty and non-JSON text; parse only for display, never to recompute its digest",
        orderedJson: "exact ordered text; both inline fields null means a digest-only reference",
        contentDigest: "recorded SHA256 of exact UTF8 inline text, or an external reference digest; historical reads do not revalidate it",
      },
      exitCodes: {
        "0": "an answer was produced — including an honest empty scope (the filters matched nothing inside an existing run/trace/chat)",
        "1": "the scope itself is absent (no run/trace/chat with that id — a typo) or the arguments are invalid",
      },
    },
    null,
    2,
  );
}
