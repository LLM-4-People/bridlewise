---
layout: default
title: 'RUN-STREAM DIAGNOSIS — the run stream endpoint, and the large conversation'
---

# RUN-STREAM DIAGNOSIS — the run stream endpoint, and the large conversation

Read-only diagnosis. Nothing in either repository was modified. Every number below was
**driven**, not read, unless the line says otherwise; every claim is marked PROVEN,
PROVEN-BY-STRUCTURE (single-writer / call-site enumeration, no execution) or SUSPECTED.

**Trees as measured.**

| repo | HEAD | working tree |
|---|---|---|
| `web-interface-foundation-v1` | `32dc29f64e9dda245741a00bcd2b1b1ee0131ee7` | **clean** (`git status --porcelain` empty) |
| `harness-main-v1` | `e800cd8c54edf92481a1fdfecd38806b8c92b51f` | ` M integration` (submodule pointer only) |

No writing agent touched the web repo during this diagnosis — every file my claims rest on is
committed and unmodified, so §8b's "true when written, false six minutes later" hazard does not
apply here. Per-file mtimes and last-commit shas are in **§7**.

---

## 0. THE TWO TASK ENTRIES ARE NOT IN `TASKS.md` — §8b absence, established by bytes

The brief said "then the two task entries in `TASKS.md`". They are not there. Counted from
bytes (`readFileSync` + `indexOf`, never `grep` — §8b.7), over the whole of
`/home/example/code-harness-workspaces/harness-main-v1/TASKS.md` (357,293 bytes):

| phrase | occurrences in `TASKS.md` | in `ALL-BUGS-AND-ISSUES.md` (1,469,211 B) |
|---|---|---|
| `subscriber` | **0** | 0 |
| `executor, not` | **0** | 0 |
| `duplicates the whole run` | **0** | 0 |
| `second SSE` | **0** | 0 |
| `second connection` | **0** | 2 (unrelated: an artifact signal, a transaction-timing flake) |
| `cannot be opened` | **0** | 0 |
| `run stream` | **0** | 1 (unrelated) |
| `/run/` | **0** | 8 |
| `run/start` | **0** | 5 |
| `activeRuns` | **0** | 6 |
| `openSseStream` | **0** | 11 |

A tree-wide walk of every `.md` in both repositories for `is the executor, not a subscriber`,
`duplicates the whole run`, `large conversation cannot be opened` and `second connection`
returned exactly one hit, in `ALL-BUGS-AND-ISSUES.md:12641`, about an unrelated transaction
flake.

**So the brief's own paraphrase was the entire specification of both targets.** I diagnosed
against the paraphrase. This is a workflow finding, recorded in **§6**.

---

# TARGET A — "the run stream endpoint is the executor, not a subscriber"

## A1. VERDICT: **PROVEN**, and the task entry *understates* it

The entry says a second connection duplicates the run. It does. It also says nothing about the
two facts that make the endpoint worse than duplicated: **the run is owned by the connection**,
so (i) either connection closing **kills the other's run**, and (ii) a dropped connection makes
the run **unreachable forever** — a 404, not a re-attach. All three come from the same root:
the run's lifetime *is* the HTTP response's lifetime.

### The driving evidence

**Probe 1 — two concurrent SSE connections to one `runId`, fixture provider**
(`HARNESS_WEB_LLM_FIXTURES=1`, real router, real SQLite, real `executeToolCall`):

```
run/start: 201 {"runId":"run-2d038776-…"}

A -> 200        B -> 200          ← both connections accepted
A:connected  = 1     B:connected  = 1
A:context    = 1     B:context    = 1      ← two full system-prompt assemblies
A:model      = 8     B:model      = 8      ← two complete model streams
A:tool_result= 1     B:tool_result= 1      ← two server-side tool EXECUTIONS

DB message rows in the chat:  user = 1, assistant = 2, tool = 2   (TOTAL 5)
```

One user prompt. Two assistant messages, two tool messages, two tool executions.

**Probe 2 — the same, against a REAL OpenAI-compatible provider** (a local HTTP server standing
in for the provider, counting requests; `HARNESS_LLM_CONFIG_PATH` pointed at it):

```
### (1) DUPLICATE SPEND
  provider POSTs received = 2   /chat/completions 38429B | /chat/completions 38429B
  A:model = 5   B:model = 5
  DB rows for this runId: {"user":1,"assistant":2}
```

**Two POSTs to `/chat/completions`, 38,429 bytes of prompt each.** That is the spend, measured
at the wire, not inferred. The duplicate is byte-identical, so it is billed identically.

**Probe 3 — the shared `AbortController`.** Connection A opened at t=0, connection B at
t=300ms, B's client closed at t=1,200ms:

```
  A connected / A context / A model(start) / A metadata / A model(text_delta "hello ")
  B connected / B context / B model(start) / B metadata / B model(text_delta "hello ")
  B __client-closed__
  A model {"type":"error","error":{"kind":"provider","code":"llm_strea…
```

**B's disconnect killed A's run.** A received a provider error frame the moment B went away.

**Probe 4 — reconnect after a drop:**

```
  first connection frames: connected, context, model, metadata, model, __client-closed__
  reconnect status = 404   content-type = application/json
  reconnect body   = {"error":"not_found","message":"Run run-398f… not found or already completed"}
```

## A2. The mechanism, with `file:line`

All in `/home/example/code-harness-workspaces/web-interface-foundation-v1/server/routes/run.ts`.

| what | where |
|---|---|
| the process-global run table | `run.ts:203` — `const activeRuns = new Map<string, ActiveRun>()` |
| the GET handler | `run.ts:937` — `router.get("/api/run/:runId/stream", …)` |
| the only gates before work starts | `run.ts:945` (404 if absent) and `run.ts:948` (403 if not yours) — **there is no third check** |
| the SSE stream opens | `run.ts:963` — `await openSseStream(…)` |
| **connection owns the run's life** | `run.ts:980-983` — `ctx.res.on("close", () => { active.abortController.abort(); activeRuns.delete(runId); })` |
| the executor body | `run.ts:999` — `void withRecordingContext({…}, async () => {` … `})` |
| builds the whole LLM input | `run.ts:1070` — `buildLLMInput(…)` |
| **calls the provider** | `run.ts:1294` — `for await (const event of streamChat(turnPrompt, buildChatOpts()))` |
| **executes tools** | `run.ts:1349` — `await executeToolCall(toolName, event.arguments, {…})` |
| writes the projection | `run.ts:1406` `persistToolResult`, `run.ts:1473` `persistModelEvent` |
| tears the run down on every exit | `run.ts:1741-1742` — `activeRuns.delete(runId); stream.close();` |

`POST /api/run/start` (`run.ts:735-873`) **starts nothing**. It validates, builds the history,
seeds the context manager, inserts the user message, and returns `{ runId }` at `run.ts:872`.
Every byte of work — provider call, tool dispatch, ledger writes, quality check, memory writes —
happens inside the **GET** handler.

### The field that was going to be the guard, and is dead

`ActiveRun.isStreaming` is declared at `run.ts:130`, initialised `false` at `run.ts:830`, set
`true` at `run.ts:1278` and `false` at `run.ts:1533`. Counted from bytes: **4 occurrences, all
writes, zero reads.** It is the §21 INERT shape in its purest form — the value that would have
answered "is this run already executing?" is computed and discarded, and nothing gates on it.

## A3. Blast radius — each item separately

| blast | status | evidence |
|---|---|---|
| **Duplicate LLM spend** | **PROVEN** | 2 × `POST /chat/completions`, 38,429 B each (Probe 2). Identical prompts, so identical cost. |
| **Duplicate tool execution** | **PROVEN** | 2 × `tool_result` frames, 2 × `tool_calls` rows (Probe 1). `executeToolCall` entered twice with the same `callId` and arguments. |
| **Duplicate file writes / commands** | **PROVEN-BY-STRUCTURE** | The fixture picks `read_file`, so I did not drive a write. The dispatch table `server/tool-executor.ts` (the `TOOL_HANDLERS` object) contains `execute_command`, `edit_replace_file`, `edit_apply_patch`, `edit_insert_text`, `edit_delete_range`, `edit_replace_range` — one code path, dispatched by name. `edit_apply_patch` and `edit_insert_text` are **not idempotent**: applied twice they double-apply or fail. `execute_command` twice runs the command twice. |
| **Two runs writing the same `runId`** | **PROVEN** | Both executions carry the identical `runId` into `withRecordingContext({ actor, runId })` (`run.ts:999`), into `persistModelEvent`/`persistToolResult`, and into `recordTimelineForModelEvent` (`run.ts:604`). Both mutate the **same** `ActiveRun` object — `accumulatedText`, `assistantMessageId`, `toolCallRows`, `contextManager` — so the two interleave into one mutable state. |
| **Ledger visibility** | **PROVEN, and it is silent** | The duplication is *present* (2 assistant rows, 2 turn events, 2 token-usage events under one run) but **nothing labels it**. The chat transcript simply contains two assistant answers to one prompt, and the ledger contains two turns under one run — a shape indistinguishable from a legitimate multi-turn run. There is no `connectionId`, no execution-attempt id, no uniqueness constraint. |

## A4. Can it happen accidentally?

Answering this honestly required overturning my own first hypothesis.

- **Browser reconnect / refresh — NO.** The `close` listener (`run.ts:980`) fires first and
  deletes the run, so the retried GET gets **404** (Probe 4). `EventSource` treats a non-200 as
  a permanent failure per the HTML spec, so it does not retry further. This vector produces run
  *death*, not duplication.
- **Two tabs — UNLIKELY but possible.** `runId` lives in tab memory (`beginCockpitRun`,
  `src/cockpit/flow/run-stream.ts:373`), so two tabs normally start two runs. It requires the
  id to be shared deliberately.
- **A proxy or client retry — YES, and this is the real accidental vector.** `GET` is defined
  as **safe** by RFC 9110 §9.2.1. Every intermediary is entitled to repeat one: nginx
  `proxy_next_upstream`, an SDK retry policy, a service worker, a browser speculative load, a
  crawler with the session cookie. A repeat issued *while the original upstream connection is
  still held open* is exactly Probe 1. **A GET that spends money and edits files is the defect
  underneath the defect.**
- **Deliberately — TRIVIALLY.** Any authenticated user can `curl` their own stream URL twice.
  The default connection cap is 8 per user (`server/config.ts:293`,
  `DEFAULT_SSE_MAX_CONNECTIONS_PER_USER = 8`), so **eight simultaneous executions of one run**
  is within policy.

## A5. §0 LADDER VERDICT — target A

> **Rung reached: none.** There is no guard of any kind. `isStreaming` is written twice and read
> zero times (`run.ts:130/830/1278/1533`), so not even rung 6 (convention) is in place — there is
> no comment claiming the invariant either.
>
> **Rung 1 (physically impossible) — AVAILABLE, and it is the recommendation.** One SQLite table
> makes a second execution's *claim* refusable by the engine:
> `CREATE TABLE run_executions (run_id TEXT PRIMARY KEY, claimed_at TEXT NOT NULL)`. The executor's
> FIRST statement — before `buildLLMInput`, before `streamChat` — is
> `INSERT INTO run_executions VALUES (?, ?)`. A second attempt raises
> `SQLITE_CONSTRAINT_PRIMARYKEY` and cannot reach the provider. This survives a module that skips
> the facade, a migration written later, and the `sqlite3` CLI. It is unavailable only for a
> deployment where two server processes share no database — not this one (one DB file, one writer,
> `AsyncDbClient.inline`). **State it plainly: rung 1 is available here and nobody took it.**
>
> **Rung 2 (unrepresentable) — AVAILABLE.** The stream handler's context is currently the same
> `ActiveRun` the executor mutates. Give the subscriber a `RunFeed` type carrying only
> `{ subscribe(fromSequence), runId, chatId }` — no `abortController`, no `contextManager`, no
> `safetyGate`. "The GET starts a turn" then has no expression in the type system.
>
> **Rung 3 (unreachable by shape) — AVAILABLE, and mechanically checkable.** Split `run.ts` into
> `run-executor.ts` (the only module importing `streamChat` and `executeToolCall`) and
> `run-stream.ts` (importing only the feed). The stream module has **no import edge** to the
> executor, so it cannot call it; the check is a walk of the import graph, not a name list.
>
> **Rung 4 (runtime choke point) — available and INSUFFICIENT ALONE.** `if (active.isStreaming)
> return attachOnly()` at `run.ts:945` fixes today's instance. It does not stop the next handler
> that forgets, and it is the shape that produced the dead field in the first place.
>
> **Rung 5 (source scan) — rejected.** A scan for "does a GET handler call `streamChat`" has a
> universe, and universes are what this project keeps getting wrong.

**Recommended landing: rung 1 + rung 3 together.** Rung 1 makes the duplicate impossible at
runtime whatever the code does; rung 3 makes it impossible to write.

## A6. The fix, precisely enough to implement without re-deriving

**Move the executor to `POST /api/run/start`; make `GET /api/run/:runId/stream` a pure
subscriber. Six concrete edits.**

1. **`run.ts:735-873` (`POST /api/run/start`)** — after `sendJson(ctx.res, { runId }, 201)`,
   claim the run (`INSERT INTO run_executions`, rung 1) and launch the executor detached:
   `void withRecordingContext({ actor, runId }, () => executeRun(runId, db))`. Everything now
   at `run.ts:999-1743` moves into `executeRun`, **unchanged except for where its output goes**.

2. **New per-run broadcast buffer** (one module, one owner). `executeRun` calls
   `feed.publish(runId, eventName, payload)` where the GET handler currently calls
   `stream.send(...)`. The buffer is append-only, **sequence-numbered from 1**, bounded by the
   same `chatHistoryPageBytes`-style configurable (declare it in the global config per §17), and
   deleted when the run reaches a terminal state plus a grace window.

3. **`run.ts:937` (`GET .../stream`)** becomes: resolve + authorise (`run.ts:945/948`, unchanged)
   → `openSseStream` → replay the buffer from `Last-Event-ID + 1` → subscribe. **It imports
   neither `streamChat` nor `executeToolCall`** (rung 3). Delete the `ctx.res.on("close")`
   handler at `run.ts:980-983` entirely — a subscriber leaving must unsubscribe and nothing else.

4. **`server/sse.ts`** currently writes `retry:` (`sse.ts:337`) but emits **no `id:` field** and
   ignores `Last-Event-ID`. Add both: `send()` writes `id: <sequence>`, and `openSseStream` reads
   `req.headers["last-event-id"]`. This is SSE's own resumption mechanism and it is the whole of
   the reconnect fix.

5. **The `AbortController` moves to the run**, not the connection. `POST /api/run/:runId/cancel`
   (`run.ts:875-889`) already aborts it and is already user-scoped — it becomes the *only* way a
   run stops early, which is what the product means by cancel.

6. **Delete `ActiveRun.isStreaming`** (`run.ts:130/830/1278/1533`). The run-claim row replaces
   it, and a dead field beside a real one is exactly how the next reader is misled.

**Three open defects this closes at the same time:** the duplicate execution (A), the
disconnect-kills-the-run coupling (A3), and the false premise in
`src/cockpit/flow/run-ownership.ts:26-31` — quoted verbatim: *"the run is executing on the
SERVER, the server records every event as it happens, and returning to the workspace re-reads
the record."* **Measured false today** (Probe 4): parking closes the EventSource, the close
handler aborts and deletes the run, and `entry.reopen()` (`run-ownership.ts:160`) gets a 404.
After this fix that sentence becomes true, which is the point.

## A7. The test that would have caught it, and will catch it next time

**Two assertions, one behavioural and one structural. Both are needed: the behavioural one
catches the instance, the structural one catches the class.**

**Test 1 — behavioural, drives the real path.**
*Population, stated as a runtime number and floored:* every route the router registers whose
method is `GET` and whose path starts with `/api/run/` — **discovered from the router's own
registration table, never a literal**. Assert `routesUnderTest >= 1` first; a discovery that
comes back empty **fails** rather than passing vacuously (§8b.6).

For each such route: `HARNESS_WEB_LLM_FIXTURES=1`; start one run bound to a chat; open **N = 2**
concurrent connections; drain both.

*Liveness precondition, before any cost assertion (§8):* assert the executor ran at all —
`assistantRows >= 1` **and** `toolCallRows >= 1`. Without this the guard passes at N=0 while
measuring a refusal.

*The verdict:* `assistantRows === 1` and `toolCallRows === 1` — **row counts in the projection,
which only the executor can produce**. Not frame counts (a subscriber legitimately receives every
frame twice, once per connection), and **never ordering** (§8: the old path reproduces ordering
by accident).

**Test 2 — structural, over the import graph.** The module registering `GET /api/run/:runId/stream`
must have **no transitive import edge** to `llm-bridge.ts#streamChat` or
`tool-executor.ts#executeToolCall`. Walk the graph from the module's own source; assert the walk
visited `>= 1` edge before judging, so a walker that finds nothing reds instead of passing.

**Mutations required, all three, and each must first prove it changed an answer (§8):**

- **ABSENT** — delete the run-claim insert. Probe: `assistantRows` goes 1 → 2 *before* judging.
  Guard must red.
- **DIFFERENT SHAPE** — reach the executor by a second door (a `?resume=1` query, a `POST
  .../attach`). Verdict must still be `assistantRows === 1`. This is what proves the guard
  catches the **class** and not the literal path string.
- **INERT** — leave the claim insert in place and **discard its result**: compute "already
  claimed", then execute anyway. The row-count assertion still reds, because it asserts evidence
  only the executor produces. A frame-count or ordering assertion would survive this mutation,
  which is exactly why neither is used.

**Plant supplied from outside the guard** (§21b): the second connection is opened by the test
harness against the live server, entering where a real caller enters — not by calling an inner
helper twice.

---

# TARGET B — "a large conversation cannot be opened at all, and fails silently"

## B1. VERDICT: **NOT PROVEN — the entry is stale.** It was real, it was measured, and it was fixed

The claim is **overturned for the path it names**. Driven on a conversation I built myself
through `DbClient` (the same write path `bench/fixtures/scale.ts` uses), **21,000 messages,
5,250 tool calls with 3 KB outputs, 200 timeline refs, 40 metrics snapshots, 58.0 MB database**:

```
config bounds: tailRows=200  pageRows=500  pageBytes=400000

GET /history        200   388.3KB   119ms
GET /messages       200   192.8KB    48ms   X-Collection-Bound: limit=200; returned=190; more=1
GET /tool-calls     200   149.3KB    44ms   X-Collection-Bound: limit=200; returned=47;  more=1
GET /timeline       200    39.5KB    30ms   X-Collection-Bound: limit=200; returned=200; more=1
GET /metrics        200     6.3KB    30ms   X-Collection-Bound: limit=200; returned=40;  more=0

page facts: {"limit":200,"returned":190,"hasOlder":true,
             "olderCursor":"MjAyNi0wNy0yOFQyMjo0MDo0Mi44NDhaADIwODEy",
             "messageCount":21000,"endedBy":"bytes"}

GET /history/older (1 hop)  200  344.4KB  59ms   → returned=189, hasOlder=true, endedBy="bytes"

control — the 1-message conversation:
GET /history (small chat)   200    0.6KB  11ms
```

**119 ms and 388 KB, against a 1-message conversation's 11 ms.** The cursor advances. The page
states `messageCount: 21000` and `endedBy: "bytes"`, so the surface can say *why* the page ended
and how far back the conversation goes. Nothing is silent and nothing is lost.

**Scaling, measured at six sizes** (`getChatHistoryPage`, the route's actual read):

| messages | `getChatHistoryPage` | rows returned | `listMessages` (unbounded) | `buildConversationHistory` | history entries |
|---:|---:|---:|---:|---:|---:|
| 200 | **8 ms** | 195 | 3 ms | 30 ms | 201 |
| 1,000 | **9 ms** | 195 | 16 ms | 38 ms | 1,001 |
| 5,000 | **8 ms** | 195 | 82 ms | 124 ms | 5,001 |
| 10,000 | **9 ms** | 195 | 146 ms | 232 ms | 10,001 |
| 20,000 | **16 ms** | 194 | 266 ms | 471 ms | 20,001 |
| 40,000 | **28 ms** | 194 | 516 ms | 1,102 ms | 40,001 |

**The paged read is flat. There is no threshold at which it fails**, because the page is bounded
by rows *and* bytes and ends at whichever arrives first (`server/db/client.ts:2276-2284`,
`:2350-2368`).

The route's own comment records the original defect verbatim
(`server/routes/chats.ts:401-413`): *"Measured on the `heavy` fixture's 21,405-message chat:
75.1MB, 7,217ms to headers, 34,665ms to the last byte, against a 30,000ms client timeout. The
conversation could not be opened at all — not slowly, at all."* That was true. It is no longer.

**The "fails silently" half is also fixed, at the outermost surface.** `src/client.ts:1505-1517`
routes a failed, timed-out or truncated load into `noteChatHistoryUnread(chatId,
absenceReason(error), title)` — an explicit unread state carrying the reason and the
conversation's title — and only for the conversation still on screen. The reach state
(`src/state/chat-history-reach.ts:37-50`) carries `hasOlder` and `olderCursor` so the client
never has to *infer* whether it is at the beginning.

**The old unbounded door is dead and guarded.** `DbClient.getChatHistory`
(`server/db/client.ts:2251-2261`) fans out to four `LIMIT`-less reads and has **zero production
callers** — enumerated tree-wide: only `server/db/async-client.ts:716` (the facade) and test
files. `tests/prevention/history-route-bounded.test.ts:101` carries the mutation
(*"point the route back at `db.getChatHistory` and this returns…"*).

## B2. What is genuinely still there — the residual, and it is the same class on the door next to it

`GET /api/chats/:id/history` is bounded. **`POST /api/run/start` is not.**

```
### starting a run bound to the 21,000-message conversation
  POST /api/run/start   201   2093 ms
  (the 1-message control is single-digit ms)
```

**Mechanism.** `server/chat-history.ts:76-79`:

```ts
const [allMessages, toolCalls] = await Promise.all([
  db.listMessages(options.chatId, options.userId),
  db.listToolCallsByChat(options.chatId, options.userId),
]);
```

`listMessages` (`server/db/client.ts:1239`) goes through `pageAllRows`
(`server/db/client.ts:846-890`), which pages *internally* to avoid the quadratic `OFFSET` walk —
and then **returns every row**. The paging is a query-plan optimisation, not a bound. Called from
`run.ts:768-769` with no `maxHistoryMessages`, so the documented cap
(`chat-history.ts:49-54`, *"0 or undefined = no cap (load all)"*) is never applied by the run
route.

**And the conversation is loaded TWICE per run start.** `run.ts:785-792` calls
`applyComposeAdjustments` → `composeStateForChat` (`server/blocks/compose.ts:278`) →
`runStartTimes` (`compose.ts:243`) → `db.listMessages` (`compose.ts:180`) — a second full walk of
the same rows, decrypted again, to recover run start instants.

**Is data lost, or merely slow?** Neither is lost and nothing is unreachable — the context
manager trims correctly (the run's `context` event on the 21,000-message chat reported
`historyLength=11 contextTokens=2372 limit=32768 trimmed=true`, which is honest). The cost is
**latency and resident memory**: 40,001 decrypted messages plus 10,000 tool-call rows of 3 KB
each materialise per run start, per concurrent user.

**Severity: MEDIUM, not CRITICAL.** It is a linear cost on a door that is not the one the entry
names, and at the measured shape it is ~2 s, not a failure. But it is *the identical defect
class* the paging work fixed, sitting one route away, and it will become the next "cannot be
opened" as conversations grow.

## B3. §0 LADDER VERDICT — target B

> **Rung reached: 4, with a rung-5 backstop.** The route calls the bounded
> `getChatHistoryPage`; the unbounded `getChatHistory` is unreferenced in production; a
> source-scan prevention test with a real mutation reds if the route is pointed back.
>
> **Rung 1 (physically impossible) — unavailable, and specifically why.** SQLite cannot refuse a
> statement for returning too many rows. A `LIMIT` is a property of the query text, not a
> constraint the engine enforces against the caller. There is no trigger, permission or
> connection mode that makes "read the whole table" refusable.
>
> **Rung 2 (unrepresentable) — AVAILABLE and not taken.** Change `listMessages`'s return type from
> `readonly MessageRow[]` to a `Page<MessageRow>` carrying `{ rows, cursor, hasOlder }`. A caller
> that wants the whole conversation must then write an explicit loop and can be seen doing it; the
> unbounded read stops being the *shape of the default answer*. This is the fix that ends the
> class rather than the instance.
>
> **Rung 3 (unreachable by shape) — AVAILABLE.** Delete `DbClient.getChatHistory`
> (`client.ts:2251`) and its facade (`async-client.ts:716`) outright. It has no production caller;
> it exists only so tests can call it and so a future route can accidentally find it. §8's
> exemption rule applies: **prefer deleting the door to defending it.**
>
> **Rung 4 (runtime choke point) — WHERE IT IS TODAY**, and it is real: the route reads through
> one bounded accessor.
>
> **Rung 5 — the backstop that exists** (`tests/prevention/history-route-bounded.test.ts`), and
> which does not cover `buildConversationHistory` at all.

## B4. The fix for the residual

1. **`run.ts:768-769`** — pass the bound: `maxHistoryMessages: serverConfig.chatHistoryTailRows`
   (or a new `runHistoryMaxMessages`, **declared in the global config with default/range/doc per
   §17**, not a literal). The parameter already exists and is already honoured
   (`chat-history.ts:104-106`).
2. **`compose.ts:174-185`** — `runStartTimes` needs run ids and first-seen timestamps, not
   message bodies. Replace the `listMessages` walk with a single
   `SELECT run_id, MIN(created_at) FROM messages WHERE chat_id=? … GROUP BY run_id`. This removes
   the second full decrypt entirely.
3. **`server/db/client.ts:2251` + `async-client.ts:716`** — delete `getChatHistory`. Update the
   ~8 test call sites to the paged accessor. Rung 3, by removal.
4. **Rung 2, when there is appetite:** make `listMessages` return a page. Then
   `server/blocks/custody.ts:628` — `chats.map(async (c) => [c.id, await db.listMessages(c.id, userId)])`,
   which loads **every message of every chat in a project** to answer a per-run turn-number
   question — becomes visible as the unbounded read it is.

## B5. The test that would have caught the residual

*Population, discovered and floored:* every exported server function that calls `db.listMessages`
or `db.listToolCallsByChat` **without** a bound argument, found by walking the call graph from
each route registration — not a hand list. Assert `candidates >= 1` before judging.

*Behavioural verdict, and it must be a ratio, not an absolute (§8):* build the same conversation
at n and at 8n; drive `POST /api/run/start` at both; assert
`t(8n) / t(n) < K` for a K derived from the bound that is supposed to apply. **Liveness first:**
assert the run actually started (`201` **and** a `user` message row written) before asserting
cost — a cost guard that passes while measuring a refusal is the failure this project keeps
rediscovering.

*Mutations:* (ABSENT) remove the `maxHistoryMessages` argument → ratio goes superlinear, red.
(SHAPE) add a *third* unbounded reader on the run-start path → the call-graph half reds even
though timing may not. (INERT) pass the bound and discard it inside
`buildConversationHistory` → the ratio assertion reds, because it measures the answer, not the
argument.

---

# §3. ADJACENT FINDINGS — the three the brief named, and one more

### ADJ-1. The transcript store is single-tenant, and the code says so (KNOWN, documented)

`src/cockpit/flow/run-ownership.ts:5-21` states the defect in full: `state/chat-messages.ts`
`messages` is *"the current chat's messages"*, cleared on every chat switch and written by
`client.ts` with no chat check — so a second live run's `text_delta` is committed into the
*visible* chat's last assistant message by `commitStreamingTail`. `soleLiveRun()`
(`run-ownership.ts:128-132`) returns `null` for **both** none and several, and the header says
plainly that with two runs in flight the code *"falls back to the single-tenant behaviour … a
known limit, stated, not a silent guess"*.

**Status: correctly recorded, not fixed.** The mitigation (parking) is real but is built on the
premise disproven in §A1 — parking does not leave the run executing on the server, it **kills**
it. So today the single-tenant store is defended by a mechanism that destroys the thing it was
defending. **These two must be fixed together**, and the §A6 fix is the prerequisite.

### ADJ-2. The sweep tick counter double-counts, and its ids are minted so that no dedup can ever catch it — **PROVEN BY STRUCTURE**

`src/cockpit/flow/run-stream.ts:88-103`:

```ts
let liveTickSeq = 0;                                    // :73, module-global
function tickFromModelEvent(runId: string, event: ModelEvent): void {
  liveTickSeq += 1;
  recordReceivedEvent(Object.freeze({
    eventId: `live-model-${runId}-${liveTickSeq}`,       // :92 — id from a COUNTER
    …
  }));
}
```

`src/cockpit/sweep/sweep-store.ts:100-109`:

```ts
export function recordReceivedEvent(e: SweepEvent): void {
  nowEdge.set(advanceNowEdge(nowEdge.get(), e));
  const s = streamState.get();
  streamState.set(Object.freeze({ status: "live", lastEventMs: …,
    eventsReceived: s.eventsReceived + 1 }));            // :106 — bare increment
  fireMatchingArms(e);
}
```

There is **no `seen` set and no eventId comparison** anywhere in `recordReceivedEvent`. The
dedup that does exist is in a *different* module — `sweep-data.ts:50-67` builds `seen` over
`e.eventId` for the **band points** — and the header at `sweep-data.ts:32` claims the window is
*"deduplicated by eventId"*, which is true of the band and false of the counter.

**Two independent defects, and the second is what makes the first unfixable in place:**

1. `eventsReceived` counts receipts, not events, so the same model event delivered twice
   increments it twice.
2. Because the id embeds a **fresh `liveTickSeq` per receipt**, the two receipts of one event get
   **different** `eventId`s — so adding a `seen` set downstream would not catch them either.
   `fireMatchingArms(e)` (`sweep-store.ts:108`) is on the same path, so an armed trigger
   **fires twice** on a duplicated event.

Target A is the delivery mechanism: two connections deliver the same run's frames twice to a
client that has both open. **Fix:** derive the tick's identity from the event, not from a
counter — e.g. `${runId}:${event.sequence}` (the model frames already carry `sequence`, visible
in the probe output: `{"sequence":0,…}`, `{"sequence":1,…}`) — and dedup on it inside
`recordReceivedEvent`, which is the store's documented sole mover.

### ADJ-3. Zombie tool beats — the safety net has exactly one caller, and it is on the path that does not fire — **PROVEN BY ENUMERATION**

`finalizeRunningToolCalls` (`src/state/chat-messages.ts:597`) marks every still-`running` tool
call as `error` with an honest `incompleteReason` and no synthesised output. It has **exactly one
production call site**, enumerated tree-wide across `src/`: `src/client.ts:2104`, inside the
`done` listener (`client.ts:2090`).

It is **not** called from the `error` listener (`client.ts:2277-2311`), nor from the
transport-loss branch (`client.ts:2294`), nor from `controller.close()` (`client.ts:2314`).

So **every run that ends without a `done` frame leaves its in-flight tool beats spinning
"running" forever on screen** — and §A1 proves exactly how a run ends without `done`: a
disconnect on either connection aborts the run and the handler emits `error`
(`run.ts:1724-1728`), never `done` (`run.ts:1677`).

Server side, `tool_calls` rows are created `status: "running"` at `run.ts:337-345` and there is
exactly **one** writer that finalises them — `persistToolResult` → `db.updateToolCall`
(`run.ts:486`). Enumerated tree-wide across `server/`: **no reconciler, no sweeper, no
startup pass** exists. A process restart between `tool_call_start` and `tool_result` orphans the
row permanently; `chat-history.ts:24` correctly omits it from the LLM history, and
`toolCallToView` serves it to the UI as "running" on every subsequent reload.

*Honest limit:* I did **not** drive the process-restart case — the reachability above is
established by single-writer enumeration, not by execution. The client-side half (one call site,
`done` only) is settled by enumeration and is not in doubt.

### ADJ-4. `openSseStream` writes `retry:` but never `id:` — resumption is not merely unused, it is unavailable

`server/sse.ts:337` writes `retry: <ms>`, so the browser *is* told to reconnect. No frame carries
an `id:` field and `Last-Event-ID` is never read (counted from bytes across `sse.ts`: **0**
occurrences of either). So even if the run survived a disconnect, the client would have no way to
resume without replaying from the start. **This is why §A6 step 4 is not optional** — telling a
client to reconnect to a stream it cannot resume, on a server that deletes the run on
disconnect, is three mechanisms pointing in three directions.

---

# §4. SEVERITY, restated as data

| # | finding | verdict | severity | class |
|---|---|---|---|---|
| A-1 | `GET /api/run/:runId/stream` executes the run; N connections = N executions | **PROVEN** (2 provider POSTs, 2 tool executions, 2 assistant rows) | **CRITICAL** | duplicate spend + duplicate effects |
| A-2 | Either connection closing aborts the shared run | **PROVEN** (Probe 3) | **CRITICAL** | availability |
| A-3 | A dropped connection makes the run permanently unreachable (404) | **PROVEN** (Probe 4) | **HIGH** | availability + the false premise in `run-ownership.ts:26-31` |
| A-4 | `ActiveRun.isStreaming` written 4×, read 0× | **PROVEN** (byte count) | MEDIUM | §21 inert |
| B-1 | Large conversation cannot be opened / fails silently | **NOT PROVEN — fixed and guarded** | — | entry is stale |
| B-2 | `POST /api/run/start` reads the whole conversation, twice | **PROVEN** (2,093 ms @ 21k; linear to 1,102 ms @ 40k for one of the two walks) | MEDIUM | unbounded read |
| ADJ-1 | Single-tenant transcript store, defended by a mechanism that kills runs | PROVEN (in-source + Probe 4) | HIGH | correctness under concurrency |
| ADJ-2 | Sweep tick counter double-counts; ids minted per-receipt defeat any dedup | PROVEN-BY-STRUCTURE | MEDIUM | counting |
| ADJ-3 | Zombie tool beats: safety net wired to `done` only; no server reconciler | PROVEN-BY-ENUMERATION | MEDIUM | stuck UI state |
| ADJ-4 | SSE emits `retry:` but no `id:`; `Last-Event-ID` unread | PROVEN (byte count) | MEDIUM | resumption impossible |

---

# §5. COVERAGE

**What I DROVE** (real router, real SQLite, real `executeToolCall`, ephemeral ports, temp DBs):

- Two concurrent SSE connections to one `runId`, fixture provider — frame counts per connection
  and DB row counts (Probe 1).
- The same against a **real HTTP provider I stood up and instrumented** — request count and
  request size at the wire (Probe 2). This is the spend evidence.
- Close-one-connection-kill-the-other, with an ordered event trace (Probe 3).
- Reconnect after a drop — status, content-type and body (Probe 4).
- A **21,000-message / 5,250-tool-call / 58.0 MB** conversation built through `DbClient`, then
  `/history`, `/messages`, `/tool-calls`, `/timeline`, `/metrics`, `/history/older`, and a
  1-message control, all timed and sized.
- `POST /api/run/start` and `GET .../stream` against that conversation.
- A six-point scaling table (200 → 40,000 messages) for `getChatHistoryPage`, `listMessages` and
  `buildConversationHistory`.

**What I READ** (and where the claim rests on reading, I have said so):

- `server/routes/run.ts` in full; `server/routes/chats.ts` in full; `server/chat-history.ts` in
  full; `src/cockpit/flow/run-ownership.ts` in full; `src/cockpit/sweep/sweep-data.ts` in full.
- Targeted regions of `server/db/client.ts` (`pageAllRows`, `pageMessagesBackwards`,
  `getChatHistory`), `src/client.ts` (`openRunStream`, `readChatHistory`, the `done`/`error`
  listeners), `server/sse.ts`, `server/config.ts`, `server/blocks/compose.ts`,
  `server/blocks/custody.ts`, `src/cockpit/flow/run-stream.ts`, `src/cockpit/sweep/sweep-store.ts`,
  `src/state/chat-messages.ts`, `server/tool-executor.ts`.
- Call-site and phrase enumeration done in-process over **bytes** (`readFileSync` + `indexOf` /
  line scan), never `grep` — §8b.7. Where I report a count, that is how it was obtained.

**What I did NOT establish — stated plainly:**

1. **I did not drive a duplicated WRITE.** The fixture provider requests `read_file`. That
   `edit_apply_patch` / `execute_command` would run twice is inferred from one dispatch table
   (`server/tool-executor.ts` `TOOL_HANDLERS`) reached by one code path, proven entered twice.
   Strong, but structural, not driven.
2. **I did not drive the process-restart orphan** in ADJ-3. The single-writer enumeration is
   solid; the reachability is argued, not executed.
3. **I did not drive a real browser.** Probes used Node `fetch`, not `EventSource`. The
   reconnect-produces-404 conclusion therefore rests on the HTML spec's "any status other than
   200 fails the connection" plus the measured server 404. A Chrome-driven confirmation would
   close that gap.
4. **I did not run either full suite** (instructed not to) and I ran **no** existing test file —
   every measurement is from a standalone probe outside both repositories. I therefore report
   **no suite line**. Nothing I did can have moved either baseline: both trees were and are
   unmodified by me.
5. **I did not test a proxy retry end to end.** The accidental-vector claim in §A4 rests on
   RFC 9110 §9.2.1 (GET is safe/idempotent, so intermediaries may repeat it) plus the driven fact
   that a repeat duplicates. I did not stand up nginx to watch it happen.
6. **I did not exhaust the "large conversation" surface.** I bounded the *chat* reads. A project
   with 3,000 chats, the chat list, and the Custody room's per-project fan-out
   (`server/blocks/custody.ts:628`) are unmeasured — ADJ-4-adjacent and worth their own pass.
7. **I could not read the two task entries** (§0). If they contain constraints the brief's
   paraphrase omitted, my scoping may be narrower than intended.

---

# §6. WORKFLOW FINDING (owed by every agent, §20)

**A brief that cites a tracker entry must carry the entry's anchor, not its title.** This brief
pointed at "the two task entries in `TASKS.md`". Neither exists there — established by bytes over
357,293 bytes for eleven distinct phrasings, all zero, and by a tree-wide `.md` walk of both
repositories. I spent the first portion of this task searching for a specification that had never
been written down, and the only real specification was the brief's own paraphrase.

**The cheap fix, and it is mechanical:** a brief that references a tracker entry cites
`TASKS.md:<line>` **plus the first eight words verbatim**. A coordinator generating briefs can
assert the quoted words occur exactly once in the file at that line before dispatching — the same
uniqueness assertion §11b already requires of a scripted edit's anchor, pointed at prose. A brief
whose anchor does not resolve is refused rather than dispatched.

**Why it matters beyond convenience.** The brief said *"several entries in that file have been
overturned today"* — which is exactly right about target B, and I could only establish that by
measurement because the entry itself was unreadable. An analyst who could not measure would have
had to either take the paraphrase on trust or report nothing. **An unresolvable citation converts
a checkable claim into a belief**, which is the failure mode this contract exists to prevent,
arriving through the brief instead of through the code.

---

# §7. THE FILES EVERY CLAIM RESTS ON — mtime and last-commit sha (§8b)

Web repo `HEAD = 32dc29f64e9dda245741a00bcd2b1b1ee0131ee7`, working tree **clean**
(`git status --porcelain` produced no output). Every file below is committed and unmodified, so
no claim here can be a "true when written, false six minutes later" artefact.

| file (relative to `web-interface-foundation-v1/`) | mtime | last commit |
|---|---|---|
| `server/routes/run.ts` | 2026-07-28 08:52:16 | `99c8bc8` |
| `server/sse.ts` | 2026-07-27 11:23:51 | `c33f284` |
| `server/routes/chats.ts` | 2026-07-27 15:17:41 | `c9f6eef` |
| `server/chat-history.ts` | 2026-07-27 15:10:02 | `9f2ade9` |
| `server/db/client.ts` | 2026-07-27 15:32:54 | `c9f6eef` |
| `server/config.ts` | 2026-07-28 04:26:22 | `0c7e536` |
| `server/blocks/compose.ts` | 2026-07-27 16:00:43 | `636a569` |
| `server/blocks/custody.ts` | 2026-07-27 05:45:08 | `2455a44` |
| `src/client.ts` | 2026-07-27 16:07:43 | `636a569` |
| `src/cockpit/flow/run-stream.ts` | 2026-07-27 03:45:08 | `3a28a23` |
| `src/cockpit/flow/run-ownership.ts` | 2026-07-26 21:38:00 | `809dba1` |
| `src/cockpit/sweep/sweep-store.ts` | 2026-07-26 18:52:56 | `54b75c3` |
| `src/cockpit/sweep/sweep-data.ts` | 2026-07-26 11:12:56 | `93df92d` |
| `src/state/chat-messages.ts` | 2026-07-27 08:44:27 | `daf44ee` |

`harness-main-v1` `HEAD = e800cd8c54edf92481a1fdfecd38806b8c92b51f`; the only working-tree entry
is ` M integration` (a submodule pointer). `TASKS.md` mtime `2026-07-28 16:16:17`, last commit
`aaa488f0282a0d15673297fa434c32cb9f4ab310` — i.e. the §0 absence was established against the
current committed tracker, not a stale copy.

**Probes.** Four standalone scripts, run with `node --experimental-strip-types` from the web repo
so the repo's own module resolution applied, each creating only its own `mkdtemp` database and
its own ephemeral-port servers. They live outside both repositories, in this session's scratchpad
(`probe-a.mjs`, `probe-a2.mjs`, `probe-b.mjs`, `probe-c.mjs`), and are reproducible as written.
No repository file, fixture database or shared artefact was created, modified or deleted.
