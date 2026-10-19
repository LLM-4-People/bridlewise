---
id: UD-S9b
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: partial
route: SCALE-IE
acted_in: [engine/src/process/fault-policy.ts]
---
# Durability defaults per class; tools fail closed; fail-stop and restart

The defaults that answer [UD-S9](UD-S9-it-cannot-crash.md): `power`
durability (fsync before the effect) for provider calls, external pushes
and approval or credential audits; the write-ahead log for every other
consequential effect; streaming detail batched with counted gap rows. A
tool whose intent cannot be recorded refuses to run (runs queue). An
uncaught exception is a fail-stop followed by a supervised restart (the
fail-stop landed with SCALE-CR1; the supervised restart is open).
