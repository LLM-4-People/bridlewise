# Roadmap

Bridlewise is a developer preview. This roadmap is a statement of intent, not a promise, and it deliberately avoids dates. The detailed engineering roadmap, workstreams, and exit criteria live on the [development floor](https://llm-4-people.github.io/bridlewise-testing/floor/roadmap/). See [docs/roadmap.md](docs/roadmap.md) for the product-facing status and gap register.

## Milestones

| Milestone | State | What must be true |
|---|---|---|
| **M0 · Public preview and floor** | Done | Both repositories, Pages, the public gate, failure reporting, the promotion gate, and `v0.0.3-preview` are live. |
| **M1 · Reproducible, sharded floor** | Active | The full suite runs on shards, merges into one receipt, and every canonical test file runs once with its prerequisites named. |
| **M2 · Admission evidence** | Next | Readiness is reported per capability, with evidence and a remedy attached. |
| **M3 · Product hardening** | Next | Backup and restore, provider coverage, portability, scale, and accessibility have tested failure paths. |
| **M4 · Sustainable contribution** | Active | A new contributor can go from clone to a merged test or docs change using only public instructions. |

## Now

- Make the full test floor reproducible and substantially faster through sharding, a merged receipt, and a pinned corpus manifest. Do not publish the raw corpus.
- Repair the public-snapshot baseline reds without hiding or skipping a test.
- Keep the first-run flow honest and reproducible: provider setup, project selection, and a clear readiness report.
- Keep the preview warning visible in the README, docs, installer, and health output.
- Triage security and correctness reports from the preview.

## Next

- Close the remaining pre-admission gates and report readiness per capability instead of a single boolean.
- Add release provenance: versioned metadata, checksums, attestations, and a documented verification path. Signing follows a reproducible build.
- Improve cross-platform path handling; keep Landlock confinement Linux-only and clearly labeled.
- Expand the public design and decision record set.
- Add a hosted, read-only demo only if the security model can support it honestly.

## Later

- Backup and restore for the database and key home.
- Deeper code-intelligence coverage and language packs.
- More provider and MCP interoperability with conformance evidence.
- Better memory and context inspection.
- A desktop packaging path.
- A stable extension surface.

## Not planned

- A hosted multi-tenant service in the preview.
- Publishing the raw 4.1 GB corpus as a repository.
- Claims of production readiness before the admission gates close.
- Silent fallbacks or fabricated data to make an empty state look complete.
- A benchmark number without its method.
