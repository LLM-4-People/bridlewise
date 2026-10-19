---
id: UR-02
date: 2026-09-28
by: user
group: user-rules
status: in-force
implementation: standing
---
# Generated values come from generators

Hashes, pins, fingerprints, inventories, baselines and manifests are never
edited by hand: `cd engine && node src/cli.ts harness sync [--with-bundle]`
and the registered generators produce them. A generated value no generator
owns is a tooling gap: it is registered with a generator, so `harness sync`
regenerates it and `harness check` detects its drift.
