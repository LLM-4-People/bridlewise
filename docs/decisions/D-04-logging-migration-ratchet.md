---
id: D-04
date: 2026-09-27
by: coordinator
group: engine
status: in-force
implementation: pending
route: RC-06
---
# Logging migrates in place under a ratchet

Raw logging moves to the central debug and audit system in place, one owner at
a time, with a shrinking allowlist: a list of files still to migrate that may
only lose entries, never gain one.
