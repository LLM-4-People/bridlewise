---
id: U-M4
date: 2026-10-01
by: user
group: memory
status: in-force
implementation: pending
route: MEM-LAB-M4
---
# Memory placement is chosen from measured precision, within $20 of Coral

Where memory is injected (the system prompt or the volatile tail channel)
is decided AFTER the lab's grounded-answer round measures precision and the
provider's cached tokens for both placements; the pros and cons come back
to the user with the numbers
([UR-03](UR-03-caching-never-sacrifices-a-harness-function.md)). That round
may spend up to $20 of Coral (a hard cap: stop and report at the cap); the
key reaches the process from the environment only
([D-09](D-09-credentials-never-in-repository-records.md)).
