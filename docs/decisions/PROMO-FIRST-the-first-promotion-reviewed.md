---
id: PROMO-FIRST
date: 2026-10-01
by: user
group: promotion
status: in-force
implementation: done
acted_in: [promotion/testing-to-master.json]
---
# The first promotion: reviewed by the user, then applied

The first promotion of `testing` into `master` went through the promotion
door ([UR-12](UR-12-master-changes-only-through-the-promotion-door.md))
after the user reviewed its exact change: the 8 target edits (`master`'s own
changes that `testing` overwrites) and the 9 deletions, against
[PROMO-UD](PROMO-UD-promotion-choices.md)'s one-time file list (its UD-4).
It was applied on 2026-10-01 (one promotion commit, published with its
receipt, the product checkout fast-forwarded and `harness check` green).
