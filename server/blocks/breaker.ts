/**
 * BREAKER PANEL — `tools.breaker` (DESIGN-COCKPIT-V2.md §3.5).
 *
 * One breaker row per available tool: on/off/tripped state, real call counts
 * from the ledger's recorded tool events, last duration from the recorded
 * `effect-timing` document, last error from the recorded error columns.
 * Nothing here is a new state store:
 *
 * - THE STATE OWNER IS THE EXISTING PER-USER OVERRIDE STORE (`tool_settings`
 *   via `db.upsertToolSetting` — the same rows the legacy
 *   `POST /api/tools/:name/toggle` writes and the per-run safety gate
 *   re-reads on every check). This block EXTENDS that owner with the
 *   breaker contract instead of shipping a second tool-state party
 *   (Single-Party-Owner). Breaker metadata (arm threshold, trip marker)
 *   lives under the row's existing free-form `config` column, merged — a
 *   plain toggle that rewrites `config` clears it, which is honest: a
 *   deliberate re-enable IS a reset.
 *
 * - THE COUNTS OWNER IS THE LEDGER: `calls`/`lastMs`/`lastError` are folded
 *   from recorded `tool` events scoped to the chat's runs (bounded searches
 *   of `idx_event_log_run` via the store's `runIds` filter — the plan is
 *   EXPLAIN-asserted at the SQL owner). No counter is kept here to drift.
 *
 * NEXT-BOUNDARY SEMANTICS (the quantized flip)
 *
 * `set { at: "next-boundary" }` writes the override row immediately; the run
 * loop honors it at the NEXT tool-call decision point — the top of each turn
 * iteration in `server/routes/run.ts`, where `honorToolBoundary` (below)
 * re-derives the enabled manifest + LLM tool definitions from the live rows.
 * A flip mid-call therefore never aborts the in-flight call (the loop only
 * consults the store between turns), and the safety gate — which re-reads
 * the same rows per check — backstops the window in depth.
 *
 * AUTO-TRIP is a DETERMINISTIC check at that same boundary: when a tool's
 * consecutive recorded failures (the run's attempt counter, which increments
 * only on recorded failed executions) reach the armed `tripAfterFailures`,
 * the boundary flips the row off, stamps the trip marker, and appends a
 * `permission`/denied ledger event. `tripsFired` keys the check on the exact
 * failure count so one failure streak trips exactly once — an explicit
 * `reset` at the same count does not instantly re-trip.
 */

import { z } from "zod";

import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import {
  findManifestTool,
  getEnabledToolManifestForSession,
  getToolAccountStates,
  invalidateToolManifestCache,
  manifestEntriesToToolDefinitions,
  type WebToolEntry,
} from "../tools/tools-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { NotFoundError } from "../kernel/errors.ts";
import type { ToolSettingRow } from "../db/client.ts";
import type { ToolDefinition } from "../kernel/canonical.ts";
import {
  BREAKER_EVENT_FOLD_LIMIT,
  TIMELINE_EFFECT_TIMING_DOCUMENT,
} from "../../shared/constants.ts";
import { defineBlock, RANGED_UNTIL_PARAM, type BlockHandlerContext } from "./define.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

// ── Breaker config under the override row's `config` column ────────────────

/** Key inside `tool_settings.config` this block owns (merged, never replacing peers). */
export const BREAKER_CONFIG_KEY = "breaker";

/** The tripped marker: the trip's facts. `auto`/`runId` are present only on a
 * gate auto-trip (see {@link BreakerConfig}). */
export type BreakerTripped = Readonly<{
  atMs: number;
  failures: number;
  auto?: true;
  runId?: string;
}>;

export type BreakerConfig = Readonly<{
  /** Armed auto-trip threshold: consecutive recorded failures. */
  tripAfterFailures?: number;
  /** Present while the tool is off BECAUSE it tripped. */
  tripped?: BreakerTripped;
}>;

/** Decode the breaker slice of a row's config; absent/foreign shapes → {}. */
export function breakerConfigOf(row: ToolSettingRow | undefined): BreakerConfig {
  const config = row?.config;
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  const slice = (config as Record<string, unknown>)[BREAKER_CONFIG_KEY];
  if (slice === null || slice === undefined || typeof slice !== "object" || Array.isArray(slice)) {
    return {};
  }
  const r = slice as Record<string, unknown>;
  return {
    ...(typeof r.tripAfterFailures === "number" && Number.isInteger(r.tripAfterFailures)
      ? { tripAfterFailures: r.tripAfterFailures }
      : {}),
    ...(r.tripped !== null && typeof r.tripped === "object" && !Array.isArray(r.tripped)
      ? {
          tripped: {
            atMs: Number((r.tripped as Record<string, unknown>).atMs ?? 0),
            failures: Number((r.tripped as Record<string, unknown>).failures ?? 0),
            ...((r.tripped as Record<string, unknown>).auto === true
              ? { auto: true as const }
              : {}),
            ...(typeof (r.tripped as Record<string, unknown>).runId === "string"
              && ((r.tripped as Record<string, unknown>).runId as string).length > 0
              ? { runId: (r.tripped as Record<string, unknown>).runId as string }
              : {}),
          },
        }
      : {}),
  };
}

/** Merge a breaker slice into an existing config value, preserving foreign keys. */
export function withBreakerConfig(existing: unknown, breaker: BreakerConfig): unknown {
  const base =
    existing !== null && existing !== undefined && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (Object.keys(breaker).length === 0) {
    delete base[BREAKER_CONFIG_KEY];
  } else {
    base[BREAKER_CONFIG_KEY] = breaker;
  }
  return base;
}

// ── Read: rows folded from manifest + override store + ledger ──────────────

export type BreakerRow = Readonly<{
  id: string;
  label: string;
  description: string;
  state: "on" | "off" | "tripped";
  calls: number;
  lastMs?: number;
  lastError?: string;
  /** Armed auto-trip threshold, when set. */
  tripAfterFailures?: number;
}>;

// The fold ceiling (`BREAKER_EVENT_FOLD_LIMIT`) is owned by shared/constants.ts.

/** Undecodable timing → honest absence (no lastMs), never a guess. */
function decodeDurationMs(contentJson: string | undefined): number | undefined {
  if (contentJson === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(contentJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>).durationMs;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold the chat's recorded tool events into per-tool `{calls, lastMs,
 * lastError}`. The tool name is the recorded `tool:<name>` description —
 * the same recorded string `TimelineRunActivitySummary` reports; an event
 * whose description does not carry the prefix is skipped (it is not a tool
 * execution record).
 */
export function foldToolEvents(
  runIds: readonly string[],
  untilMs?: number,
): ReadonlyMap<string, { calls: number; lastMs?: number; lastError?: string }> {
  const folded = new Map<string, { calls: number; lastMs?: number; lastError?: string }>();
  if (runIds.length === 0) return folded;
  const events = getTimelineStore().query({
    runIds,
    eventType: "tool",
    ascending: true,
    limit: BREAKER_EVENT_FOLD_LIMIT,
    ...(untilMs !== undefined ? { toWallTime: new Date(untilMs).toISOString() } : {}),
  });
  for (const event of events) {
    if (!event.description.startsWith("tool:")) continue;
    const name = event.description.slice("tool:".length);
    if (name.length === 0) continue;
    let entry = folded.get(name);
    if (entry === undefined) {
      entry = { calls: 0 };
      folded.set(name, entry);
    }
    entry.calls += 1;
    // Ascending fold: the last event of the loop is the latest recorded call.
    const durationMs = decodeDurationMs(
      event.documents.find((d) => d.name === TIMELINE_EFFECT_TIMING_DOCUMENT)?.contentJson ?? undefined,
    );
    if (durationMs !== undefined) entry.lastMs = durationMs;
    if (event.outcome === "failed" || event.errorMessage !== null) {
      entry.lastError = event.errorMessage ?? "failed (no recorded error detail)";
    } else {
      delete entry.lastError;
    }
  }
  return folded;
}

/** Compute the full breaker row set for a user + chat scope. */
export async function computeBreakerRows(
  db: AsyncDbClient,
  userId: string,
  runIds: readonly string[],
  untilMs?: number,
): Promise<readonly BreakerRow[]> {
  const rows = new Map(
    (await db.listToolSettings(userId)).map((r) => [r.tool_name, r] as const),
  );
  // Effective per-account states resolved by the BRIDGE (the single owner of
  // manifest access — `tool-registry-owner`), with the same merge rule the
  // run route and the safety gate apply.
  const states = getToolAccountStates(
    new Map([...rows.values()].map((r) => [r.tool_name, r.enabled] as const)),
  );
  const ledger = foldToolEvents(runIds, untilMs);
  return states.map((entry) => {
    const row = rows.get(entry.name);
    const breaker = breakerConfigOf(row);
    const state: BreakerRow["state"] =
      !entry.enabled && breaker.tripped !== undefined ? "tripped" : entry.enabled ? "on" : "off";
    const counts = ledger.get(entry.name);
    return Object.freeze({
      id: entry.name,
      label: entry.name.replace(/_/g, " "),
      description: entry.description,
      state,
      calls: counts?.calls ?? 0,
      ...(counts?.lastMs !== undefined ? { lastMs: counts.lastMs } : {}),
      ...(counts?.lastError !== undefined ? { lastError: counts.lastError } : {}),
      ...(breaker.tripAfterFailures !== undefined
        ? { tripAfterFailures: breaker.tripAfterFailures }
        : {}),
    });
  });
}

// ── The trip write (one owner for every trip source) ──────────────────────

/**
 * THE ONE TRIP WRITE. Flips the override row off with a trip marker and
 * records the `permission`/denied ledger event — the exact write the
 * next-boundary auto-trip has always performed, extracted so the GATE's
 * auto-trip routes through the same owner (no parallel breaker): the row
 * the panel reads, the marker the reset action clears, and the ledger
 * event all come from here.
 *
 * A tool that is already off WITHOUT a trip marker is left as-is (a
 * deliberate user disable is not adopted by a trip) — the same guard the
 * boundary check applies. A GATE auto-trip additionally refuses to
 * re-stamp a USER-ARMED trip (a marker without the auto provenance): the
 * user's trip is the stronger state — it already refuses everything, the
 * gate's streak work is moot — and a re-stamp would hand the marker the
 * gate's `auto`/`runId`, making the run-end revert end the user's
 * until-reset lifetime early. Returns the trip fact, or `null` when the
 * flip was refused (already off, a user-armed trip an auto-trip may not
 * adopt) or the tool is not in the manifest (a hallucinated name has no
 * breaker row to flip — the gate's own refusal is the whole remedy there).
 */
export async function tripToolBreaker(args: {
  db: AsyncDbClient;
  userId: string;
  tool: string;
  /** The failure/streak count the trip fired at — recorded + event-described. */
  failures: number;
  /** The user-armed threshold, when this trip is the boundary's armed check. */
  armedAt?: number;
  /** The auto-trip's provenance: names the run whose loop owns the revert. */
  autoRunId?: string;
  runId?: string;
}): Promise<ToolSettingRow | null> {
  const { db, userId, tool, failures } = args;
  // A hallucinated (non-manifest) tool has no breaker row to flip; the
  // gate-side refusal for the rest of the run is the whole remedy.
  if (findManifestTool(tool) === undefined) return null;
  const rows = await db.listToolSettings(userId);
  const row = rows.find((r) => r.tool_name === tool);
  const breaker = breakerConfigOf(row);
  // Only trip a tool that is currently live (or already tripped — a re-trip
  // re-stamps the marker): a tool the user turned off stays as they left it.
  if (row !== undefined && !row.enabled && breaker.tripped === undefined) return null;
  // THE MARKER RULE: a gate auto-trip must not re-stamp a user-armed trip.
  // The user's marker (no `auto` provenance) carries an until-manual-reset
  // lifetime; stamping the gate's `auto`/`runId` over it would let this
  // run's end revert flip the tool back on and end the user's trip early.
  if (
    args.autoRunId !== undefined &&
    breaker.tripped !== undefined &&
    breaker.tripped.auto !== true
  ) {
    return null;
  }
  const updated = await db.upsertToolSetting(
    {
      tool_name: tool,
      enabled: false,
      config: withBreakerConfig(row?.config, {
        ...(breaker.tripAfterFailures !== undefined ? { tripAfterFailures: breaker.tripAfterFailures } : {}),
        tripped: {
          atMs: Date.now(),
          failures,
          ...(args.autoRunId !== undefined ? { auto: true as const, runId: args.autoRunId } : {}),
        },
      }),
    },
    userId,
  );
  invalidateToolManifestCache();
  getTimelineRecorder().recordEvent({
    eventType: "permission",
    description: args.autoRunId !== undefined
      ? `breaker:tripped:${tool} — ${failures} consecutive identical blocked calls (gate auto-trip)`
      : `breaker:tripped:${tool} — ${failures} consecutive recorded failures${
          args.armedAt !== undefined ? ` (armed at ${args.armedAt})` : ""
        }`,
    outcome: "denied",
    ...(args.runId !== undefined || args.autoRunId !== undefined
      ? { correlation: { runId: args.autoRunId ?? args.runId! } }
      : {}),
  });
  return updated;
}

/**
 * Revert THIS RUN's gate auto-trips at run end. The auto-trip's lifetime is
 * the run: the gate's tripped set dies with the gate instance, and the row
 * flip the trip performed is restored here — UNLESS the user already
 * re-armed (the panel's reset/set clears the marker; nothing to revert).
 * Keyed on the marker's OWN provenance (`auto` + `runId`): a user-armed
 * trip carries neither, and the marker rule in `tripToolBreaker` keeps a
 * gate auto-trip from stamping them over it, so the user's until-reset
 * lifetime survives any run. Concurrent runs in other chats cannot
 * interfere (each reverts only markers naming its own run).
 */
export async function revertGateAutoTrips(db: AsyncDbClient, userId: string, runId: string): Promise<readonly string[]> {
  const rows = await db.listToolSettings(userId);
  const reverted: string[] = [];
  for (const row of rows) {
    const breaker = breakerConfigOf(row);
    if (breaker.tripped?.auto !== true || breaker.tripped.runId !== runId) continue;
    await db.upsertToolSetting(
      {
        tool_name: row.tool_name,
        enabled: true,
        config: withBreakerConfig(row.config, {
          ...(breaker.tripAfterFailures !== undefined ? { tripAfterFailures: breaker.tripAfterFailures } : {}),
        }),
      },
      userId,
    );
    reverted.push(row.tool_name);
  }
  if (reverted.length > 0) invalidateToolManifestCache();
  return reverted;
}

// ── The next-boundary honor point (called from the run loop) ───────────────

export type BoundaryResult = Readonly<{
  manifest: readonly WebToolEntry[];
  definitions: readonly ToolDefinition[];
  /** Auto-trips fired AT this boundary (already persisted + recorded). */
  trips: readonly Readonly<{ tool: string; failures: number; threshold: number }>[];
}>;

/**
 * The ONE function the run loop calls at each tool-call decision point.
 *
 * 1. Deterministic auto-trip: for every armed tool whose consecutive
 *    recorded failure count has reached its threshold — and whose exact
 *    count has not already fired (`tripsFired`) — flip the override row off
 *    with a trip marker and append a `permission`/denied ledger event.
 * 2. Re-derive the enabled manifest + LLM tool definitions from the LIVE
 *    per-user rows, so any `tools.breaker/set` (or legacy toggle) landed
 *    since the previous boundary takes effect for the NEXT decision — and
 *    never mid-call.
 *
 * `tripsFired` is caller-owned per run: it maps tool → the failure count a
 * trip already fired at, which is what makes the check idempotent per streak
 * and lets an explicit reset survive until a NEW failure raises the count.
 */
export async function honorToolBoundary(args: {
  db: AsyncDbClient;
  userId: string;
  consecutiveFailures: ReadonlyMap<string, number>;
  tripsFired: Map<string, number>;
  runId?: string;
}): Promise<BoundaryResult> {
  const { db, userId, consecutiveFailures, tripsFired } = args;
  const rows = new Map(
    (await db.listToolSettings(userId)).map((r) => [r.tool_name, r] as const),
  );
  const trips: { tool: string; failures: number; threshold: number }[] = [];

  for (const [tool, failures] of consecutiveFailures) {
    if (failures <= 0) continue;
    const row = rows.get(tool);
    const breaker = breakerConfigOf(row);
    const threshold = breaker.tripAfterFailures;
    if (threshold === undefined || failures < threshold) continue;
    if (tripsFired.get(tool) === failures) continue; // this exact streak already fired
    const trip = await tripToolBreaker({
      db,
      userId,
      tool,
      failures,
      armedAt: threshold,
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
    });
    if (trip === null) continue;
    rows.set(tool, trip);
    tripsFired.set(tool, failures);
    trips.push({ tool, failures, threshold });
  }

  const manifest = getEnabledToolManifestForSession(
    new Map([...rows.values()].map((r) => [r.tool_name, r.enabled] as const)),
  );
  return Object.freeze({
    manifest,
    definitions: manifestEntriesToToolDefinitions(manifest),
    trips: Object.freeze(trips),
  });
}

// ── Registration ───────────────────────────────────────────────────────────

const ReadInput = z.strictObject({
  chatId: z.string().min(1).max(256),
  /** Inclusive upper bound, epoch ms — the ranged-read convention
   * (`RANGED_UNTIL_PARAM`, declared once in define.ts). */
  until: RANGED_UNTIL_PARAM.optional(),
});

const SetInput = z.strictObject({
  tool: z.string().min(1).max(256),
  on: z.boolean(),
  /** The only supported landing point — the spec's quantized flip. */
  at: z.literal("next-boundary"),
});

const ResetInput = z.strictObject({
  tool: z.string().min(1).max(256),
});

const ArmInput = z.strictObject({
  tool: z.string().min(1).max(256),
  tripAfterFailures: z.number().int().min(1).max(20),
});

const DisarmInput = z.strictObject({
  tool: z.string().min(1).max(256),
});

/**
 * Every breaker verb's door: the tool must be a real manifest entry (an
 * unknown/hallucinated name has no breaker row to act on — 404), and every
 * REAL entry is eligible: built-in and live MCP tools are gated per tool
 * the same way (the run's tool decisions honor per-session overrides for
 * any category, and the gate's auto-trip flips MCP tools exactly as it
 * flips built-ins), so the panel that promises "re-enable it from the
 * breaker panel" must accept the trip's own subject. The old
 * built-in-only refusal made the auto-trip's promised exit a dead door
 * for the whole MCP family.
 */
function requireManifestTool(tool: string): void {
  // Bridge-owned manifest lookup (`tool-registry-owner`), same gate shape as
  // `tools.enabled/toggle`: unknown → 404.
  const entry = findManifestTool(tool);
  if (entry === undefined) {
    throw new NotFoundError(`Tool ${tool} not found`);
  }
}

export function defineBreakerBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "tools.breaker",
    title: "Tool breakers",
    description:
      "Per-tool breaker rows for a chat: on/off/tripped state from the per-user override store (the same rows the safety gate reads per decision), with call counts, last duration and last error folded from the ledger's recorded tool events — real counts, never a client-side tally.",
    read: {
      input: ReadInput,
      output: z.array(z.object({}).loose()),
      ttlMs: 5_000,
      invalidateOn: ["run:done", "tools:changed"],
      handler: async (input, { ctx }: BlockHandlerContext): Promise<readonly BreakerRow[]> => {
        const user = await requireUserContext(ctx, db);
        if (await db.getChat(input.chatId, user.userId) === null) {
          throw new NotFoundError(`Chat ${input.chatId} not found`);
        }
        const runIds = await db.runIdsForChat(input.chatId, user.userId);
        return computeBreakerRows(db, user.userId, runIds, input.until);
      },
    },
    actions: {
      set: {
        input: SetInput,
        title: "Flip breaker",
        consequence:
          "Turns this tool on or off for your account; a call already underway finishes untouched, and the change lands at the next tool decision — never mid-call.",
        invalidates: ["tools:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          requireManifestTool(input.tool);
          const existing = (await db.listToolSettings(user.userId)).find(
            (r) => r.tool_name === input.tool,
          );
          const breaker = breakerConfigOf(existing);
          const row = await db.upsertToolSetting(
            {
              tool_name: input.tool,
              enabled: input.on,
              // A deliberate flip clears any trip marker (state becomes a
              // plain on/off); the armed threshold survives the flip.
              config: withBreakerConfig(existing?.config, {
                ...(breaker.tripAfterFailures !== undefined
                  ? { tripAfterFailures: breaker.tripAfterFailures }
                  : {}),
              }),
            },
            user.userId,
          );
          // Same cache drop the sibling toggle performs — the next manifest
          // read and the gate's next check see the new state immediately.
          invalidateToolManifestCache();
          return Object.freeze({ tool: row.tool_name, on: row.enabled, effectiveAt: "next-boundary" as const });
        },
      },
      reset: {
        input: ResetInput,
        title: "Reset breaker",
        consequence:
          "Clears the tripped state and turns the tool back on from the next tool decision; your auto-trip setting stays armed.",
        invalidates: ["tools:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          requireManifestTool(input.tool);
          const existing = (await db.listToolSettings(user.userId)).find(
            (r) => r.tool_name === input.tool,
          );
          const breaker = breakerConfigOf(existing);
          const row = await db.upsertToolSetting(
            {
              tool_name: input.tool,
              enabled: true,
              config: withBreakerConfig(existing?.config, {
                ...(breaker.tripAfterFailures !== undefined
                  ? { tripAfterFailures: breaker.tripAfterFailures }
                  : {}),
              }),
            },
            user.userId,
          );
          invalidateToolManifestCache();
          return Object.freeze({ tool: row.tool_name, on: row.enabled, tripped: false });
        },
      },
      arm: {
        input: ArmInput,
        title: "Arm auto-trip",
        consequence:
          "After this many failures in a row, the tool switches itself off at the next safe moment; the trip is recorded with the time and the count.",
        invalidates: ["tools:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          requireManifestTool(input.tool);
          const existing = (await db.listToolSettings(user.userId)).find(
            (r) => r.tool_name === input.tool,
          );
          const breaker = breakerConfigOf(existing);
          // Preserve the current effective enabled state: arming is not a
          // flip. Resolved by the bridge's merge rule (no override → the
          // shared default decides).
          const currentlyEnabled =
            existing?.enabled ??
            getToolAccountStates(new Map()).find((t) => t.name === input.tool)?.enabled ??
            false;
          const row = await db.upsertToolSetting(
            {
              tool_name: input.tool,
              enabled: currentlyEnabled,
              config: withBreakerConfig(existing?.config, {
                ...breaker,
                tripAfterFailures: input.tripAfterFailures,
              }),
            },
            user.userId,
          );
          invalidateToolManifestCache();
          return Object.freeze({
            tool: row.tool_name,
            tripAfterFailures: input.tripAfterFailures,
            on: row.enabled,
          });
        },
      },
      disarm: {
        // THE WAY BACK FROM `arm` — the one-way door this block used to be.
        // `arm` writes a threshold nothing could remove: the panel's reset
        // preserves it on purpose ("your auto-trip setting stays armed"), the
        // flip preserves it, and no other surface offered the clearing verb —
        // so "not armed yet" was unreachable once armed (UIE-008). Disarm
        // removes the THRESHOLD and nothing else: a tripped tool stays
        // tripped until its own reset, and the on/off state is untouched.
        input: DisarmInput,
        title: "Disarm auto-trip",
        consequence:
          "Removes the auto-trip setting for this tool — failures stop counting toward a trip until you arm one again. The tool's on/off state stays as it is, and a tripped tool stays tripped until reset.",
        invalidates: ["tools:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          requireManifestTool(input.tool);
          const existing = (await db.listToolSettings(user.userId)).find(
            (r) => r.tool_name === input.tool,
          );
          const breaker = breakerConfigOf(existing);
          // The armed threshold leaves; a standing trip marker is the
          // breaker's own state and outlives the setting that tripped it.
          const row = await db.upsertToolSetting(
            {
              tool_name: input.tool,
              enabled: existing?.enabled ?? true,
              config: withBreakerConfig(existing?.config, {
                ...(breaker.tripped !== undefined ? { tripped: breaker.tripped } : {}),
              }),
            },
            user.userId,
          );
          invalidateToolManifestCache();
          return Object.freeze({
            tool: row.tool_name,
            tripAfterFailures: null,
            on: row.enabled,
          });
        },
      },
    },
  });
}
