---
id: UD-S2
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-3b
---
# A ledger shard per project, each with its own writer

No global single writer: the ledger is SHARDED per project (or a
configurable shard group), each shard with its own database and its own
off-main-thread writer, so projects write in parallel and capacity grows
with them. The grouping default is [UD-S6](UD-S6-one-shard-per-project.md).
Refines [UR-01](UR-01-dry-kiss-yagni-one-owner.md): one writer per shard is
the single owner of that shard's chain.
