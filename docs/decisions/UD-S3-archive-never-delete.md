---
id: UD-S3
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-9
---
# Logs are never lost: segment and archive, never delete

Retention means archive, never deletion: the ledger is segmented and its
sealed segments are archived; nothing recorded is dropped to save space.
The storage tiers are [UD-S5b](UD-S5b-hot-lean-archive-sealed-tiers.md).
Refines [UR-08](UR-08-central-logging-at-the-lowest-choke-point.md): what is
logged stays retrievable.
