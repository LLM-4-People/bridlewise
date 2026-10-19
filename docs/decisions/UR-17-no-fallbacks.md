---
id: UR-17
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# No fallbacks

"I would like to avoid fallbacks whenever possible" (user, 2026-10-07). No
design has a primary path plus a degraded or alternative path ("if X fails,
use Y"), and nothing ever falls back silently: a missing capability is a
loud, typed failure that names its remedy, not a quieter substitute. Make
the one path work and prove it.

- Forbidden, for example: awareness silently using a regex scanner when the
  syntax-tree package is missing; a red gate re-judged by a different judge;
  a reader that quietly accepts a second format with no end.
- Not a fallback: a test-only independent oracle declared as such; a typed
  refusal; a bounded retry of the SAME operation that then fails loudly.

Applies to all existing code ([UR-19](UR-19-every-rule-is-retroactive.md));
each existing fallback becomes an owned fix task.
