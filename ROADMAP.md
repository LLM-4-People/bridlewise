# Roadmap

Bridlewise is a developer preview. This roadmap is a statement of intent, not a promise, and it deliberately avoids dates.

See [docs/roadmap.md](docs/roadmap.md) for the longer version.

## Now

- Make the public product clone build and verify cleanly on Linux.
- Make the first-run flow honest and reproducible: provider setup, project selection, and a clear readiness report.
- Keep the preview warning visible in the README, docs, installer, and health output.
- Publish reproducible screenshots and a short tour of the cockpit.
- Triage security and correctness reports from the preview.

## Next

- Close the remaining pre-admission gates and report readiness per capability instead of a single boolean.
- Make the testing floor reproducible without the private 4.1 GB corpus.
- Add signed release artifacts and a documented verification path.
- Improve cross-platform path handling; keep Landlock confinement Linux-only and clearly labeled.
- Expand the public design and decision record set.
- Add a hosted, read-only demo if the security model can support it honestly.

## Later

- Deeper code-intelligence coverage and language packs.
- More provider and MCP interoperability.
- Better memory and context inspection.
- A desktop packaging path.
- A stable extension surface.

## Not planned

- A hosted multi-tenant service in the preview.
- Claims of production readiness before the admission gates close.
- Silent fallbacks or fabricated data to make an empty state look complete.
