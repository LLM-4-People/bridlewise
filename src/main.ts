import { ClientError } from "./client";

const target = document.getElementById("app");
if (target === null) {
  throw new ClientError("bootstrap_no_root", "Root element #app not found");
}

// ── The cockpit is the ONLY entry ──
// The shell itself is loaded dynamically so this module stays a tiny synchronous
// stub: the root-element refusal above runs before any of the app's module
// graph is paid for. `bootCockpit` owns everything a running page needs —
// the liveness socket (see `startLivenessWatch` for why an entry point must
// hold it), the density attribute, and the service-worker registration.
void import("./cockpit/main").then(({ bootCockpit }) => bootCockpit(target));
