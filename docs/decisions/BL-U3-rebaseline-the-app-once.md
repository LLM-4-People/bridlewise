---
id: BL-U3
date: 2026-10-01
by: user
group: labs
status: in-force
implementation: pending
route: BL-R2
---
# The lab app is re-baselined onto testing once, after its stage is sealed

After the fifty-stream stage is sealed
([BL-U4](BL-U4-seal-fifty-streams-plus-one-two-hundred-run.md)), the lab's
app is re-baselined onto the current `testing` ONCE, with real three-way
merges and its generated files rebuilt by `harness sync`
([UR-02](UR-02-generated-values-come-from-generators.md)); the package
split is done in the same window.
