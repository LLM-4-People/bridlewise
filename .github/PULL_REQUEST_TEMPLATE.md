## What changed

<!-- One paragraph. Link the issue if there is one. -->

## Why

<!-- The failure mechanism or design rationale, not just the symptom. -->

## Verification

<!-- Exact commands, tests, or manual steps. State what you could not verify. -->

- [ ] `npm run typecheck`
- [ ] `npm --prefix engine run typecheck`
- [ ] `npm run check:secrets`
- [ ] `npm run build`
- [ ] `npm --prefix engine run build:bundle`
- [ ] Guardian build/test (if touched)
- [ ] Testing-floor suite (if touched; link the run)

## Safety and scope

- [ ] I did not include credentials, private source, personal data, databases, logs, or build output.
- [ ] I did not use Bridlewise on a sensitive or production codebase.
- [ ] The change does not add a silent fallback, retry mask, or fabricated data.
- [ ] Documentation and examples match the code.
- [ ] I agree my contribution is licensed under AGPL-3.0-only.

## AI assistance

<!-- Disclose material AI assistance and describe how you verified the result. Write "none" if not applicable. -->
