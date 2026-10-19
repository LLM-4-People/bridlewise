---
id: D-14
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: pending
route: RC-04
---
# Test-drive fixes: detector families and the context budget

B01: the configuration file may disable a harness-notice detector family (the
settings page only refuses); harness notices become persisted, replayed
`developer` messages through one helper. B25: the context budget comes from
configuration and the model window only caps it (the default is set by
[U9](U9-context-budget-is-a-ratio.md)). The B02 choice that trimmed payloads
are not retrievable is overridden by [U3](U3-large-payloads-stay-retrievable.md).
