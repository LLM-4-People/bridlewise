/**
 * Sweep categories — the event→category mapping and the §12.3 palette.
 *
 * §12.3: "Event categories get a fresh 8-hue wheel at equal lightness …
 * mapped from the EVENT_KINDS + ledger category vocabulary by a single
 * table in tokens.css." That single table LANDED (src/cockpit/tokens.css:
 * `--cat-turn/tool/effect/check/finding/steer/anomaly/heal`, OKLCH 0.72 /
 * 0.10, hues ≥40° apart). This module consumes it: each sweep category
 * resolves, in order,
 *   1. `--cat-<sweepId>` — so if the tokens owner later grows ledger-named
 *      entries (`--cat-lifecycle`, `--cat-transport`, …) they win with zero
 *      sweep changes;
 *   2. the wheel slot the category BORROWS (the `borrows` column) — llm /
 *      tool / effect / safety alias semantically, the four ledger-mass
 *      categories (lifecycle/user/context/transport) borrow the remaining
 *      four hues (a naming gap for the tokens owner, not a colour drift:
 *      all 8 hues stay the ONE wheel);
 *   3. a hex fallback COMPUTED from the owner's declared OKLCH (the wheel's
 *      hue is read out of tokens.css at build time, and the sRGB fallback is
 *      converted from it — no second table to keep in step) — used only
 *      where no stylesheet resolves (tests, bare harness).
 *
 * NO `@harness/*` value imports (client-bundle rule — see
 * shared/event-types.ts header): the raw event-type vocabulary is string-
 * keyed here, and tests/cockpit/sweep-categories.test.ts round-trips the
 * server registry (via server/canonical.ts) against this table so a new
 * backend event type cannot silently fall through.
 */

import type { SweepCategoryId, SweepEvent } from "./types";
import { EVENT_KINDS } from "../../../shared/event-types";
import { TOKEN_FALLBACKS } from "../paint/design-tokens.ts";

export type SweepCategoryInfo = Readonly<{
  id: SweepCategoryId;
  label: string;
  /** OKLCH hue (degrees) on the landed §12.3 wheel. */
  hueDeg: number;
  /** The landed tokens.css entry this category reads. There is ONE wheel —
   * the tokens.css `--cat-*` declarations — and the category's own name is
   * the ledger-named alias of the wheel slot it borrows (documented per
   * row). A `--cat-<id>` of its own lands the day the wheel grows
   * ledger-named entries, and this field becomes that name with no edit
   * here. */
  cssVar: string;
  /** The wheel slot this category borrows — the tokens.css `--cat-*` name
   * whose declared hue dresses it today. */
  borrows: `--cat-${string}`;
  /** sRGB of the landed OKLCH (0.72 / 0.10 / hue) — stylesheet-less
   * fallback only (tests, bare harness), DERIVED from the wheel's declared
   * hue at module load rather than restated as a second copy. */
  fallbackDark: string;
}>;

/**
 * The §12.3 wheel's declared geometry — the shape of every `--cat-*` token.
 * The values below are consumed by the canvas in a browser (no build-step
 * read of the CSS file is possible from a shipped bundle), so they are
 * DECLARED here and the sweep-categories test re-derives each one FROM
 * tokens.css's own OKLCH and asserts the two agree — the single source of
 * truth is enforced mechanically, not by memory.
 */
const WHEEL_LIGHTNESS = 0.72;
const WHEEL_CHROMA = 0.1;

/**
 * OKLCH → sRGB, the reference conversion (Björn Ottosson's public-domain
 * derivation, reimplemented here so the fallback is a COMPUTATION from the
 * declared wheel rather than a second table someone must keep in step).
 * Used ONLY for the stylesheet-less fallback; the browser resolves the real
 * `oklch()` itself when a stylesheet is present.
 */
function oklchToSrgbHex(l: number, c: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = Math.cos(h) * c;
  const b = Math.sin(h) * c;
  // OKLCH → OKLab is (l, a, b) directly; OKLab → linear sRGB:
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  const toSrgb = (x: number): number => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  const hex = (x: number): string => toSrgb(x).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}



/** The single category table (order = stack order in the skyline, bottom
 * up). Stack order is stable so the band reads consistently at every zoom.
 *
 * The wheel slot each category borrows is the tokens.css `--cat-*` name in
 * the `borrows` column; the hue and the sRGB fallback are DERIVED from that
 * declaration, never restated. `cssVar` stays the ledger-named alias (the
 * future per-ledger entry point), so a sweep bin reads `--cat-lifecycle`
 * first and the borrowed wheel slot second — one table, one wheel. */
export const SWEEP_CATEGORIES: readonly SweepCategoryInfo[] = Object.freeze(
  (
    [
      { id: "lifecycle", label: "Run milestones", borrows: "--cat-finding", hueDeg: 65 },
      { id: "user", label: "Your turns", borrows: "--cat-steer", hueDeg: 20 },
      { id: "llm", label: "Model turns", borrows: "--cat-turn", hueDeg: 250 },
      { id: "tool", label: "Tool calls", borrows: "--cat-tool", hueDeg: 210 },
      { id: "context", label: "Context & memory", borrows: "--cat-heal", hueDeg: 295 },
      { id: "transport", label: "Usage & cost", borrows: "--cat-check", hueDeg: 110 },
      { id: "effect", label: "Files & system work", borrows: "--cat-effect", hueDeg: 160 },
      { id: "safety", label: "Safety & quality", borrows: "--cat-anomaly", hueDeg: 340 },
    ] as const
  ).map((c) => {
    return Object.freeze({
      id: c.id,
      label: c.label,
      hueDeg: c.hueDeg,
      cssVar: `--cat-${c.id}`,
      borrows: c.borrows,
      fallbackDark: oklchToSrgbHex(WHEEL_LIGHTNESS, WHEEL_CHROMA, c.hueDeg),
    });
  }),
);

export const SWEEP_CATEGORY_IDS: readonly SweepCategoryId[] = Object.freeze(
  SWEEP_CATEGORIES.map((c) => c.id),
);

/**
 * Raw ledger event-type token → sweep category. Key set mirrors the closed
 * `TIMELINE_EVENT_TYPES` registry (drift-guarded by the test, which imports
 * the registry server-side). Unknown tokens fall back to "effect" — the
 * honest floor the old timeline used, and the drift guard fails until the
 * table catches up, so the fallback is a floor, not the expected path.
 */
const EVENT_TYPE_CATEGORY: Readonly<Record<string, SweepCategoryId>> = Object.freeze({
  // lifecycle
  run: "lifecycle",
  agent: "lifecycle",
  task: "lifecycle",
  subtask: "lifecycle",
  // turns
  message: "user",
  turn: "llm",
  provider: "llm",
  // tools
  tool: "tool",
  "tool-input": "tool",
  "tool-output": "tool",
  // context / memory
  context: "context",
  memory: "context",
  // transport
  header: "transport",
  token: "transport",
  cost: "transport",
  timing: "transport",
  resource: "transport",
  // the browser lane: the page's own measurements ride the measurement
  // category; its uncaught errors are the safety ridge's client half.
  "client-metric": "transport",
  "client-error": "safety",
  // effects
  "file-effect": "effect",
  test: "effect",
  git: "effect",
  commit: "effect",
  tag: "effect",
  checkpoint: "effect",
  rollback: "effect",
  artifact: "effect",
  network: "effect",
  process: "effect",
  filesystem: "effect",
  db: "effect",
  ledger: "effect",
  permission: "effect",
  success: "effect",
  // the engine lane: measured engine function calls through the hub ride
  // the effect lane with db/process/network — harness work a request
  // performed.
  engine: "effect",
  // safety / quality (quality + promotion from the closed registry; the
  // EVENT_KINDS inline vocabulary maps below)
  quality: "safety",
  promotion: "safety",
  // `error` events ride the safety lane; whether one feeds the ridge is the
  // spectrum predicate (isErrorEvent), never the type name.
  error: "safety",
});

/** The inline-event vocabulary (shared/event-types.ts) — all safety. */
const EVENT_KIND_SET: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

export function sweepCategoryFor(eventType: string): SweepCategoryId {
  const mapped = EVENT_TYPE_CATEGORY[eventType];
  if (mapped !== undefined) return mapped;
  if (EVENT_KIND_SET.has(eventType)) {
    // hallucination / steering / bias / self-healing / error / ui_control
    return eventType === "ui_control" ? "lifecycle" : "safety";
  }
  return "effect";
}

/**
 * An event IS a failure exactly when the engine spectrum's error row would
 * count it — outcome `failed` OR a recorded error code, whatever the event
 * type. The spectrum (the band's preferred source and the counting-policy
 * owner) reads `failed || error_code` over the raw ledger columns, so the
 * client fallback mirrors that predicate verbatim: the two binning paths
 * must agree on the same ledger rows, or the caption a chat shows depends
 * on which source served it. A denied inline account (a gate-block's
 * `error` event, outcome denied, no error code) is therefore NOT an
 * incident on either path — parented or not — and a `failed` or
 * error-coded event is an incident on both. Never guessed, never widened:
 * event-type shapes and error categories are display vocabulary, not
 * failure verdicts.
 */
export function isErrorEvent(e: Readonly<{
  outcome: string | null;
  errorCode?: string | null | undefined;
}>): boolean {
  return e.outcome === "failed" || (e.errorCode !== undefined && e.errorCode !== null);
}

/** Structural input: the fields of `TimelineEventRecord` the sweep reads.
 * Also matches the lighter shapes (a `TimelineRef` plus nulls). */
export type SweepSourceRecord = Readonly<{
  eventId: string;
  eventType: string;
  wallTime: string;
  outcome: string | null;
  errorCode?: string | null;
  errorCategory?: string | null;
  runId: string | null;
  turnId?: string | null;
  parentEventId?: string | null;
  description?: string;
}>;

/**
 * Project a real ledger record to a SweepEvent. Returns null when wallTime
 * does not parse — an unplottable event is DROPPED and counted by the
 * caller, never given an invented time (no fake pixels).
 */
export function toSweepEvent(r: SweepSourceRecord): SweepEvent | null {
  const timeMs = Date.parse(r.wallTime);
  if (!Number.isFinite(timeMs)) return null;
  return Object.freeze({
    eventId: r.eventId,
    timeMs,
    category: sweepCategoryFor(r.eventType),
    isError: isErrorEvent({ outcome: r.outcome, errorCode: r.errorCode }),
    eventType: r.eventType,
    outcome: r.outcome ?? null,
    errorCode: r.errorCode ?? null,
    runId: r.runId ?? null,
    turnId: r.turnId ?? null,
    parentEventId: r.parentEventId ?? null,
    description: r.description ?? "",
  });
}

// ── Palette resolution ──

export type SweepPalette = Readonly<{
  categories: Readonly<Record<SweepCategoryId, string>>;
  /** §12.2 — the error ridge color. */
  alarm: string;
  /** §12.2 — the ONE live hue: now edge, head, ribbons. */
  beam: string;
  /** §12.1 — band housing / band ground / hairline / ink. */
  ground1: string;
  ground2: string;
  line1: string;
  ink2: string;
  ink3: string;
}>;

/**
 * The non-wheel fallbacks. These are PINNED PROJECTIONS of the token
 * owner's dark declarations, read from TOKEN_FALLBACKS (the one JS table at
 * the paint door) rather than restated here. The sweep-categories test
 * re-reads the owner's value for each name and asserts the two agree. They
 * exist only for stylesheet-less environments (tests, a bare harness); the
 * browser always resolves the real token first.
 */
const PALETTE_FALLBACKS_DARK = Object.freeze({
  alarm: TOKEN_FALLBACKS["--alarm"],
  beam: TOKEN_FALLBACKS["--beam"],
  ground1: TOKEN_FALLBACKS["--ground-1"],
  ground2: TOKEN_FALLBACKS["--ground-2"],
  line1: TOKEN_FALLBACKS["--line-1"],
  ink2: TOKEN_FALLBACKS["--ink-2"],
  ink3: TOKEN_FALLBACKS["--ink-3"],
});

/**
 * Resolve the palette through a `readVar` function (component passes
 * `getComputedStyle`-backed lookup; tests pass a stub). tokens.css wins when
 * present — ledger-named var first, then the landed alias — with the
 * spec-computed hex fallbacks last (stylesheet-less environments only).
 */
export function resolveSweepPalette(
  readVar: (name: string) => string,
): SweepPalette {
  const pick = (cssVar: string, fallback: string): string => {
    const v = readVar(cssVar).trim();
    return v.length > 0 ? v : fallback;
  };
  const categories = {} as Record<SweepCategoryId, string>;
  for (const c of SWEEP_CATEGORIES) {
    categories[c.id] = pick(c.cssVar, pick(c.borrows, c.fallbackDark));
  }
  return Object.freeze({
    categories: Object.freeze(categories),
    alarm: pick("--alarm", PALETTE_FALLBACKS_DARK.alarm),
    beam: pick("--beam", PALETTE_FALLBACKS_DARK.beam),
    ground1: pick("--ground-1", PALETTE_FALLBACKS_DARK.ground1),
    ground2: pick("--ground-2", PALETTE_FALLBACKS_DARK.ground2),
    line1: pick("--line-1", PALETTE_FALLBACKS_DARK.line1),
    ink2: pick("--ink-2", PALETTE_FALLBACKS_DARK.ink2),
    ink3: pick("--ink-3", PALETTE_FALLBACKS_DARK.ink3),
  });
}
