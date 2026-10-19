# Filesystem self-protection

The engine side of the Landlock self-protection system: compiling the
operator config and the non-overridable floor into the guardian ruleset
spec, resolving and pinning the guardian binary, and the path-region math
the spec compiler relies on. The guardian binary itself lives under
`engine/guardian/`; this folder is the TypeScript that drives it.

## What each file does

- `index.ts` — the public barrel: explicit named re-exports only, so the
  public surface stays discoverable.
- `self-protection-config.ts` — the operator-facing config schema, its
  defaults, and the parser (additive-only over the root-policy floor). It is
  the ONE owner of what an absent `selfProtection` section means: CONFINED
  (`enabled: true`). The engine CLI bootstrap, the dev-mode detector and the
  web server's confinement status all resolve through
  `resolveSelfProtectionConfig`; only a written `"enabled": false` is dev
  mode / unconfined.
- `self-protection-contracts.ts` — the guardian spec schema, the Landlock
  access-flag vocabulary, and the flag metadata.
- `guardian-binary.ts` — resolving and verifying the guardian binary (its
  path and pinned hash), and compiling the config to the spec (the keep-out
  list's present entries become the spec's protected subtrees and `keep_out`;
  no temp folder is granted unless the host names a private one).
- `keep-out.ts` — THE ONE KEEP-OUT LIST: the harness floor, every home's
  stores (WSL Windows profiles included, case-insensitive, short 8.3 names
  resolved to their long names), the key home and its registered stores (each
  store's whole family by prefix), the host's facts, the operator's
  `additionalProtectedSubtrees`; plus two arms needing no list: an install
  still keeping its key beside its database (by shape, unregistered — a
  key-sized `db-key`, a link to one included, beside a SQLite database; a
  grant or project containing one within `legacyInstalls.containedSearchDepth`)
  and
  a store name directly inside a home-like folder (`<…>/home/<u>/`,
  `<…>/Users/<u>/`, `/root/`; the same name inside a project is project
  content, and so is a whole home-shaped folder inside the project an
  operation serves — `operation({ servedProject })`, the file door's and the
  search walk's scope: a dotfiles repository or a fixture home, sec-e-design M1). One verdict by identity for the compiler, the project door and the
  file choke point; the list is rebuilt only when its generation moves
  (`keepOutListBuilds`), and a caller asking about many places takes one
  `operation()`.
- `key-home.ts` — where every harness key lives (`HARNESS_KEY_HOME` >
  `$XDG_CONFIG_HOME/bridlewise/keys` > `~/.config/bridlewise/keys`, 0700,
  never a link, outside every checkout, store folder, declared project and the
  system temp folder), THE ONE admission (`admitHarnessKeyHome`: it computes
  the neighbours; `admitKeyHome` is its primitive), the key and salt file names
  (and each retired key a re-key kept, in a slot of its own named by its fingerprint, so a later re-key never replaces the one older copies open under), and the registry of harness stores
  (`openStoreRegistry`: an explicit dependency recording which key seals each
  store; a read never prunes, `forgetHarnessStore` is the key tool's). A
  process under test with no `HARNESS_KEY_HOME` is refused
  (`key_home_unset_under_test`); the runners arm a private one
  (`engine/test/support/test-key-home.ts`).
- Path identity (resolution, `(dev, ino)` comparison) is `../path-identity.ts`.

## Stated residuals

**A confined command reads a project's secret files raw** (sec-e-correctness
M-6). A project holding `.npmrc`, `.docker/config.json` or `.kube/config` is
admitted (its store names are project content, secd-design H1): the FILE
DOOR (`read_file`, `search_code`) serves them through the secret-file owner
with every value hidden, but a confined `cat .npmrc` reads the project's bytes
like any other project file, and command output does not pass through that
owner — only through the detectors every egress runs. Hiding them there
would mean holding each project's secret-file values as known secrets at the
command-output door (the held-set door MCP output uses); that is recorded as
open work, not done.

**The bounds of the unregistered-install look.** The look for an install
still keeping its key beside its database is bounded
(`ROOT_POLICY.selfProtection.legacyInstalls`); what each bound does when it
is reached (sec-e-correctness M-4):

- **Files beside a key** — at most `maximumSiblingsRead` headers are read,
  database-named siblings (`*.db`, `*.db3`, `*.sqlite*`) first, so filler
  files cannot hide the database. A key beside more files than that with no
  database found among the ones read is kept out FAIL CLOSED (the install is
  reported `searchExhausted`; `db-key scan` refuses to register it with
  `legacy_install_search_exhausted`).
- **Folders below a grant** — at most `containedSearchDepth` levels and
  `containedSearchFolders` folders are looked at. Past either bound the look
  stops and the grant compiles: an install deeper, or behind more folders, is
  kept out only once registered (from the engine package root, `node ../scripts/db-key.ts scan --apply`). Reaching
  the folder budget is audited (`self-protection.legacy-search-budget`, with
  the grant); failing closed there would refuse every large project.
- **A linked key** — a `db-key` that is a link to a key-sized regular file is
  a key (followed for its size only; its bytes are never read). A database
  keeping its key beside it is recognised directly (its own header and the
  key), never through the bounded listing, so it is never given a new key.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/filesystem/self-protection/`.

- `guardian-binary.ts` is consumed by `engine/src/filesystem/self-protection/index.ts`.
- `index.ts` is consumed by `server/kernel/canonical.ts`.
- `keep-out.ts` is consumed by `engine/src/filesystem/self-protection/guardian-binary.ts`, `engine/src/filesystem/self-protection/index.ts`, `engine/src/filesystem/temporary-root.ts`, `engine/src/process/instrument-lock.ts`.
- `key-home.ts` is consumed by `engine/src/filesystem/persisted-key.ts`, `engine/src/filesystem/self-protection/index.ts`, `engine/src/filesystem/self-protection/keep-out.ts`.
- `self-protection-config.ts` is consumed by `engine/src/cli.ts`, `engine/src/filesystem/self-protection/guardian-binary.ts`, `engine/src/filesystem/self-protection/index.ts`, `engine/src/filesystem/self-protection/keep-out.ts`, `engine/src/filesystem/self-protection/key-home.ts`, `engine/src/kernel/config-contracts.ts` and 1 more.
- `self-protection-contracts.ts` is consumed by `engine/scripts/verification/slice-projections.ts`, `engine/src/filesystem/self-protection/guardian-binary.ts`, `engine/src/filesystem/self-protection/index.ts`, `engine/src/filesystem/self-protection/self-protection-config.ts`, `engine/src/kernel/root-policy.ts`.

<!-- /consumers:generated -->
