---
id: CFG-DIR
date: 2026-09-28
by: user
group: configuration
status: in-force
implementation: pending
route: CFG
---
# Configuration is a code registry plus the database

Configuration is not a file written at runtime. One code-level declarative
registry (the single source of truth) defines every setting: default, ranges
and validation, type, docs, tests and allowed scopes. Changed values are
written to the database, never to a config file. Scopes: admin/global
(admins only), user, and project/conversation; a setting may allow several,
and resolution is layered ([UD-C1](UD-C1-most-specific-scope-wins.md)). Adding,
editing or deleting a setting is easy and mechanical; the settings UI is
generated from the registry. The bootstrap tier (needed before the database
exists) and repository tooling configuration stay checked-in files.
