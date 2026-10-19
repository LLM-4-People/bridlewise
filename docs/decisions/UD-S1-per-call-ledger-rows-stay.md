---
id: UD-S1
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-2a
---
# Per-call ledger rows stay; performance is pushed instead

Full fidelity is the default: one ledger row per call stays (the proposed
engine-span rollup is withdrawn). Speed comes from doing the same work
cheaper: batching and group commit, prepared statements, a cheaper row and
minimal main-thread work. Refines
[UR-03](UR-03-caching-never-sacrifices-a-harness-function.md): no function
or record is traded for throughput.
