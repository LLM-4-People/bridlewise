---
id: D-09
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: standing
---
# Agents never write a credential into a record

No key, token or password is written into a tracked file, a brief, a report,
a log or a test fixture; a fixture that needs a key-shaped value builds one no
scanner or provider accepts. Development and test provider keys reach a
process only through environment variables named by configuration or the
provider profile (loaded from a private file outside the repository, never
printed). How the PRODUCT stores credentials (the database key file, the
credential vault) is decided by [D-15](D-15-database-key-outside-the-state-root.md)
and [CRED-DIR](CRED-DIR-credentials-the-model-never-sees.md), not here.

Adopted by the coordinator from the first friction audit (FR-28); it replaces
[UR-07](UR-07-secrets-from-the-environment-only.md), which was misattributed
to the user and contradicted the key-file and vault decisions.
