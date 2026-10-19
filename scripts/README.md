# Scripts

Dev-lifecycle orchestration, dev-server correctness probes, and the
harness-root integration tooling. Operator and agent tooling — nothing here
ships into the client bundle or the server runtime.

## What each file does

- `sd.mjs` — the server lifecycle script: the single reliable way to start,
  stop, restart, and report the dev servers.
- `trace.ts` — the ledger dig CLI + the harness anatomy: reads the timeline
  ledger read-only and answers "what did this run/trace actually do" in one
  command (`run`, `trace`, `tail`, with `--failed`, `--llm`, `--documents`,
  `--since`/`--until`, `--json`), `runs` (one line per run: span, outcome
  rollup, failures, tokens), `doctor` (the newest run with failures,
  collapsed to the header + failed events + gate blocks + provider
  payloads), `--schema` (the JSON contract of every command's `--json`
  output), and `anatomy` prints the live harness — the /proc process
  census (pids, chains, CPU, RSS, classification, provenance) plus the
  server's in-process component registry, fetched through the
  `observability.anatomy` block read when the server is up (the census owner
  is `server/observability/process-census.ts`; the registry is
  `server/observability/component-registry.ts`). The query/format logic
  lives in `engine/src/timeline/ledger-dig.ts` (the ledger's engine-owned
  read path); this file is the thin shell. Exit codes are the contract's
  first signal: 0 an answer (including an honest empty scope), 1 an absent
  id or invalid arguments.
  `docs/debugging/README.md` is the guide.
- `dev-all.ts` — the dev orchestrator: starts the API server and the Vite
  dev server together, tracks PIDs under `.dev/`, guarantees clean shutdown.
- `dev-stop.ts` — the companion stopper: stops exactly those process groups,
  and only those (with no pid file it names what holds the ports and stops
  nothing).
- `dev-processes.ts` — what the two share: the `.dev/` pid files (each the
  spawn record of a process this lifecycle started: pid + start time, so a
  recycled pid is never signalled; the census reads the same records),
  `stopDevGroup` (the process-facts owner's one terminate loop with the
  shutdown grace, for an owned process only — KILL-OWNED-ONLY),
  `stopDevOrchestrator` (THIS repository's recorded orchestrator, by identity
  and working directory — `sd.mjs stop` and `dev-stop.ts` both; never a
  process-list pattern, which matched every checkout's orchestrator) and
  `portListeners` (what holds the dev ports: named, never stopped).
- `db-key.ts` — `npm run db-key -- relocate --db <db> [--force-empty] | scan <folder>... [--apply] | forget --db <db> | rekey --db <db>`: the thin shell of `server/db/key-rotation.ts` (one JSON line; exit 0 done, 1 refused). `scan --apply` REGISTERS the installs it finds and never moves a key; each install moves its own with `relocate`.
- `vite-dep-cache.ts` — the single owner of "is the Vite dep-optimizer cache
  older than the source being served", with the refusal that clears it.
- `served-module-probe.ts` — the settle-and-poll mechanics for probing a
  dev-server boot against a served transform artifact.
- `svelte-css-scope-probe.ts` — refuses a dev server that serves a
  component's CSS unscoped.
- `generate-pwa-icons.mjs` — emits the PWA icons using only Node built-ins.
- `db-archive.ts` — the conversation-archive shell (the development root package's `db-archive` script, with
  `--db <database> --chats-file <file>`; not installed in the product projection): a thin shell over the `database.conversations.archive` action (`server/db/conversation-archive.ts`); stop the server first.

## The subfolders

- `harness-root/` — the integration merge and bootstrap tooling at the
  harness root.

## Where it lives and what consumes it

The folder lives at `scripts/`. The npm scripts in `package.json` invoke the
lifecycle entries, and agents drive `sd.mjs` directly.
