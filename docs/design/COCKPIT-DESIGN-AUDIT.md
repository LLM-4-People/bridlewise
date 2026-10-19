---
layout: default
title: 'COCKPIT DESIGN AUDIT'
---

# COCKPIT DESIGN AUDIT

Read-only measurement of `web-interface-foundation-v1/src/cockpit/**` (70 `.svelte`
files, one `.css` file), taken 2026-07-28. Every claim below carries `file:line`
or a reproducible count. Where I took something on trust it is listed under
COVERAGE at the foot.

**Headline verdict, stated first because it governs the plan.** The system is
not undisciplined — it is *disciplined into flatness*. Conformance to the token
owner is near-total (8 literal deviations in 70 components, and 7 of the 8 are
legitimate `ch`/`vh` units). What is missing is not rigour; it is **range**. The
declared scales reach far (10px→40px type, 2px→48px space, five radii) and the
code uses only the bottom of every one of them: 87% of radius uses are the same
2px, 94% of type declarations sit inside a 3.5px band, 87% of spacing is ≤12px,
and the tallest type token has **zero** consumers. That is the mechanical
signature of "the base is going in the right direction but it's not there yet".

The same is true of motion. There are **11 motion declarations in the entire
cockpit** (3 keyframes, 8 transitions). All 11 are honest — I found **zero**
decorative and **zero** ambient motion, which is a genuinely rare result. The
problem is the fourth category: **thirteen named recorded events** land in the
UI and produce no visible response at all. The cockpit is decisively at the
**dead-still** failure mode, not the noisy one.

And the same is true of the watching surface, which is where the product spends
most of its life. During a run **seven real, recorded channels are live**
(§11.1) — the beat doing work, the characters arriving and which channel they
belong to, the send-path milestone, the elapsed, the context filling, the tool
executing right now, the new bins on the band. **The total visible movement is
one 5px dot travelling, some 2px cells changing colour, and a grey bar jumping
with no transition.** Nothing on that screen is legible from across a room. The
measuring is done; the expression is not.

**The single most useful sentence in this report:** almost every fix below is
amplitude, not plumbing. The events are already named, addressed, recorded and
arriving; the scales already have the range; the DOI function, the refusal
contract and the provenance stamps already exist. Nothing here asks for a new
capability.

---

## 1. TOKEN INVENTORY

`src/cockpit/tokens.css` — 924 lines, **265 declaration lines / 201 unique token
names** (the difference is the light theme re-deriving 40 of them, plus density
and two breakpoint remaps).

### 1.1 What it covers

| Family | Tokens | Verdict |
|---|---|---|
| Ground / line | `--ground-0..3`, `--line-1..2` (tokens.css:27-32) | complete, re-derived for light (523-528) |
| Ink | `--ink-1..4` (36-39) | complete |
| Semantic hue | `--beam`, `--ok`, `--warn`, `--alarm` (44-47) | complete, contrast measured in-comment (800-805) |
| Category wheel | `--cat-*` ×8, `--on-cat-*` ×8 (73-88) | **broken — see 1.4** |
| Type | 11 size tokens, 3 weights, 2 faces, 1 track (91-110, 450-457) | declared with range; **unused at the top** |
| Shape | `--radius-0/1/2`, `--radius-bubble`, `--radius-card` (113-115, 158-159) | 5 values; **1 carries 87% of uses** |
| Space | `--sp-0..7` (142-149) + ~20 derived gutters | followed, but bottom-heavy |
| Elevation | `--shadow-sheet` only (128, 545) | **one** elevation value for the whole system |
| Motion | `--t-1/2/3`, `--ease-out/exit/desk` (363-368) | `--t-3` and `--ease-exit` **dead** |
| Interaction | `--layer-hover/select/press` (49-51), `--focus-ring-*` (54-56) | the closest thing to a state vocabulary that exists |
| Hit floor | `--hit-min: 24px` (126) | one owner, consumed correctly |
| Geometry | ~90 per-surface dims (`--reel-w`, `--custody-parcel-w`, …) | this is 45% of the file |

Reduced motion (620-626) collapses all three durations to 1ms in one block —
correct, and it is the reason no component needs its own reduced-motion
override for duration.

### 1.2 What is missing that a state grammar needs

This is the central gap. **The token file has a vocabulary for STATIC APPEARANCE
and for three POINTER states. It has no vocabulary for the states the product
actually reasons in.**

Present as tokens: hover (`--layer-hover`), selected (`--layer-select`), pressed
(`--layer-press`), focused (`--focus-ring-*`), and four *outcome* hues
(`--ok/--warn/--alarm/--beam`) which are wired to `data-state` at
tokens.css:806-817 — but **only on `.beat-card`, and only in the flow**.

Absent as tokens, though every one of them is a real, computed, load-bearing
state in the data layer:

- **absent** — 52 markup uses of `class="absent"`, 17 files declaring their own
  `.absent` rule (§4.2). No token. Each file re-picks between `--ink-3`,
  `--ink-4`, italic, mono, or nothing.
- **pending / not-yet-measured** — a first-class `{kind:"pending"}` in six
  modules. No token, no shared treatment.
- **refused** — `Verb.svelte` renders a disabled control carrying an honest
  reason (`verb-unwired`, Verb.svelte:135). This is the single most valuable
  state in the system and it exists in exactly one component.
- **armed** — `data-armed` appears twice in markup; no token.
- **working / in-flight** — expressed as a text suffix (`{busy ? label+"…" :
  label}`, Verb.svelte:92) and nothing else.
- **dominant / salient** — no token at all. See §7.
- **stale / superseded** — the desk and sweep both know about a planted head
  (`isPastView`) and express it with prose only.

**A system with four outcome hues and no absent/pending/refused/working tokens
is a palette with a status light bolted on, not a grammar.**

### 1.3 Dead tokens (declared, never referenced)

Scanned tree-wide for `var(--x)`, `getPropertyValue("--x")` and
`setProperty("--x")` across all of `src/`.

**Genuinely dead — 18:**

| Token | Line | Note |
|---|---|---|
| `--on-cat-turn/tool/effect/check/finding/steer/anomaly/heal` (8) | 81-88 | the `--cat-*` pairs' foreground; nothing ever paints text on a category fill |
| `--f-hero-size`, `--f-hero-weight` | 109-110 | **the top of the type scale has no consumer** — see §7 |
| `--verbs-pad-y` | 164 | |
| `--tick-w` | 265 | the fisheye tick mark's width |
| `--bead-glow` | 281 | Bead.svelte:36 uses `var(--sp-1)` for its glow instead |
| `--t-3` (240ms) | 365 | commented "room cut, sweep zoom"; **neither exists** |
| `--ease-exit` | 367 | **nothing in the cockpit has an exit** |
| `--density-type-delta` | 372 | declared, remapped at 514/519, never read — the density steps change row height only, never type |
| `--stream-rate-w` | 437 | superseded by `--stream-say-w` (884) |
| `--editor-page-h` | 478 | |

`--t-3`, `--ease-exit` and `--f-hero-*` are not clerical dead weight — they are
**the file telling you what it was designed to do and never got to do.** The
room cut, the exit, and the one hero numeral are all declared and all missing.

**NOT dead, correcting a plausible reading:** the eight `--cat-*` tokens show
zero `var()` references but *are* consumed, dynamically, at
`sweep/categories.ts:219` via `pick(c.cssVar, pick(c.aliasVar, …))`. A
name-based grep alone would have reported them dead and a writer would have
deleted a live path. Flagging this explicitly because it is exactly the
absent-versus-relocated trap.

### 1.4 Duplicated values — two names, one value, drifting later

25 literal values are carried by more than one token name. Most are harmless
coincidence (`--sp-3` and `--beat-tick-h` are both 12px because 12 is a common
number). Three are real defects:

1. **`#101216` is declared nine times** (tokens.css:27, 81-88) — once as
   `--ground-0` and eight times as `--on-cat-*`. Changing the app ground now
   requires nine edits, eight of which nobody will remember.
2. **`--f-data-size` and `--f-code-size` are both `12.5px`** (104, 402) and mean
   the same thing (mono content type). Two owners for one question.
3. **The category wheel has THREE sources of truth for one colour.**
   `categories.ts:48-56` declares, per row, a `cssVar` (`--cat-lifecycle`,
   `--cat-user`, `--cat-llm`, `--cat-context`, `--cat-transport`, `--cat-safety`
   — **none of which tokens.css declares**), an `aliasVar` pointing at a
   differently-named token that does exist, and a hardcoded `fallbackDark` hex
   (`#d0975f`, `#dc8b8b`, …). So the ledger's category vocabulary and the token
   file's category vocabulary are **two different eight-word lists**, bridged by
   an alias table, backstopped by a third copy of the colours in TypeScript.
   `resolveSweepPalette` (categories.ts:210-232) additionally carries
   `PALETTE_FALLBACKS_DARK` — seven more hardcoded hexes duplicating
   `--alarm/--beam/--ground-1/--ground-2/--line-1/--ink-2/--ink-3`, **dark-only**,
   so in the light theme every one of those fallbacks is wrong.

### 1.5 Tokens with exactly one consumer — 77 of 201

Not a defect by itself (`--custody-file-col` legitimately has one consumer), but
it quantifies the shape of the file: **~45% of the token system is one surface's
private geometry parked in a global file.** The genuinely *shared* vocabulary —
the part a grammar could be built on — is about 60 tokens. The rest is a
dimensions ledger. This matters for the plan: adding state tokens will not make
the file worse, because the file is already two files wearing one name.

---

## 2. CONFORMANCE

### 2.1 Where the grammar IS followed — and it is followed unusually well

I scanned all 70 components' `<style>` blocks with comments stripped and
`var()` calls removed. **Total literal deviations: 8.**

| Site | Literal | Verdict |
|---|---|---|
| `shell/ConnectionBlock.svelte:187` | `100vw` | legitimate — viewport unit inside a `calc` |
| `shell/ConnectionBlock.svelte:215` | `60ch` | **undeclared measure** — a second content width beside `--measure` |
| `shell/ConnectionBlock.svelte:231` | `4ch` | reserved numeral box; comparable tokens exist (`--diff-num-w: 4ch`) |
| `shell/Popover.svelte:184` | `100vh` | legitimate |
| `flow/WaitLine.svelte:169` | `5ch` | reserved box, undeclared |
| `boot/Registration.svelte:142,181,222` | `12ch` ×3 | **the login column's label track, declared three times inline** |

The token guard (`tests/cockpit/cockpit-tokens-owner.test.ts`) explains the
discipline: it rejects hex/rgb/hsl/oklch, `ms`/`s` on transition lines, local
`--x:` declarations, `:root` blocks, and `px`/`rem`/`em` — with nine mutation
self-checks. It is a good guard.

**Two universe gaps in that guard, both currently exploited:**

- **It scans only `<style>` blocks** (`styleBlock()`, test:33-40). Literal
  colours in `<script>` are invisible to it. That is precisely where the three
  known violations live: `rooms/MicroSweep.svelte:63` (`"#4d545e"`),
  `rooms/MicroSweep.svelte:64` (`"#e26a5f"`), `rooms/Spark.svelte:97`
  (`"#79818d"`) — **confirmed**, plus `sweep/categories.ts:48-56` (8 hexes) and
  `sweep/categories.ts:195-203` (7 hexes) which are in `.ts` and outside the
  scanned extension list entirely. **Real count of literal cockpit colours: 18,
  not 2.**
- **It does not scan `ch`/`vh`/`vw`/`%`**, which is why the 8 deviations above
  pass. `12ch` repeated three times in one file is the same defect class as
  `12px` repeated three times.

### 2.2 Canvas-drawn surfaces — the special case, confirmed broken

Three surfaces paint to canvas and therefore read tokens in JS:

| Surface | Reads | Re-reads on theme switch? |
|---|---|---|
| `rooms/Spark.svelte:97` | `--ink-3` via `getComputedStyle` at paint | **No.** `$effect` (116-121) depends on `canvas` and `pts` only. |
| `rooms/MicroSweep.svelte:63-64` | `--ink-4`, `--alarm` at paint | **No.** `$effect` (84-88) depends on `canvas` and `density` only. |
| `sweep/Sweep.svelte:346-351` | the **entire** palette — 8 categories + 7 chrome colours | **No, and worse:** resolved **once, in `onMount`**, into `let palette = $state(...)`. Never re-resolved anywhere in `src/` (verified tree-wide). |

The theme owner is `settings/local-prefs.ts:111-112`, which toggles
`data-cockpit-theme` on `documentElement`. That attribute change is invisible to
every one of these three effects. **Switching to the light "logbook" theme
leaves the sweep band — the largest single instrument in the cockpit — painting
the carbon-dark grounds, the dark ink, and the dark 8-hue wheel onto a warm
paper page, and it stays that way until the component remounts.** Spark and
MicroSweep self-heal on their next data tick; the Sweep palette does not
self-heal at all.

This is not a rendering nicety. It is the single-source rule failing at the
CSS/JS boundary, and it is invisible to the guard because the guard reads CSS.

### 2.3 Components implementing their own treatment rather than inheriting

Measured, and the answer is more encouraging than expected:

- **Hover** — 76 `:hover` rules across 45 files. **50 of them use
  `background: var(--layer-hover)` and 53 use `color: var(--ink-1)`.** Only 6
  outliers: `border-color: var(--line-2)`, `border-color: var(--ink-2)`,
  `background: var(--line-2)`, `background: var(--ground-3)`,
  `background: var(--beam)`, `text-decoration-thickness`. Hover is *de facto*
  uniform already — it just isn't *declared* anywhere, so it is 50 copies of a
  convention rather than one rule.
- **Focus** — one global rule (tokens.css:820-824). But **8 components override
  it locally** (`flow/Verb.svelte:128`, `shell/NewTabButton.svelte:63`,
  `sweep/Sweep.svelte:1014`, `flow/Flow.svelte:1712,1764`,
  `flow/ThinkingFold.svelte:159`, `computer/FindingNote.svelte:114`,
  `render/CopyButton.svelte:86`, `shell/Desk.svelte:279`). Two of them
  (`ThinkingFold:159`, `FindingNote:114`) re-declare the ring as
  `var(--sp-0) solid var(--ink-1)` — the *spacing* scale standing in for
  `--focus-ring-width`, which is a token pointing at the same 2px. One door
  exists; eight surfaces walked around it.
- **Disabled** — 22 `:disabled` rules across 16 files, each picking its own
  colour. No `--layer-disabled` token exists; `--ink-4` is commented "disabled
  only" (tokens.css:38) but is used for absence and for canvas ink too.
- **Loading** — no shared treatment of any kind. `Verb.svelte:92` appends `…`
  to the label; `boot/Registration.svelte:114` swaps the word to `"checking…"`.
  Two components, two inventions, no token, no primitive.

---

## 3. THE MOTION AUDIT — under the motion law

**THE LAW: calm at rest, a spark at the thing that changed, every motion with an
address and a cause.**

Complete inventory. There are 11 motion declarations in 70 components.

### 3.1 TARGETED — keep (4)

| # | Site | The recorded cause | Address | Strong enough? |
|---|---|---|---|---|
| 1 | `flow/Bead.svelte:37` `transition: transform --t-2` | the beat currently doing work, derived from the log; the header states it "NEVER moves without a corresponding event, and when the run stalls it visibly holds" | a 5px mark in the flow gutter | **No.** 5px, one colour, no arrival emphasis. This is the single most conceptually correct piece of motion in the product and it is nearly invisible. |
| 2 | `flow/StreamPulse.svelte:243-246` `transition: background, height --t-1` | real characters arriving on the stream; head cell advances per token | 2px cells, 10px tall | **No.** Sub-pixel-scale response to the most important live event in the app. |
| 3 | `rooms/InstrumentCell.svelte:242,249-258` `animation: roll --t-1` | a **true** measured-value change — fired by a `{#key}` remount, and the comment is explicit that "an unchanged re-measurement re-keys nothing" | the digit itself | **Yes, borderline.** 90ms, 0.8em rise. The only motion in the system with real address+cause+visible amplitude. |
| 4 | `shell/Popover.svelte:191-198` / `shell/ScopeHost.svelte:98-107` `rise` / `sheet-in` | a user gesture opening a surface | the sheet | **Yes**, 6px over 150ms. Appropriate. |

Also targeted but not animated: `shell/Desk.svelte:191`
`transition: grid-template-rows --t-2 --ease-desk` — the desk open/close, driven
by a real gesture. Correct.

**Cause quality.** #1 and #2 are driven by *actual recorded events* (the beat
log; the token stream). #3 is driven by a *measured value change*, which is one
step weaker but still evidence. #4 is a local state flag, which is correct for a
gesture. **Nothing in the cockpit animates on a timer, on mount, or on a route
change.** That is a clean result and it should be said plainly: the honesty floor
is already met. This is the foundation the "alive" claim can be built on, and it
is the thing a competitor cannot copy without rebuilding their recording layer.

### 3.2 DECORATIVE — 0

None found. No spinner, no shimmer, no skeleton, no progress bar that is not
measuring something.

### 3.3 AMBIENT — 0

No continuous animation exists. Rest is genuinely still. **The budget the motion
law reserves is entirely unspent.**

### 3.4 MISSING — a real event occurs and the surface stays still

This is the largest category and the actionable one. Each row is a recorded
event that already fires, an element that already exists, and no visible
response.

| Recorded event | Where it lands today | Element that should spark | Currently |
|---|---|---|---|
| `run:done` | `sweep/spectrum-load.ts:185` → the band re-reads its spectrum | the newly-arrived bins at the **now edge** of `sweep/Sweep.svelte` | band repaints silently; header says "there are no sweep animations at all" (Sweep.svelte:30) |
| `custody:changed` | `rooms/custody-feed.ts:253` | the **specific parcel row** in `rooms/Parcel.svelte` that changed | rows swap in place |
| `compose:changed` | `desk/desk-feed.ts:607` | the **channel strip item** whose composition changed, `desk/ChannelStrip.svelte` | zero motion in file |
| `tools:changed` | `desk/desk-feed.ts:608` | the affected tool row | zero motion in file |
| `run:done` (desk) | `desk/desk-feed.ts:609` | `desk/Gauge.svelte` readout | zero motion in file |
| `SETTINGS_CHANGED_EVENT` | `settings/settings-feed.ts:96` | the row's `.value[data-provenance="changed"]` — **which already knows it changed**, `rooms/SettingsRoom.svelte:740` | changes ink colour only, instantly, no arrival |
| breaker trip / restore | `desk/BreakerRow.svelte:138-140` sets `data-state`, `class:executing`, `class:highlight` | the breaker itself | class flips, nothing moves |
| a verb succeeds | `flow/Verb.svelte:76-82` — `busy` clears, `failure` stays null | the verb chip | label loses its `…`. **A successful action produces no confirmation at all.** |
| a verb fails | `flow/Verb.svelte:93` renders `role="alert"` text | the failure sentence | appears instantly with no arrival, next to a control that did not move |
| a room opens | `shell/RoomHost.svelte:103-110` toggles `visibility` | the room | **hard cut.** `--t-3` (240ms) is declared *for exactly this* and is dead. |
| connection degrades | `shell/ConnectionBlock.svelte:101` `data-connection="slow"` | the bar | appears instantly |
| a finding is computed | `computer/FindingNote.svelte` | the note | **zero motion declarations in the file** |
| a beat arrives in the flow | `flow/Flow.svelte` virtualizer | the new beat | appears; the Bead moves 5px |

**Thirteen recorded events, one 5px response between them.** That is the
measured answer to "not there yet".

### 3.5 The reconciliation

Calm-at-rest is already achieved and should not be touched. Every addition below
must attach to a row in §3.4 — i.e. it must name its event. The rule that makes
this cheap: **the events already exist and are already named.** No new
plumbing is required to make the cockpit feel alive; `onInvalidation` already
carries the address.

---

## 4. THE STATE VOCABULARY TODAY (measured, with its inconsistencies)

### 4.1 `data-state` carries five incompatible vocabularies

One attribute name, 15 binding sites, and at least five disjoint value sets —
only one of which the token owner styles.

| Vocabulary | Values | Declared at | Styled by tokens.css? |
|---|---|---|---|
| beat state | `running` \| `ok` \| `warn` \| `alarm` \| `neutral` | `flow/beat-state.ts:60` | **yes** — 806-817, on `.beat-card` only |
| density | `pending` \| `measured` \| `absent` | `rooms/switch-feed.ts:42-44` | no |
| probe | `ok` \| `absent` \| `failed` | `boot/probes.ts:67` | no |
| thinking | `absent` \| `live` \| `settled` | `flow/thinking-fold.ts:84` | no |
| breaker | `on` \| `tripped` | `desk/BreakerRow.svelte:138-140` | no |
| ad-hoc literals | `"past"`, `"bad"`, `"failed"`, `"empty"` | inline in markup | no |

Note the collisions. `absent` means "no reasoning present" in one vocabulary and
"the read refused" in another. `failed` and `alarm` mean the same thing under two
names. `ok` appears in two vocabularies with two different sibling sets. **A
reader learning "what does this colour mean" learns it five times.**

### 4.2 How absence is expressed — the honesty-critical one

The *data* layer is excellent and the *presentation* layer is anarchy.

**The data shape is right, and it is re-declared 12 times.** The union
`Readonly<{kind:"absent"; reason:string}>` appears verbatim at
`editor/feed.ts:135,161,196`, `editor/tree.ts:97`,
`rooms/custody-feed.ts:39,44`, `rooms/switch-outcome.ts:40`,
`rooms/switch-feed.ts:44`, `desk/desk-feed.ts:55,60,66,73`. Six *modules*
independently declare the same three-state discriminated union. The **wording**
has one owner (`src/lib/data/absence.ts:31 absenceReason`, imported by seven
call sites) — that part is correct and is the template for the fix. The
**shape** does not.

**The presentation has no owner at all.** `class="absent"` appears 52 times in
markup; **17 files declare their own `.absent` rule**, and they disagree:

| File | Its `.absent` |
|---|---|
| `shell/RoomHost.svelte:161` | `margin: 0` — no styling whatsoever |
| `shell/ScopeHost.svelte:164` | `margin: 0` |
| `shell/Desk.svelte:308` | `margin: 0; align-self: center` |
| `rooms/Parcel.svelte:495` | `--ink-4`, italic |
| `desk/ChannelScope.svelte:125` | `--ink-3`, italic |
| `desk/TripScope.svelte:119` | `--ink-3`, italic |
| `desk/ItemBody.svelte:142` | `--ink-3`, italic |
| `desk/DeskPanel.svelte:386` | `--ink-3`, italic |
| `rooms/Reel.svelte:213` | mono, `--f-data-size`, `--ink-4`, no italic |
| `rooms/SettingsRoom.svelte:607` | mono, `--f-data-size` |
| `rooms/CustodyRoom.svelte:472` | mono, `--f-data-size` |
| `settings/SettingSheet.svelte:500` | mono, `--f-data-size` |
| `desk/ChannelStrip.svelte:439` | `--f-micro-size`, padded |
| `desk/Gauge.svelte:183` | italic, `text-transform: none` |
| `rooms/InstrumentCell.svelte:~295` | mono, `--ink-4` |
| `render/ArtifactFrame.svelte:405` | `gap: --sp-1` only |
| plus `.absence` in 6 further files | |

Four different inks, two different faces, italic-or-not, and three files where
the absence state is **visually identical to normal content**. The most
honesty-critical state in the product is the least consistently expressed thing
in it.

### 4.3 How refusal is expressed — one component does it perfectly

`flow/Verb.svelte` is the high-water mark of the whole codebase and deserves to
be quoted as the model:

- it **throws at the render boundary** if a caller claims `wired` without an
  action, or `disabled` without a reason (Verb.svelte:38-46) — the bad state is
  unrepresentable past the guard, carried in the type (`ValidatedVerb`, 29-31);
- refusal reasons are **computed from the record**, not asserted by the caller:
  `verbs.ts:44-47` refuses rollback because the message id exists only in this
  tab; `Verb.svelte:61-65` refuses every writing verb while a head is planted,
  with one owned sentence;
- the reason is rendered **on the control as visible text**, not a tooltip
  (Verb.svelte:104, `.verb-unwired`).

That is `wired / refused(reason) / working / failed(message)` — four states,
computed, mutation-guarded. **It is imported by four files.** See §5.

### 4.4 Everything else, enumerated

| State | How it is expressed today | Sites |
|---|---|---|
| rest | nothing declared | — |
| hover | `--layer-hover` + `--ink-1` | 50/53 of 76 |
| focus | one global rule | tokens.css:820, +8 local overrides |
| pressed | `--layer-press` | 5 sites; `flow/Verb.svelte:133` uses `transform: scale(0.994)` instead |
| selected | `--layer-select` | 9 sites |
| disabled | ad-hoc, mostly `--ink-4` | 22 rules, 16 files |
| armed | `data-armed` | 2 sites, no styling |
| working | text suffix `…` | 2 components |
| succeeded | **nothing** | 0 |
| refused | `Verb.svelte` only | 1 component |
| absent | `.absent` | 17 conflicting rules |
| pending | mostly a sentence | ad-hoc |
| outcome ok/warn/alarm/running | `.beat-card` leading edge | tokens.css:806-817, flow only |

---

## 5. PRIMITIVES

### 5.1 What exists

| Primitive | File | Importers |
|---|---|---|
| Verb (button) | `flow/Verb.svelte` | **4** (`Beat`, `BeatDepth`, `BeatScope`, `FindingNote`) |
| Popover (menu/sheet) | `shell/Popover.svelte` | **3** (`Horizon`, `WorkspaceStrip`, `ArmMenu`) |
| CopyButton | `render/CopyButton.svelte` | via the global `.hover-reveal` rule |
| Gauge | `desk/Gauge.svelte` | 1 real + 1 dev harness |
| Spark | `rooms/Spark.svelte` | InstrumentCell, Monitor |
| `.beat-card` | tokens.css:733-744 | 5 consumers, correctly |

**There is no shared field/input, no shared sheet body, no shared row, no shared
absence element, no shared status/chip.**

### 5.2 The anti-pattern, named and counted

> **A primitives folder nobody uses because every surface restyles.**

The measurement:

- `class="verb"` appears **55 times** in cockpit markup.
- **16 files declare their own `.verb` CSS rule**: `flow/Verb.svelte`,
  `boot/Registration.svelte`, `desk/BreakerRow.svelte`, `desk/ChannelStrip.svelte`,
  `editor/DeleteConfirm.svelte`, `editor/FilePane.svelte`, `lens/LensCallout.svelte`,
  `render/ArtifactFrame.svelte`, `rooms/CustodyRoom.svelte`,
  `rooms/InstrumentCell.svelte`, `rooms/Parcel.svelte`, `rooms/Reel.svelte`,
  `rooms/SwitchRoom.svelte`, `settings/SettingSheet.svelte`,
  `shell/ConnectionBlock.svelte`, `shell/Horizon.svelte`.
- The component `Verb.svelte` is imported by **4**.

So **15 independent re-implementations of the one control that already has a
correct state contract.** Every one of those 15 re-derives hover, focus and
disabled by hand, and **not one of them has the wired/refused/reason contract** —
which means 15 buttons in this product can be disabled with no reason given,
and the guard that makes that impossible only protects the flow.

Same pattern, smaller: `.engraved` (the micro-label register) is declared in
**15 files**; `.absent` in 17; `.note` in 8; `.verbs` (the row) in 8. These are
not incidental class names — they are the same four visual ideas typed out
between 8 and 17 times each.

**Where the shared owners DO exist they work.** tokens.css already hosts
`.beat-card` (733), the nine `.syn-*` roles (639-666), the `.hover-reveal
.copy-btn` rule (686), and the global `:focus-visible` (820) — each with a
written justification for why a child's scoped CSS could not do it. The pattern
for the fix is already in the file; it simply stopped after four.

---

## 6. THE LOGIN PAGE

### 6.1 Correction to the brief — it has already been rebuilt

`src/lib/auth/LoginGate.svelte` is the retiring UI's gate, still rendered by
`src/App.svelte:542,544`, and it consumes only old tokens (`--color-bg-base`,
`--space-4`, `--font-size-lg`, `--radius-md` …) — none of which exist in
`tokens.css`, all of which die at cutover.

**But the cockpit already has its successor: `src/cockpit/boot/Registration.svelte`.**
Its header states the intent explicitly: "The auth FLOW survives (client.ts
submitLogin/submitRegister — the same recorded POSTs); the old login form does
not (§13)." It is mounted from the cockpit boot path and consumes only cockpit
tokens. The task is therefore **finishing and dressing Registration**, not
building a login page. A writer briefed to "rebuild the login page in the
cockpit" would build a second one.

### 6.2 States needed vs expressible

| State | Needed | Registration today | Cockpit grammar can express it? |
|---|---|---|---|
| idle | yes | form renders, fields enabled | yes — rest |
| submitting | yes | `disabled={auth.loading}`, label → `"checking…"` (Registration:113-115) | **only as a word.** No working state exists. |
| wrong password | yes | `{#if auth.error.length > 0}<p class="error">` (108-110) | partially — `--alarm` exists, but there is no shared error element and no arrival |
| offline / unreachable | yes | `gate === "offline"` → "the server is not answering — [probe again]" (80-84) | **yes, and well** — this is an absence with a reason and a verb, exactly right |
| first-run setup | yes | `gate === "setup"` → "no owner yet — choose a passphrase to open the logbook" (86-88) | yes |
| locked out | **no** | **not modelled anywhere** — `src/state/auth.ts` has no attempt count, no lockout, no retry-after | **no.** Needs a data-layer state first; do not fake it. |
| boot probes | yes | 1 line per real probe with measured ms (68-76) | yes — and this is the best part of the surface |

### 6.3 The acid test result

**It fails, and it fails informatively.** Registration is 240 lines of which
~130 are its own `<style>` block, and inside it are:

- its own `.verb` rule (Registration:~213) — re-implementation #15;
- its own `input:disabled` rule (195) — no shared field exists;
- its own `.enter:disabled` (224);
- its own `.error` — no shared error element exists;
- `12ch` written literally three times (142, 181, 222) because no field-label
  track token exists;
- **zero motion**, including no response when a probe line lands (each line
  arrives as a measured fact and simply appears) and no response on a successful
  sign-in — despite `Registration:57-62` measuring the exact ms it took.

So the honest answer to "can the system dress its simplest page without special
cases" is **no — it needs five special cases** (field, label track, error, verb,
submit). Each of those five is exactly the primitive that §5 says is missing.
The login page is not a separate task; **it is the acceptance test for the
primitives work**, and it should be built last and used to prove the set is
complete.

One genuine strength worth preserving: Registration's boot column is
"instruments checking in, truthfully" — real probes with real measured
durations, no splash, no spinner. **That is the most distinctive login screen
idea in this codebase and it is currently rendered as a static list.** See §12.

---

## 7. DOMINANCE, TYPE, SPACING, RADIUS, SEPARATION, MENUS

### 7.1 Type — 11 sizes declared, 4 used, all within 3.5px

| Token | Value | `var()` uses |
|---|---|---|
| `--f-data-size` | 12.5px | **110** |
| `--f-micro-size` | 11px | **87** |
| `--f-nano-size` | 10px | **48** |
| `--f-ui-size` | 13.5px | 31 |
| `--f-code-size` | 12.5px | 7 |
| `--f-value-size` | 22px | 3 |
| `--f-prose-size` | 15.5px | 2 |
| `--f-h1/h2/h3-size` | 21/18/16px | 1 each |
| `--f-hero-size` | 40px | **0** |

**276 of 291 sized declarations (95%) fall between 10px and 13.5px.** The
declared scale spans 4× (10→40); the used scale spans 1.35×.

Weight tells the same story: three weight tokens, 54 declarations, **47 of them
the same `--f-micro-weight` (560)**. `--f-heading-weight` 5 uses,
`--f-value-weight` 2, `--f-hero-weight` 0.

**Distinct type ROLES: 6 declared** (nano note / micro engraved label / mono data
/ sans UI / prose / value numeral) **+ 3 heading + 1 hero = 10.** Roles actually
*optically distinguishable* at a glance: **3** — engraved-uppercase-tracked,
mono-data, and prose. Nano (10px) and micro (11px) differ by one pixel and are
told apart only by uppercase+tracking, which micro also has; they are one role
wearing two tokens.

**Where one role carries two meanings:** `--f-data-size` (110 uses) is
simultaneously "a data value", "a body sentence in a room", "an absence
sentence", and "a verb label" (`Verb.svelte:115`). The single most-used type
token in the product has no meaning at all.

**Dominance verdict:** *the scale has the range; the code refuses to use it.*
`--f-hero-size: 40px` and `--f-value-size: 22px` exist and are commented for
exactly this job ("the one registration/empty numeral", "instrument values").
Nothing is blocking boldness — no author has spent it. **This is a cheap,
high-yield finding: dominance requires no new tokens.**

### 7.2 Spacing — scale followed, top half unspent

| Token | Value | uses |
|---|---|---|
| `--sp-0` | 2px | 59 |
| `--sp-1` | 4px | 120 |
| `--sp-2` | 8px | **159** |
| `--sp-3` | 12px | 77 |
| `--sp-4` | 16px | 20 |
| `--sp-5` | 24px | 21 |
| `--sp-6` | 32px | 9 |
| `--sp-7` | 48px | 11 |

**415 of 476 uses (87%) are ≤12px. The top three steps together account for 8%.**
The scale is obeyed perfectly and lives almost entirely in its bottom half. This
is the measured form of "cramped", and per the steer it is the cheapest
"not premium" signal to fix — no new tokens, only different choices at the
container level (`--sheet-pad` already resolves to `--sp-4`, `--sheet-gap` to
`--sp-3`; both are single-consumer).

### 7.3 Radius — a five-value scale collapsed to one

87 `border-radius` declarations:

| Value | uses | share |
|---|---|---|
| `var(--radius-1)` = **2px** | **76** | **87%** |
| literal `0` | 4 | |
| `var(--radius-0)` = 0 | 3 | |
| `var(--radius-2)` = 4px | 2 | |
| `var(--radius-card)` = 6px | 1 | |
| `var(--radius-bubble)` = 10px | 1 | |

**At 2px, nearly every corner in the cockpit is a sharp corner.** The two soft
radii introduced for chat readability (`--radius-bubble` 10px, `--radius-card`
6px) have **one consumer each** — the bubble idea landed and then stopped.

**Nested radii do not relate at all.** A `.beat-card` at 10px contains a
`.copy-btn` at 2px (`CopyButton.svelte:76`) and a `.verb` at 0
(`Verb.svelte:109`). A `Popover` at 2px contains buttons at 2px. The rule that a
child's radius should be `parent − padding` is nowhere expressed, and cannot be
while there is effectively one value.

The explicit sharp corners: `flow/Bead.svelte:34` (correct — a data mark),
`flow/Verb.svelte:109` (**the most-repeated control in the product has square
corners**), `flow/Flow.svelte:1701`, `flow/Flow.svelte:1745`.

**Canvas surfaces get no radius at all** — `Spark` strokes polylines,
`MicroSweep` draws `fillRect` bars (MicroSweep:73,79), `Sweep` paints
rectangles. Every canvas instrument is hard-edged by construction and none of
them is clipped by a rounded container.

### 7.4 Separation — one tool doing five jobs, confirmed

Four separation tools exist in principle. Their actual use:

| Tool | Uses | Verdict |
|---|---|---|
| **Rule (hairline border)** | **~140 declarations** — 51× `border: --hairline-w solid --line-1`, 25× `border-bottom` same, 22× `border: … --line-2`, 13× `border-top`, … | **carrying essentially all separation** |
| **Elevation (shadow)** | **7** — 6 are the same `--shadow-sheet`, 1 is the bead's glow (`Bead.svelte:36`) | one value, four surfaces |
| **Ground / inset** | 67 — `--ground-1` 24×, `--ground-2` 21×, `--ground-3` 14×, `--ground-0` 8× | in use, but not systematically tied to depth |
| **Spacing** | see 7.2 — bottom-heavy | under-used as a separator |

**The meanings the hairline is being asked to carry**, from the same 1px
treatment in the same two inks:
1. *different region* — `RoomHost.svelte:117` cap rule;
2. *different depth* — `.beat-card` border (tokens.css:738);
3. *different owner / voice* — the rule-led register (tokens.css:769-778);
4. *outcome state* — the leading edge, `border-left-color: --ok/--warn/--alarm/--beam`
   (806-817);
5. *scrollable beyond here* — `MicroSweep.svelte:108` `border-top`, and the
   desk/sweep housings.

**Five meanings, one treatment, two inks (`--line-1`, `--line-2`) whose
difference is 13 luminance steps in dark and 27 in light.** That is a precise
mechanical account of "unclear separation". Elevation and spacing — the two
tools that could carry depth and grouping — are almost entirely unspent, and
there is exactly one shadow value in the system, so *depth has one step*.

### 7.5 Menus and controls at rest — 29 controls are invisible until hovered

I scanned every rule that sets both `background: none`/`transparent` **and**
`border: none`/`0` outside a `:hover`/`:focus` selector. **29 interactive
controls render with no fill and no edge at rest:**

`shell/WorkspaceStrip.svelte:320` `.tab` · `:346` `.tab-close` ·
`shell/Horizon.svelte:342` `button` (**every button in the top chrome**) ·
`shell/ChordGrip.svelte:63` · `sweep/Sweep.svelte:999` `.tick` ·
`flow/Beat.svelte:914` `.beat-grip` · `flow/Flow.svelte:1696` `.head-verb` ·
`:1740` `.read-again` · `flow/BeatScope.svelte:177` and
`flow/BeatDepth.svelte:143` `.cause-link` · `flow/ThinkingFold.svelte:140` ·
`flow/Verb.svelte:104` (**the 55-use control**) · `editor/FileTree.svelte:165` ·
`editor/TextEditor.svelte:135` · `settings/SettingSheet.svelte:513` `.segment` ·
`:546` `.switch` · `computer/FindingNote.svelte:102` ·
`rooms/InstrumentCell.svelte:282` `.pin` · `rooms/SettingsRoom.svelte:536`,
`:688` `.row-face`, `:755` `.surface-link` · `desk/Gauge.svelte:228` ·
`desk/ChannelScope.svelte:143` · `desk/ChannelStrip.svelte:367`, `:499` ·
`render/ArtifactFrame.svelte:312` · `render/JsonNode.svelte:113`, `:183` ·
`render/ToolOutput.svelte:263`.

Plus two genuinely hover-gated affordances: `flow/Beat.svelte:884` (`opacity: 0`
→ 1 on `:hover`/`:focus-within`, the verb row) and `render/CopyButton.svelte:82`
(same). Both correctly include `:focus-within`/`:focus-visible`, so keyboard
reach is intact — but for a mouse they are undiscoverable until the pointer is
already there.

**This is a mouse-first product by binding correction (tokens.css:119-126 spends
a whole token, `--hit-min`, on exactly that argument), and 29 of its controls do
not look like controls until the mouse is on them.** The hit floor was fixed;
the *visibility* floor was never stated.

### 7.6 The premium trap

Rounded corners + soft shadows + generous whitespace is available here and would
help — 2px corners, one shadow value and 87%-of-spacing-under-12px are all
genuinely below table stakes. **But it cannot be the substance**, and this audit
should not be read as recommending it as such. Take it as the quiet floor.

The version available here that nobody can copy is in §3.1 and §4.3 and is
already half-built: **depth that is real** (the Popover genuinely *is* above,
and `--shadow-sheet` is spent only on things that are), **motion that can name
its cause** (the Bead cannot move without a logged event; the digit roll cannot
fire without a changed measurement), and **emphasis that is computed** (a
refused verb is refused because the record says the id is unpersisted, not
because a caller passed `disabled`). Those three are the substance. Corners and
shadows are the packaging, and the plan below treats them that way.

---

## 8. PRIOR-ART CHECK — state computed from the ledger

**Yes, one control already does it, and it is the best thing in the codebase.**

`flow/Verb.svelte` + `flow/verbs.ts`: the control's state is *derived from the
record*, not asserted by the caller.
- `verbs.ts:44-47` — rollback is refused because the beat id is a live
  client-appended id with no persisted counterpart, so the endpoint cannot
  address it. The reason is a fact about the ledger.
- `Verb.svelte:61-65` — every verb that declares `writes` is refused while a
  head is planted, with one owned sentence.
- `Verb.svelte:38-46` — a caller that asserts a state without evidence
  **throws** at the render boundary.

Two more places already carry the machinery and do not spend it visually:

- **The provenance stamp.** `data-prov` is stamped on 14 data-bound regions
  (`DeskPanel:245,259,324,336`, `Sweep:801`, `Reel:93,110`, `Parcel:181`,
  `MicroSweep:91`, `CustodyRoom:207,211,268`) and read by `lens/LensCallout` via
  `readTarget` (`lens-callout-data.ts:51-60`) under an explicit no-invention law.
  **Every one of those regions can already answer "where did this number come
  from" — and none of them shows any sign of it until the LENS is opened.** A
  region that knows its own provenance is a region that can be *emphasised* by
  it.
- **The settings row already computes salience.** `SettingsRoom.svelte:740`
  styles `.value[data-provenance="changed"]` differently because somebody made a
  decision there — computed dominance, in the product, today. It spends
  `--ink-2` → `--ink-1` on it. **That is the correct idea at 5% of its
  available strength**, and it is the proof that computed salience is
  implementable here without inventing anything.

**Could more controls do it? Yes, cheaply, because the data is already shaped
for it.** The `pending | measured | absent(reason)` union in §4.2 *is* a
ledger-derived state, computed in six modules. Nothing renders it as a state —
each surface unpacks it into ad-hoc prose. One shared element consuming that
union directly would convert twelve type declarations and seventeen `.absent`
rules into one honest primitive.

---

## 9. PROPOSED GRAMMAR

Derived from what §4 measured surfaces actually need — not invented. Every state
below already exists somewhere in the data layer; the proposal is to name it
once and dress it once.

### 9.1 The state axis — one vocabulary, replacing five

```
rest · hover · focus · armed · working · succeeded · refused · absent
```

Mapping to what exists (nothing here is new information, only newly named):

| State | Already computed at | Today |
|---|---|---|
| rest | — | undeclared |
| hover | 76 rules | `--layer-hover` by convention in 50/76 |
| focus | tokens.css:820 | one rule + 8 overrides |
| armed | `data-armed`, `sweep/arm-sync.ts` | no treatment |
| working | `Verb.svelte:69 busy`, `auth.loading` | a `…` suffix |
| succeeded | `Verb.svelte:76` (failure stays null) | **nothing** |
| refused | `BeatVerb.wired:false + reason` | one component |
| absent | `{kind:"absent"; reason}` ×12 | 17 conflicting rules |

Additionally **pending** should be distinguished from **absent** at the token
level, because the data layer already distinguishes them
(`switch-feed.ts:42-44`) and conflating them is the difference between "not
measured yet" and "measured, and there is nothing".

Required new tokens (small, and every one is currently being faked):
`--layer-disabled`, `--state-refused-ink`, `--state-absent-ink`,
`--state-pending-ink`, `--state-working-ink`, and one `--spark-*` duration for
arrivals. Nothing else. Note that **no new type or spacing tokens are needed for
dominance** — `--f-hero-size`, `--f-value-size`, `--sp-5..7` already exist and
are unspent.

### 9.2 The composition rule, stated once

Reuse the axis separation the token file already argues for at 691-727 and
extend it by one axis:

- **WHO / VOICE** — register (filled vs rule-led). Owned, working.
- **STATE** — the eight above. Carried on one element per control, one
  treatment, differing only in ink and (for the four outcomes) hue.
- **SALIENCE** — *new, and this is the dominance answer*: `data-salience` in
  `{quiet | normal | dominant}`, **computed**, never authored. It moves a control
  *up the existing scales* — one type step, one spacing step, one elevation step
  — and is never a bespoke treatment. Legitimate computed sources already
  present: `data-provenance="changed"` (SettingsRoom:740), `isError`
  (`categories.ts:127`), `beat.abnormal` (`beat-state.ts:234`), the now-edge, and
  a verb the record says is the live one.

### 9.3 The motion rule

Attach every animation to a row in §3.4. Formally: a motion may exist only if it
can name (a) the recorded event that fires it and (b) the element that
represents the thing that event changed. `--t-3` and `--ease-exit` are already
declared for the room cut and the exit and should be spent, not deleted.

### 9.4 Corollary — enforceable, and each is a test

1. No component may declare `.verb`, `.absent`, `.engraved` or `.note` — the
   shared owner does. (Scan: a class name declared in >2 files is a defect.)
2. `data-state` may only carry values from the one vocabulary. (Scan the
   bindings against the union type.)
3. Every disabled control carries a reason. (Extend `Verb.svelte`'s render-time
   throw to the shared button; it is already mutation-tested for the flow.)
4. Extend `cockpit-tokens-owner` to `<script>` blocks and `.ts` files — this
   alone catches all 18 literal colours (§2.1).
5. Any canvas surface reading tokens must re-read on `data-cockpit-theme`
   change. (Assert an observer exists; mutation-test by flipping the attribute.)

---

## 10. EMPHASIS WITHOUT OCCLUSION — focus + context

### 10.1 The mechanism exists, is excellent, and serves one surface

`flow/fisheye.ts` is a real degree-of-interest function: three levels
(`full → ghost → tick`, fisheye.ts:21) computed from three terms — causal
distance, recency, and the beat's own declared abnormality — and **it returns
its own reason in plain words** ("collapsed: 3 turns old, no effects",
fisheye.ts:24-27). The header states the law: "unexplained salience is a bug".
Its `focusTurnIndex: number | null` carries a scar from a real defect
(fisheye.ts:33-49): substituting the last beat for an absent focus degenerated
the three-term DOI into a pure age ramp and compressed the entire scrollback.

**This is the emphasis-without-occlusion mechanism the product needs, it is
already built, already honest, and it applies to exactly one thing: beats in the
flow.** Nothing else in the cockpit — not a room, not a reel, not a parcel, not
a settings row, not an instrument — has a compressed form.

### 10.2 Where the cockpit emphasises by REMOVING context

| Site | What it removes | Could compress instead? |
|---|---|---|
| `shell/RoomHost.svelte:95-99` — `.room { position: absolute; inset: 0; z-index: 30; background: var(--ground-0) }` | **Everything.** Five rooms (Switch, Custody, Instruments, Settings, Editor) each paint an **opaque full-shell takeover** over the flow, the sweep and the desk. A run continues underneath and the reader can see none of it. | Yes — this is the largest single occlusion in the product, and it is a plain `inset: 0` with an opaque ground. |
| `shell/ConnectionBlock.svelte:165-167` + `:119-120` — `.scrim { position: fixed; inset: 0 }`, `role="alertdialog" aria-modal="true"` | everything, deliberately | **Correct as-is.** The header (ConnectionBlock:6) records the user's own instruction that an unhealthy API must block the entire UX. The one justified modal. |
| `--monitor-display: none` at ≤1100px (tokens.css:607) | the pinned monitors, entirely | Partially defensible — the comment argues they are "one click away". But the token file **already has** the compressed form: `--spark-dot-w: 16px` (356) and `--monitor-w/h: 96×28` are the compressed rendering of the 280×96 `InstrumentCell`. The responsive step goes 280×96 → 96×28 → **gone**, when a third compression rung (a bare dot) is already built. |
| `rooms/DiffSheet.svelte`, `editor/DeleteConfirm.svelte`, `settings/SettingSheet.svelte` | their siblings, within their room | Sheets, not modals — acceptable, but none has a compressed sibling state. |

**Counter-example done right, and it should be the template:**
`flow/BeatDepth.svelte` — a tool beat "opens IN PLACE and never into a sheet"
(tokens.css:876-882), so the beat's full record appears under the card while
everything around it stays on screen. That decision is recorded, argued, and is
the exact behaviour rooms should have.

### 10.3 Is there range to compress rather than remove?

Split verdict — and the split is informative.

**Where range EXISTS and is used (the flow):**
- beat: full (~56px estimated, `Flow.svelte:815`) → ghost `--beat-ghost-h: 22px`
  → tick `--beat-tick-h: 12px`. **≈4.7:1.** Genuine range, and the tokens carry a
  written argument (tokens.css:269-279) about a ghost that once cost 88px and
  therefore bought nothing.
- instrument: cell 280×96 → monitor 96×28 → spark-dot 16px wide. **≈9:1 by
  area.** Also genuine — and then it goes to zero.

**Where range does NOT exist (everything else):**
- **Type has no compressed rung.** Smallest legible `--f-nano-size: 10px`
  against the normal `--f-ui-size: 13.5px` is a ratio of **0.74**, and against
  the dominant `--f-data-size: 12.5px` it is **0.80**. An author who wants to
  push something into the background by shrinking it has **one step of 2.5px**
  available, which is not enough to read as *receded* — it reads as a typo. This
  is the same "no range" finding as §7.1, at the other end of the scale: the
  code cannot be bold *or* quiet, because it lives in the middle of a scale it
  never leaves.
- **Ink has range and it is the only compression tool actually available**:
  `--ink-1..4` is four rungs and is used for exactly this. It is doing the work
  four tools should share.
- **Density** (`--row-h` 24/28/34, tokens.css:371, 514, 519) is a global
  preference, not a per-element DOI — and `--density-type-delta` is declared for
  exactly the missing type compression and is **dead** (§1.3).

**Conclusion:** compression-instead-of-removal is available in the flow and
nowhere else, and the reason is measurable — the flow is the only surface with a
DOI function *and* the only surface with more than one rung of size to spend.
Extending the fisheye is not the hard part; giving the other surfaces a
compressed rung to compress *into* is.

---

## 11. THE WATCHING SURFACE — a run in progress, with a human looking at it

This is a first-class state and it is the state the product is in most of the
time. Measured on its own terms.

### 11.1 What is actually live during a run — six real channels

Every one of these is real, recorded, and already on screen:

| Channel | Source | Rendered as | Moving? |
|---|---|---|---|
| beats arriving | `flow/Flow.svelte` virtualizer | new rows | appear, no arrival |
| the beat doing work | `flow/Bead.svelte` — derived from the log | a **5px** mark, `--beam` | **yes** — the only travelling motion in the product |
| characters arriving | `flow/StreamPulse.svelte:196-222` — measured rate, char count, and **the channel name** (thinking / reply / tool input) | **2px × 4px** cells; a `19ch` word; a count | yes, sub-pixel-scale |
| send-path milestones | `flow/WaitLine.svelte:107-124` — stage sentence, `"n of 3"` **only once genuinely observed** (WaitLine:111-113), and elapsed to one decimal ticking 5×/sec | 12.5px **italic `--ink-3`** in a **22px** row | text ticks; nothing moves |
| context filling | `desk/Gauge.svelte:112-123` — `contextTokens / limit` as a %, a real `style:width` fill bar, live `tok/s` | the bar is **`--ink-2` grey** and has **zero transition** (Gauge.svelte:203-206, and the file contains 0 `transition`/`animation` declarations) | **jumps** |
| the tool running right now | `desk/Gauge.svelte:131-133` — `● {executing}`, "from the live run stream" | a micro-size `●` and a name | static |
| new events on the band | `sweep/Sweep.svelte` at the now edge | bins repaint | **no animation at all** (Sweep.svelte:30) |

**Seven live channels. Total visible movement: one 5px dot travelling, a handful
of 2px cells changing colour, a grey bar jumping, and digits ticking in 12.5px
italic grey.**

That is the answer to "entertaining to watch": **the cockpit already knows
everything worth watching and renders almost none of it at a watchable scale.**
The data problem is solved. The expression problem is untouched.

### 11.2 Legible from across the room

**Essentially nothing.** Inventory of glanceable (non-textual) state during a
run:

- the Bead — 5px;
- the StreamPulse head cell — 2px wide, 10px tall;
- two `●` glyphs (`Gauge.svelte:116` "run streaming", `:132` the executing tool)
  at `--f-micro-size`/`--f-data-size`;
- the context fill bar — `--gauge-bar-h: 3px`, grey.

Everything else is 10–13.5px text in `--ink-3`/`--ink-4` (§7.1). **The one live
hue the system reserves — `--beam`, whose "rarity is the meaning"
(tokens.css:41-43) — is currently spent entirely on marks of 5px and 2px.** The
rarity discipline is right and worth keeping; the *scale* at which the rare thing
is drawn is the timid decision. A hue can be rare and still be large.

Note also that the thing which grows monotonically and meaningfully during a run
— the context bar — is painted `--ink-2`, i.e. the same grey as body text, and
is the one element that would read from across a room if it were not.

### 11.3 Depth to discover while waiting

Genuinely present, and better than most:

- **LENS** — hover any of 14 provenance-stamped regions and get the recorded
  source of that number, under a no-invention law (`lens-callout-data.ts:7-14`).
- **The fisheye's reason** — every compressed beat can state *why* it was
  compressed (fisheye.ts:24-27).
- **Beat depth** — a tool beat opens in place with its full record, its cause,
  and every verb including the refusing ones (tokens.css:876-882).
- **The stream channel word** — StreamPulse names *which* channel the characters
  belong to (thinking vs reply vs tool arguments), which is a genuinely
  interesting fact most tools do not expose at all.

**The gap is not depth; it is the invitation.** All four are hover- or
click-gated with no resting affordance (§7.5 — 29 controls invisible at rest),
so a watching user has no visual cue that there is anything to lean into. Depth
that announces nothing is depth nobody finds.

### 11.4 Operator-during interventions — what can be acted on the moment it appears

**The capability is real and it is well built.** `desk/ChannelStrip.svelte`
carries live composition verbs — mute a channel (`:213-217`), move the trim
point (`:234-266`), pin an item — each with `data-verb-id`, each refusing
honestly while a head is planted (`PAST_VIEW_ACT_REASON`), each recorded as an
`operator`-voice beat (`beat-state.ts:120,134`) that appears in the flow as a
thing that happened. That is the intervention loop, closed, with recording.

**Three things blunt it:**
1. It lives in the **desk, which is closed by default** (`--desk-h: 64px` closed
   vs `--desk-open-h: 280px`). The interventions are one gesture away from a
   watcher who does not know they exist.
2. **The flow itself offers no act at the moment something appears.** A tool
   beat arrives, and the verbs on it are `opacity: 0` until hovered
   (`Beat.svelte:884`).
3. An intervention lands as an `operator` beat with **no arrival response** —
   the register is correctly distinct (rule-led, `≡` mark) but the moment of
   acting produces no feedback (§3.4).

### 11.5 Why this is available here and nowhere else

Worth recording plainly, because it determines what the next writer should build
rather than merely how it should look. Every item in §11.1 is a **recorded**
fact the harness cannot avoid producing: the beat currently doing work, the
channel the characters belong to, the tool executing now, the measured rate, the
context actually consumed, the milestone genuinely reached. A competitor showing
the same screen would be animating an estimate — and the WaitLine's own comment
(`WaitLine:110-112`) shows the discipline: `"n of 3"` is withheld at zero
because that "would be a progress claim over no progress".

**The spectator surface is a dividend of the recording architecture, not an
addition to it.** It is interesting because it is true. That is also why the fix
is cheap: nothing new must be measured, computed or plumbed — the events are
named, addressed and arriving. What is missing is amplitude.

---

## 12. THE THREE PLACES CLOSEST TO EXCELLENT, HELD BACK BY ONE TIMID DECISION

Highest ratio of latent quality to remaining effort.

### 1. `flow/Verb.svelte` — a complete, ledger-computed state contract used by 4 of 19 surfaces

The contract is finished: wired/refused-with-reason/working/failed, computed
from the record, unrepresentable-if-wrong, mutation-guarded. **The one timid
decision: it was scoped to "a beat verb (spec §1.2)" instead of "a cockpit
control".** Fifteen files re-implemented the button and none of them inherited
the contract — so fifteen buttons in this product can still be disabled with no
reason, which is the exact defect the component was written to make impossible.
Promoting it to `shell/` and pointing the 15 at it is mostly deletion, and it
converts a local guard into a system-wide one.

### 2. `flow/Bead.svelte` + `flow/StreamPulse.svelte` — the only motion in the product that can name its cause, drawn at 5px and 2px

The Bead "NEVER moves without a corresponding event, and when the run stalls it
visibly holds". StreamPulse advances a cell per real token. **These are the two
things nobody can copy without rebuilding their recording layer, and they are
the two smallest marks on the screen.** The one timid decision: they were sized
as *instrument marks* (5px, 2px, `--ink-4`) rather than as *the product's
signature*. Amplitude costs nothing — the causes are already correct, the
reduced-motion path is already correct, `--f-value-size` and `--f-hero-size` sit
unused. This is the single cheapest route to "alive".

### 3. `boot/Registration.svelte` — real probes with measured durations, rendered as a static list

"Instruments checking in, truthfully" — every line a real probe with its own
measured ms, no splash, no spinner. It is the most distinctive first-run screen
idea in the codebase and it is the first thing every user sees. **The one timid
decision: the lines arrive as recorded facts and simply appear.** Each line has
an address, a cause and a measured duration already in hand
(`probes.ts:69-78`) — a per-line arrival spark is the textbook case of the
motion law, and the sign-in itself already measures its own ms
(`Registration:57-62`) and reports it to nobody. Adjacent and equally cheap: it
is also the surface that needs the five missing primitives (§6.3), so dressing
it *is* the acceptance test for the primitives work.

---

## 13. ORDERED PLAN — one writer at a time, each step independently verifiable

Ordered so that each step's verification does not depend on the next, and so
the cheapest high-yield work lands first.

**S1 — Close the guard's universe.** Extend `cockpit-tokens-owner.test.ts` to
scan `<script>` blocks and `src/cockpit/**/*.ts`, and add `ch`/`vh`/`vw` to the
length scanner. *Verify:* the suite goes RED naming all 18 literal colours
(MicroSweep:63,64 · Spark:97 · categories.ts:48-56,195-203) and the 8 unit
literals. Mutation-test by planting a hex in a `.ts`. **No source is fixed in
this step — the step's product is a red test that proves the finding.**

**S2 — Fix what S1 exposed, at the choke point.** Delete
`PALETTE_FALLBACKS_DARK` and the per-row `fallbackDark`; make the canvas
surfaces read tokens or fail honestly rather than fall back to a dark-only
guess. Collapse the `--cat-*` naming split: declare the ledger's eight names in
tokens.css and delete `aliasVar`. *Verify:* S1 goes green; sweep categories test
still passes.

**S3 — Canvas surfaces re-read on theme change.** One shared observer (this is a
cross-cutting concern with three consumers — it belongs in one place, not three
`$effect`s). *Verify:* flip `data-cockpit-theme` in jsdom, assert each painter
re-ran; mutation-test by removing the observer from one consumer.

**S4 — Declare the state axis in tokens.css.** Add the six state tokens (§9.1)
and the `data-state` / `data-salience` rules beside the existing `.beat-card`
block, whose comment (691-727) is already the template. Delete `--on-cat-*` ×8,
`--stream-rate-w`, `--editor-page-h`, `--bead-glow`, `--tick-w`,
`--verbs-pad-y`, `--density-type-delta`. **Keep `--t-3` and `--ease-exit`** —
they are spent in S8. *Verify:* dead-token scan (the script in this audit,
promoted to a test) reports zero; no visual change yet.

**S5 — Promote the shared control.** Move `flow/Verb.svelte` to `shell/`, widen
it to the eight-state axis, keep the render-time throw. Point the 15
re-implementations at it, file by file, deleting their `.verb` rules. *Verify:*
`class="verb"` appears in exactly one `<style>` block; the throw's
mutation test now covers 19 surfaces, not 4; assert the covered population as a
runtime number with a floor.

**S6 — One absence element.** Collapse the 12 `{kind:"absent"; reason}`
declarations into one exported union beside `lib/data/absence.ts` (which already
owns the *wording* correctly and is the precedent), and render it through one
component. Delete the 17 `.absent` rules and the 6 `.absence` rules. *Verify:*
one declaration site; `.absent` declared once; a planted second declaration
fails the scan.

**S7 — Field, label track, error, sheet body.** The four remaining primitives,
driven by what Registration needs (§6.3). Retires the three `12ch` literals.
*Verify:* Registration's `<style>` block shrinks to layout only; S1's unit
scanner stays green.

**S8 — Spend the scales.** Radius: relate nested radii (panel > card > control)
using the five values that exist. Spacing: lift container padding into
`--sp-4..7`. Type: spend `--f-value-size` and `--f-hero-size` where the product
has one number that matters. Elevation: a second shadow step so depth has more
than one rung. *Verify:* an e2e that asserts a child's radius is smaller than
its parent's, and that at least N surfaces use a type token above 15.5px.

**S9 — The sparks.** Work the §3.4 table top to bottom. Each animation names its
event in a source comment and is bound to the element that changed. Spend
`--t-3` on the room cut and `--ease-exit` on the exits. *Verify:* a scan that
every `animation:`/`transition:` in the cockpit is reachable from a named
recorded event; mutation-test by adding a mount-fired animation and asserting
the scan catches it. This is the step that makes the motion law mechanical
rather than aspirational.

**S10 — The watching surface** (§11). The highest-yield step and it needs no new
data. Amplify the three signatures of §12 (Bead, StreamPulse, Registration
arrivals); give the context bar a transition and the `--beam` hue so the one
monotonically-growing fact in a run is the one thing legible across a room; give
the `● executing` tool and the WaitLine milestones real amplitude. *Verify:* an
e2e that drives a synthetic run (`flow/dev/synthetic.ts` already exists) and
asserts each of the seven channels in §11.1 produces a measurable visual delta.

**S11 — Emphasis without occlusion** (§10). Two parts, and part (a) is the
larger win: (a) rooms stop being opaque `inset: 0` takeovers — the flow
compresses behind them rather than disappearing, using the DOI mechanism that
already exists; (b) add the third compression rung the responsive step is
missing, so pinned monitors compress to a dot instead of to nothing, and spend
the dead `--density-type-delta` so type has a compressed rung at all.
*Verify:* with a room open, assert the flow is still measurably on screen;
assert `--monitor-display: none` no longer appears at any width. **Leave
`ConnectionBlock`'s modal alone — it is the one justified occlusion and the
user asked for it.**

**S12 — Delete `src/lib/auth/LoginGate.svelte` and the old component tree.**
*Caution for whoever schedules this:* the cockpit imports **57 times from
`src/lib/data/**` and twice from `src/lib/shared/**`** (`absence.ts`, `asof.ts`,
`broker.ts`, `connection.ts`, `errors.ts`, `html-preview.ts`). `src/lib` is
**not** uniformly the retiring UI — the *component* directories are; the data
layer is live shared infrastructure and must survive. A brief that says "delete
src/lib" will break the cockpit.

---

## 14. WORKFLOW FINDING

**A design-token audit needs a dead-token scan the same way a config needs a
write gate, and this repo has the second and not the first.** The token owner is
guarded in five directions (no literals, no local declarations, no theme blocks,
no stray CSS files, required groups present) and in **zero** directions for
whether a declared token is ever consumed. That asymmetry is why `--t-3`
(the room cut) and `--f-hero-size` (the one hero numeral) could sit declared,
commented, load-bearing in the spec, and unconsumed — with the required-groups
test (E, test:155-181) actively asserting `--t-3` *exists* while nothing
asserted it *does anything*. **A guard that asserts presence without asserting
consumption is the CSS form of wired-but-inert**, and it passed green the whole
time. The ~30-line scan used for §1.3 of this audit should be promoted to
`tests/cockpit/`, with the exception list empty and any intentional
declared-but-unused token required to justify itself in source.

---

## 15. COVERAGE — what I read versus took on trust

**Read in full:** `src/cockpit/tokens.css` (924 lines) ·
`tests/cockpit/cockpit-tokens-owner.test.ts` · `src/lib/auth/LoginGate.svelte` ·
`src/cockpit/rooms/Spark.svelte` · `src/cockpit/rooms/MicroSweep.svelte` ·
`src/cockpit/flow/Bead.svelte` · `TIER1-AGENT-CONTRACT.md`.

**Read in relevant part:** `src/cockpit/boot/Registration.svelte` (script +
markup + style head) · `src/cockpit/boot/probes.ts` (types) ·
`src/cockpit/flow/Verb.svelte` (full script + style) · `src/cockpit/flow/verbs.ts`
(head) · `src/cockpit/sweep/categories.ts` (full) · `src/cockpit/sweep/Sweep.svelte`
(geometry + palette + mount) · `src/cockpit/lens/lens-callout-data.ts` (head) ·
`src/lib/data/absence.ts` · `src/cockpit/main.ts` ·
`src/cockpit/flow/StreamPulse.svelte` (style) ·
`src/cockpit/rooms/InstrumentCell.svelte` (style) ·
`src/cockpit/shell/RoomHost.svelte` (style) · `src/cockpit/rooms/SettingsRoom.svelte`
(style excerpt) · `src/cockpit/flow/fisheye.ts` (head + DOI contract) ·
`src/cockpit/flow/WaitLine.svelte` (markup + style) ·
`src/cockpit/flow/wait-stage.ts` (`WAIT_SAY`, milestone count) ·
`src/cockpit/desk/Gauge.svelte` (markup + `.fill`) ·
`src/cockpit/desk/ChannelStrip.svelte` (verb sites) ·
`src/cockpit/shell/ConnectionBlock.svelte` (scrim + modal role).

**Measured mechanically across all 70 components + all `src/**/*.{svelte,ts,css}`:**
token declarations and consumption (including `getPropertyValue`/`setProperty`
forms); literal colours/lengths/durations inside comment-stripped, `var()`-stripped
`<style>` blocks; `border-radius` value distribution; `border-*` declaration
distribution; `box-shadow` sites; `background: var(--ground-N)` distribution;
spacing- and type-token use counts; `font-weight` distribution; `:hover`,
`:focus-visible`, `:active`, `:disabled` rule counts and what each changes;
`data-*` attribute frequency; class-name frequency and per-class rule-declaration
file counts; `@keyframes`, `animation:`, `transition:` and Svelte transition
inventory; controls with no background and no border outside a hover/focus
selector; `onInvalidation` call sites.

**Taken on trust — verify before acting:**
1. **I ran no tests and no browser.** Every rendering claim (theme switch leaving
   the sweep dark; 29 controls invisible at rest; nested radii not relating) is
   derived from source and is falsifiable in a browser in minutes. The theme-switch
   claim is the one I would check first, because it is the most consequential and
   rests on Svelte 5 `$effect` dependency semantics — an attribute change on
   `documentElement` not being a tracked dependency of an effect reading
   `canvas`/`points`. I am confident in the reasoning and it is worth one
   empirical confirmation before S3 is scheduled.
2. **I did not read `flow/Beat.svelte` (1000+ lines), `flow/Flow.svelte`,
   `Cockpit.svelte`, or `rooms/SwitchRoom.svelte` in full** — only the regions
   the greps pointed at. A state treatment buried in one of those and not
   matching any of my patterns would be missed.
2b. **The room-occlusion claim (§10.2) rests on `RoomHost.svelte:95-99` plus
   `Cockpit.svelte:860` mounting `RoomHost` as a sibling of the flow outlet at
   `z-index: 30`.** I did not read `Cockpit.svelte`'s full stacking context, so
   confirm empirically that an open room does in fact hide the flow before S11
   is briefed — it is the step's entire premise.
3. **`--t-3` and `--ease-exit` being dead** rests on a tree-wide scan for
   `var(--x)`, `getPropertyValue("--x")` and `setProperty("--x")`. A token
   assembled from string fragments would evade it. I judged this unlikely but did
   not prove it; the `--cat-*` case (§1.3) proves the pattern class is real, so
   the S4 deletions should each be confirmed by a basename grep before removal.
4. **Contrast ratios** in the tokens.css comment (800-805) are asserted there and
   recomputed by `tests/cockpit/flow-tool-symmetry.test.ts`; I did not recompute
   them and did not run that test.
5. **The 8-hue wheel's perceptual separation** and the light-theme re-derivation
   are taken as designed; I checked their *structure*, not their appearance.
