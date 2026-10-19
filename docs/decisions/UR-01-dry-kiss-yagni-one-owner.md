---
id: UR-01
date: 2026-09-27
by: user
group: user-rules
status: in-force
implementation: standing
---
# Shared owners, one source of truth

DRY, KISS and YAGNI; shared reusable modules, tests and configurables; one
single source of truth; the change at the lowest choke point; modular,
resilient, agnostic and dynamic designs that expose their settings, signals
and actions ([UR-05](UR-05-expose-settings-signals-actions.md)); a full
refactor and clean-up rather than a partial one; broad deterministic tests so
each finding would be caught next time; act on all findings, pre-existing and
unrelated ones included, reproducing them first; docs and trackers kept
current in the same change.
Never: static configurables inside the code, band-aids or workarounds,
over-engineering, duplicated logic or constants, backward-compatible shims
(the old path is deleted instead).
