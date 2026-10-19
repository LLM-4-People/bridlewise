import { readFileSync } from "node:fs";
import { cpus, loadavg, totalmem, freemem } from "node:os";
import { performance } from "node:perf_hooks";

import { InputError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import { DIAGNOSTIC_MODE_IDS } from "./performance-config.ts";
import type { PerformanceConfig, DiagnosticModeId } from "./performance-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { procfsPath } from "../process/process-facts.ts";
// The unit conversions the CPU and uptime snapshots perform — one shared
// owner each, never a bare 1000 beside the reading.
import { MS_PER_SECOND, MICROSECONDS_PER_MILLISECOND } from "../../../shared/constants.ts";

/**
 * Isolated diagnostic modes for performance and resource observability.
 *
 * Each mode (CPU, memory/allocation, I/O, event-loop, process/worker, cgroup)
 * is separately enabled, bounded by timeout and budget, and never runs in
 * the always-on path. Honest attribution is exact only for isolated task,
 * worker, process, or cgroup scopes; shared or estimated under concurrency.
 *
 * No raw credentials, PII, prompts, file contents, or unbounded labels.
 */

export const DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION =
  schemaId("diagnostic-snapshot", 1);

export type CpuDiagnosticSnapshot = Readonly<{
  mode: "cpu";
  processUserMs: number;
  processSystemMs: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cpuCount: number;
  model: string;
  speedMhz: number;
  attribution: "exact" | "shared" | "estimated";
}>;

export type MemoryDiagnosticSnapshot = Readonly<{
  mode: "memory";
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBufferBytes: number;
  totalSystemBytes: number;
  freeSystemBytes: number;
  attribution: "exact";
}>;

export type IoDiagnosticSnapshot = Readonly<{
  mode: "io";
  readOps: number;
  writeOps: number;
  bytesRead: number;
  bytesWritten: number;
  attribution: "exact" | "estimated";
}>;

export type EventLoopDiagnosticSnapshot = Readonly<{
  mode: "event-loop";
  idle: number;
  active: number;
  utilization: number;
  maxListeners: number;
  attribution: "exact";
}>;

export type ProcessDiagnosticSnapshot = Readonly<{
  mode: "process";
  pid: number;
  ppid: number;
  uptimeMs: number;
  threadCount: number;
  attribution: "exact";
}>;

export type CgroupDiagnosticSnapshot = Readonly<{
  mode: "cgroup";
  cgroupVersion: number;
  cpuUsageUsec: number;
  cpuUserUsec: number;
  cpuSystemUsec: number;
  memoryCurrentBytes: number;
  memoryMaxBytes: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  available: boolean;
  attribution: "exact" | "estimated";
}>;

export type DiagnosticSnapshot =
  | CpuDiagnosticSnapshot
  | MemoryDiagnosticSnapshot
  | IoDiagnosticSnapshot
  | EventLoopDiagnosticSnapshot
  | ProcessDiagnosticSnapshot
  | CgroupDiagnosticSnapshot;

export type DiagnosticRunResult = Readonly<{
  runId: string;
  mode: DiagnosticModeId;
  wallTime: string;
  durationMs: number;
  snapshot: DiagnosticSnapshot;
  timedOut: boolean;
  configHash: string;
}>;

export type DiagnosticRunnerOptions = Readonly<{
  config: PerformanceConfig;
  clock?: () => number;
  readCgroupFile?: (path: string) => string | undefined;
}>;

export type DiagnosticRunner = Readonly<{
  run(mode: DiagnosticModeId, signal?: AbortSignal): DiagnosticRunResult;
  runAll(signal?: AbortSignal): readonly DiagnosticRunResult[];
  supportedModes(): readonly DiagnosticModeId[];
}>;

export function createDiagnosticRunner(options: DiagnosticRunnerOptions): DiagnosticRunner {
  const config = options.config;
  const clock = options.clock ?? (() => performance.now());
  const readCgroupFile = options.readCgroupFile ?? defaultReadCgroupFile;
  const modeTimeoutMs = config.diagnosticModes.modeTimeoutMs;
  // All declared modes are on unless the config EXCLUDES them — there is no
  // enable-list a new mode could be forgotten out of. The enabled set is
  // DERIVED from the declared vocabulary, so a mode added to
  // DIAGNOSTIC_MODE_IDS runs the day it is declared.
  const excludedModes = new Set(config.diagnosticModes.excludedModes);
  const enabledModes = new Set(DIAGNOSTIC_MODE_IDS.filter((m) => !excludedModes.has(m)));

  function runMode(mode: DiagnosticModeId, signal?: AbortSignal): DiagnosticRunResult {
    if (!enabledModes.has(mode)) {
      throw new InputError(
        `Diagnostic mode ${mode} is not enabled`,
        "diagnostic_mode_not_enabled",
      );
    }
    const runId = generateId("diag");
    const startMs = clock();
    let timedOut = false;
    if (signal?.aborted) {
      timedOut = true;
      throw new InputError("Diagnostic mode was aborted before it started", "diagnostic_mode_timeout");
    }
    const snapshot = collectSnapshot(mode, readCgroupFile);
    const durationMs = clock() - startMs;
    // The mode collectors are synchronous, so a wall-clock timer armed beside
    // the collection could never fire mid-collection — the event loop stays
    // held until the collection returns, and the timer was always cleared
    // first. The honest enforcement for a synchronous collector is the
    // after-the-fact comparison: a mode that outlasted its budget is
    // reported as timed out — the report and the command's exit code say
    // so — even though its snapshot completed.
    if (durationMs > modeTimeoutMs) timedOut = true;
    return deepFreeze({
      runId,
      mode,
      wallTime: new Date().toISOString(),
      durationMs,
      snapshot,
      timedOut,
      configHash: canonicalHash(config),
    });
  }

  return deepFreeze({
    run: runMode,
    runAll(signal?: AbortSignal) {
      const results: DiagnosticRunResult[] = [];
      for (const mode of enabledModes) {
        if (signal?.aborted) break;
        try {
          results.push(runMode(mode, signal));
        } catch (e) {handleError(e, { module: "performance-diagnostic-modes", operation: "catch" });
          results.push(deepFreeze({
            runId: generateId("diag"),
            mode,
            wallTime: new Date().toISOString(),
            durationMs: 0,
            snapshot: { mode, available: false, attribution: "estimated" } as DiagnosticSnapshot,
            timedOut: true,
            configHash: canonicalHash(config),
          }));
        }
      }
      return results;
    },
    supportedModes() {
      return [...enabledModes];
    },
  });
}

function collectSnapshot(
  mode: DiagnosticModeId,
  readCgroupFile: (path: string) => string | undefined,
): DiagnosticSnapshot {
  switch (mode) {
    case "cpu":
      return collectCpuSnapshot();
    case "memory":
      return collectMemorySnapshot();
    case "io":
      return collectIoSnapshot();
    case "event-loop":
      return collectEventLoopSnapshot();
    case "process":
      return collectProcessSnapshot();
    case "cgroup":
      return collectCgroupSnapshot(readCgroupFile);
  }
}

function collectCpuSnapshot(): CpuDiagnosticSnapshot {
  const cpuUsage = process.cpuUsage();
  const load = loadavg();
  const cpuList = cpus();
  const firstCpu = cpuList[0];
  return deepFreeze({
    mode: "cpu",
    processUserMs: cpuUsage.user / MICROSECONDS_PER_MILLISECOND,
    processSystemMs: cpuUsage.system / MICROSECONDS_PER_MILLISECOND,
    loadAvg1: load[0] ?? 0,
    loadAvg5: load[1] ?? 0,
    loadAvg15: load[2] ?? 0,
    cpuCount: cpuList.length,
    model: firstCpu?.model ?? "unknown",
    speedMhz: firstCpu?.speed ?? 0,
    attribution: "shared",
  });
}

function collectMemorySnapshot(): MemoryDiagnosticSnapshot {
  const mem = process.memoryUsage();
  return deepFreeze({
    mode: "memory",
    rssBytes: mem.rss,
    heapTotalBytes: mem.heapTotal,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
    arrayBufferBytes: mem.arrayBuffers ?? 0,
    totalSystemBytes: totalmem(),
    freeSystemBytes: freemem(),
    attribution: "exact",
  });
}

function collectIoSnapshot(): IoDiagnosticSnapshot {
  const resource = process.resourceUsage() as unknown as Readonly<Record<string, number>>;
  return deepFreeze({
    mode: "io",
    readOps: resource.fsRead ?? 0,
    writeOps: resource.fsWrite ?? 0,
    bytesRead: resource.readBytes ?? 0,
    bytesWritten: resource.writeBytes ?? 0,
    attribution: "exact",
  });
}

function collectEventLoopSnapshot(): EventLoopDiagnosticSnapshot {
  const elu = performance.eventLoopUtilization();
  const idle = elu.idle;
  const active = elu.active;
  const utilization = idle + active > 0 ? active / (idle + active) : 0;
  return deepFreeze({
    mode: "event-loop",
    idle,
    active,
    utilization,
    maxListeners: getMaxListeners(),
    attribution: "exact",
  });
}

function collectProcessSnapshot(): ProcessDiagnosticSnapshot {
  const resource = process.resourceUsage() as unknown as Readonly<Record<string, number>>;
  return deepFreeze({
    mode: "process",
    pid: process.pid,
    ppid: process.ppid,
    uptimeMs: process.uptime() * MS_PER_SECOND,
    threadCount: resource.threads ?? 1,
    attribution: "exact",
  });
}

function collectCgroupSnapshot(
  readCgroupFile: (path: string) => string | undefined,
): CgroupDiagnosticSnapshot {
  const version = detectCgroupVersion(readCgroupFile);
  if (version === 0) {
    return deepFreeze({
      mode: "cgroup",
      cgroupVersion: 0,
      cpuUsageUsec: 0,
      cpuUserUsec: 0,
      cpuSystemUsec: 0,
      memoryCurrentBytes: 0,
      memoryMaxBytes: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      available: false,
      attribution: "estimated",
    });
  }
  const cpuUsageUsec = readCgroupStat(readCgroupFile, version, "cpu.usage", "");
  const cpuUserUsec = readCgroupStat(readCgroupFile, version, "cpu.stat", "user_usec");
  const cpuSystemUsec = readCgroupStat(readCgroupFile, version, "cpu.stat", "system_usec");
  const memCurrent = readCgroupStat(readCgroupFile, version, "memory.current", "");
  const memMax = readCgroupStat(readCgroupFile, version, "memory.max", "");
  const ioRead = readCgroupStat(readCgroupFile, version, "io.stat", "rbytes");
  const ioWrite = readCgroupStat(readCgroupFile, version, "io.stat", "wbytes");
  return deepFreeze({
    mode: "cgroup",
    cgroupVersion: version,
    cpuUsageUsec,
    cpuUserUsec,
    cpuSystemUsec,
    memoryCurrentBytes: memCurrent,
    memoryMaxBytes: memMax === 0 ? 0 : (memMax === Number.MAX_SAFE_INTEGER ? 0 : memMax),
    ioReadBytes: ioRead,
    ioWriteBytes: ioWrite,
    available: true,
    attribution: "exact",
  });
}

function detectCgroupVersion(
  readCgroupFile: (path: string) => string | undefined,
): number {
  const mountinfo = readCgroupFile(procfsPath("self", "mountinfo"));
  if (mountinfo === undefined) return 0;
  if (mountinfo.includes("cgroup2")) return 2;
  if (mountinfo.includes("cgroup")) return 1;
  return 0;
}

function readCgroupStat(
  readCgroupFile: (path: string) => string | undefined,
  version: number,
  statFile: string,
  field: string,
): number {
  if (version === 2) {
    const content = readCgroupFile(`/sys/fs/cgroup/${statFile}`);
    if (content === undefined) return 0;
    if (field === "") {
      const value = Number(content.trim());
      return Number.isFinite(value) ? value : 0;
    }
    for (const line of content.split("\n")) {
      const parts = line.trim().split(/\s+/u);
      const keyIndex = parts.findIndex((p) => p === field || p.startsWith(field + "="));
      if (keyIndex >= 0) {
        const valuePart = parts[keyIndex]!.includes("=")
          ? parts[keyIndex]!.split("=")[1]!
          : parts[keyIndex + 1] ?? "0";
        const value = Number(valuePart);
        return Number.isFinite(value) ? value : 0;
      }
    }
    return 0;
  }
  if (version === 1) {
    const content = readCgroupFile(`/sys/fs/cgroup/cpuacct/${statFile}`);
    if (content === undefined) return 0;
    if (field === "") {
      const value = Number(content.trim());
      return Number.isFinite(value) ? value : 0;
    }
    for (const line of content.split("\n")) {
      const [key, val] = line.trim().split(/\s+/u);
      if (key === field) return Number.isFinite(Number(val)) ? Number(val) : 0;
    }
    return 0;
  }
  return 0;
}

function defaultReadCgroupFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function getMaxListeners(): number {
  try {
    return process.getMaxListeners();
  } catch {
    return 0;
  }
}

export function diagnosticSnapshotSchemaVersion(): string {
  return DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION;
}
