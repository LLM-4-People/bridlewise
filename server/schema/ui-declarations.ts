/**
 * UI declarations — the canonical UI surface vocabulary (the "schema
 * entries").
 *
 * THIS is the file you edit to declare a surface. The schema builder
 * (`ui-schema.ts`) merges these with the live exposure metadata (signals,
 * actions, customizations) and serves the combined schema at
 * `GET /api/schema/ui`.
 *
 * The menu/panel/widget vocabulary is GONE: those arrays described the old
 * tab-bar shell, nothing read them but that shell, and MODULES is the
 * vocabulary that superseded them. The wire keeps their (empty) fields for
 * one release window — see the builder's note.
 *
 * `when` clauses are optional visibility predicates evaluated against the
 * UI context (run, project, chat, streaming, route, ...). See
 * `shared/when-eval.ts`.
 */

import type { ModuleEntry } from "../../shared/module-contract.ts";
import type { SettingEntry, ActionEntry } from "../../shared/ui-schema.ts";

// ── Modules (the surface vocabulary) ──
//
// A Module declares everything about a surface: where it lives, how its data
// is obtained, how it ranks for attention, what it links to, and how deep it
// can be drilled. Adding a surface is adding one of these — no component to
// register unless it wants a bespoke view, no route unless it needs a Block.
//
// Authored modules land here; the exposure generator (which synthesises a
// module per registry namespace) is merged in by the schema builder.
//
// ── WHY EXACTLY TWO MODULES DECLARE A `read` SOURCE ──
//
// A `read` binding is a claim that the surface's data arrives through
// `broker.read()`, which is the ONLY place provenance is captured. The claim
// is what `ModuleHost` stamps as the module's `data-prov` key, so a binding
// declared on a surface that fetches by another door would point LENS at a
// record describing a DIFFERENT request than the one that produced the pixels
// — a plausible origin that is not the origin, which is worse than none.
//
// The Broker's module-bound callers today are LENS and the coverage panel;
// every other surface still fetches through `src/client.ts`. So:
//
//   - the `sys.*` exposure modules stay unbound. They declare
//     `signals`, and signals never cross `broker.read()` at all.
//   - the folded-in surfaces below (projects, conversation summary, checks,
//     inspector, live agents) stay unbound for the same reason: their
//     components read client stores fed by `src/client.ts`.
//
// Coverage rises only when a surface genuinely changes how it fetches.
// Raising it by declaration alone would move the number without moving the
// architecture, which is the one thing a coverage ratchet must never reward.
export const MODULES: readonly ModuleEntry[] = [
  // ── The fold-in: the old shell's side panels, as ordinary modules ──
  //
  // The permanent projects sidebar and the observability right panel were the
  // old navigation-first shell surviving at the edges of the field: they
  // duplicated what field modules show (conversation facts, checks, timeline)
  // and kept project selection in a frame the field could not arrange. Each is
  // now ONE module — placed, ranked, folded, drilled and linked exactly like
  // everything else. Their gates are DATA-BOUND (`project`, `chat`, `run`),
  // never route-bound: they exist when their subject exists, on every screen.

  // PROJECTS — the publisher. The one surface that writes the project/chat
  // selection (`ProjectList.svelte` calls `selectProject`/`selectChat`), which
  // is what every `reactsTo` below is reacting to. Declaring `selects` here
  // keeps the bond two-ended now that the sidebar panel entry is gone.
  {
    id: "entities.projects",
    title: "Projects",
    icon: "folder",
    group: "entities",
    order: 0,
    sources: [],
    render: { view: "projects-module", viewFromTier: 2, home: 3 },
    relevance: {
      base: 0.6,
      // No projects at all is the one state where this module IS the call to
      // action, so it must not fold: the empty state carries the open/create
      // button. `emptyWhen` is deliberately absent.
      learn: true,
    },
    selects: ["projectId", "chatId"],
    keepAlive: true,
  },
  // CONVERSATION SUMMARY — the exchange economics of the open chat (tokens,
  // speed, time writing). Distinct from the chat module, which carries the
  // transcript; this is the meter beside it. Gated on a chat EXISTING.
  {
    id: "converse.summary",
    title: "Conversation summary",
    group: "converse",
    order: 1,
    when: "chat",
    sources: [],
    render: { view: "conversation-summary", viewFromTier: 2, home: 3 },
    relevance: {
      base: 0.4,
      emptyWhen: "scalars.tokens == 0",
      learn: true,
    },
    reactsTo: ["chatId"],
    keepAlive: true,
  },
  // AUTO-CHECKS — quality checks for the active project + conversation.
  // URGENCY IS DECLARED: a failing check floors the module at maximum
  // relevance, which the field plan turns into "can never fold, ordered
  // first, never reduced below its fact card" (mutation-tested invariant).
  {
    id: "checks.auto",
    title: "Auto checks",
    icon: "check",
    group: "workspace",
    order: 2,
    when: "project",
    sources: [],
    render: { view: "auto-check-panel", viewFromTier: 2, home: 3 },
    relevance: {
      base: 0.4,
      emptyWhen: "scalars.total == 0",
      urgentWhen: "scalars.failing > 0",
      learn: true,
    },
    reactsTo: ["projectId", "chatId"],
    keepAlive: true,
  },
  // EVENT INSPECTOR — the compact per-conversation event list. The Timeline
  // module carries the full swimlane; this is the conversation-scoped feed,
  // so it exists only while a chat does.
  {
    id: "trace.inspector",
    title: "Event inspector",
    group: "trace",
    order: 3,
    when: "chat",
    sources: [],
    render: { view: "timeline-inspector", viewFromTier: 2, home: 3 },
    relevance: {
      base: 0.35,
      emptyWhen: "scalars.events == 0",
      learn: true,
    },
    reactsTo: ["projectId", "chatId"],
    keepAlive: true,
  },
  // LIVE AGENTS — helper lifecycle for the active run. Gated on `run` (the
  // same gate its old right-panel entry declared) so it appears when there is
  // something to show. A failed helper is urgent — it must not fold behind a
  // healthy-looking field.
  {
    id: "agents.live",
    title: "Live helpers",
    group: "agents",
    order: 4,
    when: "run",
    sources: [],
    render: { view: "agent-panel", viewFromTier: 2, home: 3 },
    relevance: {
      base: 0.45,
      emptyWhen: "scalars.total == 0",
      urgentWhen: "scalars.failed > 0",
      learn: true,
    },
    keepAlive: true,
  },
  // LENS — the provenance instrument. Authored as a MODULE rather than a
  // legacy panel because it is the first surface whose data genuinely comes
  // through the Block/Broker path, so it is also the worked example of what a
  // `kind: "read"` binding looks like. It claims no exposure entries: LENS
  // measures the registry, it does not own part of it.
  {
    id: "sys.lens",
    title: "Lens",
    icon: "metrics",
    group: "system",
    order: 90,
    sources: [
      {
        key: "recorder",
        kind: "read",
        block: "lens.recorder",
        ttlMs: 15_000,
      },
    ],
    render: { view: "lens-panel", home: 3, viewFromTier: 3 },
    relevance: { base: 0.2, learn: true },
  },
  // COVERAGE — the system's honest self-knowledge (DARKFIELD + ANNUNCIATOR).
  // The SECOND surface whose data genuinely crosses `broker.read()`: its
  // panel fetches both blocks through the Broker, so these `read` bindings
  // are true claims, and LENS can explain its pixels. No icon: like the
  // exposure modules it has no distinguishing mark, and the rail draws its
  // name instead.
  {
    id: "sys.coverage",
    title: "Coverage",
    group: "system",
    order: 91,
    sources: [
      { key: "darkfield", kind: "read", block: "coverage.darkfield", ttlMs: 15_000 },
      { key: "annunciator", kind: "read", block: "coverage.annunciator", ttlMs: 15_000 },
    ],
    render: { view: "coverage-panel", home: 3, viewFromTier: 3 },
    relevance: { base: 0.2, learn: true },
  },
];

// ── Settings (UI-declared; backend customizations are merged in by the builder) ──
// UI-specific settings that are not backend customizations. Backend
// customizations registered by the backend are appended automatically by
// buildUiSchema() from the live exposure registry.

export const SETTINGS: readonly SettingEntry[] = [];

// ── Actions (UI-declared; backend actions are merged in by the builder) ──
// UI-specific actions that are not backend exposure actions. The "New
// project" action opens the project-create modal (frontend handles the
// route). Backend exposure actions (55) are appended automatically.

export const ACTIONS: readonly ActionEntry[] = [
  {
    id: "new-project",
    label: "New project",
    description: "Open the create-project dialog.",
    icon: "plus",
    order: 0,
  },
];

// ── The aggregated declarations object ──

export type UiDeclarations = Readonly<{
  readonly modules: readonly ModuleEntry[];
  readonly settings: readonly SettingEntry[];
  readonly actions: readonly ActionEntry[];
}>;

export const UI_DECLARATIONS: UiDeclarations = Object.freeze({
  modules: MODULES,
  settings: SETTINGS,
  actions: ACTIONS,
});
