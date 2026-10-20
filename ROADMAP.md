# Roadmap

Bridlewise is a developer preview. This roadmap is a statement of intent, not a promise, and it deliberately avoids dates. The detailed engineering roadmap, workstreams, and exit criteria live on the [development floor](https://llm-4-people.github.io/bridlewise-testing/floor/roadmap/), and the floor's [tracker](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/trackers/TASKS.md) is the state of record. See [docs/roadmap.md](docs/roadmap.md) for the product-facing status and gap register.

## Milestones

| Milestone | State | What must be true |
|---|---|---|
| **M0 · Public preview and floor** | Shipped | Both repositories, Pages, the public gate, failure reporting, the promotion gate, and `v0.0.3-preview` are live. |
| **M1 · Reproducible, sharded floor** | In progress | The supported suite runs on shards and merges into one receipt; every canonical test file runs once with its prerequisites named; the performance report is reproducible; and a documented runner class reaches the 10x test-phase factor. |
| **M2 · Admission evidence** | Planned | Readiness is reported per capability, with evidence and a remedy attached. |
| **M3 · Product hardening** | Planned | Backup and restore, provider coverage, portability, scale, and accessibility have tested failure paths. |
| **M4 · Sustainable contribution** | In progress | A new contributor can go from clone to a merged test or docs change using only public instructions. |

State is the floor's milestone focus, not a roll-up: a planned milestone can already have workstreams in progress. The floor's generated roadmap and tracker carry the counts, workstreams, and exit criteria.

## Now

The floor's tracker is the state of record; this list names only the work that is still moving.

- Finish the reproducible floor. Sharding, the merged receipt, the pinned corpus manifest, and the repair of the public-snapshot baseline are shipped there. The open items are a reproducible performance report under the idle-host contract, a 10x test-phase factor on a documented runner class, and a `node:test` shard runner that preserves the inventory contract. The CPU-per-file budget is blocked on a clean idle-host campaign or an explicit policy decision.
- Keep the first-run flow honest and reproducible: provider setup, project selection, and a clear readiness report.
- Keep the preview warning visible in the README, docs, CLI launcher, and health output.
- Triage security and correctness reports from the preview.

## Next

- Close the remaining pre-admission gates and report readiness per capability instead of a single boolean.
- Project the floor's shipped database and key-home backup/restore flow into the product.
- Add release provenance: versioned metadata, checksums, attestations, and a documented verification path. Signing follows a reproducible build.
- Improve cross-platform path handling; keep Landlock confinement Linux-only and clearly labeled.
- Expand the public design and decision record set.
- Add a hosted, read-only demo only if the security model can support it honestly.

## Later

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
