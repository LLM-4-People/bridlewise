---
id: EVD-STORE
date: 2026-10-07
by: user
group: process
status: in-force
implementation: partial
route: EVIDENCE-DURABILITY
acted_in: [engine/src/workflow/evidence-store.ts, engine/src/filesystem/private-home.ts, engine/src/filesystem/immutable-receipt.ts, docs/findings/recovery/evidence-manifest.json, .gitignore]
---
# Code and small records in git; raw evidence in a content-addressed store

The user's decision of 2026-10-07, landing opencode's DEC-1 resume branch:
land it as CODE plus SMALL RECORDS in git (the code and docs, the specs,
plans and review records), and move the large raw evidence (the 201 MB
`docs/findings/recovery/evidence/` folder) to a content-addressed store
OUTSIDE git, with a committed hash manifest so every citation stays
verifiable.

What that means, for every round from now on:

- **Raw evidence never enters git.** Large, never-edited evidence (run logs,
  receipts, screenshots, transcripts) is ingested with `harness evidence
  ingest --manifest <folder>/evidence-manifest.json <folder>/evidence/<path>…`
  and the files are deleted from the tree. The manifest is generated, never
  typed; every path it records lies in its own `evidence/` folder. Ingest
  STAGES the manifest it wrote (that one path): only a TRACKED manifest
  steers the generated ignore rule, verify and materialize, and an untracked
  file named like one is refused by name (`evidence_manifest_untracked`).
- **A recorded path names one set of bytes forever.** Ingest is idempotent
  and refuses other bytes for a recorded path; a changed file is recorded
  under a new path. Records cite `evidence:<recorded path>`.
- **ONE store, one owner each** ([UR-16](UR-16-one-thing-for-everything.md)):
  the store is a per-user private home of the one private-home owner
  (`engine/src/filesystem/private-home.ts`, which also admits the key home),
  located by the boot setting `HARNESS_EVIDENCE_HOME` or
  `~/.local/share/bridlewise/evidence` — never under the keep-out floor's
  `~/.local/state/bridlewise-*` wildcard — and kept out of every confined
  process wherever it is. Its objects are the immutable owner's
  content-addressed files (`engine/src/filesystem/immutable-receipt.ts`):
  written once, 0600 in 0700 folders, read back only when they hash to their
  address; a link anywhere in the store is refused.
- **Contained.** `materialize` writes only inside a tracked manifest's own
  evidence folder, never `.git` or the hooks, through folders reached without
  following a link; git ignores the copies through the `.gitignore` block
  `harness sync` generates from the manifests.
- **Small records stay in git** ([REC-DIR](REC-DIR-useful-recovery-records-live-in-the-repository.md)):
  the code, decisions, specs, plans and review records that live documents
  cite. A copy of a record another branch of this repository already holds
  is a reference to it, not a second copy.

`harness evidence verify` proves every recorded object present, private and
byte-exact. Durability (a second copy of the store) and a check that the
archive tag below is present are open: EVIDENCE-DURABILITY owns both, so this
decision is `partial`. The recovery's
bytes stay in git as objects under the pushed archive tag
`archive/codex-dec1-resume-2b2290fe`, which no sweep removes (UD-S3). The
source branch `agent/codex-dec1-resume/734ead805549` is quarantined, and the
tag, not the branch, is the copy that stays.
