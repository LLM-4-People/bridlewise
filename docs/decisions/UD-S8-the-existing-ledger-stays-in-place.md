---
id: UD-S8
date: 2026-10-01
by: coordinator
group: scale
status: in-force
implementation: pending
route: SCALE-3b
---
# The existing ledger stays in place

The existing `.bridlewise/timeline.db` is kept IN PLACE as a shard: its
ledger id, chain and history are untouched (no re-chaining, so every
evidence hash stays valid), and runs from before the cutover stay readable
through the catalog's cutover mapping. Its proposed amendment
[UD-S8b](UD-S8b-legacy-shard-keeps-memory.md) was replaced by the memory
direction [MEM-DIR](MEM-DIR-continue-the-memory-layers-lab.md).

Provenance: technical default selected by the coordinator, described in the
original conversation at line 5525 (2026-10-01), not an option accepted by
the user in answer 5469. The later storage/durability approval at 5760 does
not retrospectively turn this selection into a direct user answer.
