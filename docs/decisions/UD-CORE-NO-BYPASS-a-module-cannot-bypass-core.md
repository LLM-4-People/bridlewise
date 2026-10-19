---
id: UD-CORE-NO-BYPASS
date: 2026-10-08
by: user
group: process
status: in-force
implementation: pending
route: CORE-NO-BYPASS
---
# A module cannot bypass core

The user's rule of 2026-10-08 (BRIEF.md, "CORE CANNOT BE BYPASSED"), in the
user's words: "its very important that a module cannot bypass core modules,
its not about making a module that does not bypass, but make the harness so
a malicious module just cannot bypass core".

- Core is logging, the content guard and redaction, outbound HTTP, the
  filesystem, process spawn, the database, crypto and keys, authorization and
  configuration.
- Assume the module is MALICIOUS: static guards and the architecture
  manifest are early feedback, never the boundary.
- Enforcement is by a boundary the module cannot touch: a process boundary
  with kernel confinement plus a capability channel to core, and/or
  frozen-realm isolation.
- Every design and review states how a malicious module is stopped.

It is carried out by CORE-NO-BYPASS.
