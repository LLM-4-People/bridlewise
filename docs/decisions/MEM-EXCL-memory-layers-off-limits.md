---
id: MEM-EXCL
date: 2026-10-01
by: user
group: memory
status: superseded
superseded_by: MEM-DIR
implementation: standing
---
# The memory layers are off-limits (lifted)

The memory layers (injection, retrieval and storage of memory) belonged to
the separate memory-layers-v1 experiment: harness writers changed no memory
code, the scale design left memory storage as it was, and every needed
memory change became a finding for the experiment. Lifted the same day by
[MEM-DIR](MEM-DIR-continue-the-memory-layers-lab.md), which keeps its one
lasting rule: no harness memory change before a proven design transfers.
