---
id: UD-S7
date: 2026-10-01
by: coordinator
group: scale
status: in-force
implementation: pending
route: SCALE-3b
---
# Every shard is sealed with the web database's key

One key for all shards: the web database's (today's pairing), so there is
one key to back up and re-key. The key's home is
[D-15](D-15-database-key-outside-the-state-root.md)'s.

Provenance: technical default selected by the coordinator, described in the
original conversation at line 5525 (2026-10-01), not an option accepted by
the user in answer 5469. The later storage/durability approval at 5760 does
not retrospectively turn this selection into a direct user answer.
