---
id: UD-S5
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-2b
---
# Ledger volume falls losslessly, not by compression alone

Compression alone is not acceptable ("way too heavy"). The ledger's volume
falls through LOSSLESS reduction (content-addressed payload deduplication,
prefix and delta encoding, dropping derived duplicates, measured against
REAL ledger traffic, not only the synthetic pace) without compromising any
stored information. The tiers that answer it are
[UD-S5b](UD-S5b-hot-lean-archive-sealed-tiers.md). Refines
[UR-03](UR-03-caching-never-sacrifices-a-harness-function.md) and
[UD-S3](UD-S3-archive-never-delete.md).
