---
layout: default
title: Decision records
description: The decision record behind Bridlewise, one file per rule.
permalink: /decisions/
---

# Decisions

> [!NOTE]
> These records are historical. Some name the private development branches `testing` and `master`, or files that are not part of the public snapshots. They are published as the decision record, not as a description of the public release topology.


The ONE home of every user rule and every decision in force: one file per
decision, found by name and cited by id, never only in a scratch plan. Other
documents link a decision by its id instead of restating it.

Each file opens with a front matter:

- `id` — the id the plan and the specs cite (`D-04`, `D-R1`, `UD-C1`, `U2`);
  the file is named `<id>-<slug>.md`; `covers` lists the further ids a file
  answers for (a group of accepted recommendations);
- `date`, `by` (`user` or `coordinator`);
- `group` — the section of the index below it is listed in
  (`DECISION_GROUPS` in the checker);
- `status` (`in-force` or `superseded`, with `superseded_by`: a chain of
  supersessions ends at a decision in force); `overrides` names the decisions
  a newer one overrides in part;
- `implementation` — `standing` (binds all work), `pending` (with `route`,
  the task that carries it out), `partial` (with `route` and `acted_in`) or
  `done` (with `acted_in`, the repository paths where it was carried out,
  held by git in the commit that writes them).

The one checker is `engine/scripts/verification/tracker-entries.ts`
(`tests/prevention/decisions-format.test.ts` runs it;
`tests/prevention/agent-docs-liveness.test.ts` checks that the paths and
commands these files name exist; the commit door judges the `acted_in` paths
of every decision a commit writes).

The index below is GENERATED from the files' front matter and titles by
`harness sync` (`engine/scripts/verification/decision-index.ts`; `harness
check` reports it stale): change a decision's file, never its row.

<!-- BEGIN GENERATED: the decision index, from each file's front matter (harness sync; engine/scripts/verification/decision-index.ts) -->

## User rules (standing)

| Id | Decision | By | State |
|---|---|---|---|
| [REC-DIR](REC-DIR-useful-recovery-records-live-in-the-repository.md) | Useful work lives in the repository | user | done |
| [UR-01](UR-01-dry-kiss-yagni-one-owner.md) | Shared owners, one source of truth | user | standing |
| [UR-02](UR-02-generated-values-come-from-generators.md) | Generated values come from generators | user | standing |
| [UR-03](UR-03-caching-never-sacrifices-a-harness-function.md) | Caching never sacrifices a harness function | user | standing |
| [UR-04](UR-04-shared-and-reusable-backend-and-frontend.md) | Shared and reusable, backend and frontend | user | standing |
| [UR-05](UR-05-expose-settings-signals-actions.md) | Expose settings, signals and actions | user | standing |
| [UR-06](UR-06-reduce-build-friction.md) | Every round's friction becomes tooling | user | standing |
| [UR-07](UR-07-secrets-from-the-environment-only.md) | Secrets from the environment only | coordinator | superseded by D-09 |
| [UR-08](UR-08-central-logging-at-the-lowest-choke-point.md) | Everything goes through central logging | user | partial (RC-06) |
| [UR-09](UR-09-independent-verification-before-commit.md) | Independent verification before every commit and push | user | standing |
| [UR-10](UR-10-one-writer-per-repository.md) | One writer per repository | user | standing |
| [UR-11](UR-11-research-when-not-certain.md) | Research whenever you are not certain | user | standing |
| [UR-12](UR-12-master-changes-only-through-the-promotion-door.md) | The product branch changes only through the promotion door | user | standing |
| [UR-13](UR-13-provider-deviations-live-in-a-provider-profile.md) | Provider deviations live in a versioned provider profile | user | pending (RC-08) |
| [UR-14](UR-14-continuation-mandate.md) | The continuation mandate: never stop | user | standing |
| [UR-15](UR-15-coordinate-through-delegated-agents.md) | Coordinate through delegated agents | user | standing |
| [UR-16](UR-16-one-thing-for-everything.md) | One thing for everything | user | standing |
| [UR-17](UR-17-no-fallbacks.md) | No fallbacks | user | standing |
| [UR-18](UR-18-every-issue-class-gets-a-mechanical-guard.md) | Every issue class found gets a mechanical guard | user | standing |
| [UR-19](UR-19-every-rule-is-retroactive.md) | Every rule is retroactive | user | standing |
| [UR-20](UR-20-tests-are-always-broad.md) | Tests are always broad | user | standing |
| [UR-21](UR-21-redact-never-block.md) | Secrets and personal data are redacted, never a reason to block | user | standing |
| [UR-22](UR-22-the-coordination-branch.md) | The coordinator's record lives on the coordination branch | user | standing |
| [UR-23](UR-23-a-concurrent-web-writer.md) | A web writer may work beside the engine writer | user | standing |
| [UR-24](UR-24-zero-new-failures-every-failure-owned.md) | Zero new failures, and every remaining failure owned by a named task | user | done |

## Process decisions (coordinator)

| Id | Decision | By | State |
|---|---|---|---|
| [D-09](D-09-credentials-never-in-repository-records.md) | Agents never write a credential into a record | coordinator | standing |
| [D-10](D-10-precedence-of-records.md) | Which record wins | coordinator | standing |
| [D-11](D-11-isolation-tooling.md) | Isolation tooling: one workspace tool | coordinator | partial (A5-CANDIDATE-RETIRE) |
| [D-12](D-12-authenticated-timeline.md) | The timeline drops HMAC signing; encryption at rest stays open | coordinator | partial (REQ-025) |
| [D-13](D-13-inherited-web-reds.md) | Inherited web reds: the choices | coordinator | partial (PROMO-0) |
| [D-14](D-14-detector-families-and-context-budget.md) | Test-drive fixes: detector families and the context budget | coordinator | pending (RC-04) |
| [D-15](D-15-database-key-outside-the-state-root.md) | The database key lives outside the state root; secret files are read redacted | coordinator | done |
| [D-16](D-16-undici-owns-outbound-transport.md) | undici is the outbound door's one dispatcher | coordinator | done |
| [D-17](D-17-measured-budgets-come-from-a-tool.md) | Measured budgets come from their measuring tool | coordinator | partial (A4-OWNED-BUDGET) |
| [D-18](D-18-key-scan-registers-only.md) | The key scan registers; it never relocates other installs | coordinator | standing |
| [D-19](D-19-temp-root-outside-the-safety-floor.md) | A process's temp root lies outside the safety floor | coordinator | done |
| [D-20](D-20-generating-tooling-lands-with-its-artifact.md) | Tooling that produces a committed artifact lands with it | coordinator | standing |
| [D-W4](D-W4-server-scale-items-belong-to-the-web-writer.md) | The server-side scale items belong to the web writer | coordinator | standing |
| [D-W5](D-W5-mock-free-test-files-share-a-process.md) | Mock-free test files share a process | coordinator | pending (WEB-EFFICIENCY) |
| [EVD-STORE](EVD-STORE-raw-evidence-in-a-content-addressed-store.md) | Code and small records in git; raw evidence in a content-addressed store | user | partial (EVIDENCE-DURABILITY) |
| [FLAKE-REPRO](FLAKE-REPRO-a-flake-cause-needs-a-recorded-reproduction.md) | A flake cause needs a recorded reproduction | coordinator | partial (FLAKE-REPRO-REDECLARE) |
| [INSTRUMENT-LOCK](INSTRUMENT-LOCK-the-host-has-one-instrument-lock.md) | The host has one instrument lock | coordinator | done |
| [KILL-OWNED-ONLY](KILL-OWNED-ONLY-signal-only-what-you-started.md) | Signal only what you started | coordinator | done |
| [LIVE-SUITE](LIVE-SUITE-one-live-suite-no-hermetic-skips.md) | One live suite; the hermetic suites have no skips | coordinator | done |
| [REQUIRES](REQUIRES-a-gate-runs-after-what-it-judges.md) | A gate runs after the steps that produce what it judges | coordinator | done |
| [UD-AUDIT-NO-FORGIVENESS](UD-AUDIT-NO-FORGIVENESS-no-rerun-forgiveness-no-ambient-allowance.md) | No rerun forgiveness, no ambient-load allowance | user | partial (AMBIENT-ALLOWANCE-REMOVE) |
| [UD-CORE-NO-BYPASS](UD-CORE-NO-BYPASS-a-module-cannot-bypass-core.md) | A module cannot bypass core | user | pending (CORE-NO-BYPASS) |
| [UD-LOG-NEVER-DISABLED](UD-LOG-NEVER-DISABLED-warn-and-error-always-reported.md) | Logging is never disabled | user | pending (LOG-NEVER-DISABLED) |
| [UR-24-BUDGETS](UR-24-BUDGETS-a-budget-breach-joins-the-one-judgement.md) | A budget breach joins the one judgement | coordinator | partial (AMBIENT-ALLOWANCE-REMOVE) |

## Earlier engine decisions (coordinator)

| Id | Decision | By | State |
|---|---|---|---|
| [D-04](D-04-logging-migration-ratchet.md) | Logging migrates in place under a ratchet | coordinator | pending (RC-06) |
| [D-05](D-05-sub-agent-model-resolution.md) | A sub-agent resolves its own model or refuses | coordinator | pending (RC-28) |
| [D-06](D-06-no-dead-retry-config.md) | No dead retry configuration | coordinator | pending (CFG-3) |
| [D-07](D-07-undeclared-function-call-is-recoverable.md) | An undeclared function call is a recoverable refusal | coordinator | pending (RC-29) |
| [D-08](D-08-background-mode-per-provider.md) | Background mode only where the provider declares it | coordinator | pending (RC-43) |
| [GUARD-F5](GUARD-F5-a-link-under-the-floor-is-kept-out-by-what-it-names.md) | A link under the keep-out floor is kept out by what it names | coordinator | partial (KEEP-OUT-HARDLINKS) |

## Prompt cache

| Id | Decision | By | State |
|---|---|---|---|
| [D-R1](D-R1-stable-tool-superset.md) | A stable tool superset with a gate refusal | coordinator | superseded by U2 |
| [D-R2](D-R2-frozen-workspace-snapshot.md) | The workspace snapshot is frozen per chat | coordinator | superseded by U1 |
| [D-R3](D-R3-trim-target.md) | The trim target defaults to 0.5 | coordinator | pending (RC-40) |
| [D-R4](D-R4-cache-layout.md) | The prompt-cache layout | coordinator | pending (RC-39) |
| [U-REASONING](U-REASONING-reasoning-replay-mode.md) | Provider profiles declare the reasoning replay mode | user | pending (RC-38) |
| [U-X](U-X-safe-cache-items.md) | The cache items that lose no function (covers X1, X3b, X4, X5, X7, X8b, X9b, X11b, X12, X13) | user | pending (RC-39) |
| [U1](U1-snapshot-plus-live-delta.md) | Workspace awareness: the snapshot plus a live delta | user | pending (RC-41) |
| [U2](U2-switched-off-tools.md) | Switched-off tools | user | pending (RC-42) |
| [U3](U3-large-payloads-stay-retrievable.md) | Large payloads stay abridged and retrievable | user | pending (RC-03) |
| [U4](U4-exclude-only-retained-runs.md) | Recall excludes only retained runs | user | pending (MEM-5a) |
| [U5](U5-project-from-the-chat.md) | The project is derived from the chat | user | pending (MEM-2) |
| [U6](U6-memory-tiers.md) | Project-scoped recall plus an opt-in user memory tier | user | pending (MEM-8) |
| [U7](U7-segment-summaries.md) | Segment summaries with a recent-turn floor | user | pending (RC-40) |
| [U8](U8-append-the-tail-when-changed.md) | The tail is appended when it changes | user | pending (RC-44) |
| [U9](U9-context-budget-is-a-ratio.md) | The context budget is a ratio of the model window | user | pending (RC-12) |

## Configuration, prompts and credentials

| Id | Decision | By | State |
|---|---|---|---|
| [CFG-DIR](CFG-DIR-configuration-redesign.md) | Configuration is a code registry plus the database | user | pending (CFG) |
| [CRED-DIR](CRED-DIR-credentials-the-model-never-sees.md) | Credentials the model never sees | user | pending (CRED) |
| [CRED-EXFIL](CRED-EXFIL-per-use-approval-first.md) | Exfiltration control starts with per-use approval | user | pending (CRED) |
| [CRED-UD-1](CRED-UD-1-pasted-secrets-are-vaulted.md) | Pasted secrets are vaulted automatically | user | pending (CRED-6a) |
| [CRED-UD-3](CRED-UD-3-no-exposed-tier.md) | The exposed tier never ships | user | standing |
| [UD-C1](UD-C1-most-specific-scope-wins.md) | The most specific scope wins | user | pending (CFG) |
| [UD-C9](UD-C9-prompt-registry.md) | Prompts live in a versioned prompt registry (covers PRM-DIR) | user | pending (PRM-0) |
| [UD-CFG-CRED](UD-CFG-CRED-configuration-and-credential-recommendations.md) | The configuration and credential designs' recommendations (covers UD-C2, UD-C3, UD-C4, UD-C5, UD-C6, UD-C7, UD-C8, UD-C10, UD-C11, UD-C12, UD-C13, UD-R2, UD-R4, UD-R5, UD-R6, UD-R7, UD-R8, UD-R9) | user | pending (CFG) |
| [UD-P](UD-P-prompt-registry-choices.md) | The prompt registry's design choices (covers UD-P1, UD-P2, UD-P3, UD-P4, UD-P5, UD-P6, UD-P7) | user | pending (PRM-0) |

## Promotion

| Id | Decision | By | State |
|---|---|---|---|
| [PROMO-AUTO](PROMO-AUTO-promote-after-every-testing-push.md) | Auto-promotion is on | user | done |
| [PROMO-DIR](PROMO-DIR-a-generic-promotion-primitive.md) | Promotion is a generic, hands-free primitive | user | pending (PROMO-0) |
| [PROMO-FIRST](PROMO-FIRST-the-first-promotion-reviewed.md) | The first promotion: reviewed by the user, then applied | user | done |
| [PROMO-UD](PROMO-UD-promotion-choices.md) | The promotion design's choices (covers PROMO-UD-1, PROMO-UD-2, PROMO-UD-3, PROMO-UD-4, PROMO-UD-5, PROMO-UD-6, PROMO-UD-7, PROMO-UD-8) | user | pending (PROMO-0) |

## The Responses sequence

| Id | Decision | By | State |
|---|---|---|---|
| [Q-ACCEPTED](Q-ACCEPTED-responses-plan-recommendations.md) | The Responses plan's recommendations (covers Q1, Q2, Q4, Q5, Q7, Q8, Q10, Q12, Q13, Q14, Q15, Q16, Q17, Q18, Q19) | coordinator | pending (RC) |
| [Q11](Q11-context-budget-everywhere.md) | 45% of the model window everywhere | user | pending (RC-12) |
| [Q3](Q3-hardened-log-file-sink.md) | A hardened log file sink | user | pending (RC-06) |
| [Q6](Q6-versioning-after-cp3.md) | Module versioning follows the third checkpoint | user | pending (MV) |
| [Q9](Q9-drive-budget.md) | The test-drive budget | user | standing |
| [RC-AMEND](RC-AMEND-spec-amendment-points.md) | The spec amendments' open points | coordinator | pending (RC) |
| [RC-DIR](RC-DIR-responses-everywhere.md) | The Responses API everywhere, driven against a real provider | user | pending (RC) |
| [UD-AUDIT-ROUTING](UD-AUDIT-ROUTING-provider-failover-is-explicit-routing.md) | Provider failover is explicit routing | user | pending (RC-ROUTING) |

## Scale

| Id | Decision | By | State |
|---|---|---|---|
| [SCALE-AGENTS](SCALE-AGENTS-capacity-counts-every-agent.md) | Capacity counts every agent, sub-agents included | user | pending (SCALE-6) |
| [SCALE-DIR](SCALE-DIR-two-hundred-active-and-beyond.md) | The server easily carries 200 active conversations, then goes further | user | pending (SCALE) |
| [UD-S1](UD-S1-per-call-ledger-rows-stay.md) | Per-call ledger rows stay; performance is pushed instead | user | pending (SCALE-2a) |
| [UD-S10](UD-S10-gate-delegation-mix.md) | Each gate's mixed run delegates 25% of turns, three wide, two deep | coordinator | pending (SCALE-0) |
| [UD-S11](UD-S11-delegation-depth-eight.md) | Delegation depth defaults to 8 | user | pending (SCALE-6) |
| [UD-S12](UD-S12-chain-covers-a-documents-digest.md) | New events' chain envelope covers a documents digest | user | pending (SCALE-2b) |
| [UD-S15](UD-S15-archive-and-remove-the-fixture-chats.md) | The fixture chats leave the real database, archived first | user | done |
| [UD-S2](UD-S2-a-ledger-shard-per-project.md) | A ledger shard per project, each with its own writer | user | pending (SCALE-3b) |
| [UD-S3](UD-S3-archive-never-delete.md) | Logs are never lost: segment and archive, never delete | user | pending (SCALE-9) |
| [UD-S4](UD-S4-as-high-as-possible-no-hard-ceilings.md) | As high as possible, with no hard ceilings | user | pending (SCALE-5) |
| [UD-S5](UD-S5-lossless-volume-reduction.md) | Ledger volume falls losslessly, not by compression alone | user | pending (SCALE-2b) |
| [UD-S5b](UD-S5b-hot-lean-archive-sealed-tiers.md) | Hot lean rows, sealed compressed archive, queue on low disk | user | pending (SCALE-2b) |
| [UD-S6](UD-S6-one-shard-per-project.md) | The shard grouping default is one shard per project | coordinator | pending (SCALE-3b) |
| [UD-S7](UD-S7-shards-share-the-web-database-key.md) | Every shard is sealed with the web database's key | coordinator | pending (SCALE-3b) |
| [UD-S8](UD-S8-the-existing-ledger-stays-in-place.md) | The existing ledger stays in place | coordinator | pending (SCALE-3b) |
| [UD-S8b](UD-S8b-legacy-shard-keeps-memory.md) | The legacy shard keeps memory storage as it is (replaced) | user | superseded by MEM-DIR |
| [UD-S9](UD-S9-it-cannot-crash.md) | It cannot crash: fix the actual causes; durability before effect | user | partial (SCALE-IE) |
| [UD-S9b](UD-S9b-durability-defaults-per-class.md) | Durability defaults per class; tools fail closed; fail-stop and restart | user | partial (SCALE-IE) |

## Memory layers

| Id | Decision | By | State |
|---|---|---|---|
| [MEM-DIR](MEM-DIR-continue-the-memory-layers-lab.md) | Continue the memory-layers lab, then build its proven designs on the lean ledger | user | pending (MEM) |
| [MEM-EXCL](MEM-EXCL-memory-layers-off-limits.md) | The memory layers are off-limits (lifted) | user | superseded by MEM-DIR |
| [MEM-SIZE](MEM-SIZE-lossless-memory-size-reductions.md) | Find further lossless memory size reductions | user | pending (MEM-LAB-SIZE) |
| [U-M-GLOBAL](U-M-GLOBAL-a-global-memory-tier-is-evaluated.md) | A global memory layer of harness knowledge, admitted by checks and two-person admin approval | user | pending (MEM-LAB-M5) |
| [U-M1](U-M1-memory-on-the-project-and-user-shards.md) | Project memory lives in its project shard, user memory in a per-user shard | user | pending (MEM-3a) |
| [U-M2](U-M2-forget-is-a-crypto-shred.md) | Forgetting destroys a key: memory references the ledger, under per-conversation keys | user | pending (MEM-6) |
| [U-M3](U-M3-capacity-proven-on-a-dedicated-volume.md) | The memory capacity floors are proven on this host, within about 100 GB | user | pending (MEM-LAB-M10) |
| [U-M4](U-M4-answer-precision-measured-within-twenty-dollars.md) | Memory placement is chosen from measured precision, within $20 of Coral | user | pending (MEM-LAB-M4) |
| [U-M5](U-M5-quantized-vectors-and-a-keyed-lexical-index.md) | The memory index is int8 vectors with certified exact rescoring, plus a keyed lexical index | user | pending (MEM-5a) |
| [U-M6](U-M6-no-interim-patches-to-the-old-memory-path.md) | No interim patches to the old memory path | user | standing |
| [UD-MCP-MEMORY](UD-MCP-MEMORY-mcp-outputs-in-the-memory-layer.md) | MCP tool outputs can live in the memory layer | user | pending (MEM-6) |

## Labs (docs, browser, intelligence)

| Id | Decision | By | State |
|---|---|---|---|
| [BL-DIR](BL-DIR-finish-the-browser-lab.md) | Finish the browser-integration lab | user | pending (BL-R1) |
| [BL-RES](BL-RES-the-browser-lab-resources.md) | What the browser lab may use: "everything needed" | user | standing |
| [BL-U1](BL-U1-app-docs-and-server-packages.md) | The app, the docs and the server are separate packages | user | pending (BL-R3) |
| [BL-U2](BL-U2-the-docs-graduate-as-their-own-package.md) | The docs compiler graduates as the bridlewise-docs package | user | pending (PKG-1) |
| [BL-U3](BL-U3-rebaseline-the-app-once.md) | The lab app is re-baselined onto testing once, after its stage is sealed | user | pending (BL-R2) |
| [BL-U4](BL-U4-seal-fifty-streams-plus-one-two-hundred-run.md) | Seal the fifty-stream stage, plus one 200-stream run | user | pending (BL-R1) |
| [D-W1](D-W1-the-replica-key-is-server-held.md) | The replica key is server-held | user | pending (WEB-EFFICIENCY) |
| [D-W2](D-W2-a-deduplicated-compressed-replica.md) | A deduplicated, compressed replica of 256 MiB | user | pending (WEB-EFFICIENCY) |
| [D-W3](D-W3-offline-is-read-only.md) | Offline is read-only, with a banner | user | pending (WEB-EFFICIENCY) |
| [D-W6](D-W6-a-remote-action-shows-a-named-in-flight-row.md) | A remote action shows a named in-flight row | user | pending (WEB-EFFICIENCY) |
| [INTEL-DIR](INTEL-DIR-integrate-proven-codegraph-improvements.md) | Integrate the proven intelligence-codegraph improvements | user | pending (INTEL-TRANSFER) |
| [LAB-UD](LAB-UD-docs-lab-graduation.md) | The docs-writer lab's decisions (covers LAB-D1, LAB-D2, LAB-D3, LAB-D4, LAB-D5) | user | pending (LAB-6) |
| [UD-ONE-PARSER](UD-ONE-PARSER-one-parsing-owner-for-every-consumer.md) | One parsing owner for every consumer | user | pending (INTEL-L0) |
| [UD-UI-LOCAL-FIRST](UD-UI-LOCAL-FIRST-every-click-within-ten-milliseconds.md) | Every click within ten milliseconds: a local-first UI | user | pending (WEB-EFFICIENCY) |

<!-- END GENERATED: the decision index -->
