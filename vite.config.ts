/**
 * THE BUILD'S CONFIGURATION — what `vite`, `vite build` and `vite preview`
 * read, and what ships with the product. It names nothing the product tree
 * does not carry: the web test runner's configuration is `vitest.config.ts`,
 * which extends this one ({@link BUILD_CONFIG}, `mergeConfig`) with everything
 * only the suite needs.
 *
 * It is never the RUNNER's: vitest given this file (`vitest --config
 * vite.config.ts`) would run every default-included file — the engine's
 * `node:test` files among them — with no run lock, no checkout write door and
 * no key home. So the config vite loads refuses a test-mode load by vitest
 * (`VITEST` set, mode `test`), naming the runner's own config.
 */
import { globSync } from "node:fs";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

import {
  globMatchCounts,
  patternLivenessFailure,
} from "./engine/scripts/verification/pattern-liveness.ts";

// Align with the server config owner (server/config.ts reads HARNESS_WEB_PORT,
// default 5174). The dev proxy must target the port the API server actually
// binds to — previously this read the undocumented HARNESS_API_PORT, which
// drifted from the server when an operator set HARNESS_WEB_PORT.
const HARNESS_WEB_PORT = Number(process.env.HARNESS_WEB_PORT ?? 5174);

/**
 * THE DEP-SCANNER'S ENTRY UNIVERSE — the SECOND door into the tree, with its
 * own refusal, for the same reason the watcher has one.
 *
 * Vite's dependency scanner is not the watcher. `server.watch.ignored`
 * decides what the dev server watches for changes; the scanner decides which
 * HTML pages it crawls for dependencies to pre-bundle, and it answers
 * `watch.ignored` nothing — measured on this tree (vite 8.1.5, rolldown):
 * with the watcher ignoring `engine/**`, a cold start still scanned
 * `engine/large-codebases/real-20/.../overview.html` and forty more corpus
 * fixtures, and died inside the dotnet wasm template on its literal
 * `main#[.{fingerprint}].js` import placeholder. The default entry inference
 * is every `.html` under the project root, recursively, and
 * `engine/large-codebases` is a
 * SYMLINK to a 4.1 GB vendored corpus one directory down — the glob follows
 * it.
 *
 * So the entries are DECLARED, and the declaration is the app's pages and
 * nothing else: the root documents vite serves (`*.html`) and the client
 * tree's pages (every `.html` under `src/`, DISCOVERED: a tree whose client
 * holds no page of its own — the product tree, where the dev pages are not
 * carried — has none, and that is not a dead declaration). `optimizeDeps.entries` OVERWRITES the
 * default inference entirely (the installed version's own words), so this is
 * not a filter added to the crawl — the crawl's universe is this set, and
 * `engine/**` is unreachable by shape: no pattern names it, and no client
 * source imports it. Deny-by-default for any future fixture directory: a
 * page area outside `src/` is added here deliberately, never discovered by
 * widening the glob, because the widened-glob failure is the one measured
 * above.
 *
 * The same per-pattern refusal as the runner globs, over the declared
 * ROOT pattern: a dead one means the scanner pre-bundles less than the app
 * imports and says nothing, so the refusal lives at the door every
 * dev-server, build and test boot passes through. The client pages are not a
 * pattern that can die: each is named by its own path, found on disk, so a
 * moved page is followed rather than lost, and a tree without one (any tree
 * this file is shared with) loads the same config.
 */
const ROOT_PAGES: readonly string[] = ["*.html"];
const CLIENT_PAGES = "src/**/*.html";
export const OPTIMIZE_DEPS_ENTRIES: readonly string[] = [
  ...ROOT_PAGES,
  ...globSync(CLIENT_PAGES, { cwd: import.meta.dirname }).sort(),
];

const entriesLiveness = patternLivenessFailure(
  "vite.config.ts optimizeDeps.entries",
  globMatchCounts(ROOT_PAGES, import.meta.dirname),
);
if (entriesLiveness !== null) {
  throw new Error(
    `${entriesLiveness} The dependency scanner would crawl fewer pages than the app serves, ` +
    `and nothing downstream says so.`,
  );
}

/** The build's configuration: what {@link default} answers, and the base `vitest.config.ts` extends. */
export const BUILD_CONFIG: UserConfig = defineConfig({
  plugins: [svelte()],
  // THE PROJECT ROOT, PINNED TO THIS FILE'S OWN DIRECTORY, so the pages, the
  // public assets and the output directory resolve against the monorepo root
  // whatever the caller's cwd. The web test runner inherits it
  // (`vitest.config.ts`): vitest resolves a config by walking UP from the
  // caller's cwd, so a `npx vitest run test/editor/` launched inside
  // `engine/` reaches the runner's config and, without a pinned root, matches
  // the engine's tree against the web's globs and reports a misleading "No
  // test files found". With it the engine's `test/**` is unreachable BY
  // CONSTRUCTION — the wrong-runner invocation dead-ends on an empty suite
  // (`passWithNoTests` there) instead of a confusing red.
  root: import.meta.dirname,
  // Resolve the browser export condition so Svelte 5's `mount` (client build)
  // is used — in the client and in the jsdom test environment alike —
  // instead of the server build.
  resolve: {
    conditions: ["browser"],
  },
  optimizeDeps: {
    // The scanner's universe, declared above with its refusal. This OVERWRITES
    // the default recursive-html inference, which reached the corpus symlink
    // and died inside it — see the declaration's comment.
    entries: [...OPTIMIZE_DEPS_ENTRIES],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${HARNESS_WEB_PORT}`,
        changeOrigin: false,
        ws: false,
      },
    },
    /**
     * WHAT THE DEV SERVER WATCHES — DECLARED, BECAUSE THE MERGE CHANGED IT.
     *
     * MEASURED ON THE ASSEMBLED TREE (2026-07-31), thirty-nine seconds after
     * `npm run dev:all`: the dev server held **435,410 inotify watches**, was
     * burning 115% of a core and 3.0 GB of RSS. With this ignore in place the
     * same measurement is **1,316 watches and 1.4% of a core**. That part is
     * settled, it is large, and it is why the ignore stays.
     *
     * WHY `engine/`. Vite's own defaults already drop `node_modules` and
     * `.git`. `engine/` is not this project's client source — the browser
     * never loads a byte of it — and it carries `engine/large-codebases`, a
     * gitignored SYMLINK to a 4.1 GB vendored corpus. Watching it recursively
     * is where the 435,410 came from. Before the monorepo assembly that tree
     * was a sibling checkout and no watcher of this project could reach it;
     * it is one directory down now, and nothing said so.
     *
     * This is the DEV SERVER's watcher only. `vitest run` does not use it, and
     * the server-side and test-side imports of `engine/**` are unaffected:
     * ignoring a path means the watcher does not follow it, not that it cannot
     * be read.
     *
     * An ARRAY rather than a predicate, deliberately: Vite CONCATENATES this
     * with its own defaults, and a function would replace the merge with one
     * opinion — which is how `node_modules` would quietly come back.
     *
     * ── THE WATCHER WAS ONE CAUSE. IT WAS NOT THE ONLY ONE. ──
     *
     * The first version of this comment attributed the whole proxied-request
     * latency to the watcher and closed the question. **The latency survived
     * the fix**, and the closed question sent two later rounds of
     * investigation into the wrong subsystem — which is the cost of writing a
     * settled cause where an open one belongs. Measured AFTER the ignore was
     * in place, on the same tree:
     *
     *   - `/api/health` — a 36-byte response — **1097 ms** through this proxy.
     *   - a `400 missing_path` — a refusal that does no work at all —
     *     **8309 ms**.
     *   - across 62 profiled GETs: max **10.3 ms** proxied while the page is
     *     idle, but **1.0071 / 1.0187 / 1.0084 / 1.0125 / 1.0197 / 0.9617 s**
     *     while a cockpit page is loading — against **1.2 / 2.2 / 31 ms**
     *     taken DIRECTLY against the API server at the same instants.
     *
     * The direct-versus-proxied pair at one instant is what implicates THIS
     * hop and nothing downstream of it: same handler, same moment, three
     * orders of magnitude apart. A slow route cannot be fast when asked
     * directly.
     *
     * WHAT IS RULED OUT, recorded so the next reader does not re-measure it.
     * During one 962 ms stall: `time_connect` **0.53 ms** (the TCP handshake
     * is not what is slow); `TcpExtTCPSynRetrans` **unmoved** (not the accept
     * backlog); the dev server accumulated **3 CPU ticks** across the whole
     * stall (it is idle-WAITING, not CPU-blocked, so this is not the watcher
     * regressing); and Vite's own `/@vite/client` answered in **2.6 ms**
     * through the same process in the same window (the server as a whole is
     * responsive). Only the `/api` hop stalls, and it stalls in roughly
     * one-second quanta.
     *
     * THE MECHANISM IS NOT IDENTIFIED. Two candidates remain, and this
     * comment deliberately does not pick one:
     *   1. upstream keep-alive socket reuse racing the API server's
     *      `keepAliveTimeout` — the proxy hands a request to a socket the
     *      upstream is closing, and the retry costs a quantum;
     *   2. the standing `/api/live` SSE stream's interaction with the proxy's
     *      upstream agent — a never-ending response held on a pooled socket.
     *
     * WHY IT STOPS HERE RATHER THAN AT A FIX (the mechanism, not the effort):
     * the stall only reproduces while a cockpit page is loading — i.e. only
     * when the request fan-out and the standing SSE stream are both present —
     * and from outside the process the two candidates are INDISTINGUISHABLE,
     * because nothing observes which upstream socket a given proxied request
     * was waiting on. Both produce the same client-side signature: an idle
     * server, a healthy handshake, and a one-second quantum. Separating them
     * needs an instrument inside the proxy's agent, and until that exists any
     * change here would be a guess dressed as a fix — which is exactly what
     * the first version of this comment was.
     */
    watch: {
      ignored: ["**/engine/**"],
    },
  },
  build: {
    target: "esnext",
    outDir: "dist/client",
    sourcemap: true,
  },
});

/** What vite loads (see the header): the build's configuration, refused to vitest's test mode. */
export default defineConfig((env: ConfigEnv): UserConfig => {
  if (process.env.VITEST !== undefined && env.mode === "test") {
    throw new Error("vite.config.ts is the build's configuration, not the web test runner's: vitest given it would run every default-included file with no run lock, no checkout write door and no key home. Run the suite through vitest.config.ts (`npm test`, or `npx vitest` with no --config).");
  }
  return BUILD_CONFIG;
});
