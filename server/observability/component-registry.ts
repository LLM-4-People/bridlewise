/**
 * THE COMPONENT REGISTRY — the in-process half of the harness anatomy.
 *
 * The process census (process-census.ts, this directory) answers "what is
 * running on the machine". This module answers the other half of the
 * user directive — "every component of the harness at any given point" —
 * for the components that live INSIDE the server process: worker threads,
 * DB threads, folder watches, the resource sampler timer, run feeds, MCP
 * child processes. Each auto-registers AT ITS OWNER (the create/destroy
 * path of the choke point that creates it — never at a call site), so
 * forgetting to register is impossible in the same way the worker pool
 * made forgetting dedup impossible: a component cannot be created without
 * crossing the registration.
 *
 * DISTINCT FROM run-registry.ts (server/run/), which owns RUNS. This
 * registry owns RUNTIME COMPONENTS — handles, threads, timers, watchers,
 * children. The two are not conflated.
 *
 * ── LEAK-FREE BY CONSTRUCTION ─────────────────────────────────────────────
 *
 * `registerComponent` returns the unregister function; every owner stores
 * it where it already kept its own lifecycle state (the FolderWatch entry,
 * the Feed entry, the pool's worker bookkeeping) and calls it on the SAME
 * path that destroys the component. A closed component leaves the
 * registry — the owning test asserts empty-after-close.
 *
 * ── WHY THE FARM CHILDREN ARE NOT HERE ─────────────────────────────────────
 *
 * The intelligence farm children (engine/src/intelligence/process-farm.ts)
 * are forked from WORKER-THREAD isolates (the repository-map workers the
 * pool spawns). A worker thread is a separate module instance: a registry
 * entry written from inside it would land in an isolate-local registry
 * this process's route can never read — a false anatomy. The farm
 * children's honest registration surface is the CENSUS: they are real OS
 * processes with a chain to the server, their own pid, cpu and rss, and
 * their own argv pattern ("intelligence farm child") in the pattern
 * owner. The raw-handle guard lists process-farm.ts as the declared fork
 * owner with exactly this justification.
 */

/** Every component kind the registry tracks. The single owner of the
 * vocabulary — a new kind is added here and at its registering owner. */
export type ComponentKind =
  | "worker-thread"
  | "db-thread"
  | "folder-watch"
  | "settings-watch"
  | "sampler-timer"
  | "db-checkpoint-timer"
  | "run-feed"
  | "command-child"
  | "mcp-child";

/** One live registered component. */
export type RegisteredComponent = Readonly<{
  readonly id: string;
  readonly kind: ComponentKind;
  readonly label: string;
  readonly createdAtIso: string;
  /** What created it — the owner file + path, for the anatomy view's
   * "what started it" question. */
  readonly provenance: string;
  /** Per-kind facts (task label, path watched, interval, role, command). */
  readonly facts: Readonly<Record<string, unknown>>;
}>;

const live = new Map<string, RegisteredComponent>();
let nextId = 1;

/**
 * Register one live component. Returns the unregister function — the ONLY
 * door out (ids are internal). Call it on the same path that destroys the
 * component; idempotent (a double call is a no-op, never an error, so an
 * owner's error+exit double-path cannot throw out of teardown).
 */
export function registerComponent(input: Readonly<{
  kind: ComponentKind;
  label: string;
  provenance: string;
  facts?: Readonly<Record<string, unknown>>;
}>): () => void {
  const id = `c${nextId}`;
  nextId += 1;
  const entry: RegisteredComponent = Object.freeze({
    id,
    kind: input.kind,
    label: input.label,
    createdAtIso: new Date().toISOString(),
    provenance: input.provenance,
    facts: Object.freeze({ ...(input.facts ?? {}) }),
  });
  live.set(id, entry);
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    live.delete(id);
  };
}

/** The live components, sorted by kind then label then creation (stable
 * for the anatomy view + tests). */
export function componentSnapshot(): readonly RegisteredComponent[] {
  return [...live.values()].sort((a, b) =>
    a.kind === b.kind
      ? (a.label === b.label ? a.createdAtIso.localeCompare(b.createdAtIso) : a.label.localeCompare(b.label))
      : a.kind.localeCompare(b.kind),
  );
}

/** How many components are live right now (guards + tests). */
export function registeredComponentCount(): number {
  return live.size;
}

/** Live counts per kind (the anatomy summary line). */
export function componentCountsByKind(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of live.values()) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  }
  return counts;
}

/** The anatomy view's component half as text: one section per kind. */
export function formatComponentsText(components: readonly RegisteredComponent[]): string {
  if (components.length === 0) return "component registry — 0 live";
  const lines: string[] = [`component registry — ${components.length} live`];
  let currentKind = "";
  for (const c of components) {
    if (c.kind !== currentKind) {
      currentKind = c.kind;
      lines.push(`  ${c.kind}`);
    }
    const facts = Object.entries(c.facts)
      .map(([key, value]) => `${key} ${typeof value === "number" ? String(value) : JSON.stringify(value)}`)
      .join(" · ");
    const created = c.createdAtIso.slice(11, 19);
    lines.push(
      `    ${c.label}  ${facts.length > 0 ? `· ${facts}  ` : ""}since ${created}  (${c.provenance})`,
    );
  }
  return lines.join("\n");
}
