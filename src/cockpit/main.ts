/**
 * COCKPIT entry (§13) — mounts the shell. `src/main.ts` (the module
 * index.html loads) dynamically imports this and calls `bootCockpit`; the
 * split keeps the synchronous entry stub tiny while this module carries the
 * app's whole import graph.
 *
 * This entry imports the CARBON/LOGBOOK tokens; they are the ONE visual
 * token owner (guard: tests/cockpit/cockpit-tokens-owner.test.ts).
 */
import { mount } from "svelte";

import Cockpit from "./Cockpit.svelte";
import { diagnoseLivenessConnection, openLivenessStream, startChatRecordWatch } from "../client.ts";
import { clientWarn } from "../client-debug.ts";
import { SW_REGISTER_FALLBACK_DELAY_MS } from "./shell/config.ts";
import { watchServiceWorkerUpdate } from "./shell/sw-update.ts";
import { startLivenessWatch } from "../data/connection.ts";
import "./tokens.css";

/** Density is a :root attribute (§2.7) — `scan | work | deep`. `work` is
 * the default; the desk setting lands with the settings surface. */
const DENSITY_DEFAULT = "work";

/**
 * PWA service-worker registration — owned by the entry, because "this
 * process is a running page that should be installable" is an entry-point
 * fact. Hand-written (no deps). Only registers in a real browser that
 * supports service workers AND is on a secure context (localhost or https).
 * Vitest's jsdom has no `navigator.serviceWorker`, so this is a no-op in
 * tests. Deferred to idle so it never competes with first paint. A failed
 * registration is logged but never blocks the app.
 */
function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const run = () => {
    if (import.meta.env.DEV) {
      // Do not install offline caching into development. An older installed
      // worker still needs the corrected passthrough strategy, without an
      // automatic reload or touching another application's registration.
      void navigator.serviceWorker.getRegistration("/").then((registration) => {
        if (registration?.active?.scriptURL !== new URL("/sw.js", location.origin).href) return;
        watchServiceWorkerUpdate(navigator.serviceWorker, registration, () => window.location.reload());
        return registration.update();
      }).catch((err: unknown) => clientWarn("pwa", "service worker development update failed:", err));
      return;
    }
    const registering = navigator.serviceWorker.register("/sw.js", { scope: "/" });
    registering
      .then((registration) => {
        // A deploy while this page is open must not be silent (sw-update.ts):
        // the watch turns update evidence into the one-shot chip store, and
        // applying is a soft reload — the reader's click, never automatic.
        watchServiceWorkerUpdate(navigator.serviceWorker, registration, () =>
          window.location.reload(),
        );
      })
      .catch((err: unknown) => {
        clientWarn("pwa", "service worker registration failed:", err);
      });
  };
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    (window as Window).requestIdleCallback(() => void run());
  } else {
    setTimeout(() => void run(), SW_REGISTER_FALLBACK_DELAY_MS);
  }
}

export function bootCockpit(target: HTMLElement): void {
  document.documentElement.dataset.density ??= DENSITY_DEFAULT;
  // A COCKPIT AT REST ISSUES NO REQUESTS (measured: zero fetches in twelve
  // seconds on a loaded screen), so without a held socket an API that dies
  // under an idle tab would go unnoticed until the reader next clicked
  // something. Opened HERE because "this process is a running page" is a fact
  // only an entry point knows — see `startLivenessWatch`. The two halves are
  // wired together here rather than importing each other, because
  // `src/client.ts` owns `new EventSource` and already imports the Broker.
  // Both halves go over together — the socket, and the diagnosis that decides
  // whether a failure to open it was an outage or a refusal (`LivenessPort`).
  startLivenessWatch({
    open: openLivenessStream,
    diagnose: diagnoseLivenessConnection,
  });
  // THE FOCUS-TIME RECORD CHECK (UIE-052): a background tab's open
  // conversation is deliberately not synced, so the moment the reader
  // RETURNS is the one moment its staleness can matter — the check is one
  // row, and only a record that moved on pays the re-read. An entry-point
  // fact like the liveness socket above ("this page just became the one the
  // reader is looking at"), so it is wired here the same way.
  startChatRecordWatch();
  registerServiceWorker();
  mount(Cockpit, { target });
}
