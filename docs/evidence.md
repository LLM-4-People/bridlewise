---
layout: default
title: "Evidence, not vibes"
description: "What a visitor can verify about Bridlewise: CI runs, smoke tests, guardian checks, code scanning, release checksums, and the limits of each."
permalink: /evidence/
---

# Evidence, not vibes

A claim is a hypothesis until someone can rerun the check. This page lists the checks a visitor can perform without trusting the prose, the command that performs each one, and the part it still does not prove.

All observations below are from the **2026-10-19** public snapshot. Counts and alert queues move; the commands do not.

## The evidence ladder

| Claim | Artifact | Status at snapshot |
|---|---|---|
| The product gate is green | [CI workflow](https://github.com/LLM-4-People/bridlewise/actions/workflows/ci.yml) | Verified: latest run `success` |
| The development floor gate is green | [Testing CI](https://github.com/LLM-4-People/bridlewise-testing/actions/workflows/ci.yml) | Verified: latest run `success` |
| Product smoke tests pass | `npm run test:public` | Verified: 11/11 |
| Development-floor smoke tests pass | `npm run test:public` in `bridlewise-testing` | Verified: 13/13 |
| Guardian checks pass | `make -C engine/guardian all test` | Verified: 40/40 in CI; 44/44 where the mount-namespace checks run |
| CodeQL analysis runs | [CodeQL workflow](https://github.com/LLM-4-People/bridlewise/actions/workflows/codeql.yml) | Verified: latest run `success` |
| CodeQL is clean | [Security tab](https://github.com/LLM-4-People/bridlewise/security) | **Not claimed**: 0 open security-query alerts; test-only and false positives are dismissed with reasons, and a dismissal is not a fix |
| The secret scanner passes | `npm run check:secrets` | Verified: `secret scan: clean` |
| The audited dependency trees are clean | `npm audit` in the root and engine | Verified: 0 vulnerabilities at the lockfile snapshot |
| Scorecard runs | [Scorecard](https://github.com/LLM-4-People/bridlewise/actions/workflows/scorecard.yml) | Verified: score 4.4; heuristic, with a failed branch-protection check |
| Release assets match their checksums | [v0.0.2-preview](https://github.com/LLM-4-People/bridlewise/releases/tag/v0.0.2-preview) | Verified with `sha256sum -c` |
| Releases are signed | — | **Not present** |
| The docs site deploys | [Pages](https://llm-4-people.github.io/bridlewise/) | Verified: HTTP 200 |
| Relative docs links resolve | `npm run docs:links` | Verified: `docs links: clean` |
| The full corpus is reproducible | — | **Not published**: 4.1 GB external fixture root |
| Independent security audit | — | **Not present** |

## 1. The CI gate

The product job is **Build and verify**; the development-floor job is **Typecheck, public tests, build**. Both repositories also run **Secret and privacy scan** as a separate workflow.

```bash
gh run list \
  --repo LLM-4-People/bridlewise \
  --workflow ci.yml \
  --limit 1 \
  --json conclusion,headSha,url
```

Expected shape at the snapshot:

```json
[{"conclusion":"success","headSha":"215b7e6815f0c614f9331ccbe4cc35e4ab0eeb4a","url":"https://github.com/LLM-4-People/bridlewise/actions/runs/39336317698"}]
```

Read the jobs, not only the run:

```bash
run_id=$(gh run list \
  --repo LLM-4-People/bridlewise \
  --workflow ci.yml \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')

gh run view "$run_id" \
  --repo LLM-4-People/bridlewise \
  --json jobs \
  --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

Expected:

```text
Build and verify: success
```

For the development floor, the expected job line is:

```text
Typecheck, public tests, build: success
```

The product job runs typechecks, the public-snapshot secret scan, the public smoke suite, both builds, and the guardian build and tests. The testing job adds the tracked hooks, the larger typecheck surface, and the same build and guardian steps. Neither job runs the full corpus-backed suite.

## 2. The public smoke suites

Product repository:

```bash
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
npm run test:public
```

Expected:

```text
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

Development floor:

```bash
git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
npm run test:public
```

Expected:

```text
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

The product suite verifies the launcher, the version output, the typed `harness` refusal, the `preflight` receipt (`harnessReady: false`), the secret scanner's pass and fail paths, the safety warning in the README, the shipped docs, and the community files. The testing suite adds engine smoke checks for canonical JSON and redaction.

These are smoke tests. They do not exercise a live provider, a full run, the cockpit, or the large-repository path.

## 3. The guardian

```bash
make -C engine/guardian all
make -C engine/guardian test
```

Expected on the published CI runner:

```text
PASS 40/40
ALL TESTS PASS
```

The suite reports **40/40** when the host cannot create a private mount namespace. Tests 35 and 36 — the bind-mount alias attacks — are skipped in that case, and the script says so. A host that can run `unshare -rm` adds four assertions from those two tests and reports **PASS 44/44**. Do not turn either number into “all kernel paths pass”: an exit code of 3 (`landlock_unavailable`) is a skip, not a pass.

The guardian confines filesystem access on Linux. It is not a VM, a network firewall, a seccomp profile, or a user-namespace boundary. The [security page]({{ '/security/' | relative_url }}) states the limits.

## 4. The security surfaces

### Secret scan

```bash
npm run check:secrets
```

Expected:

```text
secret scan: clean
```

The scanner looks for credential shapes, private-key blocks, forbidden file types, and internal paths in tracked files. It prints the file, line, and rule — never the matched value. Test fixtures under allowlisted trees can pass. It is a gate, not a guarantee. GitHub secret scanning and push protection are also enabled on the repository; non-provider patterns and validity checks are not enabled.

### CodeQL

The CodeQL workflow analyzes JavaScript and TypeScript and uploads results to code scanning. A successful analysis is not a clean result.

```bash
gh api \
  'repos/LLM-4-People/bridlewise/code-scanning/alerts?state=open&per_page=100' \
  --jq '[.[] | select(.rule.id | test("ID$") | not)] | length'
```

At the snapshot this returned **15** CodeQL security-query alerts. The queue was then triaged: test-only, benchmark, and documented-limitation findings were dismissed with path-specific reasons; unknown server errors were changed to a fixed message, HTML script-tag parsing was made case-insensitive, and action references were pinned. The current queue reports **0 open security-query alerts**. A dismissal is not a fix unless its comment says so, and a new commit can introduce a new finding. The queue also holds OpenSSF Scorecard checks, which are not CodeQL findings.

This command requires an authenticated `gh` session with access to code scanning. Without it, use the [Security tab](https://github.com/LLM-4-People/bridlewise/security).

### Dependabot

```bash
gh api \
  'repos/LLM-4-People/bridlewise/dependabot/alerts?state=open&per_page=100' \
  --jq 'length'
```

At the snapshot this returned **21** open alerts on the product repository, mostly transitive or development dependencies. The lockfiles were then updated: `npm audit` reports zero vulnerabilities in the root and engine trees, and the former `@xenova/transformers` tree was moved to an optional peer so its vulnerable `sharp`/`protobufjs` chain is not installed by default. The product repository now reports **0 open Dependabot alerts**; the testing floor also reports 0. Re-run the command for the current count. An alert is not proof of an exploitable path, and a clean audit is not proof that none exists.

### Dependencies

```bash
npm audit
npm --prefix engine audit
```

At the lockfile snapshot both commands report **0 vulnerabilities**. That is a
point-in-time audit of the installed tree, not a guarantee about every
transitive path or a substitute for reading the dependency review. The
`@xenova/transformers` semantic-embedding peer is intentionally not installed;
install it only if you accept its transitive advisories and isolate it.

### Scorecard

The [Scorecard viewer](https://scorecard.dev/viewer/?uri=github.com/LLM-4-People/bridlewise) reported **4.4** at the snapshot. The score is a heuristic over repository settings and workflow hygiene, not an audit. Its branch-protection check errored because the scorecard token could not read classic branch protection, so the score undercounts at least that control.

## 5. The release

```bash
curl -LO https://github.com/LLM-4-People/bridlewise/releases/download/v0.0.2-preview/SHA256SUMS
curl -LO https://github.com/LLM-4-People/bridlewise/releases/download/v0.0.2-preview/bridlewise-v0.0.2-preview-source.tar.gz
sha256sum -c SHA256SUMS --ignore-missing
```

Expected:

```text
./bridlewise-v0.0.2-preview-source.tar.gz: OK
```

Download the cockpit archive, engine bundle, and both SPDX SBOMs too; the same check covers every asset in `SHA256SUMS`. The `v0.0.2-preview` release also publishes a GitHub build-provenance attestation. It does **not** publish an OS-signed installer, a maintainer signature, a reproducible-build proof, or a hosted deployment.

```bash
gh attestation verify bridlewise-v0.0.2-preview-source.tar.gz \
  --repo LLM-4-People/bridlewise
```

The attestation binds the asset digest to the release workflow run and commit under GitHub's OIDC identity. It does not prove the source is correct or the build is reproducible.

## 6. The docs

Relative Markdown links:

```bash
npm run docs:links
```

Expected shape:

```text
docs links: clean (289 Markdown files)
```

The current tracked tree reports 289 Markdown files; the count changes as pages are added. The check resolves repository-relative Markdown links against the tracked tree. It skips absolute URLs, anchors, and Liquid `relative_url` expressions, so it does not prove that the rendered Pages site has no broken links. It also scans `git ls-files`, so an untracked page is invisible until it is added.

The site itself:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://llm-4-people.github.io/bridlewise/
```

Expected:

```text
200
```

The [Pages workflow](https://github.com/LLM-4-People/bridlewise/actions/workflows/pages.yml) builds `docs/` with Jekyll and deploys it. That proves the static site built and deployed. It does not prove the cockpit runs.

## What none of this proves

This is the important section.

- **Green CI is not correctness.** It proves the configured steps passed at one commit. It does not prove the steps cover the failure you care about.
- **A clean secret scan is not a clean repository.** It proves the scanner's rules found nothing in tracked files. It cannot see a secret pasted into an issue, a screenshot, a provider, or a commit that was never public.
- **CodeQL analysis is not a clean codebase.** The analyzer can complete while alerts remain open. The snapshot has open alerts.
- **Scorecard is not an audit.** It scores visible repository hygiene. It cannot review the threat model, the auth design, or the Landlock policy.
- **Guardian tests are not a universal sandbox proof.** They exercise the tested paths on the host kernel. A skip is not a pass, and a pass on one kernel is not a pass on every kernel.
- **Checksums are not signatures.** `SHA256SUMS` proves the downloaded bytes match the published list. It does not prove who published the list, or that the build is reproducible.
- **Smoke tests are not the full suite.** The 4.1 GB corpus and the full prevention/benchmark inventory are not published. A fresh clone cannot reproduce the complete test floor.
- **The docs link check is not a site crawl.** It checks relative Markdown links in tracked files, not rendered Pages URLs or Liquid links.
- **There has been no security audit.** No third-party review, penetration test, or certification exists for this preview.

## Record your own check

If you are going to repeat a claim, leave a record that someone else can replay:

```text
claim:
commit:
command:
observed:
interpretation:
```

That is the same discipline the harness applies to a run: a claim without a command is a story. The [reading map]({{ '/reading-map/' | relative_url }}) offers shorter and longer audit paths. The [known issues]({{ '/known-issues/' | relative_url }}) page lists the gaps this evidence cannot close.
