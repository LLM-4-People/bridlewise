# Changelog

All notable public changes are recorded here. The project is a developer preview; version numbers do not imply production readiness.

## [0.0.2-preview] - 2026-10-19

### Added

- Interactive **Run 0001** record: a synthetic, offline causal timeline with an inspector, typed refusal, redaction, and keyboard navigation.
- Interactive **Policy lab**: an illustrative governance console for capability gates, a preflight receipt, and the immutable safety floor.
- **The repository is a run record** map, an evidence ladder, a glossary, a reading map, and a candid known-issues register.
- GitHub Codespaces devcontainer, Codespaces guide, relative Markdown link gate, release-note categories, and a release-tag ruleset.
- SPDX SBOM generation and GitHub build-provenance attestations for the product release workflow.
- Six scoped public issues and a `v0.0.2-preview` milestone.

### Changed

- Pinned every GitHub Action to a full commit SHA and moved write permissions to the jobs that need them.
- Made HTML script-tag parsing case-insensitive and stopped unknown server errors from exposing arbitrary messages.
- Moved semantic embeddings to an optional peer dependency, removing the vulnerable `sharp`/`protobufjs` install path from the default engine tree.
- Refreshed the root and engine lockfiles; `npm audit` is clean across both trees.

### Security

- Closed or dismissed the reviewed code-scanning queue with path-specific reasons; test-only and benchmark findings are marked as such, and real fixes are in the tree.
- Enabled a tag ruleset protecting `v*` from deletion and force-update.
- Added SBOM and provenance verification commands to the shipping and evidence docs.

### Known limitations

- Still pre-admission, unaudited, Linux-first for confinement, and not for sensitive code.
- The full corpus-backed development-floor suite is still not reproducible from a fresh clone.
- The social preview remains a manual GitHub setting.

## [Unreleased]

### Added

- First public, sanitized snapshot of the Bridlewise product tree.
- Cockpit, loopback API server, engine, Landlock guardian, and shared contracts.
- AGPL-3.0-only licensing and third-party notices.
- Public documentation site, quickstart, architecture, security, FAQ, and roadmap.
- CI, CodeQL, dependency review, secret scanning, release, Pages, and OpenSSF Scorecard automation.
- Community files: contributing guide, code of conduct, security policy, support, and issue/PR templates.

### Security

- Public snapshots were rebuilt from clean trees. Private history, internal evidence, and committed credentials are not published.
- Added explicit ignore rules for environment files, private keys, databases, logs, and local harness state.

### Known limitations

- The harness is pre-admission. Interactive capabilities are implemented but not admitted as production-ready.
- Linux-first; Landlock is Linux-only.
- No hosted demo.
- The full test suite is not reproducible from a fresh product clone; the testing repository documents its prerequisites.
- Provider setup is manual.


### Added

- First public, sanitized snapshot of the Bridlewise product tree.
- Cockpit, loopback API server, engine, Landlock guardian, and shared contracts.
- AGPL-3.0-only licensing and third-party notices.
- Public documentation site, quickstart, architecture, security, FAQ, and roadmap.
- CI, CodeQL, dependency review, secret scanning, release, Pages, and OpenSSF Scorecard automation.
- Community files: contributing guide, code of conduct, security policy, support, and issue/PR templates.

### Security

- Public snapshots were rebuilt from clean trees. Private history, internal evidence, and committed credentials are not published.
- Added explicit ignore rules for environment files, private keys, databases, logs, and local harness state.

### Known limitations

- The harness is pre-admission. Interactive capabilities are implemented but not admitted as production-ready.
- Linux-first; Landlock is Linux-only.
- No hosted demo.
- The full test suite is not reproducible from a fresh product clone; the testing repository documents its prerequisites.
- Provider setup is manual.
