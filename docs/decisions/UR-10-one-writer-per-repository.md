---
id: UR-10
date: 2026-09-29
by: user
group: user-rules
status: in-force
implementation: standing
---
# One writer per repository

At most one agent edits a repository at a time: anything that may create,
edit or delete a tracked or live file waits for the current writer. Writers of
different repositories (the harness and the docs lab) may run in parallel.
Disjoint writers inside one repository may also run in parallel (user
clarification, 2026-10-04): agents whose write-sets do not overlap —
separate experiment writers — while shared-harness integration stays
serialized. [UR-23](UR-23-a-concurrent-web-writer.md) (2026-10-07)
refines this rule: a web writer may run beside the engine writer in a
disjoint write-set.
Readers (verifiers, spec readers, reviewers) run alongside the writer, bounded
by what the shared machine can carry (see [ROLES.md](../process/ROLES.md)).
