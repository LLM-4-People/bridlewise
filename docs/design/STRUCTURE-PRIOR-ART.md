---
layout: default
title: 'STRUCTURE-PRIOR-ART — the outside view on `frontend/ backend/ docs/ tests/ shared/`'
---

# STRUCTURE-PRIOR-ART — the outside view on `frontend/ backend/ docs/ tests/ shared/`

Read-only research. Nothing in the tree was modified. Produced 2026-07-28.
Governing document: `TIER1-AGENT-CONTRACT.md` — every claim below carries its source, its date,
and its version. Where a question could not be settled, that is said in plain words rather than
filled in with plausible convention. **Every third-party claim relayed from a delegated search
was independently re-verified against the GitHub API before being written here**; the two that
did not survive verification are recorded in §10.

---

## LADDER VERDICT

**The question answered first:** *what would make cross-boundary imports and path-literal drift
IMPOSSIBLE rather than fixed?*

> **Rung reached: 2 is available, and nobody in the surveyed population uses it.**
>
> **Rung 1 (physically impossible)** — *available for the import boundary; unavailable for path
> config.* Node's `exports` field is enforced by the module resolver: an import of an unlisted
> subpath throws `ERR_PACKAGE_PATH_NOT_EXPORTED` before user code runs. **Measured today, Node
> v24.18.0, with mutation** (§4.1). It is unavailable for `tsconfig.include` / ignore files /
> test globs because those are read by many independent tools and no single authority evaluates
> them — a fact the outside world has been unable to change for eight years (§5.4).
>
> **Rung 2 (unrepresentable)** — *available, and this is the central finding.* With
> `composite: true` + `rootDir`, a `frontend/` file importing a `backend/` file is **not a lint
> warning, it is a compile error**: TS6059 and TS6307. `references` is the explicit grant;
> absent it, the import is refused. **Measured and mutation-verified today, TypeScript 7.0.2**
> (§4.2). Deny-by-default, at the compiler, with no new tooling.
>
> **Rung 3 (unreachable by shape)** — available via one `package.json` `exports` per side.
>
> **Rung 4 (runtime choke point)** — not applicable; module resolution *is* the choke point, and
> rungs 1–3 already sit on it.
>
> **Rung 5 (source-scan guard)** — where every surveyed project actually lives. Outline uses a
> lint rule; 19 of 20 large repos use nothing beyond package manifests.

**The single most useful sentence in this report:** the boundary you want can be a *compile
error* rather than a *convention*, and the price is `composite`/`rootDir`/`references` — not a
plugin, not a scanner, not a registry.

---

## 0. METHOD, INSTRUMENTS, AND THEIR BLIND SPOTS

Because an analyst's mistake becomes a decision and decisions are not re-run:

| Instrument | Establishes | Blind spot |
|---|---|---|
| `gh api …/git/trees/<br>?recursive=1` on 21 repos, `truncated:false` verified each | complete file lists | a file list is not a dependency graph |
| shallow clone of `outline/outline` @ `5ff3020` (2026-07-28T08:58-04:00) | actual import text | one repo |
| bespoke import graph + Tarjan SCC on that clone | layer edges, cycles | regex extraction — quantified below |
| Node v24.18.0, driven + mutated | `exports` encapsulation | — |
| TypeScript 7.0.2, driven + 3 mutations | `extends` semantics, project references, emit | TS 7 is newer than most repos run |
| Vitest 4.1.10 **and** 3.2.4 installed side by side, identical fixture | discovery + coverage population | — |
| GitHub API re-verification of 24 third-party issues/PRs | dates, states, quotes, diff sizes | — |

**Blind spots of the import-graph instrument, quantified rather than asserted:**

- 10,783 first-party static specifiers resolved; **1 unresolved (0.01 %)**.
- 102 dynamic `import()` calls with first-party specifiers were missed by static extraction.
  Their layer pairs are `app → app` (57) and `server → server` (5) — **zero cross-layer**, so
  including them cannot change the cross-layer cycle result.
- 0 first-party `require()` calls.

**A claim I made and then killed.** My first SCC run reported a **194-module cycle spanning
`app` (130) and `shared` (64)** — a spectacular confirmation of the folk wisdom. Re-run with
type-only imports excluded, **that cycle does not exist.** It was held together entirely by three
`import type` edges, erased at compile time. Publishing the first number would have made this
report argue the opposite of the truth. Every cycle claim below is on the runtime graph, and §7.6
turns the near-miss into a design rule.

---

## 1. PRIOR ART — repositories inspected, not blogged about

### 1.1 The near-exact match: `outline/outline`

**`app/` (frontend) · `server/` (backend) · `shared/` · `plugins/` · `docs/` at root.**
TypeScript, 39,884 stars, pushed 2026-07-28. Inspected at HEAD `5ff3020`.

Your proposed shape, minus the second-level folders, in production at 2,588 files / 2,039 TS
modules:

```
server 1080 files | app 789 | shared 367 | plugins 213 | public 76 | docs 5
```

Runtime import edges between layers (type-only excluded):

```
app    → app       3607        plugins → server     341
server → server    2802        plugins → app        265
app    → shared     776        plugins → shared     142
shared → shared     618        server  → plugins      4
server → shared     463        shared  → app          0   (3 type-only)
                               app     → server       0
```

Four things this settles:

1. **The shape scales.** 1,239 runtime edges cross into `shared/` from both sides, and it works.
2. **`app → server` is 0 — and nothing prevents it.** Outline has exactly **one** `tsconfig.json`
   and **one** `package.json` for the whole repo. I proved by driving `tsc` (§4.2 row A) that
   such a configuration provides *zero* enforcement. The 0 is culture, not structure.
3. **`shared → app` is 3, all `import type`, and all the same symbol.**
   `shared/editor/lib/ExtensionManager.ts:8` and `server/editor/index.ts:4` each do
   `import type { Editor } from "~/editor"`. *The app owns a type that both the shared layer and
   the backend depend on.* The shared layer failed in the direction nobody predicts: not "shared
   grew too big" but "a thing that should have been shared stayed in the frontend, and the other
   two layers reach up for it."
4. **`shared/` imports zero Node built-ins** (`node:*` count: 0). Environment neutrality is held
   by discipline, and it *is* held.

### 1.2 The literal name matches

**`windmill-labs/windmill`** — `frontend/` (SvelteKit, 2,553 files) · `backend/` (Rust, 4,507),
17,349 stars. **No `shared/`**, and there cannot be one: different languages. The contract is
`backend/windmill-api/openapi.yaml` → generated clients, with
`.github/workflows/validate-openapi.yml` enforcing it in CI.

**`highlight/highlight`** — `frontend/` (1,347) · `backend/` (614) · `packages/` (1,231) ·
`e2e/` (505). Again no `shared/`; the cross-side layer is `packages/`.

### 1.3 What projects changed later, and why

**Rocket.Chat abandoned a generic shared folder for named packages — and the PR is on record.**

Measured from four release tags:

| tag | date | `definition/` | `core-typings` | `rest-typings` | `model-typings` | packages |
|---|---|---|---|---|---|---|
| 4.0.0 | 2021-10-01 | **81 files** | 0 | 0 | 0 | 11 |
| 5.0.0 | 2022-07-21 | 40 | 147 | 121 | 65 | 15 |
| 6.0.0 | 2023-03-09 | 45 | 168 | 141 | 70 | 21 |
| 7.0.0 | 2024-11-01 | 49 | 215 | 227 | 89 | 48 |

The cause is [RocketChat/Rocket.Chat#25085 "Chore: move definitions to packages"](https://github.com/RocketChat/Rocket.Chat/pull/25085)
— author `ggazzo`, opened 2022-04-06, **merged 2022-04-13, 879 files, +8,419/−9,026** (all
verified via the API). The entire stated rationale:

> "This pull request moves the whole model typings to an exclusive package , as the rest apis as
> well."

`model-typings` followed in [#25758](https://github.com/RocketChat/Rocket.Chat/pull/25758)
(2022-06-22). **Caveat, and it matters:** the PR body gives *no* stated pain, links no issue, and
cites no design doc. **The restructuring is measured; the motivation is inferred, not evidenced.**
Do not let anyone quote Rocket.Chat as proof that shared folders hurt — it is proof only that
Rocket.Chat chose named packages when it had the chance.

**Backstage split `@backstage/core` into three, with a written RFC — and here the harm IS stated.**
[backstage#4872 "[RFC] Evolution of Backstage core…"](https://github.com/backstage/backstage/issues/4872),
Rugvip, 2021-03-08 (verified: closed, body quoted verbatim):

> "In backstage apps it is common to end up with multiple versions of `@backstage/core`. This
> breaks applications because of duplicated state – for example React context instances. … This
> results in the core package being duplicated 3 times … At runtime this will manifest itself as
> errors accessing React contexts, most commonly crashing on usages of `useApi`, as well as a
> significantly increased bundle size."

Fix: split **by consumption pattern, not by topic** — provider / consumer / components.
[PR #5825 "core: split into three new separate packages"](https://github.com/backstage/backstage/pull/5825),
**merged 2021-06-01, 455 files**.

**Sentry went the opposite way, for the same reason.**
[getsentry/sentry-javascript#14269](https://github.com/getsentry/sentry-javascript/issues/14269),
`lforst`, 2024-11-13:

> "We have decided that merging `@sentry/utils` into `@sentry/core` will clean up our
> architecture by quite a bit and prevent footguns like diverging package versions."

[PR #14382](https://github.com/getsentry/sentry-javascript/pull/14382), merged 2024-11-20,
**534 files**.

> **Read those two together.** Backstage *split* a shared package to stop version divergence
> between app and plugins; Sentry *merged* one to stop version divergence between its own
> packages. The common enemy is **version skew across a package boundary — and the boundary is
> what creates it.** "Split shared into packages" is not a safe default; it is a trade of one
> failure mode for another.

**Mattermost merged two repos into one, and left a receipt.**
[mattermost#22420](https://github.com/mattermost/mattermost/issues/22420), `lieut-data`,
2023-03-02, still open: "the following repositories will merged into a monorepo …
mattermost-server, mattermost-webapp, mattermost-plugin-playbooks, focalboard".

The archived `mattermost-webapp` README records the cost, and this is the sentence for your
standing goal of merging two repos:

> "We were unable to maintain Git history with the move, so migrating PRs to the new repo will
> likely involve a lot of manually copying changes to their new locations."

Today: `webapp/` (8,751) · `server/` (3,259) · `e2e-tests/` (1,604) · `docs/` (1,508) · `api/`
(72). **No top-level `shared/`.** There is `server/public/shared` (47 Go files) and
`webapp/platform/shared` (47 TS files) — I suspected duplicated copies and checked: **zero shared
paths, different languages.** Two per-side shared areas, no cross-side one.

**Unleash did the same merge and landed on `frontend/` + `src/`.**
`Unleash/unleash-frontend` is **archived**, last pushed 2022-10-25. `Unleash/unleash` now holds
`frontend/` (4,644) and the backend at `src/` (1,820). Note the asymmetry: the frontend got a
name; the incumbent backend kept the root `src/`. That is what merging *into* an existing repo
looks like when nobody renames the resident.

**Immich (Svelte, 109k stars):** `server/` + `web/` + `mobile/`, contract generated from
`open-api/immich-openapi-specs.json`. `packages/` holds only a CLI. Same answer as Windmill,
reached independently.

### 1.4 The pattern nobody in the survey uses

Across **21 repositories with complete file trees** plus a top-level survey of 33 more:

- **Exactly one** has a top-level `shared/`: Outline.
- **Exactly one** has a top-level `common/`: PostHog (346 files) — and it is *not* a shared-utils
  area. It is `common/hogvm/`, `common/hogql_parser/`, `common/replay-shared/`,
  `common/storybook/`, `common/tailwind/`: named sub-packages in C++, Python and TypeScript. The
  folder is called `common`; the structure is named packages.
- **Zero** have `shared/` at more than one level.
- **Zero** have per-side developer `docs/`. Every nested `docs/` I opened is something else:
  generated SDK reference (`windmill/typescript-client/docs`, 824 files) or a documentation site
  shipped as an app (`supabase/apps/docs` 2,669; `cal.com/apps/docs`). **Developer documentation
  lives at the root in every repo checked.**

---

## 2. THE KNOWN FAILURE MODES OF A TOP-LEVEL `shared/`

Each claim is labelled **EVIDENCED**, **MECHANICALLY TRUE BUT UNREPORTED**, or **WIDELY REPEATED,
NOT EVIDENCED**. That labelling is the deliverable; the folklore here is thick.

### 2.1 The junk-drawer effect — **WIDELY REPEATED, NOT EVIDENCED**

The best statement of the *mechanism* is Sameer Ajmani, **"Package names"**, official Go blog,
**2015-02-04** (<https://go.dev/blog/package-names>):

> "Packages named `util`, `common`, or `misc` provide clients with no sense of what the package
> contains. … Over time, they accumulate dependencies that can make compilation significantly and
> unnecessarily slower, especially in large programs."

and, directly on a `shared/` full of cross-side types:

> "Many well-intentioned programmers put all the interfaces exposed by their program into a
> single package named `api`, `types`, or `interfaces` … This is a mistake. … growing without
> bound, providing no guidance to users, accumulating dependencies, and colliding with other
> imports. Break them up."

**But this is reasoned guidance, not a measurement, and a targeted search for the experience
behind it came back empty.** Searches across GitHub issues/PRs for "junk drawer", "dumping
ground", "grab bag", "kitchen sink", "catch-all" combined with shared/common/util/monorepo/
TypeScript returned nothing usable: AI-generated repos, Go/Python projects, and dependency-bump
noise. The only practitioner phrasing located was a LinkedIn post. **No maintainer of a large
TypeScript monorepo, in the sources reachable, has written that their shared package became a
junk drawer and that this is what hurt them.**

**And size alone is demonstrably not the failure.** TypeScript's own
`src/compiler/utilities.ts` is **12,447 lines / 512,951 bytes** (verified via API today). They
ship it.

**What maintainers actually complain about is the barrel, in their own words.**
[microsoft/TypeScript#51443](https://github.com/microsoft/TypeScript/issues/51443), `jakebailey`,
2022-11-08, **open**:

> "this is a gross hack and makes it hard for us to start splitting the codebase up, export just
> the parser, etc."

That is the real harm: **the barrel is what prevents later decomposition.** Not the file count.

**One measured instance from this survey, flagged.** `langfuse/langfuse` has `packages/shared` at
1,217 files — larger than `worker/` (378). Composition: `prisma/migrations` 429,
**`src/server` 322**, `clickhouse/migrations` 184, `src/features` 93, `src/utils` 33. A package
named `shared` whose largest source directory is called `server`, with 50 % of its files being DB
migrations. *The structure is measured; reading it as drift is my inference and is* **not
established** — Langfuse's `web/` is Next.js and legitimately has server code, so "shared" may
mean "shared between two Node processes".

### 2.2 Cycles through the shared layer — **EVIDENCED, but the mechanism is the opposite of what you'd assume**

**In a single-program shared layer: contradicted, by measurement.** Outline — 2,039 modules,
367-file `shared/`, 1,239 runtime edges from both sides. Tarjan SCC on the **runtime** graph:

```
7 cyclic groups, 73 modules total, and NOT ONE crosses a layer boundary:
   51  server/models/…      (the ORM graph)
    5  shared/editor/…      (ToggleBlock ↔ toggleBlock command)
    5  server/presenters/…
    4  app/stores/…         (RootStore ↔ AuthStore)
    4  app/hooks + components
    2  server/utils + logging
    2  server/models + validation
```

**Inside `shared/`: exactly one runtime cycle, 5 modules, out of 367 files and 618 intra-shared
edges.** A large shared layer consumed by two sides did not produce a tangle. The tangles are the
ORM and the frontend store graph — ordinary intra-layer cycles with nothing to do with sharing.

**In a package-split shared layer: strongly evidenced, and it is a hard build failure.**

- [backstage#2082 "Circular dependencies across packages"](https://github.com/backstage/backstage/issues/2082)
  (2020-08-22, closed) — real `lerna ERR! ECYCLE` output, e.g.
  `@backstage/cli-common → @backstage/cli → @backstage/cli-common`. Note the *proposed fix is
  itself a shared-layer move* ("moving any referenced code to common packages"), i.e. the cure
  and the disease are the same operation.
- [backstage PR #508 "fix: circular dependency came back (test-utils => core => test-utils)"](https://github.com/backstage/backstage/pull/508),
  merged 2020-04-07, a **one-line** fix: "the circular dependency came back! The build passed
  that time but it will likely become flaky without landing this."
- [backstage#5563](https://github.com/backstage/backstage/issues/5563), 2021-05-03, a consumer:
  "**Bazel however does not allow circular dependencies and therefore we have had to patch
  circular dependencies throughout our fork.**"
- [grafana#117123 "Reduce circular dependencies"](https://github.com/grafana/grafana/issues/117123),
  2026-01-30, **open**, with per-package children. The maintainer's stated cost: "circular imports
  increase the cost of dependency graph construction, which can significantly affect unit test
  startup time, test isolation, and watch mode performance." The `grafana/ui` checklist is
  `madge --circular` output whose first entry is a cycle **between two shared packages**
  (`grafana-schema/veneer/dashboard.types.ts ↔ common.types.ts`).
- **TypeScript's editor tooling now assumes your shared barrel is cyclic.**
  [microsoft/TypeScript#45953](https://github.com/microsoft/TypeScript/issues/45953) (2021-09-18)
  → [PR #47516 "Avoid auto-importing from barrel re-exporting index files that are likely to make
  an import cycle"](https://github.com/microsoft/TypeScript/pull/47516) (2022-01-19), broadened in
  [#57342](https://github.com/microsoft/TypeScript/pull/57342) (2024-02-08).

> **The synthesis, and it is the most decision-relevant thing in §2.** Cycles are a *package-graph*
> problem, not a *shared-code* problem. In one program (Outline) a cross-side shared layer
> produced zero cross-layer runtime cycles. Split that same layer into npm packages and cycles
> become an `ECYCLE` build failure, a Bazel hard stop, and a `madge` backlog. **Splitting `shared/`
> into packages does not fix the cycle risk — it creates the conditions under which cycles become
> fatal.** Combine with §1.3's version-skew finding and the conclusion is: *do not package-split a
> shared layer unless you have a reason that outweighs both.*

### 2.3 Barrel `index.ts` over a shared layer consumed as SOURCE — **EVIDENCED, with numbers**

[vitejs/vite#8237 "Consider treeshaking module for serving files in dev mode"](https://github.com/vitejs/vite/issues/8237),
opened 2022-05-19, **still open, 56 comments** (verified). The OP's example is literally
`/shared/index.ts`:

> "easier said than done when your codebase is a big monorepo and you share hundreds of
> compositions/components/libraries/helpers"

Reports in-thread: a redux file save sending "about 1500 requests to the vite dev server"; "700
files and can take 10+ seconds for a HMR". Duplicate with minimal repro:
[vite#16100 "Barrel files makes Vite very very slow"](https://github.com/vitejs/vite/issues/16100)
(2024-03-05).

Measured cost, Next.js team, ["How we optimized package imports in Next.js"](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js),
Shu Ding, **2023-10-13** — local dev compile:

| package | before | after | modules |
|---|---|---|---|
| `@mui/material` | 7.1 s | 2.9 s | 2,225 → 735 |
| `@material-ui/icons` | 10.2 s | 2.9 s | 11,738 → 632 |
| `lucide-react` | 5.8 s | 3.0 s | 1,583 → 333 |

> "Tree-shaking is a bundler feature… not a JavaScript runtime feature."

And it bites *internal* workspace packages specifically:
[vercel/next.js#55943 "transpilePackages doesn't tree-shake barrel export in turborepo"](https://github.com/vercel/next.js/issues/55943),
2023-09-25, **still open** (verified) — expected `137 B / 79.4 kB`, got `13.7 kB / 92.9 kB`; one
commenter: "The number of modules for some pages decreased by over 10k for us."

Barrels also break test-impact selection:
[vitest#5009](https://github.com/vitest-dev/vitest/issues/5009), 2024-01-19 — `vitest related`
detects the test through a direct import and **not** through a barrel. That is wrongness in the
*unsafe* direction.

**The nuance the Vite maintainers added themselves — do not skip it.**
[vite PR #17651 "docs: clarify that barrel file issue is for apps rather libs"](https://github.com/vitejs/vite/pull/17651),
2024-07-10, renamed the guidance from "Avoid Barrel Files" to **"Avoid Barrel Files in your App"**:
"This is less of an issue for JS/TS libraries that are pre-bundled during dependency
optimization." Maintainer `bluwy`, 2023-11-01: "the bottleneck reported so far is in large
codebases and **source code** where barrel files are used often. We currently don't support
`sideEffects` in source code."

> **The precise rule: the hazard is *barrel + consumed as unbundled source*.** A top-level
> `shared/` reached through a path alias is exactly that case. A `shared` that is pre-built and
> consumed like a third-party dependency is largely exempt.

### 2.4 "Everything depends on shared, so nothing can change"

Two different claims hide under this heading and they have different evidence.

**(a) Build serialization — EVIDENCED, with Google's numbers.**
[microsoft/TypeScript#47947 "`--isolatedDeclarations` for standalone DTS emit"](https://github.com/microsoft/TypeScript/issues/47947),
Martin Probst (Google), 2022-02-18. The proposal exists *because* a deep shared dependency
serializes the build: `app ← counter ← textutils/splitter` costs
`|app| + |counter| + |textutils/splitter|` = "16 seconds" versus "6.5 seconds" with parallel
`.d.ts` emit. Internally at Google: "~20% wall time improvements in the 90th percentile across all
builds involving TypeScript … For a sample 'large' project … ~50% improvement in the 90th
percentile, and 75% in the 99th."

**(b) CI cache blast radius — MECHANICALLY TRUE BUT UNREPORTED.** A targeted search of the Nx,
Turborepo, pnpm and Bazel trackers found **no issue where a named team reported and measured
"our shared package changed and every task cache-missed"**. The nearest Nx hit
([#11366](https://github.com/nrwl/nx/issues/11366), 2022-07-29) is about the *root*
`package.json`. Web search for the claim returns almost exclusively SEO/AI-generated content.
It is *mechanically true by design* — both Nx and Turborepo hash a task over its package's
dependency closure — but **treat it as sound reasoning from documented tool behaviour, not as a
reported incident.** Also worth knowing: Turborepo's own
[structuring-a-repository docs](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository)
give **no** granularity guidance and **no** caching-consequence warning. There is no official
backing there to cite.

**What Outline does instead:** it has no build graph to invalidate. One `tsconfig`, one
`package.json`, `noEmit: true`, SWC for the server and Vite for the app.

### 2.5 Two environments, two runs — **EVIDENCED by measurement, and undiscussed anywhere**

Outline's `vitest.config.ts` defines **four** projects; `shared/` accounts for **two**:

```ts
{ name: "server",       environment: "node",  include: ["server/**/*.test.{ts,tsx}", "plugins/**/*.test.{ts,tsx}"] },
{ name: "app",          environment: "jsdom", include: ["app/**/*.test.{ts,tsx}"] },
{ name: "shared-node",  environment: "node",  include: ["shared/**/*.test.{ts,tsx}"] },
{ name: "shared-jsdom", environment: "jsdom", include: ["shared/**/*.test.{ts,tsx}"] },
```

**The two `shared/` includes are byte-identical.** Every test in `shared/` runs **twice**, because
code that must work in both environments must be *proved* in both. This is an unavoidable,
measured cost of a cross-side shared layer, and I found no discussion of it in any secondary
source. **Given your live wall-clock budget guards: adding a cross-side `shared/` means its test
population is counted twice against any suite budget** — and §20b applies, the budget must name
the population it now bounds.

### 2.6 The structural solution to the two-environment problem: VS Code — **the most actionable finding in this report**

VS Code has run a very large shared layer for a decade. `src/vs/base/common/` holds **115 entries**
(verified) — `arrays.ts`, `async.ts`, `event.ts`, `lifecycle.ts`, `uri.ts`, `observable.ts`,
`strings.ts`, … It works because the environment split is **structural and machine-enforced**,
not conventional.

[VS Code wiki, "Source Code Organization"](https://github.com/microsoft/vscode/wiki/Source-Code-Organization):

> "Inside each layer the code is organised by the target runtime environment. **This ensures that
> only the runtime specific APIs are used.**"
> - `common`: "only requires basic JavaScript APIs and run in all the other target environments"
> - `browser`: "requires Web APIs, eg. DOM — may use code from: `common`"
> - `node`: "requires Node.JS APIs — may use code from: `common`"

Verified on disk: `src/vs/base/` contains exactly `browser/ common/ node/ parts/ test/`.

**And it is enforced by the compiler first, a custom checker second.** `build/checker/` contains
**six per-environment tsconfigs** — `tsconfig.browser.json`, `tsconfig.node.json`,
`tsconfig.worker.json`, `tsconfig.electron-main.json`, `tsconfig.electron-browser.json`,
`tsconfig.electron-utility.json` (all verified present). `build/checker/layersChecker.ts` (4,928
bytes) says so in its own header:

> "// NOTE: Most layer checks are done via tsconfig.\<layer\>.json files."
> "// Types that are defined in a common layer but are known to be only available in native
> environments should not be allowed in browser"

Plus `build/lib/checkCyclicDependencies.ts` (4,718 bytes), which builds an import graph with
`ts.preProcessFile` and **exits non-zero** on a cycle.

**Translated to your shape — this is a concrete recommendation, not a principle:**

1. Do not have one `shared/`. Have `shared/common/` (no DOM, no Node), `shared/browser/`,
   `shared/node/`, with a stated one-way "may use code from" relation.
2. **Enforce it with per-environment tsconfigs that differ in `lib` and `types`.** `common` gets
   neither `dom` nor `@types/node`. This is the cheapest, highest-yield guard available, it is
   rung 2 (unrepresentable — the type does not exist), and it is what VS Code says it relies on
   most.
3. Add a cycle check that exits non-zero.
4. Only write a custom AST checker for what tsconfig cannot express.

Point 2 also dissolves §2.5: if `shared/common` genuinely cannot reference DOM or Node types, most
of it needs **one** environment, and everything that needed two has been forced into
`shared/browser` or `shared/node` where it belongs. **The double test run is the price of an
undifferentiated `shared/`, and this is how you stop paying it.**

### 2.7 Evidence *for* a large shared layer

- **Outline.** 367 files, both sides, zero cross-layer runtime cycles, 39.9k stars, active.
- **VS Code.** A 115-entry `base/common` at enormous scale — with the discipline of §2.6.
- **Backstage mandates barrels, in a written ADR.**
  [ADR004: Module Export Structure](https://github.com/backstage/backstage/blob/main/docs/architecture-decisions/adr004-module-export-structure.md):
  "We will make each exported symbol traceable through index files all the way down to the root of
  the package … Each index file will only re-export from its own immediate directory children."
  Their problem was the *opposite* of the folklore — unpredictable ad-hoc re-exports. Note this is
  a *published, pre-built* package, i.e. exactly the case Vite's maintainers exempted (§2.3).
- **TypeScript ships a 12,447-line `utilities.ts`.**

---

## 3. TESTS BESIDE vs TESTS APART

### 3.1 The population, measured

Colocated = not under a directory named `test`/`tests`/`__tests__`/`e2e`/`spec`/`cypress`.

| repo | test files | colocated | separate | what the separate tree holds |
|---|---|---|---|---|
| outline | 254 | **254 (100 %)** | 0 | — |
| directus | 942 | 827 (87 %) | 115 | `tests/blackbox/` — DB-backed integration |
| mattermost (TS) | 1,509 | 1,227 (81 %) | 282 | `e2e-tests/{cypress,playwright}` |
| unleash | 711 | 544 (76 %) | 167 | `src/**/test`, `spec` |
| immich | 205 | 141 (68 %) | 64 | `e2e/` — Playwright + docker-compose |
| windmill | 270 | 167 (61 %) | 103 | `cli/test` |
| Rocket.Chat | 908 | 486 (54 %) | 422 | `tests/{e2e,end-to-end,unit,data,mocks}` |
| langfuse | 219 | 90 (41 %) | 129 | `worker/**/__tests__` |

Mattermost additionally has **807 Go `_test.go` files**, which the language *forces* to colocate.

**The decision is far less contested than the literature suggests.** Unit tests are colocated
41–100 % of the time; the separate tree is, in every case I opened, **e2e or DB-backed
integration** — a different artefact with its own `package.json`, its own `docker-compose.yml`,
its own Playwright config (Directus `tests/blackbox/`; Immich `e2e/`).

**The per-side `test/` folders you propose already exist in Outline — holding something else.**
`app/test/` is one file (`setup.ts`). `shared/test/` is two. `server/test/` is nine:
`TestServer.ts`, `factories.ts`, `msw.ts`, `setup.ts`, `globalTeardown.ts`, `support.ts`,
`fixtures/`. **Not one test case among them.** The per-side `test/` directory in the real world is
*test harness*.

**A cautionary artefact:** Rocket.Chat's `apps/meteor/tests/` contains **both `e2e/` (387 files)
and `end-to-end/` (99 files)**. Two directories, one concept, same repo. That is a test tree after
five years without a naming authority.

### 3.2 How each choice interacts with discovery, coverage and the typecheck program

All driven, because this is where your live defect lives.

#### Discovery — a silent population change between two major versions

Vitest source (`packages/vitest/src/defaults.ts`), read at both tags:

| | v3.2.0 | v4.1.10 (latest, 2026-07-06) |
|---|---|---|
| `defaultInclude` | `['**/*.{test,spec}.?(c\|m)[jt]s?(x)']` | *unchanged* |
| `defaultExclude` | `node_modules`, **`dist`**, **`cypress`**, `.idea/.git/.cache/.output/.temp`, `*.config.*` | **`node_modules`, `.git` only** |

Official migration guide: *"By default, Vitest now only excludes tests from `node_modules` and
`.git` folders."*

**Driven, both versions installed, identical fixture** — `src/add.test.ts` (colocated),
`tests/apart.test.ts` (separate), `dist/add.test.js` (a stale compiled copy containing
`expect(1).toBe(2)`):

```
vitest 3.2.4, zero config →  Test Files  2 passed (2)
vitest 4.1.10, zero config →  Test Files  1 failed | 2 passed (3)
                              FAIL  dist/add.test.js
```

**The build artefact ran.** Same fixture, same command, different major version. This is your
"a path pattern decides what runs" defect arriving not from your code but from a *dependency's
defaults*, silently, in the permissive direction.

The default glob `**/*.{test,spec}.?(c|m)[jt]s?(x)` **matches colocated and separated tests
equally** — neither layout needs configuration; both need `exclude` to be *correct*. Note
`.svelte` is not in that extension set: a `Foo.test.svelte` is not discovered by default.

#### Coverage — the denominator is a glob, and the default hides absence

Vitest 4 removed `coverage.all` and changed `coverage.exclude`'s default from a 19-pattern list to
`[]`. Migration guide: *"In previous versions Vitest included all uncovered files in coverage
report by default … it is recommended to define `coverage.include`."*

**Driven on 4.1.10** with `src/add.ts` (partly covered), `src/unused.ts` (never imported),
`src/add.test.ts` colocated, `tests/apart.test.ts` separate:

```
no coverage.include      →  All files 75 %   —  unused.ts DOES NOT APPEAR AT ALL
coverage.include=src/**  →  All files 50 %   —  unused.ts 0 %, number moves 75 → 50
coverage.include=**      →  All files 20 %   —  package.json, package-lock.json, and coverage's
                                                OWN temp JSON files enter the denominator
```

Three consequences, all of them §21b shipped as a default:

1. **Vitest 4's default coverage cannot report an entirely-uncovered file.** A module nothing
   imports is invisible. *A green coverage number is evidence about what was executed, never about
   what is on disk.*
2. `coverage.include` *is* the population definition, and it is a path glob.
3. A naive glob yields a garbage denominator including the coverage tool's own artefacts.

**On the actual question:** test files did **not** enter the denominator in either layout under
4.1.10 — the running test file is auto-excluded by the provider. **So the frequently-repeated
claim that "colocated tests pollute your coverage numbers" is false on current Vitest and must not
drive the decision.**

#### The typecheck program — where colocation genuinely costs, and the trap under the fix

Driven on **TypeScript 7.0.2**:

```
include:["src/**/*"], outDir, rootDir, declaration
   →  dist/a.js  dist/a.d.ts  dist/a.test.js  dist/a.test.d.ts     ← shipped
```

The standard workaround:

```jsonc
// tsconfig.build.json
{ "extends": "./tsconfig.json", "exclude": ["**/*.test.ts"] }   →  dist/a.js  dist/a.d.ts   ✓
```

**And the trap, mutation-verified.** Base declares `exclude: ["**/*.spec.ts"]`; child declares
`exclude: ["**/*.test.ts"]`:

```
dist/a.js  dist/a.d.ts  dist/a.spec.js  dist/a.spec.d.ts     ← the .spec files came back
```

The child's `exclude` **replaced** the base's. Same for `include`, driven separately: a base
including three directories and a child including one yields a program of exactly one file. This
matches the documentation verbatim (<https://www.typescriptlang.org/tsconfig/#extends>):

> "It's worth noting that `files`, `include`, and `exclude` from the inheriting config file
> **overwrite** those from the base config file"

> "Currently, the only top-level property that is excluded from inheritance is `references`."

**Outline's answer to the emit problem is to have no emit.** One `tsconfig.json`, `noEmit: true`,
`exclude: ["node_modules","build","server/migrations"]`; SWC builds the server, Vite the app.
Colocated tests are in the typecheck program (which you want) and in no build output (because
there is none). **If you never `tsc --emit`, the colocation cost is zero.**

#### Publishing

If any side is ever packaged, SvelteKit's packaging docs recommend
`"files": ["dist", "!dist/**/*.test.*", "!dist/**/*.spec.*"]` — colocation requires an explicit
negation in a *fourth* place carrying the same path literals
(<https://svelte.dev/docs/kit/packaging>).

---

## 4. MONOREPO MECHANICS — what actually prevents `frontend/` importing `backend/`

### 4.1 Enforced by the runtime — Node `exports` (measured, Node v24.18.0)

Node docs (fetched today): *"When using the `exports` field, all subpaths of the package are
encapsulated and no longer available to importers."*

Driven, with mutation:

```
exports: { ".": "./index.js" }
  import "backend/internal/db.js"  →  Error [ERR_PACKAGE_PATH_NOT_EXPORTED]:
                                      Package subpath './internal/db.js' is not defined by "exports"
  import "backend"                 →  public entry ok: 1

MUTATION — remove the exports field, change nothing else:
  import "backend/internal/db.js"  →  IMPORTED INTERNAL: db-password
```

The mutation proves the guard is live rather than incidental. Rung 1: the resolver refuses, for
every consumer that will ever exist, including ones nobody has written.

### 4.2 Enforced by the compiler — project references (measured, three mutations, TS 7.0.2)

`frontend/src/app.ts` importing `../../backend/src/internal`:

| configuration | result |
|---|---|
| **A.** single project, `include`, no `composite` | **compiles clean — no enforcement whatsoever** |
| **B.** `composite: true` + `rootDir: ./src`, no `references` | `TS6059: File 'backend/src/internal.ts' is not under 'rootDir'` **and** `TS6307: File … is not listed within the file list of project` |
| **C.** same + `references: [{ path: "../backend" }]` | builds, through backend's declaration output |
| **MUTATION 1.** remove the reference from C | TS6059 + TS6307 return |
| **MUTATION 2.** keep the reference, import `backend/secret/k.ts` (outside backend's `include`) | TS6059 + TS6307 |

**Deny-by-default at the compiler.** Mutation 2 matters most: the reference does not open the
directory, only the referenced project's *declared file set*. That is contract §4 at rung 2.

Row **A** is the row to read twice: **it is Outline's exact configuration.** Their `app → server`
count of 0 is culture.

**Independent corroboration that this diagnostic is the real gate:** `moonrepo/moon`
[#1527 "[bug] includeProjectReferenceSources seems to cause typecheck failure"](https://github.com/moonrepo/moon/issues/1527)
(2024-06-27, closed) reports **the identical error from a generator**:

> `error TS6059: File '…/packages/models/src/GaugeModel.ts' is not under 'rootDir'
> '…/packages/ui/src'. … Matched by include pattern '../models/**/*' in
> '…/packages/ui/tsconfig.json'`

My driven experiment and a real generator's bug report produce the same diagnostic from opposite
directions. It is load-bearing in the wild, not a laboratory artefact.

### 4.3 Merely discouraged — and how rare the discouragement is

Across the 20 repos with complete trees (~115,000 files):

```
dependency-cruiser config      1 / 20   (Ghost)
eslint-plugin-boundaries       0 / 20
nx.json                        3 / 20   (Twenty, Grafana, Ghost)
turbo.json                     8 / 20
pnpm-workspace.yaml           11 / 20
```

**The near-universal mechanism is many `package.json` + many `tsconfig.json`.** Directus 43/43.
Rocket.Chat 77/103. n8n 86/165. **Outline 1/1.**

Nx's `enforce-module-boundaries` is the best-documented lint-level answer
(<https://nx.dev/blog/mastering-the-project-boundaries-in-nx>, Miroslav Jonaš, 2021-12-17) —
`{ "sourceTag": "scope:shared", "onlyDependOnLibsWithTags": ["scope:shared"] }`, with "circular
dependency chains … are also not allowed". But it is a lint rule, and 3 of 20 repos use Nx.

**Outline's per-directory lint config is the cheapest real thing in the survey.**
`shared/.oxlintrc.json`:

```jsonc
"no-restricted-imports": ["error", { "patterns": [
  { "group": ["@shared/*"], "message": "Use relative imports." },
  { "allowTypeImports": true, "group": ["~/*"],       "message": "Do not reference app code from shared code." },
  { "allowTypeImports": true, "group": ["@server/*"], "message": "Do not reference server code from shared code." }
]}]
```

Two decisions worth stealing regardless of the rest:

- **`allowTypeImports: true`** is why their runtime graph is acyclic across layers while the type
  graph is not. It is the escape hatch that makes the rule adoptable.
- **`@shared/*` is banned *inside* `shared/`** — "Use relative imports." An alias that resolves
  from anywhere hides cycles from tooling and readers; relative paths inside the layer make its
  internal graph legible.

And note what is **absent**: no rule anywhere in Outline forbids `app/` importing `@server/*`.
The one direction you most want closed is the one they never wrote a rule for.

### 4.4 The alternative two projects chose independently: share no source

Windmill and Immich share **a generated contract, not source** — an OpenAPI document owned by the
backend, from which the frontend client is generated, with CI validating it in Windmill's case.
The boundary cannot rot because there is no import edge to police. Available to them partly
because their two sides are different languages.

---

## 5. GENERATED-PATH-CONFIG PRIOR ART

**Summary up front: every ingredient has been built by someone competent — always for exactly one
config family, always inside a build system that owns the project graph. The cross-family
generator you describe, and its link to a sandbox spec, are unbuilt. The reasons the field stopped
where it did are documented and specific.**

### 5.1 It exists, is first-party, and you already depend on it

**SvelteKit generates `.svelte-kit/tsconfig.json`; your own `tsconfig.json` extends it.**

> "Since SvelteKit relies on certain configuration being set a specific way, it generates its own
> `.svelte-kit/tsconfig.json` file which your own config extends."
> — <https://svelte.dev/docs/kit/project-structure>

The one-declaration-emits-many pattern is the `alias` option:

> "An object containing zero or more aliases used to replace values in import statements. **These
> aliases are automatically passed to Vite and TypeScript.**"
> — <https://svelte.dev/docs/kit/configuration>

And SvelteKit 2 made the generated form the *only* supported form:

> "In SvelteKit 2, the validation is more strict and will warn when you use either `paths` or
> `baseUrl` in your `tsconfig.json`. These settings are used to generate path aliases and you
> should use the `alias` config option in your `svelte.config.js` instead, to also create a
> corresponding alias for the bundler."
> — <https://svelte.dev/docs/kit/migrating-to-sveltekit-2>

**Caveat, current as of docs fetched today: `alias` is now itself deprecated in favour of subpath
imports** — Node's `package.json` `"imports"` field with `#` prefixes, resolved by the *runtime*
rather than by a generator. The direction of travel is away from generated aliases and toward the
standard mechanism. **If you are choosing today, choose `#`-prefixed subpath imports.**

### 5.2 Real tooling, verified — and where each breaks

**Nx `nx sync` (v23.1.0, 2026-07-13).** Generates tsconfig `references` from the project graph;
`nx sync:check` gates CI. The recurring defect is that *the build graph's notion of "dependency"
≠ TypeScript's notion of "reference"*, so generation over-approximates and breaks typecheck:

- [#28997](https://github.com/nrwl/nx/issues/28997) (2024-11-19): sync adds references for
  *implicit* deps — "If we skip running the sync generator, the build succeeds, otherwise if we
  run the sync generator the build fails."
- [#36297](https://github.com/nrwl/nx/issues/36297) — **verified open, created 2026-07-10**,
  titled "@nx/js project graph infers spurious, unstable static edges between sibling apps (breaks
  @nx/js:typescript-sync)". **Nondeterministic generator output that CI then demands you commit.**
- [#33079](https://github.com/nrwl/nx/issues/33079), [#35846](https://github.com/nrwl/nx/issues/35846):
  the generator silently no-ops unless `tsconfig.base.json` sits at the root under that exact name.

**moon (`@moonrepo/cli` v2.4.6, 2026-07-28)** — the only tool found that generates tsconfig
`include` globs, not just `references`. **It hits the identical bug class as Nx, independently**
([#1527](https://github.com/moonrepo/moon/issues/1527) TS6059 as quoted in §4.2;
[#1561](https://github.com/moonrepo/moon/issues/1561) references for implicit deps;
[#2535](https://github.com/moonrepo/moon/issues/2535), [#2438](https://github.com/moonrepo/moon/issues/2438)
pruning deletes references `tsc -b` needs). Two independent implementations failing the same way
is evidence the difficulty is structural.

**Bazel + Gazelle (v0.52.2, 2026-07-23).** The merge-conflict evidence is hard, quantified, and
comes from downstream. [kubernetes#88553](https://github.com/kubernetes/kubernetes/issues/88553)
(verified: created 2020-02-25):

> Jeff Grafton, 2020-03-04: "there are **31 `BUILD` file conflicts** … having to regenerate the
> BUILD files is a pain."
> Tim Hockin: "I see BUILD file chages in 50% of PRs I review, and I promise that every single one
> of them is just autogenerated noise."
> tnozicka, on precisely your thesis: "**Their generation is not idempotent** which you will hit
> when rebasing… Keeping duplicate dependency information (includes) in 2 files is just not
> beneficial."

Outcome: [PR #99561 "Remove Bazel"](https://github.com/kubernetes/kubernetes/pull/99561) —
**verified merged 2021-03-01, 3,355 files, +21 / −147,789 lines.**

Gazelle also demonstrates **escape-hatch accretion**: 36 `# gazelle:` directives plus `# keep`,
and a `-remove_noop_keep_comments` flag — a garbage collector for your escape-hatch annotations.
[bazel-gazelle#39](https://github.com/bazel-contrib/bazel-gazelle/issues/39), *open since
2017-12-18*, is two generators contending for one file.

**Pants (release_2.32.1, 2026-06-27) — the explicit, written rejection of your approach, and your
single best citation.** [*Dependency inference: Pants's special sauce*](https://www.pantsbuild.org/blog/2022/10/27/why-dependency-inference)
has a section headed **"Auto-generating BUILD files"** (section heading and quotes verified live
against the page today) that names Gazelle and rejects it:

> "**For one thing, many BUILD files cannot be completely generated.** They still need to be
> manually edited… **Having an automatic process modify human-edited files, and vice versa, gets
> messy quickly. How do you customize and correct the generator's output? How do you ensure that
> human edits aren't erased or overwritten?** … So we ended up rejecting BUILD file generation as
> the simplifying mechanism."

Their alternative is inference at runtime — which has its own bill from their own tracker:
unsilenceable ambiguity warnings that ship a *broken* artefact
([#20806](https://github.com/pantsbuild/pants/issues/20806)); false positives
([#20324](https://github.com/pantsbuild/pants/issues/20324) — `print('retrying...')` inferred as a
dependency); and severe latency ([#23236](https://github.com/pantsbuild/pants/issues/23236),
2026-04: ">20 GiB of memory", "3-4m delay… 30-40% of a build pipeline"). Note `pants tailor`
generates target declarations but **deliberately never dependencies**.

**Buck2** requires explicit `deps`; lead maintainer ndmitchell,
[#509](https://github.com/facebook/buck2/issues/509): "for other things, like generating Python
dependencies based on import statements… **we have nothing publicly available to make it easy.**"
**please.build**: `puku` is live (v1.17.1, 2026-02-02); `wollemi` is dead (last commit 2022-04-15).

**The JS point tools, checked one by one:** `syncpack` (v15.3.2, 2.05 M/wk) — **versions only,
zero path literals**. `manypkg` (v0.25.1) — nine checks, **none path/glob**. `sherif` (v1.13.0) —
has a dangling-path *detector* (`non-existant-packages`), warning-only, never generates.
`update-ts-references` (v6.1.0, 188 K/wk) generates both `references` and `paths`.
**`turbo` (19.6 M/wk): `inputs`/`outputs` globs are hand-written universally — nothing generates
them.** Ignore files: `ignore-sync` (v8.0.0) is real but *composes* ignore files rather than
deriving them, at 2,806 downloads/wk with no functional release since 2024-12.

### 5.3 The hard, driven constraint

**`tsconfig` `include`/`exclude`/`files` do not compose across `extends`; they replace.**
Documented (§3.2) and mutation-verified. Three consequences:

1. **A generator must emit the COMPLETE list into every file that needs it.** No delta, no append,
   no merge. "Base declares the common excludes, each side adds its own" is **not expressible.**
   I planted the case and watched `a.spec.js` reappear in `dist/`.
2. **`references` is not inherited at all**, so it must be written into every leaf config.
3. **The generated file must be the one every tool reads** — and SvelteKit's own template says so:
   *"If you want to overwrite includes/excludes, make sure to copy over the relevant
   includes/excludes from the referenced tsconfig.json — TypeScript does not merge them in."*
   The escape hatch is a JS mutation callback (`kit.typescript.config`), not composition. When the
   format cannot compose, you bolt on a callback.

**And TypeScript has declined to fix this for eight years** (all verified today):

- [#20110 "allow user to merge extended arrays in tsconfig files"](https://github.com/microsoft/TypeScript/issues/20110)
  — **open since 2017-11-17, 114 reactions.**
- [#57486 "Proposal for merging array or object options in tsconfig file"](https://github.com/microsoft/TypeScript/issues/57486)
  — **open since 2024-02-22, 127 reactions.**
- [#25376 "Infer project references from common monorepo patterns / tools"](https://github.com/microsoft/TypeScript/issues/25376)
  — **open since 2018-07-02, 252 reactions, 59 comments**, still "In Discussion". Its thread is a
  graveyard of independent reimplementations (Theia's `configure-references`,
  `set-project-references`, `@monorepo-utils/…`, `pnpm/meta-updater`).

### 5.4 The other three failure modes, sourced

**(a) Generated files in git go stale and conflict.** Confirmed with numbers (Kubernetes: 31 BUILD
conflicts across 38 PRs). And you cannot simply gitignore them, because generated and hand-written
content share the file. SvelteKit escapes by writing to a gitignored `.svelte-kit/` — and pays with
the bootstrap problem: [sveltejs/kit#7028 `Cannot find base config file "./.svelte-kit/tsconfig.json"`](https://github.com/sveltejs/kit/issues/7028)
(verified: created 2022-09-25, 17 comments), fixed only by textual instruction ("Prepend your
script with `svelte-kit sync`"), and when pnpm 10 dropped lifecycle scripts SvelteKit had to
migrate the whole ecosystem to `"prepare": "svelte-kit sync"`
([#13326](https://github.com/sveltejs/kit/issues/13326)). **You get to choose which of the two you
pay; there is no configuration that avoids both.**

**(b) Tools that read path config but cannot read the generated form.** The best-sourced item in
the whole strand. Aspect's own `rules_ts` docs warn against their own generated tsconfig:
*"Remember that editors need to know some of the tsconfig settings, so if you rely exclusively on
this approach, you may find that the editor skew affects development."* And on two declarations of
one fact: *"conflicts between them are not validated."* Nx
[#3106 "Cannot find all references in VS Code"](https://github.com/nrwl/nx/issues/3106) has been
open **since 2020-06-03** with 55 comments; Nx's [RFC 29099](https://github.com/nrwl/nx/discussions/29099)
cited it as the reason to abandon generated `compilerOptions.paths` for standard workspaces,
aiming at *"relying on common standards… rather than Nx-specific features"* — and
[#30378](https://github.com/nrwl/nx/issues/30378) (2025-03) reports it still broken afterwards.

**(c) Formats that fundamentally cannot be generated into.** All three of your predictions verified:
tsconfig `include`/`exclude` overwrite on `extends` (above); **`.gitignore` has no include
directive**, and *"It is not possible to re-include a file if a parent directory of that file is
excluded"*; and **ESLint did not fix `.eslintignore` — it deleted it**: flat config *"does not
support loading ignore patterns from .eslintignore files."*

### 5.5 The counter-trend, and it won on volume

**The JS ecosystem converged on the opposite answer: read the existing file at runtime, don't
generate a new one.**

- `includeIgnoreFile()` is now **first-party in `@eslint/config`**: it "translates gitignore-style
  patterns into a config object containing `ignores` glob patterns."
- `eslint-config-flat-gitignore` (1.33 M/wk) + `@eslint/compat` (7.28 M/wk) ≈ **8.6 M/wk**, versus
  `ignore-sync`'s 2,806. The stated rationale is literally yours: *"single source of truth."*
- typescript-eslint killed `tsconfig.eslint.json` duplication with `projectService` — inference,
  not generation: *"We've seen users have to manage separate tsconfig.eslint.json files… Not
  ideal."*
- `vite-tsconfig-paths` became native in Vite 8 (`resolve.tsconfigPaths`).

Every one of these **reads a pre-existing file rather than emitting a new one.** That is the trend
line, and it is the opposite of the design you are considering.

### 5.6 Sandbox / permission specs — the negative result, stated plainly

**No tool generates a filesystem-permission or sandbox spec from the same declaration that emits
build-config path literals. No such tool was found, and no feature request for one — declined or
otherwise.**

What exists is prior art for the *principle*, always as an ephemeral internal detail:

- **Bazel** (<https://bazel.build/docs/sandboxing>): *"Bazel's file system sandbox runs processes
  in a working directory that only contains known inputs, such that compilers and other tools
  don't see source files they should not access."* Caveat from the same page: *"Sandboxing doesn't
  hide the host environment in any way."*
- **Nix**: builds *"are isolated from the normal file system hierarchy and only see their
  dependencies in the Nix store"*; the closure of declared inputs *is* the mount list.
- **Pants**: *"The process will run in a temporary directory and is hermetic."*

**In all three the sandbox is per-action, internal, and exports nothing another runtime consumes.
That is your gap, and it is real.**

On the consumer side every permission spec is hand-written. Node's permission model is Stable
(`--allow-fs-read`, stable in v23.5.0/v22.13.0) with **no generator found**. Deno gained
`permissions` in `deno.json` in **Deno 2.5 (2025-09-10)** — which relocates hand-written flags into
a file; there is no proposal to derive them from the module graph, and there is an architectural
reason: *"All modules that are imported in the initial static module graph… are loaded by the
runtime without consulting the permission system."* **The module graph is exempt from the
permission system, which is precisely the join you would need.**

### 5.7 What it is called

**No settled name.** The nearest verified terms are **"sync generator"** (Nx's own),
**"BUILD file generation"** (Bazel/Gazelle), and **"dependency inference"** (Pants, for the
opposite approach). None covers the cross-family breadth you describe. The classic critique of the
whole move is Mike Hadlow's [Configuration Complexity Clock](https://mikehadlow.blogspot.com/2012/05/configuration-complexity-clock.html)
(2012-05-07): *"we're back where we started four years ago, hard coding everything, except now in a
much crappier language."* **If there is a name for the general pattern, it does not exist yet.**

---

## 6. NAMING — what has evidence, and what is taste

Top-level names holding each side, measured across the 21 full-tree repos:

**Frontend:** `frontend` — Windmill (2,553), Highlight (1,347), PostHog (7,464), Unleash (4,644) ·
`web` — Immich (741), Langfuse (2,590) · `app` — Outline (789), Directus (1,559) · `webapp` —
Mattermost (8,751) · `public` — Grafana (8,713) · `src` — Bluesky · `apps/` — Rocket.Chat,
cal.com, Ghost, Supabase, Formbricks, Trigger.dev, Twenty, NocoDB, n8n.

**Backend:** `backend` — Windmill (4,507), Highlight (614) · `server` — Outline (1,080), Immich
(675), Mattermost (3,259) · `api` — Directus (1,206) · `src` — Unleash (1,820) · `pkg` — Grafana
(7,074, Go convention) · `worker` — Langfuse (378).

**What the evidence supports:**

- **`apps/` + `packages/` is the dominant JS-ecosystem convention by a wide margin** — roughly half
  the surveyed repos, near-universal among those started after ~2021. `frontend/` + `backend/` is a
  real but minority choice (2 of 21 use exactly those two words).
- **`backend/` vs `server/` is taste.** Both attested at scale; no evidence distinguishes them.
- **`api/` for backend *code* is a trap that has already bitten this sample.** Directus uses `api/`
  for the backend; Mattermost uses `api/` for the **OpenAPI specification** (72 files). One word,
  two incompatible meanings, inside 21 repos. If your frontend/backend contract is ever a spec
  document (§4.4 — and two projects here chose exactly that), `api/` is the name that document will
  want. **Do not spend it on code.**
- **`common/` has an explicit, dated, authoritative argument against it** (Go blog, §2.1) and one
  attested instance that is not actually a common area (PostHog). `shared/` has one attested
  instance that *is* one (Outline) and no comparable argument against the word. **On the evidence,
  `shared/` over `common/`** — though note VS Code, the strongest example in this report, uses
  `common` for the *environment-neutral* layer specifically, which is a narrower and better-defined
  meaning than "shared".
- **`core/`** — zero instances in the 21-repo survey, no authoritative guidance found. **No
  evidence either way.** Note Backstage's `@backstage/core` is a *package*, not a top-level folder,
  and it was split apart (§1.3) — which is a data point about the concept, not the word.

---

## 7. WHERE THE OUTSIDE VIEW CONTRADICTS YOUR PROPOSED SHAPE

Worst first.

### 7.1 The layout gives you *no* enforcement unless the compiler configuration changes too

**This is the contradiction that matters most, and it is not about naming.** Directory layout does
not create a boundary. Driven proof: one `tsconfig.json` with `include` lets `frontend/` import
`backend/` internals with **zero diagnostics** (§4.2 row A) — and that is precisely the
configuration of the one repo that matches your shape. Outline's `app → server` count of 0 is
maintained by people; their lint rules never even address that direction.

If the boundary is to be real, the layout needs **one** of:

1. `composite` + `rootDir` + `references` per side — compile error, deny-by-default, no new tools
   (rung 2, measured); or
2. one `package.json` per side with `exports` — resolver error (rung 1, measured); or
3. an explicit, written acceptance that you are at rung 5–6, as Outline effectively has.

### 7.2 `shared` at two levels — the one part with an evidenced argument against it

Your shape puts `shared/` at the root **and** `frontend/shared/` **and** `backend/shared/`.
**Zero of 21 repositories do this.** The objection is not the structure — the structure is sound,
Outline has it — it is the **name reuse**, because the two levels mean different things ("agnostic
across frontend and backend" vs "common within the frontend"), and one word cannot carry both
without every placement decision becoming a judgement call.

**Outline solved exactly this, and the solution is a rename:**

```
shared/         367 files   ← agnostic across both sides
shared/utils/    72
app/utils/       39         ← common within the frontend
server/utils/    75         ← common within the backend
```

Root layer is `shared`; per-side layers are `utils`. Different concept, different word. **This is a
naming correction, not a structural one — the structure survives intact.**

### 7.3 If `shared/` serves a browser and a Node runtime, one directory is the wrong shape

VS Code (§2.6) is the strongest counter-model in this report and it says: split by **target
runtime environment**, not just by ownership — `shared/common` (no DOM, no Node),
`shared/browser`, `shared/node` — and enforce it with **per-environment tsconfigs differing in
`lib` and `types`**, which is rung 2. Outline's single `shared/` pays for the lack of this split
with a **doubled test run** (§2.5), byte-identical globs under two environments.

### 7.4 A root `tests/` alongside per-side `tests/` will drift unless the three are named for what they are

Measured: every surveyed repo with both uses the root tree for **e2e/integration only**, and those
directories carry their own `package.json`, `docker-compose.yml` and Playwright config because they
are a different artefact. The per-side `test/` directories in Outline contain **zero test cases**.
Unit tests are colocated 41–100 % of the time everywhere.

Three distinct things; your proposal gives two of them the same word:

| what it is | evidenced home | evidenced name |
|---|---|---|
| unit tests | beside the source | `foo.test.ts` |
| test harness (setup, factories, fixtures, servers) | inside each side | `<side>/test/` |
| cross-side e2e / DB-backed integration | root, with its own manifest | `e2e/` or `tests/` |

Rocket.Chat is the warning: `tests/e2e/` **and** `tests/end-to-end/` in the same repo.

### 7.5 Per-side `docs/` is unattested

Zero of 21 repos keep developer documentation per side; every nested `docs/` opened was a generated
SDK reference or a documentation website shipped as an app. Not fatal, but it deserves a reason.

### 7.6 Do not "fix" the shared layer by splitting it into packages

This is a contradiction of the *likely next step*, not of the current proposal, and it is worth
stating now because the folklore will push you there.

- **Cycles become fatal.** In one program, Outline's 367-file cross-side `shared/` produced **zero**
  cross-layer runtime cycles. As npm packages, cycles become `lerna ERR! ECYCLE`, a Bazel hard stop,
  and a `madge` backlog (Backstage ×3, Grafana). **Packaging creates the conditions in which the
  cycle risk becomes a build failure.**
- **Version skew appears.** Backstage split a shared package *because of* version divergence;
  Sentry merged one *because of* version divergence. The boundary is the hazard.
- **Barrels become expensive.** The measured harm (§2.3) is specific to **barrel + consumed as
  unbundled source**, which is what a workspace-source shared package is.

### 7.7 Where the outside view SUPPORTS you

- **`frontend/` and `backend/` as sibling top-level folders in one repo is attested at scale**
  (Windmill 7,060 files across the two; Highlight) and is the direction of travel — Unleash and
  Mattermost both *arrived* there by merging two repos. Your standing goal is the well-trodden
  path, not the contrarian one. Budget for the Git-history loss Mattermost documented.
- **A large cross-side `shared/` does not produce dependency cycles.** The single most-repeated
  objection is, on the one repository where it could be measured properly, **false**.
- **The junk-drawer claim is not evidenced** by any large TypeScript monorepo's stated experience.
- **Colocated unit tests are the majority practice**, need no configuration under Vitest's default
  glob, and — contrary to the common claim — **do not pollute coverage** on Vitest 4.
- **The generated-path-config idea has first-party precedent in the framework you already use.**

### 7.8 Two rules to carry into the design regardless

- **Any cycle guard must run on the type-erased graph.** Including `import type` edges turns
  Outline's clean 73-module cycle set into a 194-module cross-layer monster that does not exist.
  A guard that manufactures findings is worse than no guard.
- **Your test-discovery and coverage populations are globs whose *defaults changed under you*
  between two major versions of a dependency.** Vitest 3 → 4 started running `dist/**` tests and
  stopped reporting uncovered files. Whatever declaration you emit must **pin these explicitly
  rather than inherit them**, and §20b applies: the population must be named, not implied.

---

## 8. COVERAGE — searched, found, not established

**Searched and found (primary sources, dated):**

- Complete recursive file trees for **21 repositories**, `truncated:false` verified each; top-level
  survey of 33 more. All fetched 2026-07-28.
- Rocket.Chat at **four release tags** to establish a trajectory, plus the causal PR (#25085).
- Shallow clone of `outline/outline` @ `5ff3020` with bespoke import-graph and Tarjan SCC analysis;
  blind spots quantified (§0).
- Driven experiments: Node v24.18.0 (`exports`, mutated); TypeScript 7.0.2 (`extends`, project
  references, emit — three mutations); Vitest 4.1.10 **and** 3.2.4 side by side on one fixture.
- **24 third-party issues/PRs re-verified via the GitHub API** for title, author, date, state,
  reaction count and diff size: Rocket.Chat #25085/#25758; Backstage #4872, #5825, #2082, #508,
  #5563; Sentry #14269, #14382; TypeScript #25376, #20110, #57486, #51443, #45953, #47516;
  Kubernetes #88553, PR #99561; Nx #36297; moon #1527; SvelteKit #7028; Vite #8237;
  Next.js #55943; Grafana #117123; plus VS Code `layersChecker.ts`,
  `checkCyclicDependencies.ts`, the six `build/checker/tsconfig.<layer>.json` files, and
  `src/vs/base/{browser,common,node}`.
- Docs fetched today: typescriptlang.org `#extends`; nodejs.org `packages.html`; svelte.dev
  `configuration`, `project-structure`, `packaging`, `migrating-to-sveltekit-2`; vitest.dev
  `guide/migration`; Vitest source at `v3.2.0` and `v4.1.10`; go.dev `blog/package-names`
  (2015-02-04); nx.dev boundaries blog (2021-12-17); pantsbuild.org dependency-inference blog
  (section heading and quotes confirmed live).

**Found, but weaker than I would like:**

- Rocket.Chat's move is measured across four tags *and* the PR is identified — but the PR body
  states **no pain**, links no issue and cites no design doc. The outcome is evidence; the
  motivation is inference.
- The Nx boundaries material is a vendor blog, not a post-mortem, and is labelled as such.
- Langfuse's `packages/shared/src/server/` is a measured structural fact; reading it as drift is
  explicitly flagged as **not established**.

**Not established — said rather than guessed:**

- **"A shared package invalidates every CI cache"** (§2.4b). Mechanically true by design; **no
  named team's reported incident found** across four trackers.
- **"Shared becomes a junk drawer"** (§2.1). **No large TypeScript monorepo maintainer's stated
  experience found.** Widely repeated; not evidenced.
- **Any prior art for generating a sandbox/permission spec from a build declaration** (§5.6). None
  found, and no declined feature request found either. *Not found* is not *does not exist*.
- **A settled name for the cross-family generated-path-config pattern** (§5.7).
- **Cross-layer cycle measurements beyond Outline.** One repository is one repository. The result is
  strong for Outline and is **not a general law**; a second measurement would materially change
  confidence and I do not have one.
- **`core/` as a top-level name** — zero instances, zero guidance, no verdict available.
- **Gazelle non-determinism in BUILD output** rests on one practitioner's first-hand report plus
  documented parallel traversal; **no reproducer**. Do not overstate it.
- **No vitest/jest test-glob generator or syncer found** — recorded as *no evidence found*, not
  *proven absent*.
- **No conference talk or public post-mortem** on shared-layer failure surfaced under any phrasing
  tried.

**Tool availability:** all tools worked. Kagi was useful for locating the SvelteKit, Nx, Go and
Pants primary documentation, and heavily SEO-contaminated for the monorepo-opinion questions —
first-page results included Instagram and AI-generated "best practices" pages — which is why this
report leans on repository inspection, the GitHub API and driven experiments. Pants' Slack archive
returned HTTP 429 and could not be read.

---

## 9. THE FOUR THINGS TO DO WITH THIS

Ordered by evidence strength behind them, not by effort.

1. **Make the frontend/backend boundary a compile error, not a convention** — `composite` +
   `rootDir` + `references` per side (§4.2, measured, mutation-verified). This is the rung-2 answer
   and the one nobody in the survey took.
2. **Split `shared/` by target runtime, not only by ownership** — `shared/common` (no DOM, no
   Node), `shared/browser`, `shared/node`, enforced by per-environment tsconfigs differing in `lib`
   and `types` (§2.6, VS Code). This also removes the doubled shared test run.
3. **Rename the per-side layers so no word appears at two levels** — root `shared/`, per-side
   `utils/` (§7.2, Outline). And keep `api/` free for the spec (§6).
4. **Do not package-split `shared/`** without a reason that outweighs both the cycle-fatality and
   version-skew evidence (§7.6).

And two things to *avoid*: a barrel `index.ts` over a source-consumed shared layer (§2.3), and any
cycle guard that counts `import type` edges (§7.8).

---

## 10. TWO RELAYED CLAIMS THAT DID NOT SURVIVE VERIFICATION

Recorded because the contract requires a checker to distinguish "this was wrong" from "this was
fixed", and because relayed research is exactly where a confident-and-wrong claim enters.

1. **"Agent sandboxes already derive their policies from tsconfig/gitignore."** Surfaced by a web
   search during delegated research and **refuted against primary documentation** before it reached
   this report. No such derivation exists (§5.6).
2. **moon #1527 described as an open bug.** It is **closed** (verified via API). The quoted
   diagnostic is accurate; the state was not.

One further correction of my own, already recorded in §0: my initial 194-module `app`+`shared`
cycle finding was an artefact of counting type-only imports and does not exist at runtime.

---

## 11. ONE WORKFLOW FINDING

**A research agent's dependency versions are part of its finding, and this report nearly shipped a
wrong one.** Every "what does tool X do by default" question in §3 has a *different answer* in
Vitest 3 than in Vitest 4, and the difference runs in the permissive direction — a stale build
artefact now runs; an uncovered file now vanishes from the report. Reading the docs gives one
answer; reading the docs of the version you happen to land on gives another.

The habit that caught it: **install both versions and run the identical fixture.** A differential
across versions costs one extra `npm install` and converts "the docs say" into "I watched it
happen, and here is the version where it stopped happening."

**Proposal: make this standard for any claim about a dependency's default behaviour, the same way
mutation-verification is standard for a guard.** A default is a claim about the world, and §8's
exemption rule applies to it unchanged — it carries the same evidence burden as a detection. The
same discipline caught the type-only-import artefact (§0) and the two relayed claims (§10): in all
three cases the finding was plausible, well-formed, and wrong, and only driving the path killed it.
