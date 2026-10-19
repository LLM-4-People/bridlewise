---
layout: default
title: "Security and limits"
description: "The Bridlewise threat model: what the local trust boundary protects, what it does not, how keys are stored, and the limits of redaction and Landlock."
permalink: /security/
---

# Security and limits

> **Bridlewise has not been security-audited.** It is an experimental developer preview. The engine is pre-admission (`harnessReady: false`), interactive capabilities remain behind an open governance gate, and there is no signed release, hosted service, or support contract. **Do not use it on proprietary, regulated, client-confidential, or production code.**

This page describes the intended boundary and its limits. It is not a security guarantee, a compliance statement, or a substitute for your own review.

## The short version

- The server is a **local loopback service**, not a hardened internet-facing application.
- **The local user is inside the trust boundary.** Anyone with your OS account, your key home, your database, or your process memory can reach your data.
- **Prompts and context go to the model provider you configure.** Redaction reduces accidental secret egress; it cannot make hostile repository content safe or guarantee that nothing sensitive is sent.
- **Landlock confines filesystem access on Linux.** It is not a VM, a container, a network firewall, or a seccomp profile.
- **The timeline is append-only at the application layer with a local hash chain, but it is not signed or externally anchored.** It is not an audit system.
- **No multi-tenant isolation has been audited.** Do not expose one instance to mutually distrusting users.
- **There are no signed releases.** Build from source and review what you run.

## Assets and actors

**Assets:** source code and repository content; prompts and model responses; provider API keys; session tokens and password hashes; the SQLite databases; the timeline ledger; local configuration.

**Actors considered:**

| Actor | Position |
|---|---|
| The local operator | Trusted to run the harness, but capable of mistakes. Has access to the key home and database. |
| Other processes under the same OS account | Outside the application boundary; can read files the account can read, including the key home. |
| Other local users | Not modeled as tenants. Filesystem permissions are the only separation. |
| A malicious repository | Untrusted. May contain prompt injection, hostile source, or secrets. |
| A malicious model response | Untrusted. May request tools, produce misleading text, or attempt to reach the artifact sandbox. |
| The model provider | Receives prompts and context by design. Its retention, training, and logging policies are outside Bridlewise's control. |
| A network attacker | The default bind is loopback; there is no TLS because there is no supported remote deployment. |
| A supply-chain attacker | Dependencies, MCP servers, and extensions are not audited by this project. |

**Assumptions:** a single-user workstation; a patched OS; a provider you trust with the content you send; full-disk encryption if the machine is portable; backups you control. If any assumption is false, the risk is yours to evaluate.

## What is protected

| Control | What it does | Where it lives |
|---|---|---|
| Loopback binding | The server binds to `127.0.0.1` by default and rejects non-loopback `Host` headers. | `server/index.ts`, `server/safety/safety-invariants.ts` |
| Authentication | Passwords use scrypt with per-password salts. Sessions are random 32-byte tokens in HttpOnly, SameSite=Lax cookies; only a SHA-256 hash of the token is stored. | `server/auth/` |
| CSRF and origin checks | Mutating requests require the CSRF header; the allowed origin is explicit. Auth, CSRF, and rate limits are enforced at the router choke point. | `server/router/` |
| Authorization | Routes resolve the user context; projects, chats, and providers are scoped to their owner. Admin-only writes are checked. | `server/routes/`, `server/auth/` |
| Path safety | Tool and filesystem access is restricted to the selected project; traversal and symlink escapes are rejected. | `server/filesystem/`, `engine/src/filesystem/` |
| Field encryption | Sensitive SQLite columns are encrypted with AES-256-GCM, bound to their table, column, row, parent, and owner. | `server/db/db-crypto.ts` |
| Key separation | Database key material lives in a key home outside every checkout and project, mode `0700`, never under the system temp folder. | `server/db/bootstrap-key.ts`, `engine/src/filesystem/self-protection/key-home.ts` |
| Redaction | Content bound for the provider and content shown to the user passes through one redaction adapter. | `server/llm/redaction.ts`, `engine/src/privacy/` |
| Tool governance | One registry, one executor, schema validation, typed blockers, no silent fallback. | `server/tools/`, `engine/src/tools/` |
| Pre-dispatch and runtime checks | Ghost-tool, schema, and loop checks before dispatch; bias, deviation, bandaid, workaround, and step-skip detectors during the stream. | `server/safety/`, `engine/src/safety/` |
| Landlock | Project-scoped confinement for spawned shell commands and stdio MCP servers on Linux. The CLI itself is not re-exec'd. Fails closed with a typed error when a confined spawn is requested and unavailable. | `engine/guardian/`, `server/safety/landlock-runner.ts`, `engine/src/filesystem/self-protection/` |
| Artifact isolation | Model-generated HTML renders in a sandboxed iframe without same-origin access. | `src/cockpit/render/ArtifactFrame.svelte` |
| Append-only recording | The timeline rejects mutation at the application layer and chains each record locally. | `engine/src/timeline/` |
| Explicit commits | `git_commit` is exposed as a governance blocker; the model does not auto-commit. | `server/tools/` |

These are implemented controls, not independently verified assurances. A control can have a bug. The pre-admission state means the governance evidence is still being assembled.

## What is not protected

Be explicit about the gaps:

- **No security audit.** No third-party review, penetration test, threat-model review, or certification has been completed.
- **No audit log for compliance.** The timeline is an application record with a local hash chain. It is not a cryptographically signed, externally anchored, tamper-evident compliance log. A local attacker who can write the database can rewrite the chain; a removed suffix may not be detectable locally.
- **No protection from the local user or root.** The key home is readable by the account that runs the server. Malware under the same account can take the database, the keys, and the process memory.
- **No multi-tenant hardening.** Users are modeled, and data is scoped, but isolation between mutually distrusting tenants has not been audited. Do not expose one instance to a team, a hostile network, or the public internet.
- **No remote-deployment story.** There is no TLS termination, reverse-proxy hardening guide, SSO, or network access control. `HARNESS_WEB_HOST` exists as an environment override; changing it does not make the server safe to expose.
- **No guarantee that redaction catches every secret.** Redaction is pattern- and classification-based. It can miss a secret in an unusual format and can redact ordinary text. It is a risk reduction, not a data-loss-prevention product.
- **No control over the provider.** The provider receives the request. Its logging, retention, training, and jurisdiction are governed by your agreement with that provider, not by Bridlewise.
- **No confinement of MCP servers or extensions.** Operator-installed integrations are third-party code and run outside the engine's core guarantees. A configured MCP server can see what it is given and can return hostile content.
- **No signed releases or provenance attestation.** There are no binaries, installers, or signed tags. Dependencies are not audited by this project.
- **No backup or recovery guarantee.** Back up the key home and the database yourself. A database copy without its key is unreadable. There is no hosted recovery.
- **No denial-of-service protection.** A local process can exhaust CPU, memory, or disk; the preview is not hardened against resource attacks.
- **No macOS or Windows filesystem confinement.** Landlock is Linux-only. WSL2 support depends on the host kernel and Landlock ABI; when the feature is unavailable, the guardian fails closed rather than running unrestricted.

## Keys, encryption, and backups

The web database uses application-level field encryption. The key is either a persisted random 32-byte file or, if `HARNESS_WEB_DB_KEY` is set, an scrypt-derived key over a random per-database salt. Key material lives in the key home:

1. `HARNESS_KEY_HOME`, if set;
2. otherwise `$XDG_CONFIG_HOME/bridlewise/keys`;
3. otherwise `~/.config/bridlewise/keys`.

The key home is mode `0700`; key files are created with restrictive permissions. It is deliberately outside every checkout, state folder, and project. Do not copy it into the repository, a container image, a support ticket, or a chat.

**Back it up before you need it.** The database's own backups and pre-migration copies do not contain the key. Without the key home, the encrypted columns are unrecoverable. If an older install keeps `db-key` beside its database, the server refuses to start until the key is relocated with the documented `npm run db-key -- relocate --db <database>` operation. Do not improvise a move with `mv`; the key is proven against the database first.

Encryption at rest is field-level, not whole-file. The SQLite file still contains plaintext identifiers, timestamps, status, roles, and query indexes. Protect the file with filesystem permissions and full-disk encryption.

## Redaction

Redaction runs at one owner before content leaves the process for the model, and in the display path before content is rendered back. It covers the known secret catalogue and personal-data patterns, and it is taught the harness's own credentials. It does **not** make a repository safe to send, and it does **not** replace a deliberate decision about what the provider is allowed to see.

If you are evaluating Bridlewise with a repository that contains real credentials, stop. Use a synthetic repository. Rotate any key that may have been sent to a provider during an experiment.

## Landlock: what it does and does not do

The guardian applies a Linux Landlock ruleset to itself and `exec`s the payload. The restriction is irrevocable and inherited across `fork`, `exec`, and `clone`. The web server uses the guardian per spawned shell command and per stdio MCP server, confining the process and its descendants to the selected project. The CLI itself is not re-exec'd under the guardian; `preflight`, `quality`, and `harness` run as ordinary Node processes even when self-protection is enabled. A missing binary or unsupported kernel is a typed refusal when a confined spawn is requested; it is not silently skipped.

The limits:

- **Filesystem only.** Landlock restricts filesystem access. It is not a network firewall, a seccomp filter, a user namespace, or a VM. A confined process with network access can still send data out.
- **Linux only.** macOS and Windows do not get this boundary. WSL2 depends on the host kernel; check the ABI before relying on it.
- **Path-based.** The ruleset is compiled from configured paths. A mount, link, or path that is inside an allowed subtree is reachable unless the policy excludes it. The guardian has explicit keep-out checks, but the policy is only as good as its configuration.
- **The local user can change the policy.** The config is read from the checkout. The runtime validates mode and ownership, but an attacker with your account can edit the config before launch. Self-protection is not a defense against the operator.
- **Development commands are exempt.** Non-`chat` engine commands (`preflight`, `harness`, `quality`) must read `src/`; they run unprotected with a warning even when self-protection is enabled. They are development and CI tooling, not a confined runtime.
- **The server is a separate process.** The server calls the engine through its source import path in this preview. Confinement is applied per spawned command or stdio MCP server, not to the whole server process. Do not assume every server code path is under the guardian.

## Loopback, local processes, and the browser

The default server is a local HTTP service. It is not encrypted with TLS because it is not intended for a network. Loopback traffic can still be observed by a process with sufficient privilege; a browser extension with broad permissions can read page content. Keep the machine trustworthy.

The session cookie is HttpOnly and SameSite=Lax, and the server checks the `Host` header for loopback. CSRF is enforced with a custom header. These controls reduce cross-site request risk; they do not protect against a local attacker or a compromised browser.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Public issues are for reproducible, non-sensitive bugs.

Security contact: use **[GitHub private vulnerability reporting](https://github.com/LLM-4-People/bridlewise/security/advisories/new)**. Do not include exploit details in a public issue.

Include, when possible:

- the commit or version you tested;
- the operating system and kernel (for Landlock issues);
- a minimal reproduction that does not contain real secrets or private code;
- the impact you believe it has, and whether it requires a local account, a malicious repository, or a malicious provider;
- whether you are willing to be credited.

There is **no bug bounty** and **no response-time guarantee**. This is a pre-1.0 preview maintained without a support contract. If you need a coordinated disclosure timeline, say so in the first message; do not publish details before a fix or mitigation is available.

## Safe-use checklist

- [ ] I am using a disposable copy of a repository, not production or client code.
- [ ] I have removed or rotated real credentials from the environment.
- [ ] I have backed up the key home and the database, and I know where both are.
- [ ] I am using a provider I trust with the content I am sending.
- [ ] I have read the warning and the known gaps above.
- [ ] I am not exposing the server to a network or to untrusted users.
- [ ] I have a clean git state or a separate copy I can discard.

If you cannot check every box, do not run Bridlewise on that repository.

## Related

- [Architecture]({{ '/architecture/' | relative_url }}) — the trust boundary and data flow.
- [Quickstart]({{ '/quickstart/' | relative_url }}) — installation, key home, and troubleshooting.
- [Roadmap]({{ '/roadmap/' | relative_url }}) — the gaps that are known and not yet closed.
- [SECURITY.md](https://github.com/LLM-4-People/bridlewise/blob/main/SECURITY.md) — the repository policy.
