---
id: MEM-DIR
date: 2026-10-01
by: user
group: memory
status: in-force
implementation: pending
route: MEM
---
# Continue the memory-layers lab, then build its proven designs on the lean ledger

The memory exclusion is lifted. We continue Codex's unfinished memory-layers
experiment (`~/bridlewise-workspaces/memory-layers-v1`) with agents, under
that lab's own `AGENTS.md` rules (we are its coordinator; only lab-assigned
agents write there, [UR-10](UR-10-one-writer-per-repository.md)), and THEN
implement its proven designs in the harness ON TOP OF the new lean ledger
(lean-v1, the per-project shards, the archive tier). Only findings and
proven designs transfer, never lab code; harness writers do not edit memory
code, schema, storage, recall or injection until a design is admitted and
scheduled (the MEM tasks), and a defect found meanwhile is recorded with its
MEM owner ([U-M6](U-M6-no-interim-patches-to-the-old-memory-path.md)). The
transfer replaces, never wraps
([UR-01](UR-01-dry-kiss-yagni-one-owner.md)); memory recall stays a function
the prompt cache never sacrifices
([UR-03](UR-03-caching-never-sacrifices-a-harness-function.md)). The user
tier of [U6](U6-memory-tiers.md) moves to MEM-8; its placement is
[U-M1](U-M1-memory-on-the-project-and-user-shards.md).
