---
layout: default
title: Shipping and releases
description: What the build produces, how to verify it, and what a preview release contains.
permalink: /shipping/
---

# Shipping and releases

> [!WARNING]
> Every release is a developer preview. Do not deploy it for a team, expose it beyond loopback, or point it at a sensitive codebase.

## Build outputs

| Output | Command | Path | Purpose |
|---|---|---|---|
| Cockpit | `npm run build` | `dist/client/` | Static SPA bundle |
| Engine bundle | `npm --prefix engine run build:bundle` | `engine/dist/bundle.js` | Guardian payload and engine entry |
| Guardian | `make -C engine/guardian all` | `engine/guardian/build/harness-landlock-guardian` | Linux Landlock confinement |
| Process supervisor | `make -C engine/guardian test_process_supervisor` | `engine/guardian/build/` | Long-task supervision |

The build output is not committed. The source archive is the release artifact; `engine/dist/bundle.js` and `dist/client` are attached separately so they can be verified without a rebuild.

## Verify before shipping

```bash
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
npm run typecheck
npm --prefix engine run typecheck
npm run check:secrets
npm run test:public
npm run build
npm --prefix engine run build:bundle
make -C engine/guardian all
make -C engine/guardian test
```

Or:

```bash
make check
make build
make guardian
```

The `release.yml` workflow repeats this gate on a `v*` tag, then publishes:

- `bridlewise-<tag>-source.tar.gz` — the tracked source tree;
- `bridlewise-<tag>-cockpit.tar.gz` — the built static cockpit;
- `bridlewise-<tag>-engine-bundle.js` — the esbuild bundle;
- `SHA256SUMS` — checksums for all assets.

A release is not a production endorsement. The notes must repeat the developer-preview warning.

## Install from a checkout

```bash
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
node scripts/sd.mjs start
```

Open <http://127.0.0.1:5173/>. Create the first account; it owns the local harness. Add a provider in Settings before starting a chat run.

## Link the CLI

```bash
npm link
bridlewise --help
bridlewise preflight
```

The launcher runs the TypeScript CLI with Node 24's type stripping. There is no separate CLI build.

## What is not shipped

- The private development history and tags.
- The private evidence corpus, frozen records, and internal trackers.
- The full test corpus and its 4.1 GB fixture root.
- A hosted demo or a production reverse proxy.
- Provider credentials, database keys, or local state.

## Rollback

A preview release can be removed by deleting the GitHub release and tag. Local state is separate: back up the key home and the SQLite databases before upgrading, and never commit either.
