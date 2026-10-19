---
id: UD-CFG-CRED
date: 2026-09-28
by: user
group: configuration
status: in-force
covers: [UD-C2, UD-C3, UD-C4, UD-C5, UD-C6, UD-C7, UD-C8, UD-C10, UD-C11, UD-C12, UD-C13, UD-R2, UD-R4, UD-R5, UD-R6, UD-R7, UD-R8, UD-R9]
implementation: pending
route: CFG
---
# The configuration and credential designs' recommendations

Accepted as recommended: C2 (no environment layer for runtime settings), C3
(an operator relaxes through the CLI `--confirm-relax`), C4 (admins do not edit
others' settings), C5 (browser preferences per user), C6 (the chat model is a
conversation setting), C7 (code defaults and invariants are allowed), C8 (the
dead CLI re-exec is deleted), C10 (`passwordMinLength` wired, tighten-only,
floor 8), C11 (the MCP secrets move waits for the credential vault), C12
(model-proposed setting changes go through approval), C13 (providers and MCP
servers are record settings), R2 (writes always ask per use), R4
(self-protection off refuses model credentials only, with a banner), R5 (the
vault key is the database field key, domain-separated; a passphrase is
optional), R6 (`$HOME` is refused as a project), R7 (the signer tier is phase
2), R8 (decoys off), R9 (each credentialed MCP call is a use).
