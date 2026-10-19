/**
 * Concurrent tool dispatch — the unified executor for batches of tool
 * calls with five dispatch modes:
 *
 * 1. `sequential` — one call at a time (baseline for speedup measurement).
 * 2. `parallel` — all calls via `Promise.all` on the main thread.
 * 3. `worker` — CPU-bound calls to a {@link WorkerPool}, I/O on the
 * event loop; both groups run in parallel per topological level.
 * 4. `streaming` — calls are "sealed" (instant-seal) one at a time and
 * executed immediately, overlapping execution with the next call's
 * arrival (simulates streaming `tool_calls` deltas from an LLM).
 * 5. `dependency-aware` — Kahn topological levels from {@link
 * buildToolCallDependencyGraph}; calls at the same level run in parallel
 * (CPU on workers, I/O on the event loop), dependent calls wait.
 *
 * The dispatcher is agnostic to the concrete handlers: a {@link
 * HandlerRegistry} maps tool names to async handlers. The caller
 * classifies which tool names are CPU-bound (routed to the worker pool)
 * vs I/O-bound (main thread). No tool-name list is hardcoded here.
 *
 * Configuration is caller-supplied (the runtime sources it from
 * ROOT_POLICY / the central config). No static thresholds live in this
 * module.
 */

import { performance } from "node:perf_hooks";
import { HarnessError } from "../../kernel/errors.ts";
import { bestEffort } from "../../shared/best-effort.ts";
import { guarded } from "../../process/fault-policy.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { buildToolCallDependencyGraph } from "./dependency-graph.ts";
import type { ConcurrentToolCall, DependencyGraph } from "./dependency-graph.ts";
import { WorkerPool } from "./worker-pool.ts";
import type { WorkerCall, WorkerCallResult } from "./worker-pool.ts";
import { DEFAULT_DISPATCHER_MIN_CONTENT_CHARS, DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS } from "../../kernel/config-contracts.ts";

export type DispatchMode = "sequential" | "parallel" | "worker" | "streaming" | "dependency-aware";

export type HandlerContext = Readonly<{
  root: string;
  state?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}>;

export type HandlerResult = Readonly<{
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}>;

export type ToolHandler = (args: Readonly<Record<string, unknown>>, ctx: HandlerContext) => Promise<HandlerResult>;

export type HandlerRegistry = ReadonlyMap<string, ToolHandler>;

export type DispatcherConfig = Readonly<{
  /** Tool names routed to the worker pool (CPU-bound). Defaults to none. */
  cpuTools?: ReadonlySet<string>;
  /** Tool names run on the main thread (I/O-bound). Defaults to all non-CPU. */
  ioTools?: ReadonlySet<string>;
  /**
   * Max concurrent I/O calls per chunk (rate limiting). Absent: no chunking —
   * every I/O call of the batch (worker mode) or of one dependency level
   * (graph mode) runs at once. One meaning in every mode ({@link ioChunkSize});
   * graph mode used to fall back to 16 where worker mode ran them all
   * (a2-design H2 row 4).
   */
  maxConcurrent?: number;
  /** Inter-call delay for `streaming` mode (ms). */
  interCallMs?: number;
  /** Max result JSON length before truncation (caller-derived). */
  maxResultChars?: number;
  /** Per-call timeout in ms (caller-derived; protects against hung handlers). */
  callTimeoutMs?: number;
  /**
   * When true, CPU-bound calls run on the MAIN THREAD (via the handler
   * registry) instead of the worker pool. Used to measure the TRUE
   * single-threaded baseline: the worker-pool speedup over this baseline
   * reflects the real parallelism gain (single-thread → N workers). When
   * false (default), CPU calls go to the worker pool.
   */
  cpuOnMainThread?: boolean;
  /** Worker pool (required for `worker` and `streaming` modes). */
  pool?: WorkerPool;
  /**
   * Path-tools + producer-results for implicit data-flow dependency
   * detection (dependency-aware mode). Both come from the caller.
   */
  pathTools?: ReadonlySet<string>;
  producerResults?: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export type CallResult = Readonly<{
  id: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  toolDurationMs?: number;
  truncated?: boolean;
  originalBytes?: number;
  content?: string;
  worker?: boolean;
  mainThread?: boolean;
  skipped?: boolean;
  sealOffsetMs?: number;
  execStartOffsetMs?: number;
  execDurationMs?: number;
}>;

export type DispatchOutcome = Readonly<{
  results: readonly CallResult[];
  totalMs: number;
  levels?: ReadonlyMap<string, number>;
  sealed?: number;
  totalOverlapMs?: number;
  overlapWindowMs?: number;
  overlapPct?: number;
}>;

/** How many of `ioCalls` run at once: the configured bound, or all of them (the one meaning of an absent `maxConcurrent`). */
function ioChunkSize(config: DispatcherConfig, ioCalls: readonly ConcurrentToolCall[]): number {
  return config.maxConcurrent ?? ioCalls.length;
}

export class DispatcherError extends HarnessError {
  constructor(message: string, code = "dispatcher_error") {
    super(message, code);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withCallTimeout<T>(p: Promise<T>, callTimeoutMs: number | undefined, callId: string, name: string): Promise<T> {
  if (callTimeoutMs === undefined || callTimeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(guarded("tools.dispatcher.call-timeout", () => reject(new DispatcherError(
      `tool '${name}' (id='${callId}') exceeded call timeout of ${callTimeoutMs}ms`,
      "dispatcher_call_timeout",
    ))), callTimeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createConcurrentDispatcher(registry: HandlerRegistry): Readonly<{
  execute: (batch: readonly ConcurrentToolCall[], mode: DispatchMode, ctx: HandlerContext, config?: DispatcherConfig) => Promise<DispatchOutcome>;
}> {
  async function runHandler(
    call: ConcurrentToolCall,
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<CallResult> {
    const t0 = performance.now();
    const args = parseArgs(call.args);
    const handler = registry.get(call.name);
    if (handler === undefined) {
      return { id: call.id, name: call.name, ok: false, error: `unknown tool '${call.name}'`, durationMs: 0 };
    }
    let r: HandlerResult;
    try {
      r = await withCallTimeout(handler(args, ctx), config.callTimeoutMs, call.id, call.name);
    } catch (e) {
      r = { ok: false, error: errMessage(e), durationMs: performance.now() - t0 };
    }
    const durationMs = performance.now() - t0;
    if (!r.ok) {
      return { id: call.id, name: call.name, ok: false, ...(typeof r.error === "string" ? { error: r.error } : {}), durationMs };
    }
    const tr = truncateResult(r.result, config.maxResultChars);
    return deepFreeze({
      id: call.id,
      name: call.name,
      ok: true,
      ...(r.result !== undefined ? { result: r.result } : {}),
      toolDurationMs: r.durationMs,
      durationMs,
      truncated: tr.truncated,
      originalBytes: tr.originalBytes,
      content: tr.content,
      mainThread: true,
    });
  }

  async function runCpuViaPool(
    call: ConcurrentToolCall,
    pool: WorkerPool,
    config: DispatcherConfig,
  ): Promise<CallResult> {
    const t0 = performance.now();
    const args = parseArgs(call.args);
    const wc: WorkerCall = {
      id: call.id, name: call.name, args,
      ...(call.transferList !== undefined ? { transferList: call.transferList } : {}),
    };
    let r: WorkerCallResult;
    try {
      r = await withCallTimeout(pool.exec(wc), config.callTimeoutMs, call.id, call.name);
    } catch (e) {
      return { id: call.id, name: call.name, ok: false, error: errMessage(e), durationMs: performance.now() - t0 };
    }
    const durationMs = performance.now() - t0;
    if (!r.ok) {
      return { id: call.id, name: call.name, ok: false, ...(typeof r.error === "string" ? { error: r.error } : {}), durationMs };
    }
    const tr = truncateResult(r.result, config.maxResultChars);
    return deepFreeze({
      id: call.id,
      name: call.name,
      ok: true,
      ...(r.result !== undefined ? { result: r.result } : {}),
      toolDurationMs: r.durationMs,
      durationMs,
      truncated: tr.truncated,
      originalBytes: tr.originalBytes,
      content: tr.content,
      worker: true,
    });
  }

  function classify(call: ConcurrentToolCall, config: DispatcherConfig): "cpu" | "io" {
    const cpuTools = config.cpuTools ?? emptySet;
    if (cpuTools.has(call.name)) return "cpu";
    const ioTools = config.ioTools;
    if (ioTools !== undefined && ioTools.has(call.name)) return "io";
    return "io";
  }

  async function runOne(
    call: ConcurrentToolCall,
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<CallResult> {
    const kind = classify(call, config);
    if (kind === "cpu" && config.cpuOnMainThread !== true) {
      if (config.pool === undefined) {
        return { id: call.id, name: call.name, ok: false, error: "worker mode requires a pool", durationMs: 0 };
      }
      return runCpuViaPool(call, config.pool, config);
    }
    return runHandler(call, ctx, config);
  }

  // Mode 1: sequential (baseline).
  async function executeSequential(
    batch: readonly ConcurrentToolCall[],
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<DispatchOutcome> {
    const t0 = performance.now();
    const results: CallResult[] = [];
    for (const c of batch) {
      results.push(await runOne(c, ctx, config));
    }
    return { results, totalMs: performance.now() - t0 };
  }

  // Mode 2: parallel (Promise.all on main thread).
  async function executeParallel(
    batch: readonly ConcurrentToolCall[],
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<DispatchOutcome> {
    const t0 = performance.now();
    const results = await Promise.all(batch.map((c) => runOne(c, ctx, config)));
    return { results, totalMs: performance.now() - t0 };
  }

  // Mode 3: worker (CPU on workers, I/O on event loop, both in parallel).
  async function executeWorker(
    batch: readonly ConcurrentToolCall[],
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<DispatchOutcome> {
    if (config.pool === undefined) {
      throw new DispatcherError("worker mode requires a pool", "dispatcher_no_pool");
    }
    const t0 = performance.now();
    const cpuCalls = batch.filter((c) => classify(c, config) === "cpu");
    const ioCalls = batch.filter((c) => classify(c, config) === "io");
    const maxConcurrent = ioChunkSize(config, ioCalls);
    const cpuPromise = Promise.all(cpuCalls.map((c) => runCpuViaPool(c, config.pool!, config)));
    const ioPromise = (async () => {
      const all: CallResult[] = [];
      for (let i = 0; i < ioCalls.length; i += maxConcurrent) {
        const chunk = ioCalls.slice(i, i + maxConcurrent);
        const chunkResults = await Promise.all(chunk.map((c) => runHandler(c, ctx, config)));
        all.push(...chunkResults);
      }
      return all;
    })();
    const [cpuResults, ioResults] = await Promise.all([cpuPromise, ioPromise]);
    const byId = new Map<string, CallResult>();
    for (const r of [...cpuResults, ...ioResults]) byId.set(r.id, r);
    return { results: batch.map((c) => byId.get(c.id)!), totalMs: performance.now() - t0 };
  }

  // Mode 4: streaming (instant-seal + immediate exec).
  async function executeStreaming(
    batch: readonly ConcurrentToolCall[],
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<DispatchOutcome> {
    if (config.pool === undefined) {
      throw new DispatcherError("streaming mode requires a pool", "dispatcher_no_pool");
    }
    const t0 = performance.now();
    const interCallMs = config.interCallMs ?? 0;
    const results = new Map<string, CallResult>();
    let firstSealOffset: number | null = null;
    let sealed = 0;
    let streamEndOffset = 0;
    let totalOverlapMs = 0;

    const sealAndExecute = (call: ConcurrentToolCall): Promise<void> => {
      sealed++;
      const sealTime = performance.now() - t0;
      if (firstSealOffset === null) firstSealOffset = sealTime;
      const execStart = performance.now();
      return runOne(call, ctx, config).then((r) => {
        const execDuration = performance.now() - execStart;
        results.set(call.id, deepFreeze({
          ...r,
          sealOffsetMs: sealTime,
          execStartOffsetMs: execStart - t0,
          execDurationMs: execDuration,
        }));
      });
    };

    const inflight: Promise<void>[] = [];
    for (const c of batch) {
      await sleep(interCallMs);
      inflight.push(sealAndExecute(c));
    }
    await Promise.all(inflight);
    streamEndOffset = performance.now() - t0;
    for (const r of results.values()) {
      if (r.execStartOffsetMs !== undefined && r.execDurationMs !== undefined) {
        const execEndOffset = r.execStartOffsetMs + r.execDurationMs;
        const overlap = Math.max(0, Math.min(execEndOffset, streamEndOffset) - r.execStartOffsetMs);
        totalOverlapMs += overlap;
      }
    }
    const overlapWindowMs = firstSealOffset !== null ? streamEndOffset - firstSealOffset : 0;
    const overlapPct = overlapWindowMs > 0 ? (totalOverlapMs / overlapWindowMs) * 100 : 0;
    return {
      results: batch.map((c) => results.get(c.id)!),
      totalMs: performance.now() - t0,
      sealed,
      totalOverlapMs,
      overlapWindowMs,
      overlapPct,
    };
  }

  // Mode 5: dependency-aware (Kahn levels; CPU on workers, I/O on event loop).
  async function executeDependencyAware(
    batch: readonly ConcurrentToolCall[],
    ctx: HandlerContext,
    config: DispatcherConfig,
  ): Promise<DispatchOutcome> {
    if (config.pool === undefined) {
      throw new DispatcherError("dependency-aware mode requires a pool", "dispatcher_no_pool");
    }
    const t0 = performance.now();
    const graphOptions: {
      pathTools?: ReadonlySet<string>;
      producerResults?: ReadonlyMap<string, ReadonlySet<string>>;
    } = {};
    if (config.pathTools !== undefined) graphOptions.pathTools = config.pathTools;
    if (config.producerResults !== undefined) graphOptions.producerResults = config.producerResults;
    const graph: DependencyGraph = buildToolCallDependencyGraph(batch, graphOptions);
    const maxLevel = Math.max(...graph.levels.values());
    const results = new Map<string, CallResult>();

    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const callsAtLevel = batch.filter((c) => graph.levels.get(c.id) === lvl);
      const toRun: ConcurrentToolCall[] = [];
      for (const c of callsAtLevel) {
        const myDeps = graph.deps.get(c.id)!;
        let skipDep: CallResult | null = null;
        for (const dep of myDeps) {
          const r = results.get(dep);
          if (r !== undefined && !r.ok) {
            skipDep = r;
            break;
          }
        }
        if (skipDep !== null) {
          results.set(c.id, deepFreeze({
            id: c.id,
            name: c.name,
            ok: false,
            error: `Skipped: dependency '${skipDep.id}' failed (${skipDep.error ?? "unknown"})`,
            durationMs: 0,
            skipped: true,
          }));
        } else {
          toRun.push(c);
        }
      }
      const cpuCalls = toRun.filter((c) => classify(c, config) === "cpu");
      const ioCalls = toRun.filter((c) => classify(c, config) === "io");
      const maxConcurrent = ioChunkSize(config, ioCalls);
      const cpuPromise = Promise.all(cpuCalls.map((c) => runCpuViaPool(c, config.pool!, config)));
      const ioPromise = (async () => {
        const all: CallResult[] = [];
        for (let i = 0; i < ioCalls.length; i += maxConcurrent) {
          const chunk = ioCalls.slice(i, i + maxConcurrent);
          const chunkResults = await Promise.all(chunk.map((c) => runHandler(c, ctx, config)));
          all.push(...chunkResults);
        }
        return all;
      })();
      const [cpuResults, ioResults] = await Promise.all([cpuPromise, ioPromise]);
      for (const r of [...cpuResults, ...ioResults]) results.set(r.id, r);
    }
    return {
      results: batch.map((c) => results.get(c.id)!),
      totalMs: performance.now() - t0,
      levels: graph.levels,
    };
  }

  async function execute(
    batch: readonly ConcurrentToolCall[],
    mode: DispatchMode,
    ctx: HandlerContext,
    config: DispatcherConfig = {},
  ): Promise<DispatchOutcome> {
    if (batch.length === 0) return { results: [], totalMs: 0 };
    switch (mode) {
      case "sequential": return executeSequential(batch, ctx, config);
      case "parallel": return executeParallel(batch, ctx, config);
      case "worker": return executeWorker(batch, ctx, config);
      case "streaming": return executeStreaming(batch, ctx, config);
      case "dependency-aware": return executeDependencyAware(batch, ctx, config);
      default:
        throw new DispatcherError(`unknown dispatch mode '${String(mode)}'`, "dispatcher_unknown_mode");
    }
  }

  return deepFreeze({ execute });
}

const emptySet: ReadonlySet<string> = new Set();

function parseArgs(args: ConcurrentToolCall["args"]): Readonly<Record<string, unknown>> {
  if (typeof args === "string") {
    // R47: route malformed tool-call args through bestEffort so a parse
    // failure is observable instead of
    // silently returning an empty object. `bestEffort` returns undefined
    // only on a thrown error; a successfully-parsed null is preserved.
    const parsed = bestEffort(() => JSON.parse(args) as Readonly<Record<string, unknown>>);
    if (parsed === undefined) return {} as Readonly<Record<string, unknown>>;
    return parsed;
  }
  return args ?? ({} as Readonly<Record<string, unknown>>);
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function truncateResult(result: unknown, maxChars?: number): Readonly<{ truncated: boolean; originalBytes: number; content: string }> {
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch (e) {
    json = `<unserializable: ${errMessage(e)}>`;
  }
  const originalBytes = json.length;
  if (maxChars === undefined || json.length <= maxChars) {
    return { truncated: false, originalBytes, content: json };
  }
  if (result !== null && typeof result === "object" && typeof (result as { content?: unknown }).content === "string") {
    const obj = result as { content: string; [k: string]: unknown };
    const overhead = json.length - obj.content.length;
    const cap = Math.max(DEFAULT_DISPATCHER_MIN_CONTENT_CHARS, maxChars - overhead - DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS);
    const trimmed = { ...obj, content: obj.content.slice(0, cap) + "…[truncated]" };
    const restringified = bestEffort(() => JSON.stringify(trimmed));
    if (restringified !== undefined) json = restringified;
  }
  if (json.length > maxChars) {
    json = json.slice(0, Math.max(0, maxChars - DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS)) + "…[truncated]";
  }
  return { truncated: true, originalBytes, content: json };
}
