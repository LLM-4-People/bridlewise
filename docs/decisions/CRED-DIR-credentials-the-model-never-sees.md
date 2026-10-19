---
id: CRED-DIR
date: 2026-09-28
by: user
group: configuration
status: in-force
implementation: pending
route: CRED
---
# Credentials the model never sees

Users supply credentials; the model can USE them everywhere needed but never
sees a value: while using one it sees only its name, id, description and
non-secret metadata, and it cannot echo, print, encode, write out or
exfiltrate it. Credentials are persistent and reusable: stored encrypted and
scoped (user, project, conversation, admin-shared), with stable named handles
the model discovers and reuses across turns and sessions, a lifecycle (rotate,
revoke, expire, update in place), and a policy for when reuse needs
re-approval. Mechanisms are ranked by their guarantee against an actively
adversarial model, per credential class, with a user-visible risk level per
credential. Exfiltration control is [CRED-EXFIL](CRED-EXFIL-per-use-approval-first.md).
