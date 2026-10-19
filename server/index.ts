/**
 * Local loopback HTTP+SSE server — the trust boundary.
 *
 * Binds to 127.0.0.1 ONLY (never 0.0.0.0). Validates all outbound data
 * with canonical Zod schemas before sending to the client. The client
 * receives pre-validated typed events.
 *
 * This is the sole process which imports from the canonical harness source
 * (via./canonical.ts) for Zod schema validation and (eventually) runtime
 * bridge calls.
 *
 * Architecture:
 * server/index.ts — bootstrap, security middleware, route registration
 * server/router.ts — thin HTTP router with path params
 * server/sse.ts — SSE stream helper
 * server/canonical.ts — re-export hub for canonical harness schemas
 * server/validate.ts — outbound validation helpers
 * server/fixtures.ts — fixture builders (demo data matching canonical shapes)
 * server/config.ts — centralized server config (port/host/limits)
 * server/db/ — SQLite projection (schema, migrations, client)
 * server/routes/*.ts — one file per domain (health, projects, chats, etc.)
 */

// FIRST OF ALL: the process fault policy (one owner of what an escaped fault
// does; it imports nothing that reads settings), so a fault anywhere below,
// the boot's own awaits included, is handled by it (SCALE-CR1 C2).
import "./kernel/process-fault-policy.ts";
// THEN, so an unreadable settings file is a typed boot refusal before any
// module that reads the settings at load (see the module's header).
import "./kernel/boot-settings-preflight.ts";
import { closeAllSseStreams } from "./router/sse.ts";
import { releaseAllRunFeeds } from "./run/run-feed.ts";
import { stopAllMcpConnections } from "./integrations/mcp-runtime-bridge.ts";
import { closeOutboundConnections } from "../engine/src/shared/outbound-http.ts";

import { DEFAULT_SHUTDOWN_GRACE_MS, serverConfig } from "./kernel/config.ts";
import { primeKnownSecrets } from "./llm/redaction.ts";
// The masker's config-resolved policy, resolved eagerly at boot (the
// startup pin: a hand-edited privacy section that would weaken redaction
// refuses HERE, before the socket listens, instead of at the first egress
// call).
import { getPrivacyPolicy } from "./kernel/harness-config.ts";
import { getSafetyGateConfig, getEventFeedSafetyConfig } from "./kernel/harness-config.ts";
import { isLoopbackHost } from "./safety/safety-invariants.ts";
import { createRouter } from "./router/router.ts";
import { createHttpListener } from "./router/http-listener.ts";
import { databaseThreadSupervision, getOrCreateAsyncDb, warmAsyncDb } from "./db/index.ts";
import { startTimeline, timelineReadiness } from "./observability/timeline-bridge.ts";
import { startResourceSampler, stopResourceSampler, installPerformanceMetricsExposureSource } from "./observability/metrics-bridge.ts";
import { registerAllRoutes, isPublicPath } from "./routes/registry.ts";
import { readConfigRaw, writeConfigRaw, resolveWebDebugBootstrap, getSettingsStoreState, watchSettingsStore } from "./kernel/harness-config.ts";
import { egressFailureCounts } from "./router/egress-failures.ts";
import { installDatabaseFactsSource, installDatabaseThreadsSource, installTimelineReadinessSource, installEgressFailureSource, installKeepOutSource, installSettingsStoreStateSource, preMigrationBackups, installCustomizationConfigStore, registerNetworkExposure, guarded } from "./kernel/canonical.ts";
import { serverKeepOutList } from "./safety/host-facts.ts";
import { installServerKeyTool } from "./db/key-tool.ts";
import { installRunSafetyRuntimeExposureSource } from "./safety/safety-runtime-bridge.ts";
import { installIntelligenceMapCacheExposureSource, installIndexRefreshFromEditorWrites } from "./intelligence/intelligence-bridge.ts";
import {
  CONTENT_TYPE_JSON,
  CSRF_CUSTOM_HEADER,
} from "../shared/constants.ts";

// ── Router + DB + route registration ──

// Centralized debug/error system bootstrap. The debug section of the config
// document is the SSOT for the debug system's shape, resolved here ONCE at
// boot through the config reader's single resolver; `HARNESS_WEB_DEBUG=1`
// remains the process-level override that turns the master switch on for
// THIS process without touching the shared file. The resolver is what makes
// the section REAL: before it, no code read `document.debug` in any
// process, so every one of the section's leaves was inert while the shipped
// file carried them. The resolution is also the startup pin — a hand-edited
// section that would switch the debug redactor off is a typed boot refusal
// here (the write gate already refuses the same write on the way in), the
// same fail-closed stance the masker's policy door takes. When the resolved
// master switch is off (the default), the system stays in its no-op state:
// every call returns at the `!configured` guard — zero overhead.
import { configureWebDebug, createConsoleSink, webConsoleInfo, webConsoleError } from "./observability/debug-bridge.ts";
const debugBootstrap = resolveWebDebugBootstrap();
if (debugBootstrap.base.enabled === true) {
  configureWebDebug(debugBootstrap.base, debugBootstrap.consoleSinkAllowed ? [createConsoleSink()] : []);
}

// THE ONLY DOOR TO THE DATABASE IN THIS PROCESS.
//
// The migration is finished: no module outside `server/db/` holds a
// synchronous database client, so the facade's backend is a read pool plus one
// writer thread. The main thread issues calls and awaits promises; it never
// runs SQL, never decrypts a field, never validates a row.
//
// The connections open LAZILY, on first use, and `warmAsyncDb()` below is
// what makes that first use happen before the socket is listening — so no
// request is ever the thing that pays for the open, and the connection facts
// (schema version, durability posture) are known by the time anything can ask.
const db = getOrCreateAsyncDb();

// ARM THE IDENTITY LAYER BEFORE THE SOCKET LISTENS. The redactor's strongest
// evidence is that a string EQUALS a credential this server holds, and it can
// only use that evidence about credentials it has been told. Priming here
// means the first request is already covered rather than the second — the
// provider API key registers itself when it is read from disk, but the
// env-sourced credentials have no such read to hang off.
//
// Labels only, never values: this line says WHAT the redactor knows, and
// there is no accessor anywhere that says what those credentials are.
const knownCredentialLabels = primeKnownSecrets();

// RESOLVE THE MASKER'S POLICY BEFORE THE SOCKET LISTENS. The egress choke
// points consult the config-resolved privacy policy per call; resolving it
// once HERE makes a config that would weaken redaction a BOOT refusal
// (typed, naming the refused values) rather than a first-request failure —
// the same stance the debug bridge takes for `debug.redaction.enabled=false`.
// The write gate already refuses such a section on the way in, so what this
// catches is bytes that never passed it: a hand-edited file. Labels only,
// never values: the policy's shape is not a secret, and nothing here prints
// the section.
getPrivacyPolicy();

// RESOLVE THE SAFETY POSTURE BEFORE THE SOCKET LISTENS. The write gate
// already refuses a section that would disarm a gate check or an event-feed
// detector; what this catches is bytes that never passed it — a hand-edited
// file. Both accessors assert the posture on the section they read, so
// resolving them HERE makes a weakened safety section a BOOT refusal (typed,
// naming the refused leaf) rather than a first-run failure — the same
// stance the privacy policy resolution above takes for the masker.
getSafetyGateConfig();
getEventFeedSafetyConfig();

// Single-Party-Owner (route registry): the router OWNS the
// cross-cutting middleware (auth, CSRF, rate limiting, error mapping, body
// parsing); the route registry (`routes/registry.ts`) owns WHICH routes
// exist + which are public. `index.ts` is now the BOOTSTRAP ONLY — it
// wires the two together and starts the server. It no longer defines the
// auth middleware, the CSRF call, the public-path allowlist, or the 27
// ad-hoc `register*Routes` calls (all moved to their single owners).
const router = createRouter({ db, isPublicPath });
registerAllRoutes(router, db);

// Install the config store the exposure customizations read/write through.
// A config-bound customization's value is backed by `bridlewise.config.json`:
// reads come from the config document and writes go through `writeConfigRaw`,
// the deny-by-default config write gate (the whole candidate document is
// re-validated against `getConfigDocumentSchema()` before a byte reaches disk).
// Installed once, before the socket listens, so the first settings read/write
// is already backed by the file rather than a per-process stub.
installCustomizationConfigStore({
  configFilePath: serverConfig.harnessConfigPath,
  readDocument: readConfigRaw,
  writeDocument: writeConfigRaw,
});
// The outbound door reads its one setting (`network.cleartextRemote`) from
// the store just installed — before any request can leave this process.
registerNetworkExposure();

// Install the exposure state source the event-feed safety signals read
// through. The safety-runtime owner aggregates its per-run detectors
// (workaround / bandaid / step-skip / deviation) into this source, so the
// instruments show real verdicts; with no run active the honest reading is
// inactive/zero. Installed once, at boot, beside the customization store.
installRunSafetyRuntimeExposureSource();
installIntelligenceMapCacheExposureSource();
installIndexRefreshFromEditorWrites();
// The performance registration's signals (per-scope call/error/cancel
// counts, duration quantiles, cpu/ram aggregates, tokens per second,
// self-improving suggestions, the sampler's own last tick) read through the
// metrics bridge's source — installed beside the other exposure sources so
// the instruments room's cells are the SAME measurements /api/metrics
// serves, from the one owner.
installPerformanceMetricsExposureSource();
// The settings store's own state (absent / ok / unreadable) for the
// settings signals: the config owner records it on every refresh.
installSettingsStoreStateSource(getSettingsStoreState);
installEgressFailureSource(egressFailureCounts);

// A changed settings file is in force when it changes, not at the next
// request: a run executing between requests reads the snapshot too.
watchSettingsStore();
// The keep-out list IN FORCE on this host (the harness, every home's stores,
// the key home and its registered stores, this server's own files) for the
// `safety.keepOut` signal — the same list every compiled spec is held to.
installKeepOutSource(serverKeepOutList);
// The database's upgrade safety net (retention, newest verified pre-upgrade
// copy) for the `database.*` signals: read live, so a copy made by the boot
// migration is visible.
installDatabaseFactsSource(() => ({
  backupRetention: serverConfig.dbBackupRetention,
  newestPreMigrationCopy: serverConfig.dbPath === ":memory:" ? undefined : preMigrationBackups(serverConfig.dbPath).at(-1),
}));
// The database threads' supervision (SCALE-CR1 C4) for the `database.threads.*` signals.
installDatabaseThreadsSource(databaseThreadSupervision);
installServerKeyTool("server");

// ── Server bootstrap + security middleware ──

const server = createHttpListener(serverConfig, (req, res) => {
  // THE API SIGNS EVERY ANSWER IT GIVES: the listener owner
  // (server/router/http-listener.ts) sets the identity header on every
  // response before this handler runs, and on its parser refusals.

  // Security: enforce loopback origin (safety invariant — the loopback host
  // prefixes are owned by server/safety-invariants.ts, the safety carve-out
  // for non-configurable security floors).
  const host = req.headers.host ?? "";
  if (!isLoopbackHost(host)) {
    res.writeHead(403, { "Content-Type": CONTENT_TYPE_JSON });
    res.end(JSON.stringify({ error: "forbidden", message: "Loopback only" }));
    return;
  }

  // CORS: allow only the configured origin. (cross-cutting): the
  // allowed headers include the CSRF custom header (`x-requested-with`) so
  // a cross-origin reverse-proxy deployment can use the custom-header CSRF
  // defense (wired the client to send it on every request; without it
  // here the preflight would block the header → the defense would be inert
  // for cross-origin). The allowed methods include PATCH (the router
  // supports it + chats/projects routes use it; omitting it blocked
  // cross-origin PATCH preflight).
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", serverConfig.allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", `GET, POST, PUT, PATCH, DELETE, OPTIONS`);
    res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${CSRF_CUSTOM_HEADER}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // Single-Party-Owner: auth + CSRF + rate limiting + error
  // mapping + body parsing are ALL owned by the router's `dispatch`. The
  // bootstrap only enforces the loopback origin + CORS preflight here, then
  // hands off. The router applies the auth gate (via `isPublicPath` from
  // the registry) + the CSRF guard BEFORE any route handler runs.
  // `dispatch` answers every request itself (one catch around its whole
  // body): its promise never rejects, so dropping it is safe by construction.
  void router.dispatch(req, res);
});

// Open the timeline at boot, WITHOUT waiting on it (SCALE-CR1 C10). A ledger
// that owes nothing opens here, synchronously, and its effect sink is
// installed before anything can record; one that owes migrations has them
// run off this thread while the socket listens (`startTimeline`: the
// migrating window's effects are counted and recorded as one gap event, and
// ledger work is refused typed and retryable until it is ready).
void startTimeline();
installTimelineReadinessSource(timelineReadiness);

// Open the read pool and the writer thread BEFORE the socket listens. The
// pool opens lazily, so without this the first request would pay for spawning
// the threads and running the migrations, and a health probe could be asked
// for a schema version nothing had read yet.
await warmAsyncDb();

server.listen(serverConfig.port, serverConfig.host, guarded("server.listening", () => {
  // Report the port the socket actually bound, read back from the listening
  // handle — not the configured value. When the configured port is 0 the
  // kernel assigns a free ephemeral port inside the bind (the atomic choice
  // that replaces a probe-and-race), and only `address()` knows the number;
  // for a configured port this is the same value, so the line is truthful on
  // both paths.
  const bound = server.address();
  const boundPort = typeof bound === "object" && bound !== null ? bound.port : serverConfig.port;
  webConsoleInfo(`[bridlewise web] server on http://${serverConfig.host}:${boundPort}`);
  // The operator can see WHICH of its own credentials the redactor will
  // recognise — by label. Never by value, and there is no accessor that
  // would allow otherwise.
  webConsoleInfo(
    `[bridlewise web] redactor knows ${knownCredentialLabels.length} own credential(s): ` +
      (knownCredentialLabels.length === 0 ? "(none)" : knownCredentialLabels.join(", ")),
  );
  // THE RESOURCE TIME SERIES STARTS WITH THE SERVER, not with the first
  // curious dashboard: the sampler writes the process's footprint into the
  // ledger's resource lane on the config contract's interval, and its timer
  // is unref'd so it can never hold the process open. Stopped in shutdown()
  // below.
  startResourceSampler();
}));

/**
 * SHUTDOWN THAT ACTUALLY SHUTS DOWN.
 *
 * `server.close()` alone is not enough and stopped being enough the moment
 * this server gained a STANDING stream (`routes/live.ts`): close() shuts the
 * listener and then WAITS for established connections, and an SSE stream
 * never finishes, so the process lived on holding sockets with no listener.
 * Measured, not theorised — two orphaned servers were produced this way in
 * one session, and `kill` on them did nothing at all.
 *
 * Three steps, in this order, each covering what the previous cannot:
 *   1. end every open SSE stream, so clients get a clean end and `close()`
 *      has nothing left to wait for;
 *   2. `closeAllConnections()`, for anything else still established (a
 *      keep-alive socket mid-idle, a slow upload);
 *   3. a FORCED exit if the callback still has not fired (grace:
 *      DEFAULT_SHUTDOWN_GRACE_MS). `unref()` so it
 *      cannot itself hold the process open. A shutdown path that can hang is
 *      the defect being fixed, and it must not be reintroduced by the fix.
 */
function shutdown(): void {
  // The sampler's timer dies first: a shutdown path that leaves a standing
  // interval running is exactly the hang this block exists to prevent.
  stopResourceSampler();
  // Close every live MCP connection first: a stdio MCP server is a child
  // process that must not outlive this server, and an open http/sse socket
  // is exactly the kind of standing connection that otherwise keeps the
  // process alive past `server.close()`. Best-effort and not awaited — the
  // grace timer below is the backstop a hung close cannot outlive.
  void stopAllMcpConnections({ final: true }).then((/* closed */) => {
    webConsoleInfo("[bridlewise web] MCP connections closed");
  }).catch((err: unknown) => {
    webConsoleError(`[bridlewise web] MCP shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // The outbound door's pooled keep-alive connections (provider, MCP,
  // catalogue requests) close too; not awaited — the grace timer is the backstop.
  void closeOutboundConnections();
  const ended = closeAllSseStreams();
  if (ended > 0) {
    webConsoleInfo(`[bridlewise web] closed ${String(ended)} open stream(s)`);
  }
  // A finished run's replay buffer is RETAINED for a window so a client whose
  // socket dropped can still reconnect and see the end. Each retention holds a
  // timer, and a timer that outlives the decision to exit is exactly the kind
  // of thing that turns a clean shutdown into a hang. They are `unref()`d, so
  // this is not the difference between exiting and not — it is the difference
  // between exiting and being able to SAY what was released.
  const feeds = releaseAllRunFeeds();
  if (feeds > 0) {
    webConsoleInfo(`[bridlewise web] released ${String(feeds)} run feed(s)`);
  }
  server.closeAllConnections();
  const exit = guarded("server.shutdown.exit", () => process.exit(0));
  server.close(exit);
  setTimeout(exit, DEFAULT_SHUTDOWN_GRACE_MS).unref();
}

// The signals run it through the event-loop door (SCALE-CR1 C3): a throw in
// it is attributed and counted, and the forced exit above still ends the process.
const onShutdownSignal = guarded("server.shutdown", shutdown);
process.on("SIGTERM", onShutdownSignal);
process.on("SIGINT", onShutdownSignal);

// Process-level faults (an unhandled rejection, an uncaught exception) are the
// fault policy's, installed by the first import above.
