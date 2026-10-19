---
id: LAB-UD
date: 2026-09-29
by: user
group: labs
status: in-force
covers: [LAB-D1, LAB-D2, LAB-D3, LAB-D4, LAB-D5]
implementation: pending
route: LAB-6
---
# The docs-writer lab's decisions

D1/D2: the docs compiler, its freshness and citation gate and its coverage
ledger graduate into the harness (`engine/scripts/verification/`) through a
separate harness task; meanwhile the lab consumes harness owners from a pinned,
hash-verified read-only export (no private duplicates, no symlinks). D3/D4: the
lab is a git repository and its baseline is configuration, re-baselined on a
clean `testing`. D5: its hand-authored pages become generated projections plus
pinned review notes. Lab work follows [UR-10](UR-10-one-writer-per-repository.md).

The graduation destination above records the September 29 choice.
[BL-U2](BL-U2-the-docs-graduate-as-their-own-package.md) overrides D2: the
docs graduate as their own package in the harness repository. The other
choices remain in force; this record does not claim graduation is complete.
