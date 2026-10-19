---
layout: default
title: "Known issues and current gaps"
description: "The honest gap register for the Bridlewise developer preview: pre-admission, missing audit, unpublished corpus, dependency queues, Linux-only confinement, and more."
permalink: /known-issues/
---

# Known issues and current gaps

This is a gap register, not a roadmap promise. Every item below is known, stated with its impact and the mitigation that exists today. Statuses describe the snapshot, not a commitment to a date.

> **The short version:** Bridlewise is pre-admission, unaudited, Linux-first for confinement, and not safe for sensitive code. The gaps are real. Read them before you run anything.

| Gap | Impact | Status |
|---|---|---|
| [Pre-admission](#1-pre-admission) | The readiness receipt says no; interactive capabilities are denied by the root policy | Open, by design for the preview |
| [No security audit](#2-no-security-audit) | No independent assurance; unknown vulnerabilities may remain | Open |
| [Full corpus not published](#3-full-corpus-not-published) | The complete engine suite is not reproducible from a fresh clone | By design for now |
| [Dependency alerts can return](#4-dependency-alerts-can-return) | New advisories can reopen the queue at any time | Closed for the current lockfiles |
| [CodeQL findings](#5-codeql-findings) | Static-analysis findings need review; test-only and false positives must not hide a real one | Closed for the current analysis |
| [Linux-only confinement](#6-linux-only-confinement) | No OS-level filesystem boundary on macOS or Windows | By design |
| [Provider coverage](#7-provider-coverage) | Only OpenAI-style protocols are verified; native Anthropic and Gemini adapters are not | Partial |
| [No signed releases](#8-no-signed-releases) | Checksums and provenance help, but no OS-signed installer or independent audit | Partial |
| [Social preview is manual](#9-social-preview-is-manual) | The repository card can drift from the current UI | Partial |
| [No hosted demo](#10-no-hosted-demo) | Evaluation requires a clone, Node 24, and a provider | By design |

## 1. Pre-admission

**What it is.** The engine's governance gate has not admitted the interactive capabilities. `preflight` reports `harnessReady: false`, and the receipt denies model invocation, repository mutation, process execution, and network egress. The web harness runs as a developer preview around that gate.

**Impact.** The project cannot claim readiness, and some capabilities are implemented but not admitted. A successful install does not mean a safe or complete product. The warning is not boilerplate.

**Mitigation.** Run the receipt yourself:

```bash
./bin/bridlewise.mjs preflight
```

Read the capability decisions, not just the boolean. Use a disposable copy. Treat the preview as an inspection environment.

**Status:** Open, by design for the preview. See [CLI reference]({{ '/cli/' | relative_url }}#preflight) and [Architecture]({{ '/architecture/' | relative_url }}#pre-admission).

## 2. No security audit

**What it is.** There has been no third-party security review, penetration test, threat-model review, or certification of auth, encryption, redaction, Landlock policy, or the tool surface.

**Impact.** The controls may have bugs. The threat model may miss an actor. There is no external assurance to point at, and no compliance posture (SOC 2, ISO 27001, HIPAA, GDPR program).

**Mitigation.** The [security page]({{ '/security/' | relative_url }}) states the assets, actors, controls, and non-protections. Secret scanning, CodeQL, dependency review, and the guardian tests exist, but none is an audit. Do not use the preview with proprietary, regulated, client-confidential, or production code.

**Status:** Open. No audit is scheduled or promised.

## 3. Full corpus not published

**What it is.** The full engine suite depends on a 4.1 GB external corpus at `engine/large-codebases`. The corpus and the performance report are deliberately not published. The runners refuse with a named prerequisite rather than silently skipping.

**Impact.** A fresh clone of the product or the testing floor cannot reproduce the complete engine inventory. Coverage claims are limited to what the public smoke suites and CI actually run. Large-repository behavior is not publicly reproducible.

**Mitigation.** The public smoke suites, the guardian tests, and the CI gate are reproducible. The testing floor documents every prerequisite. If you need the full suite, you need the corpus and the report; the project does not pretend otherwise.

**Status:** By design for now. See [Testing]({{ '/testing/' | relative_url }}#development-floor-setup) and the [testing floor](https://github.com/LLM-4-People/bridlewise-testing).

## 4. Dependency alerts can return

**What it is.** At the 2026-10-19 snapshot, the product repository had 21 open Dependabot alerts, mostly transitive or development dependencies. The lockfiles were then updated: `npm audit` reports **0 vulnerabilities** in the root and engine trees, and the production-only audit is clean. The engine's former `@xenova/transformers` tree was moved to an optional peer so its vulnerable `sharp`/`protobufjs` chain is not installed by default. Dependabot's queue may lag until its next scan.

**Impact.** A vulnerable version can remain in a lockfile or a cached install. An alert is not proof of an exploitable path, and a clean audit is not proof that no exploit exists. Dependency review fails pull requests on high-severity changes; it does not replace review.

**Mitigation.** Re-run `npm audit` and `npm --prefix engine audit` after installing. Inspect the [Dependabot queue](https://github.com/LLM-4-People/bridlewise/security). Do not deploy the preview. If you build on it, update and test the dependency yourself, and record what you changed.

**Status:** Closed for the current lockfiles. The product repository's Dependabot queue reports **0 open alerts**, and every audit tree reports 0 vulnerabilities. New advisories can reopen the queue; this is not a permanent clean bill.

## 5. CodeQL findings

**What it is.** CodeQL analysis runs and uploads results. At the 2026-10-19 snapshot, the product repository had 15 open security-query alerts plus 29 OpenSSF Scorecard checks in the same queue. The code was then changed: unknown server errors no longer expose arbitrary messages, HTML script-tag parsing is case-insensitive, and action references and token permissions were hardened. Test-only, benchmark, and documented-limitation findings were dismissed with path-specific reasons. The reviewed script-tag false positive also carries an inline suppression with the reason in the source.

**Impact.** A dismissed finding is not a fixed finding unless the comment says so. A green CodeQL workflow proves the analyzer ran, not that the code is clean. The preview does not claim a clean scan.

**Mitigation.** Use the [Security tab](https://github.com/LLM-4-People/bridlewise/security), sort by severity, and read the path and query. Treat the queue as a finding list, not a score. The [evidence page]({{ '/evidence/' | relative_url }}#codeql) gives the inspection command.

**Status:** Closed for the current analysis. The security-query queue reports **0 open alerts**; test-only, benchmark, and false-positive findings are dismissed with path-specific reasons. Re-run CodeQL for a fresh receipt; a dismissal is not a fix, and a new commit can introduce a new finding.

## 6. Linux-only confinement

**What it is.** Landlock is a Linux kernel feature. The guardian confines server-spawned shell commands and stdio MCP servers to the selected project on Linux. macOS and Windows do not get this boundary. WSL2 depends on the host kernel and Landlock ABI; when the feature is unavailable, the guardian fails closed rather than running unrestricted.

**Impact.** The cockpit and server can run on other platforms, but the OS-level confinement story does not travel with them. Native Linux is the supported path for confinement today. A container or Codespace may or may not expose the kernel path.

**Mitigation.** Run on native Linux with a kernel that exposes Landlock. Keep the project disposable. Do not assume a non-Linux host is confined because the UI loaded. Read [Landlock: what it does and does not do]({{ '/security/' | relative_url }}#landlock-what-it-does-and-does-not-do).

**Status:** By design. Cross-platform confinement is research, not a shipped feature.

## 7. Provider coverage

**What it is.** Providers must speak the OpenAI Responses or Chat Completions protocols, configured with a base URL, API key, and model ids. Anthropic-native and Gemini-native APIs are not verified adapters here. A provider may advertise OpenAI compatibility and still differ at the edges.

**Impact.** A provider that works in another tool may fail here, or behave differently on tool calls, streaming, and limits. There is no bundled provider, default key, or fallback.

**Mitigation.** Test the endpoint with a disposable project. Use the typed refusals (`provider_not_configured`, `model_not_chosen`, `provider_key_missing`) as diagnostics. If you add an adapter, follow [Building on the harness]({{ '/extending/' | relative_url }}#add-a-provider) and bring compatibility evidence.

**Status:** Partial. The OpenAI-style path is exercised; native adapters are not verified.

## 8. No signed releases

**What it is.** `v0.0.1-preview` carried no signature, SBOM, or provenance attestation. From `v0.0.2-preview`, the product release workflow publishes SPDX SBOMs and a GitHub build-provenance attestation, but there is still no OS-signed installer, no maintainer signing key, and no independent reproduction of the build.

**Impact.** `SHA256SUMS` proves the downloaded bytes match the published list. A provenance attestation says which workflow and commit produced the asset under GitHub's OIDC identity; it does not prove the source is correct, the build is reproducible, or the maintainer account was uncompromised. A tag ruleset reduces accidental or forced tag movement but is not a signature.

**Mitigation.** Build from source and compare what you run. For `v0.0.2-preview`, all five checksummed assets passed `sha256sum -c`, the release is marked prerelease with six assets, and `gh attestation verify` exited `0` for the source archive. Review the commit and the workflow. Do not treat the release as a deployment artifact.

**Status:** Partial. Provenance and SBOM are added for new releases; OS signing and independent audit remain absent. See [Shipping and releases]({{ '/shipping/' | relative_url }}) and [Evidence]({{ '/evidence/' | relative_url }}#5-the-release).

## 9. Social preview is manual

**What it is.** [`docs/assets/social-preview.png`](https://github.com/LLM-4-People/bridlewise/blob/main/docs/assets/social-preview.png) exists, and the docs layout uses it as the default social image. The GitHub repository social preview is set in repository settings, not by a workflow. There is no automated check that it matches the current cockpit.

**Impact.** The card shown when the repository is shared can drift from the current UI. A stale preview is a small credibility leak, not a security issue.

**Mitigation.** Recapture the social preview when a cockpit surface changes materially, and upload it in repository settings. The [design page]({{ '/design/' | relative_url }}#captures) documents the capture surfaces. This remains a manual step.

**Status:** Partial. The asset exists; the update path is manual.

## 10. No hosted demo

**What it is.** There is no hosted demo, SaaS account, cloud execution, or one-click trial. Running Bridlewise requires a clone, Node `>=24.18 <25`, both dependency installs, and a model provider you configure.

**Impact.** Evaluation has friction. A visitor cannot click a link and see a live run against a real repository. The [interactive run]({{ '/run/' | relative_url }}) and [policy lab]({{ '/policy-lab/' | relative_url }}) are illustrations, not a hosted harness.

**Mitigation.** Follow the [Quickstart]({{ '/quickstart/' | relative_url }}), use a disposable project, and try fixture mode to exercise the interface without a live model call. The snapshot includes a [devcontainer for a disposable workspace]({{ '/codespaces/' | relative_url }}); it is not a hosted service and does not replace the security boundary.

**Status:** By design. A hosted demo would require a security model the preview does not have.

## Tracked work

The public queue is part of the record. These issues are scoped, labeled, and open for contribution:

- [Document every typed refusal with a reproduction](https://github.com/LLM-4-People/bridlewise/issues/10) — the refusal surface needs a single table.
- [Add anchor and external-link checks to the docs gate](https://github.com/LLM-4-People/bridlewise/issues/11) — the current checker resolves files, not headings.
- [Add a Chat Completions conformance fixture](https://github.com/LLM-4-People/bridlewise/issues/12) — provider coverage is narrow.
- [Triage the dependency alerts and record each disposition](https://github.com/LLM-4-People/bridlewise/issues/13) — audited trees are clean; the queue needs a durable account.
- [Restore or explicitly refuse the missing inventory-test-run fixture](https://github.com/LLM-4-People/bridlewise-testing/issues/9) — a public test should not fail with `ERR_MODULE_NOT_FOUND`.
- [Give the docs link checker a failure fixture](https://github.com/LLM-4-People/bridlewise-testing/issues/10) — a gate that has never failed is not evidence.

An issue is a finding with an owner-shaped next step, not a promise. The [milestone](https://github.com/LLM-4-People/bridlewise/milestone/1) is `v0.0.2-preview`.

## What is not on this list

This register does not include private vulnerability reports, undisclosed findings, or every item on the [roadmap]({{ '/roadmap/' | relative_url }}). It is not a complete threat model; that is the [security page]({{ '/security/' | relative_url }}). It is not a promise to fix anything by a date.

If you find a gap that is not here, open a reproducible issue with the revision, environment, command, and typed error — after removing secrets and private code. Use the [issue list](https://github.com/LLM-4-People/bridlewise/issues) and the [bug template](https://github.com/LLM-4-People/bridlewise/issues/new/choose). Security reports belong in the private channel described in [SECURITY.md](https://github.com/LLM-4-People/bridlewise/blob/main/SECURITY.md), not in a public issue.

The honest summary: the machinery is real, the record is real, and the assurance is incomplete. Treat the preview accordingly.
