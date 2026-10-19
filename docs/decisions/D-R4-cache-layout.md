---
id: D-R4
date: 2026-09-28
by: coordinator
group: prompt-cache
status: in-force
implementation: pending
route: RC-39
---
# The prompt-cache layout

Measured on Coral: the provider orders instructions, then tools, then input
items; any change to instructions or tools is a full miss, and so is an
insertion before a long history; `prompt_cache_key` partitions strictly, so one
is always sent. The layout: `instructions` holds only the static host system
prompt; tools are sorted, a stable superset (under [U2](U2-switched-off-tools.md));
the first input item is the frozen workspace snapshot; then the trim summary
(one accepted miss when it changes); then the append-only history; the last
item is the single volatile tail. Coral's cache semantics are recorded in its
provider profile; the core layout stays provider-agnostic. Reuse on glm-5.3 is
marked unverified.
