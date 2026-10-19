---
id: REQUIRES
date: 2026-10-08
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/src/workflow/checkout-setup.ts, engine/src/kernel/config-contracts.ts, engine/bridlewise.config.json]
---
# A gate runs after the steps that produce what it judges

The coordinator's decision of LAND-OC-FIX round 9 (the web suite's
regression gate judged a profile report no step of the run had produced).

- **`requires` names a gate's producers.** A VALIDATE or MERGE command of
  `workspaceIsolation.commands` may declare `requires`: the commands that
  produce what it judges (the perf profile step makes the report the web
  suite's regression gate reads).
- **One sequencer runs them.** `runDeclaredCommands`
  (engine/src/workflow/checkout-setup.ts) runs each producer before the first
  gate that requires it, once per sequence however many gates require it; a
  gate whose producer failed is not run, and the phase fails: a gate never
  judges an artifact no step of its sequence produced. The workspace phases,
  promotion and the landing all run through it, and `commandsRun` is what a
  ceiling, a plan digest or a toolchain census of a sequence counts.
- **The schema refuses what would make it ambiguous.** A producer is
  declared, is not the gate itself, requires nothing itself (one level), is
  never a judged (`ledger`) gate, and is named by no phase — a phase naming it
  would run it a second time, and a setup command is the checkout's, never a
  gate's input (round 12, correctness B-L11). A command with `requires` runs
  only in the validate and merge phases.
