---
id: SCALE-AGENTS
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-6
---
# Capacity counts every agent, sub-agents included

Capacity is the total of concurrent agents: parents plus delegated or
orchestrated sub-agents, possibly nested. Queuing is fair by tree, so one
conversation's fan-out cannot starve the others; sub-agent streams, ledger
writes, spawns and MCP sessions are all budgeted; cancellation and
backpressure propagate through the tree; every gate and load profile
includes fan-out. Refines [SCALE-DIR](SCALE-DIR-two-hundred-active-and-beyond.md);
the depth bound is [UD-S11](UD-S11-delegation-depth-eight.md), the gate mix
[UD-S10](UD-S10-gate-delegation-mix.md).
