---
id: D-15
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/src/filesystem/self-protection/key-home.ts, server/tools/tool-executor.ts]
---
# The database key lives outside the state root; secret files are read redacted

The database key moves out of the state root to a per-user configuration
directory outside every confinement grant and project root (default
`$XDG_CONFIG_HOME/bridlewise/keys`, 0700; a boot environment override), admitted
by the confinement owner, with a re-key and migration tool for existing
installs. A model reading a secret file (`.env`, `*.pem`, …) gets its values
redacted with the keys and structure visible (no function lost); the
credential vault later offers handles. Done by SEC-c and SEC-d.
