# Privacy

The privacy domain: PII and secret detection, classification, the data-egress policy, and the redaction engine that keeps sensitive content from reaching the model or the user.

## What each file does

- `benign-grammars.ts` — the benign-grammars module.
- `classification-catalog.ts` — the classification-catalog module.
- `credential-lexicon.ts` — the credential-lexicon module.
- `data-policy.ts` — the data-policy module; owns `safePercentDecode`, THE
  engine's one percent decoder (lenient, the WHATWG percent-decode: every run
  of `%XX` escapes that is valid UTF-8 is decoded, everything else is kept as
  written — never all-or-nothing; `test/prevention/percent-decoder-owner.test.ts`
  refuses a second one).
- `detection-span.ts` — the detection-span module.
- `evidence-handler.ts` — the evidence-handler module.
- `encrypted-field.ts` — THE field codec (`enc:` + AES-256-GCM): every call names the associated data it binds the value to, and the codec owns the ENCODING (`fieldAad(domain, parts)`, canonical JSON over the closed domain registry `bw-field-v1`/`bw-memory-v1`/`bw-secret-v1`/`bw-setting-v1`). The web database binds table, column, row, parents and owning user (`server/db/db-crypto.ts`); a ledger document sealed to its owner (a memory entry) uses `ownerSealAad` (metadata `userId` + `sealId`), which the operational projection also uses to keep that ciphertext intact. `UNBOUND_FIELD` is only for entries written before binding.
- `file-viewer.ts` — the file-viewer module.
- `held-set.ts` — THE values one operation holds (cred-final §2.1): a typed, labelled, frozen `HeldSet` (`provider:<id>`, `request:credential`, …) threaded instead of string lists; it owns THE HELD FLOOR (a2b-design H1: `DEFAULT_HELD_MINIMUM_LENGTH` in `secret-intelligence.ts`, or the policy's `privacy.heldCredentialMinimumLength`, 1..12 enforced by `createPrivacyPolicy`): a value below it stays in `values()` for exact slot replacement but is never searched for in text (`matched()`), counted (`privacy.heldSlotOnlyCount`) and audited by label (`privacy.held-slot-only`); a merge keeps the receiver's floor; with `scrub`, `scrubStrings`, `scrubAcrossTextParts` (a value split across two output items or content parts), a streaming scrubber that holds back only a suffix that could still grow into a held value, and keyed piece streams. The LLM client masks EVERY chunk of a run with it (tool-call argument deltas, native events, the raw resource), so a user's echoed key reaches no egress or storage path.
- `identity-grammars.ts` — the identity-grammars module.
- `pii-registry.ts` — the tiers and types of detection and their live switches, with a FLOOR no switch passes: the `known-values` tier and the `known-secret` type (the harness's own credentials) cannot be turned off (`privacy_floor_refused`).
- `operational-redaction.ts` — infrastructure composition that authenticates ciphertext with a held key before preserving its exact intervals in stored public text.
- `privacy-config-section.ts` — the privacy config section (the document's `privacy` schema, its safety floors, and the config door that turns a parsed section into policy options).
- `privacy-config.ts` — the privacy-config module.
- `privacy-policy.ts` — the privacy-policy module.
- `redacted-messages.ts` — the redacted-messages module.
- `responses-observation.ts` — bounded, immutable public observations of untrusted native response resources/events and input-item pages; private wire/replay resources remain separate.
- `redaction-engine.ts` — the redaction-engine module.
- `secret-files.ts` — THE secret-file owner: a file whose name says it holds credentials (env files, private keys, registry/netrc/cloud credential files) reaches a model with every value redacted and every key visible (a key is identifier-shaped or quoted; a comment's body is read like a line, so a commented-out setting keeps its key and other comment text is hidden; a section keeps its name, an argument only when it is plain words; a padded base64 run, a YAML block scalar and an indented PEM body are values); asked by the file viewer and the server's read_file/search_code.
- `secret-intelligence.ts` — the known-secret layers. The PROCESS-WIDE registry holds only the harness's own secrets (its startup environment secrets, keys); a request's or a user's values (URL passwords, provider keys and header values) are held for their own call only, and an MCP server's credentials for that server's own output only (its client door, `server/integrations/mcp-runtime-bridge.ts` `mcpServerClient`: descriptions, results, errors, stderr; INTERIM until CRED-3/CRED-7) — the mint's and the client's held lists — so one user's value never shapes another user's text, and a refused own-credential registration is logged, never silent.
- `secret-signals.ts` — the sensitive-name and secret-shape questions (`isSensitiveKeyName`, `hasSecretTextSignal`).
- `secret-parts.ts` — THE ONE write-only secret primitive (MCP servers and the config view today; the generated settings UI's secret fields and the credential vault's SecretField tomorrow): a scalar secret is never served and an empty write keeps it (`keepScalar`); a URL or an argument list is served with each secret PART as a keep mark naming its place (`concealUrl`, `concealArguments`, deny by default), and a mark sent back keeps that part only in its own place and only while the context is unchanged: the restored value equals the saved one (the whole URL — origin, path, query — or every argument: a launcher's package or script is an argument) and the caller's part (transport, command, read paths) is the same (`restoreUrl`, `restoreArguments`, sec-e H-2). It also owns THE ONE RAW URL SPLITTER (`splitUrl`: offsets into the text as written, the userinfo ending at the authority's LAST `@`, working on URLs no parser accepts) and `urlCredentialSpellings`, the credentials a URL carries in every spelling a text can carry them — the concealment's own CREDENTIAL parts (the password; a username-only userinfo; a secret-shaped username; secret-shaped path segments, query and fragment values or credential-named ones — never prose), read as written AND as a URL parser reads it (a leading space, a tab in the scheme, `https:\\`, missing slashes), raw, tab/newline removed, form-decoded `+`, and percent-decoded at most `privacy.urlDecodeLevels` times (default 2; linear in the URL, a2b H-1) — what the request mint (`responses-redaction.ts`) holds for a URL slot. An attached flag value (`-pSECRET`) is concealed as `attached:-p#<n>`.
- `text-normalize.ts` — NORMALISE BEFORE MATCHING — the fix that is invisible until it is not.
- `value-intrinsic.ts` — the value-intrinsic module.

## Operational text projection

The domain redaction engine owns full-text detection and context candidate adjustment. Ordinary context keeps its existing overlap order. The operational infrastructure requests unselected candidates, authenticates complete encrypted-field tokens, subtracts only those proven intervals and then reuses the shared overlap/application owners. This redacts secrets in adjacent plaintext while preserving authenticated ciphertext, even when the detection candidates overlap. Invalid tags, malformed padding and an `enc:` prefix alone grant no protection. No public redaction option accepts arbitrary safe ranges. Nothing here decrypts the ledger's sealed originals: their one door is the timeline store's `originalDocuments` (opened with the store key, verified against the recorded digest), which rollback uses to restore a masked pre-image exactly.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/privacy/`.

- `benign-grammars.ts` is consumed by `engine/src/privacy/secret-intelligence.ts`, `engine/src/privacy/value-intrinsic.ts`, `server/llm/redaction.ts`.
- `classification-catalog.ts` is consumed by `engine/scripts/tooling/s1-verification.ts`, `engine/src/kernel/config-contracts.ts`, `engine/src/kernel/root-policy.ts`, `engine/src/privacy/data-policy.ts`, `engine/src/privacy/privacy-config-section.ts`, `engine/src/privacy/privacy-config.ts` and 2 more.
- `credential-lexicon.ts` is consumed by `engine/src/privacy/benign-grammars.ts`, `engine/src/privacy/redaction-engine.ts`, `engine/src/privacy/secret-intelligence.ts`, `engine/src/shared/exposure/registrations/privacy.ts`.
- `data-policy.ts` is consumed by `engine/src/kernel/preflight.ts`, `engine/src/privacy/secret-parts.ts`, `engine/src/workflow/record-links.ts`.
- `detection-span.ts` is consumed by `engine/src/privacy/identity-grammars.ts`, `engine/src/privacy/pii-registry.ts`, `engine/src/privacy/redaction-engine.ts`, `engine/src/privacy/secret-intelligence.ts`, `engine/src/privacy/value-intrinsic.ts`.
- `encrypted-field.ts` is consumed by `engine/src/privacy/operational-redaction.ts`, `server/kernel/canonical.ts`.
- `evidence-handler.ts` is consumed by `engine/src/workflow/checkout-setup.ts`, `engine/src/workflow/flake-cli.ts`.
- `file-viewer.ts` is consumed by `engine/src/runtime/tool-registry.ts`.
- `held-set.ts` is consumed by `engine/src/privacy/redacted-messages.ts`, `engine/src/privacy/redaction-engine.ts`, `engine/src/privacy/responses-observation.ts`, `engine/src/privacy/responses-redaction.ts`, `engine/src/shared/llm/client.ts`, `engine/src/shared/llm/failover.ts` and 6 more.
- `identity-grammars.ts` is consumed by `engine/src/privacy/pii-registry.ts`, `engine/src/privacy/redaction-engine.ts`.
- `operational-redaction.ts` is consumed by `engine/src/timeline/timeline-store.ts`.
- `pii-registry.ts` is consumed by `engine/src/privacy/held-set.ts`, `engine/src/privacy/redaction-engine.ts`, `engine/src/shared/exposure/registrations/privacy.ts`, `engine/src/shared/llm/responses-preparation.ts`, `server/llm/redaction.ts`.
- `privacy-config-section.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `engine/src/performance/benchmark-cli.ts`, `server/kernel/canonical.ts`.
- `privacy-config.ts` is consumed by `engine/src/privacy/pii-registry.ts`, `engine/src/privacy/privacy-config-section.ts`, `engine/src/privacy/privacy-policy.ts`, `engine/src/shared/exposure/registrations/privacy.ts`.
- `privacy-policy.ts` is consumed by `engine/src/performance/benchmark-cli.ts`, `engine/src/performance/benchmark-runner.ts`, `engine/src/privacy/evidence-handler.ts`, `engine/src/privacy/file-viewer.ts`, `engine/src/privacy/operational-redaction.ts`, `engine/src/privacy/pii-registry.ts` and 15 more.
- `redacted-messages.ts` is consumed by `engine/src/shared/llm/client.ts`, `engine/src/shared/llm/provider-http.ts`, `engine/src/shared/llm/responses-preparation.ts`, `engine/src/shared/llm/responses-tracking.ts`.
- `redaction-engine.ts` is consumed by `engine/src/performance/benchmark-runner.ts`, `engine/src/privacy/evidence-handler.ts`, `engine/src/privacy/file-viewer.ts`, `engine/src/privacy/operational-redaction.ts`, `engine/src/privacy/redacted-messages.ts`, `engine/src/privacy/responses-observation.ts` and 8 more.
- `responses-observation.ts` is consumed by `engine/src/runtime/provider-adapter.ts`, `engine/src/runtime/response-turn.ts`, `engine/src/shared/llm/client.ts`, `engine/src/shared/llm/provider-http.ts`, `server/context/context-bridge.ts`.
- `responses-redaction.ts` is consumed by `engine/src/privacy/redacted-messages.ts`, `engine/src/privacy/responses-observation.ts`, `engine/src/shared/llm/provider-observation.ts`.
- `secret-files.ts` is consumed by `engine/src/privacy/file-viewer.ts`, `engine/src/timeline/timeline-store.ts`, `server/intelligence/content-search.ts`, `server/tools/tool-executor.ts`.
- `secret-intelligence.ts` is consumed by `engine/src/privacy/held-set.ts`, `engine/src/privacy/privacy-config-section.ts`, `engine/src/privacy/privacy-policy.ts`, `engine/src/privacy/redaction-engine.ts`, `engine/src/privacy/responses-observation.ts`, `engine/src/privacy/responses-redaction.ts` and 3 more.
- `secret-parts.ts` is consumed by `engine/src/privacy/responses-redaction.ts`, `server/integrations/mcp-bridge.ts`, `server/routes/config.ts`.
- `secret-signals.ts` is consumed by `engine/scripts/tooling/verification/artifact-admission.ts`, `engine/src/kernel/requirements.ts`, `engine/src/performance/performance-config.ts`, `engine/src/privacy/data-policy.ts`, `engine/src/privacy/privacy-policy.ts`, `engine/src/privacy/redaction-engine.ts` and 7 more.
- `text-normalize.ts` is consumed by `engine/src/privacy/redaction-engine.ts`, `engine/src/privacy/secret-intelligence.ts`.
- `value-intrinsic.ts` is consumed by `engine/src/privacy/redaction-engine.ts`, `engine/src/privacy/secret-intelligence.ts`, `engine/src/shared/exposure/registrations/privacy.ts`.

<!-- /consumers:generated -->
