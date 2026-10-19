---
id: UR-07
date: 2026-09-28
by: coordinator
group: user-rules
status: superseded
superseded_by: D-09
implementation: standing
---
# Secrets from the environment only

Keys, tokens and passwords are read from the environment (or the credential
vault once it exists), never from a tracked file, and never written into a
tracked file, a report, a log, a brief or a test fixture; a fixture that needs
a key-shaped value builds one that no scanner or provider accepts.

Superseded by [D-09](D-09-credentials-never-in-repository-records.md): this rule
came from the first friction audit (FR-28) and was adopted by the coordinator,
not the user, and its product clause contradicted the database key file
([D-15](D-15-database-key-outside-the-state-root.md)) and the credential vault
([CRED-DIR](CRED-DIR-credentials-the-model-never-sees.md)).
