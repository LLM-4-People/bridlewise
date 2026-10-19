---
id: UD-S9
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: partial
route: SCALE-IE
acted_in: [engine/src/process/fault-policy.ts, engine/src/mcp/core.ts, tests/prevention/guarded-callbacks.test.ts]
---
# It cannot crash: fix the actual causes; durability before effect

"Ensure it cannot crash at all; fix the actual issue": the crash causes are
eliminated at their roots (no uncaught exception, bounded memory, supervised
workers), and consequential events are durable BEFORE their effects
(intent before effect); only streaming detail is batched. Power loss and
SIGKILL cannot be prevented by code, and the records say so. The defaults
are [UD-S9b](UD-S9b-durability-defaults-per-class.md). Refines
[UR-01](UR-01-dry-kiss-yagni-one-owner.md) (no band-aids) and
[UR-08](UR-08-central-logging-at-the-lowest-choke-point.md). SCALE-CR1
implemented fixes for the measured crash causes; the final fixer snapshot
still owes independent review (TASKS: RECOVERY-POSTFIX-REVIEW). Intent before
effect is SCALE-IE's; no claim of complete crash prevention is made.
