---
id: UR-22
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# The coordinator's record lives on the coordination branch

The coordinator's scratchpad — the plan, the briefs, the specs, the reports
and every round's notes — is SAVED IN THIS REPOSITORY on the branch
`coordination` (a worktree of its own, beside the repository), committed and
pushed after every change, and never merged into `testing` or `master`
(user, 2026-10-07). Nothing durable lives only in temporary storage (a
reboot wiped `/tmp` and the scratchpad with it), and nothing is ever created
under `~/.local/state/bridlewise-*`, the keep-out floor's wildcard (a link
placed there on 2026-10-07 disabled every confined command).

- The coordination branch is the ONE current coordination owner: the
  recovery cutover block in `docs/trackers/TASKS.md` is history, superseded
  by it ([REC-DIR](REC-DIR-useful-recovery-records-live-in-the-repository.md)).
- A record another branch of this repository already holds is cited there,
  never copied into `testing` ([UR-16](UR-16-one-thing-for-everything.md)).
