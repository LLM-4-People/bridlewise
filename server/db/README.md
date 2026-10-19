# Db

The persistence layer: the single owner of all reads and writes to the web-slice SQLite projection — schema, migrations, encryption at rest, and the threaded access facade.

Custody attribution uses `runAttributionsForProject` through the threaded facade: a caller/project-scoped query reads canonical run IDs, visible chat titles and the first user request for each run. Its window counts every user row, including rows without a run ID. It avoids decrypting assistant bodies or metadata; global ownership still comes from `allRunIdsForUser`. Both reads retain the normal reader barrier.

## What each file does

- `async-client.ts` — THE ASYNC DATA-ACCESS FACADE — the seam the performance design asks for.
- `bootstrap-key.ts` — process-lifetime admission of one root key and its exact configured database/key source; it admits the key home ONCE (`serverKeyHome`, through the one admission: the harness checkout, the system temp folder, both database folders, this repository and the declared project roots are its neighbours), registers the timeline as a harness store sealed with the web database's key (the registry's pairing), and serves the registry (`serverStoreRegistry`) to the keep-out list.
- `client.ts` — Thin SQLite DB client wrapping `node:sqlite` for the web-slice projection.
- `db-crypto.ts` — Database field encryption — app-level encryption-at-rest for sensitive columns (AES-256-GCM). `ENCRYPTED_COLUMNS` is the one list; every value is bound (the codec's `fieldAad("bw-field-v1", …)`) to its table, column, row, parents and OWNING USER, and every read and write goes through the row doors `openRow`/`sealRow` (a column added to the list is encrypted everywhere). `memoryBinding` seals memory content to its owner and seal id; `ownedRowsSql` gives bulk readers each row's owner.
- `db-files.ts` — the writers of a database's copies: `writeVerifiedCopy` (the ONE proven copy: never through a link, private staging name, `quick_check` + the caller's content check, then moved into place — the pre-migration and pre-re-key copies) and the copies' own files. The NAMES live in `engine/src/filesystem/database-files.ts`.
- `key-tool.ts` — the key tool as a host runs it: the exposure module `database`'s admin actions `database.key.relocate|scan|forget|rekey` and signals (`database.keyHome` for admins, `database.registeredStores`, `database.legacyKeysFound`) over `key-rotation.ts`, with the host's admitted key home and passphrase; installed at boot (`"server"`) and by the `npm run db-key` shell (`"shell"`), which runs the same actions. The scan's walk (`findLegacyInstalls`, bounded by `legacyInstalls.scanFolderBudget`, saying `truncated` when it stops there) runs in a worker thread (`key-scan-worker.ts`, the one pool) on both hosts; `relocate` and `rekey` are the shell's only — installed through the one shell-operation slot (`installDatabaseShellOperations`, shared with the conversation archive); the server refuses them `database_action_shell_only` (428), naming the command to run with it stopped (sec-e-design H3, SCALE-CR1-FIX M7).
- `key-scan-worker.ts` — the key tool's scan off the event loop: the bounded, read-only walk for installs still keeping a key beside their database (`findLegacyInstalls`) in a worker thread of the one pool; the calling thread registers what it found.
- `key-rotation.ts` — the key's lifecycle tool behind `npm run db-key`: relocate ONE install's key (and passphrase salt) into the key home after PROVING it opens the database (a database with nothing sealed needs `--force-empty`); scan folders for installs still keeping a key beside their database and REGISTER them (never move a key: another checkout still reads its own; one outcome per install); forget a deleted store; and re-key (a new key, or a new random salt retiring the old shared one) after a verified pre-re-key copy, keeping each retired key in a slot of its own (its fingerprint), so every earlier copy still opens after any number of re-keys — refused while another process holds the database (the tool leaves WAL and holds it exclusively) and while a timeline sharing the key (the registry's pairing) holds history; a staged key refuses every open until a re-run finishes it.
- `db-worker.ts` — ONE DATABASE THREAD.
- `index.ts` — Singleton DbClient instance for the web-slice server process.
- `json-columns.ts` — Strict stored JSON decoding and trap-free structural admission for opaque native metadata and tool projections.
- `method-kinds.ts` — WHICH DbClient METHODS READ, AND WHICH WRITE — stated once, mechanically.
- `migrations.ts` — Versioned migration runner for the web-slice SQLite projection. Migrations are facts about the past: v19 and v20 carry their own frozen copies (v20: `V20_ENCRYPTED_COLUMNS`, `v20Binding`, golden-tested), never the live list; v20 is idempotent and refuses a database that mixes bound and unbound values (a planted pre-v20 copy is never sealed to its new row).
- `schema.ts` — Web-slice projection schema (SQLite).
- `thread-backend.ts` — THE SHAPE UNDERNEATH THE FACADE: a read pool and one writer.
- `wire.ts` — THE MESSAGE FORMAT BETWEEN THE FACADE AND ITS DB THREADS.
- `conversation-archive.ts` — THE ONE DOOR THAT REMOVES CONVERSATIONS (UD-S15): `archiveConversations` proves the server stopped (`holdDatabaseAlone`), keeps a verified `<db>.pre-archive` copy, writes every row the trashed conversations own (`DbClient.conversationRows`, sealed fields as stored) to one 0600 archive in `<db>.archive/`, proves it row by row (`verifyConversationArchive`), and only then removes them (`DbClient.purgeConversations`: trashed only, all or none, the refuse-delete triggers lifted and re-created inside the one transaction). Run by the development root package's `db-archive` script (not installed in the product projection) (the `database.conversations.archive` action, a shell operation; the server refuses it `database_action_shell_only`); the removal is an audit event (`database.conversations.archived`).

## Native evidence storage

Schema v18 encrypts provider call IDs and tool names with the existing `DbCrypto`, alongside arguments, results, message metadata and the typed `public_projection` derivative. Clone mints local row IDs and preserves original decoded provider identities and empty results. Private `providerEvidence` and `providerObservation` metadata are excluded by the positive public metadata schema. This storage contract does not certify the later public tool-view or native replay composition.

Opaque native metadata and tool projections are snapshotted before schema parsing and before the async facade's structured-clone boundary with the canonical forensic depth/node ceiling. Getters, proxies, cycles, non-JSON values and negative zero (whose sign `JSON.stringify` loses) refuse without writes. Undefined optional outer fields are absent; nested undefined is invalid. Immutable input wrappers prevent another schema field from replacing admitted evidence. There is no additional DB byte cap. Other existing JSON input contracts are unchanged. Stored malformed JSON, noncanonical ciphertext, authentication failure and nonempty plaintext in an encrypted field produce fixed typed errors; reads do not replace the stored bytes. A metadata update acknowledges exactly one directly affected SQL row, not a filesystem durability guarantee.

Encryption writes accept plaintext, including literal `enc:` strings and valid ciphertext supplied as plaintext. Only versioned migrations interpret existing encrypted storage. The v18 migration authenticates existing tool inputs/results before converting identities; a wrong key rolls back schema and bytes. Failed initialization closes its SQLite connection. Historical pre-v5 `enc:`-prefixed values remain ambiguous and may be unavailable under strict decoding; this change does not recover lost keys or rewrite that data. Since v20 every field is bound to its table, column, row, parents and owning user (`db-crypto.ts` `fieldBinding`).

## Key and worker startup

The production database, memory and timeline openers consume one admitted root key capability, including in-memory configuration. Native workers receive a cloned `KeyObject` through dedicated startup data and construct their local codec; keys are not exported as raw bytes or passed through database RPC replies. A later conflicting source configuration refuses. Independent database pools retain independent explicit admission rather than inheriting the production singleton accidentally.

The field codec preserves the existing `enc:` AES-GCM format and passphrase derivation. It remains separate from forensic associated-data sealing. A key (or passphrase salt) is minted ONLY where no ciphertext can be orphaned (`resolveDatabaseKey`): a missing database, one that never reached the first encrypting migration (`FIRST_ENCRYPTED_SCHEMA_VERSION`, v5 — a v4 install upgrading), or one whose encrypted columns hold nothing yet. A v5+ database that holds ciphertext only loads: its missing key is refused (`persisted_key_missing`), never replaced, and so is the key of an install whose old key still sits beside it (relocate it). Read-only connections only load. The configured `HARNESS_WEB_DB_BUSY_TIMEOUT_MS` (validated once, by the config owner) is applied before anything else, including the key probe's own connection; WAL is entered through the WAL owner (`engine/src/filesystem/sqlite-wal.ts`), which waits for a concurrent first opener that SQLite refuses without the busy handler. The registry read and every pending migration share one `BEGIN IMMEDIATE` (applied in version order), and read-only connections read that same version (`readSchemaVersion`).

Worker startup failure joins every acquired worker, including partial readers and pre-ready exits. A fatal worker failure refuses future calls. Read barriers wait for the contiguous settled-write prefix; a later clone/send failure cannot release reads past an earlier pending write. Close stops new admissions, drains admitted work and joins the graceful close. An explicit reader count must be a positive safe integer; the existing default sizing bounds are unchanged and a one-reader override remains supported.

Checkpoint results distinguish completion, incomplete progress, no applicable WAL and failure. Timer intervals are best-effort cadence, not maximum crash-loss bounds.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/db/`.

- `async-client.ts` is consumed by `server/auth/user-context.ts`, `server/blocks/anatomy.ts`, `server/blocks/arm.ts`, `server/blocks/breaker.ts`, `server/blocks/checks.ts`, `server/blocks/client-telemetry.ts` and 48 more.
- `bootstrap-key.ts` is consumed by `server/context/memory-bridge.ts`, `server/db/index.ts`, `server/db/key-tool.ts`, `server/observability/timeline-bridge.ts`, `server/safety/host-facts.ts`.
- `client.ts` is consumed by `server/blocks/breaker.ts`, `server/context/chat-history.ts`, `server/db/async-client.ts`, `server/db/conversation-archive.ts`, `server/db/db-worker.ts`, `server/db/index.ts` and 4 more.
- `conversation-archive.ts` is consumed by nothing yet.
- `db-crypto.ts` is consumed by `server/context/memory-bridge.ts`, `server/db/bootstrap-key.ts`, `server/db/client.ts`, `server/db/db-worker.ts`, `server/db/index.ts`, `server/db/key-rotation.ts` and 2 more.
- `db-files.ts` is consumed by `server/db/conversation-archive.ts`, `server/db/key-rotation.ts`, `server/db/migrations.ts`.
- `db-worker.ts` is consumed by `server/db/thread-backend.ts`.
- `index.ts` is consumed by `server/index.ts`.
- `json-columns.ts` is consumed by `server/db/async-client.ts`, `server/db/client.ts`.
- `key-rotation.ts` is consumed by `server/db/key-tool.ts`.
- `key-scan-worker.ts` is consumed by nothing yet.
- `key-tool.ts` is consumed by `server/index.ts`.
- `method-kinds.ts` is consumed by `server/db/db-worker.ts`, `server/db/thread-backend.ts`.
- `migrations.ts` is consumed by `server/db/client.ts`, `server/db/key-rotation.ts`.
- `schema.ts` is consumed by `server/db/async-client.ts`, `server/db/client.ts`, `server/db/db-crypto.ts`, `server/db/key-rotation.ts`, `server/db/migrations.ts`, `server/filesystem/fs-gate.ts` and 2 more.
- `thread-backend.ts` is consumed by `server/db/async-client.ts`, `server/db/index.ts`.
- `wire.ts` is consumed by `server/db/db-worker.ts`, `server/db/thread-backend.ts`.

<!-- /consumers:generated -->
