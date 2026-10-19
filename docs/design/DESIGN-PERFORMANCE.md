---
layout: default
title: 'DESIGN-PERFORMANCE — the data-flow contract'
---

# DESIGN-PERFORMANCE — the data-flow contract

Companion to `DESIGN-COCKPIT-V2.md`. That document owns what the surface says;
this one owns how data reaches it and what it costs. Both are build law.

Written from measurements, not intuition. Every number here was measured on this
machine by the `bench/` harness or `tests/performance/cockpit/`, and every claim
that is *not* measured says so.

---

## The user's decision (July 2026, verbatim)

> *"lets keep sqlite, but everything that can be async do it for standardization.
> ui should only target specific updates via sse, not full page, only update what
> changes. try and avoid round trips as much as possible. do lazy loadings, etc."*

Plus the standing bar: *"everything needs to feel butter smooth at any point,
given any scenarios, no matter how many projects/files/chats we have"* and
*"ok is not good enough, I want instant"*.

**SQLite stays.** Postgres was considered and rejected: the local-file model is
load-bearing for the ledger's tamper-evidence, custody, and the claim that an
empty cell is *provably* empty. A single file you can hash, move and inspect is
part of the product, not an implementation detail.

---

## §1 — The four laws

**L1. Nothing synchronous on the event loop.**
Measured: at 100 concurrent, `getChatHistory` went 15.4ms → **453ms** while an
async control stayed flat at 20.2ms. With 50 concurrent writers a 1ms poller got
**one turn in 621ms**. A 5ms timer fired **0 of 183 expected times**. Latency
grows *linearly with users* — a shape no constant-factor tuning repairs.

Applies to all of it, not just the DB: `spawnSync` in tool execution (30s default
timeout — one tool call can freeze every user's stream), the custody
filesystem/git scan (8,009ms observed on an otherwise 3ms endpoint), and any
`statSync` storm.

**L2. The client is told what changed, never handed the world again.**
Measured: opening a 21,405-message conversation transfers **75.1MB** and takes
**34,665ms** against a 30,000ms client timeout — it cannot be opened at all. A
full-object refetch gets *worse* as data grows, by construction. SSE already
carries deltas for a live run; the same discipline extends to every surface.

**L3. Absence is stated, never rendered as emptiness.**
Measured: after two aborted 30s requests the Flow rendered `beats: 0` with no
error — the product asserting "nothing here" when the truth was "I could not load
it". This is the same fabricated-absence failure the whole product exists to
prevent, arriving through the performance door. **A load that fails, times out or
is truncated must say so, in plain words, with what it could not reach.**

**L4. Round trips are budgeted, and serial ones must justify themselves.**
Measured: boot is **7 strictly serial legs**; dependencies require only **4
waves**, and because project/chat ids are already persisted, optimistic firing
collapses it to ~**2**. `/api/health` is redundant (any later call proves reach)
and `/api/intelligence/map` is on the critical path *solely to print a decorative
line*.

---

## §2 — The async data-access facade

The standardization the user asked for. One boundary, applied uniformly — not
only where it currently hurts, because a half-async data layer is where the next
stall hides.

- **Every `DbClient` method returns a promise.** No exceptions, including ones
  that are cheap today; the point is that call sites never need to know.
- **SQLite work moves off the request thread.** In WAL mode SQLite supports
  concurrent readers with a single writer, so the shape is a **read pool plus one
  writer**. The measured ceiling of 69–85 durable writes/sec is an *fsync*
  ceiling, not a SQLite one — at `synchronous=NORMAL` an append is 140µs, so the
  engine is not the limit.
- **Ordering guarantees are re-established explicitly**, not inherited from the
  fact that everything used to be synchronous. Write ordering, read-your-writes
  within a request, and ledger sequence are each stated and tested.
- **The facade is the seam that keeps the engine swappable.** Once call sites are
  async, changing the driver underneath is a driver change, not a rewrite. This
  is the actual future-proofing; the engine choice is downstream of it.

### Durability, stated and bounded

`synchronous = "FULL"` is hardcoded (`integration/src/timeline/timeline-store.ts`)
with no config key — a default nobody chose. It costs **5.93ms per commit on real
ext4**; `NORMAL` costs **140µs**, a **42×** difference.

What `NORMAL` changes, precisely: a *process* crash loses nothing (the WAL is
written, just not fsynced); an *OS crash or power loss* can lose events since the
last checkpoint. SQLite guarantees the file is never corrupted in this mode.
**The window must be bounded by time, explicitly, and the number stated** — not
left to `wal_autocheckpoint` and assumed.

### What may never be traded

Recording is **not** the cost. Measured: AsyncLocalStorage **1µs**, chain hash
**9µs** — together **0.17%** of an append. The other **99.8% is fsync**. So:

- recording stays structurally unavoidable (an effect cannot happen unrecorded);
- the registry stays closed, so an empty cell stays *provably* empty;
- causality stays recorded data, not reconstruction;
- the chain hash stays tamper-evident.

Batching is permitted **only** with a flush barrier before the response is
acknowledged, so no effect is ever acknowledged-to-the-user while uncommitted.
Without that barrier, batching violates L-invariant 1 and is not an option.

> **Measurement trap, recorded so it is not re-entered:** the first ledger
> benchmark ran on `os.tmpdir()`, which is **tmpfs (RAM)**, where fsync is a
> no-op — 1µs versus 5.93ms on real ext4. It nearly concluded "durability is
> free". The harness now probes both and prints the gap.

> **Second measurement trap, same shape: a WAL FILE's SIZE IS NOT ITS
> BACKLOG.** `.bridlewise/timeline.db` was observed at 124MB beside a
> **163MB** WAL — larger than the database, and surviving a restart. Read off
> `ls`, that says "the checkpoint is not keeping up, and every reader is paying
> to walk it", which is a textbook failure of a read-pool design and was worth
> taking seriously.
>
> It is not what was happening. `PRAGMA wal_checkpoint(PASSIVE)` on that file
> returns `{busy: 0, log: 523, checkpointed: 523}`: **523 frames at a 4KB page
> is 2.0MB of real content, all of it copied, with no reader blocking.** A WAL
> file is a high-water mark — SQLite reuses the space in place and only shrinks
> the file on a TRUNCATE checkpoint, which happens on clean close. A 163MB file
> is the fossil of one past burst, not a backlog.
>
> The number that answers the question is `wal_checkpoint`'s `log` and
> `checkpointed` counters, never `statSync`. Tested directly as well as
> inferred: growing a fixture's WAL to 4MB under load and re-reading the same
> conversation measured **0.84×** — no slower, marginally faster from the warm
> page cache.

---

## §3 — Targeted updates: the delta contract

> *"ui should only target specific updates via sse, not full page, only update
> what changes"*

- **A surface subscribes to a stream of changes, and applies them in place.** No
  full refetch on revisit, no remount, no blanking, no layout shift. The
  warm-data discipline already in `shell/room-warm.ts`, `room-visibility.ts` and
  `rooms/custody-feed.ts` is the precedent; extend it rather than adding a
  fourth caching idiom.
- **A delta names what changed**, so the client patches one row rather than
  re-deriving a list.
- **Failed revalidation keeps the last known value and marks it stale** — it does
  not blank, and it does not present old data as fresh (`custody-feed.ts` already
  does this correctly; `chats.ts` now does too).
- **Deltas must be idempotent and carry identity**, because a reconnecting client
  will replay. The sweep tick counter's missing `eventId` dedup is the cautionary
  example: two sources double-counted while the band, which *does* dedup, stayed
  correct — two numbers describing one thing, disagreeing.

---

## §4 — Lazy loading and paging

- **No route may return an unbounded collection.** ~~History, messages, tool
  calls, timeline, projects, chats, memory currently all can.~~ **FIVE
  CLOSED**: `/history` (the cursor), and `/messages`, `/tool-calls`,
  `/metrics`, `/timeline`, which are now served from the same tail page so
  there is one bounded read and one definition of "the newest N" rather than
  five bounding rules that can drift. A bare JSON array has nowhere in the
  body to carry a cursor, so those four state the bound in an
  `X-Collection-Bound` header — a bounded array that says nothing is exactly
  the silent truncation the paging owner exists to prevent.
  **THREE STILL OPEN, and they are open on purpose:** `/api/projects`,
  `/api/projects/:id/chats` and the memory routes. Bounding the chat list
  changes a PRODUCT surface rather than a data path — the Switch's
  type-to-filter is specified as in-memory over every conversation (§5.2,
  "sub-50ms or it's a bug"), so a bound there is a design decision about what
  the Switch can find, not a paging change. Measured at `heavy`: 3,001 chats
  is ~600KB, over §5's budget and growing. It needs its own pass, with the
  Switch's search contract decided first.
- ~~**The client needs an incremental load path**, which does not exist today.~~
  **DONE.** A page of older beats is a DELTA: `prependMessages` announces the
  prefix BEFORE the transcript changes (a nanostores subscriber runs
  synchronously on `set`, so announcing afterwards is one frame too late),
  the ingest splices it in front instead of rebuilding, `log.prependBeats`
  puts the beats at the front and counts them, and `HeightIndex.prepend`
  shifts every measurement already taken rather than discarding it.
- ~~**Open the recent end, page backwards on demand.**~~ **DONE**, and the
  reader is held still while it happens. Measured in a browser at the
  `heavy` stack, ten pages arriving under a reader parked mid-conversation:
  the beat under the top of the viewport moved **at most 1px**, while
  `scrollTop` was compensated by up to 7,062px to absorb what arrived above.
  Two owners for one scroll position is how a fight starts — the first
  version held four trials of five to within 1px and threw the fifth 126px,
  because `holdReadingPosition` was capturing an anchor against a
  half-applied geometry; a `prependPending` interlock removed it.
- **Absence stays honest at the top of the list.** "Older messages are not
  loaded yet" and "this is the beginning of the conversation" render as the
  same pixels — the list stops — and mean opposite things. The surface states
  which, and **the client never infers it**: `endedBy: "beginning"` is issued
  only for a short page cut from one database snapshot, which is proof there
  is nothing older. A page that FAILS does not clear `hasOlder`, because a
  failed request does not make the older messages stop existing.
- **Mount-windowing is separate from paint-windowing, and both are required.**
  Measured on the Switch: scrolling 3,000 rows is smooth (p50 17.1ms, 1.1%
  dropped) while *mounting* them costs a **3,749ms long task** and 30,133 DOM
  nodes. `content-visibility` fixed the paint and hid the mount cost.

---

## §5 — Budgets, and the guards that hold them

A number in a report decays at the next commit. Each budget below is a test that
**fails on regression**. `bench/lib/report.ts::diffReports` compares against a
committed baseline.

| layer | budget | before | after items 1–4, 6–7 | guard |
|---|---|---|---|---|
| one recorded effect | < 200µs | **5.90ms** | **126µs** p50 / 5.01ms p95 | `ledger/recordEffect` |
| one durable message write | < 1ms | **11.0ms** | **274µs** p50 / **693µs** p95 — passing | `writepath/createMessage.full` |
| one whole-conversation read | (none stated) | **3.62s** p50 @ 22,525 msgs | **1.00s** p50 @ 26,455 msgs (161µs → **38µs/row**) | `db/getChatHistory` |
| any collection response | < 500KB | **75.1MB** | **367KB** tail page / **411KB** worst page of the whole walk — **PASSING**, item 5 | `history-route-bounded` payload assertion |
| history open, any size | < 200ms to first beats | **never renders** | **57ms** over HTTP @ 20,000 msgs (54ms to headers); renders at the TAIL | `history-cursor-owner` + browser |
| egress redaction | ~~< 1× stringify~~ see §5e | **6.6–77×** | **1.89×** @ 72MB, **2.95×** @ 367KB — the budget is unreachable and §5e says why | `egress-redaction-owner` |
| **per-op growth at 50 concurrent** | **< 2× vs n=1** (see §5c — unreachable for CPU-bound work) | **11.3–15.3×** | read **26.8× → 5.0×**, write **11.1× → 8.4×**; parallel floor **4.0×** | `concurrency/*` growth |
| **event-loop availability under load** | **> 80% of expected timer firings** | **0%** | **0% → 84%** @50 reads, **83%** @100, **100%** @50 writes — **GREEN** | starvation % |
| mount of N list rows | no long task > frame budget | **3,749ms @ 3,000** | unchanged, item 9 | browser spec |
| client critical path | < 150KB gzip | **201KB / 49 resources** — passing | unchanged | `payload/bundle` |
| cold reveal | < 500ms | **369ms** — passing | **342ms** — passing | browser spec |
| boot round trips | serial legs must justify themselves | **7 legs, `allSerial: true`** | **`allSerial: false`**, health + map gone | `boot-waves-owner` |

Machine for every figure above: linux x64, 12 cores, node v24.18.0, real ext4
(never `os.tmpdir()`), harness-reported QUIET (load 0.48), `--profile heavy`,
8 reader threads + 1 writer.

The `heavy` fixture no longer grows. It used to — the write benches appended to
the chats the read benches read, which is what made the largest conversation go
22,525 → 26,455 → 27,860 messages across three runs and quietly ruined the read
comparisons. Writes now go to a dedicated sink chat that no read case touches,
`assertReadTargetsPristine` refuses a fixture whose read targets have moved, and
the fixture used above was rebuilt from its seed (346,968 messages, 2,018.9MB).
The sync and async figures come from the SAME run against that fixture.

The two browser rows come from `tests/performance/cockpit/` driving a
Playwright page at the `heavy` stack (`tests/performance/scale/stack.ts heavy`),
frame clock asserted real at 16.6ms — never a backgrounded tab, which once
inflated a boot figure by ~1,000ms. Both are from a WARM stack: the same
measurement on a freshly started one reads 1,078ms, and that number is cold
Vite transforming 250 modules plus a cold page cache over a 2GB file, not the
product. The before-figure (369ms) was warm too, so the pair is comparable.

**Gate hardest on event-loop starvation.** It is one number that catches
regressions of *shape* rather than of constant, and shape is what defeats scale.

> **The facade landed, and the two shape rows moved in opposite ways — one
> to green, one to its physical floor.** Measured in ONE run, on ONE pristine
> `heavy` fixture, sync and async back to back, so the pair describes the same
> situation rather than two situations (`bench/concurrency.bench.ts`).
>
> | at 50 concurrent | sync | async facade | parallel floor |
> |---|---|---|---|
> | `getChatHistory` per-op p50 | 193.70ms | **54.67ms** | — |
> | `getChatHistory` growth vs n=1 | 26.8× | **5.0×** | 4.0× |
> | event-loop availability, reads | **0%** | **84%** | — |
> | event-loop availability, writes | **0%** | **100%** | — |
> | a 1ms poller during 50 writes | 1 turn of 33 (**97% starved**) | **14 turns of 13 (0% starved)** | — |
> | worst wait between poller turns | 33.32ms | **1.69ms** | — |
>
> Availability is the row §5 says to gate hardest on, and it is the one that
> went green: 0% → 84% at 50 concurrent reads, 83% at 100, and 100% under
> write load. The C3 row is the same fact stated as a user would feel it — a
> trivial request that got ONE turn in 33ms now gets every turn it asks for,
> and the worst wait behind 50 simultaneous writers fell from 33.32ms to
> 1.69ms.
>
> Growth fell 26.8× → 5.0× but did not reach 2×, and §5c explains why that
> budget cannot be reached by any implementation rather than treating 5.0× as
> a shortfall to be tuned away.
>
> **Three instrument repairs were needed to keep these numbers honest**, and
> each was found by disbelieving a figure rather than by looking for it.
>
> 1. **The benches were eating their own fixture.** The write cases appended
>    to the chats the read cases read — `concurrency` read `chatIds[1500]` and
>    then wrote ~257 messages into it; `writepath` wrote into the 20,000-message
>    mega chat that three read suites read. The read target had reached **1,412
>    messages against 46–167 in its neighbours**, and that presented as a
>    product regression: `getChatHistory.concurrent` p50 at n=1 going 13.23ms →
>    23.81ms across a wave that never touched the read path. The whole-database
>    count moved 2.6% in the same period, which is why it hid. It had also
>    disabled the regression guard: the largest read case is named by its row
>    count, so it arrived under a new name every run and `diffReports`, which
>    keys on `suite/name[scale]`, silently had nothing to compare. Writes now
>    go to a dedicated sink, the fixture owner refuses to hand out a drifted
>    fixture, and `tests/prevention/bench-fixture-drift.test.ts` fails if a
>    bench writes anywhere else. On a rebuilt fixture the same read is **7.22ms
>    at n=1**, against 13.23ms two waves ago. Across the curve the rebuilt sync
>    path is 0.55×/1.14×/1.14×/0.84×/0.98×/0.93× of that baseline at
>    n=1/5/10/25/50/100 — better at four levels, 14% worse at two, on p50s
>    drawn from 5 and 10 samples. The pair is not fully comparable in either
>    direction, because the 4c06bfd figures were themselves taken on a fixture
>    that had already drifted by an unrecorded amount; that is the point. What
>    IS comparable is the async path against the same baseline, which is
>    **0.82×/0.70×/0.43×/0.23×/0.28×/0.27×** — faster at every level, and
>    3.6× faster at 50 concurrent.
> 2. **A window shorter than the sampler was reported as 0% availability.**
>    The 5ms lag timer cannot fire during a 0.9ms fan-out whatever the loop is
>    doing, so the fastest async write rows read as "100% starved" in the very
>    table meant to show the loop being freed. It now says UNMEASURABLE.
> 3. **The async growth ratio flatters itself**, because its n=1 carries a
>    round trip and a structured clone the sync n=1 does not — a larger
>    denominator makes the ratio smaller for free. This is the same hazard that
>    made `createMessage` report **0.4× growth** last wave from a cold
>    statement compilation, arriving from the other direction. The fix is the
>    same: publish the figure with no denominator. Every async row now prints
>    the ABSOLUTE p50 beside the ratio.
>
> The earlier repair stands and is why the baselines above are trustworthy:
> the n=1 growth denominator must be WARM
> (`bench/concurrency.bench.ts::burnInCold`), or a cold statement compilation
> turns a linear shape into a green number.

> **THE 20,000-MESSAGE CONVERSATION OPENS.** Measured in one run, in one
> process, against the same pristine `heavy` fixture and the same
> conversation, through every stage a response passes on its way to the
> socket — read → view map (which redacts) → egress redact →
> `JSON.stringify` (`bench/history-page.bench.ts`).
>
> | opening chat `8535703c` (20,000 messages) | whole conversation | tail page |
> |---|---|---|
> | read + map + redact + stringify | **1.51s** | **33.0ms** p50 / 38.6ms p95 |
> | payload | **72.11MB** | **367.1KB** (101 messages) |
> | | | **45.9× faster, 201× smaller** |
>
> And over real HTTP, against a real `server/index.ts` on a real port
> serving the same fixture:
>
> | `GET /api/chats/<id>/history` | before (recorded, browser) | after |
> |---|---|---|
> | time to headers | **7,217ms** | **54ms** |
> | time to full body | **34,665ms** — past the 30,000ms client timeout | **57ms** |
> | payload | **75.1MB** | **367KB** |
> | outcome | **ABORTED — the conversation could not be opened at all** | **opens, at its tail** |
>
> **Nothing became unreachable to make that true**, which is the half a page
> bound can quietly get wrong. The full backwards walk delivers **20,000 of
> 20,000** messages in **215 pages**; the worst single page is **44.6ms /
> 410.6KB**, so every page of the walk is inside §5's budget, not merely the
> first. The walk costs **7.02s** in total against **1.51s** for the one
> unbounded read — the honest trade, stated: 215 bounded round trips are more
> total work than one 72MB materialisation, and nobody makes them unless they
> travel the whole way back.
>
> **TWO BOUNDS, BECAUSE ONE IS NOT A PAYLOAD BOUND.** A row bound alone lets
> one large tool call blow the budget, and the first version of this work
> shipped exactly that defect and was caught by measuring rather than by
> reading: a 200-message page whose MESSAGES were 322KB carried **449KB of
> tool calls** — 56% of a 788.8KB response — because the page's tool calls
> are fetched AFTER its messages are chosen and were outside the bound
> entirely. Every row-count assertion was green. Tool calls are now weighed
> from their STORED size (`LENGTH` over the ciphertext, no decryption, an
> upper bound on the plaintext), and `tests/prevention/history-cursor-owner`
> holds it with a fixture of trivial messages and enormous outputs.
>
> **AND AN INDEX IS PART OF THE CURSOR, NOT AN OPTIMISATION OF IT.**
> `ORDER BY created_at DESC, rowid DESC LIMIT 200` without
> `idx_messages_chat_created` (migration 13) reads and sorts EVERY message in
> the chat to find the newest 200 — an unbounded read producing a bounded
> answer. Worse, and this is the one no test of the RESULTS can see: the
> older-page predicate needs a redundant `created_at <= ?` conjunct in front
> of the lexicographic leg, because SQLite cannot turn a disjunction into an
> index range. Without it the plan degrades from `(chat_id=? AND
> created_at<?)` to `(chat_id=?)` — a backwards scan from the tail, filtered,
> on every page. That is O(distance from the tail) per page and O(n²) over a
> walk: the OFFSET defect this cursor replaced, wearing a WHERE clause.
> **Mutation-tested: deleting the conjunct and its bound parameter leaves
> every behavioural assertion green.** The guard reads the query plan, and it
> lifts the predicate out of the product's source rather than retyping it.

---

## §5e — What the redaction budget can and cannot ask for

The budget said **egress redaction < 1× `JSON.stringify`**. Measured after
hoisting the regexes and making the UTF-8 offset map lazy: **1.89×** on a
72MB payload and **2.95×** on a 367KB one, down from **6.6–77×**. The leaf
pass itself is **4.0× faster** on a real corpus.

It does not reach 1×, and it cannot. `JSON.stringify` is native C++ making
one pass; the redaction walk is JavaScript running **six regex automata**
over every string leaf and rebuilding the object tree. Asking the second to
beat the first is the same shape of error as §5c's growth budget — a bound
that encodes an assumption the measurements do not support (there, that the
work waits; here, that a six-automaton scan is comparable to a native
serialization).

**So the useful gate is the ABSOLUTE cost against the view budget, not the
ratio.** On the page a reader actually receives it is **1.04ms** — 0.5% of
the 200ms view budget, and the whole reason the ratio moved from alarming to
irrelevant is item 5, not item 8: the payload is 201× smaller.

**The two passes both stay, and the second is NOT redundant.** That was the
question item 8 asked, and the answer is a counterexample in each direction,
both held by `tests/prevention/egress-redaction-owner.test.ts`:

- the VIEW pass catches what the choke point cannot. `views.ts` parses a
  tool call's JSON arguments before detecting, so `\"` cannot hide a
  credential assignment; the plain-text detector alone finds nothing in
  `{"code":"const password = \"zzzz…\""}`.
- the CHOKE POINT catches what no view mapper touches — the chat TITLE, the
  config snapshot, the MCP server config. `chatToView` does not redact the
  title.

**A leak was found while measuring, and closed.** The choke point preferred
the plain-text result whenever the plain pass found ANYTHING, which
suppressed the JSON-aware pass entirely. Measured, at the egress choke point:

    in   {"note":"sk_aaaa…","code":"const password = \"zzzz…\""}
    out  {"note":"[REDACTED:token]","code":"const password = \"zzzz…\""}

The token was masked, so the credential was not even looked for. The rule is
now "prefer whichever masked MORE", which is monotone with respect to the old
one — when the plain pass found nothing, `jsonMarks > 0 = plainMarks` still
selects the JSON-aware result — so it can only ever mask more, never less.

**Equivalence was proved, not argued.** The previous detector is replicated
verbatim in the guard and run beside the current one over a corpus of real
fixture strings plus an adversarial set that DOES carry secrets: same
redacted bytes, same spans field for field, **0 disagreements over 704
strings / 386,182 chars, of which 9 were genuinely redacted**. A corpus of
negatives alone would have proved only that the fast path is fast.

**One honesty note about the `lastIndex` reset**, reported rather than
overstated: hoisting a `g` regex means its cursor now survives between calls,
and `detectSensitiveSpans` resets it. Deleting the reset was mutation-tested
and every BEHAVIOURAL assertion stayed green — the scan loop drains each
regex to `exec() === null`, and the engine resets `lastIndex` on a null
result. That is a property of the LOOP, not of the regex, and it survives
only while no early exit exists (the loop had one until this change removed
it as dead). The reset stays, and it is guarded by reading the source, with
the reason written where a tidier would find it.

---

## §5d — The same question asked THROUGH THE SERVER, which is where it changed

Every figure in §5's facade table was measured against `AsyncDbClient`
directly, in the bench's own process. That is the right way to measure the
mechanism and it cannot answer the product's question, because it skips the
auth gate, the CSRF check, the rate-limit bucket, the redaction walk at the
`sendJson` choke point, `JSON.stringify`, the socket and the kernel. So the
head-of-line question was asked again over real HTTP, against a real
`server/index.ts` on a real port, over the same 2,024MB `heavy` fixture.

**The two runs are back to back on this machine, minutes apart, against the
same fixture and the same conversation** — the pre-migration commit (`bf73a37`)
and the converted one. Same probe, same 20,000-message / 75.6MB read, same
cheap endpoint hammered on its own connection throughout.

| `GET /api/health` while ONE 75.6MB history read is in flight | before (sync) | after (threaded) |
|---|---|---|
| **requests served during the read** | **15** | **644** |
| …which is one every | 212ms | **5.7ms** |
| p50 | 11ms | **2ms** |
| p95 | **2,957ms** | **5ms** |
| p99 | **2,957ms** | **12ms** |
| **max** | **2,957ms** | **1,808ms** |
| the heavy read itself | 3,182ms | 3,651ms (**+15%**) |
| control (nothing else in flight), p50 / max | 2ms / 11ms | 3ms / 14ms |

**The sample count is the finding, not the percentiles.** In 3.18 seconds of
blocking the old server answered a trivial request FIFTEEN times; the new one
answered it 644 times in 3.65 seconds. p95 fell 2,957ms → 5ms. That is the
shape change §5b said only the facade could produce, now visible where a user
would feel it rather than in a bench's own process.

**The remaining 1,808ms max is real, and it is NOT the database.** The facade
took the DB work off the loop; it did not take the RESPONSE off the loop. A
75.6MB payload is still redacted and `JSON.stringify`-ed on the main thread,
and that is one long synchronous stretch per heavy read. It belongs to L2 and
to item 5 (the cursor), not to §2 — and stating which half moved is the point,
because "max fell 2,957 → 1,808" would otherwise read as "the problem is 39%
fixed" when the truth is that one cause was removed entirely and a different
one is now the whole of what remains.

**The heavy read got 15% SLOWER, and that is the trade being made.** A round
trip and a structured clone are not free; what they buy is the 43× increase in
what everyone else got served meanwhile. §5's read comparison stands — the
async path is faster at every concurrency level — and this row is the serial,
uncontended case where it is not, stated rather than omitted.

### The cost that only appeared through the server: memory

Measured on the same fixture, same process, six sequential worst-case reads:

| | sync | threaded |
|---|---|---|
| RSS at idle, connections open | **150MB** | **868MB** |
| RSS after one 20,000-message read | 479MB | 1,271MB |
| RSS after six | 1,279MB | 2,121MB |
| per-read latency | 1,225–1,330ms | 1,366–1,531ms |

Two separate effects, and they should not be confused:

- **~718MB fixed**, for nine worker isolates each holding an open connection.
  The live server shows the same shape on the real database: **454MB → 951MB**
  at idle. This is the price of the pool and it does not grow with load.
- **~2.7× on the first heavy read** (475MB → 1,263MB), because the rows are
  materialised on the reader thread, serialised into the port, and
  materialised again on the main thread. The same payload, counted twice, plus
  its serialisation. This one is bounded by item 5: a read that never
  materialises 75.6MB has nothing to copy.

> **An accident of the measurement that states L1 better than the harness
> does.** The RSS sampler in the probe is a 20ms `setInterval`. In the SYNC run
> it fired ZERO times across ~8 seconds of reads — the peak column came back
> `0MB` because the callback never ran once. In the threaded run it fired
> throughout. Nothing was configured to measure availability there; the
> instrument simply could not run in one case and could in the other.

> **Measurement hygiene, learned here the hard way.** Two attempts at the wire
> suite produced 17 dropped endpoint classes and a server that died mid-phase,
> and neither is evidence about the product. MUTATION TESTING WAS RUNNING
> CONCURRENTLY, rewriting `server/db/index.ts` and `server/router.ts` in place
> while the benchmark was booting servers from those same files. A harness that
> spawns the product from source cannot share a working tree with anything that
> edits it — and the failure does not announce itself as a harness failure, it
> announces itself as seventeen broken endpoints. Both runs are discarded; the
> pair above was measured with nothing else touching the tree. The `heavy` wire
> suite itself remains unrun on this box — see §7.

---

## §5c — What the growth budget can and cannot ask for

The budget says **per-op growth at 50 concurrent < 2× vs n=1**. Measured
against it, the facade reads 5.0× and looks like a partial success. It is not
a partial success; the budget is asking for something no implementation can
deliver, and saying so is worth more than a number that keeps failing.

**The bar is right for work that WAITS, and unreachable for work that
COMPUTES.** The harness's own control is 20ms of `setTimeout`, and it stays
flat at 1.0× for any N, because fifty simultaneous sleeps still take 20ms. A
whole-conversation read is the opposite: measured at `heavy`, SQLite's own work
is **137ms of 1,005ms (14%)**, AES decryption is **496ms (49%)**, and Zod
validation is most of the remainder. All of it is CPU, none of it is waiting.

With **K** workers and **N** equal tasks of duration **W**, the task finishing
in the median position completes at `W · ceil(ceil(N/2) / K)`. That product is
a floor no correct implementation can go under:

| N concurrent | floor with 8 readers | measured |
|---|---|---|
| 1 | 1.0× | 1.0× |
| 5 | 1.0× | 1.4× |
| 10 | 1.0× | 1.6× |
| 25 | 2.0× | 2.2× |
| 50 | **4.0×** | **5.0×** |
| 100 | 7.0× | 8.7× |

The measured curve tracks the floor within 1.25× at every level. Reaching 2× at
N=50 would need ~25 cores doing nothing else; this machine has 12, of which 8
are the read pool.

**So the useful gate is distance from the floor, not distance from 1×**, and
the metric that has no such excuse — and therefore stays the sharpest thing in
the table — is event-loop availability. That one has no lower bound imposed by
physics: a loop is either free to run a timer or it is not, and it is now free
84–100% of the time where it was free 0% of the time. `bench/concurrency.bench.ts`
prints the floor beside every growth figure so the two are never confused.

**This does not retire §5b.** The cheap wins genuinely could not move either
row, and did not; the facade moved both, one to green and one to its limit. The
rule that a good number does not retire the plan is unchanged — what changed is
that one of the two numbers turned out to encode an assumption (that the work
waits) which the measurements do not support.

---

## §5b — Good numbers do not retire the plan

> User, July 2026: *"even tho we end up getting good performance, i want to be
> sure we stick to the plan"*

This is a binding rule, and it exists because the measurements set a specific
trap.

**The cheap wins fix the constant. Only the facade fixes the shape.**
`synchronous=NORMAL` alone is 42×. Combined with items 3–4 below, per-operation
cost drops far enough that **the product will look fine at 50 users** — and the
underlying property will be completely unchanged: every DB touch still blocks the
event loop, so latency still grows *linearly with concurrency*. A 42× faster
constant simply moves the cliff; it does not remove it. The measured shape was
15.4ms → 453ms across 1 → 100 concurrent while an async control stayed flat.
Making the 15.4ms into 0.4ms leaves a curve of the same shape, and the day it
matters is the day there are enough users that nobody can reproduce it locally.

So the temptation this document exists to refuse: *"the benchmarks are green, we
can skip §2."*

**The guard that makes the plan mechanical, not remembered.** An absolute-latency
budget can be satisfied by the cheap wins alone, which is exactly why the budget
table gates hardest on two *shape* metrics:

- **per-op growth at 50 concurrent < 2× vs n=1** — measured today at 11.3–15.3×
- **event-loop availability > 80% of expected timer firings** — measured today at
  **0%**

Neither can be passed by making individual operations faster. `synchronous=NORMAL`
does not move them. Batching does not move them. Only getting the work off the
request thread moves them. **These two numbers are the plan, expressed as a test**
— they stay red until §2 lands, no matter how good every other figure looks.

The same discipline applies on the client. "Feels instant on my machine with the
`real` fixture" is not the bar; the bar is *"no matter how many projects/files/
chats we have"*. A surface that is smooth at 200 rows and blocks for 3.7s at
3,000 has not passed — it has merely not been asked the question yet. Every
client budget is measured at the `heavy` fixture, never at `tiny`.

**Nor does performance work retire the other rules.** L3 (honest absence) is a
correctness rule that happens to live in this document; a fast surface that
renders `beats: 0` when it means "I could not load it" is worse than a slow
honest one. Recording, the closed registry, causality and tamper-evidence are
never traded for a number (§2). If a benchmark is only reachable by weakening
one of those, the benchmark is wrong.

---

## §6 — Ranked work

1. ~~**L3 first — honest absence on failed load.**~~ **DONE.** An unread
   conversation now says so, names what it could not reach, and offers a verb;
   `loadChatHistory` deduplicates by chat id so the identical request cannot
   fire twice, and the Flow's self-heal effect no longer re-arms on failure.
2. ~~`synchronous=NORMAL` with a stated, time-bounded window.~~ **DONE**, on
   both databases. `timeline-config.ts` and `server/config.ts` own the value
   and the **1000ms** window; the window is held by an unref'd PASSIVE
   checkpoint, because `wal_autocheckpoint` bounds the WAL by PAGE COUNT and is
   not a time bound at all. Both stores report the posture they actually got,
   read back off their own connection.
3. ~~`createMessage` in one transaction.~~ **DONE.** 11.0ms → 274µs p50.
4. ~~Keyset pagination.~~ **DONE.** Whole-conversation read 3.62s → 1.00s;
   per-row 161µs → 38µs. The OFFSET walk was quadratic *and* slower than not
   paging at all; keyset is 2.2× faster than the unpaged single query.
5. ~~Cursor + client incremental load for history (§4).~~ **DONE. The
   conversation opens.** 34,665ms/75.1MB/aborted → **57ms/367KB, at the
   tail**, and scrolling back holds the reader to 1px. The cursor is
   `(created_at, rowid)` — the conversation's DECLARED order, so a page
   boundary can neither skip nor repeat a message — seekable by
   `idx_messages_chat_created` (migration 13), bounded by rows AND by content
   bytes, with `endedBy` saying which bound ended the page and whether the
   conversation genuinely begins there. Measured in §5's table and the block
   under it; the client half is `prependMessages` → `ingestPrefix` →
   `prependBeats` → `HeightIndex.prepend`.
6. ~~Boot waves: 7 serial → ~2.~~ **DONE.** `allSerial: false`; `/api/health`
   and `/api/intelligence/map` are off the boot path entirely.
7. ~~Custody prefetch.~~ **DONE, partly.** The idle warm no longer prefetches
   `custody.history` (~24 blocking git spawns for a room nobody opened);
   `custody.state` stays, because the Switch's badges read it with the room
   closed. The remaining read is 2 spawns instead of ~24. **Getting the scan
   off the loop is still item 10's.**
8. ~~Redaction: hoist the 6 per-string regex compilations, drop the second
   pass.~~ **HALF DONE, and the other half is REFUSED with a reason.** The
   regexes are hoisted and the UTF-8 offset map is built only when a span is
   actually detected — 6.6–77× → **1.89–2.95×**, leaf pass **4.0× faster**,
   equivalence proved against the previous detector over a real corpus with
   **0 disagreements**. **The second pass STAYS**: it is not redundant, and
   §5e carries the counterexample in each direction rather than the argument.
   A leak was found while measuring and closed (one visible secret suppressed
   the JSON-aware pass and hid every escaped secret beside it). The `< 1×
   stringify` budget is unreachable by construction; §5e replaces it with the
   absolute cost against the view budget.
9. Mount-windowing for the Switch (§4).
10. ~~**The async facade (§2).**~~ **DONE — the facade is the server's only
    door, and the backend is threaded.** `server/db/async-client.ts` exposes
    every `DbClient` method as a promise over a read pool plus a single writer
    thread (`thread-backend.ts`). The three orderings are re-established
    explicitly and tested — write ordering (one writer thread, synchronous
    handler, in-order delivery), read-your-writes (writes take a sequence
    number; a read waits for the frontier captured at ISSUE time, so it holds
    even when the caller did not await), and ledger monotonicity (the DB
    threads set `HARNESS_DB_WORKER` and `timeline-bridge.ts` THROWS if the
    ledger is opened there). The read pool is opened READ-ONLY, so "the pool
    never writes" is a property of the file handles rather than of a lookup
    table. Measured: §5's table and §5d.

    **The conversion could not be done halfway, and was not.** A
    half-converted server would hold a read-write connection on the main
    thread AND one on the writer thread — two writers on one file, which is
    exactly what W1 and the ledger's chain hash depend on there not being. So
    every intermediate commit ran the INLINE backend over the ONE `DbClient`
    the process already had, and the backend flipped on the commit that closed
    the last synchronous door. `tests/prevention/async-db-facade-owner.test.ts`
    held that interlock and INVERTED on its own: it now requires the threaded
    backend where it used to forbid it.

    **Three conversions were not mechanical, and each would have failed
    SILENTLY.** They are recorded because the shape recurs: a synchronous
    consumer that cannot await, handed a promise, where the promise is TRUTHY.
    `provenance.ancestryPortFor`, `synthesis.runOwnershipFor` and
    `custody.attributionResolverFor` each hand a synchronous predicate to a
    walk that cannot await; a per-id `runBelongsToUser` there would have
    returned a promise and admitted every run in the ledger while still
    reading like a gate. All three now resolve the caller's run set ONCE
    (`allRunIdsForUser` asks the identical question) and test membership. The
    run safety gate is the fourth: `executeToolCall` is synchronous into the
    canonical gate, so the gate reads a snapshot refreshed in the async frame
    immediately before each tool call, with no `await` between — asserted as
    an ADJACENCY, not merely as the existence of a refresh.

    **The one `withTransaction(fn)` in the product had to be replaced.** A
    closure cannot cross a thread, and `transaction(ops)` deliberately cannot
    express a body that reads, merges in application code and writes. Note
    what the transaction was actually buying: the old body was SYNCHRONOUS, so
    nothing could interleave with it whether or not it held a transaction. The
    conversion introduces two `await` points inside the read-merge-write, and
    THAT is what loses updates. `AsyncDbClient.updateUserModelPrefs` serialises
    the sequence per user; W2 guarantees the second sequence's read observes
    the first's write.
11. Tool execution off the main thread; a worker pool exists and tools never use
    it.

Items 1–4 and 6–7 are correct under any architecture and landed before the
facade, and the two shape rows stayed red exactly as §5b predicted and
required. Item 10 moved them — availability is green, growth is at its
parallel floor (§5c) — and it is now finished rather than seamed: the call
sites are converted, the synchronous client does not reach past `server/db/`,
and the threaded backend is live in the product.

**Item 5 closed the last shape defect on the read path**, and it is worth
saying which kind it was. The facade fixed WHERE the work happened; the
cursor fixed HOW MUCH work there is. A 75MB response is not slow because of
where it is assembled — it is slow because it is a function of how long the
user has talked, which is the L2 failure in its purest form. §5d's remaining
**1,808ms** max was named as "75.6MB being redacted and stringified on the
main thread", and item 5 is what removes it: a payload that never
materialises 75.6MB has nothing to redact, nothing to stringify and nothing
to copy across a thread boundary. Measured: **1.51s → 33.0ms** for the same
conversation, through the same stages. What is left on the data path is item
11 (tool execution) and the three collections §4 names as still open.

---

## §7 — Known unmeasured

Stated rather than implied complete:

- **Streaming frame timing** under a live run with tool calls
  (`HARNESS_WEB_LLM_FIXTURES=1` is the hook).
- **Editor FileTree at scale** — fixture project paths do not exist on disk, so
  the tree returns 0 entries. Needs a fixture pointed at a real large directory.
- **Long-session memory at heavy scale** — the run hit its 600s cap first. Heap
  rose 18MB → 278MB holding a single history payload, which deserves its own
  investigation.
- **Wire-level behaviour at 50 users / 100 connections** — in flight. The
  `heavy` wire suite (`bench/wire/load.ts --profile heavy`) has NOT completed
  on this box since the conversion. Two attempts were made and BOTH overlapped
  with mutation testing rewriting `server/db/index.ts` and `server/router.ts`
  in place, which the suite spawns its servers from (§5d); both are discarded
  as instrument failures, and neither is evidence about the product. The suite
  has not been run since under clean conditions, so what happens to it at
  `heavy` is simply UNKNOWN — not "fine", and not "broken". Until it runs, the
  head-of-line pair in §5d is the only through-the-server evidence, and it
  covers ONE heavy read, not sustained load.
- **The `hol` and `concurrency` wire phases at `heavy`** — unrun for the same
  reason. §5d's pair was measured by a purpose-built probe
  (staging, seeding, spawn, hammer, tear down) because the suite could not be
  driven to that phase; the probe measures the same thing and less of it.
- **Ledger index pruning gain** — 14 indexes on `event_log` (one redundant with
  an existing autoindex), a full duplicate `timeline_projection`, and
  `event_edges` carrying 3 indexes with **0 rows**. Not measured in isolation
  because it would require modifying the schema.
