# Timeline

The timeline domain: the append-only ledger of runs and effects, its schema, and the recording context.

## What each file does

- `ledger-primitives.ts` — the ledger-primitives module.
- `ledger-dig.ts` — the read-only ledger reader behind the trace CLI
  (`scripts/trace.ts`): opens its own `node:sqlite` connection with
  `readOnly: true`, never writes, and answers the recurring question shapes
  (a run in causal order grouped by turn, a trace, the newest events, the
  provider payloads, the failures) with the formatting and summary the CLI
  prints. Its SQL belongs here because the timeline ledger is engine-owned —
  beside the store's SQL, not in the web server tree.
- `recorded-effect.ts` — `recordEffect`/`recordEffectAsync` — wrap work so that performing it IS recording it. Each settled effect reports its kind, name, outcome, real duration, the CPU time it consumed and the heap growth it caused (`cpuMs`/`heapDeltaBytes`, measured by the shared delta probe), its redacted invocation arguments (`argsOf` — read once at emit time, carried on success, result-failure and thrown paths alike), and any documents it captured about its own work.
- `recording-context.ts` — The ambient recording context — who is acting, and within what.
- `rollback.ts` — the rollback module.
- `timeline-config.ts` — the timeline-config module.
- `timeline-sealing.ts` — the sealed originals: seals and opens the exact bytes of a document the operational projection masked (forensic AEAD, bound to ledger/event/sequence, digest-verified).
- `timeline-query.ts` — the timeline-query module.
- `timeline-recorder.ts` — the recorder over the durable store: effect records admitted by the execution-closure validators and appended to the store, the one pairing owner; it keeps NO in-memory closure (SCALE-CR1 C6: that copy grew ~1.6 KB per paired effect for the life of the process) — what is pending is the store's `pendingIntents()`.
- `timeline-schema.ts` — Timeline SQLite schema (S4-aligned, harness-owned, provider-neutral).
- `timeline-store.ts` — the timeline-store module: the append path, the lineage statements (`TIMELINE_LINEAGE_STATEMENTS`, each served by migration 11's `idx_event_log_effect_lineage`, SCALE-CR1 C5), the pending-intent scan, and the off-thread migration entry (`pendingTimelineMigrations`, `migrateTimelineFile`, SCALE-CR1 C10).
- `timeline-types.ts` — the timeline-types module.

## Append admission and attribution

The four public store append methods and thirteen recorder recording methods capture their JSON arguments through `ledger-primitives.snapshotLedgerInput` before field reads. It reuses the existing structural snapshot and forensic depth/node limits; accessors, proxies, non-record roots and non-JSON values are refused without evaluating caller getters. Paired evidence retains its separate allowed-field check. This contract covers recording arguments, not recorder construction options, ambient context providers or the standalone execution-closure API.

The store resolves intent/terminal lineage inside its existing `BEGIN IMMEDIATE` transaction before hashing. New intents cannot reuse an effect ID with an existing intent or terminal in the same ledger. A terminal requires exactly one same-ledger intent, no prior terminal and a matching event type. Its actor, all eight correlation fields, trace and span come from the persisted intent; its parent is that intent's actual event ID. Missing provenance stays absent. Caller provenance overrides are refused at both store and recorder terminal doors through the same ledger helper, including untyped callers. No migration rewrites ambiguous historical rows.

Observations are independent evidence. The recorder attributes them to the observer's current actor and merged correlation, even when the referenced effect is unknown or belongs to a different run. Observation inputs to the store therefore require their own actor. The recorder's existing restored-intent naming protocol remains unchanged.

Tests cover foreign/outside/restored contexts, arbitrary intent IDs, missing/ambiguous/duplicate/type refusals, rollback without row or chain advancement, indexed transaction-time lookup, real competing connections, and owned HTTP query/detail visibility. Concurrent workloads supplement the direct transaction witness; they do not guarantee a particular interleaving.

Document admission is shared by the store and effect fitter in `ledger-primitives.assertTimelineDocument`. Captured attachments carry at most one of `contentJson` or `orderedJson`; either can be empty. Inline digests must match the exact UTF8 text, with valid Unicode scalar sequences and no parsing or normalization. Neither inline field means a digest-only reference whose content cannot be verified here. Effect originals are admitted before fitting; stored bytes obey the configured ceiling. The direct store and fitter validate that ceiling against the existing root-policy domain. Optional effect records retain their internal own-undefined fields outside the captured document channel; this is not a getter-safety claim for arbitrary effect metadata or callbacks.

Read projections retain text and digest separately from parsed display content. The unkeyed chain covers event envelopes rather than attachments; each attachment's digest is admitted against its exact text. Workspace imports use bounded ascending pages through a captured tip and shared document integrity admission before both new appends and identity skips. Historical skips do not impose the target's current byte ceiling; new appends do. Import commits one event at a time, so a valid prefix can remain on later document failure, and source shards remain available.

The existing chain verifier now consumes one native SQLite iterator locally and synchronously, retaining its sequence, previous-hash and envelope recomputation authority. Explicit finally return resets the cursor on exhaustion, early failure and native next/row-extraction exceptions. This bounds row allocation rather than total work or read-snapshot lifetime. Workspace import finishes verification and rechecks its captured tip before any destination access; a corrupt chain or growth observed during verification refuses without a new target row. Later growth still refuses after any already committed prefix. Separate verification/page passes are not a transaction against hostile history rewrites. Unkeyed integrity is not cryptographic authentication, and none of this establishes writer quiescence, whole-import/Git atomicity, automatic recovery or power-loss durability.

## The operational projection and the sealed originals

Every append passes through ONE projection (`projectPayload` in `timeline-store.ts`), before the chain hash is computed, so the hash covers what was stored and no caller can name the bytes that reach SQLite. Documents go through `redactOperationalText` (the egress detector, minus the spans that are authenticated field ciphertext under the store key, so memory entries carried in the ledger stay readable); the failure text and the description go through `redactForLLMContext`. Identifiers, timestamps and document names are never masked (a masked id breaks the id a reader sends back): they are refused when they look sensitive (`timeline_sensitive_identifier`).

A document the projection changed is `protected`: its row holds the masked text and its digest, names the ORIGINAL's digest (`original_digest`), and the original is sealed in `event_document_originals` (`timeline-sealing.ts`: the forensic AEAD under the store key, bound to ledger, event and sequence, chunked at the forensic input bound, reassembled against the digest). Every other document is `exact`. A path that COPIES records (the workspace shard import) carries each event's ORIGINAL documents (`originalDocuments`), so the receiving ledger re-projects and re-seals them under its own key — a seal that cannot be opened refuses the import (`workspace_shard_original_unavailable`), never a masked copy labelled `exact`; and a rollback admits a pre-image only when its bytes are the ones the file effect RECORDED (`preimageDigest`), so a lost original refuses (`timeline_rollback_preimage_unavailable`) instead of writing masked text back (a3-correctness H-1). A SECRET FILE's pre-image (`.env`, a key, a credential store — `isSecretFile` over the path the effect document names) is projected through THE secret-file redactor `read_file` serves it through before the detector: every value hidden whatever its grammar (a `#` inside it, quotes, spaces — the detector's value grammar left most of such values in the clear, a3-correctness M-2), keys and comment markers kept. So an edited `.env`'s values are not stored as text in the projection while a rollback still restores the file exactly. The detector's own value grammar is unchanged: an assignment in any OTHER file (`password = 'a b#c'` in source) is still read by it (a stated residual, Deferred to the detector's corpus-measured owner). `originalDocuments(eventId, purpose)` is the one door to a sealed original; anything that does not open to exactly the named digest is refused (`timeline_sealed_original_unavailable`), and every opening of a seal through it — opened or refused — is audited (`timeline.original.open`: ledger, event, document names, the caller's purpose `rollback` or `workspace-shard-import`, outcome; never bytes — a3-design M6), the seam an approval gate (cred-final APR-1) takes when REQ-025's vault is built. The failure text and the description are masked without a sealed copy: an encrypted full-fidelity evidence vault for the whole timeline (REQ-025, encryption at rest) is an OPEN requirement, not this.

The store key is the caller's admitted one (the web timeline shares the web database's) or the key of the ledger's FOLDER from the key home (`resolvePersistedKey`) — shared by every store of that folder. A ledger that already holds sealed originals only ever loads its key; a missing one is refused, never replaced, and the key owner mints a key for ANY store only when no other registered store sharing it holds ciphertext (each store kind registers its ciphertext probe: the timeline's sealed originals, the web database's encrypted fields). The ledger records its seal key's CHECK VALUE at its first seal (migration 10, `timeline_seal_key_check`, append-only) and every open compares it, so a second key (a host resolving another one) is refused before anything is sealed or read (`timeline_seal_key_mismatch`; a3-design H2).

## Migrations, WAL and concurrent openers

The migration registry read and every pending migration run inside ONE `BEGIN IMMEDIATE`, so a contending opener re-reads the registry only after it holds the writer lock; migrations are matched by name, so a ledger missing a known migration's row is upgraded, while a registry row this build does not know (a newer or foreign build wrote the ledger) is refused (`timeline_migration_unknown`). Entering WAL mode goes through the WAL owner (`engine/src/filesystem/sqlite-wal.ts`): SQLite answers one of two first openers of a fresh file SQLITE_BUSY without consulting the busy handler, and the owner waits for the other opener within the same busy timeout. `close()` reports the TRUNCATE checkpoint's own result row (a blocked checkpoint throws nothing and is still not a success).

## Rollback

The plan pages ascending through the tip fixed at planning time, so it covers every later event (a single query used to stop at the default page and leave older effects in place while reporting success); a gap, repeat or empty page refuses (`timeline_rollback_plan_incomplete`). Before any callback the whole batch is admitted: each file effect's exact documents are resolved — a protected pre-image from its sealed original — and a missing or digest-only pre-image refuses before anything is touched or recorded. An intent is appended before the callbacks and a terminal after them, carrying the `rolled-back-by` edges; a thrown callback or a failed terminal append leaves the intent pending. The plan itself carries the masked projection, never a sealed original.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/timeline/`.

- `effect-documents.ts` is consumed by `engine/src/timeline/effect-sink.ts`, `server/kernel/canonical.ts`.
- `effect-sink.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `server/kernel/canonical.ts`.
- `ledger-dig.ts` is consumed by nothing yet.
- `ledger-primitives.ts` is consumed by `engine/src/cli.ts`, `engine/src/kernel/execution-closure.ts`, `engine/src/timeline/effect-documents.ts`, `engine/src/timeline/effect-sink.ts`, `engine/src/timeline/recorded-effect.ts`, `engine/src/timeline/timeline-query.ts` and 4 more.
- `provider-recording.ts` is consumed by nothing yet.
- `recorded-effect.ts` is consumed by `engine/src/performance/engine-instrumentation.ts`, `engine/src/runtime/harness-bootstrap.ts`, `engine/src/shared/exposure/action.ts`, `engine/src/timeline/effect-documents.ts`, `engine/src/timeline/effect-sink.ts`, `engine/src/timeline/provider-recording.ts` and 1 more.
- `recording-context.ts` is consumed by `engine/src/cli.ts`, `engine/src/performance/engine-instrumentation.ts`, `engine/src/runtime/harness-bootstrap.ts`, `engine/src/shared/llm/client.ts`, `engine/src/shared/llm/provider-http.ts`, `engine/src/timeline/effect-sink.ts` and 5 more.
- `rollback.ts` is consumed by `engine/src/timeline/timeline-recorder.ts`, `engine/src/workflow/harness-commands.ts`.
- `timeline-config.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `engine/src/timeline/effect-documents.ts`, `engine/src/timeline/timeline-store.ts`, `server/kernel/canonical.ts`.
- `timeline-query.ts` is consumed by `engine/src/timeline/timeline-recorder.ts`, `server/kernel/canonical.ts`.
- `timeline-recorder.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/agents/agent-state.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/evaluation/cli.ts`, `engine/src/evaluation/matrix-executor.ts`, `engine/src/evaluation/scenario-runner.ts` and 8 more.
- `timeline-schema.ts` is consumed by `engine/src/timeline/timeline-store.ts`.
- `timeline-sealing.ts` is consumed by `engine/src/timeline/timeline-store.ts`.
- `timeline-store.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/index.ts`, `engine/src/runtime/harness-bootstrap.ts`, `engine/src/workflow/harness-commands.ts`, `engine/src/workflow/timeline-shard.ts`, `engine/src/workflow/workspace-manager.ts` and 1 more.
- `timeline-types.ts` is consumed by `engine/src/agents/agent-state.ts`, `engine/src/agents/orchestrator.ts`, `engine/src/agents/workspace-peek.ts`, `engine/src/memory/memory-store.ts`, `engine/src/runtime/harness-bootstrap.ts`, `engine/src/runtime/orchestrator-tools.ts` and 11 more.

<!-- /consumers:generated -->
