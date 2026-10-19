/**
 * WHICH DbClient METHODS READ, AND WHICH WRITE — stated once, mechanically.
 *
 * The async facade routes a call to the read pool or to the single writer
 * thread on the strength of this table, so a misclassification is not a style
 * problem: a write sent to a reader hits a connection SQLite opened read-only
 * and fails outright, and a read sent to the writer needlessly serialises
 * behind every queued write.
 *
 * ── Deny by default ──
 *
 * There is no fallback. A method that appears in neither list is UNCLASSIFIED
 * and the facade refuses to dispatch it, because the two ways to guess are
 * both wrong: guessing "read" sends writes to a read-only connection, and
 * guessing "write" silently drops every new read onto the one thread the whole
 * process shares. `tests/prevention/async-db-facade-owner.test.ts` walks
 * `DbClient.prototype` and fails if any public method is missing here, so
 * adding a method to the client without classifying it breaks the build rather
 * than surfacing as a runtime error in whichever route reaches it first.
 *
 * ── "Read" means read-only, not "cheap" ──
 *
 * `getProjectByPath` lists and decrypts every project of a user; it is a read.
 * `countUsers` touches one row; it is a read. Cost plays no part — the only
 * question is whether the method can modify the database, because that is the
 * question the WAL's one-writer rule asks.
 */

/** Methods that never modify the database. Dispatched to the read pool. */
export const DB_READ_METHODS = [
  // projects
  "listProjects",
  "getProject",
  "projectBelongsToUser",
  "getProjectByPath",
  "projectPathBelongsToUser",
  // ownership probes
  "chatBelongsToUser",
  "messageBelongsToUser",
  // chats
  "listChats",
  "listTrash",
  "getChat",
  // messages
  "countMessages",
  "listMessages",
  "getMessage",
  // tool calls
  "listToolCallsByChat",
  "listToolCallsByMessage",
  // metrics
  "listMetricsSnapshots",
  // auto checks
  "listAutoChecksByProject",
  "listAutoChecksByChat",
  // timeline refs + run scoping
  "listTimelineRefs",
  "runIdsForChat",
  "runIdsForProject",
  "runAttributionsForProject",
  "allRunIdsForUser",
  "runBelongsToUser",
  // tool settings
  "listToolSettings",
  // identity
  "countUsers",
  "getUserByUsername",
  "getUserById",
  "getAuthSession",
  // preferences
  "getUserModelPrefs",
  "getUserPromptPrefs",
  // composite
  "getChatHistory",
  // composite, BOUNDED (DESIGN-PERFORMANCE §4) — the cursor's two doors
  "getChatHistoryPage",
  "getChatMessagePage",
] as const;

/** Methods that modify the database. Dispatched to the single writer thread,
 * in the order the caller issued them. */
export const DB_WRITE_METHODS = [
  // projects
  "createProject",
  "renameProject",
  "updateProject",
  "deleteProject",
  "restoreProject",
  // chats
  "createChat",
  "renameChat",
  "setChatModel",
  "deleteChat",
  "restoreChat",
  "setChatPinned",
  "duplicateChat",
  // messages
  "createMessage",
  "updateMessageContent",
  "updateMessageMetadata",
  // tool calls
  "createToolCall",
  "updateToolCall",
  // metrics
  "createMetricsSnapshot",
  // auto checks — the ledger-free half; see DB_FACADE_OWNED_METHODS
  "createAutoCheckReturningTransition",
  // run execution claim — the rung-1 refusal. A WRITE, and it must be the
  // writer thread's: two claims racing on two read connections would both
  // succeed against their own snapshots, and the whole point is that exactly
  // one of them commits.
  "claimRunExecution",
  "finalizeRunningToolCallsForRun",
  // timeline refs
  "createTimelineRef",
  // tool settings
  "upsertToolSetting",
  // identity
  "createUser",
  "setUserPasswordHash",
  "deleteUser",
  "createAuthSession",
  "deleteAuthSession",
  // preferences
  "upsertUserModelPrefs",
  "upsertUserPromptPrefs",
  "deleteUserPromptPrefs",
] as const;

/**
 * Members of `DbClient` that are deliberately NOT dispatched, each with the
 * reason, because "it is not in either list" must be a decision on the record
 * rather than an omission.
 *
 *  - `close` — a lifecycle operation on every connection at once, owned by the
 *    facade, not forwarded as one call to one thread.
 *  - `withTransaction` — takes a CALLBACK. A function cannot cross a thread
 *    boundary, so the facade offers `transaction(ops)` instead: a list of
 *    named operations executed together on the writer. See `async-client.ts`.
 *  - `schemaVersion`, `path`, `durability`, `keyPersisted`, `keyFilePath` —
 *    connection facts, read once when the pool opens and served from memory.
 *    Sending a message to ask a worker for a constant would be silly.
 */
/**
 * Methods the FACADE implements itself and must never forward to a thread.
 *
 * `createAutoCheck` fuses a database write with a ledger append. The write can
 * run on the writer thread; the append cannot run anywhere but the main
 * thread, because the ledger has one writer and because a worker has no
 * AsyncLocalStorage context to take causality from. So the facade calls
 * `createAutoCheckReturningTransition` on the writer and appends the event
 * itself.
 *
 * Listing it here rather than leaving it out is the point: dispatching it
 * would still "work" — the row would be written and the ledger append would
 * throw inside the worker, be caught by its own warn-not-throw handler, and
 * the check would silently stop appearing in the history. A method that fails
 * quietly is exactly the one that needs a name.
 */
export const DB_FACADE_OWNED_METHODS = ["createAutoCheck"] as const;

export const DB_UNDISPATCHED_MEMBERS = [
  "constructor",
  "close",
  "withTransaction",
  "schemaVersion",
  "path",
  "durability",
  "keyPersisted",
  "keyFilePath",
  // The conversation archive's read and removal (UD-S15): the maintenance
  // shell's door, run with the server STOPPED on its own client — never
  // dispatched through the server's facade.
  "conversationRows",
  "purgeConversations",
] as const;

export type DbReadMethod = (typeof DB_READ_METHODS)[number];
export type DbWriteMethod = (typeof DB_WRITE_METHODS)[number];
export type DbDispatchedMethod = DbReadMethod | DbWriteMethod;

const READ_SET: ReadonlySet<string> = new Set(DB_READ_METHODS);
const WRITE_SET: ReadonlySet<string> = new Set(DB_WRITE_METHODS);

/** "read" | "write", or null when the method is unclassified — which the
 * caller must treat as a refusal, never as a default. */
export function methodKind(name: string): "read" | "write" | null {
  if (READ_SET.has(name)) return "read";
  if (WRITE_SET.has(name)) return "write";
  return null;
}
