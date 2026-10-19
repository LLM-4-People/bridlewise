/**
 * THE ASYNC DATA-ACCESS FACADE — the seam DESIGN-PERFORMANCE §2 asks for.
 *
 * > *"lets keep sqlite, but everything that can be async do it for
 * > standardization."*
 *
 * EVERY method here returns a promise. No exceptions, including the ones that
 * are cheap today, because the value is that a call site never has to know
 * which is which. A half-async data layer is where the next stall hides: the
 * one method somebody left synchronous is the one that blocks the loop, and it
 * looks identical at the call site to the twenty that do not.
 *
 * ── What this changes, and what it does not ──
 *
 * It does not make SQLite faster. Every constant is the same as it was. What
 * changes is WHERE the work happens: on a read pool and a single writer thread
 * (`thread-backend.ts`) instead of on the request thread. That is a change of
 * SHAPE, and shape is what defeats scale — a 42× cheaper operation still grows
 * linearly with concurrency if every user's query runs on the one thread every
 * user shares.
 *
 * ── The two backends, and why the inline one is not a cheat ──
 *
 * `:memory:` cannot be shared across threads: a second thread opening
 * `:memory:` gets its own empty database, not a view of the first. So an
 * in-memory facade runs its `DbClient` inline and returns already-resolved
 * promises. The seam is identical, the ordering guarantees hold trivially, and
 * the hundreds of tests that use an in-memory DB keep working. What it does
 * NOT do is claim the shape benefit — an inline backend blocks the loop
 * exactly as before, which is why the production path and every benchmark use
 * the thread backend, and why `isOffThread` says plainly which one you have.
 *
 * ── Transactions across a thread boundary ──
 *
 * `withTransaction(fn)` cannot cross: a closure is not serialisable. In its
 * place `transaction(ops)` takes an ordered list of named operations and runs
 * them inside one transaction on the writer. That is less expressive on
 * purpose — a transaction whose body is a list of DB operations is exactly the
 * transaction that CAN be atomic off-thread, and a transaction whose body
 * interleaves DB work with application logic never could be.
 */

import { DbClient, recordCheckStatusEvent, type DbClientConfig } from "./client.ts";
import { ValidationError } from "../kernel/errors.ts";
import { recordEffectAsync } from "../kernel/canonical.ts";
import { ThreadBackend, type ThreadBackendConfig, type DbConnectionFacts } from "./thread-backend.ts";
import { snapshotDbWriteArguments } from "./json-columns.ts";
import type {
  ProjectRow,
  ChatRow,
  MessageRow,
  RunAttributionRow,
  ToolCallRow,
  ToolPublicProjection,
  MetricsSnapshotRow,
  AutoCheckRow,
  TimelineRefRow,
  ToolSettingRow,
  ToolSettingUpsertInput,
  ProjectCreateDbInput,
  ChatCreateDbInput,
  MessageCreateInput,
  ToolCallCreateInput,
  MetricsSnapshotCreateInput,
  AutoCheckCreateDbInput,
  TimelineRefCreateInput,
  MessageMetadataUpdate,
  ChatHistory,
  ChatHistoryPage,
  ChatMessagePage,
  UserRow,
} from "./schema.ts";
import type { DurabilityFacts } from "./client.ts";

/** One operation inside `transaction(...)`. */
export type DbOp = Readonly<{ method: string; args: readonly unknown[] }>;

/**
 * The SHAPE of one database argument — the only thing about it the ledger may
 * know. A type name always; a byte length for the kinds where size is the
 * interesting shape fact (a string's length, an object's serialized size).
 * There is deliberately no branch that returns the value itself, so message
 * content cannot reach a ledger document through this channel no matter how
 * the schema grows.
 */
function dbArgsShape(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    return { type: "string", bytes: Buffer.byteLength(value, "utf8") };
  }
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return { type: typeof value };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    // The serialized size is the shape fact for an object. A payload that
    // cannot be serialized (a cycle, a BigInt nested inside) reports NO size
    // rather than a wrong one — and never the bytes themselves.
    try {
      const json = JSON.stringify(value);
      return json === undefined
        ? { type: "object" }
        : { type: "object", bytes: Buffer.byteLength(json, "utf8") };
    } catch {
      return { type: "object" };
    }
  }
  return { type: typeof value };
}

/** What a facade dispatches to. Both backends satisfy the same contract, which
 * is what lets a test swap the inline one in without a single call site
 * changing. */
interface DbBackend {
  call(method: string, args: readonly unknown[]): Promise<unknown>;
  transaction(ops: readonly DbOp[]): Promise<unknown[]>;
  close(): Promise<void>;
  readonly facts: DbConnectionFacts;
  readonly offThread: boolean;
  readonly readPoolSize: number;
}

/**
 * The in-process backend: a real `DbClient`, called synchronously, wrapped in
 * resolved promises.
 *
 * Deliberately NOT `queueMicrotask`-deferred beyond what `async` already does.
 * Pretending to be asynchronous by deferring would make the inline backend
 * look off-thread in a benchmark while blocking the loop exactly as much —
 * a measurement that flatters is worse than no measurement.
 */
class InlineBackend implements DbBackend {
  readonly offThread = false;
  readonly readPoolSize = 0;
  readonly facts: DbConnectionFacts;

  private readonly client: DbClient;

  constructor(client: DbClient) {
    this.client = client;
    this.facts = {
      ready: true,
      schemaVersion: client.schemaVersion,
      path: client.path,
      durability: client.durability,
      keyPersisted: client.keyPersisted,
      keyFilePath: client.keyFilePath,
      provenance: client.provenance,
    };
  }

  async call(method: string, args: readonly unknown[]): Promise<unknown> {
    const fn = (this.client as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!;
    return Reflect.apply(fn, this.client, args);
  }

  async transaction(ops: readonly DbOp[]): Promise<unknown[]> {
    return this.client.withTransaction(() =>
      ops.map((op) => {
        const fn = (this.client as unknown as Record<string, (...args: unknown[]) => unknown>)[op.method]!;
        return Reflect.apply(fn, this.client, op.args);
      }),
    );
  }

  async close(): Promise<void> {
    this.client.close();
  }

  /** The underlying sync client. Exposed ONLY for the inline backend, and only
   * so a test can seed data without going through 60 awaits. Production code
   * never reaches it: `getDb()` hands out a facade, and the thread backend has
   * no such client to hand out. */
  get sync(): DbClient {
    return this.client;
  }
}

class ThreadBackendAdapter implements DbBackend {
  readonly offThread = true;

  private readonly backend: ThreadBackend;

  constructor(backend: ThreadBackend) {
    this.backend = backend;
  }

  call(method: string, args: readonly unknown[]): Promise<unknown> {
    return this.backend.call(method, args);
  }

  transaction(ops: readonly DbOp[]): Promise<unknown[]> {
    return this.backend.transaction(ops);
  }

  close(): Promise<void> {
    return this.backend.close();
  }

  get facts(): DbConnectionFacts {
    return this.backend.connectionFacts;
  }

  get readPoolSize(): number {
    return this.backend.readPoolSize;
  }
}

/**
 * A threaded backend whose threads are not spawned until something uses it.
 *
 * ── Why deferral, rather than opening in `AsyncDbClient.open` ──
 *
 * The process's facade is reached through `getOrCreateAsyncDb()`, which is
 * SYNCHRONOUS by design: `isOffThread` has to be answerable without opening
 * anything, because the interlock in
 * `tests/prevention/async-db-facade-owner.test.ts` asks exactly that question
 * and must not spawn nine worker threads inside a test process to get an
 * answer. Nor should importing the module light up a thread pool.
 *
 * So the decision — threaded — is made at construction, and the CONNECTIONS
 * are opened on first use. `server/index.ts` calls `warmAsyncDb()` before the
 * socket listens, so in the server the "first use" is the boot, never a
 * request: no user pays for the open, and the connection facts are populated
 * before anything can ask for them.
 *
 * `facts` throws before the open rather than returning a plausible blank. A
 * schema version of 0 or an empty path would be a fabricated answer to "what
 * are you connected to", which is the failure mode L3 exists to refuse.
 */
class DeferredThreadBackend implements DbBackend {
  readonly offThread = true;

  private readonly config: ThreadBackendConfig;
  private opening: Promise<ThreadBackend> | null = null;
  private opened: ThreadBackend | null = null;

  constructor(config: ThreadBackendConfig) {
    this.config = config;
  }

  /**
   * Open the pool if it is not open. Concurrent callers share one open.
   *
   * `:memory:` is refused HERE rather than in the constructor, and the
   * distinction is the point: constructing the facade only DECLARES which
   * backend the process uses, and this process uses threads — that is true
   * before any connection exists, and `isOffThread` must be able to say so
   * without spawning nine threads to find out. USING a threaded facade for an
   * in-memory database is what cannot work: each thread would open its own
   * empty database, so nothing would fail — every read would simply answer
   * from a different one. It is refused the moment anyone tries, which in the
   * server is `warmAsyncDb()` at boot, before the socket listens.
   */
  ready(): Promise<ThreadBackend> {
    if (this.config.path === ":memory:") {
      return Promise.reject(
        new ValidationError(
          "an in-memory database cannot be shared across threads: each thread " +
            "would open its OWN empty database and every read would answer from " +
            "a different one. Use AsyncDbClient.inline({ path: ':memory:' }).",
          "db_memory_not_threadable",
        ),
      );
    }
    if (this.opened !== null) return Promise.resolve(this.opened);
    if (this.opening === null) {
      this.opening = ThreadBackend.open(this.config).then((backend) => {
        this.opened = backend;
        return backend;
      });
      // A failed open must not be cached as a permanent failure state that
      // also swallows its own rejection.
      this.opening.catch(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  async call(method: string, args: readonly unknown[]): Promise<unknown> {
    return (await this.ready()).call(method, args);
  }

  async transaction(ops: readonly DbOp[]): Promise<unknown[]> {
    return (await this.ready()).transaction(ops);
  }

  async close(): Promise<void> {
    if (this.opening !== null) await this.opening.catch(() => undefined);
    if (this.opened !== null) await this.opened.close();
  }

  get facts(): DbConnectionFacts {
    if (this.opened === null) {
      throw new ValidationError(
        "the database connections are not open yet, so there are no connection " +
          "facts to report. Await the facade's first call, or warm it at boot " +
          "(server/db/index.ts::warmAsyncDb).",
        "db_not_open",
      );
    }
    return this.opened.connectionFacts;
  }

  get readPoolSize(): number {
    return this.opened === null ? 0 : this.opened.readPoolSize;
  }
}

export class AsyncDbClient {
  private readonly backend: DbBackend;

  private constructor(backend: DbBackend) {
    this.backend = backend;
  }

  /**
   * Open a facade backed by a read pool and one writer thread. The production
   * path, and the one every shape measurement uses.
   */
  static async open(config: ThreadBackendConfig): Promise<AsyncDbClient> {
    return new AsyncDbClient(new ThreadBackendAdapter(await ThreadBackend.open(config)));
  }

  /**
   * Open a facade over an in-process client. Required for `:memory:`, which
   * cannot be shared across threads, and used by tests that want one
   * connection they can also seed synchronously.
   */
  /**
   * Declare a threaded facade WITHOUT opening its connections yet.
   *
   * The production door. `isOffThread` is answerable immediately; the read
   * pool and the writer thread open on first use, or at boot when the caller
   * warms them (`warmAsyncDb`). See `DeferredThreadBackend` for why the
   * decision and the opening are separated.
   */
  static deferred(config: ThreadBackendConfig): AsyncDbClient {
    return new AsyncDbClient(new DeferredThreadBackend(config));
  }

  /** Open the connections a `deferred` facade has not opened yet. A no-op on
   * a facade that is already open, and on an inline one. */
  async warm(): Promise<void> {
    if (this.backend instanceof DeferredThreadBackend) await this.backend.ready();
  }

  static inline(clientOrConfig: DbClient | DbClientConfig): AsyncDbClient {
    const client =
      clientOrConfig instanceof DbClient ? clientOrConfig : new DbClient(clientOrConfig);
    return new AsyncDbClient(new InlineBackend(client));
  }

  /** Whether the database work actually happens off the request thread. Stated
   * rather than assumed: an inline facade is async in SHAPE OF API only, and a
   * measurement that does not distinguish the two is measuring nothing. */
  get isOffThread(): boolean {
    return this.backend.offThread;
  }

  get readPoolSize(): number {
    return this.backend.readPoolSize;
  }

  get schemaVersion(): number {
    return this.backend.facts.schemaVersion;
  }

  get path(): string {
    return this.backend.facts.path;
  }

  get durability(): DurabilityFacts {
    return this.backend.facts.durability;
  }

  get keyPersisted(): boolean {
    return this.backend.facts.keyPersisted;
  }

  get keyFilePath(): string | null {
    return this.backend.facts.keyFilePath;
  }

  /** Whose database this facade serves (UD-S15): the health route states it, so a test suite refuses a real server. */
  get provenance(): DbConnectionFacts["provenance"] {
    return this.backend.facts.provenance;
  }

  /** The synchronous client behind an INLINE facade, for test seeding. Throws
   * on a threaded facade, where no such object exists on this thread — better
   * a loud failure than a second connection quietly opened to satisfy the
   * call. */
  get syncForTests(): DbClient {
    if (!(this.backend instanceof InlineBackend)) {
      throw new ValidationError(
        "syncForTests is only available on an inline facade; a threaded facade " +
          "keeps its connections on other threads by design.",
        "db_facade_not_inline",
      );
    }
    return this.backend.sync;
  }

  close(): Promise<void> {
    return this.backend.close();
  }

  /**
   * Run an ordered group of operations inside ONE transaction.
   *
   * The replacement for `withTransaction(fn)`, which cannot cross a thread.
   * Results come back in the order given.
   */
  async transaction(ops: readonly DbOp[]): Promise<unknown[]> {
    const prepared = ops.map((op) => {
      const { method, args } = op;
      return { method, args: snapshotDbWriteArguments(method, args) };
    });
    // RECORDING CHOKE POINT for the `db` effect kind, transaction form: the
    // same main-thread guarantee as `call` below, and the same shape-only
    // args — the operation NAMES and their count, never an operation's
    // arguments.
    return recordEffectAsync(
      "db",
      "transaction",
      () => this.backend.transaction(prepared) as Promise<unknown[]>,
      {
        argsOf: () => ({
          opCount: prepared.length,
          ops: prepared.map((op) => op.method),
        }),
      },
    );
  }

  private async call<T>(method: string, ...args: readonly unknown[]): Promise<T> {
    args = snapshotDbWriteArguments(method, args);
    // RECORDING CHOKE POINT for the `db` effect kind: every data-facade call
    // crosses this private method, so wrapping it here means a database
    // operation cannot execute unrecorded. The effect settles when the
    // backend's promise settles — the real measured duration of the call,
    // including the worker round-trip.
    //
    // MAIN THREAD ONLY, AND THAT IS STRUCTURAL, NOT ENFORCED HERE: the
    // worker threads run `DbClient` directly (they never construct this
    // facade), so the wrapper — and therefore the ledger sink, which refuses
    // a second writer thread — is only ever entered from the main thread.
    //
    // THE ARGS ARE SHAPES, NEVER VALUES. A database argument is frequently
    // the user's message content, and the ledger's documents are stored
    // verbatim by design — so the args document records the method name, the
    // argument count, and each argument's type name + size, and NOTHING of
    // what the arguments contain. `dbArgsShape` is the one place that
    // decides what a shape is.
    return recordEffectAsync(
      "db",
      method,
      () => this.backend.call(method, args) as Promise<T>,
      {
        argsOf: () => ({
          argCount: args.length,
          args: args.map(dbArgsShape),
        }),
      },
    );
  }

  /**
   * Tail of the queue for each serialisation key. A read-modify-write that
   * must not interleave with another for the SAME key chains onto it.
   *
   * Bounded: the entry is deleted once the task it holds is the last one, so
   * a per-user key does not accumulate one map entry per user forever. It is
   * a `Map` of at most the keys with work in flight.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const run = prior.then(task);
    // WHAT IS STORED IS THE SETTLED SHAPE, NOT THE RESULT — and that one line
    // is the whole reason a failed task cannot strand the queue behind it.
    // Chaining the next task onto `run` would propagate a rejection down the
    // key forever: one bad merge would wedge that user's setting for the life
    // of the process. Chaining onto a promise that always fulfils means the
    // queue ORDERS work without COUPLING outcomes. It also means the stored
    // promise is never an unhandled rejection.
    //
    // Stated because it was mutation-proved the wrong way round first: a
    // `then(task, task)` here read like the guard and was dead code, since
    // `prior` can never reject. Replacing it changed nothing and passed —
    // a green mutation that proved only that it had aimed at the wrong line.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  // ── Projects ──

  listProjects(userId: string): Promise<readonly ProjectRow[]> {
    return this.call("listProjects", userId);
  }
  getProject(id: string, userId: string): Promise<ProjectRow | null> {
    return this.call("getProject", id, userId);
  }
  createProject(input: ProjectCreateDbInput, userId: string): Promise<ProjectRow> {
    return this.call("createProject", input, userId);
  }
  renameProject(id: string, name: string, userId: string): Promise<ProjectRow | null> {
    return this.call("renameProject", id, name, userId);
  }
  updateProject(
    id: string,
    fields: Readonly<{ name?: string; path?: string }>,
    userId: string,
  ): Promise<ProjectRow | null> {
    return this.call("updateProject", id, fields, userId);
  }
  deleteProject(id: string, userId: string): Promise<boolean> {
    return this.call("deleteProject", id, userId);
  }
  restoreProject(id: string, userId: string): Promise<ProjectRow | null> {
    return this.call("restoreProject", id, userId);
  }
  listTrash(userId: string): Promise<
    Readonly<{ projects: readonly ProjectRow[]; chats: readonly ChatRow[] }>
  > {
    return this.call("listTrash", userId);
  }
  projectBelongsToUser(projectId: string, userId: string): Promise<boolean> {
    return this.call("projectBelongsToUser", projectId, userId);
  }
  getProjectByPath(path: string, userId: string): Promise<ProjectRow | null> {
    return this.call("getProjectByPath", path, userId);
  }
  projectPathBelongsToUser(path: string, userId: string): Promise<boolean> {
    return this.call("projectPathBelongsToUser", path, userId);
  }
  chatBelongsToUser(chatId: string, userId: string): Promise<boolean> {
    return this.call("chatBelongsToUser", chatId, userId);
  }
  messageBelongsToUser(messageId: string, userId: string): Promise<boolean> {
    return this.call("messageBelongsToUser", messageId, userId);
  }

  // ── Chats ──

  listChats(projectId: string, userId: string): Promise<readonly ChatRow[]> {
    return this.call("listChats", projectId, userId);
  }
  getChat(id: string, userId: string): Promise<ChatRow | null> {
    return this.call("getChat", id, userId);
  }
  createChat(input: ChatCreateDbInput, userId: string): Promise<ChatRow> {
    return this.call("createChat", input, userId);
  }
  renameChat(id: string, title: string, userId: string): Promise<ChatRow | null> {
    return this.call("renameChat", id, title, userId);
  }
  setChatModel(id: string, modelId: string | null, userId: string): Promise<ChatRow | null> {
    return this.call("setChatModel", id, modelId, userId);
  }
  deleteChat(id: string, userId: string): Promise<boolean> {
    return this.call("deleteChat", id, userId);
  }
  restoreChat(id: string, userId: string): Promise<ChatRow | null> {
    return this.call("restoreChat", id, userId);
  }
  setChatPinned(id: string, pinned: boolean, userId: string): Promise<ChatRow | null> {
    return this.call("setChatPinned", id, pinned, userId);
  }
  duplicateChat(id: string, userId: string): Promise<ChatRow | null> {
    return this.call("duplicateChat", id, userId);
  }

  // ── Messages ──

  countMessages(chatId: string, userId: string): Promise<number> {
    return this.call("countMessages", chatId, userId);
  }
  listMessages(chatId: string, userId: string): Promise<readonly MessageRow[]> {
    return this.call("listMessages", chatId, userId);
  }
  createMessage(input: MessageCreateInput, userId: string): Promise<MessageRow> {
    return this.call("createMessage", input, userId);
  }
  getMessage(id: string, userId: string): Promise<MessageRow | null> {
    return this.call("getMessage", id, userId);
  }
  updateMessageContent(
    id: string,
    content: string,
    userId: string,
    extras?: Readonly<{ readonly model_event_type?: string }>,
  ): Promise<void> {
    return this.call("updateMessageContent", id, content, userId, extras);
  }
  updateMessageMetadata(id: string, metadata: MessageMetadataUpdate, userId: string): Promise<void> {
    return this.call("updateMessageMetadata", id, metadata, userId);
  }
  // No `deleteMessagesAfter`: withdrawal replaced deletion, and the
  // synchronous owner does not carry one to forward to.

  // ── Tool calls ──

  listToolCallsByChat(chatId: string, userId: string): Promise<readonly ToolCallRow[]> {
    return this.call("listToolCallsByChat", chatId, userId);
  }
  listToolCallsByMessage(messageId: string, userId: string): Promise<readonly ToolCallRow[]> {
    return this.call("listToolCallsByMessage", messageId, userId);
  }
  createToolCall(input: ToolCallCreateInput, userId: string): Promise<ToolCallRow> {
    return this.call("createToolCall", input, userId);
  }
  updateToolCall(
    id: string,
    userId: string,
    updates: Readonly<{
      readonly input?: unknown;
      readonly output?: unknown;
      readonly status?: "running" | "done" | "error";
      readonly durationMs?: number;
      readonly attemptCount?: number;
      readonly publicProjection?: ToolPublicProjection;
    }>,
  ): Promise<void> {
    return this.call("updateToolCall", id, userId, updates);
  }

  /** Finalise every still-`running` tool call of a run. See
   * `DbClient.finalizeRunningToolCallsForRun` — returns how many rows moved. */
  finalizeRunningToolCallsForRun(runId: string, userId: string): Promise<number> {
    return this.call("finalizeRunningToolCallsForRun", runId, userId) as Promise<number>;
  }

  // ── Run execution claim (the rung-1 refusal) ──

  /**
   * Claim the right to execute a run. Resolves when this caller won; rejects
   * with `ConflictError` (`run_already_executing`) when SQLite refused the
   * INSERT because the run is already claimed.
   *
   * It goes to the single writer thread, which is what makes the race
   * decidable: the writer serialises, so of two simultaneous claims exactly
   * one INSERT commits and the other meets a row that is already there.
   */
  claimRunExecution(runId: string, userId: string): Promise<void> {
    return this.call("claimRunExecution", runId, userId) as Promise<void>;
  }

  // ── Metrics ──

  listMetricsSnapshots(chatId: string, userId: string): Promise<readonly MetricsSnapshotRow[]> {
    return this.call("listMetricsSnapshots", chatId, userId);
  }
  createMetricsSnapshot(
    input: MetricsSnapshotCreateInput,
    userId: string,
  ): Promise<MetricsSnapshotRow> {
    return this.call("createMetricsSnapshot", input, userId);
  }

  // ── Auto checks ──

  listAutoChecksByProject(projectId: string, userId: string): Promise<readonly AutoCheckRow[]> {
    return this.call("listAutoChecksByProject", projectId, userId);
  }
  listAutoChecksByChat(chatId: string, userId: string): Promise<readonly AutoCheckRow[]> {
    return this.call("listAutoChecksByChat", chatId, userId);
  }

  /**
   * Upsert an auto-check AND append its status transition to the ledger.
   *
   * The append happens HERE, on the main thread, after the write commits — not
   * inside the write. Two reasons, both non-negotiable under §2:
   *
   *  - the ledger's chain hash needs ONE writer, and a worker calling the
   *    recorder would open a second store over the same file;
   *  - `recordEvent` merges the ambient recording context out of
   *    AsyncLocalStorage, which does not cross a thread. A worker would not
   *    fail — it would record the event with no causality at all, which is the
   *    quiet version of losing it.
   *
   * ALS survives `await`, so this call still runs inside whatever run boundary
   * the caller was in, and a check upserted inside a run still carries that
   * run's id exactly as before.
   *
   * Recording is still structurally unavoidable: this is the only door to the
   * upsert on the async path, `createAutoCheckReturningTransition` is not
   * exposed by the facade, and a recorder failure is warned rather than
   * thrown — the row is already durable and failing the caller would report a
   * failure that did not happen.
   */
  async createAutoCheck(input: AutoCheckCreateDbInput, userId: string): Promise<AutoCheckRow> {
    const transition = (await this.backend.call("createAutoCheckReturningTransition", [
      input,
      userId,
    ])) as {
      row: AutoCheckRow;
      fromStatus: string | null;
      checkName: string;
      toStatus: string;
      projectId: string | null;
      chatId: string | null;
    };
    recordCheckStatusEvent(
      transition.row.id,
      transition.checkName,
      transition.fromStatus,
      transition.toStatus,
      transition.projectId,
      transition.chatId,
    );
    return transition.row;
  }

  // ── Timeline refs + run scoping ──

  listTimelineRefs(chatId: string, userId: string): Promise<readonly TimelineRefRow[]> {
    return this.call("listTimelineRefs", chatId, userId);
  }
  createTimelineRef(input: TimelineRefCreateInput, userId: string): Promise<TimelineRefRow> {
    return this.call("createTimelineRef", input, userId);
  }
  runIdsForChat(chatId: string, userId: string): Promise<readonly string[]> {
    return this.call("runIdsForChat", chatId, userId);
  }
  runIdsForProject(projectId: string, userId: string): Promise<readonly string[]> {
    return this.call("runIdsForProject", projectId, userId);
  }
  runAttributionsForProject(projectId: string, userId: string): Promise<readonly RunAttributionRow[]> {
    return this.call("runAttributionsForProject", projectId, userId);
  }
  allRunIdsForUser(userId: string): Promise<readonly string[]> {
    return this.call("allRunIdsForUser", userId);
  }
  runBelongsToUser(runId: string, userId: string): Promise<boolean> {
    return this.call("runBelongsToUser", runId, userId);
  }

  // ── Tool settings ──

  listToolSettings(userId: string): Promise<readonly ToolSettingRow[]> {
    return this.call("listToolSettings", userId);
  }
  upsertToolSetting(input: ToolSettingUpsertInput, userId: string): Promise<ToolSettingRow> {
    return this.call("upsertToolSetting", input, userId);
  }

  // ── Identity ──

  countUsers(): Promise<number> {
    return this.call("countUsers");
  }
  getUserByUsername(username: string): Promise<UserRow | null> {
    return this.call("getUserByUsername", username);
  }
  getUserById(id: string): Promise<UserRow | null> {
    return this.call("getUserById", id);
  }
  createUser(username: string, passwordHash: string): Promise<UserRow> {
    return this.call("createUser", username, passwordHash);
  }
  setUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
    return this.call("setUserPasswordHash", userId, passwordHash);
  }
  deleteUser(id: string): Promise<boolean> {
    return this.call("deleteUser", id);
  }
  createAuthSession(tokenHash: string, userId: string, sessionId: string): Promise<void> {
    return this.call("createAuthSession", tokenHash, userId, sessionId);
  }
  getAuthSession(
    tokenHash: string,
  ): Promise<{ user_id: string; session_id: string; created_at: string } | null> {
    return this.call("getAuthSession", tokenHash);
  }
  deleteAuthSession(tokenHash: string): Promise<void> {
    return this.call("deleteAuthSession", tokenHash);
  }

  // ── Preferences ──

  getUserModelPrefs(userId: string): Promise<unknown | null> {
    return this.call("getUserModelPrefs", userId);
  }
  upsertUserModelPrefs(userId: string, config: unknown): Promise<void> {
    return this.call("upsertUserModelPrefs", userId, config);
  }

  /**
   * Read the stored model preferences, merge, and write back — WITHOUT the
   * two concurrent savers losing each other's update.
   *
   * The only `withTransaction(fn)` call site in the product was here, and it
   * cannot cross a thread: the body reads, merges in application code, and
   * writes. `transaction(ops)` deliberately cannot express it, because a
   * transaction whose body interleaves DB work with application logic is
   * exactly the one that could never be atomic off-thread.
   *
   * Notice what the transaction was actually buying. The old body was
   * SYNCHRONOUS end to end, so on a single-threaded loop nothing could
   * interleave with it whether or not it held a transaction. The conversion
   * introduces two `await` points inside the read-merge-write, and THAT is
   * what would make a second concurrent PUT read the same stale document and
   * silently drop the first save. Replacing the transaction with nothing would
   * have been a regression the type-checker could not see.
   *
   * So the facade serialises the whole sequence per user. The merge runs on
   * the MAIN thread — it never crosses the boundary — and the read that opens
   * the second sequence is issued after the first sequence's write has
   * committed, which W2 (`thread-backend.ts`) guarantees it will observe.
   * Same property the transaction gave, established the way this architecture
   * can actually establish it.
   */
  updateUserModelPrefs(
    userId: string,
    merge: (existing: unknown | null) => unknown,
  ): Promise<unknown> {
    return this.serialize(`userModelPrefs:${userId}`, async () => {
      const existing = await this.getUserModelPrefs(userId);
      const next = merge(existing);
      await this.upsertUserModelPrefs(userId, next);
      return next;
    });
  }
  getUserPromptPrefs(userId: string): Promise<unknown | null> {
    return this.call("getUserPromptPrefs", userId);
  }
  upsertUserPromptPrefs(userId: string, prefs: unknown): Promise<void> {
    return this.call("upsertUserPromptPrefs", userId, prefs);
  }
  deleteUserPromptPrefs(userId: string): Promise<void> {
    return this.call("deleteUserPromptPrefs", userId);
  }

  // ── Composite ──

  getChatHistory(chatId: string, userId: string): Promise<ChatHistory | null> {
    return this.call("getChatHistory", chatId, userId);
  }

  /** The conversation at its TAIL, bounded (DESIGN-PERFORMANCE §4). */
  getChatHistoryPage(
    chatId: string,
    userId: string,
    limit?: number,
  ): Promise<ChatHistoryPage | null> {
    return this.call("getChatHistoryPage", chatId, userId, limit);
  }

  /** The page of messages BEFORE a cursor — a delta, not a conversation. */
  getChatMessagePage(
    chatId: string,
    userId: string,
    before: string,
    limit?: number,
  ): Promise<ChatMessagePage | null> {
    return this.call("getChatMessagePage", chatId, userId, before, limit);
  }
}
