---
layout: default
title: "Quickstart"
description: "Install Bridlewise from source, start the loopback server, create the first account, and configure a model provider."
permalink: /quickstart/
---

# Quickstart

This gets a **developer preview** running from source on a disposable copy of a repository. It is not an installation guide for a supported product.

> **Read this first.** Bridlewise is pre-1.0 and pre-admission. Do not use it on proprietary, regulated, client-confidential, or production code. Expect breaking changes and data loss. See [Security and limits]({{ '/security/' | relative_url }}).

## Prerequisites

- **Node.js `>=24.18.0 <25.0.0`** and npm.
- **Linux** for the Landlock path. The server and cockpit can run elsewhere, but OS-level confinement is Linux-only; WSL2 depends on the host kernel and Landlock ABI.
- **Git**, a C compiler and `make` if you want to build the guardian yourself.
- A disposable copy of a repository, and a model provider endpoint you can call.
- Enough free disk for `node_modules` in both packages and local SQLite state.

Check the runtime before installing:

```bash
node --version   # must be v24.18.x or later in the 24 line
npm --version
```

## Prefer a prepared workspace?

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/LLM-4-People/bridlewise?quickstart=1)

The dev container installs both lockfiles, builds the guardian's native
dependencies, forwards ports `5173` and `5174`, and still runs the cockpit on
loopback. It does **not** include a model credential or the development-floor
corpus. See [Open it in a Codespace]({{ '/codespaces/' | relative_url }}) for
what it configures and what it deliberately leaves to you. A Codespace consumes
your GitHub plan's included quota; it is not a free hosted deployment.

## Install

From the repository root:

```bash
git clone https://github.com/LLM-4-People/bridlewise.git
cd bridlewise

npm ci
(cd engine && npm ci)

chmod 600 engine/bridlewise.config.json
```

Three details matter here:

1. **Both packages install separately.** The engine has its own `package.json` and lockfile. A root-only install leaves the engine incomplete.
3. **The config must be `0600`.** Git does not preserve exact non-executable Unix modes, so a fresh checkout can materialize `engine/bridlewise.config.json` as `0644` or `0664`. Self-protection is enabled in the checked-in config, and the runtime fails closed with `config_mode_insecure` until the mode is fixed.

If you prefer to inspect before running, the config is a strict, typed document. It contains no secrets; secrets live behind handles outside the repository.

## Start

```bash
node scripts/sd.mjs start
```

The lifecycle script starts the API server and the Vite UI, waits for health, and reports what it started. Open:

**http://127.0.0.1:5173**

The API listens on **`127.0.0.1:5174`** by default. The UI is Vite's; the API server alone does not serve the app.

Useful commands:

```bash
node scripts/sd.mjs status    # PIDs + listeners on 5173 and 5174
node scripts/sd.mjs restart   # stop what this lifecycle started, start fresh
node scripts/sd.mjs stop      # stop only what this lifecycle started
```

`sd.mjs` deliberately does not kill a process it did not start. If another process owns a port, it names that process and stops. Do not reach for `pkill` or `kill -9`; you will lose the record of what you started.

### Ports

| Service | Default | Override |
|---|---|---|
| Cockpit (Vite) | `5173` | Vite's own configuration; strict port |
| API + SSE | `5174` | `HARNESS_WEB_PORT` |
| Allowed browser origin | `http://127.0.0.1:5173` | `HARNESS_WEB_ALLOWED_ORIGIN` |

If you change the UI origin, set `HARNESS_WEB_ALLOWED_ORIGIN` to match before starting. If you change the API port, `sd.mjs` reads `HARNESS_WEB_PORT` for its health check.

## First run

### 1. Create the first account

The first account **owns the harness** and is the administrator. Open registration is allowed only while no users exist; after that, registration is closed unless an administrator creates the account. There is no hosted account recovery service.

Choose a username and a password you are willing to lose with the disposable environment. The session cookie is HttpOnly and SameSite=Lax; the database stores a hash of the session token, not the token itself.

### 2. Add a model provider

Open **Settings → Model providers** and choose the add action. You need:

- a **name** for the provider (what the picker shows);
- an **API address** — an HTTP or HTTPS base URL such as `https://your-provider.example/v1`, with no embedded credentials, query string, or fragment;
- an **API key**;
- at least one **model id** the endpoint serves.

You can add optional per-model limits (context window, max reply tokens, temperature) and extra non-secret headers. The key is stored in the encrypted provider record and is never echoed back by the read path. If a provider is saved without a key, it is listed as incomplete and a run that selects it refuses by name. There is no fallback provider.

Set a default model for new conversations, or choose a model per conversation. Providers must speak the **OpenAI Responses** or **OpenAI Chat Completions** protocols. Anthropic-native and Gemini-native APIs are not verified adapters here.

### 3. Add a project

Choose a **disposable copy** of a repository. The harness reads and writes inside the selected project and rejects paths outside it. Deleting a project removes it from the harness database only; it never deletes files from disk. Keep your own backup and a clean git state.

### 4. Send a run

Send a prompt. The cockpit opens a run and streams its beats. Expect to see:

- the user turn and the model turn;
- tool calls with their arguments and results;
- file effects with diffs;
- check deltas when a check changes state;
- findings authored by the harness;
- typed refusals where a capability is blocked.

A run executes once. If you open the same run in another view, it attaches to the recorded stream rather than starting a second execution. Cancelling or steering is an explicit action on the run.

## Provider-free demo mode

To exercise the interface without live model calls:

```bash
HARNESS_WEB_LLM_FIXTURES=1 node scripts/sd.mjs start
```

Fixture mode replaces the model stream with deterministic events. It is not a free pass around setup: provider and model resolution still run first, so you must have a provider and model selected. The configured endpoint is **not called** in fixture mode, and fixture turns are marked as fixtures in the record. Do not use fixture output to evaluate model quality.

To return to live calls, stop the servers and start them without the variable:

```bash
node scripts/sd.mjs stop
node scripts/sd.mjs start
```

## What to expect

- **A boot column, not a splash screen.** Registration reports real probes with measured timings. On a warm signed-in boot it compresses to a few lines.
- **Guided refusal instead of an empty chat.** With no provider, a run refuses with `provider_not_configured` and names the remedy.
- **Local state.** The web database defaults to `.bridlewise/web.db`; the timeline defaults to `.bridlewise/timeline.db`. Runtime state is ignored by git.
- **Keys outside the checkout.** Database key material lives in the key home: `HARNESS_KEY_HOME` if set, otherwise `$XDG_CONFIG_HOME/bridlewise/keys`, otherwise `~/.config/bridlewise/keys`. **Back it up.** A database copy without its key is unreadable.
- **No hosted service.** Nothing is uploaded to a Bridlewise account. Prompts and context do go to the provider you configure, subject to the redaction policy.
- **Rough edges.** Layout, providers, migrations, and error copy are still changing. If something looks wrong, capture the run id and the typed error before restarting.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `config_mode_insecure` at boot | `engine/bridlewise.config.json` is not mode `0600` | `chmod 600 engine/bridlewise.config.json`, then start again. Do not disable self-protection to get past it. |
| Port `5173` or `5174` already in use | Another dev server, or a stale process from a previous lifecycle | `node scripts/sd.mjs status`; stop what this lifecycle owns. Do not kill an unrelated process. |
| "The server is not answering" in the boot column | API not running, wrong port, or health never became ready | `node scripts/sd.mjs status`; read the tail of `.dev/boot.stderr.log` if present; restart. |
| UI loads but no models | No provider saved for this account | Settings → Model providers; add a provider and a model, then set a default. |
| `provider_key_missing` | Provider saved without a key | Edit the provider and add its key. |
| `provider_not_configured` | No provider, no model chosen, or the model is not served | Add the model to a provider or choose a model that provider serves. |
| `SelfProtectionUnavailableError` | Landlock is unavailable, or the guardian binary is missing | Use a Linux kernel with Landlock; build the guardian with `cd engine/guardian && make all`; check `node engine/src/cli.ts preflight` from `engine/`. WSL2 may not expose the needed ABI. |
| Engine complains the bundled payload is missing | Production mode expects `engine/dist/bundle.js` | From `engine/`, run `npm run build:bundle`; after source changes, `node src/cli.ts harness sync --with-bundle`. |
| Stale UI after a code change | Old Vite process or browser tab | `node scripts/sd.mjs restart`; reload the tab. Confirm the served tree with `status`. |
| Registration refused as closed | A first account already exists | Sign in as the administrator. Open registration is closed by design after setup. |
| Sign-in fails and you have no other account | The local database is the account store; there is no hosted recovery | Restore the disposable environment from your own backup. Do not treat the harness database as your only copy. |

If a failure is reproducible, include the exact command, the typed error code, the run id, and whether the provider was live or fixture mode. Redact keys, tokens, and private code before posting.

## Verify the install

```bash
npm run typecheck
(cd engine && npm run typecheck)
```

The product tree exposes type checks, not the full prevention suite. The complete test inventory, benchmarks, and verification tooling live in [`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing). The engine's `preflight` is an integrity receipt:

```bash
(cd engine && node src/cli.ts preflight)
```

It reports `harnessReady: false` while the governance gate is open. That is the current, honest state of the preview — not a bug in your install.

## Next

- [Architecture]({{ '/architecture/' | relative_url }}) — how the pieces fit and where the trust boundary is.
- [Security and limits]({{ '/security/' | relative_url }}) — what is protected, what is not, and how to report a vulnerability.
- [Design]({{ '/design/' | relative_url }}) — the cockpit's surfaces, tokens, and accessibility rules.
- [FAQ]({{ '/faq/' | relative_url }}) — readiness, providers, licensing, and the two repositories.
