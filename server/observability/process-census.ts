/**
 * THE PROCESS CENSUS — the single owner of "what is running on this machine
 * that belongs to this harness".
 *
 * The user directive this module exists for: the debug tooling must give a
 * view of EVERY component of the harness at any given point — process id,
 * what it does, how much it consumes, what started it, the chain. Tracing
 * LLM flows (the ledger dig) answers one lane; this answers the process
 * lane.
 *
 * ── WHAT MOVED HERE, AND WHY ─────────────────────────────────────────────
 *
 * Until the anatomy view existed, the /proc enumeration lived inline in
 * `scripts/sd.mjs` and the argv pattern table in
 * `scripts/sd-stale-classifier.ts`, consumed by exactly one reader (the
 * lifecycle script's stale reconciliation). The anatomy view needs the
 * SAME enumeration, the SAME patterns, the SAME pidfile read — so they
 * moved here, once, and every consumer (sd.mjs's stale reconciliation,
 * `scripts/trace.ts anatomy`, the `observability.anatomy` block read)
 * imports THIS module. sd-stale-classifier.ts re-exports the pattern table
 * + matcher so its existing imports keep resolving; the PURE stale VERDICT
 * (`classifyStaleProcess`) stays there, beside its owning test.
 *
 * ── THE SAFETY GATE, UNCHANGED IN STRENGTH ────────────────────────────────
 *
 * This machine hosts other node work (editors, language servers, other
 * repositories, other agents' MCP servers out of the shared `~/.npm/_npx`
 * cache — measured live: chrome-devtools-mcp watchdogs run beside this
 * tree). The CENSUS is read-only, so it may LOOK at anything; the STALE
 * KILL path in sd.mjs may only ever signal a process whose /proc/<pid>/cwd
 * IS this repository AND whose argv matches a SERVER-TREE spec. The census
 * body reads cwd BEFORE the pattern check, and sd.mjs's candidate filter
 * re-applies `cwd === repoRoot` on top of the scope — both orderings are
 * pinned by the owning test (`tests/prevention/sd-stale-reconciliation
 * .test.ts`).
 *
 * ── THE TWO PATTERN SCOPES ────────────────────────────────────────────────
 *
 * SERVER_TREE_ARGV_SPECS is the KILL scope: argv shapes this repo's own
 * server tree starts (measured live: dev-all, api, vite + esbuild, the
 * stdio MCP children the api server starts per the harness config — the
 * fixture AND the npx filesystem chain — and the intelligence farm children
 * the map workers fork). A new child shape belongs there only when this
 * repo's own tree starts it.
 *
 * HARNESS_TOOL_ARGV_SPECS is DISPLAY-ONLY: harness tools an OPERATOR runs
 * from this repository (the trace CLI). They are labelled in the census so
 * the anatomy view is honest about what it sees, and they are NEVER stale-
 * kill candidates — `argvMatchesServerTree` does not consult them, so an
 * operator's live `node scripts/trace.ts …` command can never be signalled
 * by the lifecycle script however long it runs.
 *
 * Everything with this repository as cwd that no pattern claims is labelled
 * an unrelated bystander and left alone.
 *
 * ── LINUX-ONLY, DELIBERATELY ──────────────────────────────────────────────
 *
 * The walk reads /proc directly (stat, status, cmdline, cwd, uptime) — the
 * same interface the stale reconciliation already depends on. Userspace
 * view of the kernel clock tick (sysconf(_SC_CLK_TCK)) is 100 on linux; the
 * tick math here states that assumption where it converts.
 */

import { readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Text reads go through the single file-read owner (the encoding is decided
// once, there — never re-declared at each /proc call site).
import { readFileText } from "../filesystem/file-read.ts";
import { allProcessIds, bootWallTimeMs, CLOCK_TICK_MS, commandLineOf, isProcessIdentityLive, parseProcessIdentityRecord, residentBytesOf, startWallTimeMs, statFactsOf, workingDirectoryOf, type ProcessIdentity, type StatFacts as ProcessStatFacts } from "../../engine/src/process/process-facts.ts";

// ── The argv pattern tables (the pattern owner) ────────────────────────────

/**
 * The argv shapes of processes this repo's own server tree starts — DERIVED
 * from what the tree actually spawns (measured live, not invented):
 *   - `vite` — the web child dev-all.ts spawns: the `npm exec vite`
 *     wrapper (npm REWRITES its own argv[0] to the display title
 *     `npm exec vite` — measured live, the classic node argv-title trick),
 *     the `sh -c "vite"` child (the quoted command string, quotes included),
 *     the bare `vite` argv of a direct invocation, this repo's
 *     `node_modules/.bin/vite` + `node_modules/vite/` paths, and vite's
 *     esbuild service children under `node_modules/@esbuild/`.
 *   - `engine/test/mcp/fixtures/fake-mcp-server.mjs` — the stdio MCP child
 *     the api server starts per the harness config's tools.mcpServers.
 *   - `engine/src/intelligence/farm-child.ts` — the crash-isolated parse
 *     children the repository-map WORKERS fork (children of this server
 *     process; an orphaned one is a leak from a previous tree).
 *   - the npx filesystem MCP chain the api server starts per the harness
 *     config — the `npm exec @modelcontextprotocol/server-filesystem .`
 *     wrapper (title-rewritten argv[0], matched EXACTLY so a same-stem
 *     bystander package can never be claimed), the
 *     `sh -c "mcp-server-filesystem"` child, and node running the package
 *     out of the shared `~/.npm/_npx` cache. The npx-cache kind is
 *     value-scoped (`mcp-server-filesystem`), so the OTHER agents'
 *     npx-cached MCP servers on this box (measured: chrome-devtools-mcp
 *     watchdogs) never match.
 * A new child shape belongs here only when this repo's own server tree
 * starts it.
 */
export const SERVER_TREE_ARGV_SPECS: readonly ArgvSpec[] = Object.freeze([
  Object.freeze({ label: "dev-all orchestrator", kind: "suffix", value: "scripts/dev-all.ts" }),
  Object.freeze({ label: "api server", kind: "suffix", value: "server/index.ts" }),
  Object.freeze({ label: "vite (bare argv — direct)", kind: "exact", value: "vite" }),
  Object.freeze({ label: "vite (npm exec wrapper title)", kind: "exact", value: "npm exec vite" }),
  Object.freeze({ label: "vite (sh -c wrapper)", kind: "exact", value: "\"vite\"" }),
  Object.freeze({ label: "vite (bin)", kind: "suffix", value: "/node_modules/.bin/vite" }),
  Object.freeze({ label: "vite (repo modules)", kind: "repo-modules", value: "vite/" }),
  Object.freeze({ label: "esbuild service (repo modules)", kind: "repo-modules", value: "@esbuild/" }),
  Object.freeze({ label: "mcp stdio fixture", kind: "suffix", value: "engine/test/mcp/fixtures/fake-mcp-server.mjs" }),
  Object.freeze({ label: "intelligence farm child", kind: "suffix", value: "engine/src/intelligence/farm-child.ts" }),
  Object.freeze({ label: "mcp filesystem (npm exec wrapper)", kind: "exact", value: "npm exec @modelcontextprotocol/server-filesystem ." }),
  // The sh wrapper's -c command string arrives as ONE element, quotes and
  // trailing args included (measured live: `"mcp-server-filesystem" .`) —
  // unlike vite's clean `"vite"` — so this spec is prefix-shaped.
  Object.freeze({ label: "mcp filesystem (sh wrapper)", kind: "title-prefix", value: "\"mcp-server-filesystem\"" }),
  Object.freeze({ label: "mcp filesystem (bare argv)", kind: "exact", value: "mcp-server-filesystem" }),
  Object.freeze({ label: "mcp filesystem (npx cache child)", kind: "npx-suffix", value: "mcp-server-filesystem" }),
]);

/**
 * DISPLAY-ONLY argv shapes: harness tools an OPERATOR runs from this
 * repository. Labelled by the census, never consulted by the stale verdict
 * (`argvMatchesServerTree` reads only SERVER_TREE_ARGV_SPECS), so a live
 * operator command is never a kill candidate.
 */
export const HARNESS_TOOL_ARGV_SPECS: readonly ArgvSpec[] = Object.freeze([
  Object.freeze({ label: "trace CLI", kind: "suffix", value: "scripts/trace.ts" }),
]);

/** Does one argv element match one spec? Pure. */
function specElementMatches(
  spec: ArgvSpec,
  element: string,
  repoRoot: string,
): boolean {
  if (spec.kind === "exact" && element === spec.value) return true;
  // npm rewrites its wrapper's argv[0] to a display TITLE ("npm exec vite")
  // and a shell -c command string can arrive as ONE element with further
  // args baked in (measured: `"mcp-server-filesystem" .`). The
  // title-prefix kind matches an element that starts with the spec's
  // value INCLUDING its closing delimiter (quote), so a longer same-stem
  // name (`"mcp-server-filesystem-evil"`, a hypothetical package
  // `npm exec @modelcontextprotocol/server-filesystem-extra`) can never
  // match — and the cwd gate (the kill path's safety floor) still decides
  // candidacy, never the title alone.
  if (spec.kind === "title-prefix" && element.startsWith(spec.value)) return true;
  if (spec.kind === "repo-modules" && element.startsWith(`${repoRoot}/node_modules/${spec.value}`)) return true;
  if (spec.kind === "npx-suffix") {
    // The shared npx cache (`~/.npm/_npx/<hash>/…`) is machine-global, NOT
    // repo-anchored, so this kind matches on the cache marker PLUS the
    // spec's own value — a different package in the same cache (measured:
    // chrome-devtools-mcp) never matches.
    return element.includes("/.npm/_npx/") && (element === spec.value || element.endsWith(`/${spec.value}`));
  }
  if (spec.kind === "suffix") {
    const needle = spec.value.startsWith("/") ? spec.value : `/${spec.value}`;
    if (element === spec.value) return true;
    if (!element.endsWith(needle)) return false;
    // Absolute elements are repo-anchored: another tree's absolute path
    // is not this repo's server, whatever the file is named.
    if (element.startsWith("/")) return element.startsWith(`${repoRoot}/`);
    return true;
  }
  return false;
}

/** The argv spec kinds — one named union, owned here. */
type ArgvSpecKind = "exact" | "suffix" | "repo-modules" | "npx-suffix" | "title-prefix";
type ArgvSpec = Readonly<{ label: string; kind: ArgvSpecKind; value: string }>;

/** The first spec table entry one argv matches, or null. Pure. */
function matchSpecTable(
  argv: readonly unknown[],
  repoRoot: string,
  specs: readonly ArgvSpec[],
): string | null {
  for (const spec of specs) {
    for (const element of argv) {
      if (typeof element !== "string" || element.length === 0) continue;
      if (specElementMatches(spec, element, repoRoot)) return spec.label;
    }
  }
  return null;
}

/**
 * Does one candidate argv match a SERVER-TREE spec? Pure. THE KILL-SCOPE
 * matcher — sd.mjs's stale reconciliation consults exactly this (and only
 * after the cwd gate). Same semantics the classifier always had: `suffix`
 * specs match repo-relative equality/suffix, absolute elements only inside
 * this repository; `exact` matches the bare argv element; `repo-modules`
 * matches under this repo's node_modules.
 */
export function argvMatchesServerTree(
  argv: readonly unknown[],
  repoRoot: string,
): string | null {
  return matchSpecTable(argv, repoRoot, SERVER_TREE_ARGV_SPECS);
}

/** The census classification of one argv: a label + which scope it came
 * from — server-tree (kill-relevant), harness-tool (operator display), or
 * null (bystander). Pure. */
export function classifyArgv(
  argv: readonly unknown[],
  repoRoot: string,
): Readonly<{ label: string; scope: "server-tree" | "harness-tool" }> | null {
  const serverTree = matchSpecTable(argv, repoRoot, SERVER_TREE_ARGV_SPECS);
  if (serverTree !== null) return { label: serverTree, scope: "server-tree" };
  const tool = matchSpecTable(argv, repoRoot, HARNESS_TOOL_ARGV_SPECS);
  if (tool !== null) return { label: tool, scope: "harness-tool" };
  return null;
}

// ── Live pidfile read (moved here from sd-stale-classifier: a live /proc
// walk belongs with the enumeration owner; the pure verdicts stay there) ────

/**
 * One pidfile entry's process, or null when the entry cannot name one — the
 * file is unreadable (it vanished between the directory read and this read)
 * or is not a process-identity record (a bare pid names no process: a
 * recycled pid is another one). Absence is OBSERVABLE (null): an entry that
 * cannot name a live process names nothing.
 */
function pidfileIdentityOf(path: string): ProcessIdentity | null {
  try {
    return parseProcessIdentityRecord(readFileText(path)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Live pids named by `<pidDir>/*.pid` (dead, recycled or malformed entries
 * are dropped — a pidfile whose process no longer runs names nothing).
 */
export function livePidfilePids(pidDir: string): readonly number[] {
  const out = new Set<number>();
  let files: readonly string[];
  try { files = readdirSync(pidDir); } catch { return [...out]; }
  for (const file of files) {
    if (!file.endsWith(".pid")) continue;
    const identity = pidfileIdentityOf(join(pidDir, file));
    if (identity !== null && identity.pid > 1 && isProcessIdentityLive(identity)) out.add(identity.pid);
  }
  return [...out];
}

// ── The census ─────────────────────────────────────────────────────────────

/** One hop of a process's ancestor chain. */
export type CensusChainHop = Readonly<{ readonly pid: number; readonly name: string }>;

/** How a census process relates to the live server tree. */
export type CensusProvenance = Readonly<{
  readonly kind: "pidfile-owned" | "descendant-of-server" | "orphaned" | "outside-tree";
  readonly detail: string;
}>;

/** What a census process is, per the pattern owner. */
export type CensusClassification = Readonly<{
  readonly label: string;
  readonly scope: "server-tree" | "harness-tool" | "bystander";
}>;

/** The sampled CPU cost of one process, two reads `sampleMs` apart. */
export type CensusCpuSample = Readonly<{
  readonly sampleMs: number;
  /** utime+stime delta across the sample window, in ms. */
  readonly cpuMs: number;
  /** The delta expressed per second of wall time (ms of CPU per second). */
  readonly cpuMsPerSecond: number;
}>;

/** One process in the census. */
export type CensusProcess = Readonly<{
  readonly pid: number;
  readonly ppid: number | null;
  /** The ancestor chain, nearest first, walked toward init (bounded). */
  readonly chain: readonly CensusChainHop[];
  /** Start time: field 22 of /proc/<pid>/stat, boot-relative ticks. */
  readonly startedAtBootTicks: number | null;
  /** Start time as wall-clock ISO (derived from /proc/uptime + starttime). */
  readonly startedAtWallIso: string | null;
  readonly cwd: string | null;
  readonly argv: readonly string[];
  readonly cmdline: string;
  readonly classification: CensusClassification;
  readonly provenance: CensusProvenance;
  readonly cpu: CensusCpuSample | null;
  readonly rssBytes: number | null;
}>;

/** Facts read once from procfs `stat` for every visible pid (the one owner: engine process-facts). */
type StatFacts = ProcessStatFacts;

/** Chain + ancestor-walk bound — deeper than any real process tree. */
const CHAIN_HOP_BOUND = 64;
/** How many chain hops the text view prints before the "… (N hops)" tail —
 * a DISPLAY bound owned beside the walk it renders, not a tunable. */
const CHAIN_DISPLAY_HOPS = 6;
/** The default CPU sample window (two reads this far apart). */
const DEFAULT_CPU_SAMPLE_MS = 500;

// Every procfs read goes through the ONE owner
// (engine/src/process/process-facts.ts), called by its own names: its stat
// parser splits after the LAST ")", so a process name holding spaces or
// parentheses cannot shift a field; its tick length and boot clock are the
// one answer (this module once kept its own copies of all three). Absence is
// `undefined` inside; the wire shape below states it as `null`.

/** The ancestor chain of `pid`, nearest first, toward init, bounded. Pure
 * over the facts map (which a test can hand it synthetically). */
export function censusChainOf(
  pid: number,
  factsOf: (p: number) => StatFacts | undefined,
): readonly CensusChainHop[] {
  const chain: CensusChainHop[] = [];
  let cursor = pid;
  for (let hops = 0; hops < CHAIN_HOP_BOUND; hops += 1) {
    const facts = factsOf(cursor);
    if (facts === undefined || facts.ppid <= 1) break;
    const parent = factsOf(facts.ppid);
    if (parent === undefined) break;
    chain.push(Object.freeze({ pid: facts.ppid, name: parent.name }));
    cursor = facts.ppid;
  }
  return Object.freeze(chain);
}

/** The provenance verdict for one census process. Pure. */
export function censusProvenanceOf(
  pid: number,
  chain: readonly CensusChainHop[],
  classification: CensusClassification,
  pidfilePids: readonly number[],
): CensusProvenance {
  const owned = new Set<number>(pidfilePids);
  if (owned.has(pid)) {
    return Object.freeze({ kind: "pidfile-owned", detail: "a live .dev pidfile names this pid" });
  }
  const ownedAncestor = chain.find((hop) => owned.has(hop.pid));
  if (ownedAncestor !== undefined) {
    return Object.freeze({
      kind: "descendant-of-server",
      detail: `descendant of pidfile-owned pid ${ownedAncestor.pid} (${ownedAncestor.name})`,
    });
  }
  if (classification.scope === "server-tree") {
    return Object.freeze({
      kind: "orphaned",
      detail: "server-tree argv shape with no pidfile ancestor — the previous-tree leak class",
    });
  }
  if (classification.scope === "harness-tool") {
    return Object.freeze({
      kind: "outside-tree",
      detail: "operator-run harness tool, not part of the server tree",
    });
  }
  return Object.freeze({
    kind: "outside-tree",
    detail: "this repository is its cwd but no harness pattern claims it",
  });
}

/**
 * The process census: every visible process that either runs with this
 * repository as cwd OR matches a harness argv pattern (so known children
 * appear even when their cwd differs), each with pid, parent chain to
 * init, start time, cmdline, classification, provenance, sampled CPU and
 * RSS. Read-only — the census never signals anything.
 *
 * `cpuSampleMs` (default 500) is the gap between the two CPU reads; `0`
 * skips sampling entirely (the stale-reconciliation caller does not need
 * it and must stay fast).
 */
export async function censusProcesses(
  repoRoot: string,
  options: Readonly<{ cpuSampleMs?: number }> = {},
): Promise<readonly CensusProcess[]> {
  const cpuSampleMs = options.cpuSampleMs ?? DEFAULT_CPU_SAMPLE_MS;
  const entries = allProcessIds();

  // Pass 1 — facts for every visible pid (the chain + provenance walks
  // need ancestors that are NOT census candidates: systemd-run, the user
  // manager, init). THE SAFETY ORDER: cwd is read BEFORE the pattern check.
  const stats = new Map<number, StatFacts>();
  const raw = new Map<number, Readonly<{ cwd: string | null; argv: readonly string[] | null }>>();
  for (const pid of entries) {
    const facts = statFactsOf(pid);
    if (facts === undefined) continue;
    stats.set(pid, facts);
    const argv = commandLineOf(pid);
    raw.set(pid, { cwd: workingDirectoryOf(pid) ?? null, argv: argv === undefined || argv.length === 0 ? null : argv });
  }

  const classify = (argv: readonly string[] | null): CensusClassification => {
    if (argv !== null) {
      const matched = classifyArgv(argv, repoRoot);
      if (matched !== null) return Object.freeze({ label: matched.label, scope: matched.scope });
    }
    return Object.freeze({ label: "unrelated-bystander", scope: "bystander" });
  };

  // Candidates: cwd IS this repo, OR a harness pattern claims the argv
  // (known children with a different cwd — the npx-cached MCP servers).
  const candidates: Readonly<{
    pid: number;
    cwd: string | null;
    argv: readonly string[];
    classification: CensusClassification;
    rssBytes: number | null;
    cpuTicksAtFirstRead: number;
  }>[] = [];
  for (const [pid, { cwd, argv }] of raw) {
    if (cwd !== repoRoot && classifyArgv(argv ?? [], repoRoot) === null) continue;
    const facts = stats.get(pid)!;
    candidates.push(Object.freeze({
      pid,
      cwd,
      argv: argv ?? [],
      classification: classify(argv),
      rssBytes: residentBytesOf(pid) ?? null,
      cpuTicksAtFirstRead: facts.utimeTicks + facts.stimeTicks,
    }));
  }

  // The CPU sample: a second read of utime+stime, `cpuSampleMs` later.
  let cpuAtSecondRead: Map<number, number> | undefined;
  if (cpuSampleMs > 0 && candidates.length > 0) {
    await new Promise((r) => setTimeout(r, cpuSampleMs));
    cpuAtSecondRead = new Map<number, number>();
    for (const candidate of candidates) {
      const facts = statFactsOf(candidate.pid);
      if (facts !== undefined) cpuAtSecondRead.set(candidate.pid, facts.utimeTicks + facts.stimeTicks);
    }
  }

  const boot = bootWallTimeMs();
  const pidfilePids = livePidfilePids(join(repoRoot, ".dev"));
  const factsOf = (pid: number): StatFacts | undefined => stats.get(pid);

  const out: CensusProcess[] = candidates.map((candidate) => {
    const facts = stats.get(candidate.pid)!;
    const chain = censusChainOf(candidate.pid, factsOf);
    const cpu: CensusCpuSample | null = (() => {
      if (cpuSampleMs <= 0 || cpuAtSecondRead === undefined) return null;
      const second = cpuAtSecondRead.get(candidate.pid);
      if (second === undefined) return null; // died mid-sample — no number, not zero
      const deltaTicks = Math.max(0, second - candidate.cpuTicksAtFirstRead);
      const cpuMs = deltaTicks * CLOCK_TICK_MS;
      return Object.freeze({
        sampleMs: cpuSampleMs,
        cpuMs,
        cpuMsPerSecond: cpuSampleMs > 0 ? (cpuMs * 1000) / cpuSampleMs : 0,
      });
    })();
    const startedAtMs = startWallTimeMs(facts.starttimeTicks, boot);
    const startedAtWallIso = startedAtMs === undefined ? null : new Date(startedAtMs).toISOString();
    return Object.freeze({
      pid: candidate.pid,
      ppid: Number.isFinite(facts.ppid) ? facts.ppid : null,
      chain,
      startedAtBootTicks: facts.starttimeTicks,
      startedAtWallIso,
      cwd: candidate.cwd,
      argv: candidate.argv,
      cmdline: candidate.argv.join(" "),
      classification: candidate.classification,
      provenance: censusProvenanceOf(candidate.pid, chain, candidate.classification, pidfilePids),
      cpu,
      rssBytes: candidate.rssBytes,
    });
  });
  return out.sort((a, b) => a.pid - b.pid);
}

/**
 * This module's repository root, derived from its own location — the
 * server-side default the anatomy block's read handler passes (the server
 * may be started from any cwd; the census's cwd gate must compare against
 * the REAL root).
 */
export function censusRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// ── Formatting (the CLI + the block read print the SAME shapes) ────────

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function formatAgeFromIso(iso: string | null): string {
  if (iso === null) return "—";
  const startedAt = Date.parse(iso);
  if (!Number.isFinite(startedAt)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formatCpu(process: CensusProcess): string {
  if (process.cpu === null) return "—";
  return `${process.cpu.cpuMsPerSecond.toFixed(1)}ms/s`;
}

function formatChain(chain: readonly CensusChainHop[]): string {
  if (chain.length === 0) return "(at init)";
  const hops = chain.map((hop) => `${hop.name}(${hop.pid})`);
  return hops.slice(0, CHAIN_DISPLAY_HOPS).join(" ← ") + (hops.length > CHAIN_DISPLAY_HOPS ? ` ← … (${hops.length} hops)` : "");
}

/**
 * The anatomy view's process half as text. One line per process: pid, ppid,
 * what it is, how it relates to the live tree, the sampled CPU, RSS, age,
 * and the ancestor chain to init.
 */
export function formatCensusText(processes: readonly CensusProcess[]): string {
  const inTree = processes.filter((p) => p.provenance.kind !== "outside-tree" || p.classification.scope === "server-tree").length;
  const lines: string[] = [];
  lines.push(`process census — ${processes.length} process(es), ${inTree} in the server tree`);
  for (const p of processes) {
    const started = p.startedAtWallIso !== null ? p.startedAtWallIso.slice(11, 19) : "—";
    lines.push(
      `  pid ${String(p.pid).padEnd(8)} ppid ${String(p.ppid ?? "—").padEnd(8)} ` +
      `${p.classification.label.padEnd(42)} ${p.provenance.kind.padEnd(20)} ` +
      `cpu ${formatCpu(p).padStart(9)}  rss ${formatBytes(p.rssBytes).padStart(9)}  ` +
      `up ${formatAgeFromIso(p.startedAtWallIso).padStart(5)}  started ${started}  cwd ${p.cwd ?? "(unreadable)"}`,
    );
    lines.push(`      chain ${formatChain(p.chain)}`);
    lines.push(`      cmd ${p.cmdline}`);
    lines.push(`      why ${p.provenance.kind}: ${p.provenance.detail}`);
  }
  return lines.join("\n");
}

/** The anatomy view's process half as JSON (the block read's data shape). */
export function formatCensusJson(processes: readonly CensusProcess[]): string {
  return JSON.stringify({ processes }, null, 2);
}
