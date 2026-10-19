---
id: CRED-UD-3
date: 2026-09-28
by: user
group: configuration
status: in-force
implementation: standing
---
# The exposed tier never ships

A tier in which the model can read a credential's value never ships. A
credential kind that needs a raw in-process value gets a never-raw route
(a protocol-aware relay or a harness-side client) on the extension path;
until then it is unsupported. (Cited as UD-3 in the credential design.)
