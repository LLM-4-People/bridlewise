/**
 * Outlet discovery — the file-convention seam (see contract.ts).
 *
 * `import.meta.glob` with literal paths: when a sibling agent creates the
 * file, Vite picks it up on the next dev-server module graph refresh and
 * the shell mounts it — no shell file is edited. When the file is absent
 * the glob map is simply empty and the outlet renders its honest
 * "not built yet" state. Eager: false is deliberate — outlet modules load
 * during boot (before the reveal) so the reveal frame mounts them without
 * a late network fetch (§10.3 one-reveal law).
 */

type ComponentModule = Readonly<{ default: unknown }>;
type Loader = () => Promise<ComponentModule>;

import type { ReadableAtom } from "nanostores";
import type { Component } from "svelte";
import { RIGHT_MENU_GROUPS, type RightMenuId } from "./right-menu.ts";
import type { GrammarTarget } from "./contract.ts";

/** Inspector extension door. Add a named group at right-menu.ts and its
 * domain body here; the host derives navigation, disclosure and mounting.
 * Bodies own their sections/data/actions through Disclosure and broker. */
const inspectorBodies = {
  setup: () => import("../desk/DeskPanel.svelte"),
  run: () => import("../flow/RunPane.svelte"),
  arm: () => import("../sweep/ArmMenuBody.svelte"),
} satisfies Record<RightMenuId, () => Promise<{ default: Component }>>;

export type InspectorGroup = Readonly<{
  id: RightMenuId; label: string; description: string; chord?: GrammarTarget;
  context: "conversation" | "workspace"; defaultOpen: boolean; summary: ReadableAtom<string | null>;
}>;

export const INSPECTOR_GROUPS: readonly InspectorGroup[] = Object.freeze(
  (Object.keys(inspectorBodies) as RightMenuId[]).map((id) => Object.freeze({
    id, ...RIGHT_MENU_GROUPS[id],
  })),
);

const inspectorModules = new Map<RightMenuId, { loading: Promise<Component>; component: Component | null }>();
export function inspectorGroupComponent(id: RightMenuId): Component | null {
  return inspectorModules.get(id)?.component ?? null;
}
export function loadInspectorGroup(id: RightMenuId): Promise<Component> {
  const held = inspectorModules.get(id);
  if (held !== undefined) return held.loading;
  const loading = inspectorBodies[id]().then(module => {
    entry.component = module.default;
    return module.default;
  }).catch(error => {
    inspectorModules.delete(id);
    throw error;
  });
  const entry = { loading, component: null as Component | null };
  inspectorModules.set(id, entry);
  return loading;
}

const flowGlob = import.meta.glob("../flow/Flow.svelte") as Record<string, Loader>;
const sweepGlob = import.meta.glob("../sweep/Sweep.svelte") as Record<string, Loader>;
const gaugeGlob = import.meta.glob("../desk/Gauge.svelte") as Record<string, Loader>;
const lensGlob = import.meta.glob("../lens/LensCallout.svelte") as Record<string, Loader>;
const roomsGlob = import.meta.glob("../rooms/*Room.svelte") as Record<string, Loader>;

function single(glob: Record<string, Loader>): Loader | null {
  const keys = Object.keys(glob);
  return keys.length > 0 ? glob[keys[0]!]! : null;
}

export type OutletId = "flow" | "sweep" | "gauge" | "lens";

const OUTLET_LOADERS: Readonly<Record<OutletId, Loader | null>> = {
  flow: single(flowGlob),
  sweep: single(sweepGlob),
  gauge: single(gaugeGlob),
  // ⌘L (§9.2) — the LENS callout overlay: mounted at the reveal, renders
  // NOTHING until armed (zero-cost when closed), claims the "lens" chord.
  lens: single(lensGlob),
};

/**
 * Every outlet id there is — the union's members, at runtime.
 *
 * DERIVED FROM THE RECORD, WHICH THE TYPE FORCES TO BE COMPLETE.
 * `OUTLET_LOADERS` is a `Record<OutletId, …>`, so a member added to the union
 * without an entry here is a compile error, and an entry here that the union
 * does not declare is one too. That makes these keys the union, exhaustively,
 * without a second list anyone maintains.
 *
 * It exists because the guard over outlets carried a hand-written
 * `readonly OutletId[]` literal instead. A subset array is assignable to that
 * type, so a seventh outlet whose component does not exist left the guard at
 * six passed and `tsc` at zero errors — a declaration with nothing behind it,
 * inside the guard built to end declarations with nothing behind them.
 */
export const OUTLET_IDS: readonly OutletId[] = Object.keys(OUTLET_LOADERS) as OutletId[];

/** Whether the sibling surface exists in the tree at all. */
export function outletExists(id: OutletId): boolean {
  return OUTLET_LOADERS[id] !== null;
}

/**
 * Load an outlet component (null when not built yet). Called during boot,
 * BEFORE the reveal, so mounting at the reveal frame is synchronous.
 */
export async function loadOutlet(id: OutletId): Promise<unknown | null> {
  const loader = OUTLET_LOADERS[id];
  if (loader === null) return null;
  const mod = await loader();
  return mod.default;
}

/** Room component for a RoomId, by the `<Id>Room.svelte` convention. */
export async function loadRoom(roomId: string): Promise<unknown | null> {
  const cap = roomId.charAt(0).toUpperCase() + roomId.slice(1);
  const suffix = `/${cap}Room.svelte`;
  for (const [path, loader] of Object.entries(roomsGlob)) {
    if (path.endsWith(suffix)) return (await loader()).default;
  }
  return null;
}

/** Whether a room's component exists (sync — drives hint vs. open). */
export function roomExists(roomId: string): boolean {
  const cap = roomId.charAt(0).toUpperCase() + roomId.slice(1);
  const suffix = `/${cap}Room.svelte`;
  return Object.keys(roomsGlob).some((p) => p.endsWith(suffix));
}
