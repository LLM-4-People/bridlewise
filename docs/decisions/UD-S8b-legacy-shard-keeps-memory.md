---
id: UD-S8b
date: 2026-10-01
by: user
group: scale
status: superseded
superseded_by: MEM-DIR
implementation: pending
route: SCALE-3b
---
# The legacy shard keeps memory storage as it is (replaced)

Proposed: the existing ledger becomes a `legacy` shard holding memory
unchanged, while a new lean `system` shard takes host events, because memory
storage was out of scope. NOT adopted as a lasting shape: the user lifted
the memory exclusion and replaced it with
[MEM-DIR](MEM-DIR-continue-the-memory-layers-lab.md) — memory moves onto the
lean shards ([U-M1](U-M1-memory-on-the-project-and-user-shards.md)). Until
that transfer (MEM-3b), the legacy file keeps memory's own appends.
