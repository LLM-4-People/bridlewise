---
layout: default
title: 'Addendum — THE BLOCK: one declaration, every projection'
---

# Addendum — THE BLOCK: one declaration, every projection

**Status:** decision document. Amends `DESIGN-SPEC-GRAVITY-WELL.md` §2 and §10.
**Location:** The design records that codebase comments cite — `DESIGN-SPEC-GRAVITY-WELL`,
`DESIGN-COCKPIT-V2`, `DESIGN-PERFORMANCE`, and this one — are tracked on the `testing`
branch (the floor), not at the root of `master`. A comment naming one cites the spec as an
authority; the file itself lives on the floor.
**Binding guideline:** "I want the entire harness to work the same, every api, every page, so we
can build on the easiest possible way, in modules/blocks."

---

## 0. The problem, measured

Per capability the codebase currently maintains **four parallel artifacts** by hand:

| Artifact | Where | Count today |
|---|---|---|
| Route registration | `server/routes/*.ts` (27 files) | **102** |
| Input validation | inline `zod` in the route | **121** usages |
| Client function | `src/client.ts` (2 458 lines) | **93** exports |
| UI consumer | a bespoke Svelte panel | ~20 panels |

102 routes vs 93 client functions do not correspond one-to-one — the drift the doctrine forbids
is already present. Adding a capability means editing four places and remembering all four.

`DESIGN-SPEC-GRAVITY-WELL.md` §2.2 unified the **consumption** half: `SourceBinding` declares
`endpoint`, `ttlMs`, `invalidateOn`, `page`, `priority`, and the Broker gives every module the
same cache/dedup/batch behaviour. But `endpoint: "/intelligence/graph"` is a **string pointing at
a hand-written route** — unvalidated, and free to point at nothing.

---

## 1. Decision

> **A Block is the single unit of capability. One declaration emits the route, its validation,
> its client binding, its schema entry, its UI module and its contract tests.**

There is no second way to add an API. There is no second way to add a page. `defineBlock` is the
choke point, and per the doctrine, if a capability can reach the wire by another path, that other
path is the defect.

## 2. The declaration

```ts
// server/blocks/code.graph.ts — the ONLY file a new capability needs
export const codeGraph = defineBlock({
  id: "code.graph",                       // namespaced module.name; the route derives from it

  read: {
    input:  z.object({ projectPath: ProjectPath }),
    output: GraphWire,                    // the wire contract, not a comment
    handler: (input, ctx) => getDependencyGraph(input.projectPath, ctx.gate),
    ttlMs: 60_000,
    invalidateOn: ["index:ready"],
    page: { limit: 500, cursorParam: "after" },   // optional; enables uniform pagination
  },

  actions: {                              // become POST /api/b/code.graph/invalidate
    invalidate: { input: z.object({ projectPath: ProjectPath }),
                  handler: (i, ctx) => invalidateProjectCache(i.projectPath, ctx.gate) },
  },

  signals: ["code.graph.nodes", "code.graph.cycles"],   // ids from the exposure registry
  customizations: ["code.nodeSpacing"],                  // ditto

  ui: { home: 2, view: "graph-canvas", relevance: { base: 0.4, emptyWhen: "data.nodes == 0" } },
});
```

## 3. What one declaration emits

| Projection | Mechanism | Replaces |
|---|---|---|
| **Route** | `GET /api/b/code.graph` auto-registered by `registry.ts` | a hand-written `router.get` |
| **Validation** | derived from `read.input`; rejects at the router choke point | inline per-route zod |
| **Ownership / auth / CSRF / rate limit** | already owned by `server/router.ts` — unchanged | — |
| **Client binding** | `read("code.graph", params)` typed from `read.output` | a new export in `client.ts` |
| **UI module** | `ModuleEntry` with `SourceBinding{ kind:"read", block:"code.graph" }` | a bespoke panel |
| **Schema entry** | merged into `/api/schema/ui` beside signals/actions/customizations | — |
| **Contract tests** | enumerated from the block registry | hand-written per route |

`SourceBinding.endpoint` (a free string) is **replaced by** `SourceBinding.block` (a block id).
A binding can no longer point at an endpoint that does not exist — enforced statically by a
prevention test, not by discipline.

## 4. The uniform envelope — why this buys "instant everywhere"

Every block read answers in one shape:

```ts
type BlockResponse<T> = { data: T; meta: { etag: string; asOf: number;
                                          cursor?: string; partial?: boolean } };
```

Because the shape is uniform, the Broker implements **once**, for all 102+ capabilities:
conditional requests (`If-None-Match`), response cache keyed by `(block, params)`, in-flight
dedup, superseded-request cancellation, `GET /api/batch` coalescing, cursor pagination,
prefetch-on-intent, and stale-while-revalidate.

Today none of that exists (`client.ts:211` — no cache, no dedup, no ETag); worse, adding it
per-endpoint across 93 functions is why it never got built. Uniformity is the thing that makes it
affordable **once**.

## 5. Choke points this establishes

1. **`defineBlock`** — the only way a capability enters the system.
2. **`server/router.ts`** — already the only place auth/CSRF/rate-limit/error-mapping happen.
3. **The envelope** — the only response shape, so the Broker is capability-agnostic.
4. **`src/lib/data/broker.ts`** — the only place the client performs I/O.

## 6. Generated tests (tests as a projection, not hand-written)

Enumerating the block registry yields, for free, per block:

- **input rejection** — malformed/missing/hostile params return 400, never 500;
- **output conformance** — the handler's return parses against `read.output`;
- **ownership** — a foreign `projectPath` is refused at the fs-gate;
- **envelope** — response carries `data` + `meta.etag` + `meta.asOf`;
- **binding resolution** — every `SourceBinding.block` resolves to a registered block;
- **no bypass** — no `router.get`/`router.post` outside generated registration or the legacy allowlist.

## 7. Migration — ratchet, not big bang

`defineBlock` coexists with the 102 legacy routes.

- A `LEGACY_ROUTES` allowlist starts at **95** (102 registrations minus 7 that stay hand-written: auth, health, static) and is **ratcheted down**; the prevention test fails
  if it grows. (Same pattern as the existing `integration-rule-refs-ratchet` test.)
- Every capability touched during Phases 1–5 converts as it is touched.
- `client.ts` shrinks as its 93 exports are replaced by `read(blockId, …)`; the file stops being
  a place anything is added.
- **New capabilities may only be added as blocks** — enforced from day one, so the problem stops
  growing immediately even while the backlog drains.

## 8. Scope

This applies to **both repos**. The harness (`harness-main-v1/integration`) already has the
registry half — `registerSignal` / `registerAction` / `registerCustomization` in
`src/shared/exposure/` — and blocks are its natural completion: the same declaration style
extended from *tunables and telemetry* to *capabilities*. `defineBlock` lives beside them and
reuses their metadata, so one module declares its data, its controls, its telemetry and its
surface together.

## 9. Targeted updates — only what changed, everywhere, by construction

**Binding guideline:** "ux must instantly do target update (things that changed only), the whole
app must be very efficient."

Today the app is the structural opposite. Verified:

- `src/state/chat-messages.ts:444` — every streamed token copies the **entire** message array
  (`slice(0,-1)` + push + `set`), invalidating every downstream subscriber.
- `src/state/chat-messages.ts:216` — `conversationSummary` is a `computed` over that array and
  re-derives **12 aggregates across all N messages on every token**.
- `src/lib/chat/MessageList.svelte:159` — `renderItems` rebuilds the complete render-item array
  (phantom filtering, minute grouping, tool coalescing) **per token**.
- `src/lib/chat/MessageList.svelte:191` — a tool group's key is derived from its members' ids, so
  each new parallel tool call **destroys and recreates the whole group**.
- `src/lib/dynamic-panel.svelte:38` — every tab switch destroys and remounts the panel tree.

So one token costs O(N) array work, O(N) aggregate work, O(N) render-item work, and a keyed-each
diff. Svelte 5's signals already update per-expression; the invalidation is being manufactured
*upstream, in the stores*. Fixing this per screen is why it has never been fixed.

> **Decision: targeted update is a property of the Block pipeline, not of any screen.**

**9.1 Deltas on the wire.** A stream channel emits patches in one envelope, so no capability
invents its own delta format:

```ts
type BlockPatch = Readonly<{ block: string; params?: string;
                             ops: readonly PatchOp[]; asOf: number }>;
type PatchOp = { op: "set"; path: string; value: unknown }
             | { op: "append"; path: string; value: unknown }   // token streaming
             | { op: "remove"; path: string };
```

**9.2 Entity atoms, not monolithic arrays.** Collections become `map`-of-atoms keyed by stable id.
Appending a token writes **one** atom; the subscriber set is the one text node bound to it. The
array store holds *ids only*, so list identity changes only when membership changes.

**9.3 Memoized projection.** `project()` is pure (§2.1), so the Broker memoizes it per
`(block, params, sourceVersions)` and re-projects **only** the sources whose version advanced. A
patch to one source cannot re-run the other four.

**9.4 Incremental aggregates.** Derived values fold the patch instead of rescanning:
`tokensTotal += delta`, not `messages.reduce(...)`. An aggregate that cannot be folded declares
itself `recomputeOn` an explicit coarse event rather than silently costing O(N) per tick.

**9.5 Stable identity.** Keys are entity ids, never derived from content or membership. Combined
with `VirtualList` (§10.4) and panel keep-alive, a changed row updates in place; nothing around it
unmounts.

**9.6 Mechanically enforced, not aspirational.** Per the doctrine, the guarantee gets a test
rather than a comment. `tests/performance/targeted-update.test.ts` drives real interactions with a
`MutationObserver` and asserts **complexity classes**:

| Interaction | Asserted bound |
|---|---|
| One streamed token | O(1) DOM mutations, independent of message count |
| One timeline event arriving | O(1), independent of the 24 642 in scope |
| One signal value changing | O(1); untouched modules record **zero** mutations |
| Tab / stage switch | outgoing module is **not** unmounted (keep-alive) |
| Brush selection change | only modules subscribed to that `SelKey` re-project |

The test runs each interaction at two data volumes and fails if mutation count **scales with
volume**. That converts "must be very efficient" from a wish into a gate, and it is the same shape
as the existing runtime-budget ratchet.

---

## 10. Server and frontend are the same construction

**Binding guideline:** "server and frontend must be built the same way with the same principles
in mind."

This is not an analogy imposed after the fact — the harness already thinks this way. It has a
projection DB (`timeline_projection`), `forensic-projection.ts`, `protocol-projections.ts`, and
config comments that say "one canonical source, two projections." The frontend simply never
adopted the vocabulary. Both sides reduce to the **same three-part shape**:

> **a declaration · a pure projection over a source of truth · one choke point for effects.**

### 10.1 The isomorphism

| Principle | Server | Frontend |
|---|---|---|
| Unit of capability | `defineBlock` — declaration + handler | `ModuleEntry` — declaration + `project()` |
| The pure part | `handler(input, ctx)` — no ambient state | `project(raw)` — no store capture, no DOM |
| Source of truth | event ledger / projection DB | Broker cache (fed by the same blocks) |
| Effect choke point | `server/router.ts` — auth, CSRF, rate limit, error mapping | `src/lib/data/broker.ts` — all I/O |
| Validation | `zod` at the router boundary | the **same** schemas from `contracts/` |
| Registration | `registry.ts`, one call | `modules/registry.ts`, one entry |
| Change propagation | emits `BlockPatch` | applies `BlockPatch` (§9) |
| Errors | typed errors thrown, router maps to HTTP | typed `ClientError`, `ErrorBoundary` maps to UI |
| Configuration | exposure customizations | the same registry, rendered |
| Tests | generated by enumerating the registry | generated by enumerating the registry |
| Concurrency | worker pool (`server/worker-pool.ts`) | projection worker (`src/lib/data/`) |

Both sides are therefore reviewable with one checklist, and a developer who has added a server
capability already knows how to add a page.

### 10.2 What this makes shared rather than duplicated

`contracts/` becomes the genuine seam and grows to hold what both sides need:

- **Wire + domain schemas** — one `zod` schema validates the request on the server *and* types the
  client binding. Not "kept in sync": the same object.
- **The envelope and patch types** (§4, §9.1) — one definition, both directions.
- **The error taxonomy** — one code set; server maps it to status codes, client maps it to
  messages. The current `server/errors.ts` (421 lines) and `src/lib/shared/error-messages.ts` are
  two vocabularies for one set of failures; they converge.
- **Pure domain logic** — anything that is a pure function over data (formatting, thresholds,
  classification, relevance) lives in `contracts/` or `shared/` and is imported by both, never
  reimplemented. This is the existing "no parallel implementations" rule applied across the wire.

### 10.3 The one legitimate asymmetry, stated honestly

The **trust boundary**. The server validates hostile input and enforces ownership at the fs-gate;
the client validates only to catch its own bugs. Client-side validation is a developer
convenience and **never** a security control — so `defineBlock` always validates server-side even
when the only caller is our own typed binding. Symmetry of *construction* must not be mistaken for
symmetry of *trust*.

### 10.4 Enforcement

- `tests/prevention/isomorphism-owner.test.ts` — every block declares both halves; no handler
  reaches ambient state; no `project()` imports a store or touches `document`.
- No domain logic duplicated across `server/` and `src/` — an extension of the existing
  `no-duplicate-code` guard, applied **across** the boundary rather than within each side.
- All I/O in `src/` originates in the Broker (single-owner assertion, same shape as
  `frontend-routing-owner` class A).

---

## 11. Enforcement matrix — every principle has a test that fails

**Binding guideline:** "we must enforce these principles as much as possible via mechanical tests."

A principle without a guard is a wish. The codebase already proves the pattern works — 130
prevention tests, all green — and the decisive property is that they use **dynamic discovery**
(`walk()` the tree, parse the registry) rather than hardcoded lists, so a newly added file or
capability is covered *automatically*. Every guard below obeys that rule. **A test that needs
editing when you add a module is itself a defect** — that is precisely the failure mode
`exposure-registry-counts` had, and why it blocked growth.

| # | Principle | Mechanical guard | Fails when |
|---|---|---|---|
| 1 | Modules/blocks are the only unit | `block-contract-owner` | a `router.get/post` exists outside generated registration or the shrinking `LEGACY_ROUTES` allowlist |
| 2 | Single source of truth | `exposure-registry-counts` *(repointed — shipped)* | any registry entry fails to reach `/api/schema/ui`, compared per-id against the **live** registry |
| 3 | Bindings cannot dangle | `block-contract-owner` (binding resolution) | a `SourceBinding.block` names a block that is not registered |
| 4 | Lowest choke point | one single-owner assertion per invariant: I/O only in `broker.ts`; history APIs only in `location.ts`; auth/CSRF/rate-limit only in `router.ts` | a second path to the same effect appears |
| 5 | Server ≡ frontend construction | `isomorphism-owner` | a handler reads ambient state, or a `project()` imports a store / touches `document` |
| 6 | No cross-boundary duplication | `no-duplicate-code`, extended across `server/` ↔ `src/` | domain logic is reimplemented instead of shared via `contracts/` |
| 7 | Targeted updates | `targeted-update` complexity test (§9.6) | DOM mutations for one change **scale with data volume** |
| 8 | Efficiency budgets | existing runtime-budget ratchet + §10.6 budgets | a measured metric regresses past budget |
| 9 | Configurables in one place | `centralized-config`, `no-hardcoded-values`, `css-tokens-owner` | a literal appears outside the config/token owner |
| 10 | Configurables reachable in the UX | coverage assertion: every customization resolves to a generated control | a tunable exists that no surface can reach |
| 11 | Deterministic core | import-graph assertion | anything under the deterministic boundary imports the LLM client |
| 12 | LLM work is replayable | record/replay equivalence test | replaying recorded model output changes the result |
| 13 | Codebase-agnostic | language-pack assertion | a module outside the pack layer switches on file extension or language name |
| 14 | Resilience | per-block failure-path generation | a block has no malformed-input or upstream-failure test |
| 15 | Tests are a projection | registry-enumeration harness | a registered capability has no generated contract test |

### 11.1 What cannot be mechanized — and what substitutes

Honesty matters more than coverage theatre. These are **not** mechanically decidable, and each
gets a named human gate instead of a fake assertion:

- **Whether the relevance engine feels intentional rather than arbitrary.** Substitute: the
  usability test already mandated before any further visual work (Phase 1), plus `sys.salience`
  making every score term inspectable, plus a freeze toggle. If it fails, the documented fallback
  is a manually ordered rail.
- **Whether the visual system is beautiful.** Substitute: contrast ratios, token coverage and the
  light-theme completeness check are mechanical; taste is reviewed.
- **Whether an exposed capability is *useful* to surface.** Coverage proves it is reachable, not
  that it earns its place. Substitute: the audit's value ratings drive tier placement, revisited
  per phase.

Claiming a test for these would be worse than admitting the gap.

---

## 12. Standing principles — and the guard for each

Several of these already have guards in the tree (`no-scattered-helpers`, `error-debug-owner`,
`centralized-config`, `no-hardcoded-values`, `no-hardcoded-config-values`,
`timeline-no-hardcoded-magic`). They are listed so the doctrine is complete in one place, with the
*missing* guards named as work.

| Principle | Guard | Status |
|---|---|---|
| Single source of truth | projection parity vs the **live** registry | shipped (§11.2) |
| Everything dynamically computed | no hardcoded list/count/threshold that a registry or the data can yield; tests use dynamic discovery | partly — `no-hardcoded-values` exists; extend to **test bodies** |
| Centralized, mandatory debug/error system | `error-debug-owner`; every failure path routes through the typed error taxonomy + debug bridge | exists — extend to blocks (generated failure-path tests, §6) |
| Fake / static / placeholder data prohibited | no fabricated data may reach a user-facing surface, ever, on any path | **guard missing — build it** |
| Single-Party-Owner | one owner per concern; single-owner assertions per invariant (§11.4) | exists, extend per block |
| Deny-by-default | validation and authorization refuse unless explicitly allowed, at the choke point | exists (`setRoute`, fs-gate, router) |
| No scattered helpers | `no-scattered-helpers`, extended **across** server↔client (§10.2) | exists, extend |
| Everything exposed | coverage: every signal, action, customization, task, event and **result** reaches a surface | partial — §3 covers signals/actions/customizations; tasks/events/results need block coverage |
| Quality over time/effort, balanced by maintainability | §12.2 — the machinery budget | new |

### 12.1 Fake data — a live violation, fixed, and the guard it needs

`server/llm-bridge.ts` **streamed fixture events to the user when LLM client creation failed.**
An earlier revision had already identified the exact harm — its own comment read "the user saw
fixture events + thought the LLM worked" — and responded by adding an operator warning *while
still fabricating*. Observability was fixed; the user was still reading invented text in the place
a model answer belongs.

Fixed: that path now yields a typed `error` event (`provider` / `llm_client_unavailable`) and
stops. Fixtures remain reachable only through the explicit `HARNESS_WEB_LLM_FIXTURES=1` opt-in,
never as a silent fallback.

> **Guard to build:** `no-fabricated-data.test.ts` — fixture/demo/sample builders may be imported
> only by `tests/**` or behind an explicitly named opt-in flag; **never** from a `catch` block, a
> fallback branch, or a default value on a user-facing path. Deny-by-default: a new fixture
> builder is out of bounds unless allowlisted with a reason.

This generalises beyond LLM output: an empty state must say "no data", never show plausible
zeros; a failed fetch must surface the failure, never render a skeleton forever.

### 12.2 The machinery budget — this principle constrains *this spec*

> "Quality wins over time and effort — but balanced against maintainability (prefer simple
> built-in mechanisms over custom machinery)."

Taken seriously, this is a constraint on what I have proposed, so here is the honest audit. Custom
machinery must **retire more complexity than it adds**, or be cut.

| Proposed | Verdict |
|---|---|
| **Block contract** | **Keep.** It is custom, but it retires 102 bespoke route registrations, 121 inline validations and 93 client functions. Net large reduction, and it is the thing that makes everything else affordable once. |
| **URL routing via History API** | **Keep — it is a simplification.** The *current* localStorage routing is the custom mechanism; moving to the platform's History API removes machinery rather than adding it. |
| **Projection in a Worker** | **Keep.** `Worker` is a built-in; the custom part is a thin message shim. |
| **`VirtualList`** | **Defer.** The codebase already uses the built-in `content-visibility: auto` + `contain-intrinsic-size`, which is strictly less machinery. Build `VirtualList` only where the §9.6 complexity test *proves* the built-in misses budget — not preemptively at "seven call sites". |
| **Canvas glyph atlas** (Phase 3) | **Defer behind evidence.** It carries an accessibility cost that needs a DOM mirror — machinery to compensate for machinery. Ship DOM glyphs first; adopt canvas only if measurement demands it. |
| **Patch ops** (§9.1) | **Keep, minimal.** Three ops, not a JSON Patch implementation. |
| **Multiplexed SSE** | **Keep.** SSE is built-in; multiplexing is a small layer justified by browser connection limits. |
| **Relevance engine** | **Keep, but it is the one genuine bet.** Highest-risk idea in the spec; already gated on a usability test before further visual work, with a documented fallback to a manually ordered rail. The module contract survives either outcome. |

The rule going forward: **propose the built-in first; custom machinery must name what it retires.**

---

## 13. Recording cannot be omitted

**Binding guideline:** "we must ensure things cannot NOT be recorded, for as many things as
possible. We don't want to have to remember to code them or pass them into a function. The
recording is part of that. Single-Party-Owner."

### 13.1 The evidence that manual recording fails

Recording today is ~10 hand-written `recorder.recordX({...})` calls, essentially all inside
`server/routes/run.ts`. The ledger holds exactly **six** event types — `run`, `memory`, `message`,
`turn`, `token`, `error` — which is exactly the set someone remembered to write a call for.

Everything without a call is invisible: tool calls (`tool-executor.ts`), file edits
(`transactional-editor.ts`), git operations (`git-ops-bridge.ts`), agent lifecycle, auto-checks,
config changes. Not disabled — simply never emitted.

The same cause explains the field gaps: `outcome` is null on 87% of events because setting it is a
property of the *call*, and `trace_id` is 0% and `parent_event_id` 60% because a caller has to
thread them through by hand.

> **The defect is not the missing calls. It is that recording is a call at all.**

### 13.2 Decision — record at the choke point, with ambient context

Three layers, each using a mechanism this codebase already accepts:

**(a) Ambient context — `AsyncLocalStorage`.** Already used in the harness
(`src/runtime/admitted-node-runtime.ts`, `src/filesystem/durable-filesystem-internal.ts`), so this
extends an accepted pattern rather than introducing one. A single `RecordingContext`
(`actor{kind,id,role}`, `runId`, `sessionId`, `turnId`, `traceId`, current `spanId`) is entered
**once** at the session/request boundary and propagates across every `await` automatically.

Nothing is threaded through a signature. No handler takes a `ctx` it must remember to forward.
This is the direct answer to "we don't want to have to pass it into a function."

**(b) The choke points record — not the call sites.** Every effectful path in the system already
passes through exactly one place. Each of those wraps, so the work *cannot* happen unrecorded:

| Choke point | Records automatically |
|---|---|
| `server/router.ts` | every request: actor from session, outcome from status, duration |
| `defineBlock` wrapper (§2) | every capability invocation: inputs digest, outcome, duration, typed error |
| `tool-executor.ts` | every tool call + its result — closes the always-empty "Tool call" lane |
| `transactional-editor.ts` | every file effect |
| `llm-bridge.ts` `streamChat` | every model call, finish reason, usage |
| `git-ops-bridge.ts` | every git operation |

Because the wrapper observes whether the function **returned or threw**, `outcome` is set for free
— fixing the 87%-null problem without touching a single handler. Because spans nest on the
`AsyncLocalStorage` stack, `parent_event_id` and `trace_id` are derived from *structure* rather
than from a caller's diligence — fixing 60% and 0% by construction.

**(c) Single-Party-Owner, inverted into a prohibition.** `recordEvent` and friends become
**private to the recording owner**. A route, bridge or handler may not call them.

> You cannot record manually, and you cannot avoid being recorded.

That is the whole principle in one sentence, and it is mechanically checkable.

### 13.3 Guards

- **No manual recording** — `recordEvent`/`recordTurn`/`recordMessage`/`recordRun` appear only
  inside the recording owner. Any other call site fails. (Same shape as `frontend-routing-owner`
  class A: `currentRoute.set` exists in exactly one file.)
- **No unrecorded effect** — every module performing an effect (filesystem, process, network, git,
  LLM, DB write) is reachable only through a wrapped choke point. Discovered dynamically from the
  import graph, so a *new* effectful module is covered without anyone updating a list.
- **Context is never absent** — an effect executing with no `RecordingContext` throws in dev and
  records with `actor.kind: "unattributed"` in production, so the gap is visible in the ledger
  itself rather than silently dropping the event.
- **Actor is never a constant** — the ledger must contain more than one distinct `actor_kind`
  across a real session. This is the specific regression that produced "harness" for all 24,816
  events; a guard that only checked *presence* would have passed.

### 13.4 What this does not cover

Automatic recording captures *that* something happened, by whom, when, and how it ended. It cannot
infer **domain meaning** — that an edit was a refactor rather than a fix, or that a tool call was
speculative. Those are declared on the Block (§2), not called imperatively, so they remain
declarations rather than remembered calls.

---

## 14. Reuse first — the primitive budget

**Binding guideline:** "re-use, adapt, edit shared, if they fit our requirements."

The order is: **reuse → adapt the shared owner → compose → only then create.** Editing a shared
primitive is the *correct* move, not a last resort: `src/lib/shared/` is the single owner, so a
missing capability is a gap in the owner, never a reason to fork a sibling.

`DESIGN-SPEC-GRAVITY-WELL.md` §11 Phase 0 listed eleven "new" primitives. Audited against what
exists, most are not new:

| Spec listed | Decision | Why |
|---|---|---|
| `ActionButton` | **Reuse `Button`** | already carries `variant/size/icon/loading/disabled/pressed/block`; a registry action maps straight onto those props |
| `FacetCard` | **Adapt `Card`** | `Card` has `raised/pad/class`; add the header/affordance slot **to `Card`** so all 20 consumers gain it |
| `ModuleChip` (t1) | **Reuse `Badge`** + the global `.header-chip` primitive already in `tokens.css` | the chip vocabulary exists and is already shared |
| `SignalMark` | **Dispatch table, not a renderer** | `charts/{Sparkline,Gauge,Donut,BarChart}` + `MetricTile` already exist; `SignalMark` maps *signal type → existing component* |
| `SignalBoard` | **Compose `Panel` + grid** | layout, not a primitive |
| `ModuleGlyph` (t0) | **Try `Badge` at min size first** | create only if measurement shows it cannot carry t0 |
| `VirtualList` | **Deferred** (§12.2) | built-in `content-visibility` first; build only where the complexity test proves it insufficient |
| `ControlField` | **Create — and it deletes more than it adds** | no generic field exists; it absorbs the ad-hoc inputs inlined across `SettingsPanel` (980 lines) |
| `RecordTable` | **Create** | nothing equivalent exists |
| `RecordInspector` | **Create by composition** | `Collapsible` + `Card` + `Modal` |
| `Module.svelte` (host) | **Create** | the tier host; genuinely new |

**Eleven proposed → four created, three of those by composition or with a net deletion.**

### 14.1 Why editing shared is safe here

The codebase already has the safety net that makes "edit the shared owner" the low-risk option:
`shared-primitive-prop-contract.test.ts` (128 tests) and
`shared-primitive-bindable-contract.test.ts` pin every primitive's public surface, so a change
that breaks one of ~20 consumers fails immediately. Forking a near-duplicate is the *riskier*
path — it escapes those contracts entirely.

### 14.2 Guard

`ui-primitives-owner` already denies a panel defining its own `Button`/`Card`. Extend it:

- a **new** file in `src/lib/shared/` must not be a near-duplicate of an existing primitive
  (name/role overlap check), and
- any new primitive is introduced together with the consumers that justify it — a primitive with
  fewer than two consumers, or one that duplicates an existing role, fails.

This applies across the wire too (§10.2): a helper needed by both sides goes to `contracts/` or
`shared/` and is imported, never reimplemented per side.

---

## 15. Phase placement

Phase 0 gains: `contracts/block-contract.ts`, `server/blocks/define.ts`, generated registration in
`server/routes/registry.ts`, `read()` in the Broker, the generated-test harness, and the
`LEGACY_ROUTES` ratchet. The two Phase 1 pilot modules (`code.graph`, `checks.auto`) convert to
blocks, which proves both halves — a hard capability and a trivial one — before anything else
migrates.
