/**
 * The CPU time a test run actually consumed — the run's WORK, as opposed to
 * the run's DURATION.
 *
 * ── WHY THIS NUMBER HAD TO EXIST ─────────────────────────────────────────
 *
 * The suite's wall clock was being judged against an absolute cap, and the
 * cap sat inside the run-to-run noise band. The obvious repair — divide the
 * wall clock by the recorded ambient load — was measured and REJECTED, and
 * the measurement is worth keeping because it is counter-intuitive:
 *
 *   - `load1PerCpuAtStart` is `loadavg()[0]`, a one-minute EXPONENTIALLY
 *     DECAYING average sampled before the run starts. Immediately after a
 *     previous suite run it is dominated by that run's ghost — cores that are
 *     now completely free. Measured here: a run whose recorded load was
 *     **0.598/cpu** finished in **35.6s** on an idle box, while a run whose
 *     recorded load was **0.678/cpu** — eight genuine CPU burners, running
 *     throughout — took **60.5s**. Two nearly equal recorded loads, a 70%
 *     difference in outcome. **The recorded load cannot separate them**, which
 *     is exactly why the historical failures showed no correlation with it.
 *   - Per-file wall-clock occupancy does not help either: under those same
 *     eight burners it moved **724 → 1240 ms/file (+71%)**, tracking the wall
 *     clock almost exactly. Occupancy is wall time, so it inherits every
 *     contention effect the wall clock has.
 *
 * CPU time does not — under MILD contention. Contention makes a runnable
 * process WAIT for a core; it does not make it execute more instructions. So
 * under mild contention the same tree does the same work whoever else is on
 * the machine, and a budget on that work is a budget on the suite rather
 * than on the box it happened to run on. The invariance does not survive
 * saturation — cache thrashing, memory-bandwidth contention and scheduling
 * pressure add real work to the same instructions — which is why the
 * verdict that consumes this number defers a saturated box as provisional
 * instead of judging it (see `budget-verdict.ts`, the owner of that model).
 *
 * ── HOW IT IS READ, AND WHY THERE IS NO CLOCK-TICK CONSTANT ──────────────
 *
 * `/proc/self/stat` carries `utime`/`stime` (this process) and
 * `cutime`/`cstime` (every child it has REAPED) — and a vitest run spends
 * almost all of its CPU in pool workers, which are children. Those four
 * fields are in kernel clock ticks, and the tick rate is a build-time
 * constant of the kernel that node exposes nowhere.
 *
 * Rather than hardcode 100 and be wrong on a kernel built differently, the
 * rate is DERIVED from the process's own two clocks: `process.cpuUsage()`
 * reports this process's CPU in microseconds, and `utime + stime` reports the
 * same quantity in ticks. Their ratio is the tick length, measured on the
 * machine that is running, and it cancels out of the answer entirely:
 *
 *     childCpuMs = (cutime + cstime) * (selfCpuMs / (utime + stime))
 *
 * No constant, nothing to keep in step with a kernel. When the denominator is
 * zero — a process that has consumed no measurable CPU, or a platform with no
 * `/proc` — the answer is ABSENT, never a zero: zero CPU is a claim that the
 * run did no work, and a budget that believes it would pass a suite that
 * never ran.
 *
 * The parse deliberately starts after the LAST `)` in the line: field 2 is the
 * executable name in parentheses and may itself contain spaces and
 * parentheses, so splitting the whole line on whitespace mis-indexes every
 * field after it. That is the standard trap in reading this file, and it is
 * the same one `scripts/run-tests.ts` avoids by shelling out to `ps`.
 */
import { parseStatLine, procfsDocument, STAT_FIELD } from "../process/process-facts.ts";

/** The first field number that follows the parenthesised executable name (`proc(5)`, 1-based). */
const FIRST_FIELD_AFTER_COMM = 3;

export interface RunCpu {
  /** CPU consumed by this process and every child it has reaped, in ms. */
  readonly totalCpuMs: number;
  /** The child half alone, in ms — where a vitest run does its work. */
  readonly childCpuMs: number;
}

/** One `/proc/self/stat` field, in clock ticks, or null when unreadable. */
function statTicks(afterComm: readonly string[], field: number): number | null {
  const raw = afterComm[field - FIRST_FIELD_AFTER_COMM];
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The run's CPU cost, or null when it cannot be measured honestly.
 *
 * Null is a real answer here and the caller must carry it as absence: a
 * budget with no CPU measurement behind it must refuse to judge rather than
 * judge a zero.
 */
export function readRunCpu(
  readStat: () => string | undefined = () => procfsDocument("self", "stat"),
  selfCpuUsage: () => { user: number; system: number } = () => process.cpuUsage(),
): RunCpu | null {
  const line = readStat();
  if (line === undefined) return null; // No procfs — not a Linux box. Absence, not zero.
  // Parsed by the one stat-line owner (after the LAST `)`: the executable's
  // name is field 2 and may hold spaces and parentheses).
  const afterComm = parseStatLine(line);
  if (afterComm === undefined) return null;

  const utime = statTicks(afterComm, STAT_FIELD.utime);
  const stime = statTicks(afterComm, STAT_FIELD.stime);
  const cutime = statTicks(afterComm, STAT_FIELD.cutime);
  const cstime = statTicks(afterComm, STAT_FIELD.cstime);
  if (utime === null || stime === null || cutime === null || cstime === null) return null;

  const selfTicks = utime + stime;
  if (selfTicks <= 0) return null; // Nothing to calibrate the tick length with.

  const usage = selfCpuUsage();
  const selfCpuMs = (usage.user + usage.system) / 1000;
  if (!Number.isFinite(selfCpuMs) || selfCpuMs <= 0) return null;

  // Tick length measured on this machine, from this process's own two clocks.
  const msPerTick = selfCpuMs / selfTicks;
  const childCpuMs = (cutime + cstime) * msPerTick;
  const totalCpuMs = selfCpuMs + childCpuMs;
  if (!Number.isFinite(childCpuMs) || !Number.isFinite(totalCpuMs)) return null;
  return { totalCpuMs: Math.round(totalCpuMs), childCpuMs: Math.round(childCpuMs) };
}
