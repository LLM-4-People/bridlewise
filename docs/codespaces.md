---
layout: default
title: Open it in a Codespace
description: The one-click GitHub Codespaces workspace for the Bridlewise developer preview, what it boots, and what it deliberately does not configure.
permalink: /codespaces/
page_class: article
---

<p class="eyebrow">GitHub-native workspace</p>

# Open the cockpit in a Codespace

The repository ships a dev container so the first run does not begin with a
toolchain essay. One click gives you a Linux workspace with Node 24, the
native build tools the guardian needs, both lockfiles installed, and ports
`5173` (cockpit) and `5174` (loopback API) forwarded.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/LLM-4-People/bridlewise?quickstart=1)

The badge opens a new Codespace from `main`. Codespaces is a GitHub-hosted
development environment, not a hosted demo of Bridlewise. The cockpit still
runs on loopback inside that workspace. Prompts and the repository context you
send to a model provider leave the machine by design; the local server and the
record stay on loopback. The container does not ship a provider credential.

## What the container does

- Boots `mcr.microsoft.com/devcontainers/typescript-node:5-24-trixie` with
  `build-essential` for the guardian's C build.
- Runs `npm ci`, `npm --prefix engine ci`, and tightens
  `engine/bridlewise.config.json` to mode `600`.
- Forwards `5173` and `5174`. The API is loopback-bound; the forwarded API
  port is for the cockpit in the same workspace, not a public API.
- Installs the Svelte, ESLint, and Prettier editor extensions.

## First commands

```bash
# the honest state of the harness
./bin/bridlewise.mjs preflight

# start the cockpit and the loopback server
node scripts/sd.mjs start

# the public smoke suite (no corpus, no model key)
npm run test:public
```

Open the forwarded `5173` URL. If `preflight` refuses a capability, that is
the product working: the refusal names the missing admission gate or adapter.
Read [Run record]({{ '/run/' | relative_url }}) for what the cockpit records,
and [Policy lab]({{ '/policy-lab/' | relative_url }}) for the governance posture
the demo illustrates.

## What it does not configure

- **No model credential.** A Codespace has no provider key. Use the fixture
  path for a UI walkthrough, or configure a provider you are willing to use.
- **No corpus.** The 4.1 GB development-floor corpus is not in this
  repository. The public smoke suite does not need it; the full suite does.
- **No production claim.** The container is a developer workspace for an
  experimental preview, not a hardened deployment target. Do not point it at
  sensitive, proprietary, or regulated code.

## Cost and lifecycle

Codespaces consumes the included quota on your GitHub plan and stops when it
is idle. A public repository does not make compute free. Delete the Codespace
when you are done; the repository does not need a long-lived workspace.

If the container cannot build the guardian on your architecture, use the
[quickstart]({{ '/quickstart/' | relative_url }}) on a Linux host and open an
issue with the exact failure. A dev container that hides a broken native build
would be worse than no dev container.
