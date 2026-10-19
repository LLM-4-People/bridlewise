---
id: D-06
date: 2026-09-27
by: coordinator
group: engine
status: in-force
implementation: pending
route: CFG-3
---
# No dead retry configuration

`retryableStatusCodes` is wired into the one retry classifier when it maps to
real behaviour, and deleted otherwise: a setting nothing reads is not kept.
