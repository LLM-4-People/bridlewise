# harness-landlock-guardian (Pattern A: restrict-self + exec)

Standalone C binary. Applies a Linux Landlock LSM restriction to itself and
then `execvp`s a payload. The payload and all its descendants inherit the
restriction irrevocably and cannot read/write the protected subtrees.

This is the OS-level filesystem sandbox the bridlewise currently lacks. It
is **not** an N-API addon — the build is a separate `make` step. The Node
wrapper (Author B, follow-up) fail-closes to a typed `unavailable` if the
binary is missing.

## The process supervisor (`test-process-supervisor.c`)

The second native primitive this folder builds, separate from the security
guardian: the Linux process-lifetime supervisor every supervised command runs
under (`engine/src/process/supervised-run.ts`: both suites' runners, the
nested runners a test launches, and the checkout command runner a workspace
and a promotion use) — external deadlines, a stop forwarded as SIGTERM before
the kill, identity-safe child termination, subreaper cleanup of every
descendant, an optional pass-through of the command's fd 3 (`--pass-fd`) and
CPU receipts. `make test_process_supervisor` builds
`build/test-process-supervisor` (`guardian/build.ts`
`testProcessSupervisorBinary`). It lives here, not beside the tests, because
the product's own command runner needs it: a product checkout builds it from
what ships.

## Build

```bash
cd guardian
make all          # -> build/harness-landlock-guardian, build/test_payload
make test_process_supervisor   # -> build/test-process-supervisor
make test         # builds + runs tests/run-tests.sh
make clean
```

Or via the Node helper (prints the absolute binary path on success):

```bash
node guardian/build.ts
```

Requires a C compiler (`cc`/`gcc`/`clang`) and `make`. No external deps.

## CLI

```
harness-landlock-guardian apply --spec <spec.json> --exec <payload> [payload-args...]
```

- `apply` — subcommand (only one for now; reserves space for Pattern B `guardian-ipc`).
- `--spec <path>` — JSON ruleset spec (must precede `--exec`).
- `--exec <payload>` — program to exec after restriction (`execvp`, so `$PATH`
  resolution works for `node`). Trailing args become the payload's `argv[1..]`.
- Sets NO environment variable: whether a process is confined is measured,
  never read from an env value a process can forge (the former
  `HARNESS_LANDLOCK_GUARDIAN=applied` sentinel went with the CLI re-exec).
- On success: does not return. The payload's exit code is the guardian's.
- On failure before exec: prints `landlock-guardian: <code>: <message>` to
  stderr and exits with the specific code:

| code | meaning                                                        |
|------|----------------------------------------------------------------|
| 2    | spec_parse_error (missing/invalid JSON, unknown flag name)    |
| 3    | landlock_unavailable (ABI probe failed or ABI < 1)            |
| 4    | spec_invalid (bad or linked path, path under or containing a protected_subtree, access not in handled, no handled flags after ABI masking) |
| 5    | prctl_failed                                                   |
| 6    | create_ruleset_failed                                          |
| 7    | add_rule_failed                                                |
| 8    | restrict_self_failed                                           |
| 9    | exec_failed                                                     |
| 10   | keep_out_exposed: THIS spawn's grant holds what decides a keep-out entry's content — a link's folder on the way, its target, a dangling link's would-be target's folder, or a mount below the grant that shows a kept-out place. The message names the link (or the mount) and the remedy. Other spawns are unaffected. |
| 64   | usage (bad CLI args)                                            |

## Ruleset spec

```json
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","TRUNCATE",...],
  "allow_rules": [
    {"path": "/abs/allowed-dir", "access": ["READ_FILE","READ_DIR",...]}
  ],
  "protected_subtrees": ["/abs/harness-root/src"]
}
```

- `abi_version_hint`: `0` = use probed ABI; `>0` = mask to `min(hint, probed)`.
- Flag names are the short names WITHOUT the `LANDLOCK_ACCESS_FS_` prefix.
- Recognized flags (ABI 1–5): `EXECUTE`, `WRITE_FILE`, `READ_FILE`, `READ_DIR`,
  `REMOVE_DIR`, `REMOVE_FILE`, `MAKE_CHAR`, `MAKE_DIR`, `MAKE_REG`, `MAKE_SOCK`,
  `MAKE_FIFO`, `MAKE_BLOCK`, `MAKE_SYM`, `REFER` (ABI 2), `TRUNCATE` (ABI 3),
  `IOCTL_DEV` (ABI 5). Any other name → `spec_parse_error`.
- `allow_rules[].path` must be an **absolute path to an existing regular
  file or directory**. The binary auto-detects the inode type via `fstat`:
  - **directory rule**: covers the subtree beneath; all 16 flags valid in
    `access`.
  - **file rule**: covers exactly that single file; `access` may contain
    ONLY file-level flags (`READ_FILE`, `WRITE_FILE`, `EXECUTE`, `TRUNCATE`);
    any directory-only flag (`READ_DIR`, `MAKE_*`, `REMOVE_*`, `REFER`,
    `IOCTL_DEV`) → exit 4. Symlinks/sockets/devices/fifos → exit 4.
- `protected_subtrees` must exist; they are NOT added as allow-rules — deny is
  by omission.
- `keep_out` (optional): the rest of the harness's keep-out list present when
  the spec was compiled (credential stores, the key home, harness databases).
  Compared exactly like `protected_subtrees` (a rule or the temp dir under or
  containing one → exit 4). A FILE entry is also kept by its name (its
  folder and its name as a resolved spelling), so a store replaced between
  the guardian's open and the payload's still refuses a grant at its name or
  over its folder. An entry ABSENT when the guardian opens it, or one that
  keeps changing while it is located (ESTALE after `keep_out_retries`
  re-locations), is kept by its folder and its name — never skipped. An entry
  reached through a link is resolved one link at a time (at most 40): a
  grant holding a link's folder, the target or a dangling link's would-be
  target's folder refuses that spawn with exit 10 (GUARD-F5).
- `keep_out_retries` (required with `keep_out`): how many times an entry that
  changed while it was located is located again (the root policy's
  `selfProtection.keepOutRetries`).
- Mounts: a mount point below a grant whose root is on a kept-out entry's
  chain (a bind alias of a keep-out folder; WSL's `/mnt/wslg/distro`, which
  is `/`) refuses that spawn with exit 10, read from `/proc/self/mountinfo`.
- **Every path is RESOLVED and is opened exactly once, without following any
  link** (`openat2` with `RESOLVE_NO_SYMLINKS`): the compiler emits resolved
  paths, so a link anywhere in one means it was swapped after it was checked
  (exit 4). A hand-written spec names `/lib` as `/usr/lib` on a merged-`/usr`
  host.
- **Protected subtrees are compared by IDENTITY** — `(st_dev, st_ino)` of the
  location and of every ancestor (walked with `..` from the descriptor) —
  never by spelling: an allow-rule or `temp_dir` that is, sits under, or
  CONTAINS a protected subtree is refused, including through a bind-mount
  alias (WSL's `/mnt/wslg/distro`) that no `realpath()` removes.
- **The rule is added from the descriptor the checks ran on** (an `O_PATH`
  `parent_fd`), so nothing between the check and `landlock_add_rule` can move
  it (no TOCTOU).
- The refused credential/state paths and W^X are the harness compiler's floor
  (`compileSelfProtectionConfigToSpec`), which every caller goes through.

## File-targeted rules (esbuild-bundle)

A file-targeted rule allow-lists a single regular file. This enables the
esbuild-bundle deployment: the harness is pre-bundled into a single file
`dist/bundle.js`, which is allow-listed as a file rule (`READ_FILE`); `src/`
is in `protected_subtrees`; the rest of the harness tree is neither allowed
nor protected (default-deny for the model). `node dist/bundle.js <args>`
loads the bundle (the file rule grants READ_FILE) but any `readFile` against
`src/` is denied by omission. See DESIGN.md "File-targeted allow-rules".

## How protection works

Landlock is **deny-by-default allowlist**. Set `handled_access_fs` to the flags
you govern, add allow-rules for every path the payload needs, and add **no**
allow-rule covering the protected subtree. Any governed access against the
protected subtree is then denied with `EACCES`.

Not restrictable by Landlock: `stat`, `access`, `chdir`, `chmod`, `chown`,
`flock`, `setxattr`, `utime`, `fcntl`. A sandboxed process can `stat`/`chdir`
into a protected dir, but any `open`/`read`/`write`/`create`/`unlink`/`rename`
against it is denied. Tests exercise real `open`/`read`/`write`.

## ABI probing + masking (kernel-docs-recommended)

The binary probes the running kernel's ABI at runtime and masks every flag to
the effective ABI, so it never passes flags the kernel doesn't know. On a
kernel that lacks Landlock entirely, it exits `3` (`landlock_unavailable`).

## Limitations (this slice)

- `allow_rules` target **regular files or directories** (symlinks, sockets,
  devices, fifos are rejected). Device-file rules with `IOCTL_DEV` are a
  follow-up (device files are currently rejected; `IOCTL_DEV` is `dir only`
  and governs devices within an allowed dir subtree).
- fs-only; no network / scoped rules.
- Pattern A only (restrict-self + exec). Pattern B (a separate privileged
  guardian for self-evolution) is a follow-up slice.
- No per-arch prebuilt binaries (future distribution via `optionalDependencies`).

See `../DESIGN.md` for the full design and `tests/run-tests.sh` for the test plan.
