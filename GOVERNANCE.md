# Governance

Bridlewise is an experimental developer preview maintained in the
[LLM-4-People](https://github.com/LLM-4-People) organization. This file
describes how repository decisions are made. It is not a promise of support,
a release schedule, or production fitness.

## Who decides

The organization administrators are the current maintainers. The project is
small enough that a committee would be theater; the maintainers are
accountable for merges, releases, and security responses. Contributors are
credited in the change that lands.

## How decisions are recorded

- Product and architecture decisions live in [`docs/decisions/`](https://github.com/LLM-4-People/bridlewise/tree/main/docs/decisions)
  and, for the development floor, in the decision-record collection in
  [`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing/tree/main/docs/decisions).
- A decision that changes a public contract, a safety boundary, or a
  compatibility claim needs a record before the merge, not after it.
- A refusal is a decision too. If the harness will not do something, the
  reason and the remedy belong in the record.
- The [run record](https://llm-4-people.github.io/bridlewise/run/) is an
  illustration of the product's causal-record model. It is not a governance
  document.

## Changes

1. Open an issue or discussion for behavior changes, security boundaries, and
   public API changes.
2. Open a pull request against `main`. Keep one concern per change.
3. Required checks must pass: the build and verification job, the secret and
   privacy scan, and the docs link gate.
4. A maintainer reviews and merges. The repository uses linear history.
5. Security reports go through the private advisory flow in
   [`SECURITY.md`](https://github.com/LLM-4-People/bridlewise/blob/main/SECURITY.md),
   never a public issue with exploit details.

## Releases

Releases are tagged `v*` and are prereleases until the project says otherwise.
From `v0.0.2-preview` onward, product release assets carry checksums, SPDX
SBOMs, and a GitHub build-provenance attestation. `v0.0.1-preview` predates
that step. The public testing floor does not make a release claim.

## Compatibility and support

The preview may break. There is no support SLA. The project does not accept
responsibility for use with sensitive, proprietary, regulated, or production
code; see the warning in the README. If that constraint is unacceptable, do
not use the preview.

## Conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Security reports are handled under [`SECURITY.md`](SECURITY.md).
