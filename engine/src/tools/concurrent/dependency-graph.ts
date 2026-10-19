/**
 * Concurrent tool dispatch — dependency graph + topological levels.
 *
 * Two dependency sources:
 * 1. Explicit `$ref` placeholders: an arg `{ "$ref": "A" }` means
 * "substitute the result of call A here". The call depends on A.
 * 2. Implicit data-flow: a path-bearing call whose `path` (or `paths`)
 * arg matches a file path produced by a prior `grep`-like call.
 * The implicit pattern is configurable through {@link
 * DependencyGraphOptions.pathTools} and `producerTools` — there are
 * no hardcoded tool-name lists.
 *
 * Returns the dependency graph (Map<id, Set<depId>>) plus topological
 * levels (Kahn's algorithm). A cycle throws a typed {@link
 * DependencyCycleError}; an unknown `$ref` throws a typed {@link
 * UnknownReferenceError}.
 *
 * This module is pure (domain layer): no I/O, no workers, no timers. It is
 * the single owner of dependency-ordering logic for the concurrent
 * dispatcher.
 */

import { HarnessError } from "../../kernel/errors.ts";

export class DependencyCycleError extends HarnessError {
  constructor(message = "Batch has a dependency cycle") {
    super(message, "dependency_cycle");
  }
}

export class UnknownReferenceError extends HarnessError {
  constructor(callId: string, refId: string) {
    super(
      `Call '${callId}' references unknown callId '${refId}' via $ref`,
      "dependency_unknown_ref",
    );
  }
}

export type ConcurrentToolCall = Readonly<{
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>> | string;
  /**
   * Optional list of Transferable objects (ArrayBuffer, MessagePort, etc.)
   * to pass to the worker's `postMessage` transferList. When present, the
   * listed objects are transferred zero-copy (the main thread loses
   * ownership). Eliminates the structured-clone overhead for large
   * payloads (e.g., pre-read file contents as Uint8Array).
   */
  transferList?: readonly (import("node:worker_threads").Transferable)[];
}>;

export type DependencyGraphOptions = Readonly<{
  /**
   * Tools whose `path`/`paths` arg consumes a file produced by a producer.
   * Defaults to none (the dispatcher passes its own configured set). No
   * hardcoded list lives here.
   */
  pathTools?: ReadonlySet<string>;
  /**
   * Tools that produce a set of file paths available for implicit
   * dependency matching. The caller seeds `producerResults` with the
   * files each producer returned.
   */
  producerTools?: ReadonlySet<string>;
  /**
   * Map of `producerCallId -> set of file paths it returned`. Used for
   * implicit data-flow dependency detection. Optional.
   */
  producerResults?: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export type DependencyGraph = Readonly<{
  deps: ReadonlyMap<string, ReadonlySet<string>>;
  levels: ReadonlyMap<string, number>;
}>;

/**
 * Build the dependency graph + topological levels for a batch of tool
 * calls. Throws {@link DependencyCycleError} on a cycle and {@link
 * UnknownReferenceError} on an unknown `$ref`.
 *
 * Named `buildToolCallDependencyGraph` to distinguish it from the
 * repository-module dependency graph builder in
 * `src/intelligence/dependency-graph.ts` (which resolves code imports to
 * file-level adjacency). This function orders concurrent tool-call
 * execution via `$ref` placeholders + implicit data-flow dependencies.
 */
export function buildToolCallDependencyGraph(
  batch: readonly ConcurrentToolCall[],
  options: DependencyGraphOptions = {},
): DependencyGraph {
  const ids = new Set(batch.map((c) => c.id));
  const deps = new Map<string, Set<string>>();
  for (const c of batch) deps.set(c.id, new Set<string>());

  // 1. Explicit $ref placeholders.
  for (const c of batch) {
    const args = parseArgs(c.args);
    collectRefs(args, (refId) => {
      if (!ids.has(refId)) throw new UnknownReferenceError(c.id, refId);
      if (refId !== c.id) deps.get(c.id)!.add(refId);
    });
  }

  // 2. Implicit data-flow: a path-bearing consumer that matches a file
  // produced by a prior producer call.
  const pathTools = options.pathTools ?? emptySet;
  const producerResults = options.producerResults ?? emptyMap;
  if (pathTools.size > 0 && producerResults.size > 0) {
    for (const c of batch) {
      if (!pathTools.has(c.name)) continue;
      const args = parseArgs(c.args);
      const paths = extractPaths(args);
      if (paths.length === 0) continue;
      for (const refId of producerResults.keys()) {
        if (refId === c.id) continue;
        const produced = producerResults.get(refId)!;
        for (const p of paths) {
          if (produced.has(p)) {
            deps.get(c.id)!.add(refId);
            break;
          }
        }
      }
    }
  }

  const levels = topologicalLevels(deps);
  if (levels === null) throw new DependencyCycleError();
  return {
    deps: freezeDeps(deps),
    levels,
  };
}

/**
 * Kahn's topological sort returning `Map<id, level>` (level 0 = no deps).
 * Returns `null` on a cycle.
 */
export function topologicalLevels(
  deps: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> | null {
  const indeg = new Map<string, number>();
  for (const [id, dset] of deps) indeg.set(id, dset.size);
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of indeg) {
    if (deg === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  const dependents = new Map<string, string[]>();
  for (const id of deps.keys()) dependents.set(id, []);
  for (const [id, dset] of deps) {
    for (const dep of dset) dependents.get(dep)!.push(id);
  }
  let processed = 0;
  while (queue.length > 0) {
    const u = queue.shift()!;
    processed++;
    const ul = level.get(u)!;
    for (const v of dependents.get(u)!) {
      indeg.set(v, indeg.get(v)! - 1);
      if (!level.has(v) || ul + 1 > level.get(v)!) level.set(v, ul + 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  return processed === deps.size ? level : null;
}

/**
 * Resolve only the explicit `$ref` dependencies for a batch. Useful for
 * building `dependsOn` arrays without the implicit data-flow layer.
 */
export function resolveExplicitDeps(
  batch: readonly ConcurrentToolCall[],
): Map<string, ReadonlySet<string>> {
  const ids = new Set(batch.map((c) => c.id));
  const out = new Map<string, Set<string>>();
  for (const c of batch) {
    const dset = new Set<string>();
    const args = parseArgs(c.args);
    collectRefs(args, (refId) => {
      if (ids.has(refId) && refId !== c.id) dset.add(refId);
    });
    out.set(c.id, dset);
  }
  return freezeDeps(out);
}

const emptySet: ReadonlySet<string> = new Set();
const emptyMap: ReadonlyMap<string, ReadonlySet<string>> = new Map();

function parseArgs(
  args: ConcurrentToolCall["args"],
): Readonly<Record<string, unknown>> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Readonly<Record<string, unknown>>;
    } catch {
      return {} as Readonly<Record<string, unknown>>;
    }
  }
  return args ?? ({} as Readonly<Record<string, unknown>>);
}

function collectRefs(
  node: unknown,
  emit: (refId: string) => void,
  seen: Set<unknown> = new Set(),
): void {
  if (node === null || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const c of node) collectRefs(c, emit, seen);
    return;
  }
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === "$ref") {
    const v = (node as { $ref: unknown }).$ref;
    if (typeof v === "string" && v.length > 0) {
      const parts = v.split(".");
      const id = parts[0];
      if (id !== undefined && id.length > 0) emit(id);
    }
    return;
  }
  for (const c of Object.values(node)) collectRefs(c, emit, seen);
}

function extractPaths(args: Readonly<Record<string, unknown>>): readonly string[] {
  const out: string[] = [];
  const p = args.path;
  if (typeof p === "string" && p.length > 0) out.push(p);
  const ps = args.paths;
  if (Array.isArray(ps)) {
    for (const x of ps) {
      if (typeof x === "string" && x.length > 0) out.push(x);
    }
  }
  return out;
}

function freezeDeps(
  deps: Map<string, Set<string>>,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [k, v] of deps) out.set(k, new Set(v));
  return out;
}
