---
id: UR-23
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
overrides: [UR-10]
---
# A web writer may work beside the engine writer

The web module (the server, the interface and the web tests) is worked on AT
THE SAME TIME as the engine work, and its inefficiency is fixed — the module
itself and its tests (user, 2026-10-07). This refines
[UR-10](UR-10-one-writer-per-repository.md):

- A second concurrent writer is allowed when it works in its own isolated
  workspace whose write-set is DISJOINT from the engine writer's (the web
  writer: `server/`, `src/`, the web parts of `shared/`, the web tests and the
  web package files).
- Shared files (the root package files, generated manifests, the docs and
  trackers) are touched by one writer at a time.
- Landings stay serialized through `ws merge` (one integrator at a time).
- The two writers' qualification runs never overlap on CPU-heavy suites: the
  measured web budget is load-sensitive.
