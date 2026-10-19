---
layout: default
title: "Glossary"
description: "The working vocabulary of Bridlewise: runs, beats, causal edges, admissions, guardians, floors, projections, and evidence."
permalink: /glossary/
---

# Glossary

Bridlewise uses ordinary words for specific things. This page keeps the meanings sharp so a claim can be read precisely. Where a term has a cheaper synonym, the cheaper synonym is usually hiding a distinction.

## The run

The run is the unit of work. Everything else is either a part of it, a boundary around it, or a record of it.

| Term | Definition |
|---|---|
| **Run** | One executable unit of work with an owner, a stream, a claim, and a record. A run executes once. Reopening its stream attaches to the recorded execution; it does not start a second one. |
| **Beat** | One typed, ordered record in a run's stream: a model turn, tool call, file effect, check, finding, or decision. The beat is the smallest thing the cockpit renders and the smallest thing the ledger keeps. |
| **Causal edge** | The recorded relation between a beat and the beat it caused: tool input to output, edit to diff, check to delta, detection to response. The edge is why the stream is a record rather than a log. |
| **Tool call** | A model's request to invoke a registered tool with typed arguments. It is a proposal until the pre-dispatch gate admits it and the executor runs it. |
| **File effect** | A recorded change to the project's filesystem: create, update, or delete, with the target and a reviewable diff. File effects go through the transactional editor and can be rolled back. |
| **Check delta** | The before-and-after state of a check, not just its final result. A check that did not move is still evidence; a delta without its prior state is a rumor. |
| **Finding** | A recorded observation that something is wrong, suspicious, or worth attention, with its source and derivation. A finding is not a decision; it is an input to one. |
| **Receipt** | The JSON document returned by `preflight`: config hashes, capability decisions, and the readiness stage. A receipt records integrity. It is not a certificate of readiness. |
| **Provenance** | The chain from a claim to the artifact that supports it and the command that reproduces it. Provenance is a path, not a badge. |

## The boundary

The boundary is where the harness decides what may happen. A refusal is a first-class result, not an error to be smoothed over.

| Term | Definition |
|---|---|
| **Refusal** | A typed “no” returned before an effect. A refusal names the missing capability, failed gate, or unsafe condition. It is not an empty success and not a silent fallback. |
| **Typed blocker** | A refusal with a stable code and a stated remedy, such as `provider_not_configured` or the deliberate `git_commit` governance blocker. The type is part of the contract. |
| **Admission** | The governance act that moves a capability from “implemented” to “allowed,” on evidence. The preview's interactive capabilities are pre-admission: implemented, exercised, and still denied by the root policy. |
| **Preflight** | The read-only integrity check that prints the receipt. It verifies configuration, hashes, and capability decisions. It does not run a model or touch a repository. |
| **`harnessReady`** | The top-level readiness boolean in the preflight receipt. It is `false` in the developer preview. A healthy integrity check and a ready product are different claims. |
| **Safety floor** | The non-configurable part of the root policy that configuration cannot lower: keep-out paths, the minimum allow-set, and invariants a confined process must respect. A process's temporary root must lie outside it. |
| **Guardian** | The frozen C binary that applies a Linux Landlock ruleset to itself and then `exec`s the payload. The restriction is inherited and irrevocable. The guardian confines filesystem access; it is not a VM or a firewall. |
| **Landlock** | A Linux kernel security module that restricts a process's filesystem access with a ruleset. It is Linux-only, path-based, and not a network, syscall, or user-namespace boundary. |
| **Capability decision** | The `allow` or `deny` recorded for one capability in the preflight receipt. In the preview, `preflight` is allowed; model invocation, repository mutation, process execution, and network egress are denied. |

## The record

The record is what remains after the process exits. It has owners, limits, and a redaction policy.

| Term | Definition |
|---|---|
| **Timeline** | The ordered, append-only record of typed events for a run, with a local hash chain per record. It is the application's record, not a signed, externally anchored compliance log. |
| **Ledger** | The durable store and query surface behind the timeline: the local database, `harness timeline`, and `scripts/trace.ts`. The ledger keeps what happened; the chat is one projection of it. |
| **Redaction** | The single adapter that removes recognized secrets and personal data before content leaves for a provider and before it is displayed. It is pattern- and classification-based risk reduction, not a data-loss-prevention product. |
| **Provider adapter** | The boundary that speaks a model provider's protocol — here, OpenAI Responses or Chat Completions — with a configured base URL, key, and model ids. An unconfigured adapter refuses; it does not fall back to a bundled provider. |
| **MCP** | Model Context Protocol: a way to attach external tools and resources over stdio, Streamable HTTP, or WebSocket. An MCP server is third-party code; stdio servers can be placed under the guardian, but the server's own behavior is not audited by this project. |
| **Frozen record** | A record under a frozen root whose bytes are pinned by a manifest. History is exempt from link and regeneration judgment; a deliberate change is accepted explicitly, with a reason. |

## The floor

The development floor is where the product is tested, measured, decided, and projected. It is public, but it is not a second product.

| Term | Definition |
|---|---|
| **Harness** | The whole local system: cockpit, loopback server, engine, guardian, shared contracts, and the record they produce. “Harness” is not a synonym for “model” or “chat.” |
| **Block** | One server capability declaration that projects its route, input schema, client binding, and UI contract. One declaration, one owner; the projections follow. |
| **Development floor** | The [`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing) repository: the prevention suite, unit and integration tests, benchmarks, curated design records, and the decision log. It is where claims are checked before they are promoted. |
| **Corpus** | The external 4.1 GB `engine/large-codebases` fixture root used by the full engine suite. It is not published. A fresh clone cannot reproduce the corpus-backed suite. |
| **Decision record** | One file per decision, with an id, status, implementation state, and a generated index. A decision record is the durable answer to “why is it like this?” — not a meeting note. |
| **Projection** | A surface derived from one declaration or source: a route, schema, client binding, or UI from a block; the public product tree from the development floor. A projection is not a second owner of the fact. |
| **Promotion** | The gate that builds a candidate product tree from the development floor, runs the checks, commits the exact tree, and fast-forwards `main`. It is maintainer tooling, not a public release process. |
| **Preview** | A developer preview: runnable, inspectable, and explicitly not production-ready. The preview makes no compatibility, support, or safety promise beyond what its evidence shows. |
| **Evidence** | An artifact or observation someone else can inspect or rerun: a CI log, a checksum, a test receipt, a code-scanning alert, a recorded run. A claim without evidence is a hypothesis. |
| **Workspace** | An isolated worktree created by `harness workspace` for a bounded change, with its own gates and merge path. A Codespace is a development environment, not a harness workspace. |

## A note on usage

Use **run** for the unit, **beat** for the part, **record** for the whole, and **evidence** for the part someone else can check. Avoid “session” when you mean run, “log” when you mean ledger, and “sandbox” when you mean Landlock. The distinctions are the product.

The [reading map]({{ '/reading-map/' | relative_url }}) puts these terms in order. The [GitHub map]({{ '/github/' | relative_url }}) shows where the record leaves a trace. The [evidence page]({{ '/evidence/' | relative_url }}) shows how to check it.
