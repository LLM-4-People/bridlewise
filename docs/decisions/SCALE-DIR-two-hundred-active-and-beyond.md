---
id: SCALE-DIR
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE
---
# The server easily carries 200 active conversations, then goes further

The server must EASILY handle at least 200 concurrent ACTIVE projects and
conversations; where it already does, find the real ceiling and raise it.
200 is the first checkpoint, not a target cap
([UD-S4](UD-S4-as-high-as-possible-no-hard-ceilings.md)); capacity counts
every agent ([SCALE-AGENTS](SCALE-AGENTS-capacity-counts-every-agent.md)).
Scaling never sacrifices a harness function, feedback or a log
([UR-03](UR-03-caching-never-sacrifices-a-harness-function.md) applies to
scale as to caching), and every limit is an exposed setting
([UR-05](UR-05-expose-settings-signals-actions.md)). The work is the SCALE
queue (the scale design's tasks, interleaved with the RC sequence; the
test-drive checkpoints gain a concurrency scenario).
