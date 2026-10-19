---
id: UR-21
date: 2026-10-07
by: user
group: user-rules
status: in-force
implementation: standing
---
# Secrets and personal data are redacted, never a reason to block

Secrets and personal data are AUTOMATICALLY REDACTED everywhere, and the
user is prompted — never modally — to add them to the vault; the workflow is
NEVER blocked by a detection (user correction, 2026-10-07: "on doubt" means
redact, never refuse or halt).

- One detection owner at the lowest choke points (every persistence write,
  every outbound request, every log and audit sink, every model-context
  ingress) extends the credential system: a detected value is held behind a
  scoped handle and resolves only at the tool or egress boundary.
- The commit hook REDACTS a secret in the staged content (a vault handle
  placeholder) and prompts to vault it; it neither refuses the commit nor
  merely warns.
- Detectors are measured before they are relied on (precision and recall
  against adversarial and benign corpora, thresholds as settings), and every
  check, threshold and policy is a scoped setting in the one registry.

It refines [D-09](D-09-credentials-never-in-repository-records.md) and
[UR-07](UR-07-secrets-from-the-environment-only.md) for detected values; it
replaces the earlier wording "block on any doubt" for the shared content
checks.
