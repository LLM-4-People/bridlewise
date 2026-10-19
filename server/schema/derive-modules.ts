/**
 * Module generators — the modules nobody authors by hand.
 *
 * `MODULES` in `ui-declarations.ts` holds AUTHORED modules. One more source
 * is merged by the schema builder: `deriveExposureModules()` synthesises one
 * module per registry namespace from the live signals/actions/customizations.
 * This is how "expose everything" happens by GENERATION rather than by
 * hand-writing a component per capability: a new backend signal appears on
 * screen with no frontend work at all.
 *
 * (The other generator, the legacy MENUS/PANELS bridge, is gone with the
 * arrays it projected — the migration window it existed for is over.)
 *
 * Generated output is marked `synthesized: true`. Authored modules always
 * win a collision, so converting a surface is: write the real module, and
 * the generated one disappears.
 */

import { humanizeId, type ModuleEntry } from "../../shared/module-contract.ts";
import { listActions, listCustomizations, listSignals } from "../kernel/canonical.ts";

/** Namespace of a dotted exposure id (`search.threshold` → `search`). */
function namespaceOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * The generated module's visible NAME, made distinguishable by derivation.
 *
 * `humanizeId(ns)` alone produced titles that COLLIDE with surface modules:
 * two cards both named "Memory" (the memory registry namespace beside the
 * memory panel), two named "Tools" — a zero-knowledge failure, because two
 * identically-named cards with different content cannot be told apart
 * without prior knowledge. The disambiguating word is DERIVED from what the
 * module claims (its declaration shape), never from a per-namespace label
 * table: a namespace registered tomorrow names itself, and a namespace that
 * claimed only actions would say so. `module-title-collision-owner.test.ts`
 * holds the resulting title set collision-free against the live schema.
 */
function exposureTitle(
  ns: string,
  claims: Readonly<{ signals: string[]; actions: string[]; settings: string[] }>,
): string {
  const noun =
    claims.signals.length > 0 ? "signals" : claims.actions.length > 0 ? "actions" : "settings";
  return `${humanizeId(ns)} ${noun}`;
}

/**
 * Synthesise one module per exposure namespace.
 *
 * This is the mechanism behind "expose everything": the registry holds 110
 * signals, 55 actions and 88 customizations across 11 namespaces, and today
 * they are reachable only through one collapsible section at the bottom of a
 * tab hidden behind a hamburger. Generated modules give each namespace a first
 *-class home, and a capability registered tomorrow gets one automatically.
 *
 * The generated module has NO bespoke view: it renders through the generated
 * tiers from its readout, which is exactly the case the density ladder exists
 * to serve.
 */
export function deriveExposureModules(): readonly ModuleEntry[] {
  const namespaces = new Map<
    string,
    { signals: string[]; actions: string[]; settings: string[] }
  >();
  const bucket = (ns: string) => {
    let b = namespaces.get(ns);
    if (b === undefined) {
      b = { signals: [], actions: [], settings: [] };
      namespaces.set(ns, b);
    }
    return b;
  };

  for (const s of listSignals()) bucket(s.module || namespaceOf(s.id)).signals.push(s.id);
  for (const a of listActions()) bucket(a.module || namespaceOf(a.id)).actions.push(a.id);
  for (const c of listCustomizations()) bucket(c.module || namespaceOf(c.id)).settings.push(c.id);

  const out: ModuleEntry[] = [];
  let order = 0;
  for (const [ns, claims] of [...namespaces.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({
      id: `sys.${ns}`,
      // The shared id→human-name derivation, plus a claim-derived noun so the
      // namespace card can never share a visible name with the surface module
      // whose word it borrows ("Memory signals" beside "Memory").
      title: exposureTitle(ns, claims),
      // NO ICON, deliberately.
      //
      // `icon: "metrics"` stood here: one hardcoded mark for an entire class
      // of generated modules. It is the doctrine-2 failure in miniature — a
      // per-class constant where the class has eleven members and grows
      // whenever a namespace appears — and on screen it was worse than
      // abstract, because at normal density the rail collapses a module to its
      // glyph, and eleven namespaces collapsed to eleven identical bar charts.
      //
      // There is no honest replacement. A per-namespace icon table would be
      // the same hardcoded mirror with more rows, and it cannot be derived:
      // `awareness`, `bias`, `hallucination`, `safety` and `learning` have no
      // mark in the vocabulary, and inventing near-identical abstract glyphs
      // for them would rebuild the defect out of subtler parts. So the module
      // declares what is true — it has no distinguishing mark — and the rail
      // draws its NAME, which distinguishes it perfectly.
      group: "system",
      order: order++,
      sources: [
        {
          key: "signals",
          kind: "signals",
          // Glob over the namespace: a signal added to it later is picked up
          // with no edit here, which is the whole point of generating.
          ids: [`${ns}.*`],
        },
      ],
      render: {
        // No bespoke view — the generated tiers render from the readout.
        home: 1,
        distribution: "numeric",
      },
      relevance: {
        base: 0.25,
        // A namespace whose signals are all at rest shrinks to a glyph rather
        // than rendering a wall of zeros — the specific failure the current
        // observability panel exhibits.
        emptyWhen: "scalars.active == 0",
        learn: true,
      },
      exposes: {
        signals: claims.signals,
        actions: claims.actions,
        settings: claims.settings,
      },
      keepAlive: true,
      synthesized: true,
    });
  }
  return Object.freeze(out);
}

/**
 * Merge authored, legacy and generated modules.
 *
 * Precedence: AUTHORED wins over generated. Converting a surface therefore
 * means writing the real module — the generated one vanishes on the next
 * build with no deletion step and no window where both render.
 */
export function mergeModules(
  authored: readonly ModuleEntry[],
  ...generated: readonly (readonly ModuleEntry[])[]
): readonly ModuleEntry[] {
  const byId = new Map<string, ModuleEntry>();
  for (const group of generated) {
    for (const m of group) byId.set(m.id, m);
  }
  for (const m of authored) byId.set(m.id, m);
  return Object.freeze([...byId.values()].sort((a, b) => a.order - b.order));
}
