/**
 * nanostores shared state: auto-checks list, grouped per project and
 * per chat.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts. The
 * UI reads `projectChecks` + `chatChecks` and groups them in the
 * AutoCheckPanel.
 *
 * Auto-checks are quality/validation checks the harness runs
 * automatically (lint, typecheck, build, schema validation, etc.).
 * Each check has a name, status (running/passed/failed/warning), and
 * a JSON output payload (errors, warnings, summary, etc.).
 *
 * The AutoCheck type is the client-side authority for the check view.
 * The server boundary maps DB rows to this shape via
 * `server/routes/views.ts`.
 *
 * @global-store scope-based, re-scoped on chat switch via scopeAutoChecks (not a snapshot; the derived checksForCurrentChat updates with the scope)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset } from "./store-registry";

// ── Types ──

export type AutoCheckStatus = "running" | "passed" | "failed" | "warning";

export type AutoCheck = Readonly<{
  readonly id: string;
  readonly projectId: string | null;
  readonly chatId: string | null;
  readonly checkName: string;
  readonly status: AutoCheckStatus;
  readonly output: unknown;
  readonly createdAt: string;
}>;

// `AutoCheckCreateInput` is the WIRE-INPUT contract owned by
// `shared/input-schemas.ts` (the single zod schema + derived type).
// Re-exported here so existing `import { type AutoCheckCreateInput } from
// "./auto-checks"` call sites keep working; the shape is derived from the
// zod schema (a server change auto-propagates to the client type — no
// manual mirror to drift).
export type { AutoCheckCreateInput } from "../../shared/input-schemas.ts";

// ── Stores ──

export const autoChecks = atom<readonly AutoCheck[]>([]);

/**
 * Currently-selected project id for auto-checks scoping. Set by the
 * AutoCheckPanel from the current project; the panel reads
 * `checksForCurrentProject` + `checksForCurrentChat` derived stores.
 */
export const autoChecksProjectId = atom<string | null>(null);
export const autoChecksChatId = atom<string | null>(null);

export const checksForCurrentProject: ReadableAtom<readonly AutoCheck[]> = computed(
  [autoChecks, autoChecksProjectId],
  (list, pid) => (pid === null ? [] : list.filter((c) => c.projectId === pid)),
);

export const checksForCurrentChat: ReadableAtom<readonly AutoCheck[]> = computed(
  [autoChecks, autoChecksChatId],
  (list, cid) => (cid === null ? [] : list.filter((c) => c.chatId === cid)),
);

export const autoCheckCount: ReadableAtom<number> = computed(
  autoChecks,
  (list) => list.length,
);

// ── Ingestion (called only by client.ts) ──

export function setAutoChecks(list: readonly AutoCheck[]): void {
  autoChecks.set(list);
}

export function addAutoCheck(check: AutoCheck): void {
  autoChecks.set([...autoChecks.get(), check]);
}

/**
 * Merge a list of checks into the store, replacing any with the same
 * id. Used when refreshing per-project or per-chat check lists so
 * stale rows don't accumulate.
 */
export function upsertAutoChecks(incoming: readonly AutoCheck[]): void {
  const byId = new Map<string, AutoCheck>();
  for (const c of autoChecks.get()) byId.set(c.id, c);
  for (const c of incoming) byId.set(c.id, c);
  autoChecks.set([...byId.values()]);
}

/**
 * Evict every check that does NOT belong to `projectId`. Called on a
 * project switch (before upserting the new project's checks) so the raw
 * store does not accumulate checks from every project ever visited — an
 * unbounded memory leak (the derived `checksForCurrentProject` filters
 * by the current project, so the view was correct, but the raw list grew
 * without bound across a long session of project switches). Checks
 * belonging to `projectId` (project-level + chat-level for that
 * project) are kept; checks with a null `projectId` (legacy/uns scoped)
 * are also kept defensively.
 */
export function evictAutoChecksForOtherProjects(projectId: string): void {
  const kept = autoChecks.get().filter((c) => c.projectId === null || c.projectId === projectId);
  autoChecks.set(kept);
}

export function setAutoChecksScope(
  projectId: string | null,
  chatId: string | null,
): void {
  const previousChatId = autoChecksChatId.get();
  autoChecksProjectId.set(projectId);
  autoChecksChatId.set(chatId);
  // Evict the previous chat's checks at the scope choke point so the raw
  // list does not accumulate checks across every chat visited within a
  // project. The derived `checksForCurrentChat` filters by the current
  // chatId (so the view is correct), but the raw `autoChecks` list grew
  // with each chat's checks — a bounded-accumulation class of bug.
  // Evicting here (the single setter every scope change goes through)
  // means no caller can forget to clear the previous chat's checks.
  // Project-level checks (chatId === null) are kept; only the previous
  // chat's checks are evicted.
  if (previousChatId !== null && previousChatId !== chatId) {
    const kept = autoChecks.get().filter((c) => c.chatId !== previousChatId);
    autoChecks.set(kept);
  }
}

export function resetAutoChecks(): void {
  autoChecks.set([]);
  autoChecksProjectId.set(null);
  autoChecksChatId.set(null);
}

registerReset("autoChecks", resetAutoChecks);
