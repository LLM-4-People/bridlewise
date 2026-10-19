# Changelog

All notable public changes are recorded here. The project is a developer preview; version numbers do not imply production readiness.

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
