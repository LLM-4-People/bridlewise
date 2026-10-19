---
id: PROMO-UD
date: 2026-09-29
by: user
group: promotion
status: in-force
covers: [PROMO-UD-1, PROMO-UD-2, PROMO-UD-3, PROMO-UD-4, PROMO-UD-5, PROMO-UD-6, PROMO-UD-7, PROMO-UD-8]
implementation: pending
route: PROMO-0
---
# The promotion design's choices

All recommendations accepted: 1 auto-promote after every `testing` push,
enabled right after the first reviewed promotion; 2 auto-push `master` in one
atomic push; 3 one promotion commit per run, with `testing` as the second
parent and provenance trailers; 4 the first promotion takes `testing`'s
`README.md` and both `.gitignore` files (an exact list reviewed once); 5 ship
`scripts/db-key.ts`, not the root `AGENTS.md`; 6 retire
`ALL-MERGE-MANIFESTS.json` (promotion receipts replace it); 7 auto-promotion
stays paused after a rollback until released; 8 no recorded-suite requirement
yet. (Cited as UD-1..UD-8 in the promotion design.)
