---
id: UR-12
date: 2026-09-29
by: user
group: user-rules
status: in-force
implementation: standing
---
# The product branch changes only through the promotion door

`master` is never edited or merged into directly, and the checkout that holds
it is never used as a work tree by an agent. Once `testing` is committed and
green under [UR-09](UR-09-independent-verification-before-commit.md), it
reaches `master` through the repository's promotion door (today
[MERGE-GUIDE.md](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md); the generic `harness promote` of
[PROMO-DIR](PROMO-DIR-a-generic-promotion-primitive.md) replaces it), never a
plain `git merge`; then `master` is pushed.
