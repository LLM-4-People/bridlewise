# Security policy

> [!WARNING]
> Bridlewise is an experimental developer preview. It has not been security-audited, it is not production-ready, and it must not be used with sensitive, proprietary, regulated, or production codebases. Run it against disposable copies.

## Supported versions

There are no supported production versions. `main` is the only public development branch, and every release is a preview.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability.

Use GitHub's **private vulnerability reporting** for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected revision, a reproduction, the impact, and any suggested fix.

If private reporting is unavailable, open a minimal public issue that asks the maintainers for a private channel, without including exploit details, credentials, or private data.

We aim to acknowledge reports within a reasonable period, but this is a volunteer, pre-1.0 project and no response SLA is offered.

## Security model, in one page

What the design attempts to provide:

- The API server binds to loopback by default and checks the request `Host`.
- Session cookies are HttpOnly; unsafe requests require a custom CSRF header.
- Passwords are hashed with scrypt; session tokens are stored as hashes.
- Sensitive database fields are encrypted at rest with AES-256-GCM.
- Database keys live outside the checkout under the user's key home.
- PII and secret-like content are redacted at the model-egress choke point.
- Tool calls pass through a governed registry and typed refusal paths.
- On Linux, spawned commands and stdio MCP servers can be confined with Landlock.
- Runs and effects are recorded in an append-only, hash-chained timeline.

What it does **not** provide:

- A security audit, penetration test, or formal threat model review.
- A hardened multi-tenant deployment.
- Protection against a malicious model provider, a compromised host, or an attacker with the user's OS account.
- Network confinement. Landlock confines filesystem access, not egress.
- A guarantee that redaction catches every secret or every personal identifier.
- A guarantee that every destructive action is reversible.
- Production support, an incident-response team, or a disclosure SLA.

## Handling secrets

- Never commit provider keys, database keys, `.env` files, tokens, or private keys.
- Store provider credentials through the application's provider settings, not in source.
- Keep the database key home outside the repository.
- If you believe a credential was exposed, revoke and rotate it first. Removing a commit does not undo exposure.
- The public snapshots were rebuilt from clean trees; the private development history is not published.

## Safety expectations

Use a disposable copy of a repository. Assume data loss is possible. Assume the model can make incorrect or destructive suggestions. Inspect the run record before trusting an outcome. Do not point Bridlewise at a codebase you cannot afford to lose or disclose.
