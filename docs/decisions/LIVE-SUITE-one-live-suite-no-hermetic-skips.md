---
id: LIVE-SUITE
date: 2026-10-07
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/live/mcp-servers.test.ts, engine/live/provider-smoke.test.ts, engine/package.json, engine/scripts/verification/hermetic-skips.ts, engine/test/prevention/hermetic-suites-have-no-skips.test.ts, engine/test/support/host-requirement.ts]
---
# One live suite; the hermetic suites have no skips

The coordinator's LIVE-INTEROP decision (2026-10-07), carrying out
[UR-20](UR-20-tests-are-always-broad.md) and [UR-24](UR-24-zero-new-failures-every-failure-owned.md):

- Everything that depends on the world outside the checkout — the hosted MCP
  endpoints and third-party servers started from the local npm/uv cache —
  runs in ONE named live suite, the engine's `test:live` script (engine/package.json,
  engine/live/). It refuses
  at load without the root policy's one declared consent
  (`verification.networkUnderTest.liveConsentVariable`), and a server it
  cannot start fails by name: never a skip, never a quiet green.
- The hermetic suites (the engine runner's canonical set, the web vitest
  include and the Playwright specs) contain no skip, conditional or not: a
  capability a hermetic test needs is asserted, and a fact about the host (a
  mount point, another filesystem) is read from the host, never assumed. The
  ONE finder is engine/scripts/verification/hermetic-skips.ts and the
  whole-tree guard engine/test/prevention/hermetic-suites-have-no-skips.test.ts.
  The finder sees a skip by its SHAPE in the syntax tree, never by its words
  (LAND-OC-FIX round 12, E19): a skip call, option or chosen skip on a
  declarer or a test context, a skipping helper handed the context, a test
  registered only under a host condition, and the silent shape that caused
  this decision — a return inside a test body (at any depth outside nested
  functions) guarded by a condition that asks the host: `process` facts, a
  file's presence, an `os` probe, the path separator, a host-capability name
  (`host…`, `has…`, `can…`, `supports…`, `…Available`, WSL), or a value the
  test did not compute itself. A host requirement — Linux, Landlock, the built
  guardian, a non-root user, a WSL drive — is asserted by name
  (engine/test/support/host-requirement.ts). The guard admits NO site: every
  one it found was fixed at its cause in round 12 (and the real site the round-13
  re-verification named, subprocess-confinement-owner's host-branched
  assertions), so there is no owned set. **Known limits, stated (round 13):**
  the finder does NOT yet see the shape that caused this decision when its
  value comes from an imported probe (`const ok = await probe(); if (!ok)
  return;`), a `try {…} catch { return; }`, a test registered by a logical
  `linux && test(…)` or a chosen `(cond ? test : () => {})(…)`, a `switch`
  that returns, a guarded body with no return, a helper CALLED (not handed)
  that returns early, a `beforeEach` that returns early, and `.mjs`/`.js`
  tests; owned by the TASKS row HERMETIC-FINDER-SHAPES.
- Each live file's test-surface disposition is `qualified-external-oracle`; the
  conservation pin they moved is restated by hand (live/mcp-servers.test.ts, then
  live/provider-smoke.test.ts in round 12). The pins are not part of the
  policy the disposition manifest is pinned to (LAND-OC-FIX round 5, design
  M4): a restated pin is checked by the conservation identity against the git
  index, and no token door re-signs a stale policy.
