/**
 * nanostores shared state: projects list + current selection.
 *
 * Plain.ts — Node-testable via Vitest without any Svelte compiler.
 *
 * Boundary rule: the projects LIST is backend-originating and is fed ONLY by
 * client.ts (setProjects, addProject). The currentProjectId selection is
 * UI-originated shared state: components may call selectProject directly
 * (it is a pure UI selection, not backend data). client.ts also calls
 * selectProject after createProject so the new project is activated.
 *
 * The ProjectSummary type is the client-side authority for the project
 * view. The server boundary maps DB rows (snake_case) to this shape via
 * `server/routes/views.ts`.
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { restoreTabStringAtom, bindAtomTabPersistence, restoreJsonList, persistJsonList } from "./persistence";
import { registerReset } from "./store-registry";

// ── Types (canonical owner for the web-slice client view) ──

export type ProjectSummary = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Whether the project's folder is on the server's disk right now,
   * measured server-side when the project was read (the wire view owns the
   * field; `server/fs-gate.ts` owns the probe). A cached project from the
   * last visit may predate the field — `undefined` is the honest "not
   * measured this read", and renders as nothing rather than as a guess.
   */
  readonly folder?: "present" | "missing" | "unreadable";
}>;

// `ProjectCreateInput` is the WIRE-INPUT contract owned by
// `shared/input-schemas.ts` (the single zod schema + derived type).
// Re-exported here so existing `import { type ProjectCreateInput } from
// "./projects"` call sites keep working; the shape is derived from the
// zod schema (a server change auto-propagates to the client type — no
// manual mirror to drift).
export type { ProjectCreateInput, ProjectUpdateInput } from "../../shared/input-schemas.ts";

// ── Stores ──

// Cached-then-revalidate (cockpit v2.1 web-native correction): the list
// seeds from the LAST VISIT's server response so a page revisit paints
// instantly instead of reloading from empty, then the boot fetch replaces
// it with the live answer. `projectsFromCache` stays true until a real
// server list lands — consumers may label the interim honestly
// ("as of your last visit"). The cache is written ONLY from the real
// setter below, so it is stale-at-worst, never invented.
const cachedProjects = restoreJsonList<ProjectSummary>("projects:lastKnown");
export const projects = atom<readonly ProjectSummary[]>(cachedProjects ?? []);
export const projectsFromCache = atom<boolean>(cachedProjects !== null);
export const currentProjectId = atom<string | null>(null);

// Persist the selected project so chats auto-load on page refresh. The
// project LIST is backend-originating (loaded in boot); only the selection
// is persisted. Restore happens in App.svelte boot() AFTER listProjects so
// the restored id can be validated against the real list.
//
// PER BROWSER TAB, not shared. This was a single localStorage slot every tab
// wrote: opening a second tab on another project moved the first one, and the
// first moved it back on its next write. Two cockpits then disagreed about
// what they were showing with nothing on either screen saying so — the exact
// silent divergence this project refuses everywhere else. `persistTabSet`
// keeps this tab's answer in `sessionStorage` (per-tab by definition, survives
// a reload) and refreshes the shared value as the SEED a brand-new tab starts
// from, which is what preserves the restore-on-reload behaviour the boot
// probe reports on. See `state/workspaces.ts` for the level above: a tab may
// hold several workspaces, and this atom projects the active one.
restoreTabStringAtom(currentProjectId, "currentProjectId");
bindAtomTabPersistence(currentProjectId, "currentProjectId");

export const currentProject: ReadableAtom<ProjectSummary | null> = computed(
  [projects, currentProjectId],
  (list, id) => list.find((p) => p.id === id) ?? null,
);

export const projectCount: ReadableAtom<number> = computed(
  projects,
  (list) => list.length,
);

// ── Ingestion ──

export function setProjects(list: readonly ProjectSummary[]): void {
  projects.set(list);
  // A real server response is the only writer of the revisit cache, and it
  // also ends the "from cache" interim — from here the screen shows live data.
  projectsFromCache.set(false);
  persistJsonList("projects:lastKnown", list);
}

export function addProject(project: ProjectSummary): void {
  const next = [...projects.get(), project];
  projects.set(next);
}

/**
 * Remove a project from the in-memory list. Called by client.ts after a
 * successful DELETE. If the removed project was selected, clears the
 * selection so the UI doesn't reference a deleted project.
 */
export function removeProject(id: string): void {
  const next = projects.get().filter((p) => p.id !== id);
  projects.set(next);
  if (currentProjectId.get() === id) {
    currentProjectId.set(null);
  }
}

/**
 * Rename a project in the in-memory list (sidebar rework). Called
 * by client.ts after a successful PATCH. Updates the name + updatedAt.
 */
export function renameProjectInStore(id: string, name: string, updatedAt: string): void {
  const next = projects.get().map((p) =>
    p.id === id ? { ...p, name, updatedAt } : p,
  );
  projects.set(next);
}

/**
 * Apply a server-answered project update to the in-memory list (relink:
 * the folder presence is re-measured by the server on the response, so the
 * store takes the WHOLE row — a relink that fixed a missing folder clears
 * the badge without a second fetch).
 */
export function updateProjectInStore(
  id: string,
  fields: Readonly<{
    name?: string;
    path?: string;
    updatedAt: string;
    folder?: NonNullable<ProjectSummary["folder"]>;
  }>,
): void {
  const next = projects.get().map((p) => {
    if (p.id !== id) return p;
    // exactOptionalPropertyTypes: an absent field is NOT spread as
    // `undefined` (which would erase a prior value) — only present fields
    // are applied.
    return {
      ...p,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.path !== undefined ? { path: fields.path } : {}),
      ...(fields.folder !== undefined ? { folder: fields.folder } : {}),
      updatedAt: fields.updatedAt,
    };
  });
  projects.set(next);
}

export function selectProject(id: string | null): void {
  currentProjectId.set(id);
}

export function resetProjects(): void {
  projects.set([]);
  projectsFromCache.set(false);
  persistJsonList("projects:lastKnown", []); // logout clears the revisit cache
  currentProjectId.set(null);
}

registerReset("projects", resetProjects);
