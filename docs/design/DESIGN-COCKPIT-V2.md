---
layout: default
title: 'DESIGN — COCKPIT V2'
---

# DESIGN — COCKPIT V2

**The complete UI reimagining. Nothing from the current UI is reused — not one component, not one layout, not one page.**

This spec is written to be handed to build agents verbatim. Where a builder could choose, the choice is made here. Where a capability does not exist yet, the section is marked **NEEDS-BACKEND** with the exact shape of the need. Marks: **BUILD-NOW** (phase 1–2), **BUILD-NEXT** (phase 3–4), **NEEDS-BACKEND** (blocked until the named block/action exists — design is final, wiring waits).

---

## 0. The verdict this answers, and the standing law

The user's verdict, condensed to its charges, each with the structural answer in this spec:

| Charge | Structural answer | Section |
|---|---|---|
| "still see the old ui: metrics, stats at the top, right menu, git, login page" | The old component tree is **deleted at cutover**. No page called Metrics, no right rail, no login form, no git panel exists in V2. | §13 |
| "sidebar of rows / tiles above and below / chat not full width" | One shell grammar: FLOW · SWEEP · DESK · HORIZON · ROOMS · SCOPE. There are no tiles, no sidebars, no floating chips. The conversation is the full-bleed center. | §2, §3 |
| "tiles not the same size, not clear, maybe there's better than tiles" | Tiles are abolished as a category. Where uniform cells are genuinely right (the Instruments room), every cell is the **same fixed size by mechanical test**. | §2.6, §8 |
| "we don't care about data if we cannot act on it" | **No verb, no pixels.** A fact renders by default only if it carries an operable verb or an abnormal state. Everything else lives behind ask/zoom. | §1.2 |
| "buttons doing nothing useful" | Every control in this spec names the block action it POSTs. A control without a wired action is forbidden by guard. | §1.2, §14 |
| "not interesting or interactive, no life, feels like an informational dashboard" | The system **visibly computes**: findings authored by the computer dock into the flow at the moment of relevance; the bead runs the causal edge; the sweep ticks with real events. | §1.3, §4, §11 |
| "navigating to a project/conversation is not very clear" | One gesture: the Switch — full-screen, recency-ordered, type-to-filter, every row carrying measured facts and verbs. | §5 |
| "timeline is identical, I asked for novel ways" | The timeline list is deleted. The record is the **SWEEP** (persistent flight-recorder band) + **semantic-zoom** into causal trees + the **ARM** retro-trigger. | §6 |
| "graphs loading all broken, things loading after everything else" | **One-reveal boot**: fixed geometry first paint, one coordinated fill, and a mechanical guard that nothing mounts late. A chart may render only with ≥2 measured points. | §8.3, §10 |
| "options everywhere, no consolidated" | Settings exist in exactly two forms: **adjust-in-place** (from the pixel where the behavior manifests) and **one flat searchable index**. No settings pages per feature. | §9 |

### The three binding principles (equal weight)

1. **THE SPINE.** The conversation/run is the product; everything else is instrumentation around the living run. Full-bleed when active. The causal flow of a run visibly moves through the instruments.
2. **ACTION-FIRST.** Every fact carries its verb, adjacent and operable. Every verb has a real effect (a named block action). No data display without its action; no button without an effect.
3. **THE SYNTHESIS.** Raw facts are the floor. Surfaces earn their place by deriving what no single source contains — aggregate, match, extrapolate (honestly labeled), compute on demand — with the derivation stated and inspectable.

### What survives (and only this)

- **Non-UI substrate**: the contracts (`contracts/*.ts`), the Block registry and Broker, the data functions, the nanostores state layer, the recording lattice (ambient causality, `traceId` in every envelope), the exposure registry (110 signals / 55 actions / 88 customizations), the when-eval language, and the data-honesty guards (no-fabricated-data, readout headline rules, envelope causality tests).
- **Concepts, re-expressed in new components**: the density ladder (as manifestation levels, §2.6), keep-alive, drill-in-place, semantic zoom, LENS (its data layer survives; its overlay is redesigned in §9.2), selection bus (`SelKey`), optimistic writes, targeted patches.
- **Disciplines, re-justified**: chromatic pixels carry meaning and chrome does not (§12 re-derives this from the dark-cockpit literature, with a new palette); skeletons at exact final geometry; no fake motion; reduced-motion as a first-class mode.
- **Nothing visual.** No component, token file, type scale, or layout region from `src/lib/**` appears in V2. See §13 for the cutover.

---

## 1. The operating rules (mechanically enforced)

### 1.1 The honest-data law (inherited, restated)

Nothing fabricated, ever. Absence renders as absence, in plain words ("not measured yet", "collecting since 14:02"). Every number is a measured number with an `asOf`. Projections are permitted **only** with their derivation sentence attached (§4.4). Plain zero-knowledge language everywhere: no internal ids, no registry vocabulary, no git nouns in first position.

### 1.2 No verb, no pixels

A fact earns default pixels only if at least one of:
- it carries an **operable verb** (a wired block action, rendered adjacent), or
- it is in an **abnormal state** (its own declared thresholds), or
- the user **asked** for it (pinned it, or asked via the desk).

Everything else exists — reachable through ask (§4.5), the Instruments room (§8), and LENS — but does not sit on screen. This is the High-Performance HMI result (40–60% faster operator response on quiet-by-default surfaces) applied as a rendering precondition, and it is the honest form of "we don't care about data we cannot act on."

**Guard (new, cockpit-native):** `tests/prevention/cockpit-verb-owner.test.ts` — every interactive element in `src/cockpit/**` must reference a registered block action id or a client navigation primitive; a `<button>` without one fails CI.

### 1.3 The computer speaks in findings

Derived facts (aggregate / match / extrapolation) are authored by "the computer" and render as **findings**: a distinct typographic register (§12.5), a `∴` gutter mark, a derivation one level deep behind LENS, and the verb where one exists. A finding may never state what a single source already states — it must join, count, compare, or project. §4 specifies the engine.

### 1.4 One manifestation per fact per screen

A fact renders in exactly one place at a time. Pinned monitors (§2.5) are *references* to the single source, and open their source on click. This kills the duplicate-tile disease structurally.

**Guard:** `cockpit-manifest-owner.test.ts` — signal ids rendered in the FLOW may not simultaneously render in HORIZON except via the monitor reference component.

---

## 1.5 THE FEEL — acceptance criteria every surface must satisfy

The user's bar, verbatim: *"the ux must feel very smart and adaptive, show whats most important, it must feel like its alive and reactive to both the data and the user, it must be interesting to use and dynamic."* Concretized as four testable qualities. Every surface section below must deliver all four (the matrix at the end of this section is the checklist); where a surface honestly cannot deliver one, it says so and why.

**F1 — Smart & adaptive.** The surface reorganizes around *computed* importance: synthesis and the admission controller decide prominence; dark-cockpit discipline decides what earns color and size. "Show what's most important" means the system decides — and the decision is always explainable: LENS on any prominent element states *why it is prominent* in plain words with its inputs ("expanded: it caused the beat you're focused on" / "annunciating: crossed its declared threshold 40s ago"). Unexplained salience is a bug, mechanically: any component that sets prominence must pass a `reason` prop; `cockpit-salience-owner.test.ts` fails a prominence change without one.

**F2 — Alive & reactive to the data.** Real activity visibly moves through the UI as it happens: beats appended as they stream, the bead traversing recorded edges, the sweep's now edge ticking, breakers glowing during their calls, digits rolling on true change. Nothing pulses that didn't happen (the no-fake-motion guard, §11.8), and everything that happens registers within the latency budget — **a spec-level requirement builders inherit, enforced in CI**:

| Budget | Bound |
|---|---|
| keystroke → paint | < 16ms |
| action → visible acknowledgement | < 100ms (optimistic; same frame for press states) |
| any view/room/scope open | < 200ms |
| live event → its beat/tick on screen | < 100ms from frame receipt |
| finding → docked at its seam | < 300ms from the seam event |

**F3 — Reactive to the user.** Attention and intent change the surface: hover deepens (adds precision, provenance, previews — never mere highlight); focus arms verbs (the focused beat's verbs move to full contrast and onto the home keys `.` and `,`); a selection rescopes every consuming surface at once through the selection bus; the composer's `/` grammar scopes to the focused object first; and recorded use shapes defaults honestly — the computer surfaces the verb you habitually take at the moment you usually take it (`∴ You ran checks after your last 5 edits — run checks now`, from `insight.habit`), and says exactly that when asked. Manual choices always beat computed ones and are remembered (§3.2 fisheye, §4.6 dismissal learning).

**F4 — Interesting & dynamic.** The interest is power: operating a live system mid-flight (breakers and interventions at quantized boundaries), a computer that visibly derives and speaks at the right moment, retro-capture of anything because everything was recorded, and depth everywhere (every fact opens; every number is a handle). Motion has meaning or does not exist. No decoration budget exists; the fun budget is spent on responsiveness, verbs, and discovery.

**The matrix** (how each surface delivers; builders verify per row):

| Surface | F1 smart/adaptive | F2 alive to data | F3 reactive to user | F4 interesting/dynamic |
|---|---|---|---|---|
| FLOW (§3) | causal fisheye with stated reasons; check *deltas* not states | beats stream in; bead runs recorded edges | focus arms verbs; expand/collapse remembered; selection lights ribbons | every beat opens; verbs on the past (rerun, rewind, fork) |
| DESK (§3.4–3.5) | strips ordered by token share; abnormal-only summaries when closed | live gauges; executing tool glows; strips re-measure per turn | `,` opens any row's setting; breaker flips take effect at next boundary | mixing the model's next turn; mid-run breaker flips |
| COMPUTER (§4) | admission controller ranks findings; dismissals retrain it | findings dock <300ms of their seam event | `?` grammar; dismissals learned; habit verbs at their moment | the system thinking alongside you — the core of F4 |
| SWITCH (§5) | recency river; outcome lines rank what mattered | micro-sweeps are real densities; badges from live state | type-to-filter <50ms; stable spatial grouping | reels tell what happened there; replay from start |
| SWEEP/ARM (§6) | error ridge and flags stand out only when real | now edge ticks per event; backfill on boot | scrub = time travel everywhere; zoom to any depth; `m` marks | arming traps; retroactive capture; causal chains lighting |
| CUSTODY (§7) | parcels grouped by producing run; unattributed honestly separate | updates on real fs/git events | keep/undo per parcel or file; suggested message from your own words | undo at run granularity; history joined to conversations |
| INSTRUMENTS (§8) | dark by default; abnormal cells are the only colored ones | signals stream; digits roll on true change | pin to HORIZON; `ask` prefills the question; adjust in place | every number is a handle into ledger + setting |
| SETTINGS/LENS (§9) | index ranks by recently-manifested surfaces | values read back live after write | adjust from the pixel; search by behavior words | **honestly limited F4**: an index's job is consolidation, not delight — its interest is that you rarely need it |
| REGISTRATION (§10) | **honestly limited F1**: boot is a fixed probe sequence; its adaptivity is compression (fast system → 3 lines, 200ms) | every line is a measured probe; sweep backfills with real history | typing during boot buffers into the composer, never lost | the record surfacing right-to-left — once per session, earned |

---

## 2. The shell grammar — FLOW · SWEEP · DESK · HORIZON · ROOMS · SCOPE

**[Brief §8 — the layout system. Decision: committed.]** Not a spatial canvas (user-arranged canvases decay into janitorial work and entropy — the documented failure of Muse-class tools). Not stage-and-wings (wings re-grow into the rail we just killed). The commitment is a **single-column instrument stack**: everything is either *in the flow*, *on one of three fixed instruments*, or *in a summoned room*. The user never manages layout. Layout is computed from the run's causal structure.

```
┌──────────────────────────────────────────────────────────────────────┐
│ HORIZON  40px   identity · place · annunciators (≤3) · monitors (≤4) │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ FLOW     flex   the run — full-bleed block stream                    │
│                 prose at measure (76ch, centered)                    │
│                 instruments + effects bleed to full width            │
│                 findings docked at causal seams                      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ SWEEP    48px   flight recorder — the whole ledger, always visible   │
├──────────────────────────────────────────────────────────────────────┤
│ DESK     64px   where you act: composer · gauges · breakers grip     │
│          ↕ 280px when opened (channel strips + breaker panel)        │
└──────────────────────────────────────────────────────────────────────┘
ROOMS   full-screen, summoned, one at a time, Esc closes (Switch,
        Instruments, Custody, Settings index, Memory, Tools)
SCOPE   the inspector — right sheet min(560px, 42vw); at ≥1900px it
        side-docks and the FLOW narrows; below, it overlays
```

**Prior art & difference:** closest is Warp's block terminal (viewport = ordered typed blocks). Structural differences: (a) our stream is causal, not linear — blocks nest and reference by `parentEventId`; (b) three *fixed* instruments (HORIZON/SWEEP/DESK) frame the stream, none user-arranged; (c) rooms replace tabs/routes entirely.

### 2.1 The FLOW

Full-bleed vertical stream of the active conversation/run. Internal grid: a 76ch centered measure for prose (yours and the model's words), with **full-width bleed rows** for anything instrumental — tool beats, diffs, findings, gauges. This is the honest answer to "chat not taking the full width": text gets a readable measure (a 3840px-wide paragraph is worse, not better); *instruments* get every pixel. Nothing ever renders above or below the flow except the three fixed instruments.

### 2.2 The SWEEP (fixed, 48px)

The recording lattice made permanently visible — a horizontal density band of the entire ledger for the current scope. Specified in §6. It is one continuous instrument, not a strip of anything.

### 2.3 The DESK (fixed, 64px closed / 280px open)

Where all acting happens: the composer (one input, three grammars, §5.3), the context gauge, and the grip that opens the full desk — channel strips (CONTEXT DESK) and breakers (BREAKER PANEL). Specified in §3.4–3.5.

### 2.4 The HORIZON (fixed, 40px)

The only top chrome. Left: identity glyph (you, measured session) and **place** — `project ▸ conversation`, which is the Switch trigger. Center: **annunciator slots** — at most 3, priority-ordered, dark when healthy (a lit slot = a fact in abnormal state + its verb: `1 check failing · rerun`). Right: up to 4 **pinned monitors** (user-pinned live values, uniform 96×28px each) and the LENS toggle. No metrics strip, no logout button, no model selector parked here — model lives at the desk where sending happens; sign-out lives under the identity glyph.

### 2.5 ROOMS

Full-screen surfaces summoned by key or verb, never persistent, never side-docked: **Switch** (§5), **Custody** (§7), **Instruments** (§8), **Settings index** (§9), **Memory**, **Tools/Breakers full view**. One room at a time; Esc always returns to the flow; the flow's state is kept alive under it (keep-alive survives as a concept — re-implemented in the cockpit shell, not via any old component).

### 2.6 Manifestation ladder (the density ladder, re-expressed)

The `Tier 0–4` contract survives; its geometry is remapped. A module manifests as:

| Contract tier | V2 manifestation | Where |
|---|---|---|
| t0 | sweep badge / annunciator pip | SWEEP, HORIZON |
| t1 | pinned monitor (96×28, uniform) | HORIZON |
| t2 | finding / interstitial card (full-bleed row) | FLOW |
| t3 | room section | ROOMS |
| t4 | SCOPE sheet | SCOPE |

The relevance engine survives as the **finding admission controller** (§4.6) — it decides what may dock into the flow, with the same damping disciplines (dwell, hysteresis, budget), not as a rail re-orderer (there is no rail).

### 2.7 Geometry, breakpoints, density, keyboard

- Breakpoints: **≥1900** SCOPE side-docks (flow narrows to remaining width, min 720px) · **1440–1900** default · **1100–1440** bleed gutters 16px, SCOPE overlays · **<1100** SWEEP folds to 28px, desk strips stack vertically, monitors hide (annunciators stay).
- Density: `data-density` on `:root` — `scan | work | deep` remapping row height (24/28/34px) and the type step (§12.4). A desk setting, adjustable in place like everything else.
- Keyboard (complete grammar; every action reachable):

| Key | Action |
|---|---|
| `⌘K` or `/` in empty composer | command grammar in the composer (§5.3) |
| `⌘J` | the Switch |
| `⌘.` | open/close the desk (strips + breakers) |
| `⌘'` | Instruments room |
| `⌘,` | Settings index room |
| `⌘G` | Custody room |
| `[` `]` | sweep scrub back / forward (asOf) · `⇧[` `⇧]` by run |
| `Enter` on a beat | open its SCOPE · `Esc` close scope / close room / return to now |
| `↑↓` | move beat focus by causal order · `←→` collapse/expand a beat's children |
| `⌘⏎` | send · `i` focus composer |
| `.` on any focused fact | its verb menu · `,` on any focused fact | its setting (§9.1) |
| `⌘L` | LENS mode (explain any pixel) |
| `⌘⇧A` | ARM a trigger (§6.4) |

Roving tabindex through beats; every divider with full separator semantics; one global `:focus-visible` rule in the new token file.

**Mark: BUILD-NOW** (the shell is phase 1).

---

## 3. The spine — the FLOW, the DESK, the live run

**[Brief §1]**

### 3.1 Concept

The conversation is a **causal block stream**: one ordered, virtualized stream of typed *beats*. A beat is one causal fact: your words, the model's words, a tool call, a file effect, an inline event (hallucination/steering/bias/self-heal from `EVENT_KINDS`), a check delta, a finding. Beats carry their verbs on the surface (not behind hover-only affordances; hover *adds*, never *reveals-or-else*). Tool calls show their actual input → output transformation ("show the data"), not a status line — the recording already has both sides; no competitor can render this honestly.

During a live run, the causal flow is **visible motion**: the bead (§11.2) travels the real edge from the desk into the turn, branches into each tool beat as it opens, and lands on effects as they commit. The flow renders causality as it happens, not after.

### 3.2 Beat anatomy

Every beat, uniformly:

```
[gutter 32px] [body: measure or bleed] [verbs, right-aligned, visible at rest]
 gutter: causal spine line + beat glyph (per kind) + connection to parent
```

- **Your turn** — prose at measure. Verbs: `edit & resend` · `rewind here`.
- **Model turn** — prose at measure; reasoning stream as a collapsed fold with real token count. Verbs: `retry` · `copy`. Measured footer: `↑12,432 ↓3,104 tok · first word 820ms · 41 tok/s` (all measured, all from the envelope).
- **Tool beat** (bleed) — name in plain words, input → output as a two-cell transformation, duration, status. Verbs: `run again` · `open in scope` · `breaker` (jumps to that tool's breaker row, §3.5). While streaming: args render as they arrive (`append` patch ops), the beat is open by default and closes to a one-line summary on success — stays open on failure.
- **Effect beat** (bleed) — a file changed: path, `+42 −8`, micro-diff preview (first hunk). Verbs: `see what changed` (SCOPE diff) · `undo this` · `keep this` (§7). The effect beat **is** git status, relocated to the moment it happened.
- **Check delta beat** (bleed, computed) — appears only when a check's state *changed* during this turn: `lint: passing → failing (3 errors)` with verbs `rerun` · `open first error`. Never a static "checks: 2/3" block — deltas only; standing state lives in the annunciator.
- **Finding** — §4. `∴` gutter mark, computed sentence, derivation behind LENS, verb attached.
- **Inline event beat** — kind glyph + plain sentence; a hallucination event renders its `suggestion` as the primary verb (`apply correction`).

**Causal fisheye (concept transplant, DOI with an honest function):** beats collapse with causal distance from your focus — full beat → one-line ghost → tick in the gutter. The interest function is *explainable from the record* (causal distance + recency + abnormality), and every compressed beat states its reason on focus ("collapsed: 3 turns old, no effects"). `←→` expand/collapse manually; manual wins over automatic for the session. Closest prior art: fisheye source-code views (CHI 2006); difference: no geometric distortion, only representation change, and the DOI terms come from the causal ledger so "why is this big?" always has an answer.

### 3.3 Walkthrough — a run, second by second

1. You type "refactor the reader path" and hit `⌘⏎`. The beat appears instantly (optimistic); the bead leaves the desk gutter and enters it.
2. The model turn opens; words stream at measure. The desk gauges tick: context 61% → 62%, tok/s live.
3. A tool beat opens full-bleed: `read file — src/lib/data/reader.ts` — the bead forks into it; input path on the left cell; 4ms later the output cell fills (first 6 lines + fold). The beat closes to one line.
4. `edit file` opens; `+42 −8 · writing…` with args streaming. The BREAKER chip for `edit file` in the desk glows live (it is being used *now*).
5. The effect beat commits: `src/lib/data/reader.ts +42 −8` with `see what changed · undo this · keep this`. The sweep ticks — a new event mark appears at "now."
6. **The computer speaks**: `∴ This edit reaches 47 files through 12 imports — see them · run checks now` (computed from the existing impact block, docked at the seam within 300ms of the effect, §4.2).
7. A check delta beat: `typecheck: passing → failing (1 error) — rerun · open error`.
8. The run ends. The **turn seam** renders: a full-bleed hairline carrying the turn's measured rollup in one sentence (§4.3) — not a card, one line with verbs.

### 3.4 The CONTEXT DESK (integrated, not bolted on)

Open the desk (`⌘.`): the composer stays; above it, **channel strips** — one per context source of the *next* turn, mixing-desk style:

```
SYSTEM PROMPT   ████████░░  3,211 tok           [view] [pin]
MEMORIES (4)    ██░░░░░░░░    812 tok   [view] [pin] [mute]
HISTORY 12 turns█████████░  9,404 tok   trim point ▸ turn 4   [adjust]
FILES (2)       █░░░░░░░░░    488 tok   [view] [mute]
TOOL RESULTS    ███░░░░░░░  2,006 tok   [view] [mute]
────────────────────────────────────────────────────────────
NEXT TURN       15,921 / 100,000 tok · 16%      [model: … ▾]
```

Every bar is a **measured** share of the next composition (from the same composition math the server uses — served, not simulated). `pin` = always include; `mute` = exclude from the next turn; the trim point is draggable by turn. Per-turn provenance: any *past* turn's gutter glyph opens its recorded composition strips read-only in the SCOPE — what the model was actually given, from the ledger.

Closest prior art: Ableton's mixer / channel strips. Structural difference: channels are context sources with measured token cost, and the faders are real composition controls, recorded to the ledger when changed.

**NEEDS-BACKEND:** a `run.compose` block —
- read: `GET /api/b/run.compose?chatId=…` → `{ channels: [{ id: "system"|"memories"|"history"|"files"|"toolResults", tokens: number, items: [{id, label, tokens}] }], limit: number }` computed by the same code path that will assemble the next turn;
- actions: `run.compose/pin { channel, itemId }`, `run.compose/mute { channel, itemId?, turns?: 1 }`, `run.compose/trim { beforeTurn }` — each recorded as a ledger event.

### 3.5 The BREAKER PANEL (integrated, not bolted on)

Right half of the open desk: one row per available tool — **breaker rows**, uniform:

```
edit file     ● on    12 calls · last 3.2s   [off]
run command   ● on     4 calls · last 11ms   [off]
web fetch     ○ off    0 calls               [on]
search        ▲ tripped — 3 failures in a row [reset] [why]
```

- Flipping a breaker takes effect **at the next safe boundary** (the next tool-call decision point), never mid-call — the quantized-launch idea from live-performance software, which makes mid-run action safe by construction. The flip is optimistic, and the confirmation is the breaker's state chip observed from the run stream.
- **Trip conditions** are settings-in-place on the row (`,` on the row): auto-trip after N consecutive failures. A tripped breaker is an annunciator.
- The tool currently executing shows a live chip; clicking any tool beat's `breaker` verb scrolls the desk to that row.
- Closed-desk summary: the desk edge shows `tools 31/34` only when ≠ all-on, plus the live chip during calls. Dark when normal.

**NEEDS-BACKEND:** `tools.breaker` block — read: per-tool `{ id, label, state: "on"|"off"|"tripped", calls: number, lastMs?: number, lastError?: string }` for the current chat; actions: `tools.breaker/set { tool, on: boolean, at: "next-boundary" }`, `tools.breaker/reset { tool }`, `tools.breaker/arm { tool, tripAfterFailures: number }`. The run loop must honor `at: "next-boundary"` and record the flip as a ledger event with the acting user.

### 3.6 What this replaces

The chat panel, the transcript card, the tool accordions, the activity/timeline split, the run status widget, the steering queue, the tools page toggle list, the context gauge in the old header. All deleted.

### 3.7 Honest-data story

Every beat is a rendered ledger fact with `traceId` from the envelope. Streams render only received frames. The composition strips are served by the composing code path. Absent causality renders as visible absence (`unattributed` renders as its own mark, never hidden).

### 3.8 Build shape

New components (`src/cockpit/flow/`): `Flow.svelte` (custom height-indexed virtualizer — index beats by height, contents opaque, the Warp SumTree approach; the event log stays *outside* `$state`, only the visible window is reactive — this is the known Svelte 5 large-proxy trap), `Beat.svelte` + kind bodies (`TurnBeat`, `ToolBeat`, `EffectBeat`, `CheckDeltaBeat`, `EventBeat`, `FindingNote`), `Seam.svelte`, `Desk.svelte`, `ChannelStrip.svelte`, `BreakerRow.svelte`, `Composer.svelte`, `Bead.svelte`. Sources: the existing run stream channel + `trace` events via the Broker; blocks `run.compose`, `tools.breaker` (new), diffs via the existing git diff-patch route surfaced as a block.

**Mark: BUILD-NOW** (the spine is phase 1; compose/breaker actions land as their blocks land — render read-only from what exists rather than waiting).

---

## 4. The synthesis — the computer, and its findings

**[The third principle made concrete. This is the life of the product.]**

### 4.1 Concept

The system is not an observatory; it is a colleague that **shows its work**. Findings are computed sentences that join sources: ledger × checks × context × git × history. Each finding is: one sentence · `∴` mark · its verb(s) · its derivation one LENS-level deep (the exact join, in plain words, with counts). Because the causal ledger is complete, matching is **exact joins over recorded history** — honest pattern-matching, not model guessing. That is the unclonable version of "smart."

Closest prior art: IDE "insights" panels and observability anomaly feeds. Structural difference: findings are deterministic joins with mandatory derivations, docked at their causal moment in the spine, each carrying an operable verb — never a separate insights page, never a confidence score.

### 4.2 The four synthesis moves

1. **Aggregate** — cross-source rollups. `∴ This conversation: 6 files touched, 2 checks failing that passed before it started, 40% of context consumed.` Verbs: each clause is a handle (files → Custody, checks → rerun, context → desk).
2. **Match** — the present against the recorded past. `∴ 3 previous runs edited these same files — two needed follow-up fixes. see them` · `∴ You've turned this tool off in 4 of your last 5 runs. keep it off by default?` Exact joins on file paths, tool ids, check ids, error signatures across `traceId`s.
3. **Extrapolate, labeled** — deterministic projections with stated derivation. `∴ At this rate, context fills in ~12 messages — projection from your last 10 messages (avg 1,120 tok each). trim now · adjust` Never rendered without the derivation clause. Never a probability.
4. **Compute on demand** — §4.5: asking is a primary gesture at the desk.

### 4.3 Placement — findings dock at causal seams

Findings render **in the flow, at the moment of relevance**, at three seams only:
- **effect seam** — right after an effect beat (impact reach, match against past edits);
- **turn seam** — the one-line turn rollup (always present, always exactly one line);
- **desk line** — projections about the *next* turn (context fill, cost) render between the FLOW and the SWEEP, not in the flow. (User correction, July 2026: *"I want these messages to show above the timeline… not below"* — the row previously sat under the band, just above the composer. It is still outside the flow and below the reading position; only its neighbour changed. The band's reserved airspace stays on `.sweep-outlet` precisely because this row is a *sometimes* neighbour — padding on the row itself would vanish with the finding and put the risers back in the flow.)

Findings never interrupt streaming prose (they wait for the beat to close), never stack more than one deep per seam (the admission controller queues the rest behind a `+2 more` fold), and never push content the user is reading (they dock below the reading position or above the desk).

### 4.4 The derivation contract

Every finding carries, one LENS-level deep: the sources joined (as block/signal ids in plain words), the counts at each join step, and the `asOf` of the oldest input. Guard: `cockpit-derivation-owner.test.ts` — a finding component may not render without a machine-readable `derivation` prop; extrapolations must include the word "projection" and their input window.

### 4.5 Asking — the `?` grammar

The composer accepts three grammars (§5.3). `?` asks the computer, not the model: deterministic computed questions against the intelligence blocks that already exist (impact, path, reuse, retrieval) and the new insight blocks. `? what does this edit reach` → the impact answer as a finding, instantly, zero model tokens, derivation attached. `? runs that touched reader.ts` → a match listing with verbs (open, compare). The answer renders in the flow as a finding beat you can keep or dismiss. Autocomplete enumerates the askable questions from the block registry — the palette cannot lie about what's computable.

### 4.6 The admission controller

The relevance engine survives here: it scores candidate findings (base per kind + boosts from when-eval predicates), admits at most one per seam, applies dwell (a finding stays ≥8s before another may replace it at the desk line), and learns dismissals (a finding kind dismissed 3× in a session stops self-docking and retreats to ask-only — recorded, inspectable in the Instruments room).

### 4.7 What this replaces

The conversation-summary tile, the awareness/quality signal boards as passive walls, every "insight" that was a static stat. Deleted.

### 4.8 Honest-data story

Every finding is a deterministic function of ledger rows and block reads, reproducible from its derivation. If a join returns zero rows, no finding renders (absence of a finding is the honest output). Projections state their window and method inline. No finding ever uses a model.

### 4.9 Build shape

`src/cockpit/computer/`: `FindingNote.svelte`, `Derivation.svelte`, admission controller store (`computer.ts` — plain module, when-eval predicates, dwell timers). Client-computable now: turn rollups (from cached beats + checks state), context projection (measured tokens/message from the transcript). **NEEDS-BACKEND** for the joins:
- `insight.rollup` — read `?chatId` → `{ filesTouched: number, checksRegressed: [{id, from, to}], contextPct: number, tokensTotal: number, costIfPriced?: number }`, computed server-side from ledger + checks + composition; invalidateOn `run:done`.
- `insight.match` — read `?kind=files|tool|check&keys=…&scope=project` → `{ matches: [{ traceId, chatId, when: number, overlap: string[], outcome: { followUpFixes?: number, checksFailedAfter?: number } }] }` — exact joins over `event_log` by the declared keys, bounded (limit 5), with the join spelled in the response for the derivation.
- `insight.habit` — read `?kind=breaker|setting&key=…` → `{ occurrences: number, window: number, lastN: boolean[] }` from recorded settings/breaker events.

**Mark: BUILD-NOW for client-computable findings + the `?` grammar against existing intelligence blocks; NEEDS-BACKEND for the three insight blocks (exact shapes above).**

---

## 5. Navigation — the Switch and the one input

**[Brief §2]**

### 5.1 Concept

There is no sidebar, no project list page, no tab bar. Navigation is one full-screen room (**the Switch**) plus one command grammar in the composer. Places are *reels*: a conversation with its measured outcomes, not a row with a name.

### 5.2 The Switch (`⌘J`, or click the place in the HORIZON)

Full-screen room, instant (in-memory data). Layout: a single **recency river** — reels ordered by last activity, grouped under their project caps, newest at top-left, flowing left-to-right then down. Every reel is the **same fixed size** (grid cells 320×88px): name · relative time · one measured outcome line (`14 turns · 6 files · checks green` — from `insight.rollup`, or honest absence: `no runs yet`) · a 24px micro-sweep (that conversation's real event density). Verbs on the reel: `resume` (default, Enter) · `replay` (opens with the sweep scrubbed to start) · `custody` (its uncommitted work, if any — badge visible).

- Type anywhere: instant filter across project and conversation names (in-memory; sub-50ms or it's a bug — Linear's budget adopted as CI perf test).
- `⌘N` new conversation in the focused project; `⌘⇧N` new project (inline path field, validated against the fs block).
- Projects with many dead conversations: the river shows the latest 3 per project + `n more`, expandable in place. No 90-row wall, ever.
- Spatial stability: ordering is recency but **grouping is stable** (project caps hold position for the session) — spatial memory works only when the system pins positions.

Closest prior art: macOS Mission Control / Arc's space switcher. Structural difference: every cell carries measured run outcomes and verbs, and the micro-sweep is the real ledger density — a switcher that tells you *what happened there*, not just what it's called.

### 5.3 The one input (composer grammars)

The composer is the only text input in the shell. Three prefixes, mode chip renders as you type:
- *(plain)* — a message to the model.
- `?` — ask the computer (§4.5).
- `/` — commands: every registered block action, navigation, settings, with fuzzy match, current value inline for settings, and the keybinding taught on each row. `⌘K` from anywhere focuses the composer in `/` mode.

Closest prior art: Superhuman/Raycast palettes. Structural difference: the verb list is the self-enumerating block registry — the palette is *generated* from the same declarations the server executes, so it can neither lie nor go stale.

### 5.4 What it replaces / honest data / build shape

Replaces: the 25-row module sidebar, the projects panel, the constellation, the tab bar, breadcrumbs-as-navigation. Honest: outcome lines come from `insight.rollup` (absence: "no runs yet"); micro-sweeps from the spectrum block, never decorative. Build: `src/cockpit/rooms/SwitchRoom.svelte`, `Reel.svelte`, `MicroSweep.svelte` (one shared canvas painter with the SWEEP); `CommandGrammar.ts` + `GrammarMenu.svelte` in the desk. Sources: entities blocks (exist), `insight.rollup` (§4.9), spectrum (§6.6).

**Mark: BUILD-NOW** (Switch with honest absences before `insight.rollup` lands).

---

## 6. The flight recorder — SWEEP, semantic zoom, ARM

**[Brief §3 — not a list. The timeline list is deleted.]**

### 6.1 Concept

The ledger is always on screen as the **SWEEP**: a 48px full-width band above the desk — a time-binned density skyline of every recorded event in scope, drawn on one canvas. It is at once: proof the system is recording (the lattice, visible), the navigation instrument for time, and the trigger surface for forensics. The "timeline page" concept is abolished; depth comes from zooming *into* the sweep, not from a different screen.

### 6.2 Anatomy

- X = time (scope: this conversation by default; `⇧` widens to project). Y = event density, stacked by category color (§12.3), error ridge on top in `--alarm`.
- The **now edge** at the right, live-ticking as events record (real events only).
- **Flags**: marks dropped by ARM triggers (§6.4) and by you (`m` drops a mark at now).
- The **head**: hover shows a full-precision time ruler; click plants the head and sets global `asOf` — every asOf-reactive surface renders its state at that instant (the Chronoscope concept, re-expressed). `Esc` or clicking the now edge returns to live. While the head is planted, the sweep's left edge shows `viewing 14:02:11 — back to now`, and the FLOW scrolls to the containing beat.

### 6.3 Semantic zoom (the camera, without the canvas)

Scroll/pinch on the sweep zooms time. Zoomed out: runs are single blocks (skyline). Zoom in: a run opens into its **causal tree** — turns as bands, tool calls as nested ticks. Zoom further on any tick: it becomes a full beat preview; `Enter` opens the SCOPE on it. The layout at every zoom level is computed from the record — the user never places anything. DOM blocks render only near focus (~10–100), canvas carries the mass.

Closest prior art: video-editor timelines and tldraw's camera. Structural difference: one axis is always time (no 2D wandering, no lost-in-space), the representation changes with scale (semantic, not geometric), and zoom targets are causal structures from the ledger.

### 6.4 ARM — the retro-trigger

Because recording is complete, capture can be **retroactive**. `⌘⇧A` (or `,` on any check/tool/signal → "arm"): define a trigger from a small predicate menu (when-eval over live events/signals): `a check fails` · `any tool errors` · `context crosses 80%` · `file X is edited`. Armed triggers live on the sweep's left edge as cocked flags. When one fires:
- a flag drops at that instant on the sweep,
- a finding docks: `∴ Armed trigger fired: lint failed. capture ±30s · open at that moment`,
- `capture` pins a named range (the flag becomes a stored range over the ledger — nothing is copied; the record was already there; the range is a bookmark with a predicate attached).

Oscilloscope arm/trigger semantics on a software ledger — closest prior art is a scope's single-shot trigger; the structural difference is retro-capture is free because the "waveform" (the ledger) is always fully recorded.

### 6.5 Causal ribbons

Selecting any beat or sweep tick lights its **causal chain**: the gutter spine in the FLOW draws the parent path (run → turn → call → effect) in the beam color, and the sweep underlines the same instants. One chain at a time. This is brush-and-link reduced to the one linkage that matters: cause.

### 6.6 What it replaces / honest data / build shape

Replaces: the timeline page, the event list, the event-inspector panel (its content moves to SCOPE), rewind menus (rewind = a verb on your past turn beats). Honest: bins are server-counted rows; the now edge ticks only on received events; a paused stream renders a visible `stream reconnecting — last event 14:02:31` state on the sweep itself, never a frozen fake-live band. Build: `src/cockpit/sweep/` — `Sweep.svelte` (canvas painter + a parallel a11y outline listing runs/flags for AT), `SweepHead.svelte`, `ArmMenu.svelte`, `CausalRibbon.svelte` (SVG path in the flow gutter). **NEEDS-BACKEND:** `sweep.spectrum` block — read `?scope=chat|project&bins=1200` → per-bin counts per category + error count, packed (base64 Int16Array), plus `arm.flags` block (read stored flags/ranges; actions `arm/set {predicate}`, `arm/capture {t0,t1,label}`, `arm/clear {id}` — flags are ledger-backed). The head's asOf resolution needs ranged reads (`?until=` param) on history-bearing blocks — an additive, uniform block-read param.

**Mark: BUILD-NOW for the sweep band + head with a client-binned fallback over the already-streamed window; NEEDS-BACKEND for full-history spectrum + arm storage + `until` reads.**

---

## 7. Git → CUSTODY — status is verbs

**[Brief §4]**

### 7.1 Concept

Git nouns (stage, stash, HEAD, branch) never lead. The product speaks **custody of work**: every changed file is held by the run that produced it (an exact ledger join — effect events carry the file and the producing turn), and the three verbs are `keep` (commit), `undo` (revert), `see what changed` (diff). Custody appears in two places: on effect beats in the flow (§3.2 — the primary surface), and the **Custody room** (`⌘G`) as the consolidated view.

### 7.2 The Custody room

Full-screen, one column of **work parcels** — changes grouped by the producing conversation/turn (not by directory, not by staged-ness):

```
FROM THIS CONVERSATION · turn 7 · 14:02                       [keep all] [undo all]
  M src/lib/data/reader.ts   +42 −8      [see] [undo]
  M src/lib/data/broker.ts   +11 −0      [see] [undo]
FROM "fix flaky test" · yesterday                              [keep all] [undo all]
  M tests/reader.test.ts     +6 −6       [see] [undo]
NOT FROM A RECORDED RUN                                        [keep all] [undo all]
  M notes.md                 +2 −0       [see] [undo]
────────────────────────────────────────────────────────────────
SAVED WORK  ‹history as a run-correlated list: each save shows the
conversation that produced it›            [share this work ▸]
```

- `keep` opens one inline line: a suggested message **derived from the producing turn's own words** (quoted, labeled as such — `from your request: "refactor the reader path"`), editable, `⏎` commits. No modal.
- `undo` on a parcel = revert those files to their pre-run state; the confirmation states exactly what will be lost, measured (`discards +59 −14 across 3 files`).
- "NOT FROM A RECORDED RUN" is the honest bucket for outside edits — visibly unattributed, never guessed.
- Saved-work history is a list of commits each joined to its producing conversation (`∴` computed): click → the Switch reel for that conversation, or `see` the diff. `share this work` surfaces push/PR only if a remote is configured — otherwise the verb honestly does not render (§1.2).
- Branching is demoted to a `/` command (`/work on a new line`) — present, plain-worded, out of the room's face.

Closest prior art: GitHub Desktop / Tower. Structural difference: grouping key is the **producing run** via the ledger join — no other tool can group changes by the conversation that caused them, or revert at run granularity.

### 7.3 Honest data / build shape

All statuses are real reads; the run-attribution is the effect-event join, and files with no join render in the unattributed bucket. `undo` uses git checkout paths (no invented preimage store needed). Build: `src/cockpit/rooms/CustodyRoom.svelte`, `Parcel.svelte`, `DiffSheet.svelte` (SCOPE body, real unified diffs from the diff-patch route surfaced as a block). **NEEDS-BACKEND:** `custody.state` block — read → parcels as above (server does the ledger join effect-events × current `git status`); actions `custody/keep { files, message }`, `custody/undo { files }`, both recorded; `custody.history` read → commits × producing-chat join.

**Mark: BUILD-NEXT** (effect-beat verbs in the flow are BUILD-NOW via existing git routes; the room and the join block follow).

---

## 8. Metrics → honest instruments

**[Brief §5 — no broken charts, no space waste.]**

### 8.1 Concept

There is no metrics page. Measured numbers live where their verbs live: context at the desk, tok/s on the live turn, per-tool latency on breaker rows, check history on the check's own scope. The consolidated fallback is the **Instruments room** (`⌘'`) — the honest index of every measured signal, dark-cockpit style: quiet, uniform, actionable.

### 8.2 The Instruments room

A uniform grid of **instrument cells, all exactly 280×96px** (mechanical test), grouped by module, no gaps, no featured tiles:

```
┌ context utilization ────────┐┌ tool calls (this chat) ─────┐
│ 16%            ▁▂▂▃▃▄       ││ 12          ▂▁▄▂▃▅          │
│ asOf 14:02 · adjust · ask   ││ asOf 14:03 · breakers · ask │
└─────────────────────────────┘└─────────────────────────────┘
```

Each cell: plain-language name · current measured value · spark **only if ≥2 measured points exist** (with fewer, the measured value alone owns the readout — no chart, no placeholder, no empty axes, no broken chart can exist by construction; `collecting since 14:02` is the absence state of a cell with no sample yet) · `asOf` · up to two verbs resolved mechanically from the exposure registry (its bounding setting → adjust-in-place; its action → the verb; always `ask` → prefilled `?` query). Cells with no data render the honest absence state, same size. Signals stream over the existing signal channel; digits roll only on real change.

`pin` on any cell → it becomes a HORIZON monitor (uniform 96×28: name, value, spark-dot). Max 4; pinning a 5th asks which to displace.

### 8.3 The no-broken-chart law

A time series renders only from its measured ring buffer. No axis without data; no interpolation across gaps (gaps render as gaps); no chart placeholder states. Guard: `cockpit-chart-owner.test.ts` — the spark component throws in dev if fed <2 points, and the cell renders the absence state instead.

### 8.4 Replaces / honest data / build shape

Replaces: the metrics page, all 11 generated signal boards as separate surfaces, every stat tile, the header token counters (tokens now: turn footers, desk gauge, turn-seam rollups). Build: `src/cockpit/rooms/InstrumentsRoom.svelte`, `InstrumentCell.svelte`, `Spark.svelte` (one canvas painter shared with micro-sweeps), `Monitor.svelte` (HORIZON). Sources: the signal stream + exposure registry (exist). **Mark: BUILD-NEXT** (nothing here blocks the spine; monitors ship with HORIZON in phase 1).

---

## 9. Settings — in place, plus one index

**[Brief §6 — "options everywhere, no consolidated" → two surfaces total.]**

### 9.1 Adjust-in-place (the fact→verb rule applied to config)

Anywhere a behavior manifests, `,` (or the `·adjust` verb) opens the **setting sheet**: a one-setting SCOPE mini-sheet anchored to the fact — label, plain description, the control (drag-scrub numeral / segmented enum / switch), the current *measured* effect where one exists (`trip after 3 failures — tripped twice this week`), and `save` writes through the existing customization action, optimistically, recorded. The mapping fact→setting resolves mechanically from the exposure registry (`Facet.signalId` → `customizationId`), never hand-wired.

### 9.2 LENS, redesigned, gains "change this"

LENS survives as a concept and a data layer; its overlay is new: `⌘L` then hover — a single hairline callout (not a panel) naming the pixel's source (`signal context.utilization · 1.2s ago · via stream`), its derivation if computed (§4.4), and its verbs: `adjust` (the setting sheet) · `ask` · `open source`. LENS is now the universal answer to "why is this here and how do I change it."

### 9.3 The index (`⌘,`)

One flat, searchable room generated from the 88 customizations + cockpit-local preferences (density, reduced motion, sound opt-in, theme): every row = label · current value · inline control · which surface it manifests on (a link). Search by behavior words, not by internal names. No categories-as-pages, no per-feature settings screens, no duplicated controls: the index rows and the in-place sheets are the *same component* bound to the same action.

Replaces: the settings page(s), the client-debug section, scattered per-panel option menus. Honest: every row shows the value read back from the server after write (no silent overwrite). Build: `SettingSheet.svelte`, `SettingsRoom.svelte`, `LensCallout.svelte`. **Mark: BUILD-NEXT** (the setting sheet primitive early, since breaker/ARM rows use it).

---

## 10. Login + boot — REGISTRATION

**[Brief §7 — the first second is the product's character.]**

### 10.1 Concept

Boot and login are one continuous **registration sequence** — the instruments checking in, truthfully. No splash, no spinner, no form floating in a void, and no late pop-in ever.

### 10.2 Walkthrough — cold start, signed out

1. First paint (<100ms, static shell): the full cockpit geometry — HORIZON, empty FLOW, SWEEP band, DESK — in the ground palette, inert, at exact final geometry.
2. The registration column types itself down the center measure — real boot facts as they are measured, monospaced, each with its ms (`schema · 42ms` · `recording lattice · ready` · `index · 1,318 files`). These are actual readiness probes, not theater; on a warm cache the whole column may be 3 lines and 200ms, and that is the correct experience.
3. The column ends at the signature line: `sign in to open the logbook` — one passphrase field on the measure, the only chromatic pixel on screen (beam caret). Enter.
4. Sign-in is recorded (it is a ledger event — say so: `signed in · recorded 14:02:07`), and the same column continues seamlessly into session boot: the SWEEP **backfills right-to-left** with the real spectrum (history arriving is the signature moment — the record surfacing), the desk gauges fill, the last conversation's flow fades in at its kept position. **One reveal**: the flow and instruments appear in one coordinated frame when the critical batch (schema + conversation + spectrum seed) is complete; everything else fills silently at idle priority with zero layout motion.

### 10.3 The one-reveal law

After the reveal frame, nothing may mount, move, or resize except from user action or a live event. Guard: `cockpit-boot-owner.test.ts` — a Playwright boot trace asserts zero layout shifts and zero late mounts between reveal and first interaction; per-read failures render as in-place absence states, never as a layout change (one failing non-critical read can no longer break the shell).

Replaces: the login page, the boot pop-in cascade, per-panel loading states. Honest: every registration line is a measured probe; absence of a subsystem prints as its own line (`memory · not available`), not as silence. Build: `src/cockpit/boot/Registration.svelte`, `BootColumn.ts` (probe orchestration over the existing batch read). Closest prior art: game boot self-tests / aircraft pre-flight checks; structural difference: every line is a real probe with a measured time — it compresses when the system is fast instead of padding when it is slow. **Mark: BUILD-NOW** (it is the shell's entry).

---

## 11. Interest & interactivity — where the life comes from

**[Brief §9. The synthesis engine is the life; motion only ever traces real events.]**

1. **The computer speaking** (§4) — findings arriving at seams, each earned. A system that visibly derives is interesting for as long as the work is; this is the primary "life" budget.
2. **The bead** — a 3px beam-colored pulse that travels the flow's gutter spine along *real causal edges as they are recorded*: desk → turn → tool → effect. Implementation: animated offset along the drawn gutter path, compositor-only. It never moves without a corresponding event; when the run stalls, the bead visibly holds (honest stillness beats fake progress).
3. **The sweep ticking** — the now edge advancing on real events; the closest thing to a heartbeat, and it is a real one. Under reduced motion, ticks appear without the advance animation.
4. **Live numerals** — vertical digit roll (0.8em, 90ms) on real change only; tabular figures so nothing reflows.
5. **Desk physics** — channel strips and breakers respond on `pointerdown` in the same frame (scale 0.994 + press layer); the desk open/close is one 150ms transform. No springs, no overshoot anywhere except the desk snap (one deliberate signature easing).
6. **Hover adds information** — full-precision timestamps on sweep hover, value-at-cursor on sparks, provenance on any numeral (LENS-lite footer). Hover never *hides* an affordance's existence.
7. **Sound — one opt-in event, off by default**: a single short confirmation on run completion, fired only when the tab is unfocused and only on the real `run:done` event. Justification: it is the one moment a user is legitimately elsewhere; everything ambient is rejected (unbounded sessions make ambient sound a tax). Setting lives in the index (§9.3).
8. **Rejected for fake-motion risk**: idle shimmer, breathing gradients, particle ambience, hover parallax, springy tiles — all motion must trace a recorded event or a user gesture (the no-fake-motion law, now a guard: animation utilities accept an event/gesture handle, not a timer).

**Mark: bead + sweep tick BUILD-NOW (they ride the spine); the rest lands with its host surface.**

---

## 12. The visual system — designed from zero: **CARBON / LOGBOOK**

The GRAPHITE/PAPER *discipline* survives on its merits — chrome is achromatic, chromatic pixels carry meaning — because it is the same conclusion the dark-cockpit/HPHMI literature reaches independently. Everything else is new: new tokens, new type, new character. The character is **instrument glass over a paper logbook**: cool carbon surfaces, engraved labels, one electron-beam hue for "live," and a light theme that is a real paper logbook rather than an inverted dark theme.

New token file: `src/cockpit/tokens.css` (guard `cockpit-tokens-owner.test.ts` replaces the old css-token owner — no literal colors/durations in component styles).

**WHICH TOKEN FILE DIES — DECIDED HERE, because no document decided it and the resolution existed only in a source comment.** This sentence used to read "the old token file dies with the old tree" and named no path, while §13's deletion list omitted `src/styles/` entirely and `DESIGN-SPEC-GRAVITY-WELL.md` §7 commissioned a full rewrite OF that same file. Three documents, three answers, and both files live at runtime today — `src/cockpit/tokens.css` through `src/cockpit/main.ts`, `src/styles/tokens.css` through a `<link>` in `index.html`.

**THE DECISION: `src/cockpit/tokens.css` is the token owner. `src/styles/tokens.css` is the OLD tree's and is deleted with it (§13).**

It is decided on a measurement rather than a preference, and the measurement is the one nobody had taken — *who reads each file*:

| | declares | consumers in `src/cockpit/**` | consumers elsewhere |
|---|---|---|---|
| `src/cockpit/tokens.css` | 208 names | the cockpit | — |
| `src/styles/tokens.css` | 230 names | **zero** | 225 distinct names read by `src/lib/**`, 7 by `src/App.svelte` |

**The two vocabularies are DISJOINT — the intersection is exactly zero** — so there is nothing to collapse, no third file to introduce, and no migration: the old file's entire readership is the tree §13 already deletes. Neither guard polices the other's file (`css-tokens-owner.test.ts` partitions the tree), and both remain correct as written. Until the cutover both files stay, because `src/lib/**` is still mounted and a token file with live readers is not "old", it is *in use*.

**What this decision forbids:** adding a name to `src/styles/tokens.css`, and reading one of its names from `src/cockpit/**`. Either would give the doomed file a reason to survive its own tree, which is how a "temporary" second source of truth becomes permanent.

### 12.1 Ground (dark default — "carbon")

```css
--ground-0: #101216;  /* app ground — cool, hue ~250, chroma ≈ 0 */
--ground-1: #15181d;  /* flow bleed rows, sweep housing */
--ground-2: #1b1f25;  /* beats, cells, desk */
--ground-3: #232830;  /* raised: sheets, grammar menu */
--line-1:   #262b33;  /* hairline */
--line-2:   #39404b;  /* structural rule, bezel */
/* light — "logbook": warm paper, real theme, every token re-derived */
--ground-0: #f6f4ef;  --ground-1: #fbfaf7;  --ground-2: #ffffff;
--ground-3: #efece5;  --line-1: #e3dfd6;   --line-2: #c8c2b4;
```

### 12.2 Ink, beam, alarm

```css
--ink-1: #e8ebef;  --ink-2: #a6adb8;  --ink-3: #79818d;  --ink-4: #4d545e; /* disabled only */
/* light: #191c20 · #4d545e · #757c86 · #a9aeb6 — all AA on their grounds */

--beam:  #8fd3ff;   /* the ONE live hue — electron-beam blue. light: #0f6fa8 */
--ok:    #5fc78e;   --warn: #d9a84e;   --alarm: #e26a5f;
/* light: #1c7a4c · #8a5c08 · #b5352c */
```

- `--beam` is spent only on: the streaming caret, the bead, the sweep head + now edge, causal ribbons, the registration caret, live chips. Its rarity is the meaning. (There is no "info" blue — informational text is ink; the old info semantic is retired.)
- `--alarm`/`--warn`/`--ok` appear **only** on facts in those states, always beside their verb (§1.2). No colored buttons, no colored chrome, anywhere.
- Interaction states are luminance layers (`rgba(232,235,239, .05/.08/.13)` hover/select/press; light: `rgba(25,28,32, .05/.08/.12)`); focus ring `--ink-1` 2px offset 2px, zero transition.

### 12.3 Category hues (sweep + beat glyphs)

Event categories get a fresh 8-hue wheel at equal lightness (OKLCH L≈0.72 dark / 0.50 light, chroma 0.10, hues ≥40° apart) mapped from the `EVENT_KINDS` + ledger category vocabulary by a single table in `tokens.css`. Never used for chrome; only on sweep bins, beat glyphs, and scope headers. Each ships an `--on-*` pair.

### 12.4 Type — engraved instrument, readable logbook

- **Faces**: `IBM Plex Sans Variable` (prose, UI) + `IBM Plex Mono Variable` (numerals, ids, code, registration column, findings' derivations). Self-hosted woff2, latin subset, two files. Chosen for the instrument-panel heritage and because both carry true tabular figures and a slashed zero — the product is largely numerals. (Old faces retired with the old tree.)
- **Scale** (rem): `--f-micro 11px w560 track .08em UPPERCASE` — engraved labels (annunciators, strip names, room caps) · `--f-data 12.5px mono` — rows, beats' metadata · `--f-ui 13.5px` — default · `--f-prose 15.5px lh 1.6` — turn prose · `--f-value 22px w620 mono` — instrument values · `--f-hero 40px w650 mono` — the one registration/empty-state numeral.
- The **engraved label** is the identity move: every instrument's name is `--f-micro` uppercase ink-3, letter-spaced, like panel engraving — never a bold heading. Findings set their sentence in `--f-ui` italic with the `∴` in beam? No — `∴` in ink-2; beam stays live-only.

### 12.5 Shape, space, motion

- Radii: `0` (data marks, sweep, cells) · `2px` (inputs, sheets) · `4px` (rooms' inner panels, max). Sharper than consumer software on purpose; bezels are lines, not shadows. Elevation = ground step + line, shadows only on SCOPE/menus (`0 8px 24px -8px rgb(0 0 0 / .5)`; light `.12`).
- Space: 4px base — `2 4 8 12 16 24 32 48`; beat gutter 32px; bleed gutters 24px (16px <1440).
- Motion: `--t-1 90ms` (press, digits) · `--t-2 150ms` (sheet, desk, fold) · `--t-3 240ms` (room cut, sweep zoom) · easings: one standard out-curve, one exit, the desk snap. Compositor-only properties; FLIP for anything multi-element; one global reduced-motion block sets all to 1ms and stops the bead's travel (events then blink in place).

**Mark: BUILD-NOW (tokens are phase 0 of the new tree).**

---

## 13. Cutover — a fresh tree, and the deletion

- V2 is built at **`src/cockpit/`** with its own entry (`src/cockpit/main.ts`, `Cockpit.svelte` root) mounted by `index.html` in place of the old root. During build, a dev-only flag can mount old/new side by side; **at cutover the old component tree (`src/lib/**` UI, `src/styles/tokens.css`, `src/App.svelte`, old root, old routes/panels/tiles/rail/lens-overlay) is deleted**, together with its component-bound tests and UI-bound guards (old css-token owner, panel-render tests, routing class tests bound to tabs). **`src/styles/tokens.css` is named explicitly** because its omission from this list is what left the supersession undecided for the whole of the rebuild — see §12. Deleting it also means removing the `<link rel="stylesheet" href="/src/styles/tokens.css">` from `index.html`, which is the only thing keeping it loaded.
- Survives untouched: `contracts/*`, `server/**`, the block registry + Broker, client data functions, nanostores stores, recording, when-eval, LENS data layer, data-honesty guards (they test data, not components).
- Cockpit-native guards land **with their surfaces**: `cockpit-tokens-owner` (§12), `cockpit-verb-owner` (§1.2), `cockpit-manifest-owner` (§1.4), `cockpit-derivation-owner` (§4.4), `cockpit-chart-owner` (§8.3), `cockpit-boot-owner` (§10.3), `cockpit-salience-owner` (§1.5 F1), plus the latency-budget test enforcing the §1.5 F2 table (boot <200ms warm, action ack <100ms, keystroke paint <16ms, event-to-screen <100ms, finding-to-seam <300ms).
- The old UI exists in this document only as the avoid-list (§0). No section of this spec may be satisfied by restyling an existing component.

---

## 14. Build order (ranked) and marks

| # | What | Contents | Mark |
|---|---|---|---|
| 0 | Tokens + shell skeleton | `tokens.css`, `Cockpit.svelte`, HORIZON/FLOW/SWEEP/DESK geometry, keyboard grammar, one-reveal boot, Registration | BUILD-NOW |
| 1 | **The spine** | Flow virtualizer, beats (turn/tool/effect/event/check-delta), composer + `/` grammar, bead, turn seams | BUILD-NOW |
| 2 | Sweep v1 | band + now edge + head/asOf over the streamed window; causal ribbons | BUILD-NOW |
| 3 | The Switch | recency river, reels, honest absences | BUILD-NOW |
| 4 | Computer v1 | client-computable findings (rollup sentence, context projection), `?` grammar on existing intelligence blocks; admission controller | BUILD-NOW |
| 5 | Desk full | context strips (read-only until `run.compose`), breaker rows (read-only until `tools.breaker`), setting sheet primitive | BUILD-NOW render / NEEDS-BACKEND actions |
| 6 | Custody | effect-beat verbs first (existing git routes), then the room + parcels | BUILD-NEXT / NEEDS-BACKEND `custody.state` |
| 7 | Instruments room + monitors | uniform cells, no-broken-chart law | BUILD-NEXT |
| 8 | Settings index + LENS redesign | index room, LensCallout | BUILD-NEXT |
| 9 | Sweep v2 + ARM | full-history spectrum, semantic zoom, arm flags/capture | NEEDS-BACKEND `sweep.spectrum`, `arm.*`, `until` reads |
| 10 | Computer v2 | `insight.rollup` / `insight.match` / `insight.habit` findings | NEEDS-BACKEND (shapes in §4.9) |

**Backend needs, consolidated (exact shapes in their sections):** `run.compose` (§3.4) · `tools.breaker` + next-boundary semantics (§3.5) · `insight.rollup` / `insight.match` / `insight.habit` (§4.9) · `custody.state` / `custody.history` (§7.3) · `sweep.spectrum` + `arm.flags` + uniform `until` read param (§6.6). All are ordinary blocks: one declaration each, envelope causality for free.

## 15. Rejected as novelty-for-novelty's-sake

- **Freeform spatial canvas / zoomable universe home** — user-managed layout is a tax; entropy is the documented outcome. We kept only the camera (sweep zoom).
- **Geometric fisheye distortion** — moving targets destroy spatial memory; we distort representation, never geometry.
- **Node-graph authoring surface** — spaghetti by default; the causal DAG renders read-only, system-laid-out.
- **Bloomberg-density cosplay, 3D/AR, skeuomorphic cockpit chrome (rivets, glass glare)** — aesthetic theater with no verb.
- **Ambient sound / sonification of events** — a tax on unbounded sessions; one opt-in completion chime only.
- **Gamification (streaks, celebration confetti)** — fabricated affect; the honest reward is the finding.
- **An AI-narrated "insights feed"** — model-generated summaries violate the deterministic-derivation contract; the computer only joins, counts, and projects with shown work.
- **Per-beat emoji reactions / social chrome** — no verb, no pixels.
- **The adaptive self-reordering rail** (our own previous idea) — automatic layout the user must supervise is Stage Manager's failure in miniature; relevance survives only as finding admission, which moves *content into a fixed grammar*, never the grammar itself.

## 16. V2.1 — the corrections, as law

The v2.1 round turned four recurring findings into standing rules. Each rule
names its OWNER in the tree — the code that enforces it and the guard that
reds a violation — because a law that lives only in a document is a
convention (§1: mechanically enforced or it does not exist). Until this
section, these laws lived only in code comments; the scout measured that,
and this is the fix.

### 16.1 The mouse-first law

**Every actionable keyboard chord has a visible click path, and that path
TEACHES the chord.** A capability reachable only by chord is invisible to
everyone who has not read the grammar; a control that does what a chord
does must say so (tooltip derived from the grammar table, platform-true).
The converse holds too: a gesture-only capability (drag, middle-click,
double-click) states itself in a tooltip on the surface that owns it.

- Owners: `src/cockpit/shell/keyboard.ts` (`mouseTitleFor` — tooltips are
  DERIVED from the grammar, never restated) and
  `src/cockpit/shell/mouse-paths.ts` (the verified gesture-path registry for
  paths that are not control-shaped: click-a-beat, click-the-band).
- Guard: `tests/cockpit/cockpit-mouse-path-owner.test.ts` — derives the
  actionable set from claims + the shell router, then demands an
  attribute-bearing control or a verified gesture declaration for each, a
  tooltip on every path, and the pointer-target floor (`--hit-min`, WCAG
  2.2 SC 2.5.8) in both axes.

### 16.2 The rest-visibility floor

**A control revealed only by hover does not exist on a device without
hover.** Every hover-revealed control must also be revealed by focus
(keyboard) and be visible at rest under `(hover: none)` (touch). The
floor's second half — a control that is visible but does not LOOK like a
control wears a quiet edge at rest — is a reviewed judgment made owner by
owner, deliberately without a guard: an edge scanner would have to crown
one CSS spelling as "the affordance" and would manufacture wrong edges
(the reasoning, and the remaining un-edged subjects, are recorded in the
guard's own header).

- Owner: each component's reveal rules, with the shared copy-button floor
  in `src/cockpit/tokens.css`.
- Guard: `tests/cockpit/rest-visibility-floor.test.ts` — the population is
  DERIVED by pairing every hidden-at-rest declaration with a hover reveal
  of the same subject; §31a containment pins the audit-named subjects so a
  quiet scan cannot certify an empty universe.

### 16.3 The no-reload doctrine

**"Reload the page" is never the remedy the cockpit prescribes.** A deploy
under a running page announces itself as one chip and reloads only on the
reader's click; a stale credential re-issues and retries once inside the
one fetch choke point; a resume gap loads history in place; a failed room
import says "try again" because the next press already is the retry. The
one exception is its own proof: the pre-exemption service-worker escape
hatch unregisters-then-reloads exactly because that stranded page cannot
be freed any other way, and the branch is recorded as removable.

- Owners: `src/cockpit/shell/sw-update.ts` (the update chip and the v2
  escape hatch), `fetchJson`'s csrf retry (`src/data/`), the resume-gap
  history load, and the room router's retry wording
  (`src/cockpit/Cockpit.svelte`).
- Guards: `tests/cockpit/sw-update-owner.test.ts`,
  `tests/cockpit/shell-room-load-failure.test.ts`, and the csrf/resume
  suites beside their owners.

### 16.4 The rich-rendering defaults

**Recorded output renders in the shape the data actually has — and only
when the data proves that shape.** Files as highlighted code, commands as
preserved streams with stderr apart, searches as rows, JSON as one
collapsible tree, raster images as pixels inside a byte budget, markdown
as prose only for leftover text carrying two distinct block constructs
(command stdout is structurally unreachable), bare http(s) URLs in plain
streams as links that never change a byte of the text. Everything else
falls back to the verbatim string; absence is worded, never faked.

- Owner: `src/cockpit/render/shapes.ts` (every classifier is a test on the
  real value) with `markdown.ts` holding the one link allowlist and
  `JsonNode.svelte` the one JSON tree — consumed by tool output, the
  setting sheet's object read view, and whatever renders JSON next.
- Guards: `tests/cockpit/render-markdown-output.test.ts` (which also holds
  the stream-linkify assertions, consolidated there), and the render-owner
  suites beside `shapes.ts`.
