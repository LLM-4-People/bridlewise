---
id: UR-09
date: 2026-09-27
by: user
group: user-rules
status: in-force
implementation: standing
---
# Independent verification before every commit and push

Every finding, fix and implementation is triple-checked: a writer's change is
verified by separate readers (a correctness and a design verifier, security
where it applies) before it is committed and pushed. A round runs as writer,
then its verifiers, then a fixer for their findings, then a committer.

The committer commits and pushes to `origin/testing` (normal hooks, logical
commits, fast-forward, never force) once the round's qualification shows ZERO
new failures against the previous qualified run, and every remaining failure
is owned by a named later task recorded in the tracker (confirmed by the user
on 2026-09-29). A round that ends uncommitted or unpushed is not finished.
