---
id: REC-DIR
date: 2026-10-04
by: user
group: user-rules
status: in-force
implementation: done
acted_in: [docs/design/recovery-durable-records-plan.md, docs/findings/recovery-record-retention.md, docs/findings/recovery/evidence-manifest.json, docs/trackers/TASKS.md]
---
# Useful work lives in the repository

"remember to keep things in this repo, anything that is useful shouldn't sit
in your temp" (user, 2026-10-04). Useful plans, findings, verification
reports, evidence and continuation notes are versioned repository records in
their existing owners — `docs/design/`, `docs/findings/`, `docs/trackers/`,
`docs/decisions/` — never private coordinator state. Private scratch is
staging only: it is never the sole home of a useful record, and a record
that exists only outside the repository does not exist. A user instruction
given in conversation is such a record: it lands in this directory as a
decision, or as a bounded edit to the decision that already states it —
never only in a brief, a tracker line or a chat log — and other documents
cite its id instead of restating it.

The interrupted recovery executed this rule through
RECOVERY-DURABLE-RECORDS: the sealed retention plan and its bound selection
are imported byte-exact as routing inputs, and its small records (plans,
specs, reviews) are versioned under `docs/findings/recovery/` and
`docs/design/recovery/`. As AMENDED on 2026-10-07:

- **Raw evidence is kept by content outside git**
  ([EVD-STORE](EVD-STORE-raw-evidence-in-a-content-addressed-store.md)): the
  recovery's raw evidence folder `docs/findings/recovery/evidence/` is held in
  the evidence store, and the repository commits its generated manifest, so
  every cited path stays verifiable byte for byte. "Exact bytes" is the
  manifest's sha256, not a committed copy.
- **A record another branch of this repository holds is referenced, not
  copied** ([UR-16](UR-16-one-thing-for-everything.md)).
- **The coordination owner is the `coordination` branch**
  ([UR-22](UR-22-the-coordination-branch.md)). The 2026-10-04 cutover moved
  the consolidated coordinator state into `docs/trackers/TASKS.md` (after an
  independent CLEAR-TO-ACTIVATE check); that block is now history, superseded
  by the coordination branch, and both immutable coordinator records are in
  the evidence store under `docs/findings/recovery/evidence/coordinator/`.

Bounds this rule carries from its neighbors: credentials never become
records ([D-09](D-09-credentials-never-in-repository-records.md)); disposable
runtime temp roots stay outside the safety floor
([D-19](D-19-temp-root-outside-the-safety-floor.md)); one owner per semantic
fact, with this directory the one home of rules and decisions
([UR-01](UR-01-dry-kiss-yagni-one-owner.md)); retained tooling lands with
its committed artifact
([D-20](D-20-generating-tooling-lands-with-its-artifact.md)). Importing a
record grants no workload, spend or admission; historical evidence is never
a supported runtime owner.
