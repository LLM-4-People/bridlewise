---
layout: default
title: "FAQ"
description: "Straight answers about Bridlewise's readiness, providers, data handling, licensing, repositories, and platform support."
permalink: /faq/
---

# Frequently asked questions

Short answers, including the ones that are not flattering. If a question is missing, open an issue with the exact context; do not post secrets or private code.

## Is it ready?

No. Bridlewise is a **pre-1.0 developer preview**. The engine is pre-admission: `harnessReady` is `false`, interactive capabilities remain behind an open governance gate, and there has been no security audit. Expect breaking changes, incomplete flows, and data loss.

It is ready to be **evaluated** on a disposable copy, by someone willing to read the code and the record. It is not ready to be depended on.

## Can I use it at work?

Only if "at work" means a disposable, non-sensitive environment with synthetic or public code, and you have permission to send that content to your chosen model provider. Do **not** point it at proprietary, client-confidential, regulated, or production code. There is no DPA, no security certification, no support contract, and no guarantee that redaction catches every secret.

If your employer's policy requires an approved tool, Bridlewise is not that tool yet.

## Does it send my code to a model?

Yes, when you run a live model call. The server assembles context from your conversation, project, and memory, applies its redaction policy, and sends the request to the provider **you configure**. There is no Bridlewise relay or hosted account in the middle.

Redaction reduces accidental secret egress; it does not make hostile repository content safe, and it cannot guarantee that nothing sensitive is included. The provider's retention, training, and logging policies are between you and that provider.

Fixture mode (`HARNESS_WEB_LLM_FIXTURES=1`) replaces the model stream with deterministic events and does not call the endpoint. It still requires a saved provider and model because provider resolution happens before the stream, and fixture output is marked as such in the record.

## Which providers are supported?

Providers that speak the **OpenAI Responses** or **OpenAI Chat Completions** protocols, configured with a base URL, an API key, and one or more model ids. You can add optional context-window, max-token, and temperature limits per model, plus non-secret headers.

Anthropic-native and Gemini-native APIs are not verified adapters here. A provider may advertise OpenAI compatibility and still differ in edge behavior; test with your endpoint. There is no bundled provider, no default key, and no fallback.

## Why not a VS Code extension?

Because the unit of the product is the **run**, not the editor buffer. Bridlewise records a causal stream of model turns, tool calls, file effects, checks, and findings, and gives that stream its own surfaces: the FLOW, the SWEEP, custody of effects, and an append-only ledger. An extension could host a chat panel, but it would inherit the host's model of tools, permissions, and history — the parts this project is trying to make explicit.

The editor room is one surface of the cockpit, not the product's center. That is a deliberate bet. It may be the wrong bet for your workflow; a general-purpose IDE extension is not on the roadmap.

## Why AGPL-3.0?

Bridlewise is a local tool whose value is in the whole harness: the run record, the governance, the cockpit, and the engine. The AGPL keeps modifications to that whole available to the people who interact with it, including when a modified version is offered over a network. It also makes the license unambiguous for a project that expects contributions and forks.

It is not an open-core license with a proprietary "enterprise" edition, and there is no promise of one. If AGPL does not fit your organization, do not use the code; the license is the license.

## How do I contribute?

Start with the [testing floor](https://github.com/LLM-4-People/bridlewise-testing). It carries the prevention suite, benchmarks, design records, and the decision log. Read [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md) and the [Code of Conduct](https://github.com/LLM-4-People/bridlewise/blob/main/CODE_OF_CONDUCT.md).

Useful contributions include reproducible bug reports, a failing test for a real failure mode, documentation corrections, accessibility fixes, and provider compatibility evidence. The product branch is a projection of the development branch, so a change lands on the testing floor with its evidence and travels through the promotion door; do not expect a direct edit to `main`.

## Why two repositories?

They have different jobs:

- **[`bridlewise`](https://github.com/LLM-4-People/bridlewise)** is the product: the cockpit, server, engine, guardian, shared contracts, scripts, and documentation. It is what you clone and run.
- **[`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing)** is the development floor: tests, benchmarks, verification tooling, design and decision records. It is where claims are checked and where development happens.

The product branch is computed from the development branch by the promotion tooling, not hand-edited. Keeping the test inventory and history out of the product tree keeps the shipped tree smaller and makes the provenance of a change inspectable. It also means a fresh clone of the product does **not** contain the full prevention suite.

## What happens to my files? Can it delete them?

Tools operate inside the selected project. File effects go through the transactional editor and are recorded; edits can be rolled back. `execute_command` runs with the project as its confinement root on Linux. Deleting a project from the harness removes it from the harness database only — it does not delete files from disk.

Committing is a human action. `git_commit` is exposed but returns a governance blocker; the other git tools are read-only. That is deliberate: an agent that can rewrite history is a different risk class.

That does not make the preview safe. A shell command can still do damage inside the project, the editor can overwrite content, and there is no data-loss guarantee. Use a disposable copy, keep a clean git state, and do not rely on undo as a backup.

## Is there a hosted demo or cloud version?

No. There is no hosted demo, no SaaS account, and no cloud execution. You run the server on your machine and bring your own provider. The project is local-first by design, not as a temporary packaging gap.

## Does it work on Windows or macOS?

The cockpit and server are Node and Svelte and can run on those platforms, but the OS-level confinement path is **Linux-only**. Landlock is a Linux feature. WSL2 may work depending on the host kernel and Landlock ABI; when the feature is unavailable, the guardian fails closed with a typed error rather than running unprotected.

Do not assume parity with Linux. Native Linux is the supported path for the confinement story today.

## Is the timeline an audit log?

It is an **application record**: append-only at the application layer, ordered, queryable, and locally hash-chained. It is not a signed, externally anchored, tamper-evident compliance log. Someone who can write the database can rewrite the chain, and a removed suffix may not be detectable locally. Do not use it as your organization's audit system.

Security reports belong in a private channel, not a public issue. See [Security and limits]({{ '/security/' | relative_url }}) for the private reporting channel, scope, and what to include. There is no bug bounty and no response-time guarantee.
