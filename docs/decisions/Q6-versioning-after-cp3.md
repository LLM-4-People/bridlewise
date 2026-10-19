---
id: Q6
date: 2026-09-29
by: user
group: responses
status: in-force
implementation: pending
route: MV
---
# Module versioning follows the third checkpoint

Per-module versioning moves to right after the third test-drive checkpoint
(CP3) in the Responses queue.

The retained goal is a declared version for every module change, a structured
changelog with generated mechanical facts, and enforced final-tree currency
on every admission route, including cherry-pick/revert/rebase. The recovered
`specs/module-versioning.md` is pending design at QUEUE-5 Q5-087, not an
implemented mechanism. Its draft docs/tests/pin-only exclusions are not
accepted user exceptions; reconcile them with the every-change requirement.
Resolve its advisory-only content-drift checks before claiming mechanical
admission enforcement. Version history is never silently repaired by sync.
