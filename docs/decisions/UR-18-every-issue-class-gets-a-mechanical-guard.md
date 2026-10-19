---
id: UR-18
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# Every issue class found gets a mechanical guard

"About the issues you found, ensure these types of issues cannot re-occur in
the future" (user, 2026-10-07). Every CLASS of issue found — not only the
instance — becomes mechanically impossible (a typed API, a schema, a refusal
at a door) or is caught automatically at the lowest choke point (the commit
hooks, `harness check`, the merge door, a test). Reviewer vigilance is not a
guard.

- Each guard proves itself: a planted violation it must catch (in more than
  one place) and a near-miss it must not flag
  ([UR-20](UR-20-tests-are-always-broad.md)).
- A guard's existing debt is a burn-down list that only shrinks, each entry
  owned by a task ([UR-19](UR-19-every-rule-is-retroactive.md)); a genuine
  false positive is fixed in the guard, never exempted one key at a time.
- A verifier names the class of each finding, or proposes a new class; a
  class without a guard is a queue item.
