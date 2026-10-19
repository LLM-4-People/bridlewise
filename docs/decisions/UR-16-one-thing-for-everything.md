---
id: UR-16
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# One thing for everything

"The one thing for everything is a principle that must apply everywhere"
(user, 2026-10-07). Every concern has exactly ONE implementation that
everything else uses: one parser per format, one store per kind of data (no
second copy of content: references, not copies), one process launcher and
supervisor, one HTTP client, one logger, one settings reader, one approval
primitive, one scope model, one serializer per format, one test runner door,
one build and toolchain per language.

- Never introduce a second implementation "for now", never defer
  consolidation, never ship a dual path.
- A task that touches a concern with duplicates consolidates them onto the
  one owner and deletes the rest in the same change.
- An exception must be proven necessary (code that physically runs in the
  browser, a declared test-only oracle) and still shares the single source of
  its definitions.

It sharpens [UR-01](UR-01-dry-kiss-yagni-one-owner.md) and
[UR-04](UR-04-shared-and-reusable-backend-and-frontend.md), applies to every
existing owner as well as new code ([UR-19](UR-19-every-rule-is-retroactive.md)),
and is enforced by mechanical guards, never by vigilance alone
([UR-18](UR-18-every-issue-class-gets-a-mechanical-guard.md)).
