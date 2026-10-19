---
id: INTEL-DIR
date: 2026-10-02
by: user
group: labs
status: in-force
implementation: pending
route: INTEL-TRANSFER
---
# Integrate the proven intelligence-codegraph improvements

The user explicitly authorized taking improvements from
`~/bridlewise-workspaces/bridlewise-intel-lab` into the harness. This is a
separate integration task after identifying the improved behavior, its
current evidence, the existing harness owner and the replacement/deletion
map. Preserve the lab's experiment records. Use one owner rather than copied
parallel implementations ([UR-01](UR-01-dry-kiss-yagni-one-owner.md)), an
isolated harness workspace and independent verification
([UR-09](UR-09-independent-verification-before-commit.md)).

The accepted clarification in original conversation
`91a381cc-ca1b-4311-8903-a63a60c9edbd`, line 6691, UUID
`f1dcdd9b-c2f1-4e76-b4f9-d9a185ceb84b` (2026-10-02T05:14:57.796Z),
authorizes the Rust code-intelligence extractor. Rewriting other native
components requires proof of substantial benefit; absent that proof, do
only the extractor. No repeat scope question is pending. Integration still
requires current evidence and independent review; this decision claims no
completed migration. The source-bound transfer specification is
`~/.local/state/bridlewise-claude-resume-91a381cc/intel-transfer-spec.md`.
