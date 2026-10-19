/**
 * SWEEP spectrum — `sweep.spectrum` (DESIGN-COCKPIT-V2.md §6.2/§6.6).
 *
 * The read behind the SWEEP band: a time-binned density skyline of every
 * recorded ledger event in scope — per-bin counts per CATEGORY (the 8-hue
 * wheel of §12.3), plus a per-bin error count (the `--alarm` ridge), packed
 * as a base64 Int16Array with a JSON header naming categories/binMs/t0.
 *
 * WHERE THE AGGREGATION LIVES — THE LEDGER'S OWNER, NOT HERE
 *
 * Same rule as `coverage.ts` / `synthesis.ts`: this module contains NO SQL.
 * The aggregate read is `spectrum()` on the canonical timeline store —
 * with EXPLAIN checks of its actual emitted statements beside it in
 * `engine/test/timeline/timeline-spectrum.test.ts`. Every arm filters this
 * ledger before ranges and bins are computed.
 *
 * CANONICAL ERROR-ROW SEMANTICS — THE RIDGE IS AN OVERLAY, BY DESIGN
 *
 * A failing event is counted ONCE in its event-type category row AND once in
 * the error row. This is intentional and is the canonical wire semantics:
 * §6.2 draws the "error ridge on top" of the category-stacked skyline — the
 * ridge REDRAWS the same events in the alarm color, it is not a ninth
 * additive category. Consequences a consumer must honor (and the client's
 * drift test pins):
 *   - `header.events` is the true matched-event population; summing the
 *     CATEGORY rows reproduces it (minus `unbinnable`) — never add the
 *     error row into a total;
 *   - the error row is a per-bin subset marker: `errorRow[b] <= sum of
 *     category cells at b` always holds.
 * The response header states this as `errorRowIsOverlay: true` so a decoder
 * that assumes additive rows fails loudly against the field, not silently
 * against the math.
 *
 * SCOPE + OWNERSHIP
 *
 * `scope=chat` requires `chatId`, `scope=project` requires `projectId`; the
 * id resolves through the user-scoped DB lookups (`getChat`/`getProject` —
 * null → 404 hiding existence) and the run-id mapping owners
 * (`runIdsForChat`/`runIdsForProject`). The counts therefore cover ONLY
 * run-attributed events of the caller's own runs — stated in the header as
 * `attributedOnly: true`, because events recorded outside any run cannot be
 * scoped to a chat or project and silently folding them in would attribute
 * other tenants' (or nobody's) history to this scope.
 *
 * Trace scope requires a trace with at least one owned row in this
 * ledger. Every counted row is then filtered by owned run; foreign and
 * unattributed rows never affect counts, ranges or bins.
 *
 * THE `until` PARAM — the ranged-read convention (see the header note in
 * `define.ts`): an inclusive epoch-ms upper bound, so a planted SWEEP head
 * renders the state at that instant from the same read.
 */

import { z } from "zod";

import type { TimelineEventType, TimelineSpectrum } from "../kernel/canonical.ts";
import {
  SPECTRUM_CELL_MAX,
  SPECTRUM_DEFAULT_BINS,
  SPECTRUM_MAX_BINS,
} from "../../shared/constants.ts";
import { resolveTimelineScope } from "../observability/timeline-scope.ts";
import { getTimelineStore } from "../observability/timeline-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { defineBlock, RANGED_UNTIL_PARAM, type BlockHandlerContext } from "./define.ts";

// ── Category vocabulary (the 8-hue wheel of §12.3) ─────────────────────────

/**
 * The sweep's category vocabulary, in packed-row order. Eight categories —
 * the §12.3 wheel — each a stable id the client maps to its hue token.
 */
export const SWEEP_CATEGORIES = [
  "lifecycle",
  "transport",
  "agent",
  "tool",
  "outcome",
  "effect",
  "context",
  "system",
] as const;

export type SweepCategory = (typeof SWEEP_CATEGORIES)[number];

/**
 * event_type → category, EXHAUSTIVE over the harness registry: the Record is
 * typed over `TimelineEventType`, so a vocabulary change in the harness is a
 * compile error here — never a silently uncategorised lane.
 */
export const EVENT_TYPE_CATEGORY: Readonly<Record<TimelineEventType, SweepCategory>> = {
  run: "lifecycle",
  turn: "lifecycle",
  message: "lifecycle",
  header: "transport",
  token: "transport",
  cost: "transport",
  provider: "transport",
  agent: "agent",
  task: "agent",
  subtask: "agent",
  tool: "tool",
  "tool-input": "tool",
  "tool-output": "tool",
  error: "outcome",
  success: "outcome",
  timing: "outcome",
  resource: "outcome",
  "file-effect": "effect",
  test: "effect",
  git: "effect",
  commit: "effect",
  tag: "effect",
  checkpoint: "effect",
  rollback: "effect",
  filesystem: "effect",
  process: "effect",
  network: "effect",
  db: "system",
  context: "context",
  memory: "context",
  artifact: "system",
  permission: "system",
  quality: "system",
  promotion: "system",
  ledger: "system",
  // the browser lane — same family as the error/timing/resource rows:
  // uncaught page errors are outcomes, renderer measurements are the
  // client's timing/resource kin.
  "client-error": "outcome",
  "client-metric": "outcome",
  // the engine lane — internal harness machinery, same family as db
  engine: "system",
};

// Bounds (bin ceiling/default, Int16 cell clamp) are owned by
// `shared/constants.ts` (the @config-owner file) — imported above.

// ── Shapes ─────────────────────────────────────────────────────────────────

export type SpectrumHeader = Readonly<{
  /** Row labels of the packed matrix, in row order. */
  categories: readonly SweepCategory[];
  /** Row index of the error ridge (always the LAST row). */
  errorRow: number;
  /**
   * CANONICAL: the error row is an OVERLAY of events already counted in
   * their category rows (§6.2's "ridge on top"), never an additive ninth
   * row. Totals come from the category rows alone.
   */
  errorRowIsOverlay: true;
  /** Rows × cols of the packed Int16Array (rows = categories + 1 error row). */
  rows: number;
  bins: number;
  /** Bin width in ms (0 when the scope matched nothing). */
  binMs: number;
  /** Observed first/last event instants, epoch ms (null when empty). */
  t0: number | null;
  t1: number | null;
  /** Events matched / events whose wall_time did not parse (counted, not dropped). */
  events: number;
  unbinnable: number;
  /** Every web spectrum counts only events attributed to owned runs. */
  attributedOnly: true;
  /** True when at least one cell exceeded Int16 range and was clamped. */
  clamped: boolean;
}>;

export type SpectrumRead = Readonly<{
  header: SpectrumHeader;
  /** Base64 of an Int16Array, row-major: categories rows then the error row. */
  packed: string;
}>;

// ── Pure packing (exported for the behavioral tests) ───────────────────────

/**
 * Fold the store's per-event-type bins into the packed category matrix.
 * Every event type the store reports is mapped through the exhaustive table;
 * a type outside the declared registry (a raw writer's invention) is folded
 * into `system` rather than dropped — the count stays true, the category is
 * the honest catch-all.
 *
 * The header states the mandatory web read scope.
 */
export function packSpectrum(spectrum: TimelineSpectrum): SpectrumRead {
  const rows = SWEEP_CATEGORIES.length + 1;
  const bins = spectrum.bins;
  const matrix = new Int16Array(rows * bins);
  const rowIndex = new Map<string, number>(SWEEP_CATEGORIES.map((c, i) => [c, i]));
  let clamped = false;
  const add = (row: number, bin: number, count: number): void => {
    const at = row * bins + bin;
    const next = (matrix[at] ?? 0) + count;
    if (next > SPECTRUM_CELL_MAX) {
      matrix[at] = SPECTRUM_CELL_MAX;
      clamped = true;
    } else {
      matrix[at] = next;
    }
  };
  for (const [eventType, typeBins] of Object.entries(spectrum.eventTypeBins)) {
    const category = EVENT_TYPE_CATEGORY[eventType as TimelineEventType] ?? "system";
    const row = rowIndex.get(category)!;
    for (let bin = 0; bin < typeBins.length; bin++) {
      const count = typeBins[bin]!;
      if (count > 0) add(row, bin, count);
    }
  }
  const errorRow = SWEEP_CATEGORIES.length;
  for (let bin = 0; bin < spectrum.errorBins.length; bin++) {
    const count = spectrum.errorBins[bin]!;
    if (count > 0) add(errorRow, bin, count);
  }
  const packed = Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength).toString("base64");
  return Object.freeze({
    header: Object.freeze({
      categories: SWEEP_CATEGORIES,
      errorRow,
      errorRowIsOverlay: true as const,
      rows,
      bins,
      binMs: spectrum.binMs,
      t0: spectrum.t0 === null ? null : Date.parse(spectrum.t0),
      t1: spectrum.t1 === null ? null : Date.parse(spectrum.t1),
      events: spectrum.events,
      unbinnable: spectrum.unbinnable,
      attributedOnly: true as const,
      clamped,
    }),
    packed,
  });
}

// ── Registration ───────────────────────────────────────────────────────────

const Input = z
  .strictObject({
    scope: z.enum(["chat", "project", "trace"]),
    chatId: z.string().min(1).max(256).optional(),
    projectId: z.string().min(1).max(256).optional(),
    traceId: z.string().min(1).max(256).optional(),
    bins: z.coerce.number().int().min(1).max(SPECTRUM_MAX_BINS).optional(),
    /** Inclusive upper bound, epoch ms — the ranged-read convention
     * (`RANGED_UNTIL_PARAM`, declared once in define.ts). */
    until: RANGED_UNTIL_PARAM.optional(),
  })
  .refine(
    (v) =>
      (v.scope === "chat" && v.chatId !== undefined && v.projectId === undefined && v.traceId === undefined) ||
      (v.scope === "project" && v.projectId !== undefined && v.chatId === undefined && v.traceId === undefined) ||
      (v.scope === "trace" && v.traceId !== undefined && v.chatId === undefined && v.projectId === undefined),
    { message: "scope=chat requires chatId, scope=project requires projectId, scope=trace requires traceId — and only the id matching the scope" },
  );

const Output = z.object({
  header: z.object({}).loose(),
  packed: z.string(),
});

export function defineSpectrumBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "sweep.spectrum",
    title: "Sweep spectrum",
    description:
      "Time-binned density of the recorded ledger for a chat, a project, or one trace: per-bin counts per event category plus a per-bin error count, packed as a base64 Int16Array with a JSON header (categories, binMs, t0). All scopes count only events attributed to the caller's own runs in this ledger. Server-counted rows, never simulated.",
    read: {
      input: Input,
      output: Output,
      ttlMs: 5_000,
      invalidateOn: ["run:done"],
      handler: async (input, { ctx }: BlockHandlerContext): Promise<SpectrumRead> => {
        const user = await requireUserContext(ctx, db);
        const scope = await resolveTimelineScope(db, user, input);
        const spectrum = getTimelineStore().spectrum({
          runIds: scope.runIds,
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          bins: input.bins ?? SPECTRUM_DEFAULT_BINS,
          ...(input.until !== undefined
            ? { toWallTime: new Date(input.until).toISOString() }
            : {}),
        });
        return packSpectrum(spectrum);
      },
    },
  });
}

// Exhaustiveness lives in the type system (`Record<TimelineEventType, …>` —
// a missing entry is a compile error) and in the registry-walk test in
// tests/unit/cockpit-spine-blocks.test.ts; `packSpectrum` additionally folds
// any UNDECLARED type a raw writer invents into `system` so its count is
// never dropped.
