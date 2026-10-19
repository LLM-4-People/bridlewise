---
layout: default
title: CLI reference
description: The Bridlewise command line, the development scripts, and the guardian tools.
permalink: /cli/
---

# CLI reference

> [!WARNING]
> Bridlewise is a developer preview. The CLI's `preflight` receipt reports `harnessReady: false`; model invocation, repository mutation, process execution, and network egress are denied by the root policy. Do not point it at a sensitive or production codebase.

## Install and launch

```bash
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
```

The launcher is `bin/bridlewise.mjs`. It runs the TypeScript CLI directly on Node 24's type stripping, so there is no build step for the CLI itself.

```bash
./bin/bridlewise.mjs --help
npm run bridlewise -- --help
npm run bridlewise -- preflight
npm link                      # optional: exposes `bridlewise` on PATH
bridlewise --version
```

`npm run` needs `--` before CLI arguments: `npm run bridlewise -- harness check`.

## Top-level commands

| Command | What it does | Effects |
|---|---|---|
| `bridlewise preflight` | Prints the integrity receipt: config hashes, capability decisions, readiness stage | Read-only |
| `bridlewise quality [options]` | Runs the language quality packs (syntax, types, dead symbols, clones, schema drift, and related checks) | Read-only, may be CPU-heavy |
| `bridlewise harness <verb>` | Runs the workflow verbs below | Varies; verbs that write say so |

Global flags: `--help`/`-h`, `--version`/`-v`, `--verbose`/`--debug`. Everything after `--` is passed to the command verbatim.

Output defaults to JSON. `harness` verbs also accept `--text` for a human-readable rendering. Errors are typed JSON on stderr, for example:

```json
{"error":"no_harness_subcommand","message":"a harness subcommand is required (…)"}
```

## `preflight`

```bash
npm run bridlewise -- preflight
```

The receipt is the honest status surface. Healthy integrity does not mean the product is ready:

```json
{
  "harnessReady": false,
  "stage": "s1-preflight-only",
  "capabilities": [
    { "capability": "preflight", "decision": "allow" },
    { "capability": "modelInvocation", "decision": "deny" },
    { "capability": "repositoryMutation", "decision": "deny" },
    { "capability": "processExecution", "decision": "deny" },
    { "capability": "networkEgress", "decision": "deny" }
  ]
}
```

Use it to confirm the config is pinned and hashed, not to claim that a run is safe.

## `harness` verbs

`bridlewise harness` with no verb is a typed refusal that lists every verb. The verbs are grouped here by what they touch.

### Inspect and verify

| Verb | Purpose | Writes |
|---|---|---|
| `harness check` | Typecheck, architecture, and inventory checks. Flags: `--skip-typecheck`, `--skip-architecture`, `--skip-inventory` | No |
| `harness test` | Run the harness test surface. Flags: `--file <path>`, `--all`, `--no-write` | Test receipts may be written unless `--no-write` |
| `harness format` | Format the tree. `--check` is a gate and changes nothing; without it, the fixer writes | Yes (without `--check`) |
| `harness timeline` | Query the durable timeline ledger | No |
| `harness metrics` | Print the metrics snapshot | No |
| `harness diagnostic` | Run the diagnostic bundle | No |
| `harness benchmark` | Run performance benchmarks | Writes benchmark results |
| `harness eval` | Run evaluation scenarios | Writes results |
| `harness flake` | Inspect or reproduce flaky-test evidence | Varies |
| `harness extension list` | List registered extensions | No |

Examples:

```bash
npm run bridlewise -- harness
npm run bridlewise -- harness check --skip-typecheck
npm run bridlewise -- harness format --check --text
npm run bridlewise -- harness timeline --text
npm run bridlewise -- harness metrics --text
npm run bridlewise -- harness diagnostic --text
npm run bridlewise -- harness extension list
```

### Author and regenerate

| Verb | Purpose | Writes |
|---|---|---|
| `harness new-module <path>` | Scaffold a module from the registered template | Yes |
| `harness register` | Register modules in the architecture manifest | Yes |
| `harness regenerate` | Regenerate projections; `--prune <test path>` removes a stale test entry | Yes |
| `harness sync` | Converge generated hooks/projections; `--with-bundle` also rebuilds and re-pins the engine bundle; `--prune <test path>` | Yes |
| `harness index` | Rebuild the code-intelligence index | Yes |

`sync --with-bundle` is the operation that keeps the guardian payload and its hash pin consistent with the engine source. Run it after changing `engine/src` during development, then review the generated diff.

### Govern and promote

These verbs are for maintainers of the development floor. They assume the private branch/promotion topology and the full test corpus; they are documented for transparency, not as a public workflow.

| Verb | Purpose |
|---|---|
| `harness workspace create/validate/merge` | Create an isolated worktree, run the gates, and land it |
| `harness promote` | Inspect or apply the testing-to-main promotion profile |
| `harness deletions` | Declare a deliberate deletion so the commit guard can judge it |
| `harness evidence` | Ingest or materialize evidence manifests |
| `harness frozen` | Inspect or accept frozen records |
| `harness rollback` | Roll back a recorded change |
| `harness slot` | Run a bounded long task under the slot supervisor |

## Development scripts

| Script | Purpose |
|---|---|
| `node scripts/sd.mjs start\|status\|restart\|stop` | Start/stop the API and Vite together, track PIDs, wait for health |
| `npm run dev` | Vite only (no API; the cockpit will show a connection failure) |
| `npm run serve` | API only (serves no UI) |
| `npm run dev:all` | API + Vite with process groups and `.dev/*.pid` |
| `npm run dev:stop` | Stop only the recorded process groups |
| `npm run build` | Build the cockpit to `dist/client` |
| `npm run preview` | Preview the built cockpit |
| `npm run db-key -- …` | Relocate, scan, forget, or rekey the database encryption key |
| `node scripts/trace.ts …` | Inspect the run ledger: `run`, `trace`, `tail`, `runs`, `doctor`, `anatomy` |
| `node scripts/check-secrets.mjs` | Scan tracked files for credential shapes and internal paths |
| `node scripts/generate-pwa-icons.mjs` | Regenerate the PWA icons |
| `npm --prefix engine run build:bundle` | Build the guardian payload with esbuild |
| `make -C engine/guardian all test` | Build and test the Landlock guardian |

### `sd.mjs`

```bash
node scripts/sd.mjs start     # API + Vite, health-checked
node scripts/sd.mjs status    # PIDs, serving tree, health, stale processes
node scripts/sd.mjs restart
node scripts/sd.mjs stop
```

The status output names the tree each process is serving. If a process belongs to another checkout, stop it from that checkout; do not kill it from here.

### `trace.ts`

```bash
node --experimental-strip-types scripts/trace.ts runs
node --experimental-strip-types scripts/trace.ts run <runId>
node --experimental-strip-types scripts/trace.ts tail 20 --follow
node --experimental-strip-types scripts/trace.ts doctor
node --experimental-strip-types scripts/trace.ts anatomy --json
node --experimental-strip-types scripts/trace.ts --schema
```

The ledger is append-only and records redacted documents, not raw provider traffic.

### `db-key.ts`

```bash
npm run db-key -- relocate --db <database>
npm run db-key -- scan <folder>... --apply
npm run db-key -- forget --db <database>
npm run db-key -- rekey --db <database>
```

Keys live outside the checkout under `HARNESS_KEY_HOME`, `$XDG_CONFIG_HOME/bridlewise/keys`, or `~/.config/bridlewise/keys`. Keep backups and the key separate.

## Configuration

`engine/bridlewise.config.json` is the single source of truth. Self-protection is on in the shipped config, so the file must be mode `0600`:

```bash
chmod 600 engine/bridlewise.config.json
```

A fresh checkout commonly gets `0644` or `0664`; the CLI refuses it with `config_mode_insecure`. Do not weaken the check by editing the config. Set `HARNESS_CONFIG_PATH` to point at another pinned document when you need an isolated run.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | The command produced an answer, including an honest empty result |
| `1` | A typed refusal or failed check; the JSON error is on stderr |
| `64` | Usage error (guardian CLI) |
| signal-derived | The process was interrupted while waiting on a lock |

## Troubleshooting

- **`config_mode_insecure`** — `chmod 600 engine/bridlewise.config.json`.
- **Port already in use** — `node scripts/sd.mjs status`; stop the owning tree, then start again.
- **`landlock_unavailable`** — the kernel does not expose Landlock; the guardian tests skip that path. This is not a pass for confinement.
- **Bundle or guardian missing** — run `npm --prefix engine run build:bundle` and `make -C engine/guardian all`.
- **`preflight` says `harnessReady: false`** — that is the expected preview state, not a bug.
