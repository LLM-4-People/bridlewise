# Safety domain

The safety domain owns what the model is not allowed to do: the pre-dispatch
hallucination gate, the runtime detectors that watch a turn as it streams, the
artifact sandbox check, and the Landlock confinement that restricts a spawned
command to the selected project — and every stdio MCP server to a
harness-owned home of its own (`mcpServerHomeDir`). These are checked before
and during execution, never after.

The confinement floor also grants read access to the RESOLVED target of the
files it means to cover but a host may keep behind a link out of `/etc`
(`ROOT_POLICY.selfProtection.minimumLinkedReadFiles`: `/etc/resolv.conf`, a
link to `/mnt/wsl/resolv.conf` on WSL): without it a confined command or MCP
server has no DNS.

`spawnPlanned` also supports native bounded UTF-8 capture for asynchronous Git reads. The existing timeout kills the direct child with SIGKILL; captured output is usable only after both streams reach EOF. Descendant-held pipes can cause unavailable output even after the direct child exits successfully. Completion does not assert termination of every descendant.

## Security model: what confinement covers, and what it does not

- **Absent means confined.** `selfProtection` left out of the config is
  confined (one owner: `resolveSelfProtectionConfig`); only a written
  `"enabled": false` runs commands and MCP servers unconfined — and each such
  start is logged at the owner (`confined spawn unconfined`). Every refusal is
  logged with its code (`confined spawn refused`).
- **Two consumers, one owner.** `prepareConfinedSpawn` confines a `command`
  (the model's `execute_command`, the awareness checks, git) to the project,
  its private scratch folder, a per-spawn temp folder and the operator's
  `additionalAllowRules`; and an `mcp-server` to its own home ONLY (its
  `TMPDIR` lives inside it; no scratch, no operator rules). The floor's device
  files (`/dev`) stay writable for both.
- **W^X over every granted rule, by identity.** The compiler floor
  (`guardian-binary.ts`) refuses any rule granting EXECUTE that overlaps any
  rule granting a write flag — the payload, the interpreter, the server's
  tool paths, an MCP server's `readPaths` and the operator's rules alike
  (`tool_path_overlaps_writable`): what a confined process can write it can
  never `execve`. Residual, stated: Landlock's EXECUTE gates `execve` only, so
  an allowed interpreter still RUNS a script it can read.
- **ONE keep-out list, for every consumer** (`engine/src/filesystem/self-protection/keep-out.ts`).
  The harness's own code (the floor's `src` plus this repository's `server/`,
  `shared/`, `scripts/`, `src/` — `host-facts.ts`), the unremovable stores of
  EVERY home the host has (`ROOT_POLICY.selfProtection.minimumRefusedPaths`:
  `~/.ssh`, `~/.gnupg`, `~/.pki`, cloud and registry credentials, browser
  profiles, shell histories, `~/.local/state/<product>-*`, the AI tools'
  folders…; on WSL also each Windows profile under `/mnt/<drive>/Users`,
  compared case-insensitively), the KEY HOME (every harness key) and every
  harness database registered there — of any checkout, lab or backup, at any
  depth, by identity — this server's own files (`host-facts.ts`: every
  database file and copy, the config document; for an MCP server also the
  declared project roots) and the operator's additions
  (`selfProtection.additionalProtectedSubtrees`, which can only ADD). No rule of
  `execute_command` or of an MCP server may equal, contain or sit inside an
  entry (`read_path_refused`; the harness code keeps `project_is_harness_source`);
  `readPaths` are refused at save time by the same list. Every entry that
  exists is EMITTED into the guardian spec as a protected subtree, so the C
  guardian enforces all of them (Windows-drive entries excepted: Landlock does
  not govern DrvFs). Signal: `safety.keepOut`. A store name under any folder
  directly inside a home-like folder (`<…>/home/<u>/.ssh`, `<…>/Users/<u>/`,
  `/root/`: another account's or a copied home) is kept out by name; the same
  name inside a project (`.claude/`, `.npmrc`, `.docker/`, `.kube/` committed
  with the code) is project content, its secret values redacted by the
  secret-file owner. An install still keeping its key beside its database (the
  layout before the key home: a key-sized `db-key` beside a SQLite file) is
  kept out WITHOUT registration: every place inside its folder, and a grant or
  project containing it down to `legacyInstalls.containedSearchDepth` folders.
  Residual, stated: such an install deeper than that inside a granted folder is
  kept out only once registered (`npm run db-key -- scan <folders> --apply`,
  which registers and never moves a key). On a Windows drive a short 8.3 name
  (`CODEX~1`) is resolved to its long name (same inode, measured).
- **Identity, not spelling.** Every refusal and overlap is decided by
  (device, inode) of the path and its ancestors (`identityOverlapIndex`), so a
  bind-mount alias (WSL's `/mnt/wslg/distro`) is the same place; the C guardian
  opens each path once without following links (`openat2`
  `RESOLVE_NO_SYMLINKS`), checks the protected subtrees by identity in both
  directions, and adds the rule from the very descriptor it checked (no swap
  between check and use).
- **The same list for what the server opens itself.** A project folder is
  refused when it is a system folder, is the harness, holds or lies inside it,
  or overlaps a keep-out entry — so a home (it holds credential stores) or a
  Windows profile is refused (`projectRootRefusals`, the project door and the
  picker, all by identity); the file choke point (`resolveWithinProject`)
  refuses every file inside an entry (`path_harness_state` for the harness's
  state and code, `path_credential_store` for a store), which also covers a
  project registered before the door refused its folder. Host credential stores
  are measured unreadable from a confined command and a confined MCP server
  (`tests/unit/mcp-stdio-landlock.test.ts`).
- **The outbound door (every HTTP request and WebSocket the harness sends).**
  One client (`undici`, a direct dependency) in `engine/src/shared/outbound-http.ts`:
  each request is resolved once, held to its destination rule
  (`network.userPrivateAddresses` for users' providers, the operator's rule
  for admin configuration) and PINNED to the checked addresses, on a
  connection pool keyed by them (a kept-alive connection never serves a
  request pinned elsewhere). Proxied deployments: a request held to public
  addresses is refused through an environment proxy
  (`outbound_destination_unpinnable`: the proxy would resolve again); an
  admin exempts provider hosts with `NO_PROXY` in the server's environment or
  allows users' private addresses. The pooled connections close with the
  server (`closeOutboundConnections`, called by its shutdown).
- **Network egress is NOT restricted.** Landlock confines the filesystem
  only; there is no network namespace or seccomp filter. A confined command or
  MCP server can reach the network and could send out whatever it can read,
  so the read surface is what is kept small (the floor's `/etc`, `/usr`,
  `/proc`, the process's own paths). Outbound requests the HARNESS makes (the
  LLM client, remote MCP servers) go through the one outbound HTTP policy
  (`engine/src/shared/outbound-http.ts`): no redirect is followed, TLS
  verification cannot be switched off, cleartext to another host is refused or
  warned per config.
- **Environment.** A command gets `HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST`; an
  MCP server the smaller `tools.mcp.stdioInheritedEnv` plus its own entry's
  credentials. Both are projected by the one `buildSubprocessEnv`; a bare
  `*` is refused.

## What each file does

- `safety-bridge.ts` — the pre-dispatch hallucination gate: the single web-UI
  owner that checks a tool call before the model can invoke it.
- `safety-runtime-bridge.ts` — the single composition point for the engine's
  event-feed safety detectors, run against a turn as it streams.
- `safety-invariants.ts` — the hardcoded-value carve-out the safety floor
  declares.
- `artifact-check.ts` — owns "can this artifact actually run, and what is it
  reaching for that the sandbox does not have".
- `landlock-runner.ts` — the bridge to the Landlock guardian: a spawned
  `execute_command` runs restricted to the selected project and nothing else,
  and a stdio MCP server (purpose `mcp-server`) to its own home
  (`mcpServerHomeDir`, `ensureMcpServerHomeDir`), with its operator-named
  `readPaths` read-and-run only (W^X and the refused roots checked at the
  owner). Every confined child gets a PRIVATE temp folder — a command its
  per-spawn folder, an MCP server `<home>/.tmp` — and the spawn door
  (`spawnPlanned`) points `TMPDIR`/`TMP`/`TEMP` at it; the system temp folder
  is never granted (a harness database kept under `/tmp` refuses nothing, and
  no child sees another's temp files). The per-spawn folders are owned
  temporaries: a leftover the sweep cannot remove is skipped and reported,
  never a refusal of the next spawn.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/safety/`.

- `artifact-check.ts` is consumed by `server/tools/tool-executor.ts`, `server/tools/tools-bridge.ts`.
- `host-facts.ts` is consumed by `server/filesystem/fs-gate.ts`, `server/index.ts`, `server/safety/landlock-runner.ts`.
- `landlock-runner.ts` is consumed by `server/awareness/auto-check-runner.ts`, `server/blocks/tools.ts`, `server/integrations/mcp-bridge.ts`, `server/integrations/mcp-runtime-bridge.ts`, `server/intelligence/git-bridge.ts`, `server/tools/tool-executor.ts`.
- `safety-bridge.ts` is consumed by `server/routes/safety.ts`, `server/run/run-executor.ts`, `server/tools/tool-executor.ts`.
- `safety-invariants.ts` is consumed by `server/auth/auth.ts`, `server/index.ts`.
- `safety-runtime-bridge.ts` is consumed by `server/index.ts`, `server/run/run-executor.ts`, `server/tools/tool-executor.ts`.

<!-- /consumers:generated -->

Captured planned commands register their native child with the existing
component registry at creation and retire it at capture completion, including
spawn errors, output overflow and timeout. The registry reports the command
basename and PID, without arguments or environment values.
