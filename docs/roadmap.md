---
layout: default
title: "Roadmap and status"
description: "Bridlewise's honest developer-preview status, known gaps, and near-term themes — without release dates or production promises."
permalink: /roadmap/
---

# Roadmap and status

Bridlewise is an **experimental developer preview**. This page is a status report, not a release schedule. Items below may change, slip, or be removed. There are no dates, no compatibility promises, and no claim that any theme will produce a production-ready product.

## At a glance

| Dimension | Current state |
|---|---|
| Version | `0.1.0` pre-release; no stable release |
| Engine readiness | **Pre-admission**. `preflight` reports `harnessReady: false`; interactive capabilities are `deny` until the governance gate admits them |
| Distribution | Source and unsigned preview artifacts; no installers, signed binaries, or signed tags |
| Hosted service | None; the server is a local loopback process |
| Platform | Linux first; Landlock confinement is Linux-only. WSL2 depends on the host kernel |
| Security review | **None**. No audit, no penetration test, no certification |
| Data durability | No guarantee. Breaking changes and data loss are expected |
| License | AGPL-3.0 |
| Tests | The product tree exposes type checks; the prevention suite, benchmarks, and verification tooling live in `bridlewise-testing` |

## What works today

These are implemented in the product tree. "Works" means the path exists and is exercised; it does not mean it is safe for your code.

- Local account setup, sign-in, sessions, CSRF, and rate limiting.
- Provider configuration (OpenAI Responses or Chat Completions style), model selection, and per-model limits.
- A run that executes once, streams over SSE, persists, and can be reopened without starting a second execution.
- Tool dispatch through one registry and one executor: file reads, search, intelligence, memory, quality, read-only git, research adapters, delegated agents, and a confined shell.
- Typed refusals for unconfigured adapters and blocked actions, including the deliberate `git_commit` blocker.
- Pre-dispatch hallucination checks and streaming runtime detectors.
- Code intelligence backed by tree-sitter: maps, symbols, dependency graphs, data flow, reuse discovery, and slices.
- The transactional `edit` tool with diffs and rollback.
- Memory recall and tool-result retrieval across runs and chats.
- An append-only timeline with rewind and replay surfaces.
- A local SQLite database with encrypted sensitive fields, and a key home outside the checkout.
- A Linux Landlock guardian path that fails closed when unavailable.
- A cockpit with the FLOW, SWEEP, DESK, HORIZON, and summoned rooms, plus a light logbook theme.
- A fixture mode for exercising the interface without live model calls.

## Known gaps

These are the gaps we know about. The list is not exhaustive, and a gap being listed does not mean it is being worked on now.

### Readiness and assurance

- **Pre-admission.** The engine's governance gate has not admitted the interactive capabilities. The evidence trail is still being assembled; the preflight receipt is integrity-only.
- **No security audit.** No independent review of auth, encryption, redaction, Landlock policy, or the tool surface.
- **No signed releases or provenance.** The preview release assets are unsigned. There is no artifact signing, reproducible-build attestation, or release verification beyond `SHA256SUMS`.
- **No compliance posture.** No SOC 2, ISO 27001, HIPAA, GDPR program, or data-processing agreement. The timeline is not a compliance audit log.
- **No published performance envelope.** The cockpit is designed for responsiveness, but there is no public benchmark suite in the product repository proving behavior at large repositories or many concurrent runs.

### Platform and distribution

- **Linux-only confinement.** macOS and Windows do not get Landlock. WSL2 support depends on the host kernel and Landlock ABI; when unavailable, the guardian refuses to run rather than degrading silently.
- **No hosted demo.** Running it requires a clone, Node 24, dependencies, and a provider.
- **No installer or package.** No Homebrew formula, container image, desktop bundle, or signed binary.
- **No supported remote deployment.** There is no TLS, SSO, reverse-proxy guide, or multi-tenant hardening. Do not expose it.
- **Node 24 pin.** The runtime range is `>=24.18.0 <25.0.0`. Older Node versions are not supported; newer major versions are not verified.

### Setup and product surface

- **Incomplete provider setup UX.** The settings room supports a generic provider with a base URL, key, models, and optional limits, but there is no guided OAuth flow, no provider-specific presets, and no universal compatibility claim. Anthropic-native and Gemini-native APIs are not verified.
- **No migration guarantee.** Database schemas and configuration can change between previews. Back up the key home and the database; do not treat either as durable.
- **No complete fresh-clone test reproduction.** The prevention suite, benchmarks, and verification fixtures live in the testing repository. A fresh clone of the product repository does not reproduce the full inventory.
- **Documentation and captures are in progress.** The current site uses real captures of the preview; recapture them when a surface changes materially.
- **Accessibility and responsive behavior are tested in the cockpit's own suite, not certified.** The design targets 40px pointer targets, keyboard reachability, reduced motion, and enlarged text; the docs site is a separate static surface with its own checks.
- **No backup/restore product flow.** The database-key tooling supports relocation and re-keying, but there is no one-command backup, restore, or disaster-recovery story.
- **No hard multi-user story.** Accounts and scoping exist; isolation between mutually distrusting users has not been audited.
- **No automatic commits.** This is deliberate, not a missing feature. The model can read git state and produce diffs; committing remains a human action.

## Near-term themes

Themes, not commitments. No dates. An item may be dropped if the evidence does not support it.

1. **Admission evidence.** Close the gap between "implemented" and "admitted": make each capability's gate decision, evidence, and remedy inspectable from the product.
2. **Onboarding without a manual.** A first-run path that gets a disposable project, a provider, and a first recorded run working without reading the source.
3. **Packaging and verification.** A reproducible build, a checksummed source archive, and a release process that states exactly what was verified. Signing only after there is something worth signing.
4. **Confinement beyond Linux.** Research portability for macOS and Windows, or state clearly that the product is Linux-only for the confinement path. Do not fake a sandbox.
5. **Test reproducibility.** A documented, fresh-clone path to the full prevention suite and benchmarks, with the fixtures and corpus requirements stated up front.
6. **Backup and recovery.** A supported way to back up the database and key home together, verify the backup, and restore it without guessing.
7. **Provider coverage.** Better discovery, clearer failure copy, and verified adapters where the protocol actually matches. No "supports everything" claim.
8. **Scale and performance evidence.** Publish the method and the measured envelope for large repositories and concurrent runs, or state the limits honestly.
9. **Documentation and design records.** Keep the captures current; keep the design and decision records linked to the product.
10. **Accessibility and ergonomics.** Continue the cockpit's keyboard, target-size, contrast, and reduced-motion work, and test the docs site with the same seriousness.

## What we will not promise

- A release date.
- That the preview is safe for sensitive code.
- That a future version will be "production-ready" on a schedule.
- A benchmark number that has not been measured and published with its method.
- That the product replaces your IDE, your code review, or your judgment.

## How to follow or help

- Read the [testing floor](https://github.com/LLM-4-People/bridlewise-testing) for the prevention suite, benchmarks, design records, and decision log.
- Open a reproducible issue with the exact command, typed error, and run id. Redact secrets and private code.
- Read [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md) before sending a change.
- Report vulnerabilities privately, not in a public issue. See [Security and limits]({{ '/security/' | relative_url }}).

The honest summary: the machinery is real, the record is real, and the readiness is not. Treat it accordingly.
