---
id: INSTRUMENT-LOCK
date: 2026-10-08
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/src/process/instrument-lock.ts, engine/src/filesystem/file-lock.ts, engine/src/workflow/slot-cli.ts, engine/scripts/tooling/test-run-lock.ts, tests/setup/concurrency-lock.ts, engine/src/kernel/config-contracts.ts]
---
# The host has one instrument lock

The coordinator's HEAVY-SLOT decision (PLAN.md, 2026-10-04; superseding the
HEAVY-SLOT-ADHOC row), carried out as ONE waiting lock in LAND-OC-FIX rounds
5 to 12. It closes L-2026-10-04 (two heavy runs sharing the cores measured
nothing about either tree).

- **One lock, one primitive.** A heavy run — a full or multi-file suite, a
  coverage run, a perf profile, a load run, a workspace validate or merge —
  holds the host user's ONE instrument lock
  (`testExecution.instrumentLock.cacheRelativeLockPath` under `.cache` of the
  password database's home: `$HOME` and `$XDG_CACHE_HOME` never move it; never
  in a checkout, never in the keep-out floor). It is built on the one lock
  primitive (engine/src/filesystem/file-lock.ts): a record naming the holder
  by pid AND start time, read without following a link, without blocking and
  bounded; a holder counts only while it, or a process it adopted, is live by
  that identity AS THIS USER (pid 1, or another user's process, holds
  nothing).
- **One definition of heavy, from config (round 13).** A run of
  `testExecution.instrumentLock.minimumTestFiles` test files or more is heavy;
  fewer is a light, targeted run that takes nothing. A WHOLE INSTRUMENT is
  heavy by kind, as config declares it (`wholeInstruments`: every Playwright
  run, whatever config, project or filter it names; the coverage run; the
  perf profile; a slot run; a flake reproduction): its door passes
  `wholeInstrumentTestFileCount`, and a kind config does not name is refused.
  The vitest door counts the files vitest itself selects (its own CLI parser
  and specification search), a `vitest list` included: no verb is exempt
  (a setup step that lists the suite, `web-module-cache`, is declared
  `holdsInstrumentLock`: the checkout runner takes the lock before it starts,
  its wait counting toward no timeout, once per tree, and a read-only create
  skips it, so a create waits behind a validate and never fails for it). The
  engine runner and the web runner count their own arguments
  (`namedTestFileCount`); a web run that miscounts itself light is still
  caught by the vitest door, which re-runs it inside the supervising door.
  Known limit: the guard that every door reaches the lock is a hand list of
  source patterns over named files (engine/test/prevention/test-run-lock.test.ts),
  not a search for every spawn of a runner (L-3, owned by the TASKS row
  LOCK-DOOR-CENSUS).
- **A second heavy run WAITS**, saying who holds the lock. The wait is
  asynchronous and honours SIGTERM, SIGINT and SIGHUP: a signal ends it with a
  typed exit (128 + the signal's number), and nothing is taken.
- **One supervising door holds it for others.** `runInsideInstrumentLock`
  (`harness slot run`, the coverage run, the perf profile, `test:e2e`,
  `test:all`) takes the lock, runs the command under the test-process
  supervisor and ADOPTS it, so the hold lives until the command's process tree
  is gone, even when the door itself is killed. An in-process holder (the
  vitest and Playwright global setups, the coverage run's and the perf
  profile's inner process) only BORROWS a hold it runs inside, through the one
  door, which refuses it outside a live hold. ONE marker says "inside the
  door" (`HARNESS_INSIDE_INSTRUMENT_LOCK`, set by the supervising door): it
  chooses the inner path, it never grants the lock. Outside a hold, the vitest
  door RE-RUNS its own command inside the supervising door (as the coverage
  run and the perf profile do) and leaves with its code; the Playwright door is
  refused (`instrument_lock_unsupervised`) and names `npm run test:e2e`.
- **A measurement is stamped.** A run inside a live hold, by the owner's
  acquisition token, is stamped `held`; anything else is `unslotted`, and an
  unslotted measurement is refused, never judged
  ([UR-24-BUDGETS](UR-24-BUDGETS-a-budget-breach-joins-the-one-judgement.md),
  [D-17](D-17-measured-budgets-come-from-a-tool.md)). The stamp's limit: a
  same-user process that can read the record can copy its token.
- **Fairness is open.** A waiter polls, so a holder whose next run starts at
  once can win every hand-over (INSTRUMENT-LOCK-FAIRNESS): its ordering lives
  inside the one primitive, never a second mechanism beside it.
