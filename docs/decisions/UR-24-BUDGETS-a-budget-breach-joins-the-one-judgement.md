---
id: UR-24-BUDGETS
date: 2026-10-07
by: coordinator
group: process
status: in-force
implementation: partial
route: AMBIENT-ALLOWANCE-REMOVE
acted_in: [engine/src/workflow/workspace-manager.ts, engine/src/workflow/failure-owners.ts, engine/src/kernel/root-policy.ts, engine/src/shared/budget-verdict.ts, scripts/testing/performance-measurements.ts]
---
# A budget breach joins the one judgement

This is the coordinator's amendment to [UR-24](UR-24-zero-new-failures-every-failure-owned.md):
round-3 decision E' of 2026-10-07, tightened in LAND-OC-FIX round 5 §2 and by
the user's decision #2 of 2026-10-08 (round 12). It adds no second rule.

- **One judged run is the verdict (USER DECISION #2, 2026-10-08).** A CPU
  budget breach fails the run it happened in: the `overCapRunsBeforeRed`
  streak and the "recorded, not red" spread band are deleted
  (engine/src/shared/budget-verdict.ts `cpuCap`). The same-tree spread
  survives only as the measuring tool's outlier line (D-17), never as a
  verdict's allowance; the rolling baseline is fed only by runs whose own CPU
  outcome passed, so it cannot climb on failing runs (round 13).

- **When a breach passes.** A budget gate's breach that persists from the
  target passes only while both of these hold:
  - an open task row declares the budget, by its config key, for example
    `testExecution.webUiSuiteCpuBudget`, matched as a whole token
    (engine/src/workflow/failure-owners.ts);
  - this change's value, measured inside the host's one instrument lock, is no
    higher than the LOWEST value the target's tree recorded inside that lock.
- **Only slotted rows count, on both sides.** An unslotted row may have shared
  the cores with another heavy run, so it says nothing about the tree: only a
  row stamped `heavySlot: "held"` feeds the rolling baseline or the measuring
  tool's window (round 12), and a legacy row with no stamp feeds nothing.
- **A target with no slotted run is measured first.** The workspace measures
  the target in the lock (`ensureTargetBaselines`) and then judges strictly.
  A target whose slotted runs carry no value of a budget an open row owns is
  measured too, through the one sequencer (its suite's producers first: the
  web suite's perf profile). There is no allowance and no re-run.
- **The web-UI performance budgets are judged here, and only here**
  (coordinator, LAND-OC-FIX round 9; UR-16). Their names and kinds are one
  list (`ROOT_POLICY.workflow.webPerformanceBudgets`). The web reporter reads
  the profile report's measurements (scripts/testing/performance-measurements.ts),
  records them in the run's row and fails a breach by its gate
  (`performance:<name>`); the regression gate's arms judge only the report's
  integrity, never a budget. A report that cannot be judged — absent,
  measured outside the lock, or of other code (`judgeableProfileReport`, the
  one predicate) — FAILS the run (`performance-report`): an unmeasured budget
  is never a pass, and the workspace judge counts any non-pass outcome of a
  budget gate as a breach (round 12).
- **What fails.** All of the following fail:
  - a breach with no slotted value on either side;
  - a worse value;
  - an unslotted measurement;
  - an unowned breach;
  - any budget gate that `ROOT_POLICY.workflow.failureOwners.budgets` does not
    name.
- **A read-only validation passes no breach.** It has no target to own one
  against.
- **The ambient-load allowance still in code is said, numerically, in every
  verdict.** The user removed it on 2026-10-07 (UD-AUDIT-NO-FORGIVENESS). It
  is removed ATOMICALLY in the web writer's rebased workspace right after the
  engine merge, as its FIRST item (AMBIENT-ALLOWANCE-REMOVE: the removal,
  regenerated in round 13 with the floor re-derived from raw readings by the
  measuring tool, checked on every run to still apply
  (engine/test/workflow/parked-patches.test.ts), and kept in the repository at
  docs/trackers/patches/AMBIENT-ALLOWANCE-REMOVE.patch, across engine/src/shared/budget-verdict.ts and the web writer's
  tests/helpers/budget-config.ts). Until then every budget verdict, and every
  report quoting one, states the allowance in force — +5.0% per unit of
  5-minute load per CPU, capped at +12.0% — and what it added to that
  verdict, so no pass reads as a strict one. "No allowance" in this decision
  means no allowance BEYOND that one, stated; this decision is `partial`
  until it is gone.
