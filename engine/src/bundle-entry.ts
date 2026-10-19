/**
 * Bundle entry point for the Landlock self-protection guardian (EXP481 fix).
 *
 * `src/cli.ts` is the package's public API entry (`package.json` exports `.` →
 * `src/cli.ts`); the S1-B06-HOSTILE-REAL scenario verifies that surface
 * exposes ONLY `runCli`. The frozen esbuild bundle (`dist/bundle.js`), however,
 * is the sole import path available inside the Landlock guardian (the harness
 * root `src/` is protected), and the restricted child imports
 * `loadPinnedConfigSnapshot` from the bundle to exercise the env-var fast-path.
 *
 * Separating the bundle entry from the public API entry lets each expose
 * exactly the surface it needs: the package public API is `{ runCli }` (one
 * entry), and the bundle is `{ runCli, loadPinnedConfigSnapshot }` (this
 * module, used only as the esbuild entry in `scripts/build-bundle.ts`).
 */
export { runCli } from "./cli.ts";
export { loadPinnedConfigSnapshot } from "./kernel/config.ts";
