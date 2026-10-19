/**
 * Schema store — nanostore holding the UI schema + current signal/customization
 * values. The single client-side owner of the schema fetched from
 * `GET /api/schema/ui`.
 *
 * The renderer components (dynamic-panel, WidgetHost, StageHost) read from these
 * stores and render dynamically. No component hardcodes which panels or
 * widgets appear — everything is driven by the schema.
 *
 * Plain.ts — Node-testable via Vitest. Only scope-bound values reads enter
 * this snapshot. An action response describes its acceptance instant, not
 * what still stands when that response arrives.
 *
 * @global-store UI schema fetched per-user (not chat-scoped; same for every chat)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset } from "./store-registry";
import type { ModuleEntry } from "../../shared/module-contract.ts";

import type {
  UiSchema,
  UiSchemaValues,
  MenuEntry,
  PanelEntry,
  WidgetEntry,
  PanelSlot,
  WidgetSlot,
} from "../../shared/ui-schema";

// ── Stores ──

export const uiSchema = atom<UiSchema | null>(null);
export const uiSchemaValues = atom<UiSchemaValues | null>(null);
let valuesScope = 0;
let valuesRevision = 0;
export type SchemaValuesRead = Readonly<{ scope: number; revision: number }>;
/** Identity of the read that actually published the current snapshot. */
export const uiSchemaValuesRead = atom<SchemaValuesRead | null>(null);

/** Capture before asynchronous work. Resets invalidate the old user's work. */
export function beginSchemaValuesRead(): SchemaValuesRead {
  return { scope: valuesScope, revision: ++valuesRevision };
}

/** A completion from a previous account cannot begin new reads or feedback. */
export function isCurrentSchemaValuesRead(read: SchemaValuesRead): boolean {
  return read.scope === valuesScope;
}

// ── Derived: menus/panels/widgets (sorted by order) ──

function byOrder<T extends { readonly order: number }>(a: T, b: T): number {
  return a.order - b.order;
}

export const menus: ReadableAtom<readonly MenuEntry[]> = computed(
  uiSchema,
  (s) => (s ? [...s.menus].sort(byOrder) : []),
);

/**
 * The module declarations from the schema — the surface vocabulary.
 *
 * Populated by the server from three sources: authored MODULES, the legacy
 * bridge (which projects every existing panel so nothing is unreachable during
 * migration), and the exposure generator (one module per registry namespace).
 */
export const allModules: ReadableAtom<readonly ModuleEntry[]> = computed(
  uiSchema,
  (s) => s?.modules ?? [],
);

export const allPanels: ReadableAtom<readonly PanelEntry[]> = computed(
  uiSchema,
  (s) => (s ? [...s.panels].sort(byOrder) : []),
);

export const allWidgets: ReadableAtom<readonly WidgetEntry[]> = computed(
  uiSchema,
  (s) => (s ? [...s.widgets].sort(byOrder) : []),
);

// ── Slot-filtered helpers (plain arrays — for tests + non-Svelte consumers) ──

export function panelsForSlot(slot: PanelSlot): readonly PanelEntry[] {
  return allPanels.get().filter((p) => p.slot === slot);
}

export function widgetsForSlot(slot: WidgetSlot): readonly WidgetEntry[] {
  return allWidgets.get().filter((w) => w.slot === slot);
}

// ── Derived: signal value lookup map ──

export const signalValueMap: ReadableAtom<ReadonlyMap<string, number | string | boolean>> = computed(
  uiSchemaValues,
  (v) => {
    const map = new Map<string, number | string | boolean>();
    if (v) for (const entry of v.signals) map.set(entry.id, entry.value);
    return map;
  },
);

/** Read a signal's current value from the values store, or `undefined`. */
export function getSignalValue(id: string): number | string | boolean | undefined {
  return signalValueMap.get().get(id);
}

// ── Ingestion (called only by client.ts) ──

export function setUiSchema(schema: UiSchema): void {
  uiSchema.set(schema);
}

export function setUiSchemaValues(values: UiSchemaValues, read: SchemaValuesRead = beginSchemaValuesRead()): void {
  if (read.scope !== valuesScope || read.revision < (uiSchemaValuesRead.get()?.revision ?? 0)) return;
  uiSchemaValues.set(values);
  uiSchemaValuesRead.set(read);
}

export function resetUiSchema(): void {
  valuesScope += 1;
  valuesRevision = 0;
  uiSchemaValuesRead.set(null);
  uiSchema.set(null);
  uiSchemaValues.set(null);
}

registerReset("uiSchema", resetUiSchema);
