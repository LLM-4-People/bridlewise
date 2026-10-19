---
id: UD-AUDIT-NO-FORGIVENESS
date: 2026-10-07
by: user
group: process
status: in-force
implementation: partial
route: AMBIENT-ALLOWANCE-REMOVE
acted_in: [engine/src/shared/budget-verdict.ts, engine/src/shared/run-history.ts, engine/src/workflow/workspace-manager.ts]
---
# No rerun forgiveness, no ambient-load allowance

The user's audit decisions of 2026-10-07 (PLAN.md, "USER DECISIONS (2026-10-07, audit)"):

- **Flaky-rerun forgiveness is DELETED.** Each flaky test is fixed at its
  cause, and the checks are deterministic. A new failure that the flaky memory
  already holds is a regression like any other: nothing is re-run alone to pass.
  A suspect leaves the reds only through
  [FLAKE-REPRO](FLAKE-REPRO-a-flake-cause-needs-a-recorded-reproduction.md),
  or is owned by a shrink-only burn-down entry: nothing ages out (there is no
  window, and a failing row the run history trims moves to its never-trimmed
  suspect archive, round 13).
- **The budget-level forgiveness is DELETED too (round 12, the user's
  decision #2 of 2026-10-08).** A CPU budget breach once passed until three
  consecutive runs breached (`overCapRunsBeforeRed`) and inside a "recorded,
  not red" spread band; both are deleted: one judged run over the cap fails
  ([UR-24-BUDGETS](UR-24-BUDGETS-a-budget-breach-joins-the-one-judgement.md)).
- **The ~12% ambient-load allowance is REMOVED.** It is a slope of 5% per
  unit of recorded 5-minute load per CPU, capped at 12%. It is STILL APPLIED
  in code (engine/src/shared/budget-verdict.ts `ambientInflationFraction`,
  config `webUiSuiteCpuBudget.ambientInflation*`) until AMBIENT-ALLOWANCE-REMOVE
  lands. The removal is written, regenerated in round 13 against the landing
  (with the floor re-derived from raw readings by the measuring tool, D-17),
  checked on every run to still apply (engine/test/workflow/parked-patches.test.ts)
  and kept at docs/trackers/patches/AMBIENT-ALLOWANCE-REMOVE.patch; it spans two leases (UR-23), so it
  lands ATOMICALLY in the web writer's rebased workspace right after the
  engine merge, as its FIRST item. Until then every budget verdict states the
  allowance in force numerically, and what it added
  ([D-17](D-17-measured-budgets-come-from-a-tool.md),
  [UR-24-BUDGETS](UR-24-BUDGETS-a-budget-breach-joins-the-one-judgement.md));
  and a reading counts only when it was measured inside the host's one
  instrument lock.
