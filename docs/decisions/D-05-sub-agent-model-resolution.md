---
id: D-05
date: 2026-09-27
by: coordinator
group: engine
status: in-force
implementation: pending
route: RC-28
---
# A sub-agent resolves its own model or refuses

A delegated sub-agent resolves its own model and credential. When that is not
possible the delegation refuses with a typed error; the parent's model is
never substituted silently.
