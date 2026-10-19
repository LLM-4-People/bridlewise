---
id: Q11
date: 2026-09-29
by: user
group: responses
status: in-force
overrides: [U9]
implementation: pending
route: RC-12
---
# 45% of the model window everywhere

The context budget is 45% of the model window everywhere, with no special
Coral cap; the key is `memory.contextBudget` (`{ratio: 0.45}` or `{tokens}`); an
unknown window with a ratio is a typed refusal. `memory.contextTokenLimit` is
retired, not value-mapped: a customized value gets a one-time notice and a log.
