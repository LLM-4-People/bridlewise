---
id: UR-19
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# Every rule is retroactive

Every rule, standing or newly added, applies to ALL existing code, records
and data, not only to new changes (user, 2026-10-07).

- A new rule triggers an audit of the whole tree; every existing violation
  becomes a fix task with an owner, scheduled, never grandfathered.
- Guards check the whole tree, not just the diff.
- A baseline of existing violations is a burn-down list that can only
  shrink, with an owner task per entry — never a permanent exemption.
- A writer touching code that violates any rule fixes it in the same change.
