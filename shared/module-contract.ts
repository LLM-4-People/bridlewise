/**
 * The MODULE contract — one declaration per surface, shared server↔client.
 *
 * A Module is the unit of UI capability. Its EXISTENCE is declared here as
 * pure serialisable data (server-owned, so the schema pipeline, `when-eval`,
 * `/api/schema/ui` and every prevention test can see it). Its RENDERING is a
 * separate client-side registry mapping `moduleId → { project, view? }`.
 *
 * That split is deliberate. Putting the whole declaration client-side would
 * fork ownership away from `server/schema/ui-declarations.ts`; putting the
 * projection function server-side would make it unserialisable. Splitting by
 * KIND rather than by file keeps one source of truth for "what exists" while
 * letting `project()` stay a pure function in a `.ts` file — which is what
 * makes it Worker-eligible and prevents it capturing a store or touching the
 * DOM.
 *
 * @see DESIGN-SPEC-GRAVITY-WELL §2
 * @see DESIGN-SPEC-BLOCKS-ADDENDUM — the Block contract this pairs with
 */

/**
 * The density ladder. The SAME module renders at every tier; the tier decides
 * how much of it you see, not which component you get.
 *
 * t0 glyph · t1 chip · t2 card · t3 panel · t4 inspector
 *
 * This is what makes "show data when we need it, but allow us to go very
 * deep" one mechanism rather than two: depth is a position on the ladder, not
 * a different screen.
 */
export type Tier = 0 | 1 | 2 | 3 | 4;
export const TIERS: readonly Tier[] = Object.freeze([0, 1, 2, 3, 4]);

/** A module's health/activity, used for the pip and for relevance. */
export const STATUSES = ["empty", "idle", "pending", "active", "warn", "error"] as const;
export type Status = (typeof STATUSES)[number];

/**
 * The typed selection bus — one key per linkable entity kind.
 *
 * This is the shared vocabulary that makes brush-and-link possible: a module
 * declares what it `selects` and what it `reactsTo`, and the bus wires them
 * without either module knowing the other exists. Without a closed key set,
 * linking degenerates into ad-hoc component-to-component coupling.
 */
export const SEL_KEYS = [
  "projectId", "chatId", "runId", "turnId", "messageId",
  "file", "symbol", "modulePath", "cluster",
  "toolName", "toolCallId", "eventId", "agentId",
  "checkId", "memoryId", "signalId",
  "timeRange", "asOf",
] as const;
export type SelKey = (typeof SEL_KEYS)[number];

/** How a module's data is obtained. */
export const SOURCE_KINDS = ["read", "stream", "signals", "store", "derive"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * One data dependency of a module.
 *
 * `block` names a registered Block rather than a free-text endpoint path. A
 * path string can point at a route that does not exist and nothing notices
 * until runtime; a block id is checked by a prevention test against the block
 * registry, so a dangling binding cannot ship.
 */
export type SourceBinding = Readonly<{
  /** Local name; `project()` reads `raw[key]`. */
  key: string;
  kind: SourceKind;

  // kind: "read" — an HTTP GET through the Broker (cached, deduped, batched)
  /** Registered block id, e.g. `"code.graph"`. */
  block?: string;
  /** Params, `$sel.<SelKey>` interpolated from the selection bus. */
  params?: Readonly<Record<string, string>>;
  /** Cache lifetime; the Broker's default applies when absent. */
  ttlMs?: number;
  /** Bus events that invalidate this read, e.g. `"run:done"`, `"index:ready"`. */
  invalidateOn?: readonly string[];
  /** Fetch priority. `visible` when absent. */
  priority?: "critical" | "visible" | "idle";
  /** Cursor pagination. */
  page?: Readonly<{ limit: number; cursorParam: string }>;

  // kind: "stream" — a channel on the single multiplexed SSE connection
  channel?: string;
  /** Sibling source key used for a cold start before the first frame. */
  seed?: string;

  // kind: "signals" — zero requests; reads the signal stream directly
  /** Signal ids or globs, e.g. `"awareness.*"`. */
  ids?: readonly string[];

  // kind: "store" — an existing client store
  storeId?: string;

  // kind: "derive" — other modules' readouts
  from?: readonly string[];
}>;

/** An additive relevance term, applied while its predicate holds. */
export type Boost = Readonly<{
  /** Predicate in the shared when-eval language. */
  when: string;
  /** 0..1, additive. */
  weight: number;
  /** `sticky` holds until the predicate clears; `decay` fades. Default sticky. */
  hold?: "sticky" | "decay";
}>;

/**
 * How a module earns space.
 *
 * Relevance is a DEVIATION from the user's density dial, never a replacement
 * for it — the user sets the baseline, relevance moves a module around it.
 * That ordering is what keeps an adaptive rail from feeling like it is
 * fighting you.
 */
export type RelevanceSpec = Readonly<{
  /** 0..1 resting mass. */
  base: number;
  /** When true, the module has nothing to say: penalised and tier-clamped. */
  emptyWhen?: string;
  /** When true, the module floors at maximum relevance. */
  urgentWhen?: string;
  boosts?: readonly Boost[];
  /** How fast a decaying boost fades. */
  decayMs?: number;
  /** Whether usage frequency contributes a small learned term. Default true. */
  learn?: boolean;
}>;

/** How a module is drawn at each tier. */
export type RenderSpec = Readonly<{
  /** Component-registry key for the module's own view. */
  view?: string;
  /** Lowest tier at which `view` mounts. Below it, generated tiers render. */
  viewFromTier?: 2 | 3;
  /** Component key for the t4 inspector. A generated inspector when absent. */
  inspector?: string;
  /** Tier floor. Default 0. */
  min?: Tier;
  /** Tier ceiling. Default 4. */
  max?: Tier;
  /** Tier at a neutral dial with neutral relevance. */
  home: Tier;
  /** Pixel floor below which `view` will not mount. */
  minPx?: Readonly<{ w: number; h: number }>;
  /** Shape hint for the generated body. */
  distribution?: "time" | "categorical" | "numeric";
}>;

/** Unbounded drill-down: what a record is, and how it is titled and linked. */
export type DrillSpec = Readonly<{
  /** e.g. `"module"`, `"timeline.event"`, `"signal"`. */
  recordType: string;
  /** Crumb + deep-link key. */
  idParam: string;
  /** Title template, e.g. `"$record.path"`. */
  title: string;
}>;

/**
 * What a module claims from the exposure registry.
 *
 * Claims are EXCLUSIVE: two modules may not claim the same signal. That is
 * what lets a coverage test assert every registered signal, action and
 * setting has exactly one home — the mechanical meaning of "expose
 * everything". An unclaimed entry is not an error; it falls to its generated
 * module. A doubly-claimed entry is.
 */
export type ExposeSpec = Readonly<{
  signals?: readonly string[];
  actions?: readonly string[];
  settings?: readonly string[];
}>;

/**
 * One navigation group: its id, and OPTIONALLY the word it is called.
 *
 * A label is declared ONLY where the editorial name is not a restatement of
 * the id. `converse` is called "Chat" and `trace` is called "Timeline" because
 * those are the words the product uses for those surfaces — and no derivation
 * can invent a word the vocabulary does not contain. Every other group's name
 * IS its id spelled for a human, so declaring it would be a second copy of the
 * id that can drift from the first.
 */
export type ModuleGroupDeclaration = Readonly<{
  id: string;
  /** The editorial name. Absent → derived from `id` by `humanizeId`. */
  label?: string;
}>;

/**
 * The groups the navigation rail is built from — the single declaration.
 *
 * `MODULE_GROUPS` (the closed id vocabulary every consumer already checks
 * against) is DERIVED from this list rather than written beside it, so the ids
 * exist exactly once.
 */
const GROUP_DECLARATIONS = [
  { id: "entities" },
  // "Converse" is what a derivation produces from `converse`; "Chat" is what
  // the surface is called. The label exists precisely for this gap.
  { id: "converse", label: "Chat" },
  { id: "trace", label: "Timeline" },
  { id: "code" },
  { id: "workspace" },
  { id: "agents" },
  { id: "system" },
  { id: "memory" },
  { id: "extend" },
] as const satisfies readonly ModuleGroupDeclaration[];

/** The group declarations, widened so `label` is readable on every entry. */
export const MODULE_GROUP_DECLARATIONS: readonly ModuleGroupDeclaration[] =
  Object.freeze(GROUP_DECLARATIONS);

export type ModuleGroup = (typeof GROUP_DECLARATIONS)[number]["id"];

/** The closed id vocabulary, derived from the declarations. */
export const MODULE_GROUPS: readonly ModuleGroup[] = Object.freeze(
  GROUP_DECLARATIONS.map((g) => g.id),
);

/**
 * A group id, spelled for a human — the FALLBACK when no label is declared.
 *
 * `some-new-group` → `Some new group`, `brandNewThing` → `Brand New Thing`.
 * This is what keeps a group added tomorrow rendering sensibly with no edit
 * anywhere: a missing label degrades to a derived one rather than to a blank
 * or to the raw id.
 */
export function humanizeId(group: string): string {
  const spaced = group.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").trim();
  if (spaced.length === 0) return group;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The name to show for a navigation group: DECLARED first, derived otherwise.
 *
 * The single owner of that resolution. Any consumer that wrote `label ??
 * humanize(id)` itself would be a second place the precedence lives, and the
 * two would eventually disagree about which wins.
 */
export function groupLabel(group: string): string {
  const declared = MODULE_GROUP_DECLARATIONS.find((g) => g.id === group)?.label;
  return declared !== undefined && declared.length > 0 ? declared : humanizeId(group);
}

/**
 * A module declaration — everything the system needs to place, populate,
 * rank, link and drill a surface.
 *
 * This is the whole authoring surface. Adding a surface is adding one of
 * these; there is no component to register unless the module wants a bespoke
 * view, and no route to write unless it needs a new Block.
 */
export type ModuleEntry = Readonly<{
  /** `namespace.name`, e.g. `"code.graph"`. */
  id: string;
  title: string;
  /**
   * The mark that IDENTIFIES this surface — declared only when one exists.
   *
   * Optional, and deliberately without a default. A module that has no
   * distinguishing mark declares none; it is then drawn with its NAME instead
   * (see `src/lib/module/tier.ts::RAIL_UNMARKED_MIN_TIER`), which is the whole
   * point of the glyph tier being a tier and not a requirement.
   *
   * The alternative — giving every module of a class the same icon so the
   * field can stay required — is what this optionality exists to prevent. It
   * shipped: eleven generated exposure modules and the authored Lens module
   * all declared `icon: "metrics"`, so at normal density the rail drew twelve
   * identical bar charts in a column. A glyph shared by twelve surfaces
   * identifies none of them; it is placeholder data wearing an icon's
   * clothes, and doctrine 4 prohibits exactly that.
   */
  icon?: string;
  group: ModuleGroup;
  order: number;
  /** Hard visibility gate in the shared when-eval language. */
  when?: string;
  sources: readonly SourceBinding[];
  render: RenderSpec;
  relevance: RelevanceSpec;
  /** Selection keys this module publishes when the user picks something. */
  selects?: readonly SelKey[];
  /** Selection keys this module re-projects in response to. */
  reactsTo?: readonly SelKey[];
  exposes?: ExposeSpec;
  drill?: DrillSpec;
  /**
   * Whether the module keeps its state when it loses focus. Default TRUE.
   *
   * The current shell destroys and remounts a panel's entire subtree on every
   * tab change, which restarts the graph simulation, re-fires blocking git
   * calls and resets file-tree expansion. Keep-alive is the default because
   * discarding that work is the exception, not the norm.
   */
  keepAlive?: boolean;
  /** Set by the exposure generator. Never authored by hand. */
  synthesized?: boolean;
}>;

// ── Readout: what a module's pure projection returns ────────────────────────

/** One labelled value in a generated card. */
export type Facet = Readonly<{
  label: string;
  value: string | number;
  status?: Status;
  /** Links the facet back to its signal, enabling provenance. */
  signalId?: string;
}>;

/**
 * The ANSWER a module leads with — the current fact, in plain words.
 *
 * The headline is what a first-time user reads before anything else, so it
 * obeys three rules that are enforced mechanically
 * (`tests/prevention/readout-projection-owner.test.ts`):
 *
 * 1. It is a MEASURED fact or an honest absence ("declared, not yet live"),
 *    never a fabricated or padded value.
 * 2. It is plain language: no internal ids (`sys.*`, `legacy.*`, snake_case
 *    tokens) and no registry vocabulary. The module's NAME is a subtitle,
 *    not the headline.
 * 3. `asOf` is the timestamp OF THE FACT (epoch ms, measured — e.g. the last
 *    event's wall time), never `Date.now()` at projection time. Renderers
 *    derive "2m ago" from it; baking the relative string into the data would
 *    make an unchanged fact look changed every time the clock ticked.
 */
export type Headline = Readonly<{
  value: number | string;
  /** What `value` counts, completing the sentence: `3` + `"checks failing"`. */
  unit?: string;
  delta?: number;
  /** A short plain-language qualifier after the fact, e.g. `"3 turned off"`. */
  note?: string;
  /** When the fact was measured (epoch ms). Omitted when no honest time exists. */
  asOf?: number;
}>;

/**
 * The result of a module's pure `project(raw)` function.
 *
 * `Readout` drives the GENERATED tiers (0–2) and the generated table and
 * inspector. A module with a bespoke `view` still returns one, because the
 * glyph and chip tiers are generated for every module — that is what lets the
 * rail show forty modules at once without forty hand-written miniatures.
 *
 * It is deliberately NOT responsible for t2 on every surface: a transcript, a
 * dependency graph and a diff cannot be reduced to a facet grid without
 * becoming a statistical summary of themselves. Those declare `viewFromTier`
 * and render a real, smaller instance instead.
 *
 * THE EQUALITY CONTRACT (binding on every readout producer)
 *
 * An unchanged fact must produce an IDENTITY-EQUAL readout: consumers detect
 * "changed since you last saw it" by `===`, so a projection that allocates a
 * fresh object with identical values every recompute would mark every module
 * eternally changed — or force deep-compares into every consumer. Two
 * readouts are "the same fact" exactly when `readoutEquals` (below) says so;
 * the projection host (`src/lib/module/projections/stable.ts`) is the single
 * owner that turns value-equality into identity-equality, and the guard
 * mutation-tests it.
 */
export type Readout = Readonly<{
  status: Status;
  headline: Headline;
  spark?: "line" | "step" | "bar" | "binary" | "none";
  /** Ring buffer for the sparkline; transferable across the Worker boundary. */
  series?: Float32Array;
  /** Badge pip count on the glyph. */
  count?: number;
  /** 2–6 rows → the generated t2 card. */
  facets?: readonly Facet[];
  /** → generated t3 table + t4 inspector. */
  records?: readonly Readonly<Record<string, unknown>>[];
  /** Which record field is the stable identity. */
  recordKey?: string;
  /** Values the relevance predicates read. */
  scalars?: Readonly<Record<string, number | string | boolean>>;
}>;

/** A module's pure projection: raw source data → readout. No stores, no DOM. */
export type ProjectFn = (raw: Readonly<Record<string, unknown>>) => Readout;

// ── Readout equality: the single definition of "the same fact" ─────────────

/** Structural equality for facet rows (every field participates). */
function facetEquals(a: Facet, b: Facet): boolean {
  return (
    a.label === b.label &&
    a.value === b.value &&
    a.status === b.status &&
    a.signalId === b.signalId
  );
}

/** Shallow equality over a scalar/record map (`Object.is` per key). */
function recordEquals(
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Whether two readouts describe THE SAME FACTS — the equality contract
 * consumers' change-detection is built on.
 *
 * Comparison depth, per field:
 * - `status`, `headline.*`, `spark`, `count`, `recordKey`: by value.
 * - `scalars`: shallow (`Object.is` per key) — scalars are primitives.
 * - `facets`: element-wise by field — facet rows are flat.
 * - `series`: by content (`Float32Array` element compare).
 * - `records`: element-wise SHALLOW — a record whose nested objects are
 *   rebuilt with equal values but fresh identity counts as CHANGED, so
 *   producers must reuse record objects for unchanged rows. That is a
 *   producer obligation, not a consumer risk: erring this way can only
 *   over-report change, never hide one.
 */
export function readoutEquals(a: Readout, b: Readout): boolean {
  if (a === b) return true;
  if (a.status !== b.status) return false;
  const ha = a.headline;
  const hb = b.headline;
  if (
    ha.value !== hb.value ||
    ha.unit !== hb.unit ||
    ha.delta !== hb.delta ||
    ha.note !== hb.note ||
    ha.asOf !== hb.asOf
  ) {
    return false;
  }
  if (a.spark !== b.spark || a.count !== b.count || a.recordKey !== b.recordKey) return false;
  if (!recordEquals(a.scalars, b.scalars)) return false;
  const fa = a.facets;
  const fb = b.facets;
  if (fa !== fb) {
    if (fa === undefined || fb === undefined || fa.length !== fb.length) return false;
    for (let i = 0; i < fa.length; i += 1) {
      if (!facetEquals(fa[i]!, fb[i]!)) return false;
    }
  }
  const sa = a.series;
  const sb = b.series;
  if (sa !== sb) {
    if (sa === undefined || sb === undefined || sa.length !== sb.length) return false;
    for (let i = 0; i < sa.length; i += 1) {
      if (sa[i] !== sb[i]) return false;
    }
  }
  const ra = a.records;
  const rb = b.records;
  if (ra !== rb) {
    if (ra === undefined || rb === undefined || ra.length !== rb.length) return false;
    for (let i = 0; i < ra.length; i += 1) {
      if (!recordEquals(ra[i]!, rb[i]!)) return false;
    }
  }
  return true;
}

// ── Defaults, applied in one place ─────────────────────────────────────────

/** Tier bounds and keep-alive resolved, so no consumer re-derives them. */
export function resolveRender(render: RenderSpec): Readonly<{
  min: Tier; max: Tier; home: Tier; viewFromTier: 2 | 3;
}> {
  return Object.freeze({
    min: render.min ?? 0,
    max: render.max ?? 4,
    home: render.home,
    viewFromTier: render.viewFromTier ?? 3,
  });
}

/** Whether a module keeps its state when it loses focus (default true). */
export function keepsAlive(entry: ModuleEntry): boolean {
  return entry.keepAlive ?? true;
}
