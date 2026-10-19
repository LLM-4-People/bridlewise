---
id: U-M-GLOBAL
date: 2026-10-01
by: user
group: memory
status: in-force
implementation: pending
route: MEM-LAB-M5
---
# A global memory layer of harness knowledge, admitted by checks and two-person admin approval

The open question of 2026-10-01 ("a global, PII-free tier — or maybe not")
was DECIDED by the user on 2026-10-07: there is a GLOBAL MEMORY LAYER shared
across all users.

- **Content:** harness, tool and documentation instructions (the docs lab's
  output, tool usage guides, harness behaviour) — never user or project data.
  Encrypted like everything else, under a system-scope key of the one key
  hierarchy; beside [U-M1](U-M1-memory-on-the-project-and-user-shards.md)'s
  project and user tiers.
- **Admission:** every addition, change and removal passes rigorous
  automated checks — secret and personal-data detection, provenance and
  source binding, poisoning and prompt-injection screening, dedup against the
  existing entries, size and format — and then MANUAL ADMIN APPROVAL, even
  when an admin proposes it. There is no auto-approval path; approval is built
  on the one generic approval primitive and every decision is audited in the
  ledger.
- **Two persons:** the requesting admin COUNTS as one of the two, so one more
  admin approves; an install with exactly one admin self-approves.
- **Shared checks:** the checks are the shared content checks at the lowest
  choke points, applying everywhere, not only to memory; detected secrets and
  personal data are redacted, never a reason to block
  ([UR-21](UR-21-redact-never-block.md)). Every check, threshold, policy and
  approval rule is a scoped setting in the one settings registry, exposed as
  settings, signals and actions ([UR-05](UR-05-expose-settings-signals-actions.md)).
