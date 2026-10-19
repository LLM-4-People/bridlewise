---
id: KILL-OWNED-ONLY
date: 2026-10-08
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/src/process/process-facts.ts, engine/src/process/supervised-run.ts, engine/guardian/test-process-supervisor.c, engine/test/prevention/process-liveness-owner.test.ts]
---
# Signal only what you started

The coordinator's rule after the 2026-10-08 incident (BRIEF.md, "Never signal
a process you didn't start"): an engine writer sent SIGTERM to a process
group it took for its own, and it was the memory lab's qualification run.

- **Agents never kill, signal or pkill by pattern.** They terminate only
  processes they spawned in this run, identified by pid AND start time.
- **One terminator, by full identity.** `terminate`
  (engine/src/process/process-facts.ts) signals only an OWNED identity: a
  child this process spawned, read while it is unreaped (`ownedChild`), a
  spawn record whose identity carries its start time (`readSpawnRecord`), or
  the supervisor's announcement, bound with the command's start time read by
  the supervisor while the child is unreaped (`ownedAnnouncement`). A null
  start time NEVER grants ownership (a bare pid can be recycled; round 12,
  security MF-6). The brand is a WeakSet, so a forged object is refused; the
  identity is re-checked before each signal, and a recycled group leader is
  never signalled.
- **The lock's holders follow the same identity rule**
  ([INSTRUMENT-LOCK](INSTRUMENT-LOCK-the-host-has-one-instrument-lock.md)):
  a holder is live only as this user's process with its recorded start time.
- **The guard.** engine/test/prevention/process-liveness-owner.test.ts holds
  the product and its tooling (engine/src, engine/scripts, server, scripts,
  bench, shared, src) to the one terminator: a pid-addressed signal there,
  the default-signal `process.kill(pid)` included (round 13, K3), is refused
  outside it. It does NOT read the test roots (engine/test, tests: a test may
  crash itself or signal a fixture it spawned; K2), and its other known gaps
  (a `systemctl --user stop` outside the terminator, `process["kill"]`, a
  destructured `kill`, `/bin/kill`, a spawn record's trust resting on the
  privacy of its path) are owned rows (KILL-GUARD-BREADTH,
  SPAWN-RECORD-TRUST).
