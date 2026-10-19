---
id: UD-LOG-NEVER-DISABLED
date: 2026-10-08
by: user
group: process
status: in-force
implementation: pending
route: LOG-NEVER-DISABLED
---
# Logging is never disabled

The user's rule of 2026-10-08 (BRIEF.md, "LOGGING IS NEVER DISABLED"):

- Warn and error are always reported, everywhere: the server, workers, CLIs,
  scripts, and the browser client to the server log. Debug is the only
  optional level. Nothing can suppress warn or error, and debug-only
  reporting never counts as handling an error.
- Debug, in the user's words: "everything must support debug, it's just that
  we don't store it or show it (ideally just skip it so no processing power
  is lost)". Every component is instrumented with debug logging. When debug
  is off, a debug call costs only a level check: no formatting, allocation,
  serialization, redaction or I/O, so messages are lazy.

It is carried out, and mechanically guarded, by LOG-NEVER-DISABLED (the
guard catalog's LG class).
