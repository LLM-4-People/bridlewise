---
id: UR-24
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: done
acted_in: [engine/src/workflow/failure-owners.ts, engine/src/workflow/workspace-manager.ts, engine/scripts/tooling/test-receipt.ts, engine/src/shared/run-history.ts]
---
# Zero new failures, and every remaining failure owned by a named task

A change lands with ZERO NEW failures, and every failure that remains is
owned by a named task (user, standing policy; restated by the coordinator for
LAND-OC-FIX R4, 2026-10-07). The workspace's suite gates (`ws validate`, the
engine and the web ledgers alike) carry it out as ONE judgement over the
target's recorded run, keyed by its tree:

- a failure the target's run does not have is NEW and fails the gate — even
  in a file a task owns, and even when the test would pass alone (nothing is
  re-run: [UR-17](UR-17-no-fallbacks.md));
- a failure that persists from the target but fails differently (another
  digest) is a new defect under an old identity and fails the gate;
- a failure that persists from the target the same way passes only when an
  OPEN task row of `docs/trackers/TASKS.md` (`- [ ] **<ID>**`, with its
  continuation lines) names its test's repository path
  (`engine/test/…`, `tests/…`); the gate names the owner. One no open row
  names fails the gate.

A BUDGET breach joins the same judgement through the coordinator's amendment
[UR-24-BUDGETS](UR-24-BUDGETS-a-budget-breach-joins-the-one-judgement.md)
(by: coordinator, 2026-10-07). That clause is the coordinator's, not the user's.

A test that SKIPS did not pass: the engine runner names every dispatched skip
(`<file>::<name>`, with its reason), and the skip is judged like a failure
(`<file>::<name> (skipped)`, its digest the reason). An unnamed skip, a
withheld test, a todo or a cancellation stays an independent refusal.
