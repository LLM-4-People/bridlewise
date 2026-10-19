---
id: U-M5
date: 2026-10-01
by: user
group: memory
status: in-force
implementation: pending
route: MEM-5a
---
# The memory index is int8 vectors with certified exact rescoring, plus a keyed lexical index

As AMENDED by the user on 2026-10-07 (the first version allowed "int8 or
1-bit" vectors, which is not lossless):

- The index is int8 per-chunk vectors with CERTIFIED EXACT RESCORING — the
  top-k it returns is identical to full precision's — plus a scoped KEYED
  lexical index; no plaintext full-text index of protected content.
- The scoring kernel is pinned: fixed-order float64 accumulation, ties broken
  by id, so a score is reproducible everywhere.
- Every entry carries a compact id derived from (scope, sequence). There is
  NO backward compatibility: existing memory entries are rebuilt from the
  ledger in the new format, and no dual-format reader exists
  ([UR-17](UR-17-no-fallbacks.md)).

If the lab measures any precision loss, the trade-off returns to the user
([UR-03](UR-03-caching-never-sacrifices-a-harness-function.md)).
