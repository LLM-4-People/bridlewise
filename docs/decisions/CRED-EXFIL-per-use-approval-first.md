---
id: CRED-EXFIL
date: 2026-09-28
by: user
group: configuration
status: in-force
implementation: pending
route: CRED
---
# Exfiltration control starts with per-use approval

Phase 1 asks the user to approve each use of a credential, configurable
through the shared scopes (per use, per run, per conversation, remembered per
host and use). Egress hardening (an egress lock or proxy) is deferred to a
later phase; the design keeps a clean extension path for it. The approval is
the generic approval primitive of [UR-04](UR-04-shared-and-reusable-backend-and-frontend.md).
