---
layout: default
title: 'PERFORMANCE-DIAGNOSIS — three filed items, measured'
---

# PERFORMANCE-DIAGNOSIS — three filed items, measured

Read-only diagnosis. Nothing outside this file was written in either repository.

**Headline:**

| item | verdict |
|---|---|
| **A** — dev API server pinned near 90% CPU, `/api/health` ~20 s | **NOT PROVEN.** Measured **0.00 % CPU** and **1.4 ms** health. The class was closed by work already recorded as done. One synchronous door survives and is named. |
| **B** — Switch mounts every reel, 3,000 rows blocks 3.7 s | **PROVEN, and the trigger was wrong in the filing.** The 3,000-row mount is the **type-to-filter** path, not the default view: **258 reels mounted unfiltered → 3,000 after one keystroke** at the same data. The CI budget that should catch it has **926× headroom** and can never fail. |
| **C** — artifact follow-ups re-send the whole document | **PROVEN, and worse than filed.** Measured **15,408 tokens re-sent per turn** for a real-sized artifact. **The fix already exists in this codebase, measured at 95.1 % savings, and has ZERO consumers** — 0 hits across 989 scanned files. |

---

## Provenance (§8b — a live-defect claim records what it rests on)

| fact | value |
|---|---|
| web repo | `/home/example/code-harness-workspaces/web-interface-foundation-v1` |
| web HEAD, unchanged across the whole session | `0c3b8547c64586a911025d5531b450c69c98c348` |
| web `git status --porcelain` at **01:57Z** | **empty** |
| web `git status --porcelain` at **03:0xZ** | **5 modified**, all under `server/db/` (see below) |
| harness HEAD at session start → at close | `8d69f92` → **`3c1d943`** (moved under me) |
| integration submodule HEAD | **`6a3ef77`** *"Put the compile cache on a real filesystem instead of a fixed-inode tmpfs"* — landed **during** this session |

**The writing agent landed while I was reading.** At close, the web tree carries
` M server/db/async-client.ts`, ` M server/db/client.ts`, ` M server/db/method-kinds.ts`,
` M server/db/migrations.ts`, ` M server/db/schema.ts`.

- **None of my load-bearing claims rests on those files.** The one place I quote from them —
  `server/db/client.ts:563` (an unref'd WAL checkpoint interval, cited only to say it is
  *not* spinning) — was read at ~02:0xZ **while the tree was clean at `0c3b854`**, and
  `client.ts` has since been modified. That citation is a snapshot, not a live claim; nothing
  else depends on it. **If a checker finds that line moved, the answer is "this was changed
  after I read it", not "the analyst misread it".**
- Files the brief placed off limits, snapshotted at 01:57Z so a later diff can tell *was
  wrong* from *was fixed*. **No claim here rests on any of them, and I read none of them:**

| file | mtime at 01:57Z | size |
|---|---|---|
| `server/routes/run.ts` | 2026-07-28 08:52:16.858432755 −0400 | 87,766 |
| `server/sse.ts` | 2026-07-27 11:23:51.808242259 −0400 | 19,382 |
| `src/client.ts` | 2026-07-27 16:07:43.423563956 −0400 | 131,737 |

**Ambient conditions.** All item-A live numbers were taken **while an `npm test` was running
in `harness-main-v1/integration`** — 1-minute load average **9.12 → 13.00** on **12 cores**.
That is stated because it makes item A's negative result *stronger*: the server was measured
under contention and still showed nothing. The item-B and item-C benches were run after that
suite exited, at load **0.48**.

**Session interruption, disclosed.** Between ~02:03Z and ~02:5xZ the tmpfs holding `/tmp`
returned `ENOSPC` on every create and the shell was unusable — every command failed *before*
executing, because the harness stages command output under `/tmp`. The cause is now proven
and is **ADJ-1**. Work continued read-only through that window; all benches were re-run
after it cleared.

---

# ITEM A — *"Dev API server pinned near 90% CPU; `/api/health` takes ~20s"*

## Verdict: **NOT PROVEN.** Measured on two independent servers, one of them 28.8 hours old.

### A.1 The measurement

**Server 1 — the dev server that was already running.** PID `131665`,
`node --experimental-strip-types server/index.ts`, uptime **1-04:47:37 = 103,657 s**.

- **Lifetime CPU**, from `/proc/131665/stat`: `utime=70457`, `stime=3322` → **73,779 ticks
  @ `CLK_TCK=100` = 737.79 s of CPU over 103,657 s of wall clock = 0.712 % of one core,
  averaged over its entire life.**
- **Instantaneous CPU**, one sampled window of **10,005 ms**: **0 ticks → 0.00 %.**
  Vite (PID `131686`) in the same window: **0 ticks → 0.00 %.**
- **`/api/health` latency**, n = **20**, sequential, loopback:

  | n | mean | max | min | HTTP | load avg during |
  |---|---|---|---|---|---|
  | 20 | **1.4 ms** | **2.5 ms** | 1.0 ms | 20 × 200 | **11.85** on 12 cores |

  **Liveness asserted before the cost was judged** (§8): every response carried the real body
  `{"status":"ok","harnessReady":false}` — this measures a served request, not a refusal, a
  connection error, or a 403 from the loopback guard.

**Server 2 — a fresh throwaway** I started on port 5199 with `cwd` inside the scratchpad, so
its databases landed outside both repositories: boots clean; first health **6.0 ms / 200**;
**20,004 ms idle window → 0 ticks → 0.00 %**; **16 OS threads** (a read pool + writer +
workers, consistent with the async facade being live rather than half-converted).

> **~20,000 ms was claimed. 1.4 ms was measured, n=20, under load average 11.85.**
> **~90 % CPU was claimed. 0.712 % lifetime and 0.00 % instantaneous were measured.**

**Why the lifetime average is the strongest number here.** A 10-second sample invites
*"you sampled a quiet moment"*. **0.712 % across 28.8 hours cannot be answered that way** —
a process that had ever been pinned would carry it in the cumulative counter. For a filed
claim about a *standing* condition, `/proc/<pid>/stat` refutes or confirms in one read, with
no reproduction step at all.

### A.2 `/api/health` cannot be slow by itself

`server/routes/health.ts:11-13` — the entire handler is
`sendJson(ctx.res, { status: "ok", harnessReady: false })`. No I/O, no DB, no await, and it
is public (`server/routes/registry.ts:88-97`) so it does not even pay the auth gate.
**A slow `/api/health` can therefore only ever be head-of-line blocking.** That is the only
mechanism worth hunting.

### A.3 Nothing is spinning

Counted from **bytes** (`readFileSync` + match in process — §8b.7, never `grep`), over
**114 `.ts` files** under `server/` and **362 `.ts`/`.svelte` files** under `src/`:

- `setInterval` in `server/`: **3 sites, all bounded.** `server/db/client.ts:563` (WAL
  PASSIVE checkpoint, `.unref()`ed at `:575`); `server/routes/live.ts:107` (SSE beat at
  `sseKeepaliveMs` = 15,000 ms, cleared on `close` at `:118`); `server/sse.ts:349` (keepalive —
  **not depended on**, writing agent's file).
- `fs.watch` / `watchFile` in `server/`: **0 sites.**
- Client pollers: **16 `setInterval` sites**, every one either a display ticker or gated.
  `src/cockpit/rooms/instruments-feed.ts:166` fires only while the feed has refs
  (`SIGNALS_POLL_MS = 5000`, `instruments-config.ts:21`); `src/App.svelte:392` polls metrics
  **only** on `route === "metrics"`; `src/lib/timeline/TimelineTab.svelte:84` only on a chat
  scope; `src/lib/intelligence/IntelligencePanel.svelte:417` only while indexing.

**No poller, no watcher, no spin loop.** The brief's hypothesis list is exhausted with a
negative.

### A.4 The one synchronous door that survives — and the arithmetic that fits "~20 s"

The scan found exactly **one** `spawnSync` in `server/`, and it is not dead code:

- **`server/landlock-runner.ts:1010`** — inside `spawnPlannedSync`, whose own comment at
  `:990-996` states why it exists: *"`git` is read synchronously all over the project
  listing, and rewriting every one of those call sites to be asynchronous would be a much
  larger change than the one being made."*
- Its **only production caller**, from a tree-wide search by basename over `server/`,
  `tests/`, `scripts/`, `bench/` (§8b.1 — never scoped to a path I expected): **4 hits
  total** — 1 definition, 1 import, 1 comment, **1 call at `server/git-bridge.ts:219`**.
- Reached from **`server/routes/git-ops.ts:28, 36, 52, 61, 71`** — five routes
  (`/api/git/branches`, `/log`, `/diff`, `/diff-patch`, `/status`). Every handler is
  `async` and every one calls its bridge **without `await`**, e.g. `git-ops.ts:75`
  `const status = getGitStatus(projectPath, gate);`. **The `async` keyword buys nothing** —
  the subprocess is spawned synchronously inside it, so the whole event loop stops for the
  duration of the git child.
- The per-spawn ceiling is `serverConfig.gitTimeoutMs`, passed at `git-bridge.ts:222`.
  **`DEFAULT_GIT_TIMEOUT_MS = 10_000`** — `server/config.ts:171`.

**Two timed-out git reads back to back = 20,000 ms of dead event loop**, during which a
microsecond route cannot be answered at all. `DESIGN-PERFORMANCE.md` §6 item 7 records that
the custody read is now *"2 spawns instead of ~24"*. **2 × 10 s is exactly the filed number.**

That is **SUSPECTED, not proven.** I could not manufacture a git invocation slow enough to
reach the cap, and an arithmetic coincidence is not a measurement. What **is** proven: the
synchronous door exists, five live routes go through it, and its cap is 10 s.

**Nothing else synchronous sits on a request path.** `readFileSync` (5), `statSync` (17),
`readdirSync` (4), `writeFileSync` (5) are boot-time, worker-thread or filesystem-route work;
`DatabaseSync` appears only under `server/db/` (15 sites) — never on the main thread, which
is the interlock `DESIGN-PERFORMANCE.md` §6 item 10 says had to hold.

### A.5 Why the entry was probably true when filed, and is not now

`DESIGN-PERFORMANCE.md` §5d measured the pre-facade server: `/api/health` during **one**
75.6 MB history read served **15 requests in 3.18 s**, p95 **2,957 ms**. The async facade
(item 10) and the history cursor (item 5) removed both halves. The same table's after-column
reads p95 **5 ms**; I measured **2.5 ms max** today, on a day-old server, under load 11.85.
**The class this entry describes was closed by work already recorded as done, and the entry
was never re-measured against it.**

### A.6 §0 LADDER VERDICT — class: *a request path blocks the event loop*

> **Rung reached: 4**, and only partially — one door exists, but it has a synchronous shape.
>
> **Rung 1 (physically impossible):** unavailable because Node runs one JavaScript thread per
> isolate, and no OS facility can forbid a thread from making a blocking syscall it is
> entitled to make. The kernel cannot distinguish `spawnSync` from any other `wait4`.
>
> **Rung 2 (unrepresentable):** **AVAILABLE, and unclaimed.** Delete `spawnPlannedSync`
> (`landlock-runner.ts:997-1011`) and give `prepareConfinedSpawn` only an asynchronous shape.
> `GitRead` then cannot be produced outside a `Promise`, and *"a route handler that forgot to
> await git"* stops being a thing that can be typed. The comment at `:990-996` declines this
> rung because converting the call sites is *"a much larger change"* — which §0 names
> explicitly as an **estimate, and estimates belong in a task, not in a dismissal.** The
> call-site count is small and now known: **five route handlers, and one bridge closure.**
>
> **Rung 3 (unreachable by shape):** available — make the five handlers take an
> `AsyncGitReader` they cannot construct themselves. Strictly weaker than rung 2 at the same
> cost, because rung 2 is reachable here.
>
> **Rung 4 (runtime choke point):** **already built and working.** `landlock-runner.ts` is
> the single door — the scan finding exactly one `spawnSync` in 114 files **is** the choke
> point doing its job, and it refuses correctly (ADJ-2 is the proof). Its only defect is that
> the door offers a synchronous shape beside the asynchronous one.
>
> **Rung 5 (source scan):** what a *"no `spawnSync` in routes"* lint would give. Not needed —
> rung 2 is available, and a scan would carry the usual universe problem.

### A.7 The fix

Delete the synchronous door.

1. Remove `spawnPlannedSync` (`server/landlock-runner.ts:997-1011`). The async sibling
   `spawnPlanned` (`:985-988`) already exists and already carries
   `assertNoInheritedDescriptors`.
2. Convert `git-bridge.ts`'s `run()` closure (the call is at `:219`) to await the async
   spawn, collecting stdout/stderr from the streams. The guardian-outcome classification at
   `:230-236` is unchanged — it reads `status` and `stderr`, which the async form provides.
3. Make the five handlers in `server/routes/git-ops.ts` (`:28,36,52,61,71`) `await` their
   bridge calls. They are already `async`; this adds the keyword that should have been there.
4. Move `release()` into a `finally` while you are in the file — **ADJ-3** is a real leak on
   the throw path, and it feeds ADJ-1.

### A.8 The guard, and **the population it bounds** (§20b)

The right guard half-exists: `DESIGN-PERFORMANCE.md` §5 gates on **event-loop availability**,
and §5c explains why that number is the sharpest in the table (it has no physical floor,
unlike the growth ratio). **Its population today is the database path.** Extend the
population, and *name it*:

> **Population:** every route in the live route table, enumerated **at runtime from
> `server/routes/registry.ts`'s own registration** — never a hand-written list — with the
> count asserted `>=` the registry's length, so a route that stops registering fails the
> guard instead of silently leaving the population.
>
> **Assertion:** with a 5 ms timer armed, drive each route once; availability must stay above
> §5's floor (>80 % of expected firings) **per route, not in aggregate** — an aggregate hides
> one 20-second route behind sixty fast ones.
>
> **Liveness precondition (§8):** assert each route *answered* first. A non-2xx, a 403 from
> the loopback check, or a refusal (**ADJ-2!**) makes the availability figure a measurement of
> nothing. Two benchmarks in this project have already reversed sign for exactly this reason.
>
> **Re-derivation trigger:** if `git-ops.ts` is deleted or its routes move, the threshold
> governs a set it never measured. **Deleting a route file must fail the guard until the
> population line is restated.**

---

# ITEM B — *"Switch mounts every reel: 3,000 rows blocks the main thread for 3.7s"*

## Verdict: **PROVEN — and the filing names the wrong trigger.** The 3,000-row mount is the **type-to-filter** path. I measured the mounted-row counts and the whole per-keystroke derive; I did **not** re-measure the 3,749 ms mount itself.

### B.1 The measurement — mounted rows, and the derive that precedes them

Driven over the **real** `src/cockpit/rooms/switch-data.ts` module (the room's own pure
helpers), n = **9 iterations per row count**, p50 reported, load average **0.48**, node
v24.18.0, 12 cores. Fixture: ~35 conversations per project, varied titles (never a repeated
character — repetition flatters a string scan). **Liveness asserted every iteration**:
`countReels(caps) !== N` throws, `mountedFiltered === 0` throws *"measuring a refusal"*, and
the index size is checked against the flattened length. A run that filtered nothing would
have aborted rather than reported a fast time.

| chats | projects | **mounted, unfiltered** | **mounted, after ONE keystroke** | build ms p50 | filter ms p50 | flatten+Map ms p50 | **keystroke total ms p50** |
|---|---|---|---|---|---|---|---|
| 100 | 3 | 9 | **100** | 0.064 | 0.006 | 0.012 | **0.019** |
| 250 | 7 | 21 | **250** | 0.099 | 0.005 | 0.011 | **0.015** |
| 500 | 14 | 42 | **500** | 0.194 | 0.010 | 0.043 | **0.054** |
| 1,000 | 29 | 87 | **1,000** | 0.322 | 0.016 | 0.041 | **0.057** |
| 2,000 | 57 | 168 | **2,000** | 0.708 | 0.037 | 0.181 | **0.216** |
| **3,000** | **86** | **258** | **3,000** | 1.093 | 0.071 | 0.330 | **0.408** |
| 6,000 | 171 | 501 | **6,000** | 1.833 | 0.153 | 0.791 | **0.903** |
| 12,000 | 343 | 1,029 | **12,000** | 3.561 | 0.292 | 1.371 | **1.749** |

**Three findings fall straight out of that table.**

1. **The trigger is the filter, not the room.** At 3,000 conversations the unfiltered river
   mounts **258** reels. One keystroke mounts **3,000** — an **11.6× jump on identical
   data**. The tracker's 3,749 ms is attached to 3,000 rows, and **this is the only path
   that produces 3,000 rows.** The filing reads as though opening the Switch mounts
   everything; it does not. **Typing one character does.**
2. **The pure derive is fast and stays fast — linear, and never perceptible.** The entire
   per-keystroke derive at 3,000 rows is **0.408 ms**, and at 12,000 rows **1.749 ms**.
   Growth is linear (roughly ×2 per doubling above N=500). **It never crosses 100 ms at any
   size this product will see.**
3. **Therefore the 3.7 s is entirely the mount.** Filter + flatten + index account for
   **0.408 ms of it — 0.011 %.** Everything else is component instantiation and DOM
   construction.

### B.2 The mechanism, `file:line`

The room renders reels with **no windowing whatsoever**:

- `src/cockpit/rooms/SwitchRoom.svelte:657` — `{#each filtered as cap (cap.project.id)}`
- `src/cockpit/rooms/SwitchRoom.svelte:694-706` — `{#each cap.visible as reel (reel.chat.id)}`
  → `<ReelCell … />`

So mounted reels = `Σ cap.visible.length`. **Three paths set `visible`, and they do not agree
about how large it may get:**

| path | `visible` | bound | `file:line` |
|---|---|---|---|
| unfiltered, collapsed | `reels.slice(0, 3)` | **3 per cap** (`REELS_PER_CAP`) | `switch-data.ts:29,134` |
| unfiltered, expanded (`n more`) | **all** reels of that cap | unbounded | `switch-data.ts:133-134`; toggled at `SwitchRoom.svelte:442-447` |
| **filtering** | **every match, `expanded: true`, `moreCount: 0`** | **unbounded, across every cap at once** | **`switch-data.ts:169`** |

**`switch-data.ts:169` is the defect:**

```ts
out.push({ ...cap, visible: reelMatches, moreCount: 0, expanded: true });
```

and its own comment at `:155-157` explains *why*: *"a cap with matching reels shows ALL of
them (every match visible — a filter that hides its own hits behind 'n more' would be lying
about results)."* **That reasoning is correct and the implementation is still wrong**, because
*"show every match"* was translated into *"mount every match"*. Honest results and 3,000
mounted DOM subtrees are not the same requirement — the first is a product law, the second is
an implementation choice that was never separated from it.

**And it is always one keystroke away**: `SwitchRoom.svelte:545-552` routes *any* printable
key pressed anywhere in the room into the filter.

**Where the rest of the time goes.** `Reel.svelte` renders ~10 elements per cell —
consistent with §4's measured **30,133 nodes ÷ 3,000 = 10.04**. Per keystroke the room also
runs an `$effect` (`SwitchRoom.svelte:210-219`) that calls `requestReelData(id)` **once per
flat reel** plus `requestCustody` per project. `TASKS.md:2821-2823` says that fan-out is
*"already bounded at the queue level"* — **bounding it at the queue bounds the network, not
the N function calls on the main thread**, which is a different cost in a different place.

**One suspected super-linear term, stated as suspected.** `SwitchRoom.svelte:699-701` reads
`$outcomeStates[…]`, `$densityStates[…]` and `$custodyChatCounts[…]` **inside** the `{#each}`
— the *parent* subscribes to three whole maps and passes members down as props. Those stores
fill one conversation at a time. If a write replaces the map identity, every reel's props
re-evaluate per arriving datum: **N re-evaluations × N arrivals.** **SUSPECTED** — it needs
one browser run to settle, and it should be settled *before* the windowing fix is designed,
because if it is real then windowing fixes the mount and leaves a quadratic fill behind it.

### B.3 The guard that should catch this cannot ever fail — the sharpest finding in item B

`tests/cockpit/switch-perf.test.ts` is the CI-enforced budget. From its own source:

- `:5` — *"type-to-filter across **500 reels** < 50 ms (Linear's budget, law)"*
- `:32-33` — the fixture: *"100 projects × 5 conversations = **500 reels**"*
- `:26-27` — `FILTER_BUDGET_MS = 50`, `BUILD_BUDGET_MS = 200`
- `:96-105` — it **is** mutation-tested: a deliberately slowed filter blows the budget, so
  the stopwatch can fail. That part is done properly.

**Its population is 500 reels of a pure function. Measured against my table, at 500 reels the
derive is 0.054 ms — 926× inside its own 50 ms budget. At 12,000 reels it is 1.749 ms, still
28× inside.** The budget has so much headroom that **no realistic growth can ever make it
fire**, while the surface it is named after blocks for 3,749 ms.

`switch-data.ts:19-21` states the design intent that produced this:

> *"Pure module: no DOM, no Svelte, no fetch, no `Date.now()` … so every function is
> deterministic and **the <50 ms filter budget (§5.2, CI-enforced) is measurable in
> isolation**."*

**The purity that makes the helper testable is the same property that puts the cost outside
the test.** This is §21 — *a correct region is not a correct answer* — and §20b: **the budget
names a population (a pure function at 500 rows) that excludes the defect it was written to
prevent, while its NAME ("type-to-filter") implies the surface.** Green forever, 3.7 s in the
product, and both true.

### B.4 Does the #86 redesign fix it, or does it survive?

**It SURVIVES.** `TASKS.md:2796-2823` decides: `+` beside the project name; **`+` opens the
EXISTING ⌘J recency river** (`:2801-2803`, marked *"already decided, do not re-litigate"*);
instant stateful switching with keep-alive; new project from an existing directory; widen
`GESTURE_PATHS`; cached-then-revalidate on revisit.

**Every one of those keeps `SwitchRoom.svelte` and its `{#each cap.visible}`.** The redesign
explicitly *reuses* the river rather than replacing it, so nothing in the decided list
touches the mount. The one sentence that does — `:2818-2820`, *"carries the every-reel-mounted
defect: rebuilding the room is the moment to stop mounting every reel"* — is a **scheduling**
statement, not a design change. The defect is parked inside #86, not solved by it.

**Recommendation: fix it as part of #86 — not before, not after.** Not before, because the
room's rendering is about to be touched and windowing it twice is the duplicated work §2
forbids. Not after, because #86 will otherwise ship a rebuilt room with the same defect and
the checkbox will close over it.

### B.5 §0 LADDER VERDICT — class: *a list mounts an unbounded number of rows in one synchronous update*

> **Rung reached: 5/6 — and the level-5 guard that exists measures the wrong population, so
> in practice nothing enforces this at all.**
>
> **Rung 1 (physically impossible):** unavailable because the DOM offers no mechanism that
> refuses N element constructions. `content-visibility` was tried and is the proof: §4 records
> that it *"hid the mount cost"* — it defers **paint**, and there is no browser primitive for
> *"refuse to construct"*.
>
> **Rung 2 (unrepresentable):** **AVAILABLE, and it is the right rung.** Make
> `ProjectCap.visible` a type that cannot hold an unbounded array — a `Window<Reel>` produced
> **only** by the windowing owner, with no constructor from a raw `Reel[]`. Then
> `switch-data.ts:169`'s `visible: reelMatches` is a **compile error**, and so is every future
> path that tries the same thing. `reels: readonly Reel[]` stays as it is — `countReels`
> (`switch-data.ts:223`) and the *"n more"* arithmetic both need the true count, and the
> filter must still **find** every match while **mounting** only a window. This is a small
> type change in a pure module with no DOM dependency: **the cheapest rung-2 in this report.**
>
> **Rung 3 (unreachable by shape):** available — `{#each}` over a source only the window
> owner can produce. Implied by rung 2 once `visible` is narrowed.
>
> **Rung 4 (runtime choke point):** available — one assertion in the room refusing to render
> past the window. Weaker: it fires in the browser, at the user, after the fact.
>
> **Rung 5 (source scan):** a scan for `{#each}` without a window. The rung this project keeps
> landing on and the one §3 calls the FLOOR — and here it would be worse than usual, because
> the universe is *"every `{#each}` in 362 client files"*.
>
> **Rung 6 (documentation):** what `Reel.svelte:22-23` has today — a comment saying a
> hand-rolled `IntersectionObserver` is forbidden here. Correct, and not enforcement.

### B.6 The fix

**Do not write a virtualizer. One already exists, and I found it.**

`tests/prevention/virtualization-owner.test.ts:21` names it:

> **`src/lib/shared/virtual-visibility.ts` is the SINGLE owner of lazy-render gating**
> (IntersectionObserver + sticky in-view keys), exposing **`createVisibilityGate`**.

That test's own header records why it exists — MessageList and ProjectList each had an inline
copy of the observer dance and **both carried the same defect** (the observer rooted at the
viewport while the list is clipped by an `overflow-y: auto` container, making `rootMargin`
inert). Its scan is **dynamic**: it walks `src/` and catches any new hand-rolled observer
without being edited. The Flow additionally has a full measured virtualizer (`HeightIndex`
Fenwick tree, `tests/cockpit/flow-heights.test.ts`, `flow-perf.test.ts`) — the maths for
*"lightweight for the browser"* is already solved twice in this repo.

So the fix is to **extend the existing path, never add a second one** (§2, §16):

1. Route the river's reel rendering through `createVisibilityGate`
   (`src/lib/shared/virtual-visibility.ts`). `Reel.svelte:22-23` already forbids the
   alternative; this is the affordance that comment points at.
2. Narrow `ProjectCap.visible` to the windowed type (rung 2), so `switch-data.ts:169` cannot
   re-introduce the unbounded projection.
3. Move the per-reel data request out of the N-iteration `$effect`
   (`SwitchRoom.svelte:210-219`) so it fires for reels that are actually windowed in.
4. Settle the suspected super-linear term at `:699-701` **first** (B.2). If real, hoist the
   three store reads into `ReelCell` so each cell subscribes to its own datum instead of the
   parent subscribing to three whole maps.

### B.7 The guard, and **the population it bounds** (§20b)

`DESIGN-PERFORMANCE.md` §5's row *"mount of N list rows — no long task > frame budget"*
exists and is knowingly red (its after-column reads *"unchanged, item 9"*). It needs a stated
population and a liveness precondition:

> **Population:** the number of reels the Switch mounts in **one synchronous update** —
> `Σ cap.visible.length` over the **filtered** river — read **from the DOM at runtime**, never
> from a constant in the test, at the **`heavy`** fixture (3,001 chats,
> `DESIGN-PERFORMANCE.md:175`).
>
> **Scenario, and this is the part the current guard is missing:** open the Switch, **then
> type one character that matches a majority of titles.** My table is the evidence for why:
> opening alone exercises the bounded 3-per-cap path (**258 rows**) and would pass forever;
> the keystroke is what produces **3,000**.
>
> **Liveness precondition (§8):** assert the mounted-reel count is **> 0 and equal to the
> number of matches the filter reports.** Without it, a windowing implementation that renders
> nothing, an empty fixture, and a filter that matched zero rows **all pass the budget while
> measuring a refusal** — and here that failure is especially seductive, because the honest
> windowed answer and the broken empty answer both produce *no long task*.
>
> **Re-derivation trigger:** the budget names `heavy`'s chat count and `REELS_PER_CAP`.
> Changing either must fail the guard until the number is restated.
>
> **And repair the existing budget's population.** `tests/cockpit/switch-perf.test.ts` must
> either rename itself to say it bounds **`filterRiver` in isolation at 500 rows and nothing
> downstream**, or gain a sibling that bounds the surface. Measured headroom: **926× at its
> own fixture size, 28× at 12,000 rows.** A budget that cannot fail is not a budget; it is a
> green light with a number printed on it.

---

# ITEM C — *"Artifact follow-ups are unaffordable: the full document is re-sent every turn"*

## Verdict: **PROVEN, measured — and materially worse than filed, because the fix already exists in this codebase and is connected to nothing.**

### C.1 It is **RE-SENT**, not re-referenced. Proven from source.

The single owner of what reaches the model is `server/context-bridge.ts`, and it materialises
a **fresh `ChatMessage[]` from scratch on every turn**:

- `context-bridge.ts:445-453` — `buildLLMInput(...)`, described at `:429-443` as *"the ONE
  entry point for LLM-input assembly"*, calls:
- `context-bridge.ts:260` — `buildTrimmedHistory(cm)`, which at `:320-350` walks
  `state.turns` and emits **every surviving turn verbatim**:
  - `:333` — `content: redactContent(turn.content)` — the tool result's full text;
  - **`:340-343`** — `tool_calls` re-emitted with
    `arguments: redactToolCallArguments(tc.function.arguments)` — **the full argument string,
    every turn.**

**There is no content hash, no reference, no id-substitution and no retention anywhere on this
path.** The array is rebuilt from the manager's turn list each time and handed to `streamChat`.

### C.2 The measured cost

Driven for real with the product's **own** estimator
(`integration/src/memory/unified/tokenizer.ts`) and its **own** tool-result store. Fixture:
a **55,096-byte** HTML artifact — the size `server/artifact-check.ts:9` records from twelve
artifacts driven end-to-end through a real model (*"the largest and most ambitious (a
**55,096-byte Tetris**)"*), built from varied markup rather than a repeated character.

**Liveness asserted before any cost was believed** (§8): `estimateTokens("hello world")`
returned **3** at the top of the run, and the store call throws if it returns `null`
(*"result judged small, fixture wrong"*) — so a refusal cannot be reported as a saving.

| quantity | measured |
|---|---|
| artifact body | **55,096 bytes** |
| as a `create_artifact` tool-call `arguments` JSON string | **61,632 bytes** |
| `estimateTokens(body)` | **13,774** (**4.00 bytes/token**) |
| **`estimateTokens(arguments)` — the per-turn re-send cost** | **15,408 tokens** |
| the existing store's summary for the same payload | **55 tokens** |
| the store's own reported `tokensSaved` | **15,353 → 99.64 %** |

**Cumulative over a follow-up sequence** (the same arguments re-emitted per turn):

| turns | **re-sent today** | with a reference |
|---|---|---|
| 1 | 15,408 | 55 |
| 3 | 46,224 | 165 |
| 5 | 77,040 | 275 |
| **10** | **154,080** | **550** |
| 20 | 308,160 | 1,100 |

**And at the ceiling the product allows** — `TASKS.md:1106` puts artifact `content` at up to
**512 KB** — 524,288 bytes ÷ 4.00 = **~131,072 tokens per turn, for one artifact, before the
conversation.** That single number exceeds the usable window of most models outright.

**The scaling law:** linear in document bytes, multiplied by the number of turns the document
survives the trim window, additive per artifact. A **revision** does not replace the original —
it is a *new* tool call, so a document edited three times can cost three documents per turn.

**The second-order harm is worse than the first.** Trimming (`context-bridge.ts:188-200` →
the unified manager) evicts by **total** tokens. One large artifact does not merely cost
tokens — it **evicts the rest of the conversation** to stay inside the limit, because nothing
in the trim policy distinguishes *one enormous immutable blob* from *a hundred turns of
dialogue*. The user experiences that as the model forgetting everything immediately after
making something, which reads as a model defect and is a context-assembly defect.

### C.3 **THE FIX ALREADY EXISTS, IS MEASURED AT 95.1 %, AND HAS ZERO CONSUMERS**

This is the finding that changes what should be done.

**`integration/src/memory/unified/unified-tool-result-store.ts`** — from its own header:

> *"Tool-result store (from **EXP433, 95.1 % token savings**). Stores tool results in memory
> (with deterministic summaries in context + on-demand semantic retrieval). **The LLM gets a
> ~100-token summary in context instead of the ~1000-token full result, and can `retrieve(id)`
> the full result (or chunks of it) when needed.**"*

That is, precisely and completely, the fix. It is built, exported
(`memory/unified/index.ts:27`), and its config is already wired into the unified config
(`unified-config.ts:16` imports `DEFAULT_TOOL_RESULT_CONFIG`). **I drove it and it produced a
55-token summary from the 61,632-byte artifact — 99.64 % saving**, better than its advertised
95.1 %, because an artifact is far larger than the average tool result.

**Nothing calls it.** A tree-wide search by basename and by symbol over **989 files**
(`web-interface-foundation-v1/server`, `web-interface-foundation-v1/src`,
`harness-main-v1/integration/src`) returned **28 hits, and every one of them is the module
itself, its `index.ts` re-export, its config import, the architecture manifest, or a
sibling implementation.** **Zero hits anywhere under `web-interface-foundation-v1/`.**

**And the socket it should plug into is declared and unused.**
`integration/src/memory/unified/unified-context-manager.ts:247-252`:

```ts
export function createUnifiedContextManager(
  config: UnifiedConfig,
  _memoryStore?: UnifiedMemoryStore,     // ← underscore-prefixed: declared, never referenced
  summarizer = DEFAULT_SUMMARIZER,
  topicRedactor: TopicRedactor = IDENTITY_REDACTOR,
): UnifiedContextManager {
```

A search for `toolResult` / `ToolResult` inside the context manager returns **zero hits.**
`context-bridge.ts:199` passes `undefined` for that parameter — which is honest, since the
parameter does nothing anyway.

> **So the single owner of what reaches the LLM has no tool-result integration at all, while a
> measured 95.1 %-saving tool-result store sits three imports away, exported and configured.**
> That is §19's *"correct and unplugged"* — a capability that exists and nothing calls —
> **and it is costing 15,408 tokens per turn per artifact.**

**There is also a §2 duplicate-path violation sitting beside it.** `integration/src/memory/`
holds **two** implementations of this concept: `memory/unified/unified-tool-result-store.ts`
(`ToolResultConfig`, `createToolResultStore`) and `memory/tool-result-store.ts`
(`ToolResultStoreConfig`, its own `createToolResultStore`, plus
`memory/tool-result-exposure.ts`). Two owners for one question, neither reachable from the
product. **Whichever is wired, the other must be collapsed, not left beside it** — that is the
exact shape §2 names.

### C.4 The cost that is not tokens

`context-bridge.ts:342` calls `redactToolCallArguments(...)` **on every turn, for every tool
call**. Per `context-bridge.ts:80-81` that helper *"parses + re-stringifies tool_calls JSON"*,
and `DESIGN-PERFORMANCE.md` §5e establishes the redaction walk runs **six regex automata over
every string leaf**.

So each turn, on the main thread, a 512 KB artifact is `JSON.parse`d, scanned by six automata,
rebuilt, and `JSON.stringify`d — **and then the whole array is redacted a second time at the
LLM-bridge choke point**, which `context-bridge.ts:328-332` states and defends as deliberate
(*"the second pass is not redundant"*). The second pass is correct on privacy grounds and it
**doubles this CPU cost**.

`TASKS.md:2681` already flags *"`redactToolCallArguments` parses + re-stringifies JSON on
every tool_call (INEFFICIENCY) — could cache or batch."* **The entry understates it by a
multiplier**: it is once per tool call **per turn per redaction pass**, over a payload bounded
only by 512 KB. And *"cache or batch"* aims at the wrong thing — caching an immutable
document's redaction is right, but the document is still being **sent**, which is the larger
cost by far (**ADJ-4**).

### C.5 What the product already knows and does not act on

`context-bridge.ts:517-535` — `estimateHistoryTokens(history)` sums `estimateTokens(content)`
**plus** `estimateTokens(tc.function.arguments)` for every tool call, and `:507-515` says why:
the manager's internal count under-reports what is actually sent, so this computes the
truthful figure for the `context` SSE event.

**The product measures this exact cost, per turn, surfaces it to the UI — and nothing refuses
on it.** §21 in its purest form: computed, reported, gated on by nothing. The number is
already there; the door that says no is not.

### C.6 What the fix costs — three options, priced

| option | what it changes | cost | verdict |
|---|---|---|---|
| **1. Wire the store that exists** | `create_artifact`'s result and arguments go through `createToolResultStore().add(...)`; the turn carries the **55-token summary + id**; the model gets a `retrieve` tool for the full text | **wiring, not building**: give `createUnifiedContextManager` a real store parameter instead of the unused `_memoryStore`; forward the tool-result config in `getResolvedUnifiedConfig` (`context-bridge.ts:164-174` currently forwards only 4 of the available fields); expose `retrieve` as a tool; **collapse the duplicate implementation**; tell the model in the system prompt | **DO THIS.** Measured **99.64 %** on a real artifact size. The only honest extra cost is that the model must be *told* — a silent substitution would be a new "correct and unplugged". |
| **2. Diff** | send only what changed between revisions | needs a base the model does not have and cannot reconstruct; models rewrite whole documents rather than emitting patches; fails outright on the first artifact, which has no base | **Wrong shape. Do not build it.** |
| **3. Provider-side prompt caching** | keep the prefix warm at the provider | small — a marker at the provider boundary | **Insufficient alone.** Even where it reduces cost, a cached prefix **still occupies the context window**, so it does nothing for C.2's eviction harm. **UNVERIFIED against current provider documentation** — §8b, and I did not check. |

**Ship order:** the rung-4 assertion (C.7) first — one line, stops the bleeding immediately —
then option 1.

### C.7 §0 LADDER VERDICT — class: *the same immutable payload is re-serialised into every request*

> **Rung reached: none for this invariant.** A token trim exists and it bounds the **wrong
> quantity**.
>
> **Rung 1 (physically impossible):** unavailable because the provider protocol is stateless
> request/response over HTTP. No engine or OS mechanism can make a byte range un-sendable; the
> process is entitled to write whatever it likes to a socket.
>
> **Rung 2 (unrepresentable):** **AVAILABLE, and it is the right rung.** Make
> `tool_calls[].function.arguments` a `ContentRef` — `{ sha256, bytes, inline?: BoundedString }`
> where `BoundedString` has no public constructor above a declared ceiling. Then **"put a
> 512 KB document in a turn" is a type error**, at every call site, forever, including ones
> nobody has written yet. The declaration lives in one place (`ChatMessage`), which is what
> makes it affordable — and the store that produces the referenced side already exists (C.3).
>
> **Rung 3 (unreachable by shape):** available — `buildTrimmedHistory` returns only what a
> `HistoryBudget` witness permits, so a caller cannot obtain a history it has not budgeted.
>
> **Rung 4 (runtime choke point):** **available today, cheaply, and it is what to ship first.**
> `buildLLMInput` (`context-bridge.ts:445`) is already the single door and
> `estimateHistoryTokens` (`:523`) already computes the number. One assertion refusing a
> per-message ceiling closes the acute failure in an afternoon.
>
> **Rung 5 (source scan):** useless — the payload is data, not source. Nothing to scan.
>
> **Why this reads as "no rung reached" rather than "rung 4".** The unified manager trims on
> **total** tokens. A single artifact that is individually enormous never trips a per-message
> rule — there is not one — and instead **succeeds in evicting everything else.** A budget on
> the sum cannot express *"no single element may dominate"*, and that is exactly the failure
> mode here. **Measured:** one turn of one artifact is **15,408 tokens**; ten turns is
> **154,080**. Nothing on this path refuses either.

### C.8 The guard, and **the population it bounds** (§20b)

> **Population:** every message in the `ChatMessage[]` returned by `buildTrimmedHistory` for a
> conversation containing **at least one `create_artifact` tool call**, counted at runtime.
> **The count must be asserted `>= 1`** — a fixture whose artifact turn was trimmed away
> contains no artifact message, and the guard would pass while measuring nothing.
>
> **Three assertions, all required:**
> 1. **no single message exceeds the per-message ceiling** — the invariant itself;
> 2. **liveness (§8):** the artifact turn **is present** in the derived history and the history
>    is non-empty. Without it the guard passes on an empty answer — the *"10× while measuring a
>    refusal"* failure §8 records;
> 3. **the INERT mutation (§8's mandatory third):** leave the call site intact and discard its
>    result — compute the reference, then emit the body anyway. The guard must red on
>    **evidence only the new path can produce** (the `sha256`/`id` field's presence and its
>    agreement with the stored body), and **never on ordering or on total token count**, both
>    of which the old path reproduces by accident.
>
> **Re-derivation trigger:** the ceiling derives from `contextTokenLimit` / `recentTurnWindow`
> (`context-bridge.ts:164-174`). If either config value changes, the ceiling must be re-stated
> or the guard fails — a per-message ceiling that no longer relates to the window it protects
> is the §20b defect exactly.
>
> **Second guard, cheap and independent:** assert `estimateHistoryTokens` is **read by a
> refusal path**, not only by the SSE event. Today it is computed and gated on by nothing
> (C.5); a one-line assertion that the value reaches a decision closes a §21 hole.
>
> **Third guard, and it is the one that would have caught C.3:** assert the tool-result store
> has **at least one production consumer**, counted dynamically from the module graph. A
> capability with zero callers is §19's failure and nothing mechanical says so today. **The
> architecture manifest already records dependency edges** (§8b.3) and can answer this
> question without a new scanner.

---

# ADJACENT FINDINGS

## ADJ-1 — **PROVEN**: `/tmp` was exhausted by **INODES**, not bytes, by **Node's own compile cache** — and it took this session's shell down. *(Already fixed, concurrently, by another agent — my numbers corroborate theirs independently.)*

**Measured at the moment the shell came back:**

| fact | value |
|---|---|
| `df -i /tmp` | **1,036,369 / 1,048,576 inodes = 99 %** |
| `df -h /tmp` | **11 G / 36 G = 31 %** |
| `/proc/mounts:29` | `tmpfs /tmp … size=37051932k, **nr_inodes=1048576**` |
| `/proc/meminfo:21` during the outage | `Shmem: 11,466,912 kB`, **stable**, with `MemFree` 44 GiB |

> **99 % of inodes and 31 % of bytes. Bytes were never the bound.**

**And the consumer, measured with `du -x --inodes`:**

| path | inodes | share |
|---|---|---|
| `/tmp` (total) | 1,036,353 | 100 % |
| **`/tmp/node-compile-cache`** | **1,020,671** | **98.5 % of /tmp — 97.3 % of the entire inode table** |
| `/tmp/nw-repos` | 5,619 | 0.5 % |
| everything else | < 2,200 each | — |

After that directory was removed: **15,686 inodes (2 %) and 708 MB.** One directory was
holding **~1.02 M inodes and ~10.3 GB of RAM** (this tmpfs is RAM-backed).

**The owner, and the fix — which landed while I was blind.**
`harness-main-v1/integration/scripts/compile-cache.ts` calls `enableCompileCache()` from
`node:module` and propagates `NODE_COMPILE_CACHE` to every child process. Called with no
argument, **Node chooses `$TMPDIR/node-compile-cache`** — the fixed-inode tmpfs — and the
cache is **unbounded with nothing pruning it**, so it grows with every distinct module version
compiled by every run, worker and subprocess.

**A concurrent agent diagnosed and fixed this during my outage**, committed in the integration
submodule as **`6a3ef77` — *"Put the compile cache on a real filesystem instead of a
fixed-inode tmpfs"*** (source mtime 2026-07-28 22:17 local ≈ 02:17Z, ~14 minutes after my
shell died). The fix pins the cache to
`integration/node_modules/.cache/v8-compile-cache` — the repository's own filesystem, already
ignored, discarded by a reinstall, *"which is the correct lifetime for a derived artifact"*.
Their comment records **1,020,671 entries / 10 GB / 97.3 %** — **byte-for-byte the numbers I
measured independently, from a different instrument, without seeing their work.** Two
instruments agreeing is evidence; I am recording the agreement rather than re-claiming the
finding.

**What is still open, and it is the part that bit me:** the fix redirects **future** cache
writes. **It does not remove the stale 10 GB / 1.02 M-entry directory**, which stayed on disk
and kept the tmpfs exhausted for ~50 minutes *after* the fix landed. A cleanup finally ran
(my shell returned mid-session), but nothing in the repository performs it. **A redirect
without a sweep leaves the failure live on every machine that already has the old directory.**

**Why this matters beyond one session.** `/tmp` here is RAM-backed and shared with the agent
harness, which stages **every command's stdout** through a file under it. When it fills:
execution, verification, and the ability to free the space **all fail together**, and a
subagent cannot help because its output lands in the same place. That is a bootstrap deadlock,
and it converts a background housekeeping bug into a total loss of tooling.

**The guard, with its population:** both suites assert, via `statfs` on `os.tmpdir()`, the
**free-inode count (`f_ffree`) before and after the run**, and fail on a net decrease.

> **Population:** *entries under `os.tmpdir()` created by this run*, obtained from the
> **filesystem** (`f_ffree` delta) — **never from a directory listing or a name pattern**
> (§21b: a pattern-selected inventory silently excludes whatever it does not match, and the
> leaking names are exactly the ones nobody predicted).
>
> **And the threshold must be inodes, not bytes.** Any guard phrased in gigabytes cannot fire
> here: the filesystem was at **31 % of bytes** when it started refusing writes. A byte
> threshold on this population is §20b's defect with a physical bound attached — it keeps its
> authority and loses its meaning.

**Could my own probes have contributed?** I ran ~13 confined spawns, each of which
`mkdtemp`s and releases. **Thirteen directories cannot exhaust 1,048,576 inodes**, and
`node-compile-cache` alone accounts for 98.5 % of the total. I am not claiming a zero
contribution; I am claiming the arithmetic rules my probes out as the cause.

## ADJ-2 — **HIGH, LIVE, measured**: `/api/git/*` renders a **refused** read as an **empty result** — fabricated absence on a live route

**Measured**, on a fresh server, against a path the confinement gate correctly refuses:

| request | HTTP | time | body |
|---|---|---|---|
| `GET /api/git/status?path=…/harness-main-v1` | **200** | 33.7 ms | `{"branch":null,"head":null,"dirtyFiles":0,"stagedFiles":0,"untrackedFiles":0,"entries":[]}` |
| `GET /api/git/log?path=…&max=50` | **200** | 5.6 ms | `{"count":0,"log":[]}` |
| `GET /api/git/branches?path=…` | **200** | 3.9 ms | `{"count":0,"branches":[]}` |

**git never ran.** Driven directly through the confinement owner, the plan is:

```
kind    = refused
message = "This folder holds the harness's own program code, so commands cannot be run
           against it — the sandbox is not allowed to give anything write access to the
           code that enforces the sandbox. Choose a different project folder."
```

**The refusal is correct — deny-by-default working as designed. The reporting is not.**
`harness-main-v1` had uncommitted changes at that moment, and the route answered **HTTP 200,
`dirtyFiles: 0`, a clean tree.** That is `DESIGN-PERFORMANCE.md` §1 **L3** — *"Absence is
stated, never rendered as emptiness"* — violated on a live route, and it is the same class as
the `beats: 0` failure L3 was written for. Arguably worse: a fabricated *"you have no
uncommitted work"* is a claim a user acts on before committing or switching branches.

**The reason is captured and then discarded.** `git-bridge.ts:214-216` writes
`lastGitFailureDetail = "git was not run: " + plan.message` and returns
`{ kind: "not_run", reason: plan.message }` — **a typed refusal carrying a plain-language
message already written for a user** — and `routes/git-ops.ts:28-77` maps every outcome onto a
bare collection with no channel for it. The words exist; the route throws them away.

**Fix:** the git routes must distinguish `not_run` from *ran, found nothing*. `not_run` is not
a 200 with an empty array — it is the guided state §5b describes: say what could not be
reached, in the words the bridge already produced, and offer the way out (*"choose a different
project folder"*). **Guard:** drive a route against a path the gate refuses and assert the
response carries the refusal reason — with a liveness precondition asserting the plan really
was `refused`, so the guard cannot pass against a repo that merely has no commits.

## ADJ-3 — **MEDIUM, source-proven shape**: the confinement temp directory leaks on the throw path — and it leaks hardest when `/tmp` is already full

`server/git-bridge.ts` allocates and releases across a `try` with **no `finally`**:

```
:206  const plan = prepareConfinedSpawn({...});      // mkdtemp — allocates
:219  const result = spawnPlannedSync(plan, {...});  // can throw
:227  if (plan.kind === "confined") plan.release();  // only reached on the happy path
```

If `spawnPlannedSync` throws — `assertNoInheritedDescriptors` rejecting, `EAGAIN`, `ENOENT`,
or **`ENOSPC` on a full tmpfs** — `release()` never runs. **That is a positive feedback loop
with ADJ-1:** the fuller `/tmp` gets, the more likely the spawn throws, and every throw leaks
another entry. **I did not observe it fire** — the shape is proven from source, the execution
is not. **Fix:** `try { … } finally { if (plan.kind === "confined") plan.release(); }`. One
line, and it is the discipline §8 already demands of mutation harnesses (*"snapshot and
restore … in a `finally`, before asserting"*) applied to a resource instead of a fixture.

## ADJ-4 — **MEDIUM**: `TASKS.md:2681` understates its own finding by a multiplier, and aims at the wrong half

Recorded as *"`redactToolCallArguments` parses + re-stringifies JSON on every tool_call
(INEFFICIENCY) — could cache or batch."* Per C.4 the real cost is **per tool call × per turn ×
per redaction pass**, over a payload bounded only by the 512 KB artifact ceiling. And the
remedy is aimed at the smaller half: caching the redaction of an immutable document is right,
but the document is still being **sent** — 15,408 tokens per turn, measured. The entry should
be restated against the class.

## ADJ-5 — **MEDIUM, §2**: two tool-result-store implementations, neither reachable

`integration/src/memory/unified/unified-tool-result-store.ts` (`ToolResultConfig`,
`createToolResultStore`) and `integration/src/memory/tool-result-store.ts`
(`ToolResultStoreConfig`, its own `createToolResultStore`, plus `tool-result-exposure.ts`) are
two implementations of one concept with two vocabularies and two configs. **Neither has a
consumer in the web UI** (0 hits in 989 files). Wiring one (C.6 option 1) must **collapse** the
other, not leave it beside — *"if you conclude a second path is genuinely required, stop and
justify it"* (§2). It is not required here.

---

# COVERAGE

## What I measured (live, with n, method, and liveness)

- **Live dev API server, PID 131665** (uptime 103,657 s): lifetime CPU from `/proc/<pid>/stat`
  (73,779 ticks @ 100 Hz → **0.712 %**); instantaneous CPU over a **10,005 ms** window
  (**0 ticks, 0.00 %**); Vite PID 131686 in the same window (**0 ticks**).
- **`/api/health` latency, n = 20**, sequential loopback `curl -w %{time_total}`: mean
  **1.4 ms**, max **2.5 ms**, min 1.0 ms, **20 × HTTP 200 with the real body** — liveness
  before cost.
- **A fresh throwaway server** on port 5199 with `cwd` in scratchpad: boot; first health
  **6.0 ms / 200**; **20,004 ms idle → 0 ticks → 0.00 %**; **16 OS threads**.
- **Ambient load recorded with every sample**: 9.12 / 11.85 / 13.00 during item A (a
  concurrent integration suite), **0.48** for items B and C. 12 cores throughout.
- **Item B derive bench**, over the real `switch-data.ts`: **8 row counts × 9 iterations**,
  p50 reported, with **three liveness assertions per iteration** (`countReels === N`,
  `mountedFiltered > 0`, index size = flat length) that throw rather than report a fast time.
- **Item C token bench**, over the real `tokenizer.ts` and the real
  `unified-tool-result-store.ts`: `estimateTokens("hello world") = 3` asserted first; the
  store call throws on `null`.
- **`/api/git/{status,log,branches}`** against a refused path: 3 requests, bodies quoted
  verbatim, 3.9–33.7 ms; and the confinement decision driven directly for 4 roots (1
  `refused` with its message, 3 `confined`).
- **`/tmp` exhaustion**: `df -i` / `df -h` at exhaustion and after recovery,
  `du -x --inodes -d 2`, `/proc/mounts:29`, `/proc/meminfo:21` twice, `/proc/loadavg` before
  and after the concurrent suite exited.

## Counting method

Every count came from **bytes** — `readFileSync(f,"utf8")` and matching in process
(§8b.7), never from `grep`. Populations: **114** `.ts` files under `server/`, **362**
`.ts`/`.svelte` under `src/`, **989** files for the tool-result-store consumer search
(web `server/` + web `src/` + `integration/src/`). Searches for absence were run **tree-wide
by basename**, never scoped to a path I expected (§8b.1) — the `spawnPlannedSync` search
returned 4 hits (1 definition, 1 import, 1 comment, **1 call**), and the tool-result-store
search returned 28 hits, **all inside the memory module or the manifest**.

## What I read

`server/index.ts`, `routes/health.ts`, `routes/registry.ts`, `routes/git-ops.ts`,
`routes/auth.ts`, `routes/projects.ts`, `git-bridge.ts`, `landlock-runner.ts`, `config.ts`,
`db/client.ts:555-580`, `routes/live.ts:95-125`, `context-bridge.ts` (whole),
`artifact-check.ts:1-70`, `src/cockpit/rooms/SwitchRoom.svelte` (whole),
`src/cockpit/rooms/switch-data.ts` (whole), `src/cockpit/rooms/Reel.svelte` (whole),
`tests/cockpit/switch-perf.test.ts`, `tests/prevention/virtualization-owner.test.ts`,
`integration/scripts/compile-cache.ts`, `integration/src/memory/unified/`
(`unified-tool-result-store.ts`, `unified-context-manager.ts:247-272`, `content-store.ts`),
`DESIGN-PERFORMANCE.md` (whole), `TIER1-AGENT-CONTRACT.md` (whole), `TASKS.md` (open queue).

## What I did **NOT** establish — read this before acting

1. **Item A's ~20 s was not reproduced.** The `2 × 10 s` arithmetic (A.4) is a **hypothesis
   that fits**, not a measurement. I could not manufacture a git call slow enough to reach the
   cap.
2. **Item A's ~90 % CPU was not reproduced, and I could not account for it.** A blocked
   `spawnSync` costs the **child's** CPU, not node's — so the synchronous-git mechanism
   explains the latency but **not a node process at 90 %.** If the original observer read an
   aggregate or the Vite process rather than the API server, that reconciles it —
   **unverified**.
3. **Item B's 3,749 ms mount was NOT re-measured by me.** That figure, and the 30,133 DOM
   nodes, are `DESIGN-PERFORMANCE.md:201-204`'s. What I measured is the **input** to the mount
   (258 vs 3,000 rows) and the **derive** that precedes it (0.408 ms at 3,000). The mount's own
   growth curve — linear or worse — is **unmeasured**. Anchoring on the tracker's figure gives
   ~1.25 ms/reel, which would put the 100 ms threshold near **~80 mounted reels** (≈ 930
   conversations unfiltered, or **any filter matching ~80 rows**) — that is **arithmetic on
   somebody else's number, not a measurement**, and it is the first thing the fixing agent
   should replace.
4. **The suspected super-linear term at `SwitchRoom.svelte:699-701` is SUSPECTED**, from
   reading how the parent subscribes to three whole maps. One browser run settles it.
5. **My item-B bench runs the real module in node, not the room in a browser.** It measures
   the derive honestly and says nothing about component instantiation, layout or paint.
6. **Item C's `bytes/token = 4.00` is the product's own estimator**, not a real tokenizer.
   Every token figure in C.2 is *"what the harness believes it is sending"*. That is the right
   number for the harness's own budgets and the wrong one for a provider invoice.
7. **The provider-caching claim in C.6 option 3 is UNVERIFIED** — I did not consult provider
   documentation (§8b), it is marked unverified in the table, and nothing depends on it.
8. **I never ran either test suite** (instructed not to), and **never ran a compiler at all** —
   so §23's `noEmit` constraint was satisfied vacuously and nothing could have been emitted
   anywhere.
9. **I did not read the three files the brief placed off limits**, and no claim rests on them.

## §23 disclosure — working-tree state, and cleanup

Compilers: **none run** (no `tsc`, no `svelte-check`), so no emit was possible.

`git status --porcelain`, run in every repository touched:

- **`web-interface-foundation-v1`** — HEAD `0c3b854` throughout. **Empty at 01:57Z.** At close:
  `M server/db/async-client.ts`, `M server/db/client.ts`, `M server/db/method-kinds.ts`,
  `M server/db/migrations.ts`, `M server/db/schema.ts` — **all the concurrent writing agent's;
  I wrote nothing here.**
- **`harness-main-v1`** — HEAD moved `8d69f92` → `3c1d943` under me. At close: `M integration`
  (submodule pointer), `?? PERFORMANCE-DIAGNOSIS.md` (**this file, mine**), `?? S7-CHECK.md`
  (not mine).
- **`harness-main-v1/integration`** — HEAD `6a3ef77`, **clean**.

**Everything I created lived under the session scratchpad on `/tmp`, never under `/home`.
The only file this session writes below `/home` is this report.** I ran no `git` write, no
install, and no test run.

**Cleanup, completed:** the throwaway server (PID `3309007`, port 5199) was **killed and
confirmed gone** (`kill` → `CONFIRMED-GONE`, no listener on 5199), and its scratchpad
directory including its `.bridlewise/` databases was removed. Nothing of mine is left
running or on disk outside this file.

## Workflow improvement (§20)

**A read-only diagnostic agent lost its shell for ~50 minutes mid-measurement — not because
of anything it did, but because a background cache shared an inode table with the tooling that
stages every command.** Four changes, in order of value:

1. **Give agents a scratch directory on `ext4` (`/home`), not on the RAM-backed `/tmp`.** The
   current arrangement couples *"a cache grew"* to *"no agent can run any command"*. That is a
   far larger blast radius than the cause deserves, and it is a configuration line.
2. **A redirect is not a sweep.** ADJ-1's fix (`6a3ef77`) correctly moves future writes and
   leaves the existing 10 GB / 1.02 M-entry directory in place — which is what actually took my
   shell down, **after** the fix had landed. Any change that relocates a derived artifact
   should remove the old location, or the failure stays live on every machine that already has
   it. *General form: **moving where something is written does not unwrite what was written.***
3. **State the resources a measurement depends on, the way we already state the fixture.**
   Every figure in `DESIGN-PERFORMANCE.md` carries a machine line (cores, node version,
   ext4-not-tmpfs). None carries **free inodes / free space** — and this session proved that is
   a precondition for taking any measurement at all. A benchmark that cannot write its output
   file does not produce a bad number; it produces **no** number, and the difference should be
   visible in the report rather than only in the transcript.
4. **When a filed claim is about a *standing* condition, read the cumulative counter first.**
   The single most decisive number in this report cost one `Read`: **0.712 % CPU over 28.8
   hours**, from `/proc/<pid>/stat`. A sampled window invites *"you sampled a quiet moment"*;
   a lifetime total does not. Every *"X is pinned"* / *"X is always slow"* entry should be met
   with the cumulative counter before anyone attempts a reproduction — it refutes or confirms
   with no setup, no fixture, and no risk of disturbing a shared machine.
