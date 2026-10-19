---
id: UD-P
date: 2026-09-28
by: user
group: configuration
status: in-force
covers: [UD-P1, UD-P2, UD-P3, UD-P4, UD-P5, UD-P6, UD-P7]
implementation: pending
route: PRM-0
---
# The prompt registry's design choices

Accepted as recommended: P1 `.prompt` data files and a generated typed
catalog; P2 immutable `prompt_version` rows and selection through a scoped
setting; P3 edits apply on the next run (a per-chat freeze is a setting); P4
system sections are user-editable, tools, notices and judges admin-only,
contracts not editable; P5 experiments per conversation; P6 sub-agent context
inheritance starts as an experiment; P7 the Responses `prompt` object is never
sent.
