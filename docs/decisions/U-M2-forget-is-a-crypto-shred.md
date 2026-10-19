---
id: U-M2
date: 2026-10-01
by: user
group: memory
status: in-force
implementation: pending
route: MEM-6
---
# Forgetting destroys a key: memory references the ledger, under per-conversation keys

"Forget this memory" under [UD-S3](UD-S3-archive-never-delete.md) (never
delete) is a crypto-shred. As AMENDED by the user on 2026-10-07 (memory
size decisions):

- Memory REFERENCES ledger content; it never holds a second copy of it
  ([UR-16](UR-16-one-thing-for-everything.md)).
- The ledger's conversation content is encrypted under per-(owner, project)
  keys, with a PER-CONVERSATION key beneath each.
- Forgetting destroys the key: the content is unreadable in the ledger, in
  memory and in every archive alike. A catalog tombstone records it; recall
  excludes the entry; no ledger row is deleted, and the hash chain covers the
  keyed ids, so it still verifies.

The first version (2026-10-01) shredded a per-(owner, project) memory data
key alone; that left the same text readable in the ledger, which holds 97% of
memory's bytes in plaintext (the cross-store study), so it did not forget.
Accepted with [U-M1](U-M1-memory-on-the-project-and-user-shards.md).
