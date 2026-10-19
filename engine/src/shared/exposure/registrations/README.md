# Exposure registrations

The per-module exposure registrations: the signals, actions, and
customizations every module exposes, gathered behind one
`registerAllExposure` entry point so the whole catalog is registered in a
single call.

## What each file does

- `awareness.ts`, `artifacts.ts`, `bias.ts`, `context.ts`, `dedup.ts`, `editor.ts`,
  `graph.ts`, `hallucination.ts`, `intelligence.ts`, `learning.ts`, `mcp.ts`,
  `memory.ts`, `privacy.ts`, `quality.ts`, `safety.ts`, `search.ts`, `tools.ts`
  — the per-module registration, each declaring the signals, actions, and
  customizations for its module. Several derive their entries from the live
  subsystem rather than authoring them, so the exposure cannot drift from the
  implementation.
- `database.ts` — the web database's upgrade safety net as signals: `database.backupRetention` (`HARNESS_WEB_DB_BACKUP_RETENTION`) and `database.newestPreMigrationCopy`; the source is installed by the web server at boot.
- `index.ts` — the central entry point: imports every per-module
  registration and exposes `registerAllExposure`.
- `network.ts` — The outbound door's exposure: the settings `network.cleartextRemote`, `network.userPrivateAddresses` (the destination rule stamped on a credential at mint) and `network.idleConnectionMs`, and the signals `network.outboundRefusals`, `network.cleartextOrigins`, `network.proxiedOrigins`.
- `process.ts` — the faults this process met: `process.faults.role`, `process.faults.unhandledRejections`, `process.faults.guardedCallbacks` and `process.faults.lastFault`, read from the one fault policy (`src/process/fault-policy.ts`; a service lives on after one, a tool fails closed).
- `performance.ts` — what the harness measures about itself: the metrics
  collector's counts, lanes, quantiles and token throughput as signals, plus
  the resource sampler's own last tick; the resource-delta and sampler knobs,
  the benchmark command's run bounds and the diagnostic command's mode
  timeout as customizations; and the benchmark tool's two detection budgets
  (regression and overhead) as READ-ONLY signals — a budget that decides a
  tool's verdict is that tool's contract, so the room shows it without
  offering to write it. Fed by the installable state source the server's
  metrics bridge installs at boot.
- `promotion.ts` — shipping to the product branch (`harness promote`), read only: the signals `promotion.profiles`, `promotion.pending` and `promotion.advisories` and the actions `promotion.status`, `promotion.plan` and `promotion.explain`, answered by the source the engine CLI installs (`src/workflow/promotion/context.ts`); the web server installs none, so its rows read `unmeasured` and its actions refuse (`promotion_source_unavailable`).
- `redaction.ts` — the re-hiding store's registration: the store's live
  occupancy as a signal (through an installable source the web redaction
  owner installs) and the `redaction` section's one bound — the store's
  capacity — as its config-bound knob, with the restart timing its
  once-per-process consumer actually has.
- `settings.ts` — the settings store's own state (`settings.storeState`:
  absent, ok, unreadable — the last readable settings stay in force and every
  save is refused with `config_unreadable` — or unmeasured) and the refusal's
  reason (`settings.storeRefusal`). The names CFG keeps when the store moves
  to the database. Fed by the installable source the web server installs at
  boot (`getSettingsStoreState`).
- `timeline.ts` — the recorded ledger's registration: the
  provider-payload-capture mirror as a signal and its config-bound knob,
  so the timeline's one persistent setting is served with everything else.
- `web-performance.ts` — how fast the web app must stay: the webUi section's
  thirteen performance ceilings as READ-ONLY signals reading their config
  paths — the perf-profile regression gate's own verdict budgets, visible in
  the instruments room and never writable from the settings room (the same
  doctrine as the benchmark budgets above, at the gate that judges the web
  tree itself). No customizations: the file is the machine administrator's
  path, with the re-derivation recorded beside the change.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/exposure/registrations/`.

- `agents.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `artifacts.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `awareness.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `bias.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `context.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `database.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `dedup.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `editor.ts` is consumed by `engine/src/editor/edit-tools.ts`, `engine/src/shared/exposure/registrations/index.ts`, `server/blocks/editor.ts`, `server/llm/llm-bridge.ts`, `server/tools/tool-executor.ts`, `server/tools/tools-bridge.ts`.
- `graph.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `hallucination.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`, `server/kernel/canonical.ts`.
- `harness-commands.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `index.ts` is consumed by `engine/src/runtime/harness-bootstrap.ts`, `server/kernel/canonical.ts`.
- `intelligence.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `learning.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `mcp.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `memory.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `network.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `performance.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `privacy.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `process.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `promotion.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`, `engine/src/workflow/promotion/context.ts`.
- `quality.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `redaction.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `safety.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`, `server/kernel/canonical.ts`.
- `search.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `settings.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `test-execution.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `timeline.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `tools.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `web-performance.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.
- `workspace-git.ts` is consumed by `engine/src/shared/exposure/registrations/index.ts`.

<!-- /consumers:generated -->
