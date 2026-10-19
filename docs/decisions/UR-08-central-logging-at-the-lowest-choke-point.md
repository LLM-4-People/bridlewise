---
id: UR-08
date: 2026-09-27
by: user
group: user-rules
status: in-force
implementation: partial
route: RC-06
acted_in: [engine/src/runtime/cli-debug.ts]
---
# Everything goes through central logging

Every diagnostic, refusal and state change is routed through the one central
logging system, at the lowest choke point that sees it: never `console`, never
an empty or silent catch, never a second logger. Entry points start central
logging first. RC-06 evolves the owner in place (`createLogger`,
`initLogging({role})`) under [D-04](D-04-logging-migration-ratchet.md)'s
ratchet; until then new code uses the existing debug-system owner.
