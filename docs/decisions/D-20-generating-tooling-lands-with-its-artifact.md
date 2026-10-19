---
id: D-20
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: standing
---
# Tooling that produces a committed artifact lands with it

A committed artifact (a report, a pin, an inventory, a baseline) lands in
the same task as the repository-native tool that regenerates it, so it can be
regenerated and its drift detected; a hand-made artifact with no generator is
a tooling gap (see [UR-02](UR-02-generated-values-come-from-generators.md)).
