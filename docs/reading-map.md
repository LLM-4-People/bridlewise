---
layout: default
title: "Choose your own audit"
description: "Five ways into Bridlewise, from ninety seconds to a security review, with what each path should let you conclude."
permalink: /reading-map/
---

# Choose your own audit

Not every visitor needs the same depth. Pick a path, follow four to six links, and leave with a conclusion you can defend. None of these paths is a substitute for an independent audit; they are ways to read the record honestly.

| Path | Time | Best for |
|---|---|---|
| The shape | 90 seconds | Deciding whether to keep reading |
| The claims | 10 minutes | Checking whether the project's evidence matches its words |
| The machinery | An afternoon | Understanding how a run actually works |
| The boundary | A security review | Evaluating the threat model and the gaps |
| The change | A contribution | Sending work that can land |

## 90 seconds: the shape

1. [The landing page]({{ '/' | relative_url }}) — the warning, the cockpit, and the run-record idea in one screen.
2. [The interactive run]({{ '/run/' | relative_url }}) — a synthetic record of a run, not a live model call.
3. [Security and limits]({{ '/security/' | relative_url }}) — the short version, including what is not protected.
4. [The preview release](https://github.com/LLM-4-People/bridlewise/releases/tag/v0.0.3-preview) — what actually ships: source, cockpit, engine bundle, checksums, no installer.

**You should conclude:** this is a local-first coding cockpit that records a run as a causal stream; it is a developer preview, pre-admission, unaudited, and not for sensitive code. The release is an inspection artifact, not a deployment.

## 10 minutes: the claims

1. [The README](https://github.com/LLM-4-People/bridlewise#readme) — the 90-second tour, the eight beats, and the warning.
2. [The repository is a run record]({{ '/github/' | relative_url }}) — how GitHub surfaces map to intent, boundary, tool, effect, check, finding, decision, and release.
3. [Evidence, not vibes]({{ '/evidence/' | relative_url }}) — the commands and the expected output.
4. [The latest CI run](https://github.com/LLM-4-People/bridlewise/actions/workflows/ci.yml) — job name, conclusion, steps.
5. [Code scanning (Security tab)](https://github.com/LLM-4-People/bridlewise/security) — what is open, not just what is green.
6. [Known issues]({{ '/known-issues/' | relative_url }}) — the gaps the badges do not show.

**You should conclude:** the project publishes checks that can be rerun, and it also publishes the places where those checks do not settle the question. The evidence is real; the assurance is not complete.

## An afternoon: the machinery

1. [Architecture]({{ '/architecture/' | relative_url }}) — cockpit, loopback server, engine, guardian, shared contracts, and the life of a run.
2. [Quickstart]({{ '/quickstart/' | relative_url }}) — install, first account, provider, project, first run.
3. [CLI reference]({{ '/cli/' | relative_url }}) — `preflight`, the 22 `harness` verbs, the lifecycle scripts, and the ledger tools.
4. [The policy lab]({{ '/policy-lab/' | relative_url }}) — an illustrative governance console, not a live policy engine.
5. [Testing]({{ '/testing/' | relative_url }}) — the public smoke suite, the development floor, and the corpus prerequisites.
6. [Decision records](https://github.com/LLM-4-People/bridlewise/tree/main/docs/decisions) — the durable “why” behind the rules, one file per decision.

**You should conclude:** a run is claimed once, recorded as typed beats, and projected into a chat and a cockpit; tool calls pass through one registry and executor; the guardian confines filesystem access on Linux; the full test floor is in a second repository and is not reproducible from a fresh product clone.

## A security review: the boundary

1. [Security and limits]({{ '/security/' | relative_url }}) — assets, actors, controls, and the explicit non-protections.
2. [SECURITY.md](https://github.com/LLM-4-People/bridlewise/blob/main/SECURITY.md) — reporting, scope, and the one-page model.
3. [Code scanning (Security tab)](https://github.com/LLM-4-People/bridlewise/security) — CodeQL and Scorecard alerts, including the open ones.
4. [Dependabot (Security tab)](https://github.com/LLM-4-People/bridlewise/security) — the dependency alert queue and its triage state.
5. [Scorecard](https://scorecard.dev/viewer/?uri=github.com/LLM-4-People/bridlewise) — the heuristic score and the checks behind it.
6. [The guardian tests](https://github.com/LLM-4-People/bridlewise/tree/main/engine/guardian/tests) — what the Landlock suite does and does not exercise.

**You should conclude:** the local user is inside the trust boundary; redaction reduces accidental egress but is not DLP; Landlock is filesystem-only and Linux-only; the timeline is a local application record, not a signed audit log; no third-party audit exists; open static-analysis and dependency alerts remain. If your review needs a signed artifact or a compliance story, this preview does not have one.

## A contribution: the change

1. [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md) — setup, checks, and the evidence bar.
2. [The development floor](https://github.com/LLM-4-People/bridlewise-testing) — where the larger suites, benchmarks, and decisions live.
3. [Testing]({{ '/testing/' | relative_url }}) — how to add a test at the right layer and why a skip is not a pass.
4. [Building on the harness]({{ '/extending/' | relative_url }}) — blocks, tools, providers, MCP servers, embedding, quality packs.
5. [Decision records](https://github.com/LLM-4-People/bridlewise-testing/tree/main/docs/decisions) — cite the rule, do not restate it in a scratch plan.
6. [Issues](https://github.com/LLM-4-People/bridlewise/issues) and [Discussions](https://github.com/LLM-4-People/bridlewise/discussions) — a reproducible finding or a question.

**You should conclude:** development lands on the testing floor with its tests and evidence, then travels through promotion. A direct edit to the product branch is not the path. A useful contribution is narrow, reproducible, and honest about what it could not verify.

## If you only read one thing

Read [Security and limits]({{ '/security/' | relative_url }}).

It is the page that states the assets, the actors, the controls that exist, and the protections that do not. It tells you the local user is inside the boundary, the provider receives the prompt, Landlock is not a sandbox in the general sense, and the timeline is not an audit log. If that page is acceptable for your use, the rest of the documentation is a way to inspect the machinery. If it is not, no amount of green CI should change your mind.

The second-best single link is [Evidence, not vibes]({{ '/evidence/' | relative_url }}): it turns the claims into commands and says what the commands still do not prove.
