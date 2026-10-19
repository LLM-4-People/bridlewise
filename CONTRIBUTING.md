# Contributing to Bridlewise

Thank you for looking at the machinery. Bridlewise is an experimental, pre-1.0 project. Contributions are welcome, but the bar for evidence is high and the product is explicitly not production-ready.

> [!WARNING]
> Do not use Bridlewise on sensitive, proprietary, regulated, or production codebases. Run it against disposable copies. Never include real credentials, private source, or personal data in an issue, test fixture, screenshot, or pull request.

## Repository layout

| Repository | Purpose |
|---|---|
| [`bridlewise`](https://github.com/LLM-4-People/bridlewise) | Product: Svelte cockpit, loopback server, engine, guardian, shared contracts, public docs |
| [`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing) | Development floor: tests, benchmarks, curated design records, verification |

The product repository is a curated projection. The testing repository carries the larger development surface and is intentionally noisier.

## Development setup

Requirements: Linux (Landlock is Linux-only), Node `>=24.18.0 <25.0.0`, npm, Git, and optionally a C compiler for the guardian.

```bash
git clone https://github.com/LLM-4-People/bridlewise.git
cd bridlewise
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
node scripts/sd.mjs start
```

Open <http://127.0.0.1:5173/>. The first account created owns the local harness. The API health endpoint is <http://127.0.0.1:5174/api/health>.

If the self-protection config mode is rejected, run `chmod 600 engine/bridlewise.config.json` again. Git does not preserve that mode.

## Before you open a pull request

Run the checks that apply to your change:

```bash
npm run typecheck
npm --prefix engine run typecheck
npm run check:secrets
npm run build
npm --prefix engine run build:bundle
```

For guardian changes:

```bash
make -C engine/guardian all
make -C engine/guardian test
```

The full test and verification suites live in the testing repository. If your change affects a suite there, link the corresponding run or explain why it could not be run.

## What makes a good change

- Fix the cause, not the symptom. Do not add retries, silent fallbacks, or special cases to hide a failure.
- Keep one owner per fact or behavior. Reuse the canonical implementation instead of adding a parallel one.
- Validate at trust boundaries. Handle invalid input, failure paths, and cancellation.
- Preserve the governed-tool posture: typed refusals, explicit blockers, no silent success.
- Add a regression test when fixing a reproduced bug. If a test is impossible, say so explicitly.
- Keep documentation and examples consistent with the code.

## Commit and pull request style

- Use conventional subject prefixes: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`, `chore:`.
- Keep each commit cohesive and explain the *why* in the body when it is not obvious.
- One logical change per pull request.
- Describe what changed, how it was verified, and any residual risk.
- Do not include generated build output, databases, logs, or secrets.
- By submitting a contribution, you agree that it is licensed under AGPL-3.0-only.

## AI-assisted contributions

AI-assisted work is welcome. You remain responsible for the result. Disclose material AI assistance in the pull request, verify every claim yourself, and do not paste unreviewed generated code into security-sensitive paths.

## Review and merge

Maintainers review for correctness, evidence, scope, and consistency with the project's design principles. A passing CI run is necessary but not sufficient. The project may decline changes that make the preview look more complete than it is.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
