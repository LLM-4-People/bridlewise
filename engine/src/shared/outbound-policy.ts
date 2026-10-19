/**
 * THE OUTBOUND DOOR'S POLICY AND OBSERVABLE STATE — no transport.
 *
 * The door (`outbound-http.ts`) owns every request and WebSocket the harness
 * sends, on its HTTP client. What STEERS it — the config document's `network`
 * section (its schema, defaults and the host's live source), the destination
 * rule an owner's requests are held to — and what it has OBSERVED (refusals by
 * code, cleartext and proxied origins) live here, so the modules that only
 * declare or show them (the config contract, the `network` exposure module,
 * both reachable from the browser build) never load the HTTP client.
 */
import { z } from "zod";

/** What the policy decides for a cleartext request to a non-loopback host. */
export const CLEARTEXT_REMOTE_POLICIES = ["refuse", "warn"] as const;
export type CleartextRemotePolicy = typeof CLEARTEXT_REMOTE_POLICIES[number];

/**
 * THE DOOR'S SETTINGS — the config document's `network` section, declared
 * here beside the policy they steer (composed into the document schema by
 * `config-contracts.ts`, exposed once by `registrations/network.ts`).
 */
/** Whether a NON-ADMIN's saved provider may reach private addresses (a local model server). */
export const USER_PRIVATE_ADDRESS_POLICIES = ["refuse", "allow"] as const;
export type UserPrivateAddressPolicy = typeof USER_PRIVATE_ADDRESS_POLICIES[number];

export const OUTBOUND_POLICY_SCHEMA = z.strictObject({
  /** Cleartext (`http://`, `ws://`) to a non-loopback host, or through an environment proxy: refused, or sent with a central warning. */
  cleartextRemote: z.enum(CLEARTEXT_REMOTE_POLICIES).optional(),
  /** A non-admin's provider (discovery, test, runs) reaching loopback/private addresses: refused (default), or allowed by an admin. */
  userPrivateAddresses: z.enum(USER_PRIVATE_ADDRESS_POLICIES).optional(),
  /** How long a pooled connection may sit idle before the door closes it, when its server advertises no keep-alive (below common servers' timeouts). */
  idleConnectionMs: z.number().int().min(100).max(60_000).optional(),
  /** The margin a connection is retired by BEFORE its keep-alive runs out: reused only while idle < keep-alive − this. */
  keepAliveThresholdMs: z.number().int().min(0).max(10_000).optional(),
}).refine(
  // A margin at or above the idle maximum leaves no reuse window at all: every request would open a connection, by a
  // configuration that says nothing of the kind (correctness H-L6). Judged on the EFFECTIVE pair (a default fills a gap).
  // The pair is resolved by the module's ONE resolver (read when a section is parsed, after the module is defined).
  (section) => {
    const effective = effectiveOutboundPolicy(section);
    return effective.keepAliveThresholdMs < effective.idleConnectionMs;
  },
  { message: "network.keepAliveThresholdMs must be below network.idleConnectionMs: a connection is reused only while idle < keep-alive − threshold", path: ["keepAliveThresholdMs"] },
);
export type OutboundPolicy = Readonly<{ cleartextRemote: CleartextRemotePolicy; userPrivateAddresses: UserPrivateAddressPolicy; idleConnectionMs: number; keepAliveThresholdMs: number }>;
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = Object.freeze({ cleartextRemote: "refuse", userPrivateAddresses: "refuse", idleConnectionMs: 4000, keepAliveThresholdMs: 1000 });

let policySource: () => Partial<OutboundPolicy> = () => ({});

/** The host installs where the `network` section is read from (the web server: its live config). */
export function installOutboundPolicySource(source: () => Partial<OutboundPolicy>): void {
  policySource = source;
}

/** The policy in force: the host's configured values over the defaults. */
export function outboundPolicy(): OutboundPolicy {
  return effectiveOutboundPolicy(policySource());
}

/** THE ONE RESOLVER: configured values over the defaults (an absent value takes its default). */
function effectiveOutboundPolicy(configured: Readonly<{ [K in keyof OutboundPolicy]?: OutboundPolicy[K] | undefined }>): OutboundPolicy {
  return Object.freeze({ ...DEFAULT_OUTBOUND_POLICY, ...Object.fromEntries(Object.entries(configured).filter(([, value]) => value !== undefined)) });
}

/**
 * THE DESTINATION RULE a credential is minted with (cred-final §8.2): an
 * admin's own providers may reach private addresses (a local model server is
 * a real case); a non-admin's may only when an admin allows it
 * (`network.userPrivateAddresses`). One answer for discovery, the connection
 * test and every run.
 */
export function privateAddressesAllowedFor(owner: Readonly<{ isAdmin: boolean }>): boolean {
  return owner.isAdmin || outboundPolicy().userPrivateAddresses === "allow";
}

/**
 * THE OPERATOR as an owner: what an admin configured for the whole harness
 * (an MCP server, the evaluation and drift references, the engine CLI's
 * provider, a trace tool) — asked through {@link privateAddressesAllowedFor}
 * like every other owner, so a later rule for operator paths (a metadata
 * address never reachable, say) applies to all of them at once.
 */
export const OPERATOR_OWNER: Readonly<{ isAdmin: boolean }> = Object.freeze({ isAdmin: true });

const refusalsByCode = new Map<string, number>();
const cleartextOrigins = new Set<string>();
const proxiedOrigins = new Set<string>();

/** The door's observable state (served by the exposure registry). */
export function outboundSignals(): Readonly<{ refusals: Readonly<Record<string, number>>; cleartextOrigins: readonly string[]; proxiedOrigins: readonly string[] }> {
  return Object.freeze({
    refusals: Object.freeze(Object.fromEntries(refusalsByCode)),
    cleartextOrigins: Object.freeze([...cleartextOrigins]),
    proxiedOrigins: Object.freeze([...proxiedOrigins]),
  });
}

/** Count one refusal by its code (the door's refusals and byte bounds). */
export function countOutboundRefusal(code: string): void {
  refusalsByCode.set(code, (refusalsByCode.get(code) ?? 0) + 1);
}

/** Record an origin reached in the clear or through a proxy; true the first time (the door logs each once). */
export function firstSightOf(kind: "cleartext" | "proxied", origin: string): boolean {
  const seen = kind === "cleartext" ? cleartextOrigins : proxiedOrigins;
  if (seen.has(origin)) return false;
  seen.add(origin);
  return true;
}
