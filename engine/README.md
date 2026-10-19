# The bridlewise engine

The engine is the standalone, provider/model-neutral harness core: the CLI,
the agent runtime, the transactional editor, code intelligence, the quality
packs, memory, privacy, the durable timeline ledger, the forensics and
offline protocol contracts, and the Landlock self-protection guardian. It is
consumed two ways: directly as a CLI (`node src/cli.ts …`), and as a library
by the web server (`server/` drives the engine through `src/index.ts`).

The engine's governance contract is pinned by `src/kernel/root-policy.ts`
(the immutable safety invariants). The preflight receipt
(`node src/cli.ts preflight`) is integrity-only with `harnessReady: false`:
interactive capabilities (model invocation, tool dispatch, repository
mutation, process launch, network use, durable audit) are implemented but
admitted through the governance gate, and until admission each is reported
`deny` with a typed reason. The full admission record and its evidence live
in the separate development-floor repository, not in this product snapshot.

## The subsystems

Each subsystem is a domain folder under `src/` with its own README listing
its files; the per-file consumer lists there are generated from the import
graph.

- `src/kernel/` — the trusted kernel: the typed error hierarchy, canonical
  integrity and hashing, the root policy invariants, the product identity
  owner (`product-identity.ts` — the single source of the product name,
  schema namespace, config basename, state directory, and crypto domain
  prefix), and the verification/schema/protocol contracts every other domain
  builds on. Nothing here depends on a feature; the features depend on these.
- `src/cli.ts` + `src/runtime/` — the CLI entry point and the interactive
  session runtime: `preflight`, `harness`, `quality`, and the embedded
  session APIs. The CLI does not re-exec under the guardian; the web server
  applies Landlock per spawned shell command and per stdio MCP server.
- `src/agents/` + `src/modules/tasks-agents/` — the agent runtime: agent
  types, the orchestrator, handoff protocol authority, and stigmergy
  coordination.
- `src/tools/` — the tool registry, adapters, and concurrent dispatch: the
  model-facing tools (editor, file viewing, search, intelligence, quality,
  git, agents, orchestrator) behind one manifest.
- `src/editor/` — the transactional editor: multi-layer edit planning,
  application, and validation behind the single unified `edit` tool.
- `src/intelligence/` — code intelligence: symbol extraction and search,
  repository maps, dependency graphs, data flow, retrieval, and reuse
  discovery, backed by tree-sitter.
- `src/quality/` + `src/quality-packs/` — the multi-language quality pack:
  parsers, checks, signals, scoring, and the prevention detectors.
- `src/memory/` — the memory subsystems: the unified store, the scale store,
  attempt history, and tool-result exposure/retrieval. Semantic embeddings are
  an optional peer (`@xenova/transformers`); it is not installed by default
  because its transitive tree carries known advisories. The retrieval paths
  fall back to the local TF-IDF/cosine implementation.
- `src/privacy/` — the redaction engine and PII classification.
- `src/awareness/` — the codebase-awareness engine: language adapters and the
  signal library.
- `src/safety/` — the safety layer: bias, hallucination, deviation, bandaid,
  workaround, and step-skip detectors, plus the pause/ask and tool-call gates.
- `src/timeline/` — the durable audit timeline ledger.
- `src/forensics/` — offline forensic contracts and cryptographic primitives
  (canonicalization, exact raw capture, redacted projections, AES-256-GCM and
  SHA/HMAC chains, the outbox reducer).
- `src/filesystem/` — durable filesystem operations, path boundaries, the
  repository-root capability, and the Landlock self-protection config.
- `src/git/` — git operations behind the single runner.
- `src/mcp/` — the Model Context Protocol client and its transports.
- `src/modules/effect-boundary/` — the effect-boundary module: the typed
  effects every capability funnels through.
- `src/performance/` — the performance module, benchmarks, and diagnostics.
- `src/process/` — process lifecycle primitives.
- `src/repository-path/` — repository path policy.
- `src/self-improving/` — the self-improvement loops.
- `src/shared/` — the agnostic helpers every engine domain consumes, owned
  once.
- `src/text/` — text processing primitives.
- `src/workflow/` — the harness commands: register, regenerate, check, sync,
  plus the hash-binding registry, module registrar, and test-result
  collector.

## Single startup configuration

[`bridlewise.config.json`](./bridlewise.config.json) is the only user-editable
harness configuration document. The runtime pins that exact basename beside
`src/`; there is no CLI path or environment override. Its strict schema is
defined once by `getConfigDocumentSchema()` in `src/kernel/config-contracts.ts`; unknown
and duplicate keys are rejected. The file contains no secret values or
environment overrides. All operator-configurable parameters extend that same
typed document; secrets stay outside it behind opaque handles, and immutable
schema, protocol, cryptographic, and safety invariants stay in their owning
shared modules and root policy.

## Mandatory post-checkout permission bootstrap

Git records whether a file is executable but not exact non-executable Unix
modes, so a fresh checkout can materialize `bridlewise.config.json` as `0644`
or `0664` while the runtime requires exactly `0600`. Before the first
preflight after every checkout, run:

```text
node scripts/bootstrap-permissions.ts
```

This zero-argument setup command derives the repository and pinned config
path from its own installed location, descriptor-validates ownership, file
type, device, link count, and symlink and mount boundaries, changes only the
already-open config descriptor to `0600`, then independently reopens it and
revalidates identity, mode, and unchanged content. The product preflight
fails closed with `config_mode_insecure` before this trusted step.

## Preflight

```text
node src/cli.ts preflight
```

A successful result is an integrity-only receipt with `harnessReady: false`
and a per-capability decision list; each interactive capability is reported
`deny` until the governance gate admits it. Configuration and project roots
must be owner-matched regular Linux paths; mode drift, hardlinks, symlinks,
traversal, mountpoints, cross-device paths, unknown or duplicate keys,
malformed input, and root mismatch are denied with safe typed errors.

## Self-protection (Landlock)

The engine ships an OS-level filesystem sandbox: a frozen C binary
(`guardian/build/harness-landlock-guardian`) applies a Linux Landlock LSM
restriction to itself and `execvp`s the payload. The restriction is
irrevocable and inherited across `fork`/`exec`/`clone`, so the payload and
its descendants cannot read or write the protected subtrees.

The guardian binary applies a Landlock ruleset to itself and `exec`s a
payload. The web server uses it per spawned shell command and per stdio MCP
server (`server/safety/landlock-runner.ts`), confining the process and its
descendants to the selected project. The CLI itself does not re-exec under
the guardian: `preflight`, `harness`, and `quality` run as ordinary Node
processes and must read `src/`. A missing guardian binary or Landlock feature
is a typed refusal when a confined spawn is requested; it is not silently
skipped. The engine bundle is built by `node scripts/build-bundle.ts`.

After any `src/` change, rebuild the bundle and re-pin the hash bindings in
one pass:

```bash
node src/cli.ts harness sync --with-bundle
```

## Shipping a branch to another (`harness promote`)

A promotion carries a source branch to a target branch through a declared
profile on the source (`<promotion.profileDirectory>/<name>.json`): the
target's tree is a projection of the source's — what the profile's entry
points reach, what it includes, and the files it derives (the package
manifests, the lockfiles) — never a merge. The verbs:

```bash
node src/cli.ts harness promote status  [--profile <name>] [--source <rev>] [--json|--text]
node src/cli.ts harness promote plan    [--profile <name>] [--source <rev>] [--diff] [--patch] [--json|--text]
node src/cli.ts harness promote explain [--profile <name>] [--source <rev>] [--json|--text] <path>…
node src/cli.ts harness promote apply   [--profile <name>] [--source <rev>] [--no-publish | --no-push]
                                        [--accept-target-edits <path>… --reason <text>] [--allow-deletions --reason <text>]
                                        [--release-hold --reason <text>]
node src/cli.ts harness promote rollback [--profile <name>] --to <promotion commit> --reason <text>
node src/cli.ts harness promote hold | release-hold [--profile <name>] --reason <text>
```

Each prints the harness's JSON envelope whose `result` is the promotion's
answer (`ok`, `code`, `class`, `message`, `remedy`, `data`) — or, with
`--text`, a short report (the one output option every harness verb takes,
below) — and exits with its class's code
(`src/workflow/promotion/codes.ts`; 0 ok, 2 input, 3 precondition, 4 errored,
5 failed, 6 integrity, 7 parked); `plan` writes no ref, index or checkout.
`apply` builds the promotion commit in a candidate worktree (the profile's
setup, converge and verify commands, then one `git commit` whose hooks
certify the exact tree), pins it under
`refs/bridlewise/promotion/<profile>/pending` with its receipt, pushes it
atomically with its receipt (never forced) and fast-forwards the checkout
that holds the target; `--no-publish` stops after the pin, `--no-push`
publishes locally. A rerun resumes. `rollback` restores an earlier
promotion's tree with a new commit and holds automatic promotion until
`release-hold`. With the profile's `trigger: on-source-publish`, the tracked
`.githooks/reference-transaction` hook promotes after every push of the
source (`harness promote auto`). The runbook is
`docs/process/MERGE-GUIDE.md`; `src/workflow/promotion/README.md` holds the
details.

## One output option for every harness verb

Every `node src/cli.ts harness <verb>` (also exposed by the development
root package's `ws` and `promote` aliases) answers one way: the JSON envelope
(`{schemaVersion, command, status, result, generatedAt, integrityHash}`) by
default or with `--json`, or a report for a person with `--text` — anywhere
on the line, the last one wins. A refusal goes to stderr in the same format
(the typed record, or `<code>: <message>`). The option belongs to the
dispatch (`takeOutputFormat` and `renderCommandAnswer` in
`src/workflow/command-result.ts`); no verb parses it, and a verb gives its own
report only where one reads better than the generic `key: value` rendering
(`promote`, `benchmark`, `diagnostic`, `eval`). Progress lines go to stderr.

## Verification

From the engine package root, `npm run typecheck` checks the source.
`npm run build:bundle` builds the guardian payload. The public product
snapshot does not include the full test inventory, the traceability registry,
the frozen records, or the vendored verification sources; those live in the
separate development-floor repository, together with its `test`, `check`,
and `manifest:candidate` scripts.

`harness check` is available in the product snapshot, but its architecture
and inventory legs expect development-floor records. Use it with
`--skip-inventory` (and, on a sanitized snapshot, `--skip-architecture`) when
you are checking only the product surface. The one-shot convergence command
after an engine edit is `harness sync --with-bundle`, which registers,
regenerates, and re-pins the bundle.
