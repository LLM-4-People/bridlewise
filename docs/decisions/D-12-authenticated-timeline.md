---
id: D-12
date: 2026-09-27
by: coordinator
group: process
status: in-force
implementation: partial
route: REQ-025
acted_in: [docs/findings/responses-api-migration.md]
---
# The timeline drops HMAC signing; encryption at rest stays open

Codex's authenticated-timeline draft is reduced to option (b): HMAC signing
is dropped (no requirement asks for it; tamper evidence is already met by the
hash chain), the bug fixes are kept, and the field codec and key owners stay
(`engine/src/privacy/encrypted-field.ts`, `engine/src/filesystem/persisted-key.ts`).
Done by A3.

Timeline encryption at rest (REQ-025: an encrypted, access-controlled
full-fidelity evidence vault with its key outside model-accessible files)
remains an OPEN registered requirement with its own design task (the timeline
security successor), together with keyed digests for protected originals
(FIX1-DIGEST-ORACLE).
