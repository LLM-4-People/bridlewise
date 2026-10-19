/**
 * Settings feed — the settings surfaces' ONE data door and ONE write door
 * (DESIGN-COCKPIT-V2 §9).
 *
 * READ: the served schema + values live in the schema store
 * (src/state/schema-store.ts — populated by the client's getUiSchema /
 * getUiSchemaValues); this module only ensures they are loaded and re-reads
 * the VALUES after every settings change, so what a row shows is always the
 * value the server read back, never a client-side assumption (§9.3 honest
 * read-back).
 *
 * WRITE: `saveSetting` is the SINGLE write path for served settings, and it
 * goes through `broker.action("settings.customizations","set", …)` — the
 * validated choke point (server-side declared-contract checks; an
 * out-of-contract value comes back as the server's own 400 sentence). The
 * mutation guard (tests/cockpit/settings-write-path.test.ts) fails any
 * settings source that fetches or writes around it.
 *
 * Readers are injectable for tests, exactly like custody-feed.
 */

import { atom } from "nanostores";

import { action, onInvalidation, read } from "../../data/broker.ts";
import { ClientError } from "../../data/errors.ts";
import { refusalReason } from "../../data/absence.ts";
import { getUiSchema, getUiSchemaValues } from "../../client.ts";
import { beginSchemaValuesRead, isCurrentSchemaValuesRead, uiSchema, uiSchemaValues, uiSchemaValuesRead, type SchemaValuesRead } from "../../state/schema-store.ts";
import { registerReset } from "../../state/store-registry.ts";
import {
  DIAGNOSTIC_MODES_BLOCK,
  DIAGNOSTIC_MODES_SET_ACTION,
  SETTINGS_BLOCK,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_SET_ACTION,
  type DiagnosticModesState,
  type SettingValue,
  sameSettingValue,
  servedCustomizationEntry,
} from "./settings-data.ts";

export type SettingsLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "failed"; reason: string }>;

/** Load state for the schema+values pair the settings surfaces need. */
export const settingsLoadState = atom<SettingsLoad>({ kind: "pending" });

/** Ownership outlives every editor. Values remain exclusively in uiSchemaValues. */
type SettingsWrite = Readonly<{ kind: "pending"; claim: symbol }> | Readonly<{ kind: "uncertain"; after?: SchemaValuesRead }>;
export const settingsWrites = atom<ReadonlyMap<string, SettingsWrite>>(new Map());

/** Only a published, causally later read can confirm a known accepted write.
 * Missing `after` means acceptance is unknown; no read can settle that fact. */
function settleConfirmedWrites(): void {
  const writes = settingsWrites.get();
  if (writes.size === 0) return;
  const read = uiSchemaValuesRead.get();
  if (read === null || !isCurrentSchemaValuesRead(read)) return;
  let present: Set<string> | undefined;
  let next: Map<string, SettingsWrite> | undefined;
  for (const [id, write] of writes) {
    if (write.kind === "uncertain" && write.after?.scope === read.scope &&
      read.revision > write.after.revision) {
      if (present === undefined) {
        present = new Set();
        for (const entry of uiSchemaValues.get()?.customizations ?? []) present.add(entry.id);
      }
      if (present.has(id)) (next ??= new Map(writes)).delete(id);
    }
  }
  if (next) settingsWrites.set(next);
}

// One shared observation covers settings, instruments and every client read.
uiSchemaValuesRead.listen(settleConfirmedWrites);

type Readers = Readonly<{
  /** Ensure the ui-schema store is filled (client.getUiSchema by default). */
  schema: () => Promise<unknown>;
  /** (Re)read the values snapshot into the store. */
  values: () => Promise<unknown>;
}>;

const defaultReaders: Readers = {
  schema: () => getUiSchema(),
  values: () => getUiSchemaValues(),
};

let readers: Readers = defaultReaders;
const readbackConsumers = new Set<symbol>();
let releaseReadback: (() => void) | null = null;
let lastReadback: Readonly<{ after: SchemaValuesRead; done: Promise<void> }> | null = null;

/** Test seam — replace the wire readers. */
export function setSettingsReaders(next: Partial<Readers>): void {
  readers = { ...defaultReaders, ...next };
}

/** Reset the feed (tests + logout hygiene). */
export function resetSettingsFeed(): void {
  releaseReadback?.();
  releaseReadback = null;
  readbackConsumers.clear();
  lastReadback = null;
  settingsWrites.set(new Map());
  readers = defaultReaders;
  settingsLoadState.set({ kind: "pending" });
}

registerReset("settingsFeed", resetSettingsFeed);

/**
 * Load the schema (only when the store is empty — boot usually filled it)
 * and ALWAYS re-read the values snapshot (a fresh open must show the
 * server's current values, not a stale poll).
 */
export async function requestSettingsData(): Promise<void> {
  const request = beginSchemaValuesRead();
  try {
    if (uiSchema.get() === null) await readers.schema();
    if (!isCurrentSchemaValuesRead(request)) return;
    await readers.values();
    if (!isCurrentSchemaValuesRead(request)) return;
    settingsLoadState.set({ kind: "ready" });
  } catch (err) {
    if (!isCurrentSchemaValuesRead(request)) return;
    const reason =
      err instanceof ClientError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    settingsLoadState.set({ kind: "failed", reason });
  }
}

/** Start a new read after the event, never reuse a pre-write in-flight read.
 * Every save awaits this same promise, including when its editor is closed. */
function refreshSettingsValues(): Promise<void> {
  // The invalidation is fired only after the action's response settles.
  const after = beginSchemaValuesRead();
  // Keep completion only; the canonical store owns the returned values.
  const done = readers.values().then(() => undefined);
  lastReadback = { after, done };
  // Background consumers retain the preceding snapshot on a failed refresh;
  // the writer awaits the original promise and reports unconfirmed storage.
  void done.catch(() => undefined);
  return done;
}

/**
 * Bind the read-back loop: whenever the settings invalidation event fires
 * (any surface saved through the block), re-read the values snapshot so
 * every rendered value is the server's answer. Returns the unbind —
 * lifecycle-bound by the mounting surface, so a closed room costs nothing.
 */
export function bindSettingsReadback(): () => void {
  const consumer = Symbol();
  readbackConsumers.add(consumer);
  releaseReadback ??= onInvalidation(SETTINGS_CHANGED_EVENT, () => {
    void refreshSettingsValues();
  });
  return () => {
    readbackConsumers.delete(consumer);
    if (readbackConsumers.size === 0) { releaseReadback?.(); releaseReadback = null; }
  };
}

/**
 * A save's reconciled answer: what a post-action values read found on the server,
 * and whether the display egress hides it. `value` arrives in the form the
 * wire serves — masked when the egress masks it — so a surface can paint
 * the answer as the post-save display and show exactly what the server will
 * read back. `masked` present = the served form is the masked one, never
 * the raw that was sent.
 */
export type SettingsSaveAnswer = Readonly<{
  readonly id: string;
  readonly saved: boolean;
  readonly value?: SettingValue;
  readonly masked?: true;
}>;

/**
 * Save a served setting — THE one write path (§9.1). Optimism is the
 * CALLER's rendering concern. A same-key claim survives remounts and excludes
 * conflicting writes until reconciliation finishes; other keys progress.
 * An unversioned action answer is historical, so only the post-action values
 * read may supply current truth. The broker's existing invalidation starts
 * that read exactly once, and the writer retains its binding until settlement.
 */
export async function saveSetting(id: string, value: SettingValue): Promise<SettingsSaveAnswer> {
  const previous = settingsWrites.get().get(id);
  if (previous?.kind === "pending") {
    throw new ClientError("setting_save_pending", "This setting is still saving. Your draft can be saved when it finishes.");
  }
  const current = servedCustomizationEntry(uiSchemaValues.get(), id);
  if (current?.masked && sameSettingValue(current.value, value)) {
    throw new ClientError("masked_setting_value", "The hidden display is not a value to save. Enter a new value.");
  }
  if (previous?.kind !== "uncertain" && current && sameSettingValue(current.value, value)) {
    return { ...current, saved: false };
  }
  const request = beginSchemaValuesRead();
  const claim = Symbol();
  settingsWrites.set(new Map(settingsWrites.get()).set(id, { kind: "pending", claim }));
  const release = bindSettingsReadback();
  let accepted = false;
  let confirmationAfter: SchemaValuesRead | undefined;
  try {
    const answer = await action<SettingsSaveAnswer>(
      SETTINGS_BLOCK,
      SETTINGS_SET_ACTION,
      { id, value },
      { invalidates: [SETTINGS_CHANGED_EVENT] },
    );
    accepted = true;
    if (!isCurrentSchemaValuesRead(request)) throw new ClientError("setting_scope_changed", "The account changed before this save could be confirmed.");
    if (!answer.saved || answer.id !== id || lastReadback === null) {
      throw new ClientError("setting_save_unconfirmed", "The server did not confirm this change.");
    }
    confirmationAfter = lastReadback.after;
    await lastReadback.done;
    if (!isCurrentSchemaValuesRead(request)) throw new ClientError("setting_scope_changed", "The account changed before this save could be confirmed.");
    const standing = servedCustomizationEntry(uiSchemaValues.get(), id);
    if (!standing) throw new ClientError("setting_readback_absent", "The saved setting could not be read back.");
    return { ...standing, saved: true };
  } catch (err) {
    if (!isCurrentSchemaValuesRead(request)) throw err;
    // Designed refusal explicitly says the write was declined. Transport or
    // confirmation failure cannot promise that storage was left unchanged.
    if (!accepted && refusalReason(err) !== null) {
      if (previous?.kind === "uncertain") {
        settingsWrites.set(new Map(settingsWrites.get()).set(id, previous));
        settleConfirmedWrites();
      }
      throw err;
    }
    let reason = err instanceof Error ? err.message : String(err);
    if (!accepted) {
      try { await refreshSettingsValues(); } catch {
        // Preserve the original transport reason and report the second failure
        // without retaining or exposing a response body or the submitted value.
        reason += " The confirmation request also failed.";
      }
    }
    if (!isCurrentSchemaValuesRead(request)) throw err;
    settingsWrites.set(new Map(settingsWrites.get()).set(id, { kind: "uncertain", ...(confirmationAfter ? { after: confirmationAfter } : {}) }));
    // Another post-settlement read may already have published while the
    // required read failed. Apply the same causal rule in either order.
    settleConfirmedWrites();
    if (!settingsWrites.get().has(id)) {
      return { ...servedCustomizationEntry(uiSchemaValues.get(), id)!, saved: true };
    }
    throw new ClientError("setting_save_unconfirmed", `This change may be stored, but it could not be confirmed. Try saving again. ${reason}`);
  } finally {
    const pending = settingsWrites.get().get(id);
    if (pending?.kind === "pending" && pending.claim === claim) {
      const next = new Map(settingsWrites.get());
      next.delete(id);
      settingsWrites.set(next);
    }
    release();
  }
}

// ── The diagnostic-modes array section (§9's door for the array leaf) ──────

/**
 * Read the diagnostic-modes list — the array section's ONE data door. The
 * block read serves the declared mode vocabulary and what the config file
 * excludes; the section never shapes the vocabulary itself.
 */
export async function readDiagnosticModes(): Promise<DiagnosticModesState> {
  return read<DiagnosticModesState>(DIAGNOSTIC_MODES_BLOCK, {});
}

/**
 * Save which diagnostic modes the command skips — the array leaf's ONE write
 * path, through the same validated block fabric as `saveSetting` (the past-
 * view gate, the timeline beat and the cache invalidation all ride the
 * broker's own door). Failures rethrow unchanged so the section renders the
 * server's own refusal sentence.
 */
export async function saveDiagnosticModes(excluded: readonly string[]): Promise<void> {
  await action(
    DIAGNOSTIC_MODES_BLOCK,
    DIAGNOSTIC_MODES_SET_ACTION,
    { excludedModes: [...excluded] },
    { invalidates: [SETTINGS_CHANGED_EVENT] },
  );
}

/**
 * A one-shot query handed to the settings index before it opens (the LENS
 * callout resolves a fact to SEVERAL candidate settings by namespace and
 * sends the user to the index pre-searched). The room consumes it on mount.
 */
export const pendingIndexQuery = atom<string | null>(null);

export function requestIndexQuery(query: string): void {
  pendingIndexQuery.set(query);
}

export function consumeIndexQuery(): string | null {
  const q = pendingIndexQuery.get();
  pendingIndexQuery.set(null);
  return q;
}
