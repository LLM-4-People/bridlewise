---
layout: default
title: 'DATA-BOUNDARY DIAGNOSIS — the outbound LLM call, and the transcript store'
---

# DATA-BOUNDARY DIAGNOSIS — the outbound LLM call, and the transcript store

Read-only. Nothing in either tree was modified. Every number below came from BYTES (a driven
probe or a `wc`/`grep -c` on source), never from a `grep` hit count standing in for a fact.

**§8b clearance.** The writing agent's edits are confined to `integration/scripts/` and
`integration/test/`, mtimes `2026-07-28 15:33`–`18:44`. Every file this report blames has an
mtime of `2026-07-27 20:39` or earlier. Verified with `find -newermt` and `ls --time-style`.
Nothing here is a race with the writer.

---

# TARGET A — "SECURITY: the outbound LLM call is not redacted at all"

## A.1 VERDICT: **NOT PROVEN — and the claim is badly overstated.**

It is not merely wrong at the margin. I drove the real wire and captured the exact bytes handed
to the provider. **12 of 18 planted categories were masked**, including every credential class.

```
probe: buildLLMMessages(plant, {}) → last message content
MASKED   provider-api-key-literal   "export const KEY = \"[REDACTED:token]\";"
MASKED   aws-access-key             "[REDACTED:api-key]"
MASKED   password-assignment        "password = \"[REDACTED:credential]\""
MASKED   email                      "Contact me at [REDACTED:pii] for the invoice."
MASKED   public-ip / phone / credit-card / ssn / jwt / private-key-pem / db-url / env-dump
VERBATIM username, internal-ip, abs-home-path, file-content-plain, mac-address, full-name
TOTAL plants=18 masked=12 verbatim=6
```

And the full-stack drive, with `globalThis.fetch` replaced by a capture double and
`HARNESS_LLM_CONFIG_PATH` pointed at a scratch config — this is the **actual provider request
body**, 977 bytes, `POST http://127.0.0.1:1/v1/chat/completions`:

```
--- user ---      my db password is [REDACTED:secret] please connect
--- assistant --- Connecting with [REDACTED:secret] now.
--- assistant --- tool_calls: [{… "arguments":"{\"path\":\"/home/example/.aws/credentials\",
                  \"note\":\"aws_secret_access_key = \\\"[REDACTED:credential]\\\"\"}"}]
--- user ---      also here is my key [REDACTED:token] and my email [REDACTED:pii]
```

The server's **own provider API key**, planted in the user prompt, did not reach the wire.
Redaction on the outbound path is real, load-bearing, and it works.

**Anyone reporting "not redacted at all" did not drive it.** Per the instruction that
overstating costs as much as missing: this entry should be struck and replaced by A.4 and A.5
below, which are the two things that are actually wrong.

## A.2 THE HOPS, `file:line`

Every byte from user input to provider request body:

| # | hop | `file:line` |
|---|---|---|
| 1 | route accepts prompt, verifies chat ownership | `web/server/routes/run.ts:756` |
| 2 | system prompt + trimmed history assembled | `web/server/context-bridge.ts:445` `buildLLMInput` |
| 2a | system prompt = name + **absolute path** + file listing + tool list + prefs | `web/server/project-context.ts:214` `buildSystemPrompt` |
| 2b | repo map injected | `web/server/context-bridge.ts:425` |
| 2c | memories injected (redacted per entry) | `web/server/context-bridge.ts:471` `injectMemoriesIntoPrompt` |
| 3 | **THE CHOKE POINT** — every string redacted + deduped | `web/server/llm-bridge.ts:259` `buildLLMMessages` |
| 3a | whole turn redacted together | `web/server/llm-bridge.ts:307` → `redaction.ts:254` → `redaction-engine.ts:502` |
| 3b | tool-call arguments redacted JSON-aware | `web/server/redaction.ts:270` `redactToolCallArguments` |
| 4 | user is told, via a `redaction` SSE event | `llm-bridge.ts:477` → `run.ts:1188` |
| 5 | recorded as one `llm` effect | `web/server/llm-bridge.ts:379` `recordProviderStream` |
| 6 | provider stream opened | `web/server/llm-bridge.ts:533` `client.stream(messages, …)` |
| 7 | **the single HTTP call** | `integration/src/shared/llm/client.ts:561` |

## A.3 THE CHOKE POINT — one door in the web server, a second door in the harness

**In the web server there is exactly one door.** `new SharedLLMClient` appears once
(`llm-bridge.ts:171`); `streamChat` is the only exported streamer; `buildLLMMessages` is
unconditional at `llm-bridge.ts:473`, before the `CompleteOptions` are even built. The web
server does not import `provider-adapter.ts` at all (the only hit is a *type-only* re-export at
`server/canonical.ts:365`). `landlock-runner.ts:21-28` records that an earlier design was
rejected precisely because "it would have opened a second path to the model that skipped
`streamChat`".

**Across the estate there IS a second door, and it does not redact.**
`integration/src/runtime/provider-adapter.ts:224` constructs its own `SharedLLMClient` and
streams `request.messages` straight through (`:246`, `:262`) — **zero occurrences of
`redact` in that file**. It is the harness CLI / agent-runtime / evaluation path
(`evaluation/cli.ts:7`, `agents/agent-runtime.ts:9`, `runtime/interactive-session.ts:8`), plus
4 experiment scripts. Different application, same provider, no redaction.

- *Proven*: the file constructs a client and sends `request.messages` unredacted.
- *Not established*: whether any currently-shipping harness command sends user PII through it.
  I did not drive the CLI.

## A.4 **PROVEN DEFECT — the turn-wide credential learning is WIRED BUT INERT below 12 characters**

This is the finding that matters, and it is the exact "wired-but-inert" class §8 names.

`llm-bridge.ts:280-298` states the contract in its own words:

> *"A credential is declared ONCE — **"my password may be admin44"** — and is a secret in every
> message after that, including ones that mention it with nothing beside it and a reply that
> repeats it back. … `redactTurnTogether` collects what any message declared, then redacts every
> message knowing it — by byte equality, exact and escaped."*

**Driven: it does not do that, for its own named example.**

```
redactMessagesTogether(["my password may be admin44", "ok, admin44 noted", "admin44"])
  spans on msg 0:  declared-credential:"admin44"
  learnedCount = 1                      ← the learning REPORTS success
  -> "my password may be [REDACTED:credential]"
  -> "ok, admin44 noted"                ← LEAK
  -> "admin44"                          ← LEAK
```

The boundary is a clean, deterministic step at **12 characters**:

```
mixed-class value, declared then echoed:
len= 6 …len=11   rememberable=true  learned=1  echo=LEAK    (6 of 6)
len=12 …len=14   rememberable=true  learned=1  echo=masked  (3 of 3)
```

And on realistic follow-up shapes, with `admin44` declared in message 0:

```
LEAK | assistant echo, no cue        "Right — I will use admin44 for the connection."
LEAK | user repeats it bare          "admin44"
LEAK | user quotes it in a command   "run: mysql -u root -padmin44"
LEAK | tool result contains it       "stdout: Authenticated as root (admin44)"
LEAK | assistant writes it to a file "I wrote admin44 into config.yml"
5 of 5 follow-up shapes leak the declared value to the provider.
```

`Tr0ub4dor&3xy` propagates and looks like the feature working — it does not. It is 13
characters and is caught **independently** by the entropy layer; the marker gives it away
(`[REDACTED:secret]`, the identity category, versus `[REDACTED:credential]` for the declaration
layer). Remove the length coincidence and the learning contributes nothing.

### The mechanism, `file:line` — two floors for one decision, and they disagree

```
integration/src/privacy/secret-intelligence.ts:353   MIN_REMEMBERABLE_LENGTH = 6
integration/src/privacy/secret-intelligence.ts:370-378
      rememberableDeclaredValue(v):  v.length < 6 → false   ← the ACCEPT gate
integration/src/privacy/redaction-engine.ts:516
      if (seen.has(value) || !rememberableDeclaredValue(value)) continue;
      learned.push(value)             ← accepted at 6, counted, threaded at :538-540
integration/src/privacy/secret-intelligence.ts:263
      buildEphemeralScanList(additional)
integration/src/privacy/secret-intelligence.ts:314-328
      for (const variant of escapeVariants(value)) …
integration/src/privacy/secret-intelligence.ts:104   MIN_KNOWN_SECRET_LENGTH = 12
integration/src/privacy/secret-intelligence.ts:176
      return [...out].filter((v) => v.length >= MIN_KNOWN_SECRET_LENGTH);   ← the DROP
```

`escapeVariants` was written for the **persistent** registry, where 12 is correct and its
docstring says why ("registering `"true"` would mask the word 'true' forever"). The ephemeral
path reuses it verbatim, and inherits a floor written for a different blast radius. The result
is that a value of 6–11 characters is accepted by the remembering gate, counted in
`learnedCount`, threaded into `declaredValues`, and then **silently reduced to an empty variant
list** — `knownSecretSpans("ok, admin44 noted", ["admin44"])` returns `[]`, driven.

`MIN_REMEMBERABLE_LENGTH`'s own docstring (`:347-351`) is the proof that 6 is the intended
number for this path: *"The floor can be as low as it is ONLY because the scope is one call.
These values are never registered, never persisted… A PERSISTENT registry would need a much
higher bar."* The code then applies the persistent registry's bar anyway.

**And the user is told the wrong thing.** The `redaction` SSE event reports
`maskedCount=1` — one value hidden — on a turn where one value was hidden and **one identical
value went out**. §21's rule applied to a notice: a correct count over the spans it applied is
not a correct answer about the turn.

### Why it shipped green

`web/tests/prevention/redaction-reaches-provider.test.ts:304-310`:

```ts
test("the model is never handed the value when asked to repeat it", async () => {
  await sendAndCapture(ids, `my password may be ${DECLARED}`);
  const { messages } = await sendAndCapture(ids, "what is my password");
  const user = messages.filter((m) => m.role === "user").at(-1);
  expect(user?.content).not.toContain(DECLARED);
});
```

`.at(-1)` is the message **"what is my password"**, which never contained `admin44`. The
assertion is vacuous — it cannot fail, with or without the feature. The leak lives in the
*history* messages and in the *assistant* role, and the test looks at neither. This is §21's
"a correct region is not a correct answer" in its purest form: the assertion is over the right
conversation and the wrong message.

## A.5 **PROVEN — the shipped default contradicts the 2026-07-28 decision**

Decision 4 (TASKS.md:4907-4928): *"PII DETECTORS: SUPPORTED, INDIVIDUALLY CONFIGURABLE, **OFF BY
DEFAULT**"*, naming *"email, username, internal ip address and 'pii' like that"*.

Measured from the live registry:

```
PII_TYPES total: 14      detected: 12      unsupported: person-name, street-address
tiers ON by default: 5 of 5      disabledTypes: 0
enabled detector ids (13): aba-checksum, declaration, declared-then-known, e164-grammar,
  email-grammar, iban-mod97, ipv4-grammar, ipv6-grammar, known-secret, luhn-checksum,
  secret-signals, us-ssn-rules, value-intrinsic
has a username type: false
```

`integration/src/privacy/privacy-config.ts:29-38` sets all five tiers `true`, and says so in
writing: *"**ALL FIVE ARE ON.** A privacy control that ships off is a privacy control nobody
has; the user's instruction was 'do all tiers'."* That instruction is the **older** one.
Decision 4 supersedes it and the config was never revisited.

Three concrete mismatches, each measured:

1. **Email is masked by default.** `email-grammar` is on; probe: `jane.doe@acme-corp.example`
   → `[REDACTED:pii]`. The decision says off.
2. **Internal IP is not detected at all** — the opposite of "supported, off by default".
   `pii-registry.ts:172-181` states the design: *"private and loopback ranges left alone because
   they identify nobody."* Probe: `192.168.1.77` and `10.0.0.4` verbatim, `8.8.8.8` masked.
3. **Username does not exist as a type.** Zero entries in `PII_TYPES` match user/account-name.
   Probe: `USER=example` verbatim on the wire.

### The structural problem that makes "off by default" non-trivial

**The tier axis and the PII/credential axis are not aligned.** `grammar-defined` contains
`email-address`, `ip-address`, `phone-number` **and** `provider-credential`
(`pii-registry.ts:162-213`). Switching that tier off to satisfy "email off by default" also
disables published-key-format detection — i.e. turning off a privacy preference turns off a
security control. The per-*type* switches (`registrations/privacy.ts:100-117`) are the correct
lever and they all default `true` (`:107`).

### What must be true for enabling one to take effect on the outbound path

Today, a flipped switch does reach the detector — `registrations/privacy.ts:87-91` calls
`setPrivacyTierEnabled` → `pii-registry.ts:373` mutates `liveSettings` → invalidates the
snapshot → `redaction-engine.ts:397` reads `currentPrivacySettings()` on the next call. The
wiring is live. **Three things are wrong with it:**

1. **It is process-global, not per-user.** `liveSettings` (`pii-registry.ts:337-340`) is one
   module-level object in the server process. One admin's flip changes what is masked for
   **every** user's outbound calls. That is a tenancy defect in the privacy layer itself.
2. **It does not survive a restart.** Nothing persists the value; `setSchemaCustomization`
   (`web/server/schema/ui-schema.ts:348-366`) validates and calls `set`, and stops there. So
   "off by default" would silently re-assert itself on every restart, which is the worst
   possible failure mode for a control the user deliberately turned **on**.
3. **It disobeys decision 1.** These are not declared in the global schema with a scope and
   resolved by the one resolver; they are a registration with an in-memory setter.

## A.6 WHAT REACHES A PROVIDER TODAY — enumerated, measured

Everything below was read off a captured request body or the assembling source.

| category | reaches provider? | evidence |
|---|---|---|
| user prompt | yes, redacted | `llm-bridge.ts:336-342` |
| full conversation history (user + assistant) | yes, redacted | `llm-bridge.ts:318-331` |
| tool-call **arguments** JSON | yes, redacted JSON-aware | `redaction.ts:270`; captured body shows `[REDACTED:credential]` inside escaped JSON |
| tool **results** (file contents, stdout) | yes, redacted as plain text | captured body, `role:"tool"` |
| **absolute project path** | **yes, verbatim** | `project-context.ts:228`; captured body: `Project path: /home/example/code-harness-workspaces/harness-main-v1` |
| **project file listing** (dirs + filenames) | **yes, verbatim** | `project-context.ts:145-179` `buildFileListing`, capped by depth + count |
| repository map | yes | `context-bridge.ts:425` |
| tool names + descriptions | yes, verbatim | `project-context.ts:183-188` |
| retrieved memories | yes, redacted per entry | `context-bridge.ts:483-494` |
| user prompt prefs + `systemPromptOverride` | yes, verbatim | `project-context.ts:224-231` |
| **environment variables** | only via tool output; **not** intrinsically redacted | captured body kept `HOME=/home/example`, `USER=example` |
| the server's own provider API key | **no** — registered at read time | `llm-bridge.ts:113` `rememberOwnCredential`; probe confirmed masked |

**The honest summary of the leak surface that is *by design*:** absolute home paths, the
operating-system username embedded in them, and the project's file tree go to the provider
verbatim on every single call. That is a deliberate consequence of A.5 (no username / path
detector) and it should be recorded as a decision, not discovered later as a bug.

## A.7 §0 LADDER VERDICT — Target A

**Rung reached: 4**, with a real rung-3 available for the specific defect in A.4.

- **Rung 1 (physically impossible).** *Unavailable because* the outbound call is an HTTPS request
  from an unconfined Node process; there is no OS or engine primitive that can inspect a TLS
  payload for a declared credential. The `setAuthorizer` lever that `TENANT-SCOPING-CHECK`
  proved for the DB has no network analogue. Egress-blocking the provider is not the invariant —
  the call must succeed and be clean.
- **Rung 2 (unrepresentable).** *Unavailable because* the provider contract is
  `ChatMessage.content: string`. Any type that made an unredacted string unrepresentable
  (`Redacted<string>`) would still need one `unsafeCoerce` at the boundary where the redactor
  produces it, so the bad state stays representable exactly where it matters. **But a narrower
  rung-2 IS available and should be taken**: `escapeVariants` currently takes only a value, so
  the two floors are invisible to each other. Give it a required floor argument —
  `escapeVariants(value, minLength: number)` — and *neither* caller can inherit the other's
  bar by accident. Forgetting becomes a compile error. This is the fix for A.4's class, not
  just its instance.
- **Rung 3 (unreachable by shape).** Partially held already: `streamChat` is the only exported
  streamer and `buildLLMMessages` runs before `CompleteOptions` exist, so the redaction is not
  skippable within the module. It is *not* held against `provider-adapter.ts` (A.3), which
  constructs its own client. The available rung-3 move is to make `SharedLLMClient.stream`
  refuse a `ChatMessage[]` that did not come from a redactor — a branded message type minted
  only by `buildLLMMessages`, so `provider-adapter.ts` fails to compile until it redacts too.
- **Rung 4 (runtime choke point).** **Where it sits today**, correctly, at `llm-bridge.ts:473`.
- **Rung 5.** Not used and should not be — no source scan is involved.

**The class-level statement:** the defect in A.4 is not "a floor is 12 instead of 6". It is
**one function answering two questions with one constant**. A scan for other reuses of
`MIN_KNOWN_SECRET_LENGTH` finds `:157`, `:176` and `:203` — `:203` is the persistent
`registerKnownSecret` path, where 12 is right. Two callers, one constant, opposite blast
radii. Rung 2 (the required argument) is the only fix that ends the class.

## A.8 THE FIX — precise enough to implement

**Fix 1 — A.4, the inert learning (HIGH; this is a live leak).**

1. `integration/src/privacy/secret-intelligence.ts:153` — change the signature to
   `function escapeVariants(value: string, minLength: number): readonly string[]`. Replace both
   internal uses of `MIN_KNOWN_SECRET_LENGTH` (`:157`, `:176`) with `minLength`. **No default
   value** — the point is that omitting it is a compile error.
2. `:314` `buildEphemeralScanList` — pass `MIN_REMEMBERABLE_LENGTH` (6).
3. `:203` `registerKnownSecret` — pass `MIN_KNOWN_SECRET_LENGTH` (12), unchanged behaviour.
4. Record in source at `:314` *why* the ephemeral floor is lower, citing `:347-351`, which
   already argues it.

Do **not** simply lower `MIN_KNOWN_SECRET_LENGTH` to 6. That would let a 6-character value into
the *persistent* registry, which is the content-shredder the constant exists to prevent.

**Fix 2 — A.5, the default (MEDIUM; a decision compliance gap, not a leak).**

The tier axis cannot express the decision. Do not disable a tier.
1. `privacy-config.ts` — keep `DEFAULT_PRIVACY_TIERS_ENABLED` all-true, and change
   `DEFAULT_PRIVACY_TYPES_DISABLED` (`:49`) from `[]` to
   `["email-address", "ip-address", "phone-number", "national-id", "payment-card",
   "bank-account", "bank-routing", "declared-personal-identifier"]` — i.e. the PII half,
   derived rather than typed out: `PII_TYPES.filter(t => intelligenceCategory-of(t) === "pii")`.
   The credential half (`known-secret`, `provider-credential`, `high-entropy-value`,
   `declared-credential`) stays on. Rewrite the `:20-23` docstring, which currently cites the
   superseded instruction.
2. Add `username` and `internal-ip-address` as declared types. Internal IP is a *narrowing* of
   the existing `ipv4-grammar` — the private/loopback ranges it presently skips — so it costs a
   detector id and a registry entry, not a new engine.
3. Persist and scope the switches per decision 1: declare each in the global schema with a scope
   and a default, resolve through the one resolver, and stop using process-global `liveSettings`
   as the store. Until that lands, **state in the settings surface that the switch is global and
   resets on restart** — §5b: absence is stated, never guessed.

**Fix 3 — A.3, the second door (MEDIUM).** Either route `provider-adapter.ts` through the same
redactor, or record in `provider-adapter.ts`'s header that it is deliberately unredacted and
which application owns that decision. Today it says neither.

## A.9 THE TEST THAT WOULD HAVE CAUGHT IT

**For A.4 — deterministic, mechanical, with a stated population and a plant.**

*Population*: every integer length in `[MIN_REMEMBERABLE_LENGTH, MIN_KNOWN_SECRET_LENGTH + 2]`
— derived by importing both constants, so widening either one widens the test with no edit.
That is 9 lengths today and the number is not written down anywhere in the test.

*Assertion*, per length `n`, over a mixed-class value of exactly that length:

```ts
const secret = mixedClassValueOfLength(n);            // two char classes, not a placeholder
const r = redactMessagesTogether([
  `my password may be ${secret}`,   // declaration
  `right, I will use ${secret}`,    // echo with NO declaration cue  ← the load-bearing one
  secret,                           // bare repeat
]);
if (rememberableDeclaredValue(secret)) {
  expect(r.learnedCount).toBe(1);
  for (const [i, t] of r.redacted.entries())
    expect(t, `message ${i} leaked a value the engine reported it had learned`)
      .not.toContain(secret);
}
```

The invariant is stated as an **implication**, which is what makes it mutation-proof:
*if the engine reports it learned a value, no message may contain it.* A future change that
raises the remembering floor makes the test skip those lengths honestly rather than fail
spuriously; a change that keeps reporting `learnedCount` while dropping the value fails.

*The plant, at the entry point a real caller uses* (§21): drive `buildLLMMessages` — not
`redactMessagesTogether` — for at least one length below 12, and assert on the **serialized
message array**, because that is what `client.stream` receives. Driving the inner helper is
exactly the mistake §21 names.

*Mutations, all three shapes:*
- **ABSENT** — delete the `declaredValues` threading at `redaction-engine.ts:538-540` → must red.
- **DIFFERENT NAME/SHAPE** — change `rememberableDeclaredValue`'s floor to 20 → the implication's
  antecedent goes false and the test must **skip**, not pass silently; assert the skip count
  changed, or the guard proves nothing.
- **INERT (mandatory)** — leave `buildEphemeralScanList` in place and discard its result
  (`return EMPTY_SCAN` after computing it). This is precisely today's live behaviour for n<12,
  so the guard must red on it. **A guard that passes this mutation is the guard that let the
  current defect through.**
- **Liveness proof before judging any escape** (§8): assert `learnedCount === 1` and
  `r.redacted[1] !== originals[1]` for a control at n=12, so "the guard is weak" and "the
  mutation was inert" are distinguishable.

**For A.5** — a conformance test over the registry, not a list: for every `PiiType` whose
`intelligenceCategory` is `"pii"`, assert `typeEnabled(type, DEFAULT_PRIVACY_SETTINGS) ===
false`; for every credential type, `=== true`. Population is `PII_TYPES`, so a type added
tomorrow is covered without anybody remembering.

**For the vacuous existing assertion** — a meta-guard worth its weight: in
`redaction-reaches-provider.test.ts`, assert on `wire(messages)` (the whole serialized array)
rather than on `.at(-1)`. A single-message assertion in a test whose subject is a
*conversation* is the shape to ban.

---

# TARGET B — "Transcript store is single-tenant: a background run's tokens land in the foreground conversation"

## B.1 VERDICT: **PROVEN as a defect, REPRODUCED — and it is a BUG, not a BREACH.**

The store is genuinely single-tenant. I reproduced the contamination twice. But the blast radius
is **one browser, one user, display only** — and the server-side record is correct.

## B.2 REPRODUCTION — driven

Both runs are against the real `src/state/chat-messages.ts` (loaded in Node through a
`module.registerHooks` extension resolver; no repo file touched).

**R1 — two runs' tokens merged into one assistant message, no chat switch needed:**

```
appendUserMessage("A: what is 2+2?"); appendAssistantMessage("");
appendStreamingTail("Four");            // run A
appendStreamingTail(" — and BANANA");   // run B, same store
commitStreamingTail();
→ ["user:A: what is 2+2?", "assistant:Four — and BANANA"]
```

**R2 — the legacy shell: switch chat mid-run, and the old run keeps writing into the new chat:**

```
appendUserMessage("B: dump the prod secrets"); appendAssistantMessage("");
appendStreamingTail("Here is the first half");
clearMessages(); setMessages([chat A's two messages]);   // user clicks chat A
  → ["user:A: hello", "assistant:A: hi"]
// run B's EventSource is STILL OPEN — nothing closed it. Its next turn arrives:
appendAssistantMessage(""); appendStreamingTail("...and the prod key is sk-live-XXXX");
appendToolCall({name:"read_file", …}); commitStreamingTail();
  → ["user:A: hello", "assistant:A: hi",
     "assistant:...and the prod key is sk-live-XXXX", "tool:"]
```

Chat A's transcript now contains run B's answer and run B's tool call.

## B.3 THE MECHANISM, `file:line`

- `web/src/state/chat-messages.ts:196` — `export const messages = atom<readonly ChatMessage[]>([])`.
  **One atom. No chat key, no run key.**
- `web/src/client.ts:2351` — `function ingestModelEvent(event: ModelEvent): void` — takes the
  event and **nothing else**. No chatId parameter, no comparison against `currentChatId`.
  It is called at `client.ts:1880` from the `model` SSE listener.
- `web/src/state/chat-messages.ts:467` `commitStreamingTail` — scans **backwards for the last
  assistant message** in whatever the atom currently holds.
- `web/src/state/chat-messages.ts:448` `appendStreamingTail` — appends to a single global string.
- `web/src/cockpit/flow/run-ownership.ts:7-21` states the whole defect in source, unprompted:
  *"`messages` is 'the current chat's messages' … written by `client.ts` with no chat check at
  all — `ingestModelEvent` appends to whatever is in the atom. … B's words end up inside A's
  transcript, in the store, before the flow ever sees them."*

**The information to fix it is already on the wire and thrown away.** The `connected` SSE event
carries the run's bound `chatId` (`run.ts:965`, parsed at `client.ts:1866-1871`) — and
`ingestModelEvent` never consults it.

## B.4 BLAST RADIUS — the bug/breach question, settled

**Cross-user is refused at the server. This is not a breach.**

```
web/server/routes/run.ts:937-951
  router.get("/api/run/:runId/stream", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const active = activeRuns.get(runId);
    if (active === undefined) throw new NotFoundError(…);
    if (active.userId !== user.userId)
      throw new ForbiddenError(`Run ${runId} belongs to another user`);
```

A user cannot subscribe to another user's run stream. Two different users' tokens can never
meet, because they are never delivered to the same browser. **The contamination is between two
conversations of the SAME user, in the SAME browser session.**

**One residual path where it could become cross-user — mechanism proven, impact not driven.**
`resetRunOwnership()` (`run-ownership.ts:173`) has a docstring reading *"Forget everything
(sign-out / tests). Closes any open stream."* — and **zero production callers** (`grep`
across `src/**` excluding tests: 1 hit, the definition). Logout closes exactly one stream:

```
web/src/client.ts:3046   if (activeStreamController !== null) { activeStreamController.close(); … }
```

and `activeStreamController` is assigned **only** on the legacy path (`client.ts:1134`, inside
`beginChatRun`). `beginCockpitRun` never assigns it. `src/state/reset-all.ts` contains no stream
close at all. So in the cockpit shell a run in flight at logout keeps its already-authenticated
EventSource open across `resetAllStores()`, and would write user A's tokens into the store the
next user sees in that tab.

- *Proven*: zero callers, no cockpit-side close, no close in `reset-all.ts`. All byte facts.
- *Not established*: I did not drive a browser logout/re-login. Whether the server tears the
  socket down on session invalidation is unmeasured. **Do not report this as a confirmed
  cross-user leak until that is driven.**

## B.5 IS IT RECORDED WRONGLY TOO? **No — the ledger is correct.**

Only the display is wrong, and it self-heals on reload.

- Messages are written with the run's **server-side** `chatId` and `userId`, never the client's
  view: `run.ts:247-255` `db.createMessage({ chat_id: chatId, …}, active.userId)`, and again at
  `:328`, `:419`, `:563`.
- The chat is verified to belong to the caller **before** the run starts:
  `run.ts:756` — `if (!(await db.chatBelongsToUser(input.chatId, user.userId))) throw
  ForbiddenError`. The comment records that `createMessage` enforces it at the DB layer too.
- The timeline ledger (the known second tenant surface) is gated on both its doors:
  `routes/timeline.ts:113-116` filters client-supplied `runIds` through `db.allRunIdsForUser`,
  and `:156-161` denies an event whose `runId` the caller does not own, **including
  `runId === null`** — deny-by-default. `blocks/provenance.ts:299-320` resolves
  `allRunIdsForUser` once into a **synchronous** predicate, with an in-source note that an async
  predicate here would be "the quietest possible security failure" because a promise is truthy.

So B is a **rendering defect over a correct record** — which is the good version of this bug,
and worth saying plainly.

## B.6 THE SECOND DOOR — and it is the one served at `/`

The prompt predicted this and it is there.

`openRunStream` has **3 call sites** (plus its definition at `client.ts:1854`):

```
web/src/client.ts:1133              inside beginChatRun          ← NO run-ownership registration
web/src/cockpit/flow/run-stream.ts:373   beginCockpitRun         → noteRunStarted at :379
web/src/cockpit/flow/run-stream.ts:380   the reopen closure      → registered
```

**1 of 3 bypasses the entire mitigation.** `beginChatRun` (`client.ts:1114-1136`) never calls
`noteRunStarted`, so its run is invisible to `run-ownership.ts`: **not parked** on a workspace
switch (`run-ownership.ts:151`), and **not visible to `soleLiveRun()`** (`:120`), which is what
`ingest.ts:192`'s FROZEN rule reads. Both documented guards are inert for that door.

And that door is the **default UI**:

```
web/src/main.ts:26-38
  const wantsCockpit = new URLSearchParams(window.location.search).get("cockpit") === "1";
  if (wantsCockpit) { … bootCockpit … } else { mount(App, { target }); }
```

`?cockpit=1` gets the protected shell. **Plain `/` gets `App.svelte` → `ChatPanel`**
(`component-registry.ts:86` registers `"chat-panel"`), whose send path calls `beginChatRun`
(`ChatPanel.svelte:20`, `:78`, `:88`). The cut-over that would delete the old UI is still an
open task (TASKS.md:2926). R2 above is that shell.

The one guard the legacy shell *does* get is at the store: `clearMessages()`
(`chat-messages.ts:697-713`) resets `streamingTail`, which is why R2 needed the run's **next**
turn rather than the in-flight one. That guard is real and its docstring records the exact
defect it closed. It does not stop anything after the next `start` event.

## B.7 §0 LADDER VERDICT — Target B

**Rung reached: 5 (convention + two lifecycle guards on one of two doors).** Rung 3 is available
and is the right answer.

- **Rung 1 (physically impossible).** *Unavailable because* this is browser-local module state.
  There is no OS or engine mechanism that can refuse a write to a JavaScript atom. (The
  `setAuthorizer` lever `TENANT-SCOPING-CHECK` proved is a SQLite mechanism and has no analogue
  here — the store never touches SQLite.)
- **Rung 2 (unrepresentable).** **Available and worth it.** Today `messages: atom<ChatMessage[]>`
  can represent "the transcript" with no statement about *whose*. Replace it with
  `atom<Map<ChatId, ChatMessage[]>>` — or `atom<{ chatId: ChatId; items: ChatMessage[] }>` — and
  "a transcript belonging to no conversation" stops being expressible. Every append then
  *requires* a `ChatId`, which is rung 3 for the writers.
- **Rung 3 (unreachable by shape).** **The ship-first fix.** Give `ingestModelEvent` a required
  first parameter: `ingestModelEvent(chatId: ChatId, event: ModelEvent)`, and have it drop the
  event when `chatId !== currentChatId.get()`. `openRunStream` already receives the bound chatId
  in the `connected` event (`client.ts:1866-1871`) and already discards it. Because the argument
  is required, **both doors** are fixed by one edit and a third door written next year cannot
  compile without supplying it. ~20 lines.
- **Rung 4 (runtime choke point).** The chat-id comparison inside `ingestModelEvent` is the
  runtime half of the above; on its own it is bypassable by a caller that passes the wrong id,
  which is why the required-argument shape matters more than the check.
- **Rung 5.** Where it is today: two lifecycle guards (`run-ownership.ts` parking,
  `ingest.ts` freeze) that a second door does not participate in, plus `clearMessages`'s tail
  reset. `run-ownership.ts:33-38` **already says this**: *"The honest fix at that layer is a
  chat-keyed transcript store, which is not this territory."* It was right. This is that
  territory.

## B.8 THE FIX

1. **`web/src/client.ts:2351`** — `function ingestModelEvent(chatId: string, event: ModelEvent)`.
   First statement: `if (chatId !== currentChatId.get()) return;`. Required parameter, no
   default, no optional.
2. **`web/src/client.ts:1880`** — the `model` listener must carry the chatId. Capture it from the
   `connected` event (already parsed at `:1866-1871`) into the stream's closure and pass it
   through. Do the same for the `timeline` listener at `:1894` and for `appendToolCall` /
   `ingestToolCallDone` / `finalizeRunningToolCalls`, which have the identical shape.
3. **`web/src/state/chat-messages.ts:467`** — `commitStreamingTail(chatId)` likewise; refuse to
   fold when the atom is showing a different conversation, rather than folding into whatever
   assistant message is last.
4. **Wire `resetRunOwnership()` into logout** (`client.ts:3040`, beside the
   `activeStreamController` close), and make the cockpit path register its controller so logout
   closes it too. Zero production callers on a function whose docstring says "sign-out" is a
   defect independent of everything above.
5. Once 1–3 land, `run-ownership.ts`'s parking becomes a *performance* choice (don't stream a
   tab nobody watches) rather than a *correctness* guard — and its docstring should be rewritten
   to say so, because a comment claiming a correctness role it no longer holds is the next
   agent's trap.

## B.9 THE TEST THAT WOULD HAVE CAUGHT IT

*Population*: **every `openRunStream` call site**, discovered from the call graph rather than
listed — the whole defect is that one of three was missed. Today: 3.

*Structure*: split the ingestion into `ingestModelEventInto(store, chatId, event)` plus a thin
caller, so a plant costs three lines of synthetic state and **no mutation of a tracked file**.
This is `TENANT-SCOPING-CHECK`'s systemic workflow finding (TASKS.md:3818-3827) applied here:
*"A guard must be aimable at a fixture, or it cannot prove it is awake."* The current shape —
module-global atoms written by a module-private function — is exactly what prices the plant out.

*The behavioural assertion*, deterministic, no browser:

```ts
// two conversations, one store — the shape R1 and R2 both reproduce
setChat("A"); setMessages(historyOfA);
ingestModelEvent("B", { type: "start", … });            // a run bound to chat B
ingestModelEvent("B", { type: "text_delta", delta: "BANANA", … });
commitStreamingTail("B");
expect(serialize(messages.get()), "chat B's tokens landed in chat A")
  .not.toContain("BANANA");
expect(messages.get()).toEqual(historyOfA);             // byte-identical, not merely absent
```

*Mutations, all three shapes:*
- **ABSENT** — delete the `chatId !== currentChatId.get()` early return → must red.
- **DIFFERENT SHAPE** — instead of deleting the check, compare against the run's *own* chatId
  (`chatId !== chatId`, always false) → must red. Proves the guard catches "compared the wrong
  two things", not just "forgot to compare".
- **INERT (mandatory)** — keep the comparison, compute the boolean, **discard it** and append
  anyway. This is the mutation the current architecture would pass, and it is the one the
  project keeps rediscovering. Assert on evidence only the new path can produce: the **byte
  equality** of the untouched transcript, never on message *ordering* — the old path reproduces
  plausible orderings by accident.
- **Liveness first** (§8): before judging any escape, assert the mutant's transcript differs
  from the original's on the same fixture. `"[fallback]".includes("[]")` is false; the same
  trap is one careless fixture away here.

*A second, cheap guard that ends the "second door" class*: assert that every `openRunStream`
call site is reached through a function that also calls `noteRunStarted` — **or**, better, once
the fix lands, that `openRunStream` cannot be called without a `chatId`, which makes the guard
unnecessary. Prefer removing the possibility to enumerating its instances (§0).

---

# ADJACENT FINDINGS, with evidence

**AD-1 — the redaction notice under-reports (PROVEN, follows from A.4).** On a turn where a
6–11-character declared value is masked in one message and leaks in another, the `redaction`
SSE event reports `maskedCount=1`. Driven. The user is told the input was cleaned, and it was
cleaned incompletely. §21: a correct count over the spans that were applied is not a correct
answer about the turn. The notice should carry a *residual* claim, or say nothing about
completeness.

**AD-2 — #79, memory redacted at WRITE time (CONFIRMED as recorded, and the code agrees).**
`web/server/context-bridge.ts:475-482` states it in source: *"a per-entry pass cannot see the
entry beside it. A memory that DECLARES a credential is masked; a sibling memory that merely
repeats the value is not… the memories arrive **already masked from the memory WRITE path**, so
the declaration is gone before this function sees it. The fix belongs at the write path and is
not attempted here."* This is the **same shape as A.4** — a declaration masked in isolation and
its echoes let through — arriving through a different door. When the same shape returns through
two doors, the defect is in the model (§21): "mask this string" and "mask this conversation" are
different operations, and every helper must say which it performs. Note the §13 tension is real:
the write-time masking destroys the evidence needed to audit the read-time decision, exactly as
#79 records.

**AD-3 — the privacy switches are a process-global, unpersisted, admin-only surface (PROVEN).**
`liveSettings` at `pii-registry.ts:337-340`; write path `ui-schema.ts:348-366` with no
persistence; admin gate at `user-context.ts:123-136`. One admin's flip changes every user's
outbound redaction, and it resets on restart. This is a **third tenant surface**, alongside the
DB (covered by `TENANT-SCOPING-CHECK`) and the timeline ledger — and unlike those two it is not
in any guard's universe.

**AD-4 — `beginCockpitRun` attributes a run to whichever workspace is active *after* the await
(SUSPECTED, not driven).** `run-stream.ts:369` reads `activeWorkspaceId.get()` **after**
`await startRun(...)`, while `sendUserMessage(prompt)` at `:353` already wrote the user's turn
to the shared store **before** it. A workspace switch inside that window (measured elsewhere in
this repo at five to ten seconds — `Flow.svelte:1406`) attributes the run to the wrong
workspace. Additionally, `if (workspaceId !== null)` at `:376` means a null active workspace
leaves the run **entirely unregistered**. I did not drive either; both are readings of the
control flow.

**AD-5 — the timeline ledger remains a second tenant surface, and is currently gated
correctly.** No `user_id` column; every read gated at the route/block layer
(`routes/timeline.ts:113`, `:156`; `blocks/provenance.ts:299`). Consistent with what
`TENANT-SCOPING-CHECK` recorded as an uncovered gap — I found **no** ungated consumer of
`getTimelineQuery()` (4 consumers, all scoped). The fragility is unchanged: correctness rests on
every future caller remembering, and no guard covers it.

---

# COVERAGE

**What I DROVE (executed, output read):**
- `buildLLMMessages` over 18 planted categories → 12 masked / 6 verbatim.
- `streamChat` end-to-end with a `fetch` double + scratch `HARNESS_LLM_CONFIG_PATH` → the exact
  977-byte provider request body, headers, and the `onRedaction` notice.
- `redactMessagesTogether` / `knownSecretSpans` / `redactForLLMContext` / `detectSecretSpans`
  isolated, for 5 secret values.
- The length sweep 6→14, 9 lengths, `learnedCount` and echo-leak per length.
- 5 realistic follow-up shapes (assistant echo, bare repeat, command line, tool result, file
  write) → 5/5 leak.
- The exact 3-message live-report shape (declaration → question → answer) → **no** leak, because
  the answer carried its own cue. Reported, because it disproves the simplest version of the
  claim.
- `PII_TYPES` / `PRIVACY_TIERS` / `currentPrivacySettings()` / `enabledDetectorIds()` — counts
  from the live registry.
- `src/state/chat-messages.ts` loaded in Node: R1 (interleaved deltas) and R2 (legacy-shell chat
  switch), plus a tool-call append into a foreign transcript.

**What I READ (source, not executed):** `llm-bridge.ts`, `redaction.ts`, `sse.ts`,
`context-bridge.ts`, `project-context.ts`, `run-ownership.ts`, `ingest.ts` (header + freeze),
`run-stream.ts` (`beginCockpitRun`), `client.ts` (`beginChatRun`, `openRunStream`,
`ingestModelEvent`, `submitLogout`), `main.ts`, `routes/run.ts` (gating + persistence),
`routes/timeline.ts`, `blocks/provenance.ts`, `user-context.ts`, `schema/ui-schema.ts`,
`privacy/{pii-registry,privacy-config,redaction-engine,secret-intelligence}.ts`,
`shared/exposure/registrations/privacy.ts`, `runtime/provider-adapter.ts`,
`tests/prevention/redaction-reaches-provider.test.ts`.

**What I did NOT establish — stated, not guessed:**
1. **No browser was driven.** B's reproduction is at the store layer. The end-to-end
   click-path (two workspaces, a real chat switch mid-stream) is unmeasured.
2. **The logout cross-user path (B.4) is not driven.** Zero callers of `resetRunOwnership` and
   the absence of a cockpit-side close are byte facts; the *consequence* is a reading. Whether
   the server tears down an SSE socket on session invalidation is unmeasured. **This must not be
   reported as a confirmed cross-user leak.**
3. **`provider-adapter.ts` was read, not driven.** Its lack of redaction is a source fact; that
   a shipping harness command sends user PII through it is not established.
4. **Neither full suite was run** (per instruction). I ran no test file at all — every number
   here is from a standalone probe.
5. **AD-4 is a control-flow reading**, not a measurement.
6. **The false-positive cost of Fix 2 is unmeasured.** Turning the PII half off by default is
   what the decision asks for; I did not measure how much currently-masked content would then
   flow, which is the number the user should see before it ships.
7. **`escapeVariants`' other caller (`:203`, `registerKnownSecret`) was read, not mutation-tested.**
   Fix 1 must not change its behaviour, and I have not proven that it doesn't.
8. **The web repo's `noUncheckedIndexedAccess` test baseline (327 errors, S5-T1)** means no
   type-level guarantee in `web/tests/**` is enforced. A branded `ScanRoot` or a required floor
   argument — the rung-2 fix Fix 1 proposes — is erased at run time in the test tree today. The
   fix is still right; its *guard* is weaker than it looks until S5-T1 lands.
