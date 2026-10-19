---
id: UD-S5b
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-2b
---
# Hot lean rows, sealed compressed archive, queue on low disk

The storage tiers that answer [UD-S5](UD-S5-lossless-volume-reduction.md):
the HOT store is the lean layout (lean-v1), keeping every chain hash; the
ARCHIVE is compressed, sealed columnar segments with a chain checkpoint
every 64 rows, released only after an unseal proof; when disk runs low, new
runs QUEUE and nothing is deleted ([UD-S3](UD-S3-archive-never-delete.md)).
The archive tier itself is SCALE-9's.
