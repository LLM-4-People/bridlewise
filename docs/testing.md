---
layout: default
title: Testing
description: What the public product verifies, what the development floor verifies, and how to add a test.
permalink: /testing/
---

# Testing

> [!WARNING]
> Bridlewise is a developer preview. A green suite is evidence about the tested surface, not a production guarantee. Do not run the harness against sensitive or production codebases.

## Two layers

| Layer | Repository | What it proves | Fresh-clone status |
|---|---|---|---|
| Public smoke tests | `bridlewise` | The shipped CLI launcher, the typed refusal surface, the preflight receipt, the secret scanner, the safety warning and docs | Green with `npm run test:public` |
| Development floor | `bridlewise-testing` | Prevention guards, server/cockpit unit tests, engine domain tests, performance and E2E suites | Typecheck and a curated subset are green; the full suite has prerequisites below |

The product repository intentionally carries no large test tree. Publishing a test inventory without its fixtures and frozen records would create a false impression of coverage. The development floor is published separately so the machinery can be inspected.

## Public smoke tests

```bash
npm ci
chmod 600 engine/bridlewise.config.json
npm run test:public
```

The suite uses Node's built-in test runner and covers:

- `bin/bridlewise.mjs` is executable, prints help/version, and lists every harness verb;
- `harness` without a verb is a typed refusal, not a crash or a silent success;
- `preflight` returns `harnessReady: false` and denies model invocation, repository mutation, and network egress;
- the secret scanner passes a clean tree, fails on a provider-shaped key outside a fixture path, fails on an internal absolute path, and never prints the candidate value;
- the README carries the developer-preview and sensitive-codebase warning;
- the CLI/testing/extending docs and the licence/community files exist.

Run the whole public gate with:

```bash
npm run verify     # typecheck + secret scan + public tests + build
```

## Development-floor setup

```bash
git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
npm ci
npm --prefix engine ci
npm run bootstrap:hooks
chmod 600 engine/bridlewise.config.json
```

Requirements beyond the product:

- Linux with Landlock for confinement tests; WSL works with the documented caveats.
- A C compiler and `make` for the guardian and process supervisor.
- Chromium for Playwright E2E: `npx playwright install --with-deps chromium`.
- User systemd for the long-task-runner test.
- `openssl` for the outbound-HTTP test.
- The 4.1 GB external corpus at `engine/large-codebases` for the full engine suite.
- `tests/performance/.report.json`, produced by `npm run perf:profile`, for the root performance-regression test.

The corpus and the performance report are deliberately not published. A fresh clone therefore cannot run the full suites; the runners refuse with a named prerequisite instead of silently skipping.

## Commands

### Root web suite

```bash
npm run typecheck
npm run typecheck:includes
npm test                 # vite/vitest suite through the watchdog
npm run test:watch
npm run test:raw         # vitest under the harness slot
npm run test:e2e         # Playwright
npm run test:all         # root suite + Playwright
npm run perf:profile     # writes tests/performance/.report.json
node --experimental-strip-types bench/run.ts
```

### Engine suite

```bash
cd engine
npm run typecheck
npm test                 # full engine suite; refuses without the corpus
npm run test:guards      # architecture, prevention, workflow guards
npm run test:unit
npm run test:editor
npm run test:live        # opt-in provider/network tests
npm run check            # typecheck + verification
npm run coverage
```

### Guardian

```bash
make -C engine/guardian all
make -C engine/guardian test
make -C engine/guardian test_process_supervisor
```

The guardian tests exercise Landlock itself. An exit code of 3 (`landlock_unavailable`) is a skip, not a pass; the Node-side tests cover the refusal path with a mock.

## Test map

| Path | Subject |
|---|---|
| `tests/unit/` | Server, client, API, persistence, and focused behavior |
| `tests/prevention/` | Guards against a class of regression, not one bug |
| `tests/cockpit/` | Svelte surfaces and interaction invariants |
| `tests/performance/` | Budgets and measured regressions |
| `tests/helpers/`, `tests/fixtures/` | Shared setup and deterministic fixtures |
| `tests/setup/` | Hermetic network and process setup |
| `engine/test/` | Engine domains: editor, intelligence, memory, privacy, safety, timeline, workflow, MCP, quality, and more |
| `engine/live/` | Opt-in provider and MCP smoke tests |
| `bench/` | Concurrency, DB, ledger, payload, redaction, and write-path measurements |

## Adding a test

1. Put the test beside its subject's domain: root web behavior in `tests/unit/` or `tests/prevention/`; engine behavior in the matching `engine/test/<domain>/`.
2. Use the runner already used by that tree. The web suite uses Vitest (`import { describe, expect, test } from "vitest"`); the engine suite uses `node:test` and `node:assert/strict`.
3. Make it deterministic. Use `mkdtemp`/the provided temp helpers, inject clocks and providers, and never depend on the developer's home directory, a live network, or a real credential.
4. Prefer one strong invariant over many equivalent assertions. If the test protects a reproduced bug, make it fail on the old behavior first.
5. For a prevention guard, state the class, the plant, the driven behavior, and the liveness check in the header comment. A guard that cannot prove it sees the plant is not a guard.
6. Do not add skips. If a prerequisite is absent, the runner should refuse with a typed reason; a skipped test that looks green is the failure this project exists to prevent.
7. Run the focused file, then the domain suite, then the checks that touch your change.

Example engine test:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/kernel/integrity.ts";

test("canonical JSON is stable across key order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});
```

Example web test:

```ts
import { expect, test } from "vitest";
import { normalize } from "../../server/intelligence/query.ts";

test("a blank query is refused, not broadened", () => {
  expect(() => normalize("   ")).toThrowError(/empty/u);
});
```

## CI

The product repository runs Node 24, two `npm ci` installs, both typechecks, the secret scan, the public smoke tests, the cockpit build, the engine bundle, and the guardian build/test on every push and pull request.

The testing repository runs both typechecks, the public smoke suite, the guardian build/test, and a curated development guard set. The full corpus-backed and E2E suites are documented as manual/nightly work until the corpus can be published reproducibly.

## Flakiness

A flaky test is a defect in the test or its subject. Reproduce it, name the cause, and fix the owner. Do not add retries to the default suite and do not reorder assertions until it passes. Playwright CI may use a bounded retry for browser timing, and the retry must be visible in the report.

## What is not covered

- Production multi-tenant behavior.
- A security audit or penetration test.
- Every provider's streaming edge cases.
- Windows and macOS behavior.
- A hosted demo.
- The private corpus, private evidence, and frozen records.
