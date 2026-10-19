---
id: D-17
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: partial
route: A4-OWNED-BUDGET
acted_in: [scripts/testing/measure-web-budget.ts, engine/src/shared/budget-verdict.ts]
---
# Measured budgets come from their measuring tool

A measured budget (the web test-runtime budget, a per-file ceiling) is a
generated value: a measuring tool records it from N clean runs, owned by a
generator, and it is never edited by hand (see
[UR-02](UR-02-generated-values-come-from-generators.md)). A reading is taken
inside the host's one instrument lock; a run outside it is refused, never
judged, and never tuned for. Under load the reading is NOT refused: until
AMBIENT-ALLOWANCE-REMOVE lands it is ambient-adjusted (below), stated.

The web budget's tool is `npm run budget:measure -- --check|--write`
(`scripts/testing/measure-web-budget.ts`, arithmetic `measureBudgetFloor` in
`engine/src/shared/budget-verdict.ts`): the median of the last
`baselineWindowRuns` clean judged full runs of the current population, each
stamped as measured inside the host's one instrument lock (`heavySlot:
"held"`; a row without the stamp feeds nothing), written through the
config-path writer.

**The ambient-load allowance is removed (the user's decision of 2026-10-07,
[UD-AUDIT-NO-FORGIVENESS](UD-AUDIT-NO-FORGIVENESS-no-rerun-forgiveness-no-ambient-allowance.md),
standing).** It is still APPLIED in code — each reading ambient-adjusted by
`ambientInflationSlopePerCpu` 0.05 per unit of 5-minute load per CPU, capped
at `ambientInflationCapFraction` 0.12 — until AMBIENT-ALLOWANCE-REMOVE lands.
It lands ATOMICALLY in the web writer's rebased workspace, right after the
engine merge, as that workspace's FIRST item (the saved removal patch:
engine/src/shared/budget-verdict.ts with the web writer's
tests/helpers/budget-config.ts, which are in two leases). UNTIL THEN EVERY
BUDGET VERDICT STATES THE ALLOWANCE IN FORCE, NUMERICALLY — the verdict line
itself (`[ambient allowance in force until AMBIENT-ALLOWANCE-REMOVE: +5.0% per
unit of 5-minute load per CPU, capped at +12.0%; this verdict: +x%]`) and
every report that quotes a verdict — so no pass is mistaken for a strict one.
The removal was written in round 6, no longer applied by round 12 and was
rebased then; it was regenerated in round 13 against the round-13 fold and is
kept in the repository at docs/trackers/patches/AMBIENT-ALLOWANCE-REMOVE.patch
(apply it with `git apply`; it carries its tests), where the owning task lands
it. engine/test/workflow/parked-patches.test.ts checks on every run that it
still applies. The removal RE-DERIVES THE FLOOR through this tool: without the
allowance the verdict judges raw readings, so the ambient-adjusted floor no
longer measures what is judged. The patch carries the floor the tool wrote at
regeneration (1968 at 521 files, raw window 1947.2-2019.7); whoever applies it
re-runs `npm run budget:measure -- --write` on that day's ledger and carries
the tool's value into the derivation record and the pin.

Until `baselineWindowRuns` runs of the current population are recorded the
tool answers `unmeasurable` with the count, and the re-derivation waits for
them.

The rows it measures are the eligible rows (one rule, `eligibleBudgetReadings`:
not a mutation run, the current population within the declared drift, none of
the gate's own failures other than its population arm, slotted, and — until
AMBIENT-ALLOWANCE-REMOVE — ambient-adjusted), and one outlier line
(`sameTreeSpreadFraction`) drops an overloaded outlier against the window's
own median (a stale floor cannot be the reference of its own re-derivation).
The ROLLING BASELINE reads the same eligible rows, but a row feeds it only if
its OWN CPU outcome passed (the outcome it recorded, and its reading within
the cap in force at its moment): a run that failed the cap never moves the
cap (round 13, design HIGH 1). With the floor as its lower bound, the rolling
baseline therefore never rises above the floor; only this tool moves the
floor. The spread is never a verdict's allowance (one judged run over the cap
fails, UR-24-BUDGETS).
