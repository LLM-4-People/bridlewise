/**
 * Shared exposure registrations — `network` module: the outbound HTTP door
 * (`shared/outbound-http.ts`; its settings and counters live in `shared/outbound-policy.ts`).
 *
 * The door's settings are registered here once and read by the door for
 * EVERY outbound consumer — the LLM provider client, every MCP server, the
 * drift classifier, the evaluation reference transport:
 * `network.cleartextRemote` (cleartext to another machine, or through an
 * environment proxy: refuse or warn) and `network.userPrivateAddresses`
 * (whether a non-admin's saved provider may reach loopback or private
 * addresses — the destination rule stamped on every credential at its mint:
 * refuse or allow). Registering them also installs the door's policy source,
 * so the host's config store is where the door reads them (a value a hand
 * edit made invalid reads as the safe default, `refuse`).
 *
 * The door's own state is served as signals: its refusals by code, the
 * cleartext origins it warned about, and the origins it saw routed through an
 * environment proxy.
 */

import {
  readConfigCustomization,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  schemaBounds,
  writeConfigCustomization,
} from "../index.ts";
import {
  CLEARTEXT_REMOTE_POLICIES,
  USER_PRIVATE_ADDRESS_POLICIES,
  DEFAULT_OUTBOUND_POLICY,
  OUTBOUND_POLICY_SCHEMA,
  installOutboundPolicySource,
  outboundSignals,
  type OutboundPolicy,
} from "../../outbound-policy.ts";

const CLEARTEXT_PATH = "network.cleartextRemote";
const USER_PRIVATE_PATH = "network.userPrivateAddresses";

/** A configured door decision; an absent or invalid value is the safe default. */
function configured<K extends keyof OutboundPolicy>(key: K, path: string): OutboundPolicy[K] {
  const parsed = OUTBOUND_POLICY_SCHEMA.shape[key].safeParse(readConfigCustomization(path));
  return parsed.success && parsed.data !== undefined ? parsed.data as OutboundPolicy[K] : DEFAULT_OUTBOUND_POLICY[key];
}
const configuredCleartext = (): OutboundPolicy["cleartextRemote"] => configured("cleartextRemote", CLEARTEXT_PATH);
const configuredUserPrivate = (): OutboundPolicy["userPrivateAddresses"] => configured("userPrivateAddresses", USER_PRIVATE_PATH);
const IDLE_PATH = "network.idleConnectionMs";
const configuredIdle = (): OutboundPolicy["idleConnectionMs"] => configured("idleConnectionMs", IDLE_PATH);
const THRESHOLD_PATH = "network.keepAliveThresholdMs";
const configuredThreshold = (): OutboundPolicy["keepAliveThresholdMs"] => configured("keepAliveThresholdMs", THRESHOLD_PATH);

let networkRegistered = false;

export function registerNetworkExposure(): void {
  if (networkRegistered) return;
  networkRegistered = true;
  installOutboundPolicySource(() => ({ cleartextRemote: configuredCleartext(), userPrivateAddresses: configuredUserPrivate(), idleConnectionMs: configuredIdle(), keepAliveThresholdMs: configuredThreshold() }));

  registerExposureModule({
    id: "network",
    title: "Requests to other machines",
    purpose:
      "How the harness talks to model providers and remote tool servers: whether an unencrypted address on another machine is allowed, and what the one door every such request passes has refused.",
  });

  registerCustomization({
    id: "network.cleartextRemote",
    module: "network",
    name: "Unencrypted addresses on other machines",
    description:
      "A model provider or tool server reached over http:// or ws:// on another machine — or through the environment's proxy — receives its credentials and every request in the clear. Refuse keeps those addresses unused; warn allows them and records a warning. Addresses on this machine are always allowed when no proxy relays them.",
    type: "enum",
    default: DEFAULT_OUTBOUND_POLICY.cleartextRemote,
    enum: [...CLEARTEXT_REMOTE_POLICIES],
    current: () => configuredCleartext(),
    set: (value) => writeConfigCustomization(CLEARTEXT_PATH, value),
    contract: { effect: "immediate" },
    configPath: CLEARTEXT_PATH,
  });

  registerCustomization({
    id: USER_PRIVATE_PATH,
    module: "network",
    name: "Users' providers on private addresses",
    description:
      "Whether a model provider saved by a user who is not an admin may be reached at an address on this machine or a private network (a local model server). Refuse keeps the server from sending requests to its own network on a user's behalf; allow lets every user's provider reach it. An admin's own providers may always. Applies to finding models, testing a provider and every run, from the next request.",
    type: "enum",
    default: DEFAULT_OUTBOUND_POLICY.userPrivateAddresses,
    enum: [...USER_PRIVATE_ADDRESS_POLICIES],
    current: () => configuredUserPrivate(),
    set: (value) => writeConfigCustomization(USER_PRIVATE_PATH, value),
    // Read when a credential is minted, per request: the provider client
    // cache is keyed by the rule (server/llm/llm-bridge.ts), so a change
    // applies from the next request (secd-design L11: one truth).
    contract: { effect: "next-run" },
    configPath: USER_PRIVATE_PATH,
  });

  registerCustomization({
    id: IDLE_PATH,
    module: "network",
    name: "Idle connection lifetime",
    description:
      "How long, in milliseconds, a connection to a model provider or tool server is kept open between requests when its server advertises no keep-alive of its own. Keep it below the servers' own idle timeouts (commonly 5 seconds): a connection a server closes just as a request is sent on it loses that request.",
    type: "number",
    default: DEFAULT_OUTBOUND_POLICY.idleConnectionMs,
    unit: "milliseconds",
    min: schemaBounds(OUTBOUND_POLICY_SCHEMA.shape.idleConnectionMs).min,
    max: schemaBounds(OUTBOUND_POLICY_SCHEMA.shape.idleConnectionMs).max,
    current: () => configuredIdle(),
    set: (value) => writeConfigCustomization(IDLE_PATH, value),
    // New connections take it; a pooled one keeps the lifetime it was opened with.
    contract: { effect: "immediate" },
    configPath: IDLE_PATH,
  });

  registerCustomization({
    id: THRESHOLD_PATH,
    module: "network",
    name: "Keep-alive safety margin",
    description:
      "How many milliseconds before a connection's keep-alive runs out (the server's advertised Keep-Alive timeout, else the idle connection lifetime) the harness stops reusing it. Checked when a connection would be reused, never left to a timer: a connection idle for longer is closed, not written to, so a request is never sent on a socket its server is closing.",
    type: "number",
    default: DEFAULT_OUTBOUND_POLICY.keepAliveThresholdMs,
    unit: "milliseconds",
    min: schemaBounds(OUTBOUND_POLICY_SCHEMA.shape.keepAliveThresholdMs).min,
    max: schemaBounds(OUTBOUND_POLICY_SCHEMA.shape.keepAliveThresholdMs).max,
    current: () => configuredThreshold(),
    set: (value) => writeConfigCustomization(THRESHOLD_PATH, value),
    // New pools take it (the door's pools are keyed by it).
    contract: { effect: "immediate" },
    configPath: THRESHOLD_PATH,
  });

  registerSignal({
    id: "network.outboundRefusals",
    module: "network",
    name: "Requests the outbound door refused",
    description: "How many outbound requests were refused, by reason (a redirect, cleartext to another machine, a private address, a bad header, TLS verification off, a response too large), since the harness started.",
    type: "string",
    value: () => JSON.stringify(outboundSignals().refusals),
  });
  registerSignal({
    id: "network.cleartextOrigins",
    module: "network",
    name: "Unencrypted addresses in use",
    description: "The addresses on other machines the harness has sent unencrypted requests to (only when the setting above is warn).",
    type: "string",
    value: () => outboundSignals().cleartextOrigins.join(", "),
  });
  registerSignal({
    id: "network.proxiedOrigins",
    module: "network",
    name: "Addresses reached through the environment's proxy",
    description: "Encrypted addresses whose requests Node routed through the HTTPS_PROXY of the environment (tunnelled end to end).",
    type: "string",
    value: () => outboundSignals().proxiedOrigins.join(", "),
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetNetworkRegistration(): void {
  networkRegistered = false;
}
