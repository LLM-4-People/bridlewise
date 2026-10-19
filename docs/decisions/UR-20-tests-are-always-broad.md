---
id: UR-20
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# Tests are always broad

Every test and guard covers its WHOLE concern across the whole tree — every
tracked source file, every package, every language and every entry point —
never a hand-picked slice of folders or file types (user, 2026-10-07). A
narrow scope is a defect to fix, not a design choice. Each guard proves its
breadth with planted violations in more than one place, plus near-misses
that must not be flagged ([UR-18](UR-18-every-issue-class-gets-a-mechanical-guard.md)).
