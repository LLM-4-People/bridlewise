/**
 * The error taxonomy — ONE code set, shared by the server and the client.
 *
 * WHY THIS EXISTS
 *
 * The two sides had entirely separate error vocabularies with **zero
 * overlap**:
 *
 *   - the server (`server/errors.ts`) raises precise typed codes —
 *     `path_traversal`, `preimage_mismatch`, `already_exists`,
 *     `csrf_blocked`, `not_found` — and maps each to an HTTP status;
 *   - the client (`src/data/error-messages.ts`) only ever saw
 *     `network`, `timeout`, `parse`, `malformed`, `stream_closed`, and
 *     `http_<status>`.
 *
 * The reason for the gap was a single line in `fetchJson`: the server sends
 * `{ error: "<code>", message }`, and the client read `message` while
 * DISCARDING `error`, synthesising `http_${res.status}` instead. So the
 * server's careful distinctions collapsed into the HTTP status on the way
 * across the wire — `path_traversal`, `forbidden` and `csrf_blocked` all
 * arrived as `http_403`, and the client, having no case for them, fell
 * through to a generic message.
 *
 * That is the "one registry, many projections" rule broken at the error
 * layer: the taxonomy existed, and the projection threw it away.
 *
 * Both sides now import this module. The server maps a code to an HTTP
 * status; the client maps the same code to a human message. Neither invents
 * its own vocabulary, and a code added here is available to both at once.
 */

/**
 * Transport-level codes the CLIENT originates. These never come from the
 * server — they describe a failure that happened before or instead of a
 * response.
 */
export const TRANSPORT_CODES = [
  /** The request never reached the server (offline, DNS, refused). */
  "network",
  /** The request was aborted after exceeding the client timeout. */
  "timeout",
  /** A 2xx response body was not valid JSON. */
  "parse",
  /** A response or event payload did not match the expected shape. */
  "malformed",
  /** An SSE stream ended unexpectedly. */
  "stream_closed",
  /** An SSE stream reported an error. */
  "stream_error",
] as const;
export type TransportCode = (typeof TRANSPORT_CODES)[number];

/**
 * The statuses that mean "the server DECLINED, on purpose, and said why" —
 * the PRINCIPLED REFUSAL family, owned here so the two sides cannot disagree
 * about what counts as one.
 *
 * 428 is the guided-state family (something the USER must do first — the
 * server names the remedy and will keep answering the same way until it is
 * done); 503 with a typed code is the server's own self-protection (it chose
 * not to perform the operation — `git_not_run` is the canonical case). Both
 * carry the server's own sentence in the message, and both are the response
 * grammar's REFUSED state, never its FAILED one — which is also why the
 * block read route serves them in the 200 envelope as data: a designed
 * refusal that travels as an error status lands in the browser's console as
 * a resource error on every boot, before any page code runs.
 */
export const PRINCIPLED_REFUSAL_STATUSES = [428, 503] as const;
export type PrincipledRefusalStatus = (typeof PRINCIPLED_REFUSAL_STATUSES)[number];

/**
 * Code → HTTP status. The SINGLE mapping table, owned here so the server can
 * map an outgoing error and the client can reason about an incoming one
 * without a second copy.
 *
 * Codes whose error class declares an explicit `statusCode` (AuthError=401,
 * ForbiddenError=403, ConflictError=409, NotFoundError=404,
 * BadRequestError=400, PathTraversalError=403, BodySizeLimitError=413)
 * bypass this map — their declared status always wins.
 *
 * Deny-by-default: the map is exhaustive. A code that is not here falls
 * through to 500, which is deliberately loud rather than a silent
 * undocumented status.
 */
export const CODE_STATUS_MAP: Readonly<Record<string, number>> = Object.freeze({
  // ValidationError default code — a validation failure is ALWAYS a client
  // error (400), never a 500. Latent bug (EHC-22) found by the consistency
  // audit: every current caller passes an explicit code (path_traversal,
  // file_not_found, …), so the default "validation_failed" was never
  // thrown — but a future caller using `new ValidationError("msg")` with no
  // code would have fallen through to a misleading 500. Mapped here so the
  // default is correct by default (deny-by-default completeness).
  validation_failed: 400,
  // editor-bridge / filesystem validation codes
  path_traversal: 403,
  // A file inside the project that is ALSO reachable from outside it (a second
  // hard name for the same bytes). Refused for the same reason as a traversal
  // and reported separately, because "outside the project" would be a
  // confusing thing to say about a path that really is inside it.
  path_second_name: 403,
  // A file inside a harness state folder (`.bridlewise/`: a database, its key,
  // a ledger) — never project content (fs-gate resolveWithinProject, CRED-F11).
  path_harness_state: 403,
  // A file on the keep-out list that is not harness state: a credential store
  // of any home (`~/.ssh`, a browser profile, a Windows profile's `.aws` on
  // WSL), the key home, another checkout's registered database (fs-gate
  // resolveWithinProject's keep-out verdict, SEC-d).
  path_credential_store: 403,
  file_not_found: 404,
  not_a_file: 400,
  file_too_large: 400,
  preimage_mismatch: 409,
  empty_preimage: 400,
  no_change: 400,
  already_exists: 409,
  cannot_delete_root: 400,
  // filesystem-route codes
  parent_not_found: 404,
  invalid_path: 400,
  invalid_name: 400,
  not_a_directory: 400,
  path_outside_roots: 403,
  // route-level missing-param guards (missing_path, missing_file, …)
  missing_path: 400,
  missing_file: 400,
  missing_query: 400,
  missing_symbol: 400,
  missing_event_id: 400,
  missing_action_id: 400,
  missing_customization_id: 400,
  missing_value: 400,
  // schema exposure (ui-schema.ts) codes
  unknown_customization: 404,
  unknown_action: 404,
  set_failed: 400,
  // schema action execution fallback (server/routes/schema.ts) — the
  // action rejected with no typed code. An action failure is a server-side
  // error (the action handler threw without a typed code); explicitly 500
  // so the map is exhaustive (no silent fallthrough). When the action
  // throws a typed error with a code, that code is preserved + mapped
  // individually.
  action_failed: 500,
  // config update fallback (server/routes/config.ts) — a config write
  // failed with no typed code. A config update failure is a server-side
  // error (the file write or validation failed); explicitly 500 so the
  // map is exhaustive (no silent fallthrough).
  config_update_failed: 500,
  // The config write lock could not be acquired inside the policy timeout
  // (the cross-process lock every raw config write must hold). 503, not
  // 500: the server is not faulted and the caller did nothing wrong — it
  // refused to perform an unlocked write while another process held the
  // lock, a temporary condition that retrying resolves (the error's own
  // class is retryable, and the map's 503 family is exactly "transient;
  // the current holder owns the answer"). A 500 would invite no remedy
  // where the honest one is "try again in a moment".
  config_write_lock_timeout: 503,
  // A write that would have changed the self-protection settings. 403 and not
  // 400: the request is well-formed and understood, and the answer is that
  // this server will not do it — turning the sandbox off, or widening what it
  // reaches, has to be written into the harness settings file by someone with
  // access to the machine. A 400 would invite the caller to try a different
  // spelling, which is exactly the wrong thing to suggest.
  self_protection_not_editable_here: 403,
  // workspaceIsolation.commands/phases: argv the checkout setup runs on the host,
  // never writable through the server (harness-config.ts write gate).
  workspace_commands_not_editable_here: 403,
  // A debug policy that would switch credential redaction off
  // (server/debug-bridge.ts `configureWebDebug`). 403 for the same reason as
  // the self-protection entry above: the policy is well-formed and
  // understood, and the answer is that this server will not install it —
  // deny by default on the redactor, with no spelling that changes the
  // answer.
  debug_redaction_required: 403,
  // keyset paging cursor unreadable (server/db/client.ts) — a paged history
  // read came back without the cursor column it advances on. Explicitly 500
  // because it IS a server defect (a misdeclared `PagedRead`), not anything
  // the caller did, and mapping it to a 4xx would blame the client for a bug.
  // It is a THROW rather than a silent stop on purpose: without the cursor
  // the walk would end after one page and hand back a prefix of the
  // conversation with nothing saying so, which is the silent truncation the
  // paging owner exists to make impossible. A 500 that says why beats a 200
  // that lies. Listed here so the map stays exhaustive (no fallthrough).
  paging_cursor_unreadable: 500,
  // a HISTORY CURSOR arrived that this server did not issue (server/db/
  // client.ts `decodeHistoryCursor`). 400, not 500, and the distinction from
  // `paging_cursor_unreadable` above is exactly who is at fault: that one is
  // a misdeclared server-side page walk, this one is a value the CALLER sent.
  // It is a THROW rather than a fallback to "the newest page" or "the
  // beginning", because either would hand the reader a page from somewhere
  // other than where they asked and the transcript would look like it jumped.
  history_cursor_unreadable: 400,
  // the fs-gate was asked about a project path this request never resolved
  // (server/fs-gate.ts). Explicitly 500 because it IS a server defect — a
  // route built the gate without naming a path one of its bridges would ask
  // about — and NOT 403, which is the whole point: folding it into the
  // denial would turn "nobody asked" into "you do not own it", a plausible
  // access-control answer that was never decided. A 500 that says which path
  // was never resolved beats a 403 that invents a decision.
  gate_path_undecided: 500,
  // a threaded facade was pointed at `:memory:` (server/db/async-client.ts).
  // Each worker thread would open its OWN empty in-memory database, so
  // nothing would fail — every read would simply answer from a different one.
  // A misconfiguration, hence 500, and it is refused at open (the server's
  // boot warm) rather than discovered per query.
  db_memory_not_threadable: 500,
  // the facade's connections were asked for their facts before they opened
  // (server/db/async-client.ts). 500 because it is a lifecycle defect, and it
  // is a THROW rather than a plausible blank: a schema version of 0 or an
  // empty path would be a fabricated answer to "what are you connected to".
  db_not_open: 500,
  // config path traversal guard (routes/config.ts setByPath) — the PUT
  // path traverses through a scalar leaf (a number/string/boolean/array)
  // that cannot be descended into. A client error (the admin sent a path
  // that would destroy an existing scalar value) — 400, not 500.
  config_path_traverses_scalar: 400,
  // tool-executor patch codes (client error — the LLM sent a bad patch
  // or the patch context doesn't match the file). Previously fell through
  // to 500; these are CLIENT errors, not server errors.)
  patch_malformed_header: 400,
  patch_context_mismatch: 400,
  // ProjectPathError codes (intelligence/quality/git bridges) — the
  // project path is missing, inaccessible, stale, or not a directory.
  // Previously fell through to 500; the project resource was NOT FOUND,
  // so 404 is the honest status (hides existence + matches the
  // requireProjectByPath NotFound contract).
  project_path_empty: 404,
  project_path_stale_encrypted: 404,
  project_path_missing: 404,
  project_path_not_directory: 404,
  project_path_inaccessible: 404,
  project_path_invalid: 404,
  // The copy half of a cross-device move did not land — a server I/O fault,
  // with the original reported left in place (atomic-write.ts movePath).
  move_did_not_land: 500,
  // Recycle-bin bridge codes (server/filesystem/editor-bridge.ts). A gone
  // entry is NotFound semantics — the client asked for a resource that no
  // longer exists, so 404 like the project_path_* family.
  recycle_not_found: 404,
  // The stored trash record itself is unreadable — server-held state gone
  // bad, not a client mistake. An explicit 500 over the class default:
  // loud by intent, not silent by omission.
  recycle_corrupt: 500,
  // The filesystem copy during delete-to-recycle / restore failed — a
  // server I/O fault (the original is reported left in place).
  recycle_copy_failed: 500,
  // The restore destination is occupied — a conflict with current state
  // the caller can resolve (delete or rename the occupant first), so 409
  // rather than a fault on either side.
  restore_occupied: 409,
  // ConfigError default code — the LLM/service config is invalid, so the
  // service is unavailable (503), not a generic 500. (config.ts throws at
  // startup never reach the router; llm-bridge throws in a route path.)
  config_invalid: 503,
  // A headers timeout past the request timeout, refused at boot
  // (server/kernel/config.ts): the operator's configuration, like config_invalid.
  http_headers_timeout_exceeds_request: 503,
  // The settings file exists but cannot be read or decoded (half-saved,
  // hand-edited into invalid JSON, a duplicate key, unreadable). Every
  // accessor and every save refuses rather than guess a default
  // (server/kernel/harness-config.ts). 503 — the service cannot run as
  // configured — but NOT retryable: only fixing the file helps.
  config_unreadable: 503,
  // The confinement floor refuses a grant (server/safety/landlock-runner.ts,
  // the compiler floor's one refused-paths policy and W^X). At a save — a
  // local tool server's `readPaths` — it is the admin's configuration
  // mistake, so a client refusal naming the path, never a 500.
  read_path_refused: 400,
  tool_path_overlaps_writable: 400,
  project_is_harness_source: 400,
  // ConfigError: the persisted DB encryption key file is corrupt (wrong
  // byte length). A server-side misconfiguration (the admin's key file is
  // damaged) — the client did nothing wrong. Thrown during DbClient
  // construction (startup), so it never reaches the router in practice, but
  // mapped here for exhaustiveness so no error code falls through to a
  // silent undocumented 500.
  db_key_file_corrupt: 500,
  // A row-rewriting migration could read NONE of the rows it must rewrite:
  // the key is not this database's (server/db/migrations.ts). A boot-time
  // refusal, mapped for exhaustiveness like the key-file code above.
  db_migration_undecodable: 500,
  // The pre-upgrade copy could not be made safely (a link or folder at its
  // name) or did not verify: the upgrade does not start (migrations.ts).
  db_backup_path_unsafe: 500,
  db_backup_unverified: 500,
  // Migration 20 found a database already holding bound ciphertext AND an
  // unbound value (a pre-v20 copy's ciphertext planted into a row, the
  // version lowered by an edit): it refuses to re-seal it under the row's
  // owner (migrations.ts, SEC-d). A boot-time refusal, mapped for exhaustiveness.
  db_migration_rebinding_refused: 500,
  // The key the server was handed does not open the database it is about to
  // write (server/db/client.ts, the key proof at open): refused before a row
  // is sealed under a key the right one could not read. Boot-time.
  db_key_wrong: 500,
  // THE KEY TOOL'S DESIGNED REFUSALS (server/db/key-rotation.ts, the
  // persisted-key owner and the key home, reached through the admin actions
  // `database.key.*`, the `db-key` shell and boot; sec-e-design M5): a
  // refusal with a remedy is not a server fault. 409: the database or the
  // key home is in a state that conflicts (held by another process, a key
  // that does not open it, a timeline bound to the key, another key already
  // published). 428: a guided remedy (run the shell with the server stopped,
  // prove or force an empty database, finish an interrupted re-key, upgrade
  // first, move the key). 404: the named file is not there. 503: the host
  // refuses to operate (no key tool here, an unsafe key home). 500: the
  // bytes on disk or the disk itself failed.
  // SCALE-CR1-FIX M7: ONE code for every operation only the stopped-server
  // shell runs (relocate, rekey, the conversation archive).
  database_action_shell_only: 428,
  database_key_tool_unavailable: 503,
  db_key_database_missing: 404,
  db_key_file_invalid: 409,
  db_key_relocation_conflict: 409,
  db_key_relocation_source_missing: 404,
  db_key_relocation_unproven: 428,
  db_key_relocation_wrong_key: 409,
  db_key_scan_failed: 500,
  db_rekey_database_busy: 409,
  db_rekey_key_missing: 428,
  db_rekey_schema_old: 428,
  db_rekey_timeline_bound: 409,
  db_rekey_undecodable: 500,
  db_rekey_unverified: 500,
  db_rekey_wrong_key: 409,
  key_home_not_absolute: 503,
  key_home_not_disjoint: 503,
  key_home_unsafe: 503,
  key_home_unset_under_test: 503,
  persisted_key_missing: 428,
  persisted_key_rekey_in_flight: 428,
  persisted_key_close_failed: 500,
  persisted_key_file_invalid: 500,
  persisted_key_publication_failed: 500,
  persisted_key_publication_uncertain: 500,
  persisted_key_read_failed: 500,
  persisted_key_source_unavailable: 500,
  persisted_key_sync_failed: 500,
  // THE TIMELINE'S INTEGRITY REFUSALS (engine/src/timeline, the workspace
  // shard import; a3-correctness L-6): the server's own ledger data refused
  // what it cannot prove — a sealed original that does not open, a second
  // seal key, a migration another build applied (500) — and a rollback or an
  // import that cannot have the exact bytes it needs (409).
  timeline_sealed_original_unavailable: 500,
  timeline_seal_key_mismatch: 500,
  timeline_migration_unknown: 500,
  timeline_rollback_preimage_unavailable: 409,
  workspace_shard_original_unavailable: 409,
  // The MCP WebSocket transport's typed failure after an error the client's
  // protocol layer reported (engine/src/mcp/transport/websocket.ts): the
  // upstream server failed, not this one.
  mcp_websocket_error: 502,
  // A writer or reader named an encrypted field without its complete row
  // identity (db-crypto.ts fieldBinding): a programming fault, never input.
  db_field_binding_invalid: 500,
  // A stored encrypted field did not authenticate under its binding and key
  // (db-crypto.ts decryptField): damaged ciphertext, a value copied from
  // another row, or the wrong key. Server-side data; the client did nothing.
  db_decryption_failed: 500,
  // The key admission handed a worker or client something that is not a
  // 32-byte secret KeyObject (db-crypto.ts createDbCryptoFromKey): wiring.
  db_key_capability_invalid: 500,
  // One process asked for the database key from a second, different source
  // than the one it admitted at start (bootstrap-key.ts getDatabaseKey): two
  // databases must never share one process-wide key admission. Wiring.
  database_key_owner_conflict: 500,
  // The database is at a schema version newer than this harness knows
  // (migrations.ts assertSchemaNotNewer): refused at open, before any read
  // could misinterpret it. Boot-time; mapped for exhaustiveness.
  db_schema_newer: 500,
  // A value handed to a JSON column is not plain JSON (a -0, an accessor, a
  // class instance: json-columns.ts), or a stored JSON column no longer
  // parses. Both are server-side: the writers are server code.
  db_json_input_invalid: 500,
  db_json_invalid: 500,
  // A message's evidence metadata write touched no row (client.ts): the row
  // the server just resolved is gone. Server-side, never input.
  message_metadata_write_failed: 500,
  // The configured database reader pool is not a positive integer
  // (thread-backend.ts, refused before any key, file or worker is acquired):
  // the operator's configuration, the same class as config_invalid.
  db_reader_count_invalid: 503,

  // ── The async data facade (server/db/async-client.ts and friends) ──
  //
  // Every one of these is a SERVER fault, and each is mapped explicitly so it
  // is a loud 500 by intent rather than a silent 500 by omission — the
  // distinction this map exists to draw. A client cannot cause any of them:
  // they describe the process's own wiring being wrong.
  //
  // A method reached the facade that `server/db/method-kinds.ts` does not
  // classify as a read or a write. Deny-by-default: it is refused rather than
  // guessed, because guessing "read" sends a write to a read-only connection
  // and guessing "write" drops every new read onto the one shared thread.
  db_method_unclassified: 500,
  // A write was routed to a READ worker. SQLite would refuse it anyway (the
  // pool is opened read-only); this is the facade catching its own routing bug
  // first, with a message that says which method.
  db_write_on_reader: 500,
  // The classification names a method the client does not have — the table and
  // the class have drifted.
  db_method_missing: 500,
  // db-worker.ts was loaded outside a worker thread, so it has no port to
  // answer on.
  db_worker_no_port: 500,
  // A DB thread died. Retryable: the calls it was carrying are failed
  // explicitly rather than left hanging, and a retry may land on a healthy
  // one.
  db_worker_exited: 500,
  // A call arrived after the facade was closed.
  db_closed: 500,
  // A worker threw something that was not an Error at all; wrapped so it can
  // cross the thread boundary with its text intact.
  db_worker_threw_non_error: 500,
  // A worker error whose class is not one the router maps by name; the code
  // survives even though the class does not.
  db_worker_error: 500,
  // `syncForTests` was reached on a THREADED facade, where no in-process
  // client exists. Loud rather than quietly opening a second connection.
  db_facade_not_inline: 500,
  // SCALE-CR1 C4 — the supervised database threads. A write in flight on a
  // writer that stopped may or may not have committed (500: nothing claims
  // either; the caller checks before retrying). A read that lost its reader
  // twice, and calls while the restart circuit is open, are transient (503).
  db_write_outcome_unknown: 500,
  db_read_lost: 503,
  db_unavailable: 503,
  // UD-S15 — the conversation archive (the db-archive shell; never an HTTP
  // answer in practice, mapped so no code is a silent 500). 428: run the
  // shell with the server stopped. 409: the request contradicts the data
  // (a database another process holds, conversations not in the recycle bin
  // or of two owners, a removal that left rows). 400: no or repeated ids.
  // 500: the archive could not be written or did not verify.
  db_archive_database_busy: 409,
  db_archive_chats_invalid: 400,
  db_archive_not_trashed: 409,
  db_archive_owner_ambiguous: 409,
  db_archive_unwritten: 500,
  db_archive_unverified: 500,
  db_archive_removal_mismatch: 500,
  db_purge_not_trashed: 409,
  db_purge_incomplete: 409,
  db_purge_triggers_missing: 500,
  // The timeline ledger was opened from a DB worker thread. Refused: the
  // ledger has one writer (a second would race the chain hash) and a worker
  // has no recording context, so the event would carry no causality at all.
  ledger_opened_off_main_thread: 500,
  // FileSystemError default code — a server-side I/O failure (stat, readdir,
  // tree-build). Explicitly 500 (the client did nothing wrong; the server's
  // filesystem layer failed). Listed so the map is EXHAUSTIVE — no error
  // code that can reach the router should fall through to a silent 500.
  filesystem_error: 500,
  // tools-bridge manifest wiring bug — a duplicate tool name in the unified
  // manifest is a server-side misconfiguration (the client did nothing
  // wrong). Explicit 500 so the map is exhaustive (-V3 class — the prior
  // round made the map exhaustive but missed this code; it fell through to a
  // silent 500 with no explicit intent). A WebError (no statusCode).
  tool_manifest_duplicate_name: 500,
  // filesystem mkdir route — the directory-creation call failed. The route
  // pre-checks all client-error cases (parent exists, name valid, target
  // absent, within roots); reaching the catch is a genuine server-side I/O
  // failure (disk full, permission issue, race). The raw OS errno is kept in
  // the error message for the operator; the code is the closed harness-owned
  // constant (no raw OS errno leaks into the typed code set). Explicit 500 so
  // the map is exhaustive (deny-by-default — no code falls through to a
  // silent undocumented 500).
  mkdir_failed: 500,
  // The timeline ledger file a dig was pointed at does not exist (the dig
  // reader, engine/src/timeline/ledger-dig.ts). A NOT-FOUND, the same
  // family as file_not_found/project_path_missing: the operator asked for
  // a ledger (wrong cwd, wrong HARNESS_WEB_TIMELINE_DB_PATH, server never
  // started) that is not on disk. Mapped explicitly so the code is part of
  // the total vocabulary — the reader is CLI-side today, but a code minted
  // anywhere must never fall through to a silent undocumented 500.
  timeline_ledger_missing: 404,
  // A dig CLI argument named an event type the recorded vocabulary does not
  // hold (engine/src/timeline/ledger-dig.ts). A caller error — the CLI lists
  // the known vocabulary in the message — mapped explicitly so every code
  // the reader can mint is part of the total vocabulary, the same
  // completeness discipline as timeline_ledger_missing above.
  timeline_dig_event_type_invalid: 400,
  // A dig CLI --since/--until value that is neither an ISO-8601 timestamp
  // nor a relative duration the reader's grammar accepts. Same family and
  // same discipline as timeline_dig_event_type_invalid.
  timeline_dig_time_bound_invalid: 400,
  // The web timeline's ledger identity sidecar (timeline-bridge.ts) is absent
  // for an existing ledger, cannot be read or published, or is not an
  // identity: the ledger cannot be opened as itself, so the timeline is
  // unavailable (the same class as config_unreadable) until it is restored.
  timeline_ledger_identity_missing: 503,
  timeline_ledger_identity_unavailable: 503,
  timeline_ledger_identity_invalid: 503,
  // The context summarizer's privacy observation returned a shape other than
  // one display string per turn (context-bridge.ts): a server fault.
  context_summary_observation_invalid: 500,
  // ── Codes whose error class ALSO declares an explicit `statusCode` ──
  // The class's declared status still wins at the router (see the note
  // above); these entries exist so this map is the COMPLETE code
  // vocabulary rather than only the subset that needs status resolution.
  // Completeness is load-bearing: the client's user-facing message
  // projection (`src/data/error-messages.ts`) derives its key set
  // from here, so a code that is absent from the map cannot be given a
  // message. Before this, the projection hand-maintained ~8 codes the
  // taxonomy had never heard of (`csrf_blocked`, `auth_failed`,
  // `forbidden`, `rate_limited`, …) — a second, drifting table.
  auth_failed: 401,           // AuthError
  setup_required: 401,        // AuthError (no account exists yet)
  csrf_blocked: 403,          // CsrfError
  forbidden: 403,             // ForbiddenError
  conflict: 409,              // ConflictError
  not_found: 404,             // NotFoundError
  bad_request: 400,           // BadRequestError
  // The request itself cannot be parsed (server/router/router.ts): an
  // unparsable Host header or target, a malformed percent-escape in a path
  // segment. Typed at the router's one boundary, never an escaped exception.
  request_host_invalid: 400,
  request_path_malformed: 400,
  body_too_large: 413,        // BodySizeLimitError
  rate_limited: 429,          // RateLimitError
  sse_connection_limit: 429,  // RateLimitError (per-identity SSE cap)
  service_unavailable: 503,   // ServiceUnavailableError
  map_not_ready: 202,         // MapNotReadyError (still indexing)
  awareness_not_ready: 202,   // AwarenessNotReadyError (still computing)
  // ── Mid-run stream failures (SSE) ──
  // The run stream can fail AFTER the 200 + headers are written, so these
  // never travel as an HTTP status — they travel on the `error` SSE frame.
  // They live in the SAME map as every other code (one taxonomy, two
  // transports) so the client's message projection and the server's status
  // resolution share one vocabulary. Status 500 is the honest answer for
  // "if this had happened before the response, it would have been a 500".
  /** The tool-call loop hit its configured iteration bound. */
  tool_iteration_limit: 500,
  /**
   * The run paused to ask the user a question and no answer arrived within
   * the configured wait — the bound (the same shape as the iteration limit:
   * a configured bound doing its job, not a fault) ended the run. Never
   * `run_failed` (nothing threw) and never `done` (the run never finished,
   * and reporting a completion for it would be a lie).
   */
  pause_answer_timeout: 500,
  /** The run stream ended on an untyped throw (no `.code` on the error). */
  run_failed: 500,
  // A run's final `error` frame the SSE egress door could not redact: it was
  // withheld and stands in its place (`withheldTerminalFrame`,
  // server/router/sse.ts) when the original carried no taxonomy code.
  frame_withheld: 500,
  /**
   * THE RUN STOPPED PRODUCING AND NOTHING RECORDED WHY.
   *
   * Distinct from `run_failed`, which means a throw reached the top of the
   * run and did not carry a code — there, something went wrong and said so
   * badly. This means the run left its loop without any of its known endings
   * being reached: not a completion, not the tool-call bound, not a throw,
   * not a cancellation. That should not be reachable, and the honest report
   * for "should not be reachable" is a code that says exactly that rather
   * than the nearest plausible cause.
   *
   * It exists because the alternative — publishing `done` — would report a
   * finished answer for a run that produced no ending, and reporting a
   * completion that did not happen is worse than reporting a fault whose
   * cause is unknown.
   */
  run_ended_without_result: 500,
  // The upstream model provider itself returned an error (carried on a
  // ModelEvent's `error.code`). 502 is the honest status: this side worked,
  // the upstream did not. Declared here — rather than left as vocabulary
  // only the client's message table knew about — because the taxonomy is
  // the ONLY place a code may be introduced.
  model: 502,

  // ── The account has not finished setting up its model providers ─────────
  //
  // 428 Precondition Required across this family, and the choice carries the
  // whole meaning. None of these is a server fault (500) and none is a
  // transient outage (503): the server is working perfectly and will keep
  // giving the same answer until the USER does something. 428 is the status
  // that says so, and it is what lets a client tell "come back later" apart
  // from "you have something to do" without reading the prose.
  //
  // Four codes rather than one because the four remedies differ, and a user
  // who is told the wrong one goes looking in the wrong place.
  /** No provider is saved at all — first-run setup. */
  provider_not_configured: 428,
  /** Providers exist, but this run named no model and none is defaulted. */
  model_not_chosen: 428,
  /** A model was named that no saved provider serves. */
  model_not_configured: 428,
  /** A saved provider is missing its API key, so its requests would bounce. */
  provider_key_missing: 428,
  /** A saved provider lists no models, so there is nothing to ask it for. */
  provider_models_missing: 428,
  /** A request named a provider this account has not saved. */
  provider_unknown: 404,
  /** A provider route was reached without a provider name in the path. */
  provider_id_missing: 400,
  // ── MCP lifecycle (server/mcp-runtime-bridge.ts + engine/src/mcp) ──
  // Availability states of the MCP runtime itself. A disabled server or a
  // mis-named tool is a client-visible configuration fact (the settings
  // surface renders it), not a 500.
  /** The runtime's `ensure started` was replaced mid-flight by a rebuild or shutdown — transient; the current lifecycle owns the answer. */
  mcp_start_superseded: 503,
  /** The runtime is shutting down (server shutdown in flight) — transient by construction. */
  mcp_runtime_shut_down: 503,
  /** A configured MCP server is not currently connected (down or still connecting). */
  mcp_not_connected: 503,
  /** A call named an MCP server the config does not register. */
  mcp_server_not_registered: 404,
  /** A call named an MCP tool the operator has disabled — unavailable by deliberate configuration. */
  mcp_tool_disabled: 503,
  /** The MCP tool ran and reported an error — an upstream service failure, mirroring the provider's `model: 502`. */
  mcp_call_tool_failed: 502,
  /** A server's config names a ${VAR} outside `tools.mcp.credentialEnv`; nothing was read and the server was not started. */
  mcp_credential_env_refused: 400,
  // ── Agent delegation (server/agent-restrictions.ts + agent-runtime-bridge) ──
  // A delegation `restrictions` argument that fails validation (unknown
  // preset, out-of-catalog capability, wrong shape) is a client/input error.
  delegation_restrictions_invalid: 400,
  // A restriction whose write set names a path OUTSIDE the profile's own
  // grant is refused (narrowing-only): forbidden, not merely malformed.
  delegation_write_set_widening: 403,
  // The harness config could not be parsed into the document the engine's
  // agent resolver needs (schema mismatch) — a server-side configuration
  // fault, distinct from "no agents configured".
  agent_config_invalid: 500,
  // No `agents` section is configured: the guided state (the user has
  // something to do), mirroring the provider 428s above.
  agents_not_configured: 428,
  // A sub-agent tool was reached on the sync dispatch path where the engine
  // contract is async-only.
  tool_async_only: 500,
  // delegate_to_agent was absent from a restricted tool set (wiring fault).
  agent_delegate_unavailable: 500,
  // A delegation was attempted without an active run context (run id, signal,
  // credential, manifest) — the caller's omission, so a client error.
  agent_context_missing: 400,
});

/**
 * The complete code vocabulary the taxonomy declares: every mapped code
 * plus the client-originated transport codes. Derived — never a second
 * hand-written list. Consumers that project a code onto something else
 * (a user-facing message, a UI treatment) use this so a projection cannot
 * name a code the taxonomy has never heard of.
 */
export const KNOWN_ERROR_CODES: readonly string[] = Object.freeze([
  ...Object.keys(CODE_STATUS_MAP),
  ...TRANSPORT_CODES,
]);

/**
 * Whether a code belongs to the taxonomy — either declared explicitly or
 * admitted by the `invalid_`/`missing_` input-validation conventions
 * (which are part of the taxonomy: they resolve to 400 without a map
 * entry). Deny-by-default: anything else is NOT a code, it is a typo or
 * an invented vocabulary.
 */
export function isKnownErrorCode(code: string): boolean {
  return isClientInputCode(code) || KNOWN_ERROR_CODES.includes(code);
}

/**
 * Extract the taxonomy code from a thrown value — the SINGLE extractor.
 *
 * Typed errors (the `WebError` hierarchy server-side, `ClientError`
 * client-side) carry a string `code`; anything else (a raw `Error`, a
 * rejected non-Error) carries none. Callers pass the `fallback` that
 * honestly describes "we know it failed, we do not know what kind" for
 * their transport — they must NOT invent a specific cause.
 *
 * This exists so the SSE error path resolves a code exactly the way the
 * REST path does, instead of each emitter re-deriving it (or, as the run
 * stream previously did, sending no code at all and leaving the client to
 * guess one from `EventSource.readyState`).
 */
export function codeForError(err: unknown, fallback: string): string {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.length > 0
  ) {
    return (err as { code: string }).code;
  }
  return fallback;
}

/** The HTTP status for a code, or `undefined` when unmapped. */
export function statusForCode(code: string): number | undefined {
  return CODE_STATUS_MAP[code];
}

/**
 * Input-validation naming conventions. A code prefixed `invalid_` (a body
 * that failed a schema check) or `missing_` (a required param absent) is
 * always a 400, so new guards get the right status without touching the map.
 */
export function isClientInputCode(code: string): boolean {
  return code.startsWith("invalid_") || code.startsWith("missing_");
}

/** Whether a code is one the client originates rather than receives. */
export function isTransportCode(code: string): code is TransportCode {
  return (TRANSPORT_CODES as readonly string[]).includes(code);
}

/**
 * The status a code maps to, applying the naming conventions first and
 * falling back to 500. The single resolution used by both sides.
 */
export function resolveStatus(code: string): number {
  if (isClientInputCode(code)) return 400;
  return statusForCode(code) ?? 500;
}
