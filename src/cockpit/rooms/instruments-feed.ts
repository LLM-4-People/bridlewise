/**
 * INSTRUMENTS — the live signal feed (DESIGN-COCKPIT-V2 §8.2).
 *
 * ONE channel, TWO consumers: the EXISTING signal channel is
 * `GET /api/schema/ui/values` (client.getUiSchemaValues → the
 * `uiSchemaValues` state store — the sole-writer law keeps the store write
 * inside client.ts). This feed:
 *
 *   1. DRIVES the channel while anyone is looking (the room open, or ≥1
 *      monitor pinned): one immediate sample + a fixed cadence, ref-counted
 *      so a closed room with nothing pinned polls nothing;
 *   2. INGESTS every snapshot that lands in the store — from this feed's
 *      own ticks or anyone else's refresh (a customization save re-reads
 *      values; the cells and monitors follow it live) — into the per-signal
 *      measured ring buffers (§8.3: the ONLY thing a spark may render from)
 *      and the current-sample map (value + the epoch-ms it was received —
 *      every number's asOf, §1.1).
 *
 * HONESTY: a signal missing from a snapshot is NOT patched, zeroed or
 * interpolated — its last measured sample stands with its old asOf, and a
 * signal never measured simply has none ("collecting since…" is the cell's
 * state, computed from `collectingSince`). A failed poll becomes
 * `lastFeedError` in plain words; the measured past is never un-measured
 * by a failing present.
 *
 * PINNED MONITORS (§8.2): ≤4 signal ids, persisted per the cockpit storage
 * convention (`cockpit.instruments.monitors.v1`, guarded, validated), and
 * projected onto the shell's HORIZON via `bindMonitorsToShell` — the
 * monitors are REFERENCES (§1.4): value formatted from the same current
 * sample, asOf the measurement instant, click opens the Instruments room
 * (the single source). While monitors exist the feed holds its own
 * acquisition so they live-update with the room closed.
 */

import { atom } from "nanostores";

import { getUiSchemaValues } from "../../client.ts";
import { persistGet, persistSet } from "../../state/persistence.ts";
import { onForeignWrite } from "../../state/cross-tab.ts";
import { uiSchema, uiSchemaValues } from "../../state/schema-store.ts";
import { registerReset } from "../../state/store-registry.ts";
import type { UiSchemaValues } from "../../../shared/ui-schema.ts";
import type { Monitor, ShellApi } from "../shell/contract.ts";
import { absenceReason } from "../../data/absence.ts";
import {
  MONITORS_STORAGE_KEY,
  SIGNALS_POLL_MS,
  SIGNAL_RING_CAPACITY,
} from "./instruments-config.ts";
import {
  MAX_PINNED,
  formatMeasuredValue,
  isPinnedMonitor,
  pushPoint,
  pinOutcome,
  type PinOutcome,
  type PinnedMonitor,
  type SignalPoint,
} from "./instruments-data.ts";

/** One received sample: the value and the epoch-ms it was received. */
export type SignalSample = Readonly<{ v: number | string | boolean; t: number }>;

// ── Stores (read by the room + monitors; written only by this module) ─────

/** signalId → measured numeric ring buffer (§8.3). Non-numeric signals
 * have no buffer — a yes/no or a string has no honest line to draw. */
export const signalHistory = atom<Readonly<Record<string, readonly SignalPoint[]>>>({});

/** signalId → last received sample (any served type). */
export const signalCurrent = atom<Readonly<Record<string, SignalSample>>>({});

/** Epoch-ms the feed FIRST started collecting this session (null = never):
 * the honest "collecting since 14:02" anchor. */
export const collectingSince = atom<number | null>(null);

/** Plain-words reason the LAST poll failed (null = the last poll landed).
 * Measured values are never cleared by a failure — only this is set. */
export const lastFeedError = atom<string | null>(null);

/** The pinned HORIZON monitor set (≤4), persisted per the storage
 * convention. Order is pin order — the HORIZON renders it verbatim. */
export const pinnedMonitors = atom<readonly PinnedMonitor[]>([]);

// ── Ingestion (every snapshot that lands in the state store) ──────────────

let ingestBound = false;

function ingestSnapshot(values: UiSchemaValues, t: number): void {
  const current = { ...signalCurrent.get() };
  const history = { ...signalHistory.get() };
  for (const entry of values.signals) {
    const prev = current[entry.id];
    // The sample is a real measurement either way; identity is kept when
    // nothing changed so consumers (digit roll) can compare `v` directly.
    if (prev === undefined || prev.v !== entry.value || prev.t !== t) {
      current[entry.id] = { v: entry.value, t };
    }
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) {
      history[entry.id] = pushPoint(
        history[entry.id] ?? [],
        { t, v: entry.value },
        SIGNAL_RING_CAPACITY,
      );
    }
  }
  signalCurrent.set(current);
  signalHistory.set(history);
}

/** Bind the store subscription exactly once (idempotent). Exported for the
 * room/tests; production binding happens on first acquire. */
export function bindInstrumentsIngest(): void {
  if (ingestBound) return;
  ingestBound = true;
  uiSchemaValues.subscribe((values) => {
    if (values === null) return;
    ingestSnapshot(values, Date.now());
  });
}

// ── The poll driver (ref-counted; injectable reader) ──────────────────────

export type InstrumentsReader = Readonly<{ values: () => Promise<unknown> }>;

const LIVE_READER: InstrumentsReader = {
  // getUiSchemaValues WRITES the uiSchemaValues store itself (client.ts is
  // the sole store writer); ingestion rides the subscription above, so the
  // return value is deliberately unused — one ingest per snapshot, never two.
  values: () => getUiSchemaValues(),
};

let reader: InstrumentsReader = LIVE_READER;

/** Test seam. Returns the previous reader so a test can restore it. */
export function setInstrumentsReader(next: InstrumentsReader): InstrumentsReader {
  const prev = reader;
  reader = next;
  return prev;
}

let refs = 0;
let timer: ReturnType<typeof setInterval> | null = null;

async function sampleOnce(): Promise<void> {
  try {
    await reader.values();
    lastFeedError.set(null);
  } catch (err) {
    lastFeedError.set(absenceReason(err));
  }
}

/**
 * Hold the feed open (room mounted, or monitors pinned). Returns the
 * release. First acquisition samples immediately (absence-first: the room
 * renders before the sample lands) and starts the cadence; the last
 * release stops it — nothing polls for nobody.
 */
export function acquireInstrumentsFeed(): () => void {
  bindInstrumentsIngest();
  refs += 1;
  if (refs === 1) {
    if (collectingSince.get() === null) collectingSince.set(Date.now());
    void sampleOnce();
    timer = setInterval(() => void sampleOnce(), SIGNALS_POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs -= 1;
    if (refs === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Whether the feed is currently collecting (drives the honest counts). */
export function feedRunning(): boolean {
  return refs > 0;
}

// ── Pinned monitors — the persistence owner + the ≤4 law ─────────────────

/**
 * Read the persisted pins, validated and capped. Storage goes through the
 * app's ONE persistence owner (`src/state/persistence.ts` — the same door
 * the cockpit's local preferences use), so the guarded-access, prefix and
 * degrade-to-no-op behavior is not re-implemented here. A corrupt, foreign
 * or over-long blob degrades to NO pins rather than to a crash or to an
 * invented monitor set.
 */
export function loadPinnedFromStorage(): readonly PinnedMonitor[] {
  const raw = persistGet(MONITORS_STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPinnedMonitor).slice(0, MAX_PINNED);
  } catch {
    return [];
  }
}

/**
 * Set when persistence did not take (quota, private mode, storage denied):
 * pins degrade to session-only and the room SAYS so. A degradation that
 * stayed silent would be the HORIZON lying about durability. Detected by
 * reading the value back through the same owner — the write path reports
 * nothing, so the read-back is the only honest evidence.
 */
let storageDegradedReason: string | null = null;

export function monitorStorageDegraded(): string | null {
  return storageDegradedReason;
}

/**
 * DELIBERATELY DIRECT — the pin set is written to this browser's storage and
 * does NOT pass `broker.action`, nor does it assert the live-view rule
 * (§6.2 write-door audit).
 *
 * The read-only rule bounds acts on the RECORDED WORLD. Which four signals a
 * person keeps on their own HORIZON is device-side arrangement: never sent,
 * never recorded, and carrying no `asOf` a planted head could falsify. There
 * is no block action to route it through because nothing travels.
 *
 * The CELL is stricter than this door anyway — `InstrumentCell.svelte`
 * disables [pin] during a past view, because a cell that cannot show a
 * reading has no measured fact to pin — so no control claims a refusal this
 * function would contradict.
 */
function savePinned(list: readonly PinnedMonitor[]): void {
  const json = JSON.stringify(list);
  persistSet(MONITORS_STORAGE_KEY, json);
  storageDegradedReason =
    persistGet(MONITORS_STORAGE_KEY) === json ? null : "this browser refused to store them";
}

pinnedMonitors.set(loadPinnedFromStorage());

/**
 * Cross-tab: THE HORIZON IS THE SAME HORIZON IN EVERY TAB.
 *
 * A pin is an arrangement of the operator's own instrument panel, not of one
 * workspace, so it converges. It is also the case where divergence was most
 * misleading: two tabs each showing four monitors, disagreeing about WHICH
 * four, with both looking equally authoritative and the ≤4 law making the
 * disagreement invisible (neither is obviously missing anything).
 *
 * WHY THIS PATCHES RATHER THAN REMOUNTS. The shell renders monitors from
 * `projectMonitors`, and the pin set feeds it through the same subscription
 * the local pin path uses (`bindMonitorsToShell`). Adopting a foreign write is
 * therefore byte-for-byte the same code path as pinning here — a `setMonitors`
 * call with a new list. The HORIZON's monitor slots are fixed-geometry
 * (uniform 96×28), so a set that changes membership changes text inside slots
 * that were already there. No slot is created or destroyed by an adoption that
 * keeps the count, and the count itself is capped identically on both sides.
 *
 * The list is re-validated on the way in through `isPinnedMonitor` and re-
 * capped at MAX_PINNED: another tab on older code cannot install a fifth
 * monitor or a malformed one.
 *
 * The feed hold is re-synced, so a tab that had no pins and receives some
 * starts acquiring — and a tab whose last pin was removed elsewhere stops.
 * Nothing polls for nobody, in either direction.
 */
onForeignWrite(MONITORS_STORAGE_KEY, () => {
  const next = loadPinnedFromStorage();
  pinnedMonitors.set(next);
  syncMonitorHold(next);
});

/** A monitor-held feed acquisition: while ≥1 monitor is pinned the feed
 * stays live so the HORIZON updates with the room closed. */
let monitorHold: (() => void) | null = null;
function syncMonitorHold(list: readonly PinnedMonitor[]): void {
  if (list.length > 0 && monitorHold === null) monitorHold = acquireInstrumentsFeed();
  else if (list.length === 0 && monitorHold !== null) {
    monitorHold();
    monitorHold = null;
  }
}

/**
 * Pin a signal. "pinned"/"already" mutate (or keep) the set; "full" mutates
 * NOTHING — the caller renders the inline displace ask (§8.2: pinning a
 * 5th asks which to displace; never silent eviction).
 */
export function pinMonitor(signalId: string): PinOutcome {
  const list = pinnedMonitors.get();
  const outcome = pinOutcome(list, signalId);
  if (outcome === "pinned") {
    const next = [...list, { signalId, pinnedAt: Date.now() }];
    pinnedMonitors.set(next);
    savePinned(next);
    syncMonitorHold(next);
  }
  return outcome;
}

export function unpinMonitor(signalId: string): void {
  const next = pinnedMonitors.get().filter((m) => m.signalId !== signalId);
  pinnedMonitors.set(next);
  savePinned(next);
  syncMonitorHold(next);
}

/** Resolve a "full" pin: replace `displaceId` with `signalId`, in place. */
export function displaceMonitor(displaceId: string, signalId: string): void {
  const next = pinnedMonitors
    .get()
    .map((m) => (m.signalId === displaceId ? { signalId, pinnedAt: Date.now() } : m));
  pinnedMonitors.set(next);
  savePinned(next);
  syncMonitorHold(next);
}

// ── HORIZON projection (§1.4 — monitors are references) ───────────────────

let shellBound: ShellApi | null = null;
let unbindShell: (() => void)[] = [];

/** The Monitor list the shell renders — exported pure so tests can pin the
 * projection without a shell. Every entry's asOf is a real instant: the
 * measurement time when measured, the collection start otherwise (the
 * honest fact then IS "collecting since t"). */
export function projectMonitors(
  pinned: readonly PinnedMonitor[],
  current: Readonly<Record<string, SignalSample>>,
  openSource: () => void,
): readonly Monitor[] {
  const schema = uiSchema.get();
  return pinned.slice(0, MAX_PINNED).map((m) => {
    const meta = schema?.signals.find((s) => s.id === m.signalId);
    const sample = current[m.signalId];
    return {
      id: m.signalId,
      label: meta?.name ?? m.signalId,
      value:
        sample !== undefined
          ? formatMeasuredValue(sample.v, meta?.type ?? "gauge", meta?.unit)
          : "collecting",
      asOf: sample?.t ?? collectingSince.get() ?? m.pinnedAt,
      openSource,
    };
  });
}

/**
 * Bind the pinned set to the shell's HORIZON (idempotent per shell). The
 * subscription lives at module scope so monitors keep updating after the
 * room unmounts; clicking a monitor opens the Instruments room — the
 * reference opens its single source (§1.4).
 */
export function bindMonitorsToShell(shell: ShellApi): void {
  if (shellBound === shell) return;
  for (const un of unbindShell) un();
  unbindShell = [];
  shellBound = shell;
  // Pins restored from storage predate any acquire — the moment a shell
  // exists to render them, they hold the feed open like a fresh pin would.
  syncMonitorHold(pinnedMonitors.get());
  const push = (): void => {
    shell.setMonitors(
      projectMonitors(pinnedMonitors.get(), signalCurrent.get(), () =>
        shell.openRoom("instruments"),
      ),
    );
  };
  unbindShell.push(pinnedMonitors.subscribe(push));
  unbindShell.push(signalCurrent.subscribe(push));
}

// ── Reset (tests / sign-out) ──────────────────────────────────────────────

export function resetInstrumentsFeed(): void {
  signalHistory.set({});
  signalCurrent.set({});
  collectingSince.set(null);
  lastFeedError.set(null);
  pinnedMonitors.set([]);
  if (monitorHold !== null) {
    monitorHold();
    monitorHold = null;
  }
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  refs = 0;
  reader = LIVE_READER;
  for (const un of unbindShell) un();
  unbindShell = [];
  shellBound = null;
}

registerReset("instruments-feed", resetInstrumentsFeed);
