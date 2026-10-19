/**
 * DARKFIELD + ANNUNCIATOR — the system's honest self-knowledge, as blocks.
 *
 * Two system-level siblings of LENS ("explain any pixel"):
 *
 *   - `coverage.darkfield` — declared capability vs lifetime occurrence. For
 *     every DECLARED timeline event type, edge type and record kind, the count
 *     of ledger rows that have EVER carried it. The registries are closed and
 *     enumerated from the harness's own exports (`TIMELINE_EVENT_TYPES`,
 *     `TIMELINE_EDGE_TYPES`, `TIMELINE_RECORD_KINDS` — never a hand-list), so
 *     an empty cell is PROVABLY empty: the counting query enumerates every
 *     value present in the table, and absence from its result is absence from
 *     the ledger. That provability is the asset, so it is never faked — a
 *     failed read yields `status: "unknown"` with NO cells, which is
 *     mechanically distinct from a counted zero.
 *
 *   - `coverage.annunciator` — the system's own recording defects, as counts.
 *     Events with no run attribution, events with no trace, tool events
 *     outside any run scope, the evidence-graph row count, and declared effect
 *     kinds whose mapped ledger event type has never occurred. COUNTS ONLY: no
 *     scores, no percentages, no thresholds pretending to be judgments. These
 *     numbers were measured by hand during the recording-defect work (e.g.
 *     trace_id was 0/26,635 before the recorder fix); this block makes them
 *     live so improvement is watchable.
 *
 * WHERE THE QUERIES LIVE — THE LEDGER'S OWNER, NOT HERE
 *
 * This module contains NO SQL and opens NO database handle. The aggregate
 * reads are `occurrenceCounts()` / `recordingGapCounts()` on the canonical
 * timeline store — the single owner of ledger SQL — reached through the
 * timeline bridge, the same door every other ledger consumer uses. (The web
 * repo's raw-SQL guard permits sqlite access only in `server/db/`; the
 * ledger's SQL owner is the harness store, so the aggregates were added
 * THERE, with EXPLAIN-verified plan tests beside them in
 * `integration/test/timeline/timeline-coverage-counts.test.ts`.)
 *
 * OWNERSHIP — WHAT GATE APPLIES, AND WHY IT IS NOT `runBelongsToUser`
 *
 * The peer blocks gate per-row: `lens.*` applies `runBelongsToUser` because
 * they return event CONTENT (descriptions, actors, ids). These blocks return
 * no row and no content — only aggregate counts over closed vocabularies, in
 * which no user-authored byte can appear. Scoping the counts per user would
 * also make them lies: "record kind `intent` has never occurred" is a fact
 * about the SYSTEM, not about one caller's runs. So the gate applied is the
 * same authentication choke point every peer applies first
 * (`requireUserContext`), and the disclosure rule is: aggregate counts and
 * declared vocabulary only, never content. Observed-but-undeclared vocabulary
 * values are reported as COUNTS (distinct values / rows), never as the
 * strings themselves, because an undeclared value is by definition outside
 * the closed vocabulary and could carry anything.
 */

import { z } from "zod";

import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_RECORD_KINDS,
  TIMELINE_EDGE_TYPES,
  EFFECT_KIND_EVENT_TYPES,
  listSignals,
  listActions,
  listCustomizations,
  type TimelineEventType,
  type TimelineOccurrenceCounts,
  type TimelineRecordingGapCounts,
} from "../kernel/canonical.ts";
import { getTimelineStore } from "../observability/timeline-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

/**
 * The reason string every failed read carries. It says explicitly that the
 * absence of a count is NOT a zero, because "0" and "could not determine" are
 * the two answers this instrument exists to keep apart.
 */
export const LEDGER_UNAVAILABLE_REASON =
  "ledger unavailable or query failed — an unknown, not a zero";

/**
 * Where the effect-kind vocabulary lives. The same table the
 * `recording-choke-points` ratchet and BOTH effect sinks consume: the engine
 * timeline vocabulary's `EFFECT_KIND_EVENT_TYPES`, reached through the
 * canonical hub as a compiled value — one owner, no restatement, and no
 * source-text parse that can fail to find it.
 */
export const EFFECT_KIND_SOURCE = "engine/src/timeline/timeline-types.ts#EFFECT_KIND_EVENT_TYPES";

/**
 * The one event type the annunciator names directly: "tool events without run
 * scope" is a specified defect lane. Typed against the harness registry so a
 * vocabulary change surfaces as a compile error here, not a silent zero.
 */
const TOOL_EVENT_TYPE: TimelineEventType = "tool";

/**
 * The ledger capabilities these blocks need — a structural subset of the
 * canonical store port, so tests bind a real temp-file store and production
 * binds the bridge's store, with no adapter between them.
 */
export type CoveragePort = Readonly<{
  occurrenceCounts(): TimelineOccurrenceCounts;
  recordingGapCounts(eventType?: TimelineEventType): TimelineRecordingGapCounts;
}>;

/** The production port: the bridge-owned canonical store, resolved lazily. */
function livePort(): CoveragePort {
  return getTimelineStore();
}

// ── Result shapes — "counted" and "unknown" are structurally distinct ──────

/** A single measured count, or the honest admission that it could not be. */
export type CountFact =
  | Readonly<{ status: "counted"; count: number }>
  | Readonly<{ status: "unknown"; reason: string }>;

/** One declared vocabulary member and its lifetime occurrence count. */
export type DarkfieldCell = Readonly<{ id: string; count: number }>;

/**
 * One registry's darkfield. When `status` is `"counted"` every declared id
 * has a cell and a zero is PROVEN (the counting query enumerated the whole
 * table); when `"unknown"` there are NO cells at all — an unknown must never
 * be renderable as a row of zeros.
 */
export type RegistryDarkfield =
  | Readonly<{
      status: "counted";
      declared: number;
      occurred: number;
      neverOccurred: number;
      cells: readonly DarkfieldCell[];
      /**
       * Vocabulary observed in the ledger but declared nowhere — counts only,
       * never the values (see the ownership note in the header).
       */
      undeclared: Readonly<{ distinctValues: number; events: number }>;
    }>
  | Readonly<{ status: "unknown"; declared: number; reason: string }>;

export type DarkfieldReport = Readonly<{
  scope:
    | Readonly<{ status: "counted"; events: number; ledgers: number }>
    | Readonly<{ status: "unknown"; reason: string }>;
  eventTypes: RegistryDarkfield;
  recordKinds: RegistryDarkfield;
  edgeTypes: RegistryDarkfield;
  exposure: ExposureDarkfield;
}>;

/**
 * The exposure registries are cheaply enumerable, so their SIZES are
 * reported; their ledger occurrence is not, because no ledger column carries
 * an exposure id — any join would be inference by string-matching, and an
 * inferred zero is exactly the fake proof this instrument refuses to emit.
 */
export type ExposureDarkfield = Readonly<{
  status: "enumerated" | "unknown";
  reason?: string;
  declared?: Readonly<{ signals: number; actions: number; customizations: number }>;
  occurrence: Readonly<{ status: "not-joinable"; reason: string }>;
}>;

export type EffectKindDarkfield =
  | Readonly<{
      status: "counted";
      source: string;
      declared: number;
      /** Kinds whose mapped ledger event type has ZERO lifetime events. */
      unproduced: readonly string[];
      kinds: readonly Readonly<{ kind: string; eventType: string; eventsOfMappedType: number }>[];
    }>
  | Readonly<{ status: "unknown"; source: string; reason: string }>;

export type AnnunciatorReport = Readonly<{
  totalEvents: CountFact;
  eventsWithoutRunId: CountFact;
  eventsWithoutTraceId: CountFact;
  toolEvents: CountFact;
  toolEventsWithoutRunId: CountFact;
  edgeRows: CountFact;
  effectKinds: EffectKindDarkfield;
}>;

// ── Pure computation over the port — this is what the tests exercise ───────

/**
 * Join one declared registry against the observed lifetime counts.
 *
 * `declared` comes from a harness export; `observed` comes from one grouped
 * count that enumerated every value present in the table, so an id absent
 * from it is a PROVEN zero. The failure path never reaches this function —
 * `computeDarkfield` withholds the whole registry as `unknown` instead, so a
 * partial answer cannot masquerade as a complete one.
 *
 * Not exported: `computeDarkfield` is the only legitimate caller, because it
 * is the one place the counted/unknown decision is made.
 */
function registryDarkfield(
  declared: readonly string[],
  observed: Readonly<Record<string, number>>,
): RegistryDarkfield {
  const declaredSet = new Set<string>(declared);
  const cells = declared.map((id) => Object.freeze({ id, count: observed[id] ?? 0 }));
  let undeclaredDistinct = 0;
  let undeclaredEvents = 0;
  for (const [value, count] of Object.entries(observed)) {
    if (!declaredSet.has(value)) {
      undeclaredDistinct += 1;
      undeclaredEvents += count;
    }
  }
  const occurred = cells.filter((cell) => cell.count > 0).length;
  return Object.freeze({
    status: "counted",
    declared: declared.length,
    occurred,
    neverOccurred: declared.length - occurred,
    cells: Object.freeze(cells),
    undeclared: Object.freeze({ distinctValues: undeclaredDistinct, events: undeclaredEvents }),
  });
}

function exposureDarkfield(): ExposureDarkfield {
  const occurrence = Object.freeze({
    status: "not-joinable",
    reason:
      "ledger rows carry no exposure id column; matching by string would be inference, not proof",
  } as const);
  let signals = 0;
  let actions = 0;
  let customizations = 0;
  try {
    signals = listSignals().length;
    actions = listActions().length;
    customizations = listCustomizations().length;
  } catch {
    return Object.freeze({ status: "unknown", reason: "exposure registry unavailable", occurrence });
  }
  if (signals + actions + customizations === 0) {
    // An empty registry at read time means registration has not run, not that
    // the system declares nothing — saying "0 declared" would be the same lie
    // as a fake zero cell.
    return Object.freeze({
      status: "unknown",
      reason: "exposure registry is empty at read time — not initialised, not proof of absence",
      occurrence,
    });
  }
  return Object.freeze({
    status: "enumerated",
    declared: Object.freeze({ signals, actions, customizations }),
    occurrence,
  });
}

/** The full darkfield read. `port` is a supplier so a failed open is caught here. */
export function computeDarkfield(port: () => CoveragePort): DarkfieldReport {
  let occ: TimelineOccurrenceCounts | undefined;
  try {
    occ = port().occurrenceCounts();
  } catch {
    occ = undefined;
  }
  const unknown = (declared: readonly string[]): RegistryDarkfield =>
    Object.freeze({
      status: "unknown",
      declared: declared.length,
      reason: LEDGER_UNAVAILABLE_REASON,
    });
  return Object.freeze({
    scope:
      occ === undefined
        ? Object.freeze({ status: "unknown", reason: LEDGER_UNAVAILABLE_REASON } as const)
        : Object.freeze({
            status: "counted",
            events: occ.totalEvents,
            ledgers: occ.ledgers.length,
          } as const),
    eventTypes:
      occ === undefined
        ? unknown(TIMELINE_EVENT_TYPES)
        : registryDarkfield(TIMELINE_EVENT_TYPES, occ.eventTypeCounts),
    recordKinds:
      occ === undefined
        ? unknown(TIMELINE_RECORD_KINDS)
        : registryDarkfield(TIMELINE_RECORD_KINDS, occ.recordKindCounts),
    edgeTypes:
      occ === undefined
        ? unknown(TIMELINE_EDGE_TYPES)
        : registryDarkfield(TIMELINE_EDGE_TYPES, occ.edgeTypeCounts),
    exposure: exposureDarkfield(),
  });
}

/**
 * THE ONE effect-kind table, consumed as the compiled value it is.
 *
 * This block used to PARSE the timeline bridge's source text for a private
 * `EFFECT_EVENT_TYPE` table — a second source-scan beside the choke-point
 * ratchet's, so the two could never disagree about what "declared" meant but
 * also shared the source-parse failure mode. The table has one owner now
 * (the engine's timeline vocabulary), both sinks consume it as a value, and
 * this block does too: a compiled import cannot fail to find the table the
 * way a source parse can, so the declared vocabulary's honest-unknown arm
 * below is reachable only through the darkfield function's own contract
 * (tests exercise it), never because a file moved.
 */
function declaredEffectKindTable(): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  for (const [kind, eventType] of Object.entries(EFFECT_KIND_EVENT_TYPES)) {
    table.set(kind, eventType);
  }
  return table;
}

/**
 * Declared effect kinds vs lifetime production, through the sink's own
 * kind → event-type mapping. A ZERO for the mapped type proves the kind never
 * produced (the sink writes exactly that type); a non-zero is an upper bound,
 * because other recorders may write the same event type — which is why the
 * field is named `eventsOfMappedType` and not `eventsProducedByKind`.
 */
export function effectKindDarkfield(
  table: ReadonlyMap<string, string> | undefined,
  observed: Readonly<Record<string, number>> | undefined,
): EffectKindDarkfield {
  if (table === undefined) {
    return Object.freeze({
      status: "unknown",
      source: EFFECT_KIND_SOURCE,
      reason: "no effect-kind table was provided to the observer",
    });
  }
  if (observed === undefined) {
    return Object.freeze({
      status: "unknown",
      source: EFFECT_KIND_SOURCE,
      reason: LEDGER_UNAVAILABLE_REASON,
    });
  }
  const kinds = [...table.entries()].map(([kind, eventType]) =>
    Object.freeze({ kind, eventType, eventsOfMappedType: observed[eventType] ?? 0 }),
  );
  return Object.freeze({
    status: "counted",
    source: EFFECT_KIND_SOURCE,
    declared: kinds.length,
    unproduced: Object.freeze(kinds.filter((k) => k.eventsOfMappedType === 0).map((k) => k.kind)),
    kinds: Object.freeze(kinds),
  });
}

/** The full annunciator read. Every fact is its own port call and fails alone. */
export function computeAnnunciator(
  port: () => CoveragePort,
  kindTable: ReadonlyMap<string, string> | undefined,
): AnnunciatorReport {
  const fact = (run: () => number): CountFact => {
    try {
      return Object.freeze({ status: "counted", count: run() });
    } catch {
      return Object.freeze({ status: "unknown", reason: LEDGER_UNAVAILABLE_REASON });
    }
  };
  let observedTypes: Readonly<Record<string, number>> | undefined;
  try {
    observedTypes = port().occurrenceCounts().eventTypeCounts;
  } catch {
    observedTypes = undefined;
  }
  return Object.freeze({
    totalEvents: fact(() => port().occurrenceCounts().totalEvents),
    eventsWithoutRunId: fact(() => port().recordingGapCounts().withoutRun),
    eventsWithoutTraceId: fact(() => port().recordingGapCounts().withoutTrace),
    toolEvents: fact(() => port().recordingGapCounts(TOOL_EVENT_TYPE).events),
    toolEventsWithoutRunId: fact(() => port().recordingGapCounts(TOOL_EVENT_TYPE).withoutRun),
    edgeRows: fact(() => port().occurrenceCounts().edgeRows),
    effectKinds: effectKindDarkfield(kindTable, observedTypes),
  });
}

// ── Registration ───────────────────────────────────────────────────────────

/** Register the coverage blocks (DARKFIELD + ANNUNCIATOR). */
export function defineCoverageBlocks(db: AsyncDbClient): void {
  // Deny-by-default: these reads take NO input, and an unexpected query
  // parameter is a 400, not a silently ignored key.
  const NoInput = z.strictObject({});

  defineBlock({
    id: "coverage.darkfield",
    title: "Darkfield — declared vs occurred",
    description:
      "Every declared timeline event type, edge type and record kind with its lifetime occurrence count in the ledger. The registries are enumerated from the harness exports, so an empty cell is provably empty; a failed query reports unknown, never zero.",
    read: {
      input: NoInput,
      output: z.unknown(),
      ttlMs: 15_000,
      handler: async (_input, { ctx }: BlockHandlerContext): Promise<DarkfieldReport> => {
        await requireUserContext(ctx, db);
        return computeDarkfield(livePort);
      },
    },
  });

  defineBlock({
    id: "coverage.annunciator",
    title: "Annunciator — recording defects",
    description:
      "The system's own recording defects as live counts: events without run attribution, events without a trace, tool events outside run scope, evidence-graph rows, and declared effect kinds whose mapped event type has never occurred. Counts only — no scores, no thresholds.",
    read: {
      input: NoInput,
      output: z.unknown(),
      ttlMs: 15_000,
      handler: async (_input, { ctx }: BlockHandlerContext): Promise<AnnunciatorReport> => {
        await requireUserContext(ctx, db);
        return computeAnnunciator(livePort, declaredEffectKindTable());
      },
    },
  });
}
