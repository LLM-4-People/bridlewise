/**
 * THE SYNTHESIS ENGINE — first blocks.
 *
 * The system holds a causal ledger, a code graph, checks and context metrics,
 * and until now computed NOTHING across them. These three blocks are the first
 * honest cross-record computations:
 *
 *   - `synthesis.conversationPulse` — one computed rollup of one conversation
 *     from the ledger: files touched, tools used, errors hit, tokens
 *     exchanged, wall-time span. Every fact carries a `derivation` sentence
 *     naming exactly which recorded rows produced it.
 *
 *   - `synthesis.echoes` — exact precedent-matching over the complete record:
 *     which PAST runs touched the same files, with each match's own recorded
 *     outcome facts. The join is string equality on the path the recorder
 *     wrote into the effect document — never a fuzzy match, never a guess.
 *
 *   - `synthesis.contextForecast` — a deterministic extrapolation, LABELED as
 *     one: measured token records → a projection carrying `kind:
 *     "projection"`, its assumption, and its arithmetic spelled out. Under
 *     three data points it refuses instead of extrapolating from noise.
 *
 * THE STANDARD (and the reason this module is worth having): exact joins over
 * recorded data, never fabrication. Every measured fact states its
 * derivation; everything not derivable is ABSENT with an honest reason —
 * never a plausible zero, never an unlabeled guess. A projection is
 * structurally distinct (`kind: "projection"`) from a measurement
 * (`status: "measured"`), so a UI cannot render one as the other by accident.
 *
 * WHERE THE QUERIES LIVE — THE LEDGER'S OWNER, NOT HERE
 *
 * Same rule as `coverage.ts`: this module contains NO SQL and opens NO
 * database handle. The reads are `runActivitySummaries()` /
 * `fileEffectFacts()` on the canonical timeline store — added THERE, with
 * EXPLAIN-verified plan tests beside them in
 * `integration/test/timeline/timeline-synthesis-facts.test.ts`.
 *
 * OWNERSHIP — RUN-SCOPED CONTENT, GATED LIKE `lens.ancestry`
 *
 * Unlike the coverage blocks (aggregate counts over closed vocabularies),
 * these blocks return event-derived CONTENT (paths, tool descriptions,
 * timestamps), so they apply run ownership, not just authentication:
 *
 *   - a `chatId` is resolved through `await db.getChat(chatId, userId)` (null →
 *     404, existence hidden) and `await db.runIdsForChat(chatId, userId)` — the
 *     same choke points `POST /api/timeline/query` uses;
 *   - a `runId` entry point must pass `db.runBelongsToUser`;
 *   - `echoes` matches can land in OTHER users' runs: those are reported as
 *     a COUNT (`withheldRuns`), never as ids or facts — the same
 *     count-not-content rule `walkTrace` applies to withheld trace events;
 *   - events with NO run attribution have no user provenance, so they too
 *     are counted, never itemised.
 *
 * RECORDING HISTORY, STATED RATHER THAN PAPERED OVER: `file-effect` rows
 * recorded before 2026-07-26 carry no run_id (the live ledger measured 0 of
 * 2,149 attributed at build time). That was NOT the recorder dropping the
 * correlation — verified by exercising the real editor-bridge write inside a
 * `withRecordingContext({runId})` boundary: the recorder's ambient merge
 * (harness `timeline-recorder.ts` `mergeCorrelation`) attributes the event.
 * The historic rows were written before the run boundary landed, or by
 * processes legitimately outside any run (test suites, human saves). The
 * joins here are built on run attribution because that is the honest key;
 * pre-boundary rows stay in the `unattributed` counts, reported as what
 * they are.
 */

import { z } from "zod";

import type {
  TimelineCheckStatusFacts,
  TimelineCheckStatusFactsFilter,
  TimelineFileEffectFacts,
  TimelineFileEffectFactsFilter,
  TimelineRunActivitySummary,
} from "../kernel/canonical.ts";
import { MAX_FORECAST_WINDOW_TOKENS } from "../kernel/config.ts";
import { NotFoundError } from "../kernel/errors.ts";
import { getTimelineStore } from "../observability/timeline-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { RouteContext } from "../router/router.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

// ── Ceilings ───────────────────────────────────────────────────────────────

/** Most paths one echoes query may name (the store port caps at 200). */
export const ECHOES_MAX_PATHS = 50;
/** Most paths listed verbatim in a pulse (the count is always complete). */
const PULSE_PATH_LIST_CAP = 100;
/** Most matched runs itemised by echoes (the counts are always complete). */
const ECHOES_MAX_MATCHES = 50;
/** Minimum token-usage records before a projection is allowed. */
export const FORECAST_MIN_SAMPLES = 3;

/**
 * The date the check-status history stream began: `createAutoCheck`
 * (`server/db/client.ts`) records an append-only check-status event in the
 * timeline ledger beside its latest-status upsert since this date. The upsert
 * alone destroys history at write time — the UPDATE overwrites `status` in
 * place — which is why `checksFlipped` was refused before the stream existed.
 */
export const CHECK_STATUS_HISTORY_SINCE = "2026-07-26";

/**
 * Why check flips are unavailable for a conversation with NO recorded
 * check-status events: history that was never recorded cannot be derived,
 * and pretending otherwise is exactly the fabrication this module exists to
 * refuse. Conversations from before `CHECK_STATUS_HISTORY_SINCE` predate the
 * stream entirely; for them this absence is expected, not a recording bug.
 */
export const CHECKS_FLIPPED_UNAVAILABLE_REASON =
  "no check-status records exist for this conversation's runs or chat — " +
  `check-status history has been recorded in the ledger only since ${CHECK_STATUS_HISTORY_SINCE}, ` +
  "so earlier conversations predate the stream; an absence of records is not proof no check ran";

/** The check statuses that are RESULTS. `running` marks a start, not a result. */
const SETTLED_CHECK_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "warning"]);

// ── Result grammar: measured / unavailable / projection / refused ──────────

/** A fact that was computed from recorded rows, or an honest absence. */
export type SynthesisFact<T> =
  | Readonly<{ status: "measured"; value: T; derivation: string }>
  | Readonly<{ status: "unavailable"; reason: string }>;

/**
 * An extrapolation. NEVER carries `status: "measured"` — the `kind` field is
 * the structural marker that separates arithmetic-over-the-future from
 * facts-about-the-past, and the mutation test pins it.
 */
export type SynthesisProjection =
  | Readonly<{ kind: "projection"; value: number; unit: string; assumption: string; derivation: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

function measured<T>(value: T, derivation: string): SynthesisFact<T> {
  return Object.freeze({ status: "measured", value, derivation });
}

function unavailable<T>(reason: string): SynthesisFact<T> {
  return Object.freeze({ status: "unavailable", reason });
}

// ── The ledger capabilities these blocks need ──────────────────────────────

/** Structural subset of the canonical store port, bindable to a temp store in tests. */
export type SynthesisPort = Readonly<{
  runActivitySummaries(runIds: readonly string[]): readonly TimelineRunActivitySummary[];
  fileEffectFacts(filter: TimelineFileEffectFactsFilter): TimelineFileEffectFacts;
  checkStatusFacts(filter: TimelineCheckStatusFactsFilter): TimelineCheckStatusFacts;
}>;

/** The production port: the bridge-owned canonical store, resolved lazily. */
function liveSynthesisPort(): SynthesisPort {
  return getTimelineStore();
}

// ── synthesis.conversationPulse ────────────────────────────────────────────

export type PulseTokenTotals = Readonly<{
  usageRecords: number;
  unparsedUsageRecords: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

export type ConversationPulse = Readonly<{
  runs: Readonly<{ known: number; withEvents: number; derivation: string }>;
  filesTouched: SynthesisFact<
    Readonly<{
      distinctPaths: number;
      records: number;
      paths: readonly string[];
      pathListTruncated: boolean;
    }>
  >;
  toolsUsed: SynthesisFact<
    Readonly<{ events: number; byRecordedDescription: Readonly<Record<string, number>> }>
  >;
  errors: SynthesisFact<Readonly<{ eventsWithErrorDetail: number; failedOutcomes: number }>>;
  tokens: SynthesisFact<PulseTokenTotals>;
  wallTimeSpan: SynthesisFact<
    Readonly<{ firstEventAt: string; lastEventAt: string; events: number }>
  >;
  checksFlipped: SynthesisFact<ChecksFlippedValue>;
}>;

export type ChecksFlippedValue = Readonly<{
  /** Settled-status changes (passed/failed/warning → a DIFFERENT one), summed. */
  flips: number;
  /** Per check: how many times its settled status changed. 0 is a proven zero. */
  byCheck: Readonly<Record<string, number>>;
  /** Decoded check-status records in this conversation's scope. */
  statusRecords: number;
  /** Records whose recorded status is not a result (e.g. `running`). */
  transitionalRecords: number;
  /** Quality events in scope whose check-status document did not decode. */
  undecodableRecords: number;
  /** True when the read hit its ceiling — counts are then lower bounds. */
  truncated: boolean;
}>;

/**
 * Derive check flips from the append-only check-status events the auto-checks
 * owner records beside its latest-status upsert (see `server/db/client.ts`
 * `recordCheckStatusEvent`; history exists since `CHECK_STATUS_HISTORY_SINCE`).
 *
 * THE DERIVATION, IN PLAIN LANGUAGE: collect this conversation's check-status
 * records — those attributed to its runs (a check upserted inside a run
 * boundary) OR recorded against the chat itself (a check run from the panel,
 * outside any run). Group them per check, walk each group's SETTLED statuses
 * (passed/failed/warning) in ledger order, and count every change from one
 * settled status to a different one as one flip. `running` records mark that
 * a check started, not what it found, so they never flip anything — a
 * passed→running→failed sequence is exactly one flip (passed→failed).
 *
 * A conversation with NO records gets an honest absence, not a zero: chats
 * predating the history stream recorded nothing to derive from.
 */
function deriveChecksFlipped(
  port: SynthesisPort,
  runIds: readonly string[],
  chatId: string | undefined,
): SynthesisFact<ChecksFlippedValue> {
  if (runIds.length === 0 && chatId === undefined) {
    return unavailable(CHECKS_FLIPPED_UNAVAILABLE_REASON);
  }
  const result = port.checkStatusFacts({
    ...(runIds.length > 0 ? { runIds } : {}),
    ...(chatId !== undefined ? { chatIds: [chatId] } : {}),
  });
  if (result.facts.length === 0) {
    return unavailable(CHECKS_FLIPPED_UNAVAILABLE_REASON);
  }
  // Facts arrive in ledger order (ascending sequence) — the walk relies on it.
  const lastSettledByCheck = new Map<string, string>();
  const flipsByCheck = new Map<string, number>();
  let transitionalRecords = 0;
  for (const fact of result.facts) {
    // Project-level and chat-level checks with the same name are different
    // checks; folding them together could fabricate flips out of interleaved
    // scopes.
    const key = fact.chatId === null ? `${fact.checkName} (project-level)` : fact.checkName;
    if (!SETTLED_CHECK_STATUSES.has(fact.toStatus)) {
      transitionalRecords += 1;
      continue;
    }
    const previous = lastSettledByCheck.get(key);
    if (previous === undefined) {
      flipsByCheck.set(key, flipsByCheck.get(key) ?? 0);
    } else if (previous !== fact.toStatus) {
      flipsByCheck.set(key, (flipsByCheck.get(key) ?? 0) + 1);
    }
    lastSettledByCheck.set(key, fact.toStatus);
  }
  let flips = 0;
  const byCheck: Record<string, number> = {};
  for (const [key, count] of flipsByCheck) {
    byCheck[key] = count;
    flips += count;
  }
  return measured(
    Object.freeze({
      flips,
      byCheck: Object.freeze(byCheck),
      statusRecords: result.facts.length,
      transitionalRecords,
      undecodableRecords: result.undecodableCheckEvents,
      truncated: result.truncated,
    }),
    `derived from ${result.facts.length} check-status records recorded for this conversation (attributed to its runs, or recorded against the chat itself): ` +
      "per check, the settled statuses (passed/failed/warning) were walked in ledger order and each change to a different settled status counts as one flip; " +
      `'running' records mark starts, not results, and never flip${result.undecodableCheckEvents > 0 ? `; ${result.undecodableCheckEvents} quality events did not decode and are counted, not guessed at` : ""}` +
      `${result.truncated ? "; the record set hit the read ceiling, so counts are lower bounds" : ""}` +
      `; check-status history has been recorded since ${CHECK_STATUS_HISTORY_SINCE}`,
  );
}

/**
 * One conversation, rolled up from its runs' ledger rows. Pure with respect
 * to the port so every fact and every honest absence is testable without a
 * database. `chatId` widens ONLY the check-status read: checks run from the
 * panel happen outside any run and are reachable solely through the chat id
 * their event recorded.
 */
export function computeConversationPulse(
  port: SynthesisPort,
  runIds: readonly string[],
  chatId?: string,
): ConversationPulse {
  const checksFlipped = deriveChecksFlipped(port, runIds, chatId);
  if (runIds.length === 0) {
    const reason =
      "this conversation has no recorded runs (run ids come from the conversation's message records), so there is nothing to aggregate";
    return Object.freeze({
      runs: Object.freeze({
        known: 0,
        withEvents: 0,
        derivation: "run ids resolved from this conversation's message records; none exist",
      }),
      filesTouched: unavailable<never>(reason),
      toolsUsed: unavailable<never>(reason),
      errors: unavailable<never>(reason),
      tokens: unavailable<never>(reason),
      wallTimeSpan: unavailable<never>(reason),
      checksFlipped,
    });
  }

  const summaries = port.runActivitySummaries(runIds);
  const runsLine = Object.freeze({
    known: runIds.length,
    withEvents: summaries.length,
    derivation: `${runIds.length} run ids resolved from this conversation's message records; ${summaries.length} of them have ledger events`,
  });
  if (summaries.length === 0) {
    const reason = `none of this conversation's ${runIds.length} run ids match any ledger event — the runs exist in the conversation record but recorded nothing to the timeline`;
    return Object.freeze({
      runs: runsLine,
      filesTouched: unavailable<never>(reason),
      toolsUsed: unavailable<never>(reason),
      errors: unavailable<never>(reason),
      tokens: unavailable<never>(reason),
      wallTimeSpan: unavailable<never>(reason),
      checksFlipped,
    });
  }

  // Files touched — from decoded file-change records carrying these run ids.
  const effects = port.fileEffectFacts({ runIds });
  const distinct = new Set<string>();
  for (const fact of effects.facts) distinct.add(fact.path);
  const orderedPaths = [...distinct];
  const filesTouched = measured(
    Object.freeze({
      distinctPaths: orderedPaths.length,
      records: effects.facts.length,
      paths: Object.freeze(orderedPaths.slice(0, PULSE_PATH_LIST_CAP)),
      pathListTruncated: orderedPaths.length > PULSE_PATH_LIST_CAP,
    }),
    `${orderedPaths.length} distinct paths from ${effects.facts.length} file-change records carrying one of this conversation's ${runIds.length} run ids; ` +
      "file-change records without run attribution (a known recording gap) cannot be attributed to any conversation and are not counted here",
  );

  // Tools used — recorded descriptions of tool events, merged across runs.
  const byRecordedDescription: Record<string, number> = {};
  let toolEvents = 0;
  let errorEvents = 0;
  let failedOutcomes = 0;
  let events = 0;
  let firstEventAt = summaries[0]?.firstWallTime ?? "";
  let lastEventAt = summaries[0]?.lastWallTime ?? "";
  let usageRecords = 0;
  let unparsedUsageRecords = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const summary of summaries) {
    events += summary.events;
    errorEvents += summary.errorEvents;
    failedOutcomes += summary.failedOutcomes;
    if (summary.firstWallTime < firstEventAt) firstEventAt = summary.firstWallTime;
    if (summary.lastWallTime > lastEventAt) lastEventAt = summary.lastWallTime;
    for (const [description, count] of Object.entries(summary.toolDescriptionCounts)) {
      byRecordedDescription[description] = (byRecordedDescription[description] ?? 0) + count;
      toolEvents += count;
    }
    usageRecords += summary.tokenUsage.samples;
    unparsedUsageRecords += summary.tokenUsage.unparsedDocuments;
    promptTokens += summary.tokenUsage.promptTokensSum;
    completionTokens += summary.tokenUsage.completionTokensSum;
    totalTokens += summary.tokenUsage.totalTokensSum;
  }

  const toolsUsed = measured(
    Object.freeze({ events: toolEvents, byRecordedDescription: Object.freeze(byRecordedDescription) }),
    `${toolEvents} tool events across ${summaries.length} runs with events, grouped by the description the recorder wrote (the ledger has no separate tool-name column)`,
  );
  const errors = measured(
    Object.freeze({ eventsWithErrorDetail: errorEvents, failedOutcomes }),
    `${errorEvents} events carrying recorded error detail and ${failedOutcomes} events with recorded outcome 'failed', counted over this conversation's runs`,
  );
  const tokens: SynthesisFact<PulseTokenTotals> =
    usageRecords === 0
      ? unavailable(
          `no token-usage records are attributed to this conversation's runs${unparsedUsageRecords > 0 ? ` (${unparsedUsageRecords} usage documents were present but did not decode)` : ""} — an absence, not a zero`,
        )
      : measured(
          Object.freeze({
            usageRecords,
            unparsedUsageRecords,
            promptTokens,
            completionTokens,
            totalTokens,
          }),
          `summed from ${usageRecords} decodable token-usage records in this conversation's runs${unparsedUsageRecords > 0 ? `; ${unparsedUsageRecords} further usage documents did not decode and are excluded (counted, not guessed)` : ""}`,
        );
  const wallTimeSpan = measured(
    Object.freeze({ firstEventAt, lastEventAt, events }),
    `earliest and latest recorded wall_time across ${events} ledger events in this conversation's runs`,
  );

  return Object.freeze({
    runs: runsLine,
    filesTouched,
    toolsUsed,
    errors,
    tokens,
    wallTimeSpan,
    checksFlipped,
  });
}

// ── synthesis.echoes ───────────────────────────────────────────────────────

export type EchoRunMatch = Readonly<{
  runId: string;
  pathsTouched: readonly string[];
  fileChangeRecords: number;
  firstTouchedAt: string;
  lastTouchedAt: string;
  /** From this run's own ledger rows (recorded error detail / failed outcomes). */
  eventsWithErrorDetail: number;
  failedOutcomes: number;
  /** Matching records on the same paths that appear LATER in the ledger than this run's last touch. */
  laterTouchesOfSamePaths: number;
  derivation: string;
}>;

export type EchoesReport = Readonly<{
  queriedPaths: readonly string[];
  examined: Readonly<{
    fileEffectEvents: number;
    matchingRecords: number;
    undecodableEffects: number;
    truncated: boolean;
  }>;
  matches: readonly EchoRunMatch[];
  matchListTruncated: boolean;
  /** Matched runs belonging to OTHER users — a count, never ids or facts. */
  withheldRuns: number;
  /** Matching records with no run attribution — counts only, per queried path. */
  unattributed: Readonly<{ records: number; byPath: Readonly<Record<string, number>> }>;
  summary: string;
  derivation: string;
}>;

/**
 * Which past runs touched these exact paths, with each owned match's recorded
 * outcome facts. `ownsRun` is the caller's ownership predicate — the SAME
 * deny-by-default rule `lens.ancestry` applies per hop is applied here per
 * matched run, and what fails it is counted rather than shown.
 */
export function computeEchoes(
  port: SynthesisPort,
  ownsRun: (runId: string) => boolean,
  paths: readonly string[],
  excludeRunId?: string,
): EchoesReport {
  const result = port.fileEffectFacts({ paths });
  const queriedPaths = Object.freeze([...paths]);

  type Group = {
    pathSet: Set<string>;
    records: number;
    firstAt: string;
    lastAt: string;
    lastSeq: bigint;
  };
  const byRun = new Map<string, Group>();
  const unattributedByPath: Record<string, number> = {};
  let unattributedRecords = 0;
  for (const fact of result.facts) {
    if (fact.runId === null) {
      unattributedRecords += 1;
      unattributedByPath[fact.path] = (unattributedByPath[fact.path] ?? 0) + 1;
      continue;
    }
    if (fact.runId === excludeRunId) continue;
    const seq = BigInt(fact.sequence);
    const group = byRun.get(fact.runId);
    if (group === undefined) {
      byRun.set(fact.runId, {
        pathSet: new Set([fact.path]),
        records: 1,
        firstAt: fact.wallTime,
        lastAt: fact.wallTime,
        lastSeq: seq,
      });
    } else {
      group.pathSet.add(fact.path);
      group.records += 1;
      if (fact.wallTime < group.firstAt) group.firstAt = fact.wallTime;
      if (fact.wallTime > group.lastAt) group.lastAt = fact.wallTime;
      if (seq > group.lastSeq) group.lastSeq = seq;
    }
  }

  // Ownership split — the gate, applied per matched run.
  let withheldRuns = 0;
  const ownedRunIds: string[] = [];
  for (const runId of byRun.keys()) {
    if (ownsRun(runId)) ownedRunIds.push(runId);
    else withheldRuns += 1;
  }
  const outcomeByRun = new Map(
    port.runActivitySummaries(ownedRunIds).map((summary) => [summary.runId, summary]),
  );

  const allSeqs = result.facts.map((fact) => BigInt(fact.sequence));
  const matchesAll = ownedRunIds.map((runId): EchoRunMatch => {
    const group = byRun.get(runId) as Group;
    const outcome = outcomeByRun.get(runId);
    const later = allSeqs.filter((seq) => seq > group.lastSeq).length;
    const pathsTouched = Object.freeze([...group.pathSet]);
    return Object.freeze({
      runId,
      pathsTouched,
      fileChangeRecords: group.records,
      firstTouchedAt: group.firstAt,
      lastTouchedAt: group.lastAt,
      eventsWithErrorDetail: outcome?.errorEvents ?? 0,
      failedOutcomes: outcome?.failedOutcomes ?? 0,
      laterTouchesOfSamePaths: later,
      derivation:
        `${group.records} file-change records in this run match ${pathsTouched.length} of the queried paths (exact string equality on the recorded path); ` +
        `error facts are counted from this run's own ledger rows (${outcome?.errorEvents ?? 0} with recorded error detail, ${outcome?.failedOutcomes ?? 0} with outcome 'failed'); ` +
        `${later} matching records on these paths appear later in the ledger than this run's last touch`,
    });
  });
  // Most recent precedent first — ordered by the run's last touch in the ledger.
  matchesAll.sort((a, b) => {
    const sa = (byRun.get(a.runId) as Group).lastSeq;
    const sb = (byRun.get(b.runId) as Group).lastSeq;
    return sa < sb ? 1 : sa > sb ? -1 : 0;
  });
  const matches = Object.freeze(matchesAll.slice(0, ECHOES_MAX_MATCHES));

  const summary =
    `${matchesAll.length} earlier run${matchesAll.length === 1 ? "" : "s"} you own changed these files` +
    (withheldRuns > 0 ? `; ${withheldRuns} more matching run${withheldRuns === 1 ? "" : "s"} belong to other users (counted only)` : "") +
    (unattributedRecords > 0
      ? `; ${unattributedRecords} matching file-change records carry no run attribution (a known recording gap) and cannot be assigned to any run`
      : "");
  const derivation =
    `exact string-equality join of ${result.facts.length} matching file-change records (of ${result.fileEffectEventsExamined} file-change events examined` +
    `${result.undecodableEffects > 0 ? `, ${result.undecodableEffects} undecodable` : ""}) on ${paths.length} queried path${paths.length === 1 ? "" : "s"}, grouped by recorded run id` +
    (excludeRunId !== undefined ? ", excluding the current run" : "") +
    (result.truncated ? "; the record set hit the read ceiling, so counts are lower bounds" : "");

  return Object.freeze({
    queriedPaths,
    examined: Object.freeze({
      fileEffectEvents: result.fileEffectEventsExamined,
      matchingRecords: result.facts.length,
      undecodableEffects: result.undecodableEffects,
      truncated: result.truncated,
    }),
    matches,
    matchListTruncated: matchesAll.length > ECHOES_MAX_MATCHES,
    withheldRuns,
    unattributed: Object.freeze({
      records: unattributedRecords,
      byPath: Object.freeze(unattributedByPath),
    }),
    summary,
    derivation,
  });
}

/** The runId entry point: this run's own touched paths become the query. */
export function echoesForRun(port: SynthesisPort, ownsRun: (runId: string) => boolean, runId: string): EchoesReport {
  const own = port.fileEffectFacts({ runIds: [runId] });
  const distinct = new Set<string>();
  for (const fact of own.facts) distinct.add(fact.path);
  const paths = [...distinct].slice(0, ECHOES_MAX_PATHS);
  if (paths.length === 0) {
    return Object.freeze({
      queriedPaths: Object.freeze([]),
      examined: Object.freeze({
        fileEffectEvents: own.fileEffectEventsExamined,
        matchingRecords: 0,
        undecodableEffects: own.undecodableEffects,
        truncated: false,
      }),
      matches: Object.freeze([]),
      matchListTruncated: false,
      withheldRuns: 0,
      unattributed: Object.freeze({ records: 0, byPath: Object.freeze({}) }),
      summary:
        "no file-change records are attributed to this run, so there are no paths to match — " +
        "file-change records without run attribution are a known recording gap, not proof this run changed nothing",
      derivation: `searched the ledger for file-change records carrying run id ${runId}; none were found`,
    });
  }
  return computeEchoes(port, ownsRun, paths, runId);
}

// ── synthesis.contextForecast ──────────────────────────────────────────────

export type ContextForecast = Readonly<{
  measured: Readonly<{
    messages: SynthesisFact<number>;
    tokensExchanged: SynthesisFact<Readonly<{ usageRecords: number; totalTokens: number }>>;
    tokensPerMessage: SynthesisFact<number>;
    lastRecordedPromptTokens: SynthesisFact<number>;
    promptGrowthPerRecord: SynthesisFact<number>;
  }>;
  projection: SynthesisProjection;
}>;

/**
 * Deterministic extrapolation over one conversation's recorded token pace.
 *
 * THE WINDOW IS AN ASSUMPTION, NEVER A FABRICATION: no context-window size is
 * recorded anywhere in the ledger or the server configuration (verified by
 * search at build time), so the projection runs only when the caller supplies
 * `windowTokens` — and the output names that assumption. The PACE is measured:
 * the growth of recorded prompt sizes across this conversation's token-usage
 * records, which is exactly the rate at which the context is filling.
 */
export function computeContextForecast(
  port: SynthesisPort,
  runIds: readonly string[],
  windowTokens?: number,
): ContextForecast {
  const summaries = runIds.length === 0 ? [] : port.runActivitySummaries(runIds);
  let messages = 0;
  let usageRecords = 0;
  let totalTokens = 0;
  let first: Readonly<{ sequence: string; promptTokens: number }> | undefined;
  let last: Readonly<{ sequence: string; promptTokens: number }> | undefined;
  for (const summary of summaries) {
    messages += summary.eventTypeCounts["message"] ?? 0;
    usageRecords += summary.tokenUsage.samples;
    totalTokens += summary.tokenUsage.totalTokensSum;
    const f = summary.tokenUsage.first;
    const l = summary.tokenUsage.last;
    if (f !== null && (first === undefined || BigInt(f.sequence) < BigInt(first.sequence))) first = f;
    if (l !== null && (last === undefined || BigInt(l.sequence) > BigInt(last.sequence))) last = l;
  }

  const noRuns = runIds.length === 0;
  const messagesFact: SynthesisFact<number> = noRuns
    ? unavailable("this conversation has no recorded runs")
    : measured(messages, `counted message events across this conversation's ${runIds.length} runs`);
  const tokensExchanged: ContextForecast["measured"]["tokensExchanged"] =
    usageRecords === 0
      ? unavailable("no decodable token-usage records in this conversation's runs")
      : measured(
          Object.freeze({ usageRecords, totalTokens }),
          `summed from ${usageRecords} token-usage records in this conversation's runs`,
        );
  const tokensPerMessage: SynthesisFact<number> =
    usageRecords === 0 || messages === 0
      ? unavailable(
          "needs both message events and token-usage records in this conversation's runs; " +
            `found ${messages} message events and ${usageRecords} usage records`,
        )
      : measured(
          Math.round((totalTokens / messages) * 10) / 10,
          `${totalTokens} total tokens ÷ ${messages} message events = ${Math.round((totalTokens / messages) * 10) / 10}`,
        );
  const lastPromptFact: SynthesisFact<number> =
    last === undefined
      ? unavailable("no decodable token-usage records, so no recorded prompt size exists")
      : measured(
          last.promptTokens,
          `promptTokens of the newest token-usage record (ledger sequence ${last.sequence}) — the measured context occupancy at the last recorded call`,
        );
  const growth =
    first !== undefined && last !== undefined && usageRecords >= 2
      ? (last.promptTokens - first.promptTokens) / (usageRecords - 1)
      : undefined;
  const growthFact: SynthesisFact<number> =
    growth === undefined
      ? unavailable(`needs at least 2 token-usage records to measure growth; found ${usageRecords}`)
      : measured(
          Math.round(growth * 10) / 10,
          `(last recorded prompt ${last?.promptTokens} − first recorded prompt ${first?.promptTokens}) ÷ ${usageRecords - 1} intervals = ${Math.round(growth * 10) / 10} tokens per record`,
        );

  let projection: SynthesisProjection;
  if (usageRecords < FORECAST_MIN_SAMPLES) {
    projection = Object.freeze({
      kind: "refused",
      reason: `too few token-usage records to project (${usageRecords} of at least ${FORECAST_MIN_SAMPLES}) — a projection from under ${FORECAST_MIN_SAMPLES} points would be noise dressed as arithmetic`,
    } as const);
  } else if (windowTokens === undefined) {
    projection = Object.freeze({
      kind: "refused",
      reason:
        "no context-window size is recorded in the ledger or the server configuration, and inventing one would be fabrication — " +
        "supply windowTokens to project against an explicitly-stated assumption",
    } as const);
  } else if (growth === undefined || growth <= 0) {
    projection = Object.freeze({
      kind: "refused",
      reason: `recorded prompt sizes do not grow across this conversation (first ${first?.promptTokens}, last ${last?.promptTokens}) — there is no measured pace to project`,
    } as const);
  } else {
    const lastPrompt = (last as { promptTokens: number }).promptTokens;
    const remaining = Math.max(0, Math.floor((windowTokens - lastPrompt) / growth));
    projection = Object.freeze({
      kind: "projection",
      value: remaining,
      unit: "recorded model calls",
      assumption: `windowTokens=${windowTokens} was supplied by the caller; no window size exists in the recorded data`,
      derivation:
        `(assumed window ${windowTokens} − last recorded prompt ${lastPrompt}) ÷ measured growth ${Math.round(growth * 10) / 10} tokens per record ` +
        `= ~${remaining} more recorded model calls at this conversation's average pace`,
    } as const);
  }

  return Object.freeze({
    measured: Object.freeze({
      messages: messagesFact,
      tokensExchanged,
      tokensPerMessage,
      lastRecordedPromptTokens: lastPromptFact,
      promptGrowthPerRecord: growthFact,
    }),
    projection,
  });
}

// ── Wiring: ownership choke points ─────────────────────────────────────────

/**
 * Resolve a chat to its run ids, denying by default.
 *
 * The SAME two choke points `POST /api/timeline/query` uses: `getChat(id,
 * userId)` returns null for a chat that does not exist OR is not the
 * caller's (existence hidden → 404), and `runIdsForChat` is itself
 * userId-scoped, so even a forgotten gate here would resolve to nothing.
 */
export async function chatRunScope(
  ctx: RouteContext,
  db: AsyncDbClient,
  chatId: string,
): Promise<readonly string[]> {
  const user = await requireUserContext(ctx, db);
  if (await db.getChat(chatId, user.userId) === null) {
    throw new NotFoundError(`Chat ${chatId} not found`);
  }
  return await db.runIdsForChat(chatId, user.userId);
}

/**
 * The per-run ownership predicate — the single gate echoes applies per match.
 *
 * Resolved into a SET before the predicate is handed out, because the
 * predicate is called per match inside synchronous folding code and cannot
 * await. An async predicate would not fail here; it would return a promise,
 * which is truthy, and every run in the ledger would pass the gate. That is a
 * silent authorisation loss dressed as a working check, so the resolution
 * happens once, up front. `allRunIdsForUser` is the same predicate as
 * `runBelongsToUser`, enumerated rather than asked one id at a time.
 */
export async function runOwnershipFor(
  ctx: RouteContext,
  db: AsyncDbClient,
): Promise<(runId: string) => boolean> {
  const user = await requireUserContext(ctx, db);
  const ownedRuns = new Set(await db.allRunIdsForUser(user.userId));
  return (runId: string) => ownedRuns.has(runId);
}

// ── Input schemas (deny-by-default) ────────────────────────────────────────

const ChatScope = z.strictObject({ chatId: z.string().min(1) });

const ForecastScope = z.strictObject({
  chatId: z.string().min(1),
  windowTokens: z.coerce.number().int().positive().max(MAX_FORECAST_WINDOW_TOKENS).optional(),
});

/**
 * `paths` travels as a JSON array string (block reads are GET query
 * parameters, and a path may legally contain any separator a flat encoding
 * would need). A malformed value is a 400 naming the expectation, never a
 * silent one-path guess.
 */
const PathsJson = z
  .string()
  .min(1)
  .transform((raw, refinementCtx): string[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      refinementCtx.addIssue({ code: "custom", message: "paths must be a JSON array of path strings" });
      return z.NEVER;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > ECHOES_MAX_PATHS ||
      !parsed.every((p): p is string => typeof p === "string" && p.length > 0)
    ) {
      refinementCtx.addIssue({
        code: "custom",
        message: `paths must be a JSON array of 1..${ECHOES_MAX_PATHS} non-empty path strings`,
      });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * Exactly one way in — the same exclusive-entry rule `lens.ancestry` applies,
 * for the same reason: accepting both would need a precedence policy the
 * caller cannot see, and accepting neither would be a query for "all echoes".
 */
const EchoesScope = z
  .strictObject({
    paths: PathsJson.optional(),
    runId: z.string().min(1).optional(),
  })
  .refine((v) => (v.paths === undefined) !== (v.runId === undefined), {
    message: "provide exactly one of paths or runId",
  });

// ── Registration ───────────────────────────────────────────────────────────

/** Register the synthesis blocks (PULSE + ECHOES + FORECAST). */
export function defineSynthesisBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "synthesis.conversationPulse",
    title: "Conversation pulse",
    description:
      "One computed rollup of this conversation from the ledger: files touched, tools used, errors hit, tokens exchanged and wall-time span, each fact carrying a derivation sentence naming the recorded rows it came from. Anything not derivable is reported absent with the reason — never as a zero.",
    read: {
      input: ChatScope,
      output: z.unknown(),
      ttlMs: 15_000,
      handler: async (input, { ctx }: BlockHandlerContext): Promise<ConversationPulse> =>
        computeConversationPulse(liveSynthesisPort(), await chatRunScope(ctx, db, input.chatId), input.chatId),
    },
  });

  defineBlock({
    id: "synthesis.echoes",
    title: "Echoes — earlier runs that touched these files",
    description:
      "Exact precedent-matching over the recorded history: which past runs changed the same files (string-equality join on the recorded path), with each owned match's recorded error facts and whether the paths were touched again later. Matches in other users' runs and records without run attribution are counted, never shown. Enter with a JSON array of paths, or a runId whose own touched paths become the query.",
    read: {
      input: EchoesScope,
      output: z.unknown(),
      ttlMs: 30_000,
      handler: async (input, { ctx }: BlockHandlerContext): Promise<EchoesReport> => {
        const ownsRun = await runOwnershipFor(ctx, db);
        if (input.runId !== undefined) {
          // Deny-by-default: the entry run must be the caller's own, and a
          // non-owned run is indistinguishable from a non-existent one.
          if (!ownsRun(input.runId)) {
            throw new NotFoundError(`Run ${input.runId} not found`);
          }
          return echoesForRun(liveSynthesisPort(), ownsRun, input.runId);
        }
        return computeEchoes(liveSynthesisPort(), ownsRun, input.paths as string[]);
      },
    },
  });

  defineBlock({
    id: "synthesis.contextForecast",
    title: "Context forecast",
    description:
      "Measured token facts for this conversation (message count, tokens per message, recorded prompt growth) plus a deterministic extrapolation of when the context window fills — always labeled kind:'projection' with its assumption and arithmetic stated, refused honestly when there are under three token records or no window size to project against.",
    read: {
      input: ForecastScope,
      output: z.unknown(),
      ttlMs: 15_000,
      handler: async (input, { ctx }: BlockHandlerContext): Promise<ContextForecast> =>
        computeContextForecast(liveSynthesisPort(), await chatRunScope(ctx, db, input.chatId), input.windowTokens),
    },
  });
}
