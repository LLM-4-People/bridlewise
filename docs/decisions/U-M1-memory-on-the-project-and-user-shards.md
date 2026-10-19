---
id: U-M1
date: 2026-10-01
by: user
group: memory
status: in-force
implementation: pending
route: MEM-3a
---
# Project memory lives in its project shard, user memory in a per-user shard

On the lean ledger, a project's memory lives in that project's shard (its
catalog a writer projection there) and user-level memory in a per-user
scope shard; there is no separate memory shard, and legacy memory is read
once into the shards, after which the legacy file has no memory writer.
One substrate for both ([UR-01](UR-01-dry-kiss-yagni-one-owner.md),
[UR-04](UR-04-shared-and-reusable-backend-and-frontend.md)); refines
[MEM-DIR](MEM-DIR-continue-the-memory-layers-lab.md) and
[UD-S2](UD-S2-a-ledger-shard-per-project.md).
