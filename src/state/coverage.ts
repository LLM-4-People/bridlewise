/**
 * nanostores shared state: the latest coverage instrument reads
 * (DARKFIELD + ANNUNCIATOR).
 *
 * Was fed by the old coverage panel's Broker reads (deleted at the
 * cutover) — the atoms and reset stay registered, and the ingest half is
 * recoverable from git when a cockpit coverage surface plugs back in.
 *
 * @global-store The coverage instruments report SERVER-WIDE lifetime
 * aggregates over the ledger (declared vocabulary vs lifetime occurrence,
 * recording defects). They are facts about the SYSTEM, not about one chat or
 * project — a chat switch does not change them, so resetting on context
 * switch would only force a refetch of identical numbers. Reset on logout
 * only (registerReset below).
 *
 * THE SHAPES ARE STRUCTURAL MIRRORS of the block outputs
 * (`server/blocks/coverage.ts`), narrowed defensively at ingest: the client
 * never imports server modules, and the block declares `output: z.unknown()`,
 * so the honest contract here is "keep what parses, keep the unknown/counted
 * distinction, drop nothing silently into a fake zero".
 *
 * Plain .ts — Node-testable via Vitest.
 */

import { atom } from "nanostores";

import { registerReset } from "./store-registry";

/** A measured count, or the honest admission that it could not be measured. */
export type CoverageCountFact =
  | Readonly<{ status: "counted"; count: number }>
  | Readonly<{ status: "unknown"; reason: string }>;

/** One declared registry's declared-vs-occurred summary. */
export type CoverageRegistryView =
  | Readonly<{ status: "counted"; declared: number; occurred: number; neverOccurred: number }>
  | Readonly<{ status: "unknown"; declared: number; reason: string }>;

export type CoverageDarkfieldView = Readonly<{
  scope:
    | Readonly<{ status: "counted"; events: number; ledgers: number }>
    | Readonly<{ status: "unknown"; reason: string }>;
  eventTypes: CoverageRegistryView;
  recordKinds: CoverageRegistryView;
  edgeTypes: CoverageRegistryView;
}>;

export type CoverageAnnunciatorView = Readonly<{
  totalEvents: CoverageCountFact;
  eventsWithoutRunId: CoverageCountFact;
  eventsWithoutTraceId: CoverageCountFact;
  toolEventsWithoutRunId: CoverageCountFact;
  edgeRows: CoverageCountFact;
  /** Declared effect kinds whose mapped event type has never occurred. */
  unproducedEffectKinds: readonly string[] | null;
}>;

// ── Stores ──

export const coverageDarkfield = atom<CoverageDarkfieldView | null>(null);
export const coverageAnnunciator = atom<CoverageAnnunciatorView | null>(null);
/** Non-null when the last read FAILED (network/server) — shown, never hidden. */
export const coverageError = atom<string | null>(null);

// ── Ingest narrowing (unknown-tolerant, never fabricates a zero) ──

/** Plain-object guard. Exported as the SINGLE owner of this helper (No
 * Scattered Helpers) — the cockpit's custody decoding imports it. */
export function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null;
}

// (The ingest narrowers and writers left with their one caller — the old
// coverage panel. The atoms and their reset stay registered; the ingest
// contract is recoverable from git when a cockpit coverage surface plugs
// back in.)

export function resetCoverage(): void {
  coverageDarkfield.set(null);
  coverageAnnunciator.set(null);
  coverageError.set(null);
}

registerReset("coverage", resetCoverage);
