---
layout: default
title: 'Exposure derivation analysis — the ten mock registration modules'
---

> **READ `EXPOSURE-DERIVATION-ANALYSIS-CHECK.md` ALONGSIDE THIS FILE.** An adversarial check
> re-derived every load-bearing claim and found eight errors. The thesis survives; several
> pieces of evidence do not. The corrections that change the plan:
>
> - **`quality.enabledChecks` "matches none of the twelve real check names" is FALSE.** Two of
>   four match exactly (`schema-drift`, `duplicated-literals`), one is a near-miss. The
>   comparison was against exported FUNCTION names, not the declared `id:` fields.
> - **`memory` is not the easy win.** `getMemoryStore` is module-PRIVATE in `memory-bridge.ts`,
>   so P2 is a hard blocker for that step, not a recommendation.
> - **`recordToolCall` is inert until something first requests `/api/metrics`** — the sink is
>   attached lazily, so every tool call before that is silently discarded. New prerequisite
>   P2b; it breaks the `tools` and `editor` derivations, quietly.
> - **`buildUiSchema` is memoized permanently**, so any lazily-registered signal is invisible.
>   New prerequisite P1b.
> - **The 22 `?? 0` sites are not reachable as described** — the branch cannot be entered while
>   the signals exist, and the memoized schema means the web never renders them. P3 is hygiene,
>   not a dress rehearsal.
> - **The ratio corollary is 41 sites across 11 modules, not 9.**
> - **`awareness` is overstated:** all ten closures read a cache, not the registry. Only 4 of 10
>   are backed by a real measurement, and 2 should be DELETEd on this report's own criteria.
> - **The proposed one-line discriminator fails both ways.** Use instead: *is the module's state
>   written by any non-test code outside the exposure surface?*
> - Deletion count for steps 1–4 is **40** signals, not 48.

# Exposure derivation analysis — the ten mock registration modules

Read-only analysis for step S6. Nothing in any tree was modified.

Scope: `integration/src/shared/exposure/registrations/` — the ten modules named as mocks
(`tools`, `context`, `memory`, `search`, `editor`, `quality`, `awareness`, `safety`,
`hallucination`, `learning`) plus `bias`. `privacy.ts` is the stated template.

---

## 0. THE HEADLINE, BEFORE THE PER-MODULE DETAIL

Four facts decide the whole step. Each is verified, not inferred.

### 0.1 There is NO way to say "not measured". This is the blocking prerequisite.

Producer side — `integration/src/shared/exposure/signal.ts:146`:

```ts
value: (args?: Readonly<Record<string, unknown>>) => number | string | boolean;
```

Wire side — `web-interface-foundation-v1/contracts/ui-schema.ts:266-269`:

```ts
export type SignalValueEntry = Readonly<{
  readonly id: string;
  readonly value: number | string | boolean;
}>;
```

No `null`, no `undefined`, no optionality, no `absent` / `available` / `measured`
discriminant. **A signal is structurally incapable of reporting absence.** The only
absence that exists today is *omission of the entry from the array*, which happens only
when `readSignal` throws — and `buildUiSchemaValues`
(`web-interface-foundation-v1/server/schema/ui-schema.ts:273-303`) downgrades that throw
to a `webWarn` log line and silently drops the row. The client then manufactures
`undefined` from a Map miss and renders `"—"`
(`src/lib/metrics/exposure-groups.ts:114`, `src/lib/widgets/SignalValueWidget.svelte:23`).

Three separate defects follow, and all three must be fixed before step one:

1. **A derived signal whose source is not attached has nowhere to go but a fabricated
   scalar.** This is not hypothetical — it is already shipping. See 0.2.
2. **"—" is not plain words.** Contract §5 requires absence stated in plain language.
3. **A dropped row is indistinguishable from a signal that was never registered.** The
   schema (`GET /api/schema/ui`) still advertises it.

The codebase already has the right *semantics* elsewhere — it is only the exposure
contract that lacks the type:

- `integration/src/awareness/types.ts:132-138` — `typeLevel`, `quality`, `drift`,
  `complexity` are each `... | null`, meaning "this signal did not compute".
- `web-interface-foundation-v1/server/quality-bridge.ts` (header of `computeScore`) —
  *"A `null` sub-metric means 'not measured' — its penalty is SKIPPED, never computed
  from a fabricated 0 (a `?? 0` here previously turned a failed quality computation into
  a zero-penalty — i.e. a high score)."*
- `web-interface-foundation-v1/src/lib/module/readout.ts` — the only surface that gets
  this right today, with prose values `"not loaded yet"`, `"nothing to report"`,
  `"declared, not yet live"`, and the note *"A namespace whose signals carry no value
  reads `idle`, not `0` — because 'no reading yet' and 'a reading of zero' are different
  facts and a dashboard that confuses them is lying quietly."*

### 0.2 The fabrication is already live in the ONE real subsystem registration.

`integration/src/shared/llm/exposure.ts` is a **real** registration wired to a **real**
live client (`SharedLLMClient`, constructed at
`web-interface-foundation-v1/server/llm-bridge.ts:171`, which calls
`registerLLMExposure()` + `setActiveLLMClientForExposure(this)` from its own constructor,
`shared/llm/client.ts:144-145`). It registers 32 signals, 9 actions, 14 customizations.

And it contains **22 occurrences of `?? 0`**, e.g.:

```ts
value: () => activeClient?.getQueue().rejected ?? 0
```

Its own header calls this *"an honest zero-state"*. It is not. A queue with zero
rejections and a process with no LLM client attached produce the identical reading. This
is the exact defect S6 is fixing, already on a user-facing path, in the module that is
supposed to be the good example. **Any derivation built before the absent
representation exists will reproduce this line 22 more times per module.**

### 0.3 Two surfaces already answer "how many tool calls", and they disagree by construction.

- `GET /api/metrics` → `server/metrics-bridge.ts` → `MetricsCollector.snapshot()` →
  `totalCallCount`, `totalErrorCount`, per-tool `callCount` / `errorCount` /
  `durationHistogram`. **Real. Measured at one choke point.**
- `GET /api/schema/ui/values` → `tools.callCount` → `toolsState.callCount`.
  **Fabricated. Moves only when a user clicks the `tools.invoke` simulator.**

Contract §1: *"If you find two places that answer the same question, that is the bug."*
The real one exists, is live, and is already served — it is simply not the one the
exposure surface reads.

### 0.4 There are THREE doors into the exposure registry, not one.

| Door | Entry point | Reachability |
|---|---|---|
| `shared/exposure/registrations/*` | `registerAllExposure()` | **LIVE** — `runtime/harness-bootstrap.ts:222` (CLI), `server/routes/schema.ts:35`, `server/blocks/settings.ts:72` |
| `safety/bandaid-exposure.ts` | `registerBandaidExposure(config)` → returns a live state handle | **ORPHANED** — zero production callers |
| `shared/llm/exposure.ts` | `registerLLMExposure()` + `setActiveLLMClientForExposure()` | **LIVE** — called from `SharedLLMClient`'s constructor |

Doors 2 and 3 are *the injection pattern the derivation needs* — a subsystem hands the
registry a live reader. Door 3 is proven in production. But they are two independently
invented mechanisms for one job (§2), and neither is discovered by
`registerAllExposure`. **Do not mint a fourth.**

---

## 1. PER-MODULE FINDINGS

Verdict key: **DERIVE** (real running source, reachable) · **DERIVE-AFTER** (real source,
not currently wired — names what must be wired) · **DELETE** (no real source; the honest
outcome is a truthfully empty surface).

---

### 1.1 `tools` — mostly DERIVE, from a source that is already running

**Fabricates.** `toolsState` (17 fields). Signals: `callCount`, `errorCount`,
`errorRate`, `avgLatency`, `lastLatency`, `inFlight`, `cancelCount`, `retryCount`,
`maxConcurrent`, `failClosed`, `timeoutCount`, `lastCallRecord`. Actions: `cancel`,
`retry`, `invoke` (a full synthetic dispatch simulator, ~80 lines), `resetCounters`,
`clearInFlight`. Customizations: `maxConcurrent`, `timeout`, `retryLimit`,
`retryBackoff`, `failClosed`, `propagateErrors`, `recordInputs`, `recordOutputs`.

**Real source.** `integration/src/performance/metrics-collector.ts`:
- `MetricsSnapshot.totalCallCount` / `.totalErrorCount` / `.totalCancellationCount`
- `MetricEntrySnapshot.callCount` / `.errorCount` / `.cancellationCount` /
  `.durationHistogram` (`{ totalCount, sumMs, minMs, maxMs, bounds, counts }`)
- `quantileFromHistogram(...)` for percentiles

**Reachable? YES.** One choke point, one line:
`web-interface-foundation-v1/server/tool-executor.ts:1556`

```ts
recordToolCall(toolName, performance.now() - start, result.success);
```

feeding `server/metrics-recorder.ts:98` → `collector.recordCall({module:"tool",
function:toolName, scope:"execute"}, ...)`. The collector instance is a process-global
lazy singleton at `server/metrics-bridge.ts:29-37`.

Note: `integration/src/tools/**` is **not** the tool registry and records nothing.
`integration/src/runtime/tool-registry.ts` *does* accept a `metricsCollector` and record
correctly — but has **zero production call sites** (barrel re-export only). The web app
runs its own executor.

| Signal | Verdict | How |
|---|---|---|
| `tools.callCount` | **DERIVE** | sum `callCount` over entries with `key.module === "tool"` |
| `tools.errorCount` | **DERIVE** | same, `errorCount` |
| `tools.errorRate` | **DERIVE** | ratio of the two; **ABSENT when `callCount === 0`**, not `0` |
| `tools.avgLatency` | **DERIVE** | `durationHistogram.sumMs / .totalCount`; ABSENT at zero samples |
| `tools.cancelCount` | **DERIVE-AFTER** | field exists (`cancellationCount`) but `recordToolCall` only ever passes `"succeeded"`/`"failed"`; `recordCancellation` has no production caller. Wire the cancel path first. |
| `tools.inFlight` | **DELETE** | the collector has no gauge and no in-flight tracking. `recordCallStart` (which returns a stop-closure and could support it) has no production caller. |
| `tools.lastLatency` | **DELETE** | a histogram has no "most recent". Nothing records it. |
| `tools.retryCount` | **DERIVE-AFTER** | `server/routes/run.ts:143` holds `toolAttemptCounts: Map<string, number>` — a real per-run attempt counter. Needs a process-level rollup. |
| `tools.timeoutCount` | **DELETE** | no timeout accounting on the live path |
| `tools.maxConcurrent` | **DELETE** | no concurrency bound is applied to tool execution |
| `tools.failClosed` | **DELETE** | no such policy exists |
| `tools.lastCallRecord` | **DELETE** | invented string |

| Customization | Verdict | How |
|---|---|---|
| `tools.timeout` | **DERIVE** | already in the global config: `tools.defaultBounds.timeoutMs = 30000`. **The mock declares the same 30000 independently — two sources of truth for one value (§1, §17).** |
| everything else (7) | **DELETE** | no config key, no consumer, no code path reads them |

**Actions: DELETE all five.** `tools.invoke` is the worst item in the entire surface — an
80-line simulator, admin-executable through `POST /api/schema/ui/actions/tools.invoke`,
whose only effect is to move the numbers a user is reading as facts.

---

### 1.2 `context` — partial DERIVE; the module that most needs the absent case

**Fabricates.** `contextState` (19 fields). Signals: `trimCount`, `overflowCount`,
`memoryRetrievalCount`, `totalTokens`, `utilization`, `lastTrimAmount`, `clearCount`,
`forceTrimCount`, `preserveSystem`, `preserveLast`. Actions: `forceTrim`, `clear`,
`addTokens`, `retrieveMemory`, `autoTrim`. Customizations: `maxContext`,
`trimThreshold`, `trimStep`, `preserveSystem`, `preserveLast`, `compactStrategy`,
`retrievalTopK`, `retrievalMinScore`.

**Real source.** `integration/src/memory/unified/unified-context-manager.ts`.
`ContextState` (lines 67-77): `turns`, `summaries`, `conversationSummaryBlock`,
**`totalTokens`**, **`tokenLimit`**, **`trimThreshold`**, `trimmed`, `lastTrimmedTurnId`,
**`trimCount`**. Methods: `tokenCount()`, `tokenLimit()`, `trimThreshold()`,
`trimThresholdTokens()`, `isOverThreshold()`, `shouldTrim()`, `trim()`, `retrieve()`,
`state()`, `clear()`.

`ContextState.trimCount` is, per the sweep, **the only genuinely accumulated counter in
any of the tools/editor/context/timeline subsystems.**

**Reachable? YES, but PER-RUN.** `server/context-bridge.ts:183 createRunContextManager()`
→ `server/routes/run.ts:799`, stored in `active.contextManager` inside the module-private
`activeRuns = new Map<string, ActiveRun>()` (`run.ts:202`). **Between runs there is no
manager at all.** A process-global signal has no instance to read. The honest reading is
then ABSENT — never `0`, which is exactly what today's mock returns. This module cannot
be done correctly before prerequisite P1.

| Signal | Verdict | How |
|---|---|---|
| `context.trimCount` | **DERIVE** | `state().trimCount`; ABSENT with no active run |
| `context.totalTokens` | **DERIVE** | `tokenCount()` / `state().totalTokens`; ABSENT with no active run |
| `context.utilization` | **DERIVE** | `totalTokens / tokenLimit`; `isOverThreshold()` is the module's own abnormality predicate and should replace the hand-declared `warnAbove: 1` |
| `context.overflowCount` | **DELETE** | no counter; `isOverThreshold()` is instantaneous only |
| `context.memoryRetrievalCount` | **DERIVE-AFTER** | `retrieve()` exists; nothing counts calls |
| `context.lastTrimAmount` | **DELETE** | not tracked |
| `context.clearCount` / `forceTrimCount` | **DELETE** | not tracked |
| `context.preserveSystem` / `preserveLast` | **DELETE** | the real manager preserves **pinned turns** (`pinTurn`/`unpinTurn`) and the **recent window** (`recentTurnWindow`, `minRecentTurnsKept`). "System"/"last" are invented concepts that do not exist in the implementation. |

| Customization | Verdict | How |
|---|---|---|
| `context.maxContext` | **DERIVE** | config `memory.contextTokenLimit = 32768` → `UnifiedConfig.contextTokenLimit` |
| `context.trimThreshold` | **DERIVE** | config `memory.trimThreshold = **0.8**` → `UnifiedConfig.trimThreshold`. **The mock declares default `0.85`. The two sources of truth have already drifted (§1) — this is a live, demonstrable disagreement, not a theoretical one.** |
| `context.retrievalTopK` | **DERIVE** | `UnifiedConfig.retrievalTopK` (real default **10**, mock says **5** — drifted again) |
| `context.retrievalMinScore` | **DERIVE** | `UnifiedConfig.retrievalMinScore` |
| `context.trimStep` | **DELETE** | no analogue in `UnifiedConfig` |
| `context.compactStrategy` (`oldest`/`summary`/`vector`) | **DELETE** | the real manager always summarizes (`extractiveSummarizer`); there is no strategy switch |
| `context.preserveSystem` / `preserveLast` | **DELETE** | see above |

**Actions.** `forceTrim` → `trim()`, `clear` → `clear()`, `retrieveMemory` → `retrieve()`
are all **DERIVE** against real methods. `addTokens` (synthetic) and `autoTrim`
(re-implements `shouldTrim()`) are **DELETE**.

---

### 1.3 `memory` — best reachability of the ten; partial DERIVE

**Fabricates.** `memoryState` (20 fields). Signals: `entryCount`, `presentCount`,
`shortTermCount`, `longTermCount`, `retrievalCount`, `hitRate`, `avgRetrievalLatency`,
`totalTokens`, `compactCount`, `corruptedEntries`. Actions: `clear`, `prune`, `compact`,
`addEntry`, `turnBoundary`, `retrieve`. Customizations: `windowSize`, `trimThreshold`,
`trimStep`, `promoteOnTurnBoundary`, `defaultTier`, `maxCorrupted`.

**Real source.** `integration/src/memory/memory-store.ts`, `createMemoryStore(options)`.
`MemoryStore.count()` (:86), `.countByTier(tier)` (:87), `.estimateTotalTokens()` (:88),
`.corruptedEntryCount()` (:89), `.config`, plus `present()` / `shortTerm()` /
`longTerm()`. Tier vocabulary is `MEMORY_TIERS = ["present","short-term","long-term"]`
(`memory-types.ts:31`).

**Reachable? YES — and it is a process-global singleton, the cleanest of all ten.**
`web-interface-foundation-v1/server/memory-bridge.ts:44` holds
`getMemoryStore()` doing `store = createMemoryStore({ store: getTimelineStore() })`,
consumed by `routes/memory.ts:35`, `routes/run.ts:49`, `blocks/compose.ts:83`,
`tool-executor.ts:83`.

| Signal | Verdict | How |
|---|---|---|
| `memory.entryCount` | **DERIVE** | `count()` |
| `memory.presentCount` / `shortTermCount` / `longTermCount` | **DERIVE** | `countByTier(t)` for each `t` in `MEMORY_TIERS` — **discovered from `MEMORY_TIERS`, not authored**, exactly the `privacy.ts` move. Note the mock's ids (`short`/`long`) do not match the real tier names. |
| `memory.totalTokens` | **DERIVE** | `estimateTotalTokens()` |
| `memory.corruptedEntries` | **DERIVE** | `corruptedEntryCount()` — the existing `abnormal: { warnAbove: 0 }` becomes truthful |
| `memory.retrievalCount` / `hitRate` / `avgRetrievalLatency` | **DERIVE-AFTER** | `createMemoryStore` measures none of these. Counters with these exact names exist only on the **orphaned** `tool-result-store.ts` (`ToolResultStoreStats.retrievalCount/retrievalHits/avgRetrievalMs`) and `unified/unified-memory-store.ts` (`UnifiedMemoryStats.retrievals/lruHits/lruMisses`). The correct wiring point is `server/memory-bridge.ts`'s own `searchMemory` / `retrieveRelevantMemories` — one choke point, recorded through the same `MetricsCollector` as tools rather than a new counter set. |
| `memory.compactCount` | **DELETE** | no "compaction" concept exists anywhere in `src/memory/**` |

| Customization | Verdict | How |
|---|---|---|
| `memory.windowSize` | **DERIVE** | real values are config `memory.recentTurnWindow = 10` (turns) and `memory.contextTokenLimit = 32768` (tokens). **The mock declares `4096` tokens — matching neither.** |
| `memory.trimThreshold` | **DERIVE** | config `memory.trimThreshold = 0.8`; mock says `0.85` — drifted |
| `memory.trimStep` | **DELETE** | no analogue |
| `memory.promoteOnTurnBoundary` | **DELETE** | no promotion machinery in `createMemoryStore` |
| `memory.defaultTier` | **DELETE** | does not exist; `add()` **requires** an explicit tier (deny-by-default, correctly) |
| `memory.maxCorrupted` | **DELETE** | the store counts corrupted entries but has no write-refusal tolerance |

**Actions.** `clear` → real. `addEntry`/`turnBoundary`/`retrieve` are synthetic →
**DELETE**; the real operations are already exposed by `memory-bridge.ts`
(`storeProvenance`, `searchMemory`, `listMemoryEntries`, `memoryCount`). `prune` /
`compact` → **DELETE** (`prune`'s own description already admits *"the stub store tracks
no entry ages, so no entries are dropped yet"*).

---

### 1.4 `search` — one DERIVE, the rest DERIVE-AFTER via the shared mechanism

**Fabricates.** `searchState` (20 fields). Signals: `queryCount`, `resultCount`,
`cacheHitRate`, `avgLatency`, `lastLatency`, `indexSize`, `indexVersion`, `reindexCount`,
`clearCacheCount`, `thresholdActive`. Actions: `clearCache`, `reindex`, `resetCounters`,
`query` (a full 7-step search simulator with a caller-supplied candidate list),
`configureIndex`. Customizations: `threshold`, `maxResults`, `fuzzyThreshold`,
`indexFreshness`, `queryTimeout`, `sortBy`, `languageFilter`, `caseSensitive`.

**Real source.** `integration/src/intelligence/symbol-search.ts` —
`hybridSearchSymbols`, `searchSymbols`, `buildBm25Index`, `Bm25Index.documentCount`
(:344), `Bm25Index.averageDocumentLength`, `Bm25Index.mapHash` (:339). Repository level:
`getRepositoryMapSummary()` → `{ fileCount, moduleCount, symbolCount, languages }`.
Config owner: `IntelligenceConfig` / `HybridSearchConfig` (:250-262) —
`bm25K1`, `bm25B`, `hybridBm25Weight`, `hybridSpecificBm25WeightFloor`,
`hybridVagueBm25WeightCeiling`, `searchBiasDirectoryThreshold`, `searchBiasMinResults`,
`searchSealRatio`, `searchSealMinScore`, `queryShortTokenLength`.

**Reachable? YES.** `web-interface-foundation-v1/server/intelligence-bridge.ts:706
searchCodeSymbols` calls `hybridSearchSymbols` at :718. Also `repository-map-worker.ts`,
`quick-view-worker.ts`, `routes/intelligence.ts`.

> **Coordination note:** `server/intelligence-bridge.ts` is being edited by another agent
> right now. This module must be sequenced after that work lands.

| Item | Verdict | How |
|---|---|---|
| `search.indexSize` | **DERIVE** | `Bm25Index.documentCount`, or `getRepositoryMapSummary().symbolCount` |
| `search.indexVersion` | **DERIVE (with a type change)** | no monotonic counter exists. `RepositoryMap.mapHash` (content hash) and `.generatedAt` do. Re-declare as `type: "string"` carrying the map hash, or `type: "timestamp"` carrying `generatedAt`. Do not invent a version number. |
| `search.queryCount` / `resultCount` / `avgLatency` / `lastLatency` | **DERIVE-AFTER** | zero counters exist anywhere. But `searchCodeSymbols` is a single choke point and the `MetricsCollector` is already live — add **one** `recordCall({module:"search", function:"symbols", scope:"query"}, ...)` there and the same reader that serves `tools` serves this. This is the §2-correct move: extend the existing path, do not build a second one. |
| `search.cacheHitRate` | **DERIVE-AFTER** | `intelligence-bridge.ts` has a real cache (`deriveFromMap`, `requireCachedMap`, `MapNotReadyError`) that records **no** hit/miss counters |
| `search.reindexCount` | **DERIVE-AFTER** | `invalidateProjectCache(projectPath, gate)` (:793) triggers rebuilds; nothing counts them |
| `search.clearCacheCount` | **DELETE** | operator-action bookkeeping with no real analogue |
| `search.thresholdActive` | **DELETE** | no BM25 score threshold knob exists on the real path |
| customizations `threshold`, `maxResults`, `fuzzyThreshold`, `indexFreshness`, `queryTimeout`, `sortBy`, `languageFilter`, `caseSensitive` | **DELETE, and replace** | **none** of the eight appears in `HybridSearchConfig`. The real, config-owned, live-consumed knobs are the ten `IntelligenceConfig` fields listed above and they are **not exposed at all**. This is the inverse of the stated defect: eight fabricated controls rendered, ten real ones hidden (§7). |

**Actions: DELETE all five.** `search.query` is a second full simulator on a user-facing
admin route.

---

### 1.5 `editor` — DERIVE from the tools mechanism, at almost no extra cost

**Fabricates.** `editorState` (15 fields incl. a `history` array). Signals: `editCount`,
`successRate`, `failureCount`, `autoHealTriggerRate`, `rollbackRate`,
`totalEditsApplied`, `lastEditAt`, `atomicWriteEnabled`, `syntaxValidationEnabled`,
`feedbackLoopEnabled`. Actions: `rollback`, `clearHistory`, `applyEdit` (a third
simulator), `validateSyntax`, `resetStats`. Customizations: `viewportLines`,
`maxRetries`, `fuzzyThreshold`, `syntaxValidationEnabled`, `atomicWriteEnabled`,
`feedbackLoopEnabled`, `historyRetention`, `backupOnEdit`.

**Real sources, and their reachability — this splits two ways.**

*(a) The five edit tools DO run through the metrics choke point.* The web server executes
`edit_replace_file`, `edit_apply_patch`, `edit_insert_text`, `edit_delete_range`,
`edit_replace_range` through `tool-executor.ts:1556 recordToolCall(...)`. The tool names
are discoverable from `createEditorToolDefinitions()`
(`integration/src/editor/edit-tools.ts:48`), which the web already imports at
`server/tools-bridge.ts:31,689`.

*(b) The transactional editor itself is ORPHANED.* `createTransactionalEditor` and
`createEditorTools` have **zero production callers** — only the `src/index.ts` barrel and
a benchmark script. `web-interface-foundation-v1/server/tool-executor.ts` and
`server/editor-bridge.ts` implement their own edit path (`editor-bridge.ts:107` even
redefines a local `detectLanguage`). `integration/src/smart-edit/**` — the entire
auto-heal cascade — is orphaned too; `server/auto-heal.ts:303-318` is a
**re-implementation** whose own comment says it mirrors `smart-edit/auto-heal.mjs`.

**That duplication is itself a §2 finding worth recording separately: the web server
rebuilt the editor rather than extending it, which is why none of the real
`EditorEffectRecorder` / `EditResult` fields can be reached.**

| Item | Verdict | How |
|---|---|---|
| `editor.editCount` | **DERIVE** | sum `callCount` over metric entries whose `key.function` ∈ the five names from `createEditorToolDefinitions()` — **discovered, never hardcoded** (§6) |
| `editor.successRate` | **DERIVE** | `(callCount − errorCount) / callCount`; **ABSENT at zero calls** |
| `editor.failureCount` | **DERIVE** | `errorCount` over the same entries |
| `editor.lastEditAt` | **DELETE** | a histogram has no last-timestamp; nothing records one |
| `editor.totalEditsApplied` | **DELETE** | hunks are produced (`PatchHunk`, `parseUnifiedDiff`) but never counted |
| `editor.rollbackRate` | **DERIVE-AFTER** | `EditResult.rolledBack` / `.rollbackFailed` and `EditorEffectRecorder.recordRollback` are real — behind an editor nobody constructs. Blocked on wiring `createEditorTools` into `tool-executor.ts`. |
| `editor.autoHealTriggerRate` | **DERIVE-AFTER** | the real cascade is `smart-edit/auto-heal.mjs` (orphaned) and `server/auto-heal.ts` (live re-implementation, counts nothing) |
| `editor.syntaxValidationEnabled` | **DERIVE-AFTER** | real as `TransactionalEditorOptions.skipSyntaxValidation` (inverted sense); the validator registry (`editor/syntax-validator.ts`) **is** live, but via `quality-packs/typescript-pack.ts`, not the editor |
| `editor.atomicWriteEnabled` | **DELETE** | atomicity is **unconditional** in the real editor (`atomicWriteFile` is the default `atomicWriter`). A switch here advertises a choice that does not exist. |
| `editor.feedbackLoopEnabled` | **DELETE** | `edit-feedback.ts` builds structured feedback unconditionally; no toggle |
| `editor.viewportLines` / `maxRetries` / `fuzzyThreshold` / `historyRetention` / `backupOnEdit` | **DELETE** | the real editor is **preimage-hash** based — exact match, no fuzzy threshold — and is stateless: no retry loop, no history array, no backup mechanism anywhere in `editor/` |

**Inverse defect worth fixing in the same round:** the config *does* own real editor
limits — `editor.maxFileBytes` (67108864), `editor.maxPatchBytes`,
`editor.maxInsertTextBytes` — and **none of the three is exposed** (§7).

**Actions: DELETE all five.**

---

### 1.6 `quality` — partial DERIVE, but from awareness, not from `src/quality/`

**Fabricates.** `qualityState` (14 fields). Signals: `findingCount`,
`falsePositiveCount`, `falsePositiveRate`, `avgCheckTime`, `checksRun`, `lastCheckTime`,
`enabledCheckCount`, `recheckCount`, `clearedCount`, `failOnCritical`. Actions:
`recheck`, `clear`, `addFinding`, `enableCheck`, `disableCheck`. Customizations:
`thresholdCritical/High/Medium/Low`, `failOnCritical/High/Medium`, `enabledChecks`.

**Real sources and reachability — three-way split.**

- `integration/src/quality/**` (`runAnalysis`, `QualityReport{files:{scanned,parsed,parseErrors,loc}, findings, signals, byCheck, durationMs}`, `scoreQuality`, `monitorDelta`) — **ORPHANED.** Its only non-test importer is `src/aux/index.ts:48`, which itself has zero importers. The chain is dead.
- `integration/src/quality-packs/**` — **LIVE, but only through the CLI**
  (`src/cli.ts:71` → `quality-packs/cli.ts runQualityCli` → `runTier` → `runQualityPack`).
  Not reachable from the web process. Real vocabulary: `QUALITY_TIERS`, `TIER_CHECK_MAP`,
  `DIAGNOSTIC_CATEGORIES`, and the **twelve** `typescriptPack` checks (`syntaxCheck`,
  `typeCheck`, `undefinedSymbolCheck`, `deadSymbolCheck`, `unusedExportCheck`,
  `deadBranchCheck`, `duplicateLogicCheck`, `schemaDriftCheck`,
  `configOutsideContractCheck`, `duplicateBodyCheck`, `esmCjsMismatchCheck`,
  `duplicatedLiteralsCheck`).
- **What actually serves quality in the web UI** is `server/quality-bridge.ts`, derived
  from the **awareness snapshot** (`snap.quality`, `snap.complexity`, `snap.clones`,
  `snap.typeLevel`) plus the repository map — **never** from `src/quality/`.

| Item | Verdict | How |
|---|---|---|
| `quality.findingCount` | **DERIVE** | `AwarenessSnapshot.quality.totalIssues` via `server/awareness-bridge.ts` (LIVE) |
| a new issue-density signal | **DERIVE** | `AwarenessSnapshot.quality.issueDensity` / `.issuesPerKloc` / `.topCategories[]` — real, measured, currently unexposed |
| `quality.enabledCheckCount` | **DERIVE** | count of the pack's own checks, discovered from `typescriptPack` + config `qualityPacks.enabled = ["typescript-pack"]` |
| `quality.enabledChecks` (cust) | **DERIVE** | config `qualityPacks.enabled`. **The mock's default is four ids (`duplicate-body-detector`, `duplicated-literals`, `dead-exports`, `schema-drift`) that match none of the twelve real check names — a fabricated vocabulary presented as a configurable list.** |
| `quality.avgCheckTime` / `lastCheckTime` | **DERIVE-AFTER** | `QualityReport.durationMs` is real but its producer is orphaned; the live path is `quality-bridge.ts`, which times nothing. Same one-line `recordCall` fix as `search`. |
| `quality.falsePositiveCount` / `falsePositiveRate` | **DELETE** | nothing anywhere marks a finding as a false positive |
| `quality.checksRun` / `recheckCount` / `clearedCount` | **DELETE** | operator bookkeeping over a mock |
| `quality.threshold{Critical,High,Medium,Low}` | **DELETE** | the real severity vocabulary is `DIAGNOSTIC_SEVERITY` / `DIAGNOSTIC_CATEGORIES` (enumerated), not a 0..1 score banded by four cutoffs. The banding function `classifySeverity` is invented arithmetic. |
| `quality.failOn{Critical,High,Medium}` | **DERIVE-AFTER** | a real gate exists: `getLintGateConfig()` in `server/harness-config.ts`. Derive from it rather than from three ad-hoc booleans. |

**Actions: DELETE all five.**

---

### 1.7 `awareness` — NOT a mock. Already derived. Reframe, do not rewrite.

This is the finding that changes the shape of the step.

`registrations/awareness.ts` does **not** hold fabricated counters. `performRefresh()`
reads the **live exposure registry** — `getSignal(id)`, `readSignal(id)`,
`countSignals()`, `countActions()`, `countCustomizations()`, `countAll()` — measures its
own cost with `performance.now()`, and drives a **real** `setInterval` (unref'd,
restarted by the `set` callbacks of `refreshInterval` / `backgroundMonitor`).

| Signal | Verdict |
|---|---|
| `signalCount`, `computationTime`, `updateRate`, `lastUpdate`, `refreshCount`, `clearCount`, `monitoredModuleCount`, `enabledSignalCount`, `backgroundMonitor`, `alertActive` | **ALREADY DERIVED — keep** |

Two real problems remain, and neither is fabrication:

1. **Name collision.** `integration/src/awareness/**` is a *completely different*
   subsystem — codebase awareness — and it is **LIVE** via
   `server/awareness-worker.ts:23-25` (`createAwarenessEngine`, `configureAwareness`),
   spawned by `server/awareness-bridge.ts:40`. It measures `fileCount`, `functionCount`,
   `moduleCount`, `totalLoc`, `languageMix[]`, `primaryLanguageId`, `typeLevel`,
   `quality`, `complexity`, `clones`, `drift` — **none of which is exposed anywhere.**
   Two concepts, one word, on one settings screen.
   **Recommendation: this exposure module is *self*-observation and should say so; the
   codebase snapshot deserves its own module (e.g. `codebase`). Do not merge them —
   that is the cross-product trap (§14).**
2. `awareness.alertThreshold` / `alertActive` compares the self-refresh rate (readings
   per second of the registry sweep) against an operator-facing "alert level". It is
   real but it measures the monitor, not the system; the alert it raises is
   uninterpretable. Either bind it to something an operator cares about or **DELETE** it.

Also note: this module is currently *truthfully measuring a fabricated surface*. Its
`signalCount` will legitimately drop as the DELETE verdicts land — that is the guard
working, not a regression.

---

### 1.8 `safety` — one DERIVE, the rest DELETE

**Fabricates.** `safetyState` (15 fields). Signals: `hallucinationCount`, `catchRate`,
`biasDetectionCount`, `biasPreventionCount`, `swallowDetectedCount`,
`groundingEnforcedCount`, `whitelistHitCount`, `resetCount`, `whitelistEnabled`,
`groundingEnabled`. Actions: `reset`, `clear`, `reportHallucination`, `reportBias`,
`enforceGrounding`. Customizations: `whitelistEnabled`, `groundingEnabled`, `threshold`,
`failClosed`, `groundingMode`.

**Real sources.** `integration/src/safety/**` is 18 files, ~6,656 lines of real code.
**Exactly one file is LIVE:**

| File | Status |
|---|---|
| `safety/tool-call-gate.ts` (`createToolCallGate`, `GateResult{blocked: BlockedToolCall[], clean: ToolCall[]}`, `DEFAULT_TOOL_CALL_GATE_CONFIG`) | **LIVE** — `integration/src/runtime/interactive-session.ts:11`; `server/canonical.ts:297` → `server/safety-bridge.ts` → `server/routes/safety.ts:26` |
| `bias-detector.ts`, `bias-preventer.ts`, `bias-config.ts` | **ORPHANED** (`createBiasPreventer` has no caller at all, not even a test) |
| `hallucination-detector.ts`, `hallucination-semantic.ts`, `hallucination-config.ts` | **ORPHANED** (test-only) |
| `bandaid-*` (5 files, incl. `bandaid-exposure.ts`) | **ORPHANED** |
| `deviation-detector.ts`, `step-skip-detector.ts`, `workaround-detector.ts`, `investigation.ts`, `pause-ask.ts` | **ORPHANED** |
| `safety/index.ts` `createSafetyModule` | **ORPHANED — zero callers including tests.** It registers `safety.findings`, `safety.recordBandaid`, `safety.sensitivity`, which therefore never register. |

| Item | Verdict | How |
|---|---|---|
| a new blocked-tool-call count | **DERIVE** | `GateResult.blocked.length` accumulated at the gate — the one real safety measurement available. `BlockedToolCall{toolCallId, toolName, errorMessage}` also supports a real "why" surface. |
| `safety.hallucinationCount` / `catchRate` | **DELETE** | source orphaned; and `hallucination` owns this concept anyway (two modules, one question — §1) |
| `safety.biasDetectionCount` / `biasPreventionCount` | **DELETE** | source orphaned; and `bias` owns it (§1 again) |
| `safety.swallowDetectedCount` | **DELETE** | no swallowed-catch detector runs |
| `safety.groundingEnforcedCount` | **DELETE** | `isGrounded` / `buildWhitelistPrompt` exist in the orphaned detector |
| `safety.whitelistHitCount` / `whitelistEnabled` | **DELETE** | no whitelist exists on any live path |
| `safety.resetCount` | **DELETE** | counts its own mock reset action |
| customizations `threshold`, `failClosed`, `groundingMode`, `groundingEnabled`, `whitelistEnabled` | **DELETE** | nothing outside the mock reads any of them. `resolveToolCallGateConfig` / `DEFAULT_TOOL_CALL_GATE_CONFIG` is the real, live config surface and should replace them. |

**Actions: DELETE all five** (`reportHallucination`, `reportBias`, `enforceGrounding` are
synthetic recorders).

---

### 1.9 `hallucination` — DELETE, entirely

**Fabricates.** `hallucinationState` (13 fields). Signals: `trapCount`, `catchCount`,
`missCount`, `correctionCount`, `catchRate`, `falseAlarmCount`, `resetCount`,
`activeLayerCount`, `autoCorrect`, `escalateOnMiss`. Actions: `reset`, `clear`,
`fireTrap`, `installTrap`, `toggleLayer`. Customizations: `threshold`,
`groundingThreshold`, `autoCorrect`, `escalateOnMiss`, `layers`, `layerMode`,
`evidenceTopK`, `correctivePrompt`.

**Real source exists and is entirely ORPHANED.**
`integration/src/safety/hallucination-detector.ts` (571 lines) —
`detectHallucination`, `isGrounded`, `extractReferences`, `buildIndexFromSources`,
`autoCorrect`, `validateStructuredOutput`, `buildWhitelistPrompt`;
`hallucination-semantic.ts` (1,058 lines) — `verifySemanticClaims`, `inferClaimsFromAst`,
`autoCorrectSignature`; `hallucination-config.ts` — `HALLUCINATION_LAYERS`,
`HALLUCINATION_DEFAULT_CONFIG`, `resolveHallucinationConfig`.

**Production callers: zero, in either repo.** Test-only. Nothing constructs an index,
nothing calls `detectHallucination`, and `createSafetyModule` (which would have) is
itself never constructed.

**VERDICT: DELETE the whole module** — all 10 signals, all 5 actions, all 8
customizations. A control labelled *"Fix flagged statements automatically"* that is on by
default and wired to nothing is the most direct capability lie in the surface.

Record for later, do not build now: if the detector is ever wired, `hallucination.layers`
must be **discovered from `HALLUCINATION_LAYERS`**, never authored — the mock's
`"factual,logical,self-contradiction,temporal"` is a hand-typed guess at it.

---

### 1.10 `learning` — DELETE, entirely

**Fabricates.** `learningState` (13 fields). Signals: `ruleCount`, `errorReductionRate`,
`generalizationRate`, `rulesApplied`, `rulesRejected`, `avgConfidence`, `relearnCount`,
`clearRulesCount`, `autoLearnEnabled`. Actions: `clearRules`, `relearn`, `addRule`,
`applyRule`, `setReduction`. Customizations: `maxRules`, `minConfidence`,
`plateauThreshold`, `relearnInterval`, `autoLearnEnabled`, `recallThreshold`.

**Real source exists and is entirely ORPHANED.**
`integration/src/self-improving/**` (9 files) — `SelfImprovingWorkflow` with
`ruleCount()`, `practiceCount()`, `improvementCount()`, `runRound(options)`;
`learner.ts` `RoundResult{round, mistakesObserved, patternsExtracted, patternsNovel,
rulesProposed, rulesAdmitted, rulesRejected, totalRules, totalPractices, preErrorRate,
postErrorRate, falsePositiveRate}`; `CommandLog`, `LearnedRulesStore`,
`BestPracticesStore`, `detectMistake`, `runLearningRound`.

**Production callers: zero, anywhere.** There is no `src/learning/` directory;
`_experiments/auto-learning/` is reachable only through the dead `src/aux/index.ts:49`.

Note how closely the mock tracks the orphaned design — `ruleCount`, `rulesApplied` ≈
`rulesAdmitted`, `rulesRejected`, `errorReduction` ≈ `preErrorRate`/`postErrorRate`,
`minConfidence`. The mock was written **from** the orphaned module's shape. That means
re-deriving later is cheap, and deleting now costs nothing.

**VERDICT: DELETE the whole module.** `learning.generalizationRate` has no source even in
the orphaned design.

---

### 1.11 `bias` — DELETE. It does not merely fabricate; it fabricates the wrong subject.

**Fabricates.** `biasState` (11 fields incl. an `auditLog` array). Signals:
`detectionCount`, `preventionCount`, `falseAlarmCount`, `preventionRate`, `typeCount`,
`resetCount`, `clearCount`, `threshold`, `preventionMode`, `auditMode`, `auditRowCount`.
Actions: `reset`, `clear`, `reportDetection`, `readAudit`, `addType`, `removeType`.
Customizations: `threshold`, `preventionMode`, `auditMode`, `biasTypes`, `recordInputs`,
`escalateToOperator`, `maxAuditRows`.

**The category error, verified.**

| | Declared to the user | Actually implemented |
|---|---|---|
| Concept | demographic fairness | **reasoning** bias in the agent's own process |
| Types | `gender, race, age, religion, nationality` (`biasState.biasTypes`, and the `bias.biasTypes` customization's default string) | `BIAS_TYPES = ["confirmation","anchoring","selection","recency","availability","representation","sampling","metric"]` (`safety/bias-config.ts:23`) |

`bias.biasTypes` is a rendered, editable, admin-writable control named **"Bias categories
watched"** with the description *"findings outside these categories are not flagged"*. It
presents a demographic-fairness capability the product does not have, has never had, and
was never designed to have. Of everything in this analysis, this is the highest-severity
user-facing item.

**Real source: `createBiasDetector` → `BiasDetectionReport{findings, byType, detectedCount}`
with `recordSearch/recordRead/recordAnswer/recordCodeSuggestion/recordMetricFinding/
recordCoverage/detect()`. ORPHANED — only caller is
`integration/test/safety/exp447-bias.test.ts`. `createBiasPreventer` has no caller at
all.**

**VERDICT: DELETE the whole module.**

**On the expected fold into `safety`: do not do it now.** Folding two fabrications into
one module produces one fabrication, not a derivation, and it is work that must be undone
when the detector is wired. Delete both `bias.*` and `safety`'s `biasDetectionCount` /
`biasPreventionCount` in the same change. If the detector is ever wired, **one** module
owns it and its vocabulary is **discovered from `BIAS_TYPES`** — the `privacy.ts` move.

---

## 2. RECOMMENDED ORDER

Cheapest and most-real first, so the pattern is de-risked by early wins and the absent
path is exercised by deletions before it is depended on by derivations.

| # | Module | Kind | Why here |
|---|---|---|---|
| **0** | *prerequisites* | — | absent-value representation + provider seam. See §4. Nothing below is honest without step 0. |
| **1** | `hallucination` | pure DELETE | 23 declarations, zero real reachability, no derivation to design. Smallest possible diff, largest honesty gain, and it proves the delete path and the truthfully-empty render before anything harder. |
| **2** | `learning` | pure DELETE | identical shape, zero callers anywhere, no judgement calls |
| **3** | `bias` | pure DELETE | same shape; also removes the wrong-concept demographic control (highest user-visible severity) |
| **4** | `safety` | DELETE + 1 DERIVE | first module that both deletes and derives; the single derivation (`GateResult.blocked`) is small and its source is unambiguously live |
| **5** | `memory` | DERIVE (partial) | **the first real win.** Best reachability of all ten — a process-global store singleton in `memory-bridge.ts`. 5 signals derive from 4 method calls; 2 customizations derive from the global config and *fix a live 0.8/0.85 disagreement*. Tier ids come from `MEMORY_TIERS`, proving the discovered-vocabulary pattern outside `privacy.ts`. |
| **6** | `context` | DERIVE (partial) | same config fix, plus `ContextState`. Second because it is the first module that **must** report ABSENT (per-run manager, nothing between runs) — do it once the empty surfaces from steps 1–4 have already exercised that path. |
| **7** | `tools` | DERIVE | needs the provider seam for `MetricsCollector`; 4 signals from one choke point. Also collapses the `/api/metrics` ↔ `tools.callCount` split (§1). |
| **8** | `editor` | DERIVE | **reuses step 7's mechanism verbatim**, filtered to the five tool names discovered from `createEditorToolDefinitions()`. Near-zero marginal cost once 7 lands — which is the argument for adjacency. |
| **9** | `search` | DERIVE-AFTER | one new `recordCall` at `intelligence-bridge.ts:706`, then it reads through steps 7/8. **Deferred: that file is under active edit by another agent.** |
| **10** | `quality` | DERIVE (partial) | last because it is the largest rewrite: an invented severity model must be replaced by the real `DIAGNOSTIC_CATEGORIES` + lint gate + the awareness snapshot, and the check-id vocabulary must be re-sourced from `typescriptPack`. |
| **11** | `awareness` | REFRAME | not a derivation. Rename so it stops colliding with `src/awareness/**`, and decide separately whether the codebase snapshot gets its own module. Do it last so its `signalCount` settles after every other module has changed size. |

Steps 1–4 remove roughly **48 signals, 20 actions and 28 customizations** with no
derivation risk at all. That is the majority of the fabricated surface, gone before any
derivation is attempted.

---

## 3. SHARED MECHANISM (contract §14)

### What is AGNOSTIC and belongs to ONE owner

`privacy.ts` already demonstrates the agnostic half, in one sentence from its own header:
*"EVERY ENTRY HERE IS DERIVED, NOT AUTHORED… a type added to the registry appears in the
settings surface without anybody editing this file."* Generalised, that is six things:

1. **The absent-value representation.** One type, one wire shape, one render. Currently
   **does not exist** (§0.1).
2. **The provider seam.** A subsystem hands the registry a live reader; signals read
   through it; when nothing is attached the reading is ABSENT. Currently **invented
   twice** — `setActiveLLMClientForExposure` (`shared/llm/exposure.ts:80`) and
   `registerBandaidExposure`-returns-a-state-handle
   (`safety/bandaid-exposure.ts:52`) — and about to be invented a third time.
   This seam is also **mandatory, not optional**: the real sources for `tools`, `editor`,
   `search`, `context` and `memory` live in the **web** tree
   (`metrics-bridge.ts`, `memory-bridge.ts`, `context-bridge.ts`,
   `intelligence-bridge.ts`) while the registrations live in the **integration** tree,
   which must not import the web.
3. **Derivation from a declaration table.** The `for (const x of TABLE)` loop that turns
   `PII_TYPES` / `PRIVACY_TIERS` into registrations. `MEMORY_TIERS`, `BIAS_TYPES`,
   `HALLUCINATION_LAYERS`, `DIAGNOSTIC_CATEGORIES`, `QUALITY_TIERS` and the twelve
   `typescriptPack` checks are all the same shape.
4. **Config-backed customizations.** `current`/`set` reading the global config owner
   rather than a module-local `let`. Would have prevented every drift in §1
   (0.8/0.85, 4096/32768, 5/10, four fake check ids).
5. **Idempotence + reset.** `let xRegistered = false` … `resetXRegistration()` is
   **copy-pasted 12 times, byte-identical apart from the noun.**
6. **The ratio/absent rule.** `denominator === 0 ? 0 : a/b` appears in **9** of the
   modules. Every one is a fabrication: "no calls yet" and "a 0% error rate" are
   different facts. One shared helper, returning ABSENT.

### What is genuinely PER-MODULE

Only four things: the id, the served words (`name`, `description`, module `title` /
`purpose`), the `unit` and `abnormal` bounds, and **the one function that reads the real
source**. Everything else above is scaffolding.

### Is the agnostic half currently duplicated ten times? Yes — and worse.

- Items 5 and 6 above: literally duplicated 12× and 9×.
- `registrations/index.ts` hardcodes a **12-entry `MODULE_REGISTRATIONS` array**, plus
  **12 reset calls** in `resetRegistrationFlags()`, plus **11 state re-exports**, plus
  **12 register re-exports** — four hand-maintained parallel lists over the same
  directory. Contract §3 (*"a list someone must remember to update … will eventually be
  forgotten"*) and §6 (*"discover items (`readdirSync`, prototype scan)"*) both apply
  directly. **Adding a module today means editing five places.** It should be
  `readdirSync`-discovered.
- The `*State` re-exports exist only so tests can reach the mocks. When the mocks go,
  those exports and the tests that use them
  (`test/shared/exposure-customization-liveness.test.ts`,
  `test/shared/exposure-language-guard.test.ts`) go with them.

**Blast radius to plan for:** `exposure-customization-liveness.test.ts` proves each knob
changes the **mock's** behaviour by executing the mock's own actions. Every DELETE and
every DERIVE invalidates part of it. It must be rewritten against the real sources — it
cannot be adjusted.

---

## 4. PREREQUISITES

Ordered. P1 is the one that blocks everything.

**P1 — An absent-value representation, end to end.** *(This is the single most important
thing in this report.)*
Producer (`Signal.value`), wire (`SignalValueEntry.value`), and render must all be able
to carry "not measured" **with a reason in plain words**. Today none of the three can.
Without it, every DERIVE degrades to a fabricated `0` the moment its source is not
attached — which is guaranteed to happen (`context` has no manager between runs;
`tools`/`editor`/`search` have no metrics before the first call; `memory`'s store is
lazy). The pattern to avoid is already visible 22 times in `shared/llm/exposure.ts`
(§0.2). The semantics already exist in this codebase in three places
(`AwarenessSnapshot`'s `| null`, `quality-bridge.ts`'s skip-don't-zero, `readout.ts`'s
prose states) — only the exposure contract lacks the type. Reuse those semantics; do not
invent a fourth vocabulary.

Its immediate corollary: the `denominator === 0 ? 0 : a/b` idiom must be replaced by the
shared ABSENT helper in all 9 places, in the same change.

**P2 — One provider seam, replacing the two that exist.** Dependency inversion so
integration-side registrations read web-side live sources. Decide this **before** step 5,
because `memory`, `context`, `tools`, `editor` and `search` all need it and any two of
them solving it locally recreates the exact §2 defect the step is meant to remove.
`shared/llm/exposure.ts`'s `setActiveXForExposure` is the working proof of the shape —
generalise **that**, do not clone it.

**P3 — Fix the 22 `?? 0` sites in `shared/llm/exposure.ts`.** They are the same defect,
already live, on the same route. Fixing them is the smallest possible end-to-end proof of
P1 and P2 together, on a module that already has a real source — a genuine dress
rehearsal before any of the ten are touched.

**P4 — Resolve the three-doors question (§0.4) before adding to any of them.** Decide
whether `bandaid-exposure.ts` (orphaned) and `llm/exposure.ts` (live) fold into the
`registrations/` directory under the discovered-loader, or whether `registrations/`
adopts their injection shape. Either answer is fine; having two answers is not.

**P5 — Note, not a step: `no-liveness-claims.test.ts` is the acceptance criterion.**
`web-interface-foundation-v1/tests/prevention/no-liveness-claims.test.ts` bans the word
"reporting" from the module surface and states its own retirement condition verbatim:
*"until a verifiable liveness channel exists… Retiring this ban is a deliberate act that
must land IN THE SAME CHANGE as the evidence channel it depends on — deleting this file
is the flag for that review."* P1's "measured / not measured" discriminant **is** that
evidence channel. When S6 completes, that file's deletion is the proof — and until then,
its continued existence is the honest admission that the work is unfinished.

---

## 5. COVERAGE — what I examined, and what I did not

**Read in full:** all 11 registration modules plus `shared.ts` and `registrations/index.ts`;
`exposure/index.ts`, `signal.ts`, `contract.ts`, `README.md`;
`runtime/harness-bootstrap.ts`; `server/schema/ui-schema.ts`; `server/routes/schema.ts`;
`server/context-bridge.ts` (relevant half); `TIER1-AGENT-CONTRACT.md`.

**Read in relevant part:** `memory/unified/unified-context-manager.ts` (types + `state()`),
`memory/unified/unified-config.ts`, `performance/metrics-collector.ts` (interface + types),
`server/metrics-recorder.ts`, `server/tool-executor.ts` (the record site),
`safety/bias-detector.ts` + `bias-config.ts`, `safety/tool-call-gate.ts` (types),
`editor/transactional-editor.ts` (types) + `edit-tools.ts`,
`intelligence/symbol-search.ts` (config type), `awareness/types.ts`,
`shared/llm/exposure.ts` (header + injection) + `shared/llm/client.ts` (constructor),
`safety/bandaid-exposure.ts`, `server/quality-bridge.ts` (header),
`src/lib/module/readout.ts`, `src/lib/metrics/exposure-groups.ts`,
`tests/prevention/no-liveness-claims.test.ts`, `contracts/ui-schema.ts`,
`bridlewise.config.json`.

**Verified mechanically:** zero non-test writers of all eleven `*State` objects
(tree-wide grep excluding `test/`, `.bkp/`, `_experiments/`); all `registerAllExposure`
call sites; production callers (or their absence) for `createBiasDetector`,
`createBiasPreventer`, `registerBandaidExposure`, `registerLLMExposure`,
`createSafetyModule`, `createTransactionalEditor`, `createEditorTools`,
`createToolRegistry`, `createMemoryStore`, `createUnifiedContextManager`,
`createAwarenessEngine`, `createMetricsCollector`, `runAnalysis`, `SelfImprovingWorkflow`.
Four parallel sweep agents independently confirmed the reachability table; where a claim
here rests on an agent's sweep rather than my own read, it is a caller-inventory result
(grep-verifiable), not an interpretation.

**NOT examined — state plainly:**
- I did **not** read the bodies of `metrics-collector.ts`, `unified-context-manager.ts`,
  `memory-store.ts`, `symbol-search.ts`, `bias-detector.ts` or the awareness engine. I
  read their **types, exported signatures and doc-comments**. If an implementation
  quietly maintains a counter its type does not surface, I would have missed it. The
  DELETE verdicts that rest on "no such field exists" are therefore verdicts about the
  **exported interface** — which is all a signal can read anyway.
- I did **not** read `intelligence-bridge.ts` beyond its export list, deliberately —
  another agent is editing it. The `search` verdicts rest on `symbol-search.ts`'s types
  and an export inventory, and step 9 must re-verify against the post-edit file.
- I did **not** examine `web-interface-foundation-v1/server/intelligence-bridge.ts`,
  `tests/prevention/symbol-search-single-path.test.ts`, or
  `integration/src/intelligence/**` beyond `symbol-search.ts`'s type surface — the
  named off-limits set.
- I did **not** run any test suite, typecheck, or the application. Every claim about
  reachability is **static**: "there is a call path from a production entry point",
  not "I observed it execute".
- I did **not** enumerate the `src/awareness/signals/**` (60+ signal modules) or the
  `src/quality/checks/**` (53 check modules) individually. Both are orphaned or
  worker-mediated and neither changes a verdict.
- I did **not** cost the work. The order in §2 ranks by *risk and dependency*, not by
  hours.

**One thing I could not settle:** whether `MetricsCollector`'s per-entry rows survive a
web-server restart or a `reset()`. If they do not, `tools.callCount` is
"calls since this process started", which differs from what the current signal
description promises ("Total number of tool calls dispatched"). The served words must be
re-derived from the source's real semantics at step 7 — a signal that silently changes
what it counts is the same class of lie in a quieter register.

---

## 6. WORKFLOW FINDING (contract §20)

The four independent reachability sweeps agreed on every module except one — `awareness`,
which the brief listed as a mock and which turned out to be genuinely derived. The brief
was written from the modules' **doc-comments** (`"This stub backs the exposure with a
small per-process state object"`), and that comment is simply wrong about its own file:
`performRefresh()` reads the live registry and the background timer is real.

The lesson is mechanical, not editorial: **a module's own header is evidence of intent,
never of behaviour, and the two drift silently.** Had step S6 proceeded from the brief's
list, `awareness` would have been rewritten to derive from something it already derives
from. The cheap guard is the one this sweep used by accident and should use on purpose:
*before classifying a module, grep its `value:` callbacks for calls out of the file.* A
signal whose `value` closure only touches module-local state is a mock; one that calls
across a module boundary is not. That is a one-line discriminator, it is mechanical, and
it would have caught this from the source rather than from the prose.
