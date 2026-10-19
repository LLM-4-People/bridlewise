#!/usr/bin/env node
/**
 * The trace CLI — dig the timeline ledger + the harness anatomy from a
 * terminal.
 *
 *   node scripts/trace.ts run <runId>    [--event-type <t>] [--failed] [--llm] [--documents] [--since <w>] [--until <w>] [--json]
 *   node scripts/trace.ts trace <traceId> [same flags]
 *   node scripts/trace.ts tail [N]       [same flags] [--all-types] [--follow [ms]]
 *   node scripts/trace.ts runs           [--failed] [--last N] [--chat <chatId> | --session <sessionId>] [--json]
 *   node scripts/trace.ts doctor         [--chat <chatId> | --session <sessionId>] [--json]
 *   node scripts/trace.ts anatomy        [--json]
 *   node scripts/trace.ts --schema
 *
 * A THIN SHELL ONLY: argument parsing, the ledger path, and the exit-code
 * mapping. Every query, aggregation, summary and formatting decision lives
 * in `engine/src/timeline/ledger-dig.ts` (the ledger's read-owner domain,
 * beside the store), and the anatomy half lives in the census +
 * component-registry owners (`server/observability/process-census.ts`,
 * `server/observability/component-registry.ts`), so the tests own the
 * behaviour and this file stays the length of a usage screen. The shell's
 * entry `runTraceCli` returns the exit code instead of taking the process
 * down, so the owning tests pin the mapping the same way the engine CLI's
 * do.
 *
 * THE EXIT-CODE CONTRACT (the caller's first signal, before any output):
 * 0 — an answer was produced, including an honest empty scope (the filters
 * matched nothing inside an existing run/trace/chat/session); 1 — the scope
 * itself is absent (no run/trace/chat/session with that id — a typo, not an
 * empty result) or the arguments are invalid. `doctor`'s "nothing qualifies"
 * is an honest answer and exits 0.
 *
 * ANATOMY, THE HONEST SHAPE: the process census is read live from /proc by
 * the census owner — this CLI can always answer it. The IN-PROCESS component
 * registry lives in the SERVER process, so it is consumed via the
 * authenticated `observability.anatomy` block read (the block is the owner's
 * door; its path is DERIVED from the id through `blockReadPath`, never
 * spelled here); when the server is down or refuses the dev session the CLI
 * says so honestly and prints the census it has, never a fabricated empty
 * registry.
 *
 * WHY A .TS SCRIPT: the tool reads the ledger path from the server's config
 * owner (`server/kernel/config.ts`) and the document vocabulary from
 * `shared/constants.ts` — both TypeScript modules. Node 24 runs .ts directly
 * (type stripping is on by default at this repo's pinned engine), the same
 * way the existing dev tooling under `scripts/` imports .ts probes from
 * `sd.mjs`.
 *
 * Read-only by construction: the reader opens its own `node:sqlite`
 * connection with `readOnly: true` and only SELECTs. Documents print as
 * stored — they were redacted before they were written.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { serverConfig } from "../server/kernel/config.ts";
import { blockReadPath } from "../shared/block-contract.ts";
import { InputError } from "../engine/src/kernel/errors.ts";
import { discardBody, outboundFetch, readBody } from "../engine/src/shared/outbound-http.ts";
import { OPERATOR_OWNER, privateAddressesAllowedFor } from "../engine/src/shared/outbound-policy.ts";
import { deadline } from "../engine/src/shared/abort-signals.ts";
import { ROOT_POLICY } from "../engine/src/kernel/root-policy.ts";

/** The central-log category of the trace CLI's own requests (a configured category: it talks to the router). */
const TRACE_LOG_CATEGORY = "router";
import { CHAT_RUN_IDS_SQL } from "../server/db/client.ts";
import {
  resolveLedgerPath,
  openLedgerReadOnly,
  digLedger,
  digExitVerdict,
  resolveEventTypeFilter,
  resolveWallTimeBound,
  listRuns,
  doctorLedger,
  nextFollowBatch,
  formatDigText,
  formatDigJson,
  formatFollowText,
  formatRunsText,
  formatRunsJson,
  formatDoctorText,
  formatDoctorJson,
  formatSchemaJson,
  TAIL_FOLLOW_POLL_MS,
  FOLLOW_WINDOW_EVENTS,
  type DigFilter,
  type DigScope,
  type DigDocumentView,
} from "../engine/src/timeline/ledger-dig.ts";
import {
  censusProcesses,
  formatCensusText,
  formatCensusJson,
} from "../server/observability/process-census.ts";
import {
  componentSnapshot,
  formatComponentsText,
} from "../server/observability/component-registry.ts";
import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";

const USAGE = `usage:
  node scripts/trace.ts run <runId>      [flags]  every ledger event of one run, in causal order
  node scripts/trace.ts trace <traceId>  [flags]  the same shape, scoped to one HTTP request's trace
  node scripts/trace.ts tail [N]         [flags]  the last N events across all runs (default 20, newest first)
  node scripts/trace.ts runs             [flags]  one line per run: span, outcomes, failures, tokens
  node scripts/trace.ts doctor           [flags]  the newest run with failures, collapsed to one answer
  node scripts/trace.ts anatomy          [--json] the harness anatomy: process census + component registry
  node scripts/trace.ts --schema                  the JSON contract of every command's --json output

flags:
  --event-type <t>   only events of this recorded type (validated against the
                     vocabulary, case-insensitive; e.g. tool, provider, db)
  --failed           only events whose outcome is failed or denied / only runs
                     that contain one
  --llm              print the stored llm-request/llm-response documents and the
                     redacted effect-args, per event (as recorded — already redacted)
  --documents        print every stored document per event
  --since <when>     only events at or after this wall time (ISO-8601 timestamp
                     or relative duration: 2h, 30m, 3d, 1h30m)
  --until <when>     only events at or before this wall time (same grammar)
  --all-types        tail only: include the sampler's resource events the
                     default tail scan excludes
  --follow [ms]      tail only: keep printing new events as the ledger grows,
                     polling every ms (default ${TAIL_FOLLOW_POLL_MS}); runs until
                     interrupted — Ctrl-C exits cleanly with code 0
  --last <N>         runs only: the newest N runs
  --chat <id>        runs/doctor only: the runs of this CHAT — resolved from
                     the web db's messages.run_id into a run-id scope (the
                     ledger holds no chat id; a chat with no recorded run is
                     absent, not empty)
  --session <id>     runs/doctor only: runs recorded under this harness web
                     session id (the ledger's own session_id column — the
                     harness_session cookie). --chat and --session are two
                     different scopes: give one
  --json             machine-readable output instead of the text dump

exit codes:
  0  an answer was produced — including an honest empty scope (filters that
     matched nothing inside an existing run/trace/chat/session)
  1  the scope is absent (no run/trace/chat/session with that id — a typo)
     or the arguments are invalid`;

/** The repo root, from this script's own location — the server's cwd when it
 * resolves its relative ledger path, so the tool works from any cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** An argument-shape error: the usage screen is part of the answer. */
class CliUsageError extends Error {}
/** An absent scope: one honest stderr line, no usage screen — the command
 * was well-formed, the id was wrong. */
class CliAbsentError extends Error {}

function fail(message: string): never {
  throw new CliUsageError(message);
}

// ── Argument parsing (no flags library; the grammar is this small) ─────────

type Parsed =
  | Readonly<{ kind: "dig"; scope: DigScope; followMs: number | null; raw: Readonly<{ eventType?: string; since?: string; until?: string; failedOnly: boolean; allEventTypes: boolean }>; view: DigDocumentView; json: boolean }>
  | Readonly<{ kind: "runs"; chatId?: string; sessionId?: string; failedOnly: boolean; last?: number; json: boolean }>
  | Readonly<{ kind: "doctor"; chatId?: string; sessionId?: string; json: boolean }>
  | Readonly<{ kind: "anatomy"; json: boolean }>
  | Readonly<{ kind: "schema" }>
  | Readonly<{ kind: "help" }>;

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const raw: { eventType?: string; since?: string; until?: string; failedOnly?: boolean; allEventTypes?: boolean } = {};
  const runs: { chatId?: string; sessionId?: string; failedOnly?: boolean; last?: number } = {};
  let view: DigDocumentView = "none";
  let json = false;
  let followMs: number | null = null;
  let schema = false;
  let i = 0;
  const value = (flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`${flag} needs a value`);
    return next;
  };
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--event-type") {
      raw.eventType = value("--event-type");
      i += 2;
    } else if (arg === "--since") {
      raw.since = value("--since");
      i += 2;
    } else if (arg === "--until") {
      raw.until = value("--until");
      i += 2;
    } else if (arg === "--chat") {
      runs.chatId = value("--chat");
      i += 2;
    } else if (arg === "--session") {
      runs.sessionId = value("--session");
      i += 2;
    } else if (arg === "--last") {
      const next = argv[i + 1];
      if (next === undefined || !/^\d+$/u.test(next) || Number(next) < 1) {
        fail(`--last needs a positive whole number, got ${next ?? "nothing"}`);
      }
      runs.last = Number(next);
      i += 2;
    } else if (arg === "--follow") {
      // The interval is optional: a bare --follow keeps the reader's default.
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/u.test(next)) {
        if (Number(next) < 1) fail(`follow interval must be a positive whole number of ms, got ${next}`);
        followMs = Number(next);
        i += 2;
      } else {
        followMs = TAIL_FOLLOW_POLL_MS;
        i += 1;
      }
    } else if (arg === "--failed") {
      raw.failedOnly = true;
      runs.failedOnly = true;
      i += 1;
    } else if (arg === "--all-types") {
      raw.allEventTypes = true;
      i += 1;
    } else if (arg === "--llm") {
      view = "llm";
      i += 1;
    } else if (arg === "--documents") {
      view = "all";
      i += 1;
    } else if (arg === "--json") {
      json = true;
      i += 1;
    } else if (arg === "--schema") {
      schema = true;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    } else if (arg.startsWith("--")) {
      fail(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  if (schema) {
    if (positional.length > 0) fail(`--schema takes no command (got ${positional[0]})`);
    if (raw.eventType !== undefined || raw.since !== undefined || raw.until !== undefined || runs.chatId !== undefined || runs.sessionId !== undefined || runs.last !== undefined) {
      fail(`--schema takes no filters`);
    }
    if (raw.failedOnly === true || raw.allEventTypes === true || followMs !== null || view !== "none") {
      fail(`--schema takes no filters`);
    }
    return { kind: "schema" };
  }

  const command = positional[0];
  if (command === "run" || command === "trace") {
    const id = positional[1];
    if (id === undefined) fail(`${command} needs an id`);
    if (positional.length > 2) fail(`unexpected argument ${positional[2]}`);
    if (raw.allEventTypes === true) fail(`--all-types applies to the tail only (the ${command} replay is complete by design)`);
    if (followMs !== null) fail(`--follow applies to the tail only`);
    if (runs.chatId !== undefined) fail(`--chat applies to runs/doctor only`);
    if (runs.sessionId !== undefined) fail(`--session applies to runs/doctor only`);
    if (runs.last !== undefined) fail(`--last applies to runs only`);
    return {
      kind: "dig",
      scope: { kind: command, id },
      followMs: null,
      raw: {
        ...(raw.eventType !== undefined ? { eventType: raw.eventType } : {}),
        ...(raw.since !== undefined ? { since: raw.since } : {}),
        ...(raw.until !== undefined ? { until: raw.until } : {}),
        failedOnly: raw.failedOnly === true,
        allEventTypes: false,
      },
      view,
      json,
    };
  }
  if (command === "tail") {
    const count = positional[1];
    if (count !== undefined && (!/^\d+$/u.test(count) || Number(count) < 1)) {
      fail(`tail count must be a positive whole number, got ${count}`);
    }
    if (positional.length > 2) fail(`unexpected argument ${positional[2]}`);
    if (runs.chatId !== undefined) fail(`--chat applies to runs/doctor only`);
    if (runs.sessionId !== undefined) fail(`--session applies to runs/doctor only`);
    if (runs.last !== undefined) fail(`--last applies to runs only`);
    return {
      kind: "dig",
      scope: { kind: "tail", limit: count === undefined ? 20 : Number(count) },
      followMs,
      raw: {
        ...(raw.eventType !== undefined ? { eventType: raw.eventType } : {}),
        ...(raw.since !== undefined ? { since: raw.since } : {}),
        ...(raw.until !== undefined ? { until: raw.until } : {}),
        failedOnly: raw.failedOnly === true,
        allEventTypes: raw.allEventTypes === true,
      },
      view,
      json,
    };
  }
  if (command === "runs") {
    if (positional.length > 1) fail(`runs takes no arguments (got ${positional[1]})`);
    if (raw.eventType !== undefined) fail(`runs does not take --event-type (the dig commands do)`);
    if (raw.since !== undefined || raw.until !== undefined) fail(`runs does not take --since/--until (narrow with --chat, --failed, --last)`);
    if (raw.allEventTypes === true) fail(`runs does not take --all-types`);
    if (followMs !== null) fail(`runs does not take --follow`);
    if (view !== "none") fail(`runs does not take --llm/--documents (dig the run it names instead)`);
    if (runs.chatId !== undefined && runs.sessionId !== undefined) {
      fail(`--chat and --session are two different scopes — give one`);
    }
    return {
      kind: "runs",
      ...(runs.chatId !== undefined ? { chatId: runs.chatId } : {}),
      ...(runs.sessionId !== undefined ? { sessionId: runs.sessionId } : {}),
      failedOnly: raw.failedOnly === true,
      ...(runs.last !== undefined ? { last: runs.last } : {}),
      json,
    };
  }
  if (command === "doctor") {
    if (positional.length > 1) fail(`doctor takes no arguments (got ${positional[1]})`);
    if (raw.eventType !== undefined) fail(`doctor does not take --event-type (it already shows the failed events)`);
    if (raw.failedOnly === true) fail(`doctor does not take --failed (it picks the newest run with failures for you)`);
    if (raw.since !== undefined || raw.until !== undefined) fail(`doctor does not take --since/--until`);
    if (raw.allEventTypes === true) fail(`doctor does not take --all-types`);
    if (followMs !== null) fail(`doctor does not take --follow`);
    if (runs.last !== undefined) fail(`doctor does not take --last (it picks one run for you)`);
    if (view !== "none") fail(`doctor does not take --llm/--documents (it already shows the payloads)`);
    if (runs.chatId !== undefined && runs.sessionId !== undefined) {
      fail(`--chat and --session are two different scopes — give one`);
    }
    return {
      kind: "doctor",
      ...(runs.chatId !== undefined ? { chatId: runs.chatId } : {}),
      ...(runs.sessionId !== undefined ? { sessionId: runs.sessionId } : {}),
      json,
    };
  }
  if (command === "anatomy") {
    if (positional.length > 1) fail(`anatomy takes no arguments (got ${positional[1]})`);
    // The dig filters do not apply to the anatomy view; refusing them keeps
    // the grammar honest instead of silently ignoring a mistyped command.
    if (raw.eventType !== undefined) fail(`anatomy does not take --event-type (the dig commands do)`);
    if (raw.failedOnly === true) fail(`anatomy does not take --failed (the dig commands do)`);
    if (raw.since !== undefined || raw.until !== undefined) fail(`anatomy does not take --since/--until (the dig commands do)`);
    if (raw.allEventTypes === true) fail(`anatomy does not take --all-types`);
    if (followMs !== null) fail(`anatomy does not take --follow`);
    if (runs.chatId !== undefined) fail(`anatomy does not take --chat`);
    if (runs.sessionId !== undefined) fail(`anatomy does not take --session`);
    if (runs.last !== undefined) fail(`anatomy does not take --last`);
    if (view !== "none") fail(`anatomy does not take --llm/--documents (the dig commands do)`);
    return { kind: "anatomy", json };
  }
  if (command !== undefined) fail(`unknown command ${command}`);
  fail(`a command is required (run, trace, tail, runs, doctor, anatomy — or --schema)`);
}

// ── The anatomy view (process census live; components via the block) ────

// THE DEV SESSION'S CREDENTIALS COME FROM THE ENVIRONMENT ONLY. A literal
// fallback here was a password committed to a tracked file (and the same
// value the dev server seeds); with no variable set the anatomy block read is
// unavailable, and the reason names the variables to set.
const AUTH_ENV = ["HARNESS_WEB_AUTH_USERNAME", "HARNESS_WEB_AUTH_PASSWORD"] as const;

type BlockComponents = Readonly<{ components: ReturnType<typeof componentSnapshot> } | { unavailable: string }>;

/**
 * Fetch the server's in-process component registry through its owning block
 * read. The port comes from the config owner (the same `serverConfig.port`
 * the server itself bound, so the owner's web-port env override is respected
 * with no duplicate fallback here). Returns `unavailable` with the honest
 * reason when the server is down or refuses the dev session — never a
 * fabricated empty registry.
 */
async function fetchComponentsFromBlock(): Promise<BlockComponents> {
  const [usernameVariable, passwordVariable] = AUTH_ENV;
  const username = process.env[usernameVariable];
  const password = process.env[passwordVariable];
  if (!username || !password) {
    return { unavailable: `the dev session needs ${AUTH_ENV.join(" and ")} in the environment (no default credential is built in)` };
  }
  const base = `http://127.0.0.1:${serverConfig.port}`;
  // Through the one outbound door (no redirect followed — the login carries a
  // password —, a bounded lifetime and body).
  const lifetime = deadline(undefined, ROOT_POLICY.tools.limits.defaultToolTimeoutMs);
  const send = (path: string, method: "GET" | "POST", headers: Readonly<Record<string, string>>, body?: string): Promise<Response> =>
    // The operator's own local server (loopback): a private address by design.
    outboundFetch({ url: `${base}${path}`, method, protocolHeaders: { "X-Requested-With": "trace-cli", ...headers }, body, signal: lifetime.signal, logCategory: TRACE_LOG_CATEGORY, allowPrivateAddress: privateAddressesAllowedFor(OPERATOR_OWNER) });
  try {
    let loginRes: Response;
    try {
      loginRes = await send("/api/auth/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ username, password }));
    } catch {
      return { unavailable: `the server is not running on ${base} (connection refused)` };
    }
    await discardBody(loginRes, TRACE_LOG_CATEGORY, ROOT_POLICY.tools.limits.defaultToolTimeoutMs);
    if (loginRes.status !== 200) {
      return { unavailable: `the dev session was refused (login ${loginRes.status}) — the registry lives in the server process` };
    }
    const cookie = (loginRes.headers.getSetCookie?.() ?? [])
      .find((c: string) => c.startsWith("harness_auth="))
      ?.split(";")[0];
    if (cookie === undefined) {
      return { unavailable: "login succeeded but no session cookie was set" };
    }
    const res = await send(blockReadPath("observability.anatomy"), "GET", { Cookie: cookie });
    if (res.status !== 200) {
      await discardBody(res, TRACE_LOG_CATEGORY, ROOT_POLICY.tools.limits.defaultToolTimeoutMs);
      return { unavailable: `GET ${blockReadPath("observability.anatomy")} answered ${res.status}` };
    }
    const text = await readBody(res, lifetime.signal, ROOT_POLICY.runtime.limits.maximumToolMemoryBytes, ROOT_POLICY.tools.limits.defaultToolTimeoutMs, TRACE_LOG_CATEGORY);
    const body = JSON.parse(text) as { data?: { components?: ReturnType<typeof componentSnapshot> } };
    return { components: body.data?.components ?? [] };
  } finally {
    lifetime.clear();
  }
}

async function runAnatomy(json: boolean): Promise<void> {
  const processes = await censusProcesses(REPO_ROOT);
  const route = await fetchComponentsFromBlock();
  if (json) {
    const payload =
      "components" in route
        ? { processes, components: route.components }
        : { processes, components: null, componentsUnavailable: route.unavailable };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatCensusText(processes)}\n\n`);
  if ("components" in route) {
    process.stdout.write(`${formatComponentsText(route.components)}\n`);
  } else {
    process.stdout.write(`component registry — UNAVAILABLE: ${route.unavailable}\n`);
  }
}

// ── The follow stream (tail --follow) ────────────────────────────────────────

/**
 * Print the tail's own first batch, then keep polling the ledger for new
 * events until interrupted. The poll timer is unref'd — the stream is held
 * by its stdin, so the process ends when its input closes instead of
 * outliving the reader, and Ctrl-C (SIGINT) exits cleanly with code 0.
 * Each poll examines the newest `FOLLOW_WINDOW_EVENTS` events and the
 * reader's pure cursor rule picks the new ones — never the whole ledger.
 */
function runFollow(
  db: ReturnType<typeof openLedgerReadOnly>,
  limit: number,
  filter: DigFilter,
  view: DigDocumentView,
  intervalMs: number,
): number {
  const first = digLedger(db, { kind: "tail", limit }, filter);
  process.stdout.write(`${formatDigText(first, view)}\n`);
  let lastSeen = nextFollowBatch(first.events, null).lastSeenSequence;
  const poll = () => {
    const window = digLedger(db, { kind: "tail", limit: FOLLOW_WINDOW_EVENTS }, filter);
    const next = nextFollowBatch(window.events, lastSeen);
    if (next.batch.length > 0) {
      lastSeen = next.lastSeenSequence;
      process.stdout.write(`${formatFollowText(next.batch, view)}\n`);
    }
  };
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  process.stdin.resume();
  process.once("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  // The stream never "completes": this returns 0 immediately and the loop
  // stays alive through the stdin hold — the process exits through the
  // SIGINT door (or when stdin closes) with code 0 either way.
  return 0;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

// ── The chat→run-ids resolution (the honest seam for `--chat`) ──────────────
//
// THE LEDGER HOLDS NO CHAT ID. Its `session_id` column is the request
// boundary's harness_session cookie id — a web SESSION, not a chat — so a
// `--chat <chatId>` flag can only be answered by resolving the chat to its
// runs first, through the web db's `messages.run_id` (every persisted
// message records the run that produced it). The mapping's SQL is owned by
// the db (`CHAT_RUN_IDS_SQL` beside `runIdsForChat`, which composes the
// user-ownership gate after it for the server route); this dev CLI
// prepares the same bytes on its own READ-ONLY connection — a diagnostic
// that already reads the whole ledger unscoped. A chat that resolves to
// zero runs is ABSENT, never "all runs" and never a quiet empty list.

/**
 * Resolve one chat id to the run ids its messages recorded. Read-only by
 * construction: a fresh `node:sqlite` connection with `readOnly: true`, one
 * prepared statement, closed by the caller. A missing web db is a
 * misconfiguration and says so honestly (the ledger opener's wording names
 * the timeline ledger, so this has its own).
 */
function resolveChatRunIds(chatId: string): readonly string[] {
  const path = resolveLedgerPath(serverConfig.dbPath, REPO_ROOT);
  if (!existsSync(path)) {
    throw new CliAbsentError(
      `web db not found at ${path} — start the server once or point HARNESS_WEB_DB_PATH at it`,
    );
  }
  const web = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = web.prepare(CHAT_RUN_IDS_SQL).all(chatId) as ReadonlyArray<Record<string, unknown>>;
    const runIds: string[] = [];
    for (const row of rows) {
      const runId = row["run_id"];
      if (typeof runId === "string") runIds.push(runId);
    }
    return runIds;
  } finally {
    web.close();
  }
}

/** The runs/doctor scope the CLI threads into the dig: `--chat` becomes a
 * resolved run-id set, `--session` passes straight through. Throws the
 * honest absent line when the chat resolved to nothing. */
function runsScope(parsed: Readonly<{ chatId?: string; sessionId?: string }>): Readonly<{ runIds?: readonly string[]; sessionId?: string }> {
  if (parsed.chatId !== undefined) {
    const runIds = resolveChatRunIds(parsed.chatId);
    if (runIds.length === 0) {
      throw new CliAbsentError(`no runs recorded for chat ${parsed.chatId} — the chat is absent or no message carries a run id`);
    }
    return { runIds };
  }
  if (parsed.sessionId !== undefined) return { sessionId: parsed.sessionId };
  return {};
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "help": {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    case "schema": {
      process.stdout.write(`${formatSchemaJson()}\n`);
      return 0;
    }
    case "anatomy": {
      await runAnatomy(parsed.json);
      return 0;
    }
    case "runs": {
      const scope = runsScope(parsed);
      const db = openLedgerReadOnly(resolveLedgerPath(serverConfig.timelineDbPath, REPO_ROOT));
      try {
        const result = listRuns(db, {
          ...scope,
          ...(parsed.failedOnly ? { failedOnly: true } : {}),
          ...(parsed.last !== undefined ? { last: parsed.last } : {}),
        });
        if (!result.scopeMatched) {
          // The scope is absent, not empty: name it honestly — a session id
          // the ledger never recorded, or (for --chat) run ids the ledger
          // no longer holds.
          throw new CliAbsentError(
            parsed.chatId !== undefined
              ? `no runs for chat ${parsed.chatId} in the ledger`
              : `no runs for session ${parsed.sessionId} in the ledger`,
          );
        }
        process.stdout.write(`${parsed.json ? formatRunsJson(result) : formatRunsText(result, parsed.failedOnly)}\n`);
        return 0;
      } finally {
        db.close();
      }
    }
    case "doctor": {
      const scope = runsScope(parsed);
      const db = openLedgerReadOnly(resolveLedgerPath(serverConfig.timelineDbPath, REPO_ROOT));
      try {
        const result = doctorLedger(db, scope);
        if (!result.scopeMatched) {
          throw new CliAbsentError(
            parsed.chatId !== undefined
              ? `no runs for chat ${parsed.chatId} in the ledger`
              : `no runs for session ${parsed.sessionId} in the ledger`,
          );
        }
        process.stdout.write(`${parsed.json ? formatDoctorJson(result) : formatDoctorText(result)}\n`);
        return 0;
      } finally {
        db.close();
      }
    }
    case "dig": {
      // The filters are validated against the vocabulary BEFORE any query
      // runs — a typo teaches the correct word instead of returning an
      // empty scope that looks like "no such events".
      let filter: DigFilter;
      try {
        filter = {
          ...(parsed.raw.eventType !== undefined ? { eventType: resolveEventTypeFilter(parsed.raw.eventType) } : {}),
          ...(parsed.raw.since !== undefined ? { sinceWallTime: resolveWallTimeBound(parsed.raw.since) } : {}),
          ...(parsed.raw.until !== undefined ? { untilWallTime: resolveWallTimeBound(parsed.raw.until) } : {}),
          ...(parsed.raw.failedOnly ? { failedOnly: true } : {}),
          ...(parsed.raw.allEventTypes ? { allEventTypes: true } : {}),
        };
      } catch (err) {
        // The resolvers' typed input errors are argument errors: the usage
        // screen is part of the answer. The ledger-open error below is an
        // environment error and keeps its own one-line shape.
        if (err instanceof InputError) throw new CliUsageError(err.message);
        throw err;
      }
      const db = openLedgerReadOnly(resolveLedgerPath(serverConfig.timelineDbPath, REPO_ROOT));
      try {
        if (parsed.followMs !== null) {
          const code = runFollow(db, parsed.scope.kind === "tail" ? parsed.scope.limit : 20, filter, parsed.view, parsed.followMs);
          return code;
        }
        const result = digLedger(db, parsed.scope, filter);
        const verdict = digExitVerdict(result);
        if (verdict === "absent" && (parsed.scope.kind === "run" || parsed.scope.kind === "trace")) {
          throw new CliAbsentError(`no ${parsed.scope.kind} with id ${parsed.scope.id} in the ledger`);
        }
        process.stdout.write(
          parsed.json ? `${formatDigJson(result, parsed.view)}\n` : `${formatDigText(result, parsed.view)}\n`,
        );
        return 0;
      } finally {
        if (parsed.followMs === null) db.close();
      }
    }
  }
}

/**
 * The CLI entry, shape-for-shape with the engine CLI's testable entry: run
 * one command line, return the process exit code. Argument and scope errors
 * print their honest reason to stderr and return 1; a produced answer —
 * including an honest empty scope — returns 0.
 */
export async function runTraceCli(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`trace: ${err.message}\n\n${USAGE}\n`);
      return 1;
    }
    if (err instanceof CliAbsentError) {
      process.stderr.write(`trace: ${err.message}\n`);
      return 1;
    }
    if (err instanceof InputError) {
      process.stderr.write(`trace: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ── Run, when invoked as the main module (an import runs nothing) ────────────

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  runTraceCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
