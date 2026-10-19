---
id: D-18
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: standing
---
# The key scan registers; it never relocates other installs

`npm run db-key -- scan <dir> --apply` is not run on a machine holding other
installs: it would move the keys of the master checkout and other installs.
A scan only registers what it finds; each install relocates its own key
(`npm run db-key -- relocate --db <path>`).
