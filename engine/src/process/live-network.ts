/**
 * THE LIVE-NETWORK OPT-IN OF A TEST RUN — one answer for both network doors.
 *
 * A process under test dials nothing but this machine: the outbound door
 * refuses a remote destination (`src/shared/outbound-http.ts`,
 * `outbound_network_under_test`) and every process that runs tests is held to
 * this machine at the socket (`scripts/tooling/network-under-test.ts`).
 * A deliberate live interop or conformance suite (the remote MCP servers the
 * shipped config names, a provider's live conformance receipt) is the one
 * declared exception (wf-del2-correctness NEW-5: the remote MCP arms had been
 * deleted instead): the operator sets the root policy's consent variable
 * (`verification.networkUnderTest.liveConsentVariable`) to "1" in the run's
 * environment, and exactly the declared `liveHosts` — exact names, never a
 * suffix — become reachable. Nothing else does, consent or not.
 *
 * The consent is read from THIS process's environment, which every
 * descendant of the run inherits; each process that finds it records one
 * audit event (`live-network-under-test`) naming the hosts, so a live run is
 * never silent.
 */

import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";

const POLICY = ROOT_POLICY.verification.networkUnderTest;
const LIVE_HOSTS: readonly string[] = POLICY.liveHosts;

let audited = false;

/**
 * The hosts a process under test may reach: the declared live hosts when the
 * run's environment consents, none otherwise.
 */
export function liveHostsUnderTest(): readonly string[] {
  if (process.env[POLICY.liveConsentVariable] !== "1") return [];
  if (!audited) {
    audited = true;
    auditEvent("live-network-under-test", { consentVariable: POLICY.liveConsentVariable, hosts: LIVE_HOSTS, pid: process.pid });
  }
  return LIVE_HOSTS;
}

/** Whether `hostname` (exact, lower case) is a live host this run consented to. */
export function liveHostConsented(hostname: string): boolean {
  return liveHostsUnderTest().includes(hostname.toLowerCase());
}
