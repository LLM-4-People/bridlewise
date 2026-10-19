---
id: U1
date: 2026-09-28
by: user
group: prompt-cache
status: in-force
overrides: [D-R2]
implementation: pending
route: RC-41
---
# Workspace awareness: the snapshot plus a live delta

U1(b): the workspace snapshot stays at the first input item and a live delta
is carried in the volatile tail, with an append-rebase, so live workspace
awareness is kept without breaking the cache.
