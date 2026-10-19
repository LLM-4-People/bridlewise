---
id: UD-S4
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-5
---
# As high as possible, with no hard ceilings

The target is "as high as possible without losing any functionality,
feedback or logs; very efficient, extremely fast; single or many projects;
no limits". 200 is the first checkpoint, then 500, 1000 and beyond, measured
by the load harness (the ladder has no stop at a target). Every concurrency
limit becomes an adaptive, generous, configurable setting
([UR-05](UR-05-expose-settings-signals-actions.md)), and admission becomes a
queue with backpressure instead of a refusal. Refines
[SCALE-DIR](SCALE-DIR-two-hundred-active-and-beyond.md).
