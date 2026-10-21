---
layout: default
title: 'How `shared/` should be split, and along which axes'
---

# How `shared/` should be split, and along which axes

**Status:** read-only analysis. Nothing was edited, created or deleted outside this file.
**Method:** every count in this document comes from **bytes** — `readFileSync` + in-process
matching over a walked file set — never from `grep`. The scripts are in the session scratchpad
(`graph2.mjs`, `man.mjs`, `coh.mjs`, `layer2.mjs`, `alias.mjs`, `dup2.mjs`, `clusters.mjs`).
**Universe:** 2,303 source files (`.ts .mts .cts .tsx .mjs .cjs .js .jsx .svelte`) across
`harness-main-v1/integration/{src,test,scripts,guardian,verification,traceability}` and
`web-interface-foundation-v1/{src,tests,server,contracts,scripts,bench}`. `node_modules`,
`dist`, `experiments`, `_experiments`, `.bkp` excluded. 7,146 resolved import edges,
1,162 imported modules.

**Snapshot for §8b (live-tree claims).**
`harness-main-v1` HEAD `0a0044284eb02e79da17cc6a89b5cd44ffe94b21` (2026-07-28T13:15:45-04:00);
`web-interface-foundation-v1` HEAD `3812f01a6936eb9a722f594f20016fd9f2bf39fe` (2026-07-28T12:27:57-04:00).
A writing agent is active. `src/architecture-manifest.ts` was written at 13:21:32 **during**
this analysis; I re-parsed it afterwards and got **721 modules, 0 differences** in every
`realm`/`layer` field — so the manifest claims below are stable across that write. mtimes for
the other load-bearing files are given inline where the claim is made.

---

## LADDER VERDICT

> **Rung reached: 2 and 3 are available for most of this, and that is the recommendation.**
>
> **Rung 1 (physically impossible)** — unavailable for *file placement*: no OS or engine
> refuses to create `src/shared/utils/misc.ts`. It IS available for one sub-problem, the
> cross-repo door (§4.4): a `package.json` `"exports"` map makes deep paths **unresolvable by
> the module resolver**, which is the loader refusing, not a scanner complaining.
> **Rung 2 (unrepresentable)** — available and under-used. `ArchitectureModule` already
> carries `realm`, `layer`, `executionBoundary`, `effects`, `dependencies`. Making
> `allowedDependencyLayers` and a new `allowedRealms` non-optional and machine-derived from
> the declaration means an illegal edge is a **type error**, not a scan finding.
> **Rung 3 (unreachable by shape)** — available: a cluster whose only export is a factory
> requiring a capability token cannot be reached by a module that has no token.
> **Rung 4 (runtime choke point)** — available for registries (auto-discovery via `readdirSync`
> over a folder, refusing unknown entries) and is the right rung for the registration lists.
> **Rung 5 (source scan)** — where the two repos live today for placement, and where the
> `@harness/*` door demonstrably failed (measured: **1 of 90** cross-repo imports use it).
>
> **The taxonomy itself is a rung-6 artifact — directory names are convention.** That is the
> honest verdict and it is the reason this document's recommendations attach a *mechanism* to
> every directory rule. A directory layout with no mechanism is documentation.

---

## 0. The three findings that should be read first

These came out of the inventory and each is a live defect, not a design opinion.

**F1 — `DEFAULT_LOCK_TIMEOUT_MS` has two owners with two different values.**
`integration/src/shared/workflow/workflow-config.mjs:18` declares `60_000`.
`integration/src/workflow/workflow-config.ts:48` declares `120_000 as const`.
Both files' header comments claim to be *the* canonical owner. `src/workflow/resource-lock.ts:24-25`
re-exports and consumes the `.ts` value; `scripts/merge-round.mjs` consumes the `.mjs` value.
So the merge lock waits 60 s from a script and 120 s from TypeScript. mtimes: `.mjs`
2026-07-25 09:21:46, `.ts` 2026-07-28 11:22:28 — the drift is real and recent.
The stated reason for the split is *"the `.mjs` workflow scripts run under plain `node` and
cannot import the `.ts` workflow config"*. **That is a runtime/module-system axis being
expressed as a duplicated file**, and it has already drifted exactly the way §1 predicts. It is
the single strongest argument in this document for "a second axis is a projection, never a copy".

**F2 — the shared layer's own exposure registration is unplugged.**
`integration/src/shared/exposure/registrations/shared.ts` (76 lines, mtime 2026-07-24 15:54:59)
exports `registerSharedExposure` and `resetSharedRegistration`. `registrations/index.ts`
imports **12** registration files (`awareness, bias, context, editor, hallucination, learning,
memory, privacy, quality, safety, search, tools`) into a hand-written `MODULE_REGISTRATIONS`
array — and **`shared.ts` is not among them**. Measured: 0 import consumers; the only file
anywhere referencing either export is `test/architecture/dead-export-scanner.test.ts`. The
completeness guard `test/shared/exposure-registrations.test.ts` iterates
`registeredModuleNames()`, which is derived *from the same list*, so it passes **vacuously**.
This is §0's tell in its purest form: the list is the mechanism, so the one thing the list
forgot is invisible. It is also darkly apt that the forgotten module is the one describing
`src/shared/` itself.

**F3 — three `percentile` owners with three incompatible contracts, two of them in the same
`shared/` folder.**

| owner | signature | units of `p` | empty input | algorithm |
|---|---|---|---|---|
| `integration/src/shared/numeric-helpers.ts:36` | `percentile(sortedAsc, p)` | **fraction 0–1** | returns **0** | nearest-rank floor |
| `integration/src/shared/stats.ts:63` | `percentileOf(value, sortedAsc)` | — (inverse direction) | returns 0 | Type-4 / parzen |
| `web/bench/lib/stats.ts:61` | `percentile(sorted, p)` | **percent 0–100** | returns **NaN** | linear interpolation |

`numeric-helpers.percentile(xs, 50)` computes `min(n-1, floor(50 * n))`, i.e. it silently
returns the **maximum** — a caller who brings the percent convention gets a plausible number
and no error. `numeric-helpers.ts` (47 consumers) and `stats.ts` (2 consumers) are **siblings in
`src/shared/`**. This is precisely the junk-drawer failure the brief asks me to design against,
and it is already present at depth 1.

---

## 1. What is actually shared today, grouped by what it does

### 1.1 The four existing shared-shaped directories, measured

| directory | files | import edges into it from outside | distinct outside consumers | distinct entry files ("doors") | cohesion* |
|---|---:|---:|---:|---:|---:|
| `integration/src/shared/` | 88 | 280 | 219 | **41** | 0.38 |
| `web/src/lib/shared/` | 30 | 224 | 84 | **28** | 0.08 |
| `integration/test/support/` | 36 | 213 | 155 | **18** | 0.06 |
| `web/tests/helpers/` | 14 | 329 | 228 | **12** | 0.01 |
| `integration/verification/benchmarks/shared/` | 9 | 12 | — | 6 | — |
| `integration/src/quality/languages/shared/` | 2 | 12 | — | 2 | — |

\* cohesion = internal edges ÷ (internal + inbound edges). High = a subsystem that mostly talks
to itself. Low = a utility layer that everything reaches into.

**Cohesion is the discriminator, and it separates these directories into two different kinds of
thing that currently share one name.** Inside `integration/src/shared/`:

| sub-tree | files | internal edges | inbound edges | outside consumers | cohesion | what it actually is |
|---|---:|---:|---:|---:|---:|---|
| `memory/` | 23 | 70 | 7 | **5** | **0.91** | a subsystem |
| `llm/` | 10 | 24 | 12 | 10 | 0.67 | a subsystem |
| `exposure/` | 24 | 37 | 24 | 13 | 0.61 | a subsystem |
| `dedup-compression/` | 10 | 23 | 16 | 5 | 0.59 | a subsystem |
| `debug/` | 2 | 1 | 49 | **48** | **0.02** | a genuine cross-cutting utility |
| loose root files | 15 | — | — | — | — | mixed: utilities + two subsystem fragments |
| `workflow/` (`.mjs`) | 4 | 0 | 0 | 0 | — | script config; 0 import consumers (see F1) |

**73 of 88 files (83%) under `integration/src/shared/` are subsystem folders, not shared
utilities.** `memory/` has 23 files and **five** consumers outside itself. It is in `shared/`
because it is *reusable*, not because it is *shared*. That conflation is the root cause of the
junk drawer: the word "shared" is doing two jobs — "used by many" and "not owned by anyone in
particular" — and only the first is measurable.

### 1.2 The manifest already answers "is this shared?", and it disagrees with the directory

`integration/src/architecture-manifest.ts` declares **721 modules**, each with
`realm: "builder" | "runtime" | "shared" | "safety"`.

- **174 modules are declared `realm: "shared"`.**
- **Only 89 of them live under a directory named `shared/`.**
- **85 (48.9%) are declared shared and live somewhere else** — `src/errors.ts`,
  `src/integrity.ts`, `src/root-policy.ts`, `src/path-boundary.ts`, `src/ordered.ts`,
  all 13 `src/privacy/*` grammar and lexicon modules, all 6 `src/evaluation/*`, all 7
  `src/quality-packs/prevention/*`, `src/text/utf8-offsets.ts`, …
- **10 modules physically under a `shared/` directory are declared NOT shared** — the 8
  `verification/benchmarks/shared/*` (declared `builder`) and both
  `src/quality/languages/shared/*` (declared `runtime`).

So for the 184 modules where directory and declaration both have an opinion, **they disagree
about 95 of them (52%)**. The directory is not currently carrying the axis; the declaration is.

**And the declaration itself over-claims.** Joining the manifest against the measured import
graph (consumers mapped to their own declared realm):

| declared realm | modules | consumed by ≥2 realms | consumed by exactly 1 realm | no in-manifest consumer |
|---|---:|---:|---:|---:|
| `shared` | 174 | **45 (26%)** | **104 (60%)** | 25 |
| `runtime` | 365 | **34** | 256 | 75 |
| `builder` | 181 | 2 | 99 | 80 |

`realm: "shared"` over-claims by roughly 2.3×, and 34 `runtime` modules are genuinely
cross-realm — `src/timeline/timeline-store.ts` (49 consumers), `src/runtime/tool-registry.ts`
(39), `src/config.ts` (25), `src/intelligence/intelligence-config.ts` (16). The interesting
number is not "how many things are in `shared/`"; it is **"how many consumer classes does this
module have"**, and that is computable, not declarable.

### 1.3 The real cross-side surface is tiny

Classifying every file by production side (`FRONTEND` = `web/src`, `WEBSERVER` = `web/server`,
`CONTRACTS` = `web/contracts`, `ENGINE` = `integration/src`) and counting modules whose
consumers span **more than one production side** — tests excluded, because a test importing
production code is not evidence of sharing:

**56 modules of 2,303 (2.4%) are consumed by more than one production side.**

| signature | count |
|---|---:|
| `ENGINE + WEBSERVER` | 45 |
| `FRONTEND + WEBSERVER` | 5 |
| `CONTRACTS + FRONTEND + WEBSERVER` | 3 |
| `CONTRACTS + ENGINE` | 1 |
| `CONTRACTS + FRONTEND` | 1 |
| `CONTRACTS + WEBSERVER` | 1 |

**No module anywhere is consumed by both `FRONTEND` and `ENGINE`.** The 45 `ENGINE+WEBSERVER`
entries are the harness engine reached through the web server's bridge files — measured, the
two repos are joined by **88 import edges through 32 web files**, of which 18 are
`server/*-bridge.ts` / worker files, and **0 edges run integration → web**.

**Consequence for the user's proposed root `shared/`:** the population of "code shared between
the frontend and the backend" is **9 modules**, and **all 9 already live in `web/contracts/`**
(`module-contract.ts` 58 consumers, `ui-schema.ts` 37, `constants.ts` 28, `wire-types.ts` 19,
`routes.ts` 13, `event-types.ts` 6, `errors.ts` 5, `block-contract.ts` 6, `web-ui-types.ts` 2)
plus one straggler, `web/src/lib/when-eval.ts` (10 consumers, FRONTEND+WEBSERVER). A root
`shared/` is therefore not a new container to be filled — **it is `contracts/` under a
different name, plus one file that should move into it.**

### 1.4 The clusters, derived from the code

I did not start from a list. I read the exports of every module in every shared-shaped
directory plus every module with ≥20 consumers, and grouped by what the exported names *do*.
The clusters that fell out, with measured import-edge totals:

| cluster | modules | edges | owners today (edges) |
|---|---:|---:|---|
| hashing / integrity / canonicalisation | 7 | 517 | `I:src/integrity.ts` 391, `W:server/canonical.ts` 59, `I:src/json-integrity.ts` 30, `I:src/safe-structural.ts` 24, `I:src/ledger-canonical.ts` 7, `W:server/digest.ts` 3, `I:src/shared/dedup-compression/shared-helpers.ts` 3 |
| errors + error vocabulary | 8 | 450 | `I:src/errors.ts` 306, `W:server/errors.ts` 80, `W:src/lib/data/errors.ts` 32, `I:src/mcp/errors.ts` 12, `I:src/shared/llm/errors.ts` 6, `W:src/lib/shared/error-messages.ts` 6, `W:contracts/errors.ts` 5, `I:test/support/legacy-errors.ts` 3 |
| environment + config resolution | 5 | 253 | `I:src/root-policy.ts` 137, `W:server/config.ts` 60, `W:src/client-config.ts` 28, `I:src/config.ts` 25, `I:src/shared/dev-mode-env.ts` 3 |
| source parsing / AST scanning | 8 | 250 | `W:tests/helpers/source-scan.ts` 150, `I:src/shared/source-scan.ts` 32, `I:src/quality/checks/shared.ts` 26, `W:tests/helpers/function-scope.ts` 17, `I:src/quality-packs/prevention/ast-helpers.ts` 11, `I:src/shared/source-structure.ts` 6, `I:test/support/source-scan.ts` 4, `W:tests/helpers/error-scan.ts` 4 |
| types / wire contracts | 16 | 249 | `W:contracts/module-contract.ts` 58, `I:src/config-contracts.ts` 43, `W:contracts/ui-schema.ts` 37, `W:contracts/types.ts` 22, `W:contracts/wire-types.ts` 19, `I:src/awareness/types.ts` 71 … |
| temp directories / fs fixtures (test) | 4 | 206 | `I:test/support/temp-dir.ts` 115, `W:tests/helpers/temp-dir.ts` 85, `I:test/support/repository-local-temporary.ts` 6 |
| UI presentation components | 19 | 150 | all `W:src/lib/shared/*.svelte`; `Icon` 36, `Button` 22, `EmptyState` 17 … |
| observability / debug logging | 4 | 104 | `I:src/shared/debug/debug-system.ts` 45, `W:src/lib/shared/client-debug.ts` 28, `W:server/debug-bridge.ts` 26, `I:src/shared/debug/debug-config.ts` 5 |
| numeric + statistics | 5 | 64 | `I:src/shared/numeric-helpers.ts` 47, `W:bench/lib/stats.ts` 10, `W:src/lib/shared/array-stats.ts` 4, `I:src/shared/stats.ts` 2, `W:src/lib/shared/arc-geometry.ts` 1 |
| failure containment (best-effort / abort) | 2 | 60 | `I:src/shared/best-effort.ts` 55, `I:src/shared/abort-signals.ts` 5 |
| http / transport test doubles | 4 | 57 | `W:tests/helpers/multi-user.ts` 28, `http-server.ts` 13, `json-request.ts` 11, `mock-http.ts` 5 |
| formatting / presentation (human-facing) | 4 | 43 | `W:src/lib/shared/format.ts` 32, `html-preview.ts` 6, `highlight.ts` 3, `markdown-parser.ts` 2 |
| path handling + boundaries | 5 | 39 | `I:src/path-boundary.ts` 24, `I:src/shared/path-utils.ts` 6, `I:src/linux-path.ts` 6 … |
| design tokens / thresholds | 3 | 36 | `W:contracts/constants.ts` 28, `W:src/lib/shared/ui-thresholds.ts` 6, `W:contracts/web-ui-defaults.ts` 2 |
| validation / type guards | 3 | 31 | `W:server/validate.ts` 15, `I:src/shared/type-guards.ts` 13, `W:contracts/input-schemas.ts` 3 |
| text similarity / tokenisation | 5 | 30 | `I:src/memory/unified/tokenizer.ts` 10, `I:src/shared/similarity.ts` 8, `I:src/shared/memory/retrieval/text-utils.ts` 6 … |
| identity / equality / ordering | 3 | 27 | `I:src/ordered.ts` 20, `I:src/shared/json-pointer.ts` 4, `I:src/shared/identity.ts` 3 |
| tree-sitter / language parsing (agnostic half) | 5 | 20 | `I:src/quality/languages/shared/tree-sitter-{loader,walker}.ts` 6 each, `shared-helpers.ts` 3, `I:src/awareness/languages/tree-sitter-base.ts` 3, `generic.ts` 2 |
| browser / DOM behaviour | 2 | 5 | `W:src/lib/shared/virtual-visibility.ts` 4, `scroll-restore.ts` 1 |
| time / duration | 1 | 1 | `I:src/shared/long-task-timing.ts` 1 |

**Read the "owners today" column, not the cluster names.** Nine of the twenty clusters have
**three or more owners spread across sides**. That, and not the folder layout, is the actual
disorder. A taxonomy that reshuffles directories without collapsing those owners moves the
problem rather than solving it.

**The layer composition of each directory, measured by import specifier and by comment-stripped
identifier use** (`node:*` import ⇒ node-IO; `.svelte` or a `svelte` import ⇒ UI-component;
`document`/`window`/`IntersectionObserver`/… in the code view ⇒ browser-IO; no value export ⇒
types-only; else pure):

| directory | pure | node-IO | browser-IO | UI-component | types-only |
|---|---:|---:|---:|---:|---:|
| `integration/src/shared/` (88) | **72 (82%)** | 12 | 0 | 0 | 4 |
| `integration/src/` (540) | 416 (77%) | 87 | 11 | 0 | 26 |
| `web/src/lib/shared/` (30) | 9 | 0 | 2 | **19 (63%)** | 0 |
| `integration/test/support/` (36) | 14 | **18 (50%)** | 0 | 0 | 4 |
| `web/tests/helpers/` (14) | 6 | **7 (50%)** | 0 | 0 | 1 |
| `web/contracts/` (13) | 11 (85%) | 0 | 0 | 0 | 2 |

Two things follow. First, `web/src/lib/shared/` is **63% Svelte components** — it is a component
library with eight loose helpers stapled on, and those two populations have nothing in common
except the word "shared". Second, the test-helper directories are **50% node-IO**, which is the
opposite of the production shared layers; a test helper's defining characteristic is that it
*touches the machine*, and that is the property worth naming.

---

## 2. The axes: which is a directory, which is a suffix, which is a field

### 2.1 The cross-product, measured

Cardinalities observed in this tree: **side = 6** (frontend, webserver, contracts, engine, test,
tooling); **domain = 74** distinct top-level module folders across both repos; **layer = 8**
(the manifest's 7 declared layers plus "undeclared"); **language = 8**
(typescript, javascript, python, go, rust, java, c-cpp, generic — observed across
`src/quality/languages/`, `src/awareness/languages/`, `src/quality-packs/`).

**Saturated cross-product: 6 × 74 × 8 × 8 = 28,416 directories for 2,303 files** — 0.08 files
per directory. That is not a hypothetical: the failure begins long before four axes.

| directory scheme | occupied cells | median files/cell | cells with ≤2 files | cells with ≤5 files |
|---|---:|---:|---:|---:|
| side | 6 | 362 | 0 (0%) | 0 (0%) |
| side × layer | 17 | 18 | 3 (18%) | 4 (24%) |
| side × domain | 110 | 9 | 21 (19%) | 41 (37%) |
| **side × domain × layer** | **147** | **5** | **46 (31%)** | **77 (52%)** |

**The trap opens at the third axis.** Two axes as directories is fine (median 9 files/cell, 19%
starved). Three is already half the cells at ≤5 files and a third at ≤2. Four is unsalvageable.

**And it is not theoretical here — the flat form of the trap is already in the tree.**
`integration/src/awareness/languages/` holds `go.ts`, `go-tree-sitter.ts`, `python.ts`,
`python-tree-sitter.ts`, `rust.ts`, `rust-tree-sitter.ts`, `typescript.ts`, `generic.ts`,
`tree-sitter-base.ts`, `index.ts` — language × parser-backend flattened into filenames. Six
languages × two backends is twelve files with nowhere to put a third backend. Twenty metres
away, `integration/src/quality/languages/` does it correctly: `c-cpp/parser.ts`, `go/parser.ts`,
`java/parser.ts`, `js-ts/parser.ts`, `python/parser.ts`, `rust/parser.ts`, plus
`shared/tree-sitter-loader.ts` and `shared/tree-sitter-walker.ts` (6 consumers each) holding the
agnostic half. **Both patterns are live in one repo, which means the codebase already contains
its own A/B test and the answer is on the `quality/` side.**

One blemish on the good example: `src/quality/languages/shared-helpers.ts` (3 consumers) sits as
a **file** beside the `shared/` **folder** (2 files, 12 consumers). Two doors to the
language-agnostic half, at depth 1, in the directory held up as the template.

### 2.2 The answer per axis

**SIDE → directory. Confidence: high.** It is the only axis with no near-empty cells (6 cells,
min 211 files), it maps to the build graph (`tsconfig.json` vs `tsconfig.server.json` vs
`tsconfig.tests.json` — three real compilations), and it maps to a physical capability boundary
(`node:fs` is reachable from three of six sides and not the others). The web repo already has
this shape under different names: `src/` = frontend, `server/` = backend, `contracts/` = shared,
`tests/` = tests. **The rename `src/`→`frontend/`, `server/`→`backend/`, `contracts/`→`shared/`
buys clarity and costs 1,122 import specifiers across 732 files** (measured blast radius of any
path segment named `shared`/`support`/`helpers`). That is a real cost against a real gain; it is
the user's call, but it is a rename, not a restructuring, and it should be done in one
mechanical move or not at all.

**LAYER → a field on the declaration, and a *lint* on the directory. Confidence: high, and the
repo already agrees.** `ArchitectureModule` carries `layer` (7 values, 462 of 721 modules are
`domain`), `executionBoundary` (5 values: 524 pure, 66 composition-root, 64 verification, 48
effect-adapter, 19 read-adapter) and `effects` (9 values; 567 modules declare none). Critically,
`LAYERS` in `architecture-manifest.ts` maps each layer to its `allowedDependencyLayers`, so an
illegal edge is already **derivable** rather than describable. Making layer a directory would
multiply cells by 8 and would fight the fact that a domain module and its adapter belong in the
same reading unit. **Recommendation: keep `layer` as a field; forbid a directory named after a
layer** (`domain/`, `application/`, `ports/` are acceptable *inside* a bounded module because
they are then side × domain × layer at depth 3 with a bounded fan-out — which is exactly what
`src/modules/tasks-agents/{domain,application}/` already does — but never at the root).

**DOMAIN → directory. Confidence: high.** 74 domains, median 9 files, 19% starved at ≤2 — the
best-populated axis after side. This is the axis the two repos already use and it should stay.

**LANGUAGE → directory *inside the specific module*, never at the root, and never in a
filename. Confidence: high; template already in-tree.** The user's own example ("if we build
quality packs for python, we store them under the python sub-folder") is exactly
`src/quality/languages/python/parser.ts`. Two corrections to the current state:
`src/quality-packs/typescript-pack.ts` (975 lines, 4 consumers) is a language-specific pack sitting
flat and should be `src/quality-packs/languages/typescript/pack.ts`; and
`src/awareness/languages/` must be nested (`go/{ast,tree-sitter}.ts`) rather than flattened.

**RUNTIME / MODULE-SYSTEM (`.ts` vs `.mjs`) → the axis nobody named, and the one that has
already caused a live defect.** It is currently expressed as a duplicated file (F1). It must be
expressed as a **generated projection**: one owner in `.ts`, an `.mjs` file emitted from it and
refused if stale — which is the same shape as `unicode-case-fold.generated.ts` already in the
tree. Never two hand-edited files.

**PROVIDER / TRANSPORT / STORAGE-BACKEND / EXPORTER / EFFECT-KIND → directory, one file per
implementation, auto-discovered.** These are already correct and should be the template:
`src/mcp/transport/{http,sse,stdio,websocket}.ts + helpers.ts + types.ts`, and
`src/shared/memory/storage/{append-log,json,msgpack,sqlite}-backend.ts + backend.ts + serde.ts`
(`backend.ts` 6 consumers, `serde.ts` 5 — the agnostic half is genuinely shared).

**Summary table.**

| axis | carrier | why |
|---|---|---|
| side (frontend / backend / shared / tests / tooling) | **root directory** | 6 well-populated cells; matches three real tsconfigs and a real capability boundary |
| domain (intelligence, quality, custody, privacy, editor…) | **directory** under side | 74 cells, median 9 files |
| implementation-of-one-concept (language, transport, storage, provider, exporter) | **directory** under the owning domain, one file per implementation, **auto-discovered** | template already correct in `mcp/transport/` and `memory/storage/` |
| layer (types / pure / IO-touching) | **field** on the module declaration (`layer`, `executionBoundary`, `effects`) | 8 values × 74 domains = starvation; already declared and already used to derive `allowedDependencyLayers` |
| "is this shared?" | **derived**, never declared and never a folder name | declaration and folder already disagree about 52% of the modules that have both, and the declaration over-claims 2.3× against measured consumption |
| runtime / module system (`.ts` / `.mjs`) | **generated projection** from one owner | the only alternative in use is a duplicated file, which has already drifted 60 s vs 120 s |
| platform (Linux-only, e.g. Landlock) | **filename suffix** + a runtime capability check | 1–2 files per platform; a `linux/` directory holding one file is 22% of this tree's directories already |

### 2.3 Where the cross-product would bite, exactly

1. **`tests/` × side × domain.** `web/tests/` already has `prevention/` (211 files), `cockpit/`
   (133), `unit/` (99). Adding a side layer under each produces `tests/prevention/frontend/…`,
   `tests/prevention/backend/…` — and the measurement says most prevention tests are
   cross-side (`source-scan.ts`'s 150 consumers break down FE 46 / WS 54 / CT 18 / EN 6), so
   the split would be arbitrary for the majority. **Do not add a side axis under `tests/`.**
2. **`shared/` × layer × domain.** `integration/src/shared/` is 82% pure. A
   `shared/pure/`, `shared/io/`, `shared/types/` split puts 72 files in one bucket, 12 in
   another and 4 in a third. Zero information gained, three doors created.
3. **language × parser-backend.** Already flat in `awareness/languages/` (12 files); nesting
   is correct, but nesting *and then* adding a layer axis (`go/domain/parser.ts`) would create
   six one-file directories.
4. **side × language.** `frontend/languages/python/` will never exist. The language axis lives
   under exactly two domains (`quality`, `awareness`) and must not be lifted above them.

---

## 3. `tests/shared/` — worked out concretely

### 3.0 The name is already taken, and it means something else

**`integration/test/shared/` exists today: 18 files, and every one of them is a `.test.ts`
that tests `src/shared/`** — `best-effort.test.ts`, `debug/debug-system.test.ts`,
`exposure*.test.ts` (×7), `llm-*.test.ts` (×4), `source-scan.test.ts`,
`dedup-compression/lower-layer.test.ts`, `dev-mode-env.test.ts`, `shared-functions.test.ts`.
Measured: **0 import consumers** — nothing imports them, because they are leaves.
`integration/test/` mirrors `integration/src/` folder-for-folder, so `test/shared/` means
"tests **of** shared", while the user's proposal means "helpers **shared by** tests".

**This is a name collision that would silently merge two populations.** Recommendation: the
mirror is the stronger convention (it is mechanical and it is used by 38 directories), so keep
`test/<mirror-of-src>/` and give the helpers a name that cannot be confused with a mirror —
`tests/kit/`, or keep `tests/helpers/` and `test/support/` and merge them under one of the two
names. Whatever is chosen, **`tests/shared/` cannot mean both things**, and today it already
means the other one.

### 3.1 What test helpers exist, who uses them, and what they are

Consumers were classified by what the *consuming test file* imports from production code
(FE = `web/src`, WS = `web/server`, CT = `web/contracts`, EN = `integration/src`).

**`web/tests/helpers/` — 14 files, 329 inbound edges, 228 distinct consumers.**

| file | consumers | FE | WS | CT | EN | verdict |
|---|---:|---:|---:|---:|---:|---|
| `source-scan.ts` (1,060L) | **150** | 46 | 54 | 18 | 6 | **cross-cutting — the flagship** |
| `temp-dir.ts` (332L) | 85 | 6 | 82 | 3 | 4 | cross-cutting (fs, side-agnostic) |
| `multi-user.ts` | 28 | 1 | 28 | 4 | 1 | **backend-specific** |
| `function-scope.ts` | 17 | 4 | 7 | 1 | 2 | cross-cutting |
| `http-server.ts` | 13 | 0 | 13 | 4 | 0 | **backend-specific** |
| `json-request.ts` | 11 | 0 | 11 | 3 | 0 | **backend-specific** |
| `history-page.ts` | 10 | **9** | 0 | 1 | 0 | **frontend-specific** |
| `mock-http.ts` | 5 | 0 | 5 | 3 | 1 | **backend-specific** |
| `error-scan.ts` | 4 | 0 | 1 | 0 | 0 | cross-cutting (source scanning) |
| `data-loss-helpers.ts` | 4 | 0 | 4 | 0 | 0 | **backend-specific** (imports `node:sqlite`) |
| `budget-paths.ts` | 2 | 0 | 1 | 0 | 0 | tooling/reporter |
| `global-boundary.ts` | 2 | 1 | 2 | 0 | 0 | cross-cutting |
| `budget-verdict.ts` (150L) | **0** | — | — | — | — | referenced by path from 2 budget tests |
| `client-writes.ts` (142L) | **0** | — | — | — | — | referenced by path from 2 cockpit tests |

**`integration/test/support/` — 36 files, 213 inbound edges, 155 distinct consumers. All EN.**

| file | consumers | verdict |
|---|---:|---|
| `temp-dir.ts` | **115** | cross-cutting |
| `mock-provider.ts` | 19 | domain: agents(9) / evaluation(5) / runtime(4) / timeline(1) |
| `s1-scenario-shared.ts` (427L) | 18 | **domain-specific**: 16 of 18 are `test/s1-scenarios/` |
| `factories.ts` | 11 | performance(6) / quality-packs(3) / runtime(2) |
| `matrix.ts` | 10 | **domain-specific**: 10 of 10 are `test/evaluation/` |
| `test-env-helpers.ts` | 7 | cross-cutting |
| `legacy-store.ts` (611L) | 6 | **legacy**: 4 named legacy test files |
| `repository-local-temporary.ts` | 6 | cross-cutting (fs) |
| `legacy-state-boundary.ts` | 5 | legacy |
| `timeline.ts` | 5 | **misnamed**: 5 of 5 consumers are `test/evaluation/`, none are timeline |
| `source-scan.ts` (381L) | **4** | duplicate — see §3.2 |
| `legacy-core.ts`, `legacy-errors.ts` | 3, 3 | legacy |
| `test-inventory-fixture.ts` | 3 | cross-cutting |
| 12 further files | 0 imports | 11 are worker/probe/fixture files loaded **by path** (verified by byte scan for the basename); **1 is genuinely dead** |

**`test/support/planned-node-test-runtime-environments.ts` (103 lines, mtime 2026-07-25
02:39:14) is dead.** Byte scan over all 2,303 files: **0 files mention its basename stem, and
0 files reference any of its three exports** (`PlannedNodeTestHostileEnvironmentScenario`,
`PlannedNodeTestHostileEnvironmentMatrix`, `createPlannedNodeTestHostileEnvironmentMatrix`).
Its sibling `planned-node-test-evidence.ts` (929L) and
`planned-node-test-source-authority.ts` have 1 consumer each, so this is not a family that was
loaded dynamically — it is one orphan.

### 3.2 The `source-scan.ts` duplication — verified function-for-function

The brief's claim is correct and is now nailed down.

| | `integration/test/support/source-scan.ts` | `web/tests/helpers/source-scan.ts` |
|---|---|---|
| size | 381 lines / 15,393 bytes | 1,060 lines / 44,922 bytes |
| exports | 7 | 29 |
| consumers | 4 | **150** |
| mtime | 2026-07-27 18:40:46 | 2026-07-28 11:47:48 |

Overlap is **4 exports**: `parseExports`, `parseExportsFromFile`, `valueReferencesModule`,
`referencesModule`. Comparing the brace-balanced bodies after stripping comments and collapsing
whitespace:

| function | integration | web | identical? |
|---|---|---|---|
| `parseExports` | `test/support/source-scan.ts:74-92` (708 chars) | `tests/helpers/source-scan.ts:892-910` (708 chars) | **yes, byte-identical** |
| `valueReferencesModule` | `:279-285` (302 chars) | `:473-479` (302 chars) | **yes, byte-identical** |
| `referencesModule` | `:319-322` (177 chars) | `:567-570` (177 chars) | **yes, byte-identical** |
| `parseExportsFromFile` | `:115-117` | `:929-931` | no — differs **only** in file access: `readFileSync(absPath,"utf8")` vs `read(rel)` |

So three of four are literal copies and the fourth differs by one expression. The web copy
additionally owns the walker and the whole scanning apparatus the integration copy lacks:
`SOURCE_EXTS, read, relpath, walk, walkTs, sourceFiles, stripCommentsAndStrings,
stripCommentsAndStringsDrop, stripCommentsOnly, stripCommentsRegex, blankStringLiterals,
stripCssBlockComments, stripCommentsKeepStrings, reExportedValuesFrom, runtimeModuleSpecifiers,
ReachableSources, sourceFilesReachableFrom, reachableFilesImporting, builtinSpellings, cssBlock,
parseCssClassNames, isTokenName, TokenSites, buildTokenIndex, referencedElsewhere` — 25
web-only exports. The integration copy has 3 the web lacks (`parseConstExports`,
`parseConstExportsFromFile`, `parseImportSpecifiers`). **Confirmed §2 violation, and the
integration side is the strictly weaker copy.**

*(Consumer-count note: the brief says ~105. I measure **150** via the resolved import graph, and
an independent byte scan for the specifier string finds 152 files. The three extras are
`tests/cockpit/artifact-containment.test.ts`, `tests/prevention/no-unused-exports-index.test.ts`
and `tests/prevention/subprocess-confinement-owner.test.ts`, which name the path as **data**
rather than importing it. 150 is the import count; 149 are test files and 1 is
`tests/helpers/error-scan.ts`.)*

### 3.3 Five more scanning owners, and three more duplications

**The source-parsing cluster has 8 owners and 250 edges.** Beyond the two above:
- `integration/src/quality/checks/shared.ts` (26 consumers) exports `stripCommentsOnly` and
  `stripCommentsAndStrings` — **the same two names** as the web helper. Bodies differ
  (jaccard 0.60 and 0.567 on normalised tokens), so these are §2 "similar", not identical:
  `src/quality/checks/shared.ts:16-35` vs `tests/helpers/source-scan.ts:270-303`, and
  `:53-79` vs `:178-220`. Two comment-stripping semantics is exactly the hazard §8b names
  ("beware the stripped view") — with two implementations, a scan can be run against the
  wrong one and pass vacuously.
- `integration/src/shared/source-structure.ts` (2,256 lines, 6 consumers, all tests).
- `integration/src/shared/source-scan.ts` (214 lines, 32 consumers).
- `integration/src/quality-packs/prevention/ast-helpers.ts` (11 consumers).

**`createTempDir` exists twice**: `integration/test/support/temp-dir.ts:69-73` (139 chars) and
`web/tests/helpers/temp-dir.ts:197-238` (1,839 chars). Not copies — the web one is thirteen
times larger and has grown leak-tracking the integration one lacks. Two implementations of the
same name for the same job, with 115 and 85 consumers respectively.

**`sha256` exists four times in live code** (plus 2 in archived benchmark trees):
`integration/src/integrity.ts:23-25`, `integration/src/shared/dedup-compression/shared-helpers.ts:12-14`,
`web/server/digest.ts:22-24`, `integration/src/smart-edit/edit-engine.mjs:28-30`. Pairwise
token jaccard 0.33–0.69 — four hand-written wrappers over `node:crypto`.

**`RateLimitError`, `AuthError`, `BadRequestError`** are each declared in both
`integration/src/shared/llm/errors.ts` (14 classes) and `web/server/errors.ts` (18 classes).
`NotFoundError` in both `web/server/errors.ts` and `integration/test/support/legacy-errors.ts`.

### 3.4 What belongs in a real shared test kit

**Tier 1 — genuinely cross-cutting, cross-repo, one owner (5 modules, ~260 consumers):**
`source-scan.ts` (150 + 4), `temp-dir.ts` (85 + 115), `function-scope.ts` (17),
`error-scan.ts` (4), `global-boundary.ts` (2). All five are pure or `node:fs`-only, none
touches a browser API, and all five are wanted by both repos' suites today.

**Tier 2 — backend test kit** (`multi-user.ts` 28, `http-server.ts` 13, `json-request.ts` 11,
`mock-http.ts` 5, `data-loss-helpers.ts` 4): 61 consumers, **zero to one frontend consumer
each**. These are HTTP and SQLite doubles. They should sit under the backend's own tests, not
in a shared kit.

**Tier 3 — frontend test kit** (`history-page.ts`, 9 of 10 consumers frontend). One file today;
it does not earn a directory yet (see §5).

**Tier 4 — domain-owned, should move next to their domain's tests:** `matrix.ts` → `test/evaluation/`
(10 of 10), `s1-scenario-shared.ts` → `test/s1-scenarios/` (16 of 18), `test/support/timeline.ts`
→ `test/evaluation/` (5 of 5, and rename — its current name is a lie about its consumers).

**Tier 5 — legacy, should be quarantined together and named as such:** `legacy-core.ts`,
`legacy-errors.ts`, `legacy-state-boundary.ts`, `legacy-store.ts`, `legacy-store-worker.ts`,
`legacy-text-validation.ts` — 6 files, 19 consumers, all four of which are named legacy tests.

**Tier 6 — delete:** `planned-node-test-runtime-environments.ts` (0 references anywhere).

---

## 4. The one-door rule, applied

### 4.1 The current door count, measured

| subtree | files | distinct entry files reached from outside | edges through `index.ts` | edges bypassing it | `index.ts` present? |
|---|---:|---:|---:|---:|---|
| `integration/src/shared/` | 88 | **41** | 0 | 280 | **no** |
| `web/src/lib/shared/` | 30 | **28** | 0 | 224 | **no** |
| `integration/test/support/` | 36 | **18** | 0 | 213 | **no** |
| `web/tests/helpers/` | 14 | **12** | 0 | 329 | **no** |
| `integration/src/shared/exposure/` | 24 | 10 | 6 | 18 | yes |
| `integration/src/shared/llm/` | 10 | 3 | **8** | 4 | yes |
| `integration/src/shared/memory/` | 23 | 6 | 1 | 6 | yes |
| `integration/src/shared/dedup-compression/` | 10 | 6 | 2 | 14 | yes |

`src/shared/` is 41 doors for 88 files. And where a barrel *does* exist, it is bypassed: across
the four barrelled subtrees, **17 edges go through `index.ts` and 42 go around it (71%
bypass)**. Only `llm/` is majority-barrel.

**So "add an `index.ts`" is not the answer — it is the thing that has already been tried four
times and lost three of them.** A barrel with no mechanism is rung 6.

### 4.2 The cross-repo door has already failed, with a number

`web/tsconfig.json` declares 8 `@harness/*` path aliases into the integration repo. Measured
usage of that door:

- **imports via `@harness/*`: 1** — `@harness/tool-manifest`, from `web/contracts/types.ts`.
- **imports via a relative `../../harness-main-v1/integration/...` path: 89**, in **71 distinct
  specifier spellings**, at 1–4 `../` hops.
- **`@harness/tool-manifest` is used through both doors** — once by alias, once relatively.
- `@harness/config` is declared and used **0 times** by alias, **8 times** relatively.
- `@harness/interactive-session` and `@harness/forensic-contracts` are used **0 times by either**.

**The declared door carries 1.1% of the traffic it was built for.** Any door proposal that
consists of declaring a door will reproduce this.

### 4.3 The one mechanism in this tree that actually works — use it as the template

`web/contracts/errors.ts` owns `KNOWN_ERROR_CODES` / `CODE_STATUS_MAP`.
`web/src/lib/shared/error-messages.ts` holds `MESSAGE_FOR_CODE`, a *projection* of it.
`web/tests/prevention/error-message-projection-owner.test.ts` (181 lines) enforces four things:

- **A.** the projection really imports the owner (a broken import fails, not passes);
- **A′.** an explicit non-vacuity assertion — `KNOWN_ERROR_CODES.length > 20` and
  `Object.keys(MESSAGE_FOR_CODE).length > 10` — so a broken import cannot make the guard green;
- **B.** an unnamed code still yields a derived human sentence, so the table never has to grow;
- **C.** **no second table can exist, by dynamic discovery** — it walks `src/` and `server/`
  over the comment-stripped view and fails if any file other than the two owners uses ≥4
  distinct taxonomy codes as object keys. No allowlist of filenames.

It is mutation-verified in its own header (add an undeclared key → A fails; remove the import →
A fails; delete the derived branch → B fails; paste a second table elsewhere → C fails).

**That is the door mechanism to generalise: one owner + a discovery scan whose failure mode is
"a second one appeared", with an explicit non-vacuity floor.** Its one weakness is its universe:
`for (const root of ["src", "server"])` — it does not scan `contracts/`, `tests/`, or the
integration repo. Any generalisation must state its covered population as a runtime number and
assert a floor on it (§8).

### 4.4 The door proposal, per cluster

| cluster | proposed single door | what mechanically prevents a second door | rung |
|---|---|---|---|
| cross-repo engine surface | `package.json` `"exports"` on the integration package, listing exactly the modules the web side may import | the **module resolver** refuses an unlisted deep path — the import does not resolve, in node and in every bundler. No scan, no list to maintain beyond the surface itself | **1** |
| types / wire contracts | `shared/contracts/` (today `web/contracts/`), consumed by name | `"exports"` + `verbatimModuleSyntax` (already on in both tsconfigs) makes a value import of a type-only module a compile error | 1–2 |
| errors + error vocabulary | one taxonomy owner, N projections | the existing projection-owner guard, generalised; scan universe stated as a number and floored | 4–5 |
| numeric + statistics | one module per *question*, not per file: one `percentile` with one unit convention | make the convention **unrepresentable**: `percentile(xs, Fraction)` where `Fraction` is a branded type. `percentile(xs, 50)` then does not compile | **2** |
| source parsing / AST scanning | one owner, and the **view** made explicit at the call site (`{ view: "code" \| "raw" }`, no default) | a required discriminated parameter — forgetting it is a compile error, which is exactly §8b's "stripped view" hazard closed at rung 3 | **3** |
| implementation families (language, transport, storage, provider) | `readdirSync` over the family folder at load, refusing unknown/duplicate ids | a new file is registered because **nobody had to remember**; a folder with an unregistrable file fails at startup | **4** |
| exposure registrations | replace the 12-entry `MODULE_REGISTRATIONS` array with directory discovery | this is the direct fix for **F2** — `shared.ts` would have been picked up the moment it existed | **4** |
| UI presentation components | the component library's own folder, consumed by component name | Svelte component resolution + the existing `component-registry.ts` (15 consumers) | 4 |
| test kit | one kit module per tier, imported by kit name | `"exports"`-style subpath map on the test tsconfig, plus the anti-duplication guard below | 1–5 |

**The one guard worth writing, generalised from §4.3, because it is the one that catches the
class rather than an instance:** *no exported value name may be declared by two modules in
different sides.* Measured today it would fire on **25 cross-repo collisions**
(`sha256`×4, `parseExports`, `parseExportsFromFile`, `valueReferencesModule`, `referencesModule`,
`createTempDir`, `stripCommentsOnly`, `stripCommentsAndStrings`, `percentile`, `RateLimitError`,
`AuthError`, `BadRequestError`, `NotFoundError`, `isRecord`, `MEMORY_TIERS`, `moduleOf`,
`makeRng`, `CONTENT_TYPE_JSON`, `parseUnifiedDiff`, `retrieveRelevantFiles`,
`createConsoleSink`, `DEFAULT_TYPECHECK_TIMEOUT_MS`, `computeCoverage`, `MIGRATIONS`) and on
**167 within-repo collisions**. That population is the migration backlog, and it is derived from
bytes rather than from anybody's judgement.

---

## 5. Depth and naming

### 5.1 The measured distribution

236 real leaf directories hold 2,303 files.

- files per directory: min 1, **p25 = 2, median = 5, p75 = 11, p90 = 19**, max 211, mean 9.8
- **52 directories (22%) hold exactly 1 file** — and together those 52 directories hold **2% of
  all files**
- 81 directories (34%) hold ≤2 files and hold 5% of files
- 125 directories (53%) hold ≤5 files and hold 12% of files
- path depth below repo root: 211 files at depth 1, 1,314 at depth 2, 617 at depth 3, 129 at
  depth 4, 24 at depth 5. **92% of files sit at depth ≤3.**

### 5.2 The rule, derived from that distribution

> **A directory earns its existence when it will hold ≥3 files *and* at least one of:
> (a) ≥5 distinct consumers from outside it, or (b) it is an implementation family whose
> membership is auto-discovered (in which case 2 files is enough, because the third is coming
> and the discovery mechanism is the point).**
>
> **A directory loses its existence when its cohesion exceeds 0.6 while its outside-consumer
> count is below 10** — that is a subsystem wearing a utility's name, and it should be moved
> out to its domain. *(This rule, applied today, evicts `src/shared/memory/` — cohesion 0.91,
> 5 outside consumers — and `src/shared/dedup-compression/` — 0.59, 5 consumers.)*
>
> **Depth stops at 4 below the repo root**, i.e. `<side>/<domain>/<family>/<file>`. 92% of the
> tree is already at ≤3 and the deepest legitimate case in the good template is
> `src/quality/languages/python/parser.ts`, which is exactly 4. Anything deeper is a signal
> that a second axis has been introduced as a directory; it belongs in a field or a filename.

The 22%-of-directories-holding-2%-of-files number is the empirical case for the floor: those
52 directories cost 52 extra path segments in every import specifier that crosses them and buy
one file's worth of grouping each.

### 5.3 Names forbidden outright

`utils/`, `util/`, `common/`, `misc/`, `helpers/` (as a catch-all), `lib/` (as a catch-all),
`shared/` **as a leaf that holds unrelated files**, `core/`, `base/`, `stuff/`, `extras/`,
`support/` (as a catch-all).

Rationale, measured rather than asserted: the four directories in this tree whose names are on
that list are exactly the four with 12–41 doors and cohesion ≤0.38. `web/src/lib/` (150 files,
13 subdirectories) is the largest single directory in either repo and is named `lib`.
By contrast `mcp/transport/` and `memory/storage/` — named after **what they contain** rather
than after their relationship to the reader — have 3 and 6 doors respectively.

**The positive rule:** a directory is named for the *question its contents answer*
(`transport/`, `storage/`, `languages/`, `contracts/`, `registrations/`), never for the
*relationship its contents have to somebody else* (`shared/`, `common/`, `helpers/`). "Shared"
is a property of a module's consumers, and consumers change; the question a module answers does
not.

**Corollary the measurements force: `shared/` should not survive as a directory name at all.**
The user's proposed root `shared/` is, measurably, `contracts/` (9 of 10 cross-side modules
already live there). The per-side `shared/` folders are, measurably, a component library
(`web/src/lib/shared/`: 63% Svelte) and a set of subsystems plus ~15 utilities
(`integration/src/shared/`: 83% subsystem). Naming three different things `shared/` is what
produced the junk drawer, and re-creating the name at two levels will reproduce it. If the
name is kept for familiarity, the ≥3-files / ≥5-consumers / cohesion rules above must be
enforced *inside* it, or it will refill.

---

## 6. What should **not** be shared — both directions

### 6.1 In a shared place, owned by one consumer

| module | location | evidence |
|---|---|---|
| `memory/` (23 files) | `integration/src/shared/` | cohesion **0.91**; **5** consumers outside the subtree; 10 of its 23 files have their only consumers inside it. It is `src/memory/`'s sibling, not a shared utility |
| `dedup-compression/` (10 files) | `integration/src/shared/` | cohesion 0.59, **5** outside consumers |
| `workflow/` (4 `.mjs` files) | `integration/src/shared/` | **0 import consumers**; reached only by path from `scripts/merge-round.mjs`. These are build-script config, not shared library code — and one of them is **F1** |
| `matrix.ts` | `integration/test/support/` | **10 of 10** consumers are `test/evaluation/` |
| `s1-scenario-shared.ts` (427L) | `integration/test/support/` | **16 of 18** consumers are `test/s1-scenarios/` |
| `timeline.ts` | `integration/test/support/` | **5 of 5** consumers are `test/evaluation/`; the name names the wrong domain |
| `legacy-*.ts` (6 files) | `integration/test/support/` | 19 consumers, all in 4 named legacy test files |
| `multi-user.ts`, `http-server.ts`, `json-request.ts`, `mock-http.ts`, `data-loss-helpers.ts` | `web/tests/helpers/` | 61 consumers, **0–1 frontend each**; `data-loss-helpers.ts` imports `node:sqlite` |
| `history-page.ts` | `web/tests/helpers/` | 9 of 10 consumers frontend |
| `ErrorBoundary.svelte`, `arc-geometry.ts`, `markdown-parser.ts`, `scroll-restore.ts`, `charts/BarChart.svelte`, `charts/Sparkline.svelte` | `web/src/lib/shared/` | **1 consumer each, 1 area each** — 6 of 30 files. `markdown-parser.ts` (425L) has one consumer, `SafeMarkdown.svelte`, in the same folder |
| `planned-node-test-runtime-environments.ts` | `integration/test/support/` | **0 references of any kind** — delete |
| `registrations/shared.ts` | `integration/src/shared/exposure/` | **F2** — not in the index; correct and unplugged |

*(`web/src/lib/shared/` is otherwise healthy: 24 of 30 files are used from ≥2 areas, `Button.svelte`
from 15. Its problem is composition, not sharing — it mixes 19 components, 6 pure helpers,
2 DOM-behaviour modules and 1 token file in one flat folder.)*

### 6.2 Duplicated across sides, should be shared and is not

| capability | owners today | evidence |
|---|---|---|
| export/reference parsing | `integration/test/support/source-scan.ts` (4 consumers) vs `web/tests/helpers/source-scan.ts` (150) | **3 of 4 shared functions byte-identical**, 4th differs by one expression — §3.2 |
| comment/string stripping | `integration/src/quality/checks/shared.ts` (26) vs `web/tests/helpers/source-scan.ts` (150) | same two export names `stripCommentsOnly` / `stripCommentsAndStrings`, different bodies (jaccard 0.60 / 0.567). Two stripping semantics is the §8b "stripped view" hazard doubled |
| temp directories | `integration/test/support/temp-dir.ts:69` (115) vs `web/tests/helpers/temp-dir.ts:197` (85) | same name, 139 vs 1,839 chars — the web one has leak-tracking the integration one lacks |
| SHA-256 | `integration/src/integrity.ts:23`, `integration/src/shared/dedup-compression/shared-helpers.ts:12`, `web/server/digest.ts:22`, `integration/src/smart-edit/edit-engine.mjs:28` | 4 live wrappers over `node:crypto`, pairwise jaccard 0.33–0.69 |
| percentile / median | `integration/src/shared/numeric-helpers.ts:36`, `integration/src/shared/stats.ts:44,63`, `web/bench/lib/stats.ts:61`, `web/src/lib/shared/array-stats.ts` | **F3** — 3 contracts, 2 unit conventions, 2 empty-input answers |
| provider error classes | `integration/src/shared/llm/errors.ts` (14 classes) vs `web/server/errors.ts` (18) | `RateLimitError`, `AuthError`, `BadRequestError` declared in both |
| lock timeout default | `integration/src/shared/workflow/workflow-config.mjs:18` vs `integration/src/workflow/workflow-config.ts:48` | **F1** — 60,000 vs 120,000 |
| tree-sitter loading/walking | `integration/src/quality/languages/shared/tree-sitter-{loader,walker}.ts` (6 each) vs `integration/src/awareness/languages/tree-sitter-base.ts` (3) | two agnostic halves of the same language axis, in two module trees |
| language-agnostic quality helpers | `integration/src/quality/languages/shared/` (folder, 12 consumers) vs `integration/src/quality/languages/shared-helpers.ts` (file, 3 consumers) | **two doors to the same layer, at depth 1, inside the good template** |

---

## 7. Trade-offs, and where my own proposals would be worse

**7.1 The root rename is the weakest recommendation in this document.** `src/`→`frontend/`,
`server/`→`backend/`, `contracts/`→`shared/` costs 1,122 import specifiers across 732 files, and
buys naming clarity for a repo whose maintainers already know that `server/` is the backend.
The measured evidence says the *taxonomy inside* the folders is where the disorder is (41 doors,
25 cross-repo name collisions, 3 percentile contracts), and none of that is fixed by the rename.
**If only one thing is done, it should not be the rename.**

**7.2 A root `shared/` covering the whole codebase is nearly empty, and pretending otherwise
would be worse than today.** Measured: **9 modules** are consumed by more than one production
side and are not tests, and all 9 already live in `web/contracts/`. Creating a root `shared/`
and then feeling obliged to fill it is how junk drawers start. **The honest form of the user's
root `shared/` is: rename `contracts/` to it, move `web/src/lib/when-eval.ts` into it, and let
it stay small.** A root `shared/` with 9 files is a correct answer, not an embarrassing one.

**7.3 Per-side `docs/` risks re-creating the problem it solves.** `harness-main-v1/docs/` and
`harness-main-v1/integration/docs/` **both contain `ten-x-harder-definition.md`, byte-identical
at 3,402 bytes** — two copies of one document, which is §1 in the documentation tree. Adding `frontend/docs/` and
`backend/docs/` multiplies the number of plausible homes for a document by the number of sides,
and documents do not have a single owning side as reliably as code does. **Recommendation: one
`docs/` at each repo root, organised by topic, with the per-side README staying next to the
code it describes.** I would not create `frontend/docs/` and `backend/docs/`.

**7.4 The barrel proposal is worse than the status quo unless a mechanism comes with it.**
Measured: barrels exist in 4 subtrees and are bypassed on 42 of 59 edges. Adding an `index.ts`
to `src/shared/` today would produce a 42nd door, not consolidate 41.

**7.5 There is an existing, blocked, and stale migration plan, and it must not be forked.**
`integration/the private migration record` (1,295 lines, status
`non-authoritative-plan/pending-independent-re-review`) and
`physical-migration-map.md` (130 lines, `planned-open-blocking`) already define a target layout:
`src/kernel/{architecture,config,errors,integrity,policy,requirements}/`,
`src/modules/<context>/{domain,application,ports,index.ts}`, `src/adapters/<tech>/`,
`src/interfaces/<transport>/`, `src/composition/`, `verification/{core,rules,oracles,slices}/`,
`test/{unit,contract,integration,recovery,mutation,system}/<context>/`. Two of its rules are the
same conclusions this analysis reached independently — *"preserve public APIs through context
`index.ts` files; reject deep cross-context imports"* and *"line count alone is never a
boundary"*. **Notably, that plan has no `shared/` directory at all: the agnostic layer is
`src/kernel/`, and "shared" stays a manifest field.** Partial execution is already visible
(`src/modules/{effect-boundary,tasks-agents}/` with `domain/`+`application/`+`index.ts`;
`verification/{core,oracles,slices,benchmarks}/`).

**But the plan is measurably stale:** it records *"38 registered TypeScript modules"* and
*"11 shared, 16 runtime, 11 builder"*. The manifest today holds **721 modules — 174 shared, 365
runtime, 181 builder, 1 safety** — an 18-fold change. It is bound by SHA to an
`architecture-v1.md` of 1,851 lines; that file is now **7,549 lines**. Its finding
`ARCH-001-flat-physical-layout` is still open and `physicalLayoutStatus` in the live manifest
still reads `"open-blocking-architecture-v1-migration-required"`.
**Any layout decision taken now must either supersede that plan through its own governance or
be recorded as an input to its re-derivation — writing a third layout document beside two
existing ones is the two-paths defect in the artifacts that describe the fix.**

---

## 8. COVERAGE

**What I measured (byte-based, in process, no `grep`):**
- 2,303 source files; 7,146 resolved static+dynamic import edges; 1,162 imported modules.
  Resolution handles `.js`→`.ts` rewriting, `/index.*`, `$lib/`, and cross-repo relative paths.
- Consumer counts, distinct-consumer counts, consumer-side and consumer-domain spreads for every
  file in all 6 shared-shaped directories, plus every module with ≥2 consumers.
- Internal-vs-inbound edge cohesion for every directory with ≥2 files in either repo (236 leaf
  directories); files-per-directory and path-depth distributions.
- `architecture-manifest.ts` parsed with balanced-brace extraction over each `moduleContract({…})`:
  721 modules with `realm`, `layer`, `owner`, `executionBoundary`, `dependencies`, `effects`,
  `authorityFamilies`. Joined against the measured import graph. **Re-parsed after a concurrent
  write at 13:21:32 — 0 field differences.**
- Exported-name collisions across all 2,303 files (8,128 distinct exported names; 279 names from
  ≥2 files; 192 value-export collisions; 25 cross-repo).
- Brace-balanced function-body extraction and normalised comparison for the 9 duplication claims
  in §3.2 / §6.2. Each body was extracted by matching the parameter list's parentheses to depth 0
  *before* looking for the body brace — the default-parameter / return-type trap §21 names — and
  the extracted spans were printed and checked against the file before any comparison.
- `@harness/*` alias usage vs relative cross-repo imports (1 vs 89, 71 spellings).
- Layer classification by import specifier + comment-and-string-stripped identifier view.

**What I read in full or in substantial part:** `TIER1-AGENT-CONTRACT.md`;
`integration/src/architecture-manifest.ts` (types, `moduleContract`, `LAYERS`, sample entries);
`the private migration record` (opening ~7 kB) and `physical-migration-map.md`
(all 130 lines); `web/tests/prevention/error-message-projection-owner.test.ts`;
`web/tests/prevention/no-unused-exports-index.test.ts` (header);
`integration/src/quality/checks/barrel-detection.ts`;
`integration/src/shared/exposure/registrations/index.ts` and `shared.ts`;
`integration/src/shared/workflow/workflow-config.mjs`; the percentile bodies in
`numeric-helpers.ts`, `stats.ts`, `bench/lib/stats.ts`; export lists for all 88 + 30 shared files;
both `tsconfig.json` files.

**What I did NOT establish — stated plainly:**
1. **I did not run either test suite.** Read-only brief. Every claim here is static; none of it
   is behavioural. In particular F1's 60 s/120 s drift is proven from source, not observed at
   runtime.
2. **Dynamic and path-based references are only partly covered.** I resolved `import()` and
   `require()` string literals, and I byte-scanned basenames for the 20 zero-consumer files.
   A module loaded through a **computed** specifier, a worker spawned with a constructed path,
   or a `vite`/`vitest` glob would not appear. My "dead" verdict is asserted for exactly **one**
   file (`planned-node-test-runtime-environments.ts`, 0 mentions of basename or of any of its 3
   exports) and withheld for the other 19.
3. **349 relative specifiers did not resolve** in the loose first pass. I diagnosed them: the
   large majority are **fixture strings inside test source** (`./a.ts`, `./foo`, `./x`,
   `./bar.ts`) and imports into `_experiments/` (deliberately excluded). The strict extractor
   used for all reported counts is line-anchored, which removes the fixture-string class. I did
   not enumerate all 219 distinct unresolved specifiers individually.
4. **I did not verify the manifest's `realm` assignments against the intent of their authors** —
   only against measured consumption. A module declared `shared` and consumed by one realm may
   be correctly anticipating a second consumer.
5. **I did not measure the runtime or bundle-size cost of any proposal.** The `"exports"`-map
   recommendation (§4.4) is argued from resolver semantics, not from a build measurement, and
   `web/tsconfig.json` excludes `server/` (which uses `tsconfig.server.json`) — so the alias
   mechanism may never have been *available* to the server files, which would explain part of
   the 1-of-90 result without excusing it. **I did not read `tsconfig.server.json`.**
6. **`web/tests/e2e/` and Playwright helpers are outside my universe** (excluded by the web
   tsconfig and not walked). If e2e helpers exist there, the `tests/` taxonomy in §3 is
   incomplete by that amount.
7. **The `experiments/` trees (483 directories at `harness-main-v1/experiments/`) were excluded
   entirely.** If shared code is being re-derived there, this analysis does not see it.
8. **Two of the twenty clusters in §1.4 are thin** — "time / duration" (1 module, 1 edge) and
   "browser / DOM behaviour" (2 modules, 5 edges). They are reported because the evidence
   produced them, not because they justify a directory; under my own §5 rule neither earns one.

---

## 9. Workflow improvement (owed by every agent, §20)

**The consumer-count claim in my own brief was low by 43%** — "~105 consumers" for
`web/tests/helpers/source-scan.ts` against a measured 150 imports (152 files mentioning the
path). The likely cause is a count taken with `grep` or taken over one directory. This is the
§8b hazard operating on a *brief* rather than on a report, and a brief's numbers are trusted
harder because they arrive as premises.

**Concrete proposal:** the repo already contains the right instrument —
`web/tests/helpers/source-scan.ts` exports `walk`, `read`, `reachableFilesImporting` and
`buildTokenIndex`, and a byte-based resolved-import graph over both repos takes about two
seconds to build. **Make it a committed script** (`scripts/import-graph.mjs`) emitting
`{module → distinct importers, doors, cohesion, exported-name collisions}` as JSON, and require
every brief and every report that states a consumer count, a duplication claim or a
"shared/unshared" verdict to cite that script's output rather than a hand count. Three of this
document's findings (F1, F2, F3) came out of that graph in the first ten minutes; none would
have been found by reading directories. The corollary rule is the cheap one:
**a count that appears in a brief carries the same evidence burden as a count that appears in a
report** — today it silently carries less.
