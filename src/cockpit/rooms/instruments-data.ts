/**
 * INSTRUMENTS — pure helpers (DESIGN-COCKPIT-V2 §8).
 *
 * Everything decidable without a DOM or a network lives here, node-testable:
 * grouping the served signal registry by feature module, resolving each
 * cell's plain-language name and its ≤2 verbs MECHANICALLY from the served
 * schema, the measured ring buffer + gap-honest spark segmentation (§8.3),
 * value formatting, abnormal-state resolution, and the pinned-monitor set
 * arithmetic (≤4, displace-on-5th).
 *
 * ZERO-KNOWLEDGE NAMES — SERVED, NEVER IMPORTED FROM THE OLD TREE: the
 * cell name is the registry's own `SignalEntry.name` and the group heading
 * is the exposure module's served title (`sys.<ns>` ModuleEntry, the
 * exposure generator's display path), falling back to the contracts-owned
 * `humanizeId`. `rawNameGaps` detects any served name that is still a raw
 * identifier so the gap is REPORTED, not papered over with old-tree tables
 * (the import law bans them).
 *
 * MECHANICAL VERBS (§1.2, §8.2) — no hand-wired verb table exists:
 *   - adjust — a served setting whose `customizationId` IS the signal's id
 *     (the registry's own bounding-setting declaration: 18 signals are
 *     customizations read back as signals);
 *   - the action verb — the served `blockActions` manifest entry whose
 *     block id IS the signal's id, offered only when its declared input
 *     template resolves without a selection context (an affordance whose
 *     input cannot be built is an inert control wearing a working one's
 *     label — block-contract law);
 *   - ask — always, the ask grammar's leader prefill (ASK_PREFILL from
 *     the grammar's own module — the menu enumerates the questions).
 * At most two render; ask is always one of them.
 *
 * ABNORMAL STATE (§1.2, §8 dark-cockpit): a cell earns color ONLY from the
 * signal's own DECLARED thresholds. The exposure contract as served today
 * declares none (verified against the registry's Signal type — no
 * threshold field exists), so `declaredThresholds` returns null for every
 * live signal and every cell is quiet ink — honestly. The resolution reads
 * only declared data, so a registry that starts serving thresholds lights
 * this up with zero code change here.
 */

import type {
  ActionEntry,
  SettingEntry,
  SignalEntry,
  UiSchema,
} from "../../../shared/ui-schema.ts";
import {
  humanizeId,
  type ModuleEntry as SchemaModuleEntry,
} from "../../../shared/module-contract.ts";
import type {
  BlockActionDescriptor,
  BlockActionsManifest,
} from "../../../shared/block-contract.ts";
import { SPARK_MIN_POINTS } from "./instruments-config.ts";
// The actions fold's press windows — the fold's own thresholds (the same
// discipline as the editor's delete windows: re-declared per surface rather
// than reached across rooms for constants that mean something else).
import { ACTION_ARM_SETTLE_MS, ACTION_ARM_WINDOW_MS } from "./instruments-config.ts";
// The ONE spelling of an instant in this product (the logbook's HH:MM:SS) —
// consumed, not re-derived, so a timestamp cell and every other clock on
// screen cannot disagree about what a moment looks like.
import { logTime } from "../shell/config.ts";
// The ask door's prefill is the ask grammar's own fact — the leader that
// opens the grammar, owned beside the grammar so the two cannot drift.
import { ASK_PREFILL } from "../computer/ask.ts";

/** Thrown by the instruments' honesty guards — a chart with nothing to
 * chart, an unmeasured value pushed at a numeral. These are bugs, loudly
 * (the §8.3 no-broken-chart law's teeth), and they are LOCAL bugs, not
 * client/transport failures — hence a cockpit-native type rather than
 * `ClientError`. Sibling of the Switch's `SwitchHonestyViolation`. */
export class InstrumentHonestyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstrumentHonestyViolation";
  }
}

// ── The measured ring buffer (§8.3 — a spark renders ONLY from this) ──────

/** One measured numeric sample: value + the epoch-ms it was received. */
export type SignalPoint = Readonly<{ t: number; v: number }>;

/** Append a measured point, keeping at most `capacity` (oldest dropped). */
export function pushPoint(
  buf: readonly SignalPoint[],
  point: SignalPoint,
  capacity: number,
): readonly SignalPoint[] {
  const next = buf.length >= capacity ? [...buf.slice(buf.length - capacity + 1), point] : [...buf, point];
  return next;
}

/** §8.3 floor: may a spark render from this buffer at all? */
export function sparkRenderable(points: readonly SignalPoint[]): boolean {
  return points.length >= SPARK_MIN_POINTS;
}

/**
 * Split measured points into gap-honest segments: adjacent points further
 * apart than `cadenceMs × gapFactor` are never connected — the un-measured
 * time between them renders as blank (§8.3: no interpolation across gaps).
 * A singleton segment renders as a dot, not a line.
 */
export function sparkSegments(
  points: readonly SignalPoint[],
  cadenceMs: number,
  gapFactor: number,
): readonly (readonly SignalPoint[])[] {
  if (points.length === 0) return [];
  const maxDt = cadenceMs * gapFactor;
  const out: SignalPoint[][] = [[points[0]!]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (cur.t - prev.t > maxDt) out.push([cur]);
    else out[out.length - 1]!.push(cur);
  }
  return out;
}

// ── Grouping by feature module (plain names via the served display path) ──

/**
 * The group heading — the exposure registry's display path as SERVED: the
 * generated `sys.<module>` ModuleEntry's title ("Context signals",
 * "Memory signals", …), else the contracts-owned humanization. Never an
 * old-tree label table.
 */
export function groupTitle(module: string, modules: readonly SchemaModuleEntry[]): string {
  const entry = modules.find((m) => m.id === `sys.${module}`);
  if (entry !== undefined && entry.title.length > 0) return entry.title;
  return humanizeId(module);
}

/** Group key for a signal whose served entry declares no module. */
export const UNDECLARED_MODULE = "other";

export type InstrumentGroup = Readonly<{
  module: string;
  title: string;
  signals: readonly SignalEntry[];
  /**
   * The module's served exposure actions (schema.actions filtered by their
   * DECLARED module), in served order — the fold derives from the served
   * schema alone, so an action registered tomorrow appears with no edit
   * here. A module that declares actions but no signals still gets its
   * group: the actions are surfaced, not dropped for lack of cells.
   */
  actions: readonly ActionEntry[];
}>;

/**
 * Group the served signals by their declared feature module, groups sorted
 * alphabetically (deterministic layout), signals in served registration
 * order (stable — no re-ranking, §8.2 has no featured tiles).
 *
 * The ACTION half: every served exposure action joins the group its
 * DECLARED module filed it under (an undeclared module groups under the
 * same honest catch-all as an undeclared signal), and a module that
 * declares actions but no signals still gets a group — the fold must
 * surface ALL served actions (deny-by-default: the derivation is from the
 * schema, never a hand list, so a filtered derivation is the one failure
 * the count guards catch).
 */
export function buildGroups(schema: UiSchema | null): readonly InstrumentGroup[] {
  if (schema === null) return [];
  const byModule = new Map<string, { signals: SignalEntry[]; actions: ActionEntry[] }>();
  const bucket = (mod: string): { signals: SignalEntry[]; actions: ActionEntry[] } => {
    let b = byModule.get(mod);
    if (b === undefined) {
      b = { signals: [], actions: [] };
      byModule.set(mod, b);
    }
    return b;
  };
  for (const s of schema.signals) {
    // The registry DECLARES each signal's module (required on the served
    // entry, populated for all 110 live signals). A blank one groups under
    // the honest catch-all rather than being invented from its id — the
    // room states what was declared, nothing more.
    bucket(s.module.length > 0 ? s.module : UNDECLARED_MODULE).signals.push(s);
  }
  for (const a of schema.actions) {
    // Same rule as the signals: the DECLARED module, with the same
    // catch-all for a declaration that named none.
    bucket(
      a.module !== undefined && a.module.length > 0 ? a.module : UNDECLARED_MODULE,
    ).actions.push(a);
  }
  return [...byModule.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
    .map(([module, contents]) => ({
      module,
      title: groupTitle(module, schema.modules),
      signals: contents.signals,
      actions: contents.actions,
    }));
}

// ── Served-name honesty (report gaps; never import old-tree tables) ───────

/** True when a served display name is still a raw identifier — empty, the
 * id itself, dotted/underscored, or camelCase (lowercase start with an
 * interior capital). Those are REPORTED as gaps, not silently re-labelled. */
export function isRawName(name: string, id: string): boolean {
  const n = name.trim();
  if (n.length === 0) return true;
  if (n === id) return true;
  if (/[._]/.test(n)) return true;
  if (/^[a-z]+[A-Z]/.test(n)) return true;
  return false;
}

/** Every served signal whose display name is still raw (id → served name). */
export function rawNameGaps(
  signals: readonly SignalEntry[],
): readonly Readonly<{ id: string; served: string }>[] {
  return signals
    .filter((s) => isRawName(s.name, s.id))
    .map((s) => ({ id: s.id, served: s.name }));
}

// ── Mechanical verb resolution (§1.2 / §8.2) ──────────────────────────────

export type InstrumentVerb =
  | Readonly<{ kind: "adjust"; label: string; customizationId: string; settingLabel: string }>
  | Readonly<{
      kind: "action";
      label: string;
      blockId: string;
      actionName: string;
      input: Readonly<Record<string, unknown>>;
      consequence: string;
      invalidates: readonly string[];
    }>
  | Readonly<{ kind: "ask"; label: string; prefill: string }>;

/** The bounding setting: the served setting whose customizationId IS this
 * signal's id — the registry's own declaration, never a lookup table. */
export function boundingSetting(
  signal: SignalEntry,
  settings: readonly SettingEntry[],
): SettingEntry | null {
  return settings.find((s) => s.customizationId === signal.id) ?? null;
}

/**
 * Whether a declared input template (`params`) is buildable WITHOUT a
 * selection context: the instruments room has no selection bus scope, so
 * any `$sel.<key>` reference makes the verb un-offerable here
 * (block-contract law: an affordance whose input cannot be built must not
 * render). An absent template is equally un-offerable — such an action is
 * invoked by a bespoke caller, not rendered from this field.
 */
export function templateBuildable(
  template: Readonly<Record<string, string>> | undefined,
): template is Readonly<Record<string, string>> {
  if (template === undefined) return false;
  return Object.values(template).every((v) => !v.startsWith("$sel."));
}

/** The declared action for a signal: the served blockActions manifest
 * entry whose BLOCK id is the signal's id, first buildable affordance. */
export function declaredAction(
  signal: SignalEntry,
  manifest: BlockActionsManifest | undefined,
): Readonly<{ blockId: string; descriptor: BlockActionDescriptor }> | null {
  const list = manifest?.[signal.id];
  if (list === undefined) return null;
  const descriptor = list.find((d) => templateBuildable(d.params));
  return descriptor === undefined ? null : { blockId: signal.id, descriptor };
}

/**
 * Up to two verbs per cell, resolved mechanically (§8.2): the first slot is
 * the bounding setting's `adjust` when one is declared, else the declared
 * action's own verb; `ask` is ALWAYS the last. Exposure `actions` sharing
 * the exact signal id would be the same mechanical join — the live registry
 * declares none (verified), and this resolver would pick them up through
 * the manifest the day a block claims the id.
 */
export function resolveVerbs(
  signal: SignalEntry,
  settings: readonly SettingEntry[],
  manifest: BlockActionsManifest | undefined,
): readonly InstrumentVerb[] {
  const out: InstrumentVerb[] = [];
  const setting = boundingSetting(signal, settings);
  if (setting !== null) {
    out.push({
      kind: "adjust",
      label: "adjust",
      customizationId: setting.customizationId ?? setting.id,
      settingLabel: setting.label,
    });
  } else {
    const act = declaredAction(signal, manifest);
    if (act !== null) {
      out.push({
        kind: "action",
        label: act.descriptor.title.toLowerCase(),
        blockId: act.blockId,
        actionName: act.descriptor.name,
        input: act.descriptor.params ?? {},
        consequence: act.descriptor.consequence,
        invalidates: act.descriptor.invalidates ?? [],
      });
    }
  }
  // The ask verb opens the grammar at its leader — never a guessed phrase.
  // A signal's display name cannot contain a question keyword (every
  // question names a code-graph fact), so a prefill built from the name
  // would be a promise the grammar can never parse; the composer's own live
  // menu enumerates what is askable from the leader on.
  out.push({ kind: "ask", label: "ask", prefill: ASK_PREFILL });
  return out;
}

// ── Abnormal state — DECLARED thresholds only (§1.2, dark cockpit) ────────

export type DeclaredThresholds = Readonly<{
  warnAbove?: number | undefined;
  alarmAbove?: number | undefined;
  warnBelow?: number | undefined;
  alarmBelow?: number | undefined;
}>;

/**
 * Read a signal's DECLARED thresholds off the served entry. The exposure
 * contract serves none today (the registry's Signal type has no threshold
 * field — verified), so this returns null for all 110 live signals and no
 * cell earns color; a served `thresholds` object with numeric bounds is
 * honored the day the registry declares one. Reading only declared data is
 * what keeps "where no threshold is declared, no abnormal state exists"
 * true by construction.
 */
export function declaredThresholds(entry: SignalEntry): DeclaredThresholds | null {
  const raw = (entry as SignalEntry & Readonly<Record<string, unknown>>)["thresholds"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Readonly<Record<string, unknown>>;
  const pick = (k: string): number | undefined =>
    typeof obj[k] === "number" && Number.isFinite(obj[k]) ? (obj[k] as number) : undefined;
  const t: DeclaredThresholds = {
    warnAbove: pick("warnAbove"),
    alarmAbove: pick("alarmAbove"),
    warnBelow: pick("warnBelow"),
    alarmBelow: pick("alarmBelow"),
  };
  return t.warnAbove !== undefined ||
    t.alarmAbove !== undefined ||
    t.warnBelow !== undefined ||
    t.alarmBelow !== undefined
    ? t
    : null;
}

export type AbnormalState = Readonly<{ level: "warn" | "alarm"; reason: string }>;

/**
 * The ONLY source of cell color: a MEASURED numeric value crossing the
 * signal's own declared threshold. Unmeasured is never abnormal (an absent
 * value cannot cross anything), and an undeclared threshold is no abnormal
 * state at all. The reason is plain words with its inputs (§1.5 F1 — the
 * salience law).
 */
export function abnormalState(
  entry: SignalEntry,
  value: number | string | boolean | undefined,
): AbnormalState | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const t = declaredThresholds(entry);
  if (t === null) return null;
  if (t.alarmAbove !== undefined && value >= t.alarmAbove)
    return { level: "alarm", reason: `measured ${value} ≥ declared alarm ${t.alarmAbove}` };
  if (t.alarmBelow !== undefined && value <= t.alarmBelow)
    return { level: "alarm", reason: `measured ${value} ≤ declared alarm ${t.alarmBelow}` };
  if (t.warnAbove !== undefined && value >= t.warnAbove)
    return { level: "warn", reason: `measured ${value} ≥ declared threshold ${t.warnAbove}` };
  if (t.warnBelow !== undefined && value <= t.warnBelow)
    return { level: "warn", reason: `measured ${value} ≤ declared threshold ${t.warnBelow}` };
  return null;
}

// ── Value formatting (measured values ONLY — absence never reaches here) ──

/** HH:MM of an epoch-ms instant — the §8.2 `asOf 14:02` form. */
export function asOfTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimFixed(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trimFixed(n / 1_000)}k`;
  if (Number.isInteger(n)) return String(n);
  return trimFixed(n);
}

function trimFixed(n: number): string {
  return n
    .toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

function durationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${trimFixed(ms / 1000)}s`;
  return `${trimFixed(ms / 60_000)}m`;
}

/**
 * Format a MEASURED value for the cell readout. Callers gate on
 * measurement first — an unmeasured signal renders the absence state, and
 * this function throwing on `undefined` is the mechanical enforcement (an
 * unmeasured value can never be rendered as a number, §1.1).
 */
export function formatMeasuredValue(
  value: number | string | boolean | undefined,
  type: string,
  unit?: string,
): string {
  if (value === undefined) {
    throw new InstrumentHonestyViolation(
      "unmeasured signal reached the numeral — render the absence state instead (§1.1)",
    );
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "—";
  // A `timestamp` signal is an INSTANT (epoch ms) by its own declaration —
  // the exposure vocabulary exists precisely so a generic consumer can
  // format it as a point in time. Falling through to the number path
  // printed the raw epoch (a thirteen-digit numeral nobody can read) on a
  // cell whose neighbours all speak the logbook's HH:MM:SS.
  if (type === "timestamp") return logTime(value);
  if (type === "timer" || unit === "ms") return durationMs(value);
  if (unit === "ratio") return `${Math.round(value * 100)}%`;
  const num = compactNumber(value);
  if (unit !== undefined && unit.length > 0 && unit !== "count") return `${num} ${unit}`;
  return num;
}

// ── Pinned monitors (≤4; a 5th asks which to displace) ────────────────────

export type PinnedMonitor = Readonly<{ signalId: string; pinnedAt: number }>;

export const MAX_PINNED = 4;

export type PinOutcome = "pinned" | "already" | "full";

/** What pinning `signalId` means against the current set. */
export function pinOutcome(pinned: readonly PinnedMonitor[], signalId: string): PinOutcome {
  if (pinned.some((m) => m.signalId === signalId)) return "already";
  return pinned.length >= MAX_PINNED ? "full" : "pinned";
}

/** Validated load shape for the storage convention. */
export function isPinnedMonitor(v: unknown): v is PinnedMonitor {
  if (v === null || typeof v !== "object") return false;
  const m = v as Readonly<Record<string, unknown>>;
  return typeof m["signalId"] === "string" && typeof m["pinnedAt"] === "number";
}

// ── Honest counts for the room's header line ──────────────────────────────

export type InstrumentCounts = Readonly<{
  declared: number;
  measured: number;
  collecting: number;
  notMeasured: number;
}>;

/**
 * The honest tally: `measured` signals have a received sample; while the
 * feed is running, the rest are `collecting` (a sample may still arrive —
 * or the server refused that signal's read this tick); before the feed has
 * ever run they are simply `notMeasured`.
 */
export function countInstruments(
  signals: readonly SignalEntry[],
  measuredIds: ReadonlySet<string>,
  feedRunning: boolean,
): InstrumentCounts {
  let measured = 0;
  for (const s of signals) if (measuredIds.has(s.id)) measured += 1;
  const rest = signals.length - measured;
  return {
    declared: signals.length,
    measured,
    collecting: feedRunning ? rest : 0,
    notMeasured: feedRunning ? 0 : rest,
  };
}

/** Re-exported action entry helper: the exposure `actions` list shares no
 * id with any signal today — the mechanical check a test pins so the claim
 * in `resolveVerbs`' doc stays verified, not asserted. */
export function exposureActionForSignal(
  signal: SignalEntry,
  actions: readonly ActionEntry[],
): ActionEntry | null {
  return actions.find((a) => a.id === signal.id) ?? null;
}

// ── The exposure actions fold (§8.2's "act on the system" surface) ─────────

/**
 * THE PRESS GRAMMAR — which served actions fire on ONE press, and which need
 * the deliberate TWO-PRESS confirm.
 *
 * Judged by WHAT EACH ACTION DOES, read from its registration (the execute
 * bodies, not the names): an action that destroys or forcibly resets state
 * (clear, reset, rollback, prune, compact, relearn, a forced trim, a cache
 * drop, a counter zeroing) gets the second press; an action that only
 * recomputes or reads without discarding anything (a refresh, a re-audit
 * read, a retrieval probe, a syntax validation) fires immediately, because a
 * confirm on an idempotent verb is friction that teaches the reader the
 * confirm means nothing.
 *
 * DENY-BY-DEFAULT: every id NOT named here is two-press. The failure mode of
 * a stale entry is OVER-confirmation (a safe action asking twice), never
 * under-confirmation — an action registered tomorrow is protective by
 * default until someone reads what it does and says otherwise. The live
 * registry guards this on BOTH arms in
 * tests/cockpit/instruments-registry-truth.test.ts: every id named here
 * must really be served (a stale entry reds by name), and the set's EXACT
 * MEMBERSHIP is asserted there, sorted and complete — so a served action
 * can never silently change class without the guard naming it.
 */
const SINGLE_PRESS_ACTIONS: ReadonlySet<string> = new Set([
  // "Force an awareness refresh and recompute aggregates" — recomputes, discards nothing.
  "awareness.refresh",
  // "Read the most recent audit log rows" — a read.
  "bias.readAudit",
  // "Trigger one memory retrieval (for testing)" — a measured probe, discards nothing.
  "context.retrieveMemory",
  // "Run a syntax validation pass over a synthetic snippet" — computes a verdict, changes nothing.
  "editor.validateSyntax",
  // "Rerun all enabled quality checks" — recomputes the findings that exist.
  "quality.recheck",
]);

/** The two-press question, answered for one served action id. */
export function isTwoPressAction(actionId: string): boolean {
  return !SINGLE_PRESS_ACTIONS.has(actionId);
}

/** Every id judged single-press — exported so the live-registry guard can
 * hold the judgment against the real field (a stale entry that outlives its
 * action reds by name). */
export function safeActionIds(): readonly string[] {
  return [...SINGLE_PRESS_ACTIONS];
}

/** The fold's confirm face — the word an armed destructive verb wears, the
 * same spelling the recycle confirm uses (a second chance that still shows
 * the resting label teaches nothing). */
export const ACTION_CONFIRM_FACE = "confirm";

/** One armed action — the fold holds ONE slot, exactly like the armed edit. */
export type ActionArm = Readonly<{ id: string; armedAt: number }>;

/**
 * One press of a served action verb. Pure, so a test can press it without
 * the room: a first press ARMS (the face changes, nothing fires); a second
 * press of the SAME id inside the settle/window pair fires; a different id
 * re-arms, and so does a press outside the window. The recycle confirm's
 * rule (rooms/recycle-confirm.ts) is the precedent; the windows are the
 * fold's own (instruments-config.ts), not reached across rooms.
 */
export function takeActionPress(
  prev: ActionArm | null,
  next: Readonly<{ id: string }>,
  now: number,
): Readonly<{ arm: ActionArm | null; fire: boolean }> {
  const armed: ActionArm = { id: next.id, armedAt: now };
  if (prev === null || prev.id !== next.id) {
    return { arm: armed, fire: false };
  }
  const elapsed = now - prev.armedAt;
  if (elapsed < ACTION_ARM_SETTLE_MS || elapsed > ACTION_ARM_WINDOW_MS) {
    return { arm: armed, fire: false };
  }
  return { arm: null, fire: true };
}

/**
 * Why an action verb cannot fire from the fold RIGHT NOW, or null when it
 * can. An action that declares REQUIRED arguments cannot be executed by a
 * bare press — the wire door would refuse it with `action arg "…" is
 * required` — so the verb says so up front instead of wearing a working
 * label that can only ever fail. Stated, never silent (§1.2).
 */
export function requiredArgNames(action: ActionEntry): readonly string[] {
  if (action.args === undefined) return [];
  return Object.entries(action.args)
    .filter(([, decl]) => decl.required)
    .map(([name]) => name);
}

/** The action verb's stable locator — `actions/<served id>`, derived, never
 * hand-listed. */
export function actionVerbId(actionId: string): string {
  return `actions/${actionId}`;
}

/**
 * One action result, compacted to the fold's answer line: the real JSON the
 * action's own execute returned, truncated honestly with an ellipsis past
 * the fold's cap (a result longer than the line is still the result — the
 * fold is not the place to dump it, and nothing about it is invented here).
 */
export function compactActionResult(result: unknown, cap: number): string {
  let text: string;
  try {
    text = JSON.stringify(result) ?? "null";
  } catch {
    return "the action ran but its result is not showable as text";
  }
  return text.length > cap ? `${text.slice(0, Math.max(0, cap - 1))}…` : text;
}
