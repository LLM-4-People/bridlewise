---
id: UD-ONE-PARSER
date: 2026-10-07
by: user
group: labs
status: in-force
implementation: pending
route: INTEL-L0
---
# One parsing owner for every consumer

The user's decision of 2026-10-07 (PLAN.md): "implement a single thing that
everything else would use … properly fix things from the get go".

- **One owner.** The native engine is the one parsing and extraction owner for
  EVERY consumer: code intelligence and the awareness, editor, quality and
  safety parsers.
- **No dual path.** The old parsers and their dependencies are deleted.
  Browser-side exceptions share one grammar and query source.
- **The native helpers stay C.** The coordinator's evaluation
  (reports/rust-native-eval.md) found that 0 of ~30 historical defects were
  memory-safety defects, that Rust brought no latency gain, and that its binary
  was 13 to 17 times larger.
