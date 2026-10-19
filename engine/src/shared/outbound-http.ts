/**
 * THE OUTBOUND HTTP POLICY — the one door every request the harness sends to
 * a remote server passes through: the LLM provider client
 * (`shared/llm/provider-http.ts`, model discovery included), the MCP
 * Streamable HTTP and WebSocket transports, the drift classifier and the
 * evaluation reference transport. A caller builds no `fetch` options of its
 * own and hands the door NO transport: it names the URL, the method, its
 * protocol headers, the operator's headers, the body and its lifetime, and
 * this module decides the rest:
 *
 *   - THE DOOR OWNS ITS TRANSPORT — ONE CLIENT, `undici` (a direct
 *     dependency), for HTTP requests AND WebSocket handshakes
 *     ({@link openOutboundWebSocket}): every request is dispatched by the
 *     door's own dispatcher, never a caller-supplied one: an injected
 *     transport could follow redirects, switch TLS verification off or
 *     receive injected credentials, and every guarantee below would be a
 *     claim about somebody else's code (secb-design F-6). There is NO
 *     substitution: tests answer through a real loopback server
 *     (`engine/test/support/loopback-upstream.ts`) and a real WebSocket
 *     server, so the transport they exercise is the one production uses.
 *   - EVERY REQUEST AND EVERY HANDSHAKE IS PINNED. The door resolves the host
 *     ONCE, holds the answer to the request's destination rule, and connects
 *     to exactly those addresses (the connector's `lookup` returns the checked
 *     ones), so a rebinding resolver cannot answer differently between the
 *     check and the connection (secc-security SECC-V-B3). The connection POOL
 *     is keyed by the checked address set itself (one dispatcher per set,
 *     `runtime.limits.maximumPinnedDispatchers` at most, least recently used
 *     closed first): a kept-alive connection is reused only by a request
 *     pinned to the same addresses, never by a later request to the same
 *     host name whose own check answered differently (secd-security
 *     SECD-V-B1, the pooled keep-alive bypass).
 *   - REDIRECTS ARE NEVER FOLLOWED. A request carries credentials (a bearer
 *     token, an `X-API-Key`, an `Mcp-Session-Id`), and a followed redirect
 *     re-sends every header except the few the fetch implementation strips
 *     to wherever the `Location` points — a reproduced leak of an MCP api-key
 *     to another host (SEC-V-1). The fetch runs with `redirect: "manual"` and
 *     ANY 3xx answer is the typed refusal `outbound_redirect_refused`, with
 *     no second request.
 *   - TLS IS VERIFIED. The platform fetch verifies certificates; the one way
 *     to switch that off process-wide (`NODE_TLS_REJECT_UNAUTHORIZED=0`) makes
 *     every `https:` request here the refusal
 *     `outbound_tls_verification_disabled`.
 *   - CLEARTEXT IS ONE DECISION, OWNED HERE. `http:` (and `ws:`) to a
 *     LOOPBACK host (`localhost`, 127.0.0.0/8, `::1` — exact, never a name
 *     suffix: `evil.localhost` is resolved by the system resolver and was
 *     measured reaching a LAN host) never leaves the machine and is allowed;
 *     to any other host the credentials cross the network in the clear, and
 *     the ONE setting `network.cleartextRemote` decides: `refuse` (the
 *     default, `outbound_cleartext_refused`) or `warn` (one central warning
 *     per origin). It is the same decision for the LLM provider and every MCP
 *     server (it used to be two keys with opposite defaults).
 *   - AN ENVIRONMENT PROXY NEVER CARRIES A CLEARTEXT REQUEST SILENTLY. When
 *     the process asks for the environment's proxy (`NODE_USE_ENV_PROXY=1` or
 *     `--use-env-proxy`), `HTTP_PROXY`/`HTTPS_PROXY` names one and `NO_PROXY`
 *     does not exempt the target — the variables read as the platform reads
 *     them, lowercase first and an empty value passed over — THE DOOR routes
 *     through it with its own proxy agent (its decision is the behaviour, not
 *     a prediction of it), an `http:` request — credentials included — is read
 *     by the proxy in cleartext, loopback target or not: it is held to the
 *     cleartext decision as a non-loopback request. An `https:` request is
 *     tunnelled (TLS end to end) and the route is logged once per origin.
 *   - PRIVATE ADDRESSES ARE A DECISION OF THE CREDENTIAL. Every request
 *     states `allowPrivateAddress` (required, no default): a request that may
 *     not reach the harness's own network (anything a non-admin's saved
 *     provider sends, cred-final §8.2) refuses a host resolving to a
 *     loopback, private, link-local, shared, benchmark, multicast, reserved,
 *     documentation or unspecified address — IPv4 embedded in IPv6 (mapped,
 *     compatible, NAT64, 6to4, Teredo) judged by the IPv4 inside
 *     (`outbound_private_destination_refused`). The value is stamped on the
 *     credential when it is minted (`privateAddressesAllowedFor`), so
 *     discovery, the connection test and inference give one answer. Such a
 *     request is never handed to an environment proxy (the proxy would
 *     resolve the name again): `outbound_destination_unpinnable`.
 *   - PROXIED DEPLOYMENTS, STATED: behind a corporate proxy
 *     (`NODE_USE_ENV_PROXY` + `HTTPS_PROXY`), every request held to public
 *     addresses — every non-admin user's provider traffic by default — is
 *     refused, because the proxy resolves the name itself and the door cannot
 *     hold its answer to the rule. The administrator's options, named in the
 *     refusal: exempt the provider hosts with `NO_PROXY` in the SERVER's
 *     environment (they then go direct and pinned), or allow users' requests
 *     to private addresses (`network.userPrivateAddresses = allow`, which
 *     lets them through the proxy unpinned). Admin and operator requests are
 *     proxied (tunnelled for `https:`) and logged once per origin.
 *   - HEADERS ARE ALLOWLISTED BY GRAMMAR AND ROLE. Operator headers must be
 *     RFC 9110 tokens with values free of CR, LF and NUL, and may not name a
 *     connection-level header. Protocol headers are applied last and win; a
 *     protocol header the platform refuses (a credential with a line break)
 *     is the typed `outbound_header_invalid`, never a raw `TypeError`.
 *   - SIZE AND TIME ARE BOUNDED. A response body is read only through
 *     {@link readBody} / {@link decodeReadableStream}, whose byte bound is a
 *     required argument (`outbound_body_too_large`); a body that is not read
 *     is let go through {@link discardBody}; a request's lifetime is the
 *     shared `deadline()` of `abort-signals.ts`, whose timeout is required —
 *     and it is the ONLY lifetime: every dispatcher is built from
 *     {@link dispatcherOptions}, which turns the client's own headers and
 *     body timeouts off (undici's 300 s defaults would cut a 600 s Responses
 *     call, or an SSE stream silent for five minutes, below its deadline and
 *     report it as a network failure — sec-e-design H1).
 *
 * Every refusal is an `OutboundHttpError` (a `SecurityError`, never
 * retryable) with a stable code, LOGGED ONCE HERE, counted by code and served
 * as signals (`outboundSignals`); each caller maps it into its own error
 * family at its own boundary, and no caller retries it.
 */

import { guarded } from "../process/fault-policy.ts";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { LookupAddress } from "node:dns";

import type { Dispatcher } from "undici";

import { HarnessError, SecurityError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { debugLog } from "./debug/debug-system.ts";
import { deadline } from "./abort-signals.ts";
import { PROXY_VARIABLES } from "../process/environment-projection.ts";
import { processUnderTest } from "../filesystem/checkout-write-door.ts";
import { liveHostConsented } from "../process/live-network.ts";
import { countOutboundRefusal, firstSightOf, outboundPolicy } from "./outbound-policy.ts";

export const CONTENT_TYPE_SSE = "text/event-stream";

export class OutboundHttpError extends SecurityError {
  constructor(message: string, code: string, safeDetails: Readonly<Record<string, string | number | boolean>> = {}) {
    super(message, code, safeDetails);
  }
}

export function isOutboundHttpError(error: unknown): error is OutboundHttpError {
  return error instanceof OutboundHttpError;
}

/** THE refusal: logged once here with its code, counted, and thrown typed. */
function refuse(logCategory: string, message: string, code: string, safeDetails: Readonly<Record<string, string | number | boolean>> = {}): never {
  countOutboundRefusal(code);
  debugLog(logCategory, "warn", code, () => ({ ...safeDetails }));
  throw new OutboundHttpError(message, code, safeDetails);
}

/**
 * Connection-level headers: framing and hop-by-hop fields (RFC 9110 §7.6.1,
 * RFC 9112 §6-7), `Host`, and `Proxy-Authorization` (a proxy credential is
 * never configuration's to send to an origin).
 */
const CONNECTION_LEVEL_HEADERS: ReadonlySet<string> = new Set([
  "connection", "content-length", "expect", "host", "keep-alive", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
/** RFC 9110 §5.6.2 `token` — the header field-name grammar. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/u;
/** Secure and cleartext schemes per caller family: a `fetch` caller never admits `ws:`, a WebSocket never `http:`. */
const SCHEMES = Object.freeze({
  http: Object.freeze({ secure: "https:", cleartext: "http:" }),
  websocket: Object.freeze({ secure: "wss:", cleartext: "ws:" }),
});
export type OutboundSchemeFamily = keyof typeof SCHEMES;

export type OutboundUrlCheck = Readonly<{
  /** The central-log category of the caller (a configured debug category). */
  logCategory: string;
  /** Which schemes the caller speaks (default `http`). */
  schemes?: OutboundSchemeFamily;
}>;

/** Loopback (127.0.0.0/8, ::1 — and their IPv4-mapped spellings) by address, not by name. */
const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addAddress("::1", "ipv6");

/**
 * Every address that is NOT the public internet: "this network", RFC 1918
 * private, CGNAT shared space, loopback, link-local (cloud metadata lives at
 * 169.254.169.254), IETF protocol assignments, the documentation TEST-NETs,
 * benchmarking (198.18/15), multicast, reserved/broadcast; IPv6
 * unspecified, loopback, discard, documentation, local NAT64, unique-local,
 * link-local, the deprecated site-local and multicast. IPv4 inside IPv6 is
 * judged by the IPv4 it carries ({@link embeddedIpv4}).
 */
const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

/** The eight 16-bit groups of an IPv6 address (dotted IPv4 tails and `::` expanded). */
function ipv6Groups(address: string): readonly number[] {
  let text = address.toLowerCase().replace(/%.*$/u, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1]!.split(".").map(Number);
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":"), right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : 8 - left.length - right.length).fill("0"), ...right];
  return groups.map((group) => Number.parseInt(group, 16));
}

function ipv4Of(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * The IPv4 address an IPv6 address carries and would reach: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`),
 * 6to4 (`2002:AABB:CCDD::/16`) and Teredo (`2001:0::/32`, client address
 * inverted in the last 32 bits). Undefined for any other IPv6 address.
 */
function embeddedIpv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (g.length !== 8) return undefined;
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0) && !(g[5] === 0 && g[6] === 0)) return ipv4Of(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4Of(g[6]!, g[7]!);
  if (g[0] === 0x2002) return ipv4Of(g[1]!, g[2]!);
  if (g[0] === 0x2001 && g[1] === 0) return ipv4Of(g[6]! ^ 0xffff, g[7]! ^ 0xffff);
  return undefined;
}

/** A URL host without IPv6 brackets. */
function bareHost(hostname: string): string {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname).toLowerCase();
}

/**
 * THE loopback predicate for host NAMES — one owner for the harness (the web
 * server's `Host`-header check asks it too): `localhost` exactly, or a
 * loopback IP literal. Never a suffix: `*.localhost` is an ordinary name the
 * system resolver may send anywhere (secb-security SECB-V-3, measured).
 */
export function isLoopbackHostName(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === "localhost") return true;
  const family = isIP(host);
  return family !== 0 && LOOPBACK_ADDRESSES.check(host, family === 4 ? "ipv4" : "ipv6");
}

/** Whether an IP address is on the public internet (see {@link NON_PUBLIC_ADDRESSES} and {@link embeddedIpv4}). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !NON_PUBLIC_ADDRESSES.check(address, "ipv4");
  const inner = embeddedIpv4(address);
  if (inner !== undefined) return isPublicAddress(inner);
  return !NON_PUBLIC_ADDRESSES.check(address, "ipv6");
}

/**
 * THE PLATFORM'S OWN NETWORK VARIABLES — whether the process asked for its
 * environment's proxy, which proxy, which hosts skip it, and whether TLS
 * verification is off. Process facts the door holds its policy against,
 * never harness configuration, read here by name AS THE PLATFORM READS THEM:
 * the lowercase spelling first, and an empty value passed over (measured on
 * Node's own http client: `http_proxy=""` with `HTTP_PROXY` set proxies;
 * `no_proxy` wins over `NO_PROXY`). The door then routes by its OWN decision
 * (its own proxy agent or a direct one), so it cannot disagree with itself.
 */
const PLATFORM_NETWORK_VARIABLES = Object.freeze({
  nodeOptions: ["NODE_OPTIONS"],
  useEnvProxy: ["NODE_USE_ENV_PROXY"],
  noProxy: PROXY_VARIABLES.noProxy,
  httpsProxy: PROXY_VARIABLES.httpsProxy,
  httpProxy: PROXY_VARIABLES.httpProxy,
  tlsRejectUnauthorized: ["NODE_TLS_REJECT_UNAUTHORIZED"],
} as const);

function platformVariable(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Whether Node routes this process's `fetch` through the environment's proxy variables. */
function environmentProxyActive(): boolean {
  const options = `${process.execArgv.join(" ")} ${platformVariable(PLATFORM_NETWORK_VARIABLES.nodeOptions) ?? ""}`;
  return platformVariable(PLATFORM_NETWORK_VARIABLES.useEnvProxy) === "1" || /(?:^|\s)--use-env-proxy(?:\s|$)/u.test(options);
}

/** Whether `NO_PROXY` exempts `url` (exact host, a domain suffix, `*`, or host:port). */
function exemptFromProxy(url: URL): boolean {
  const raw = platformVariable(PLATFORM_NETWORK_VARIABLES.noProxy) ?? "";
  const host = bareHost(url.hostname);
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return raw.split(/[\s,]+/u).filter((entry) => entry.length > 0).some((entry) => {
    if (entry === "*") return true;
    const [name = "", entryPort] = entry.toLowerCase().replace(/^\*?\./u, ".").split(/:(?=\d+$)/u);
    if (entryPort !== undefined && entryPort !== port) return false;
    const domain = name.startsWith(".") ? name.slice(1) : name;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** The environment proxy this request would be routed through, or undefined when it goes direct. */
function environmentProxyFor(url: URL): string | undefined {
  if (!environmentProxyActive() || exemptFromProxy(url)) return undefined;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const proxy = platformVariable(secure ? PLATFORM_NETWORK_VARIABLES.httpsProxy : PLATFORM_NETWORK_VARIABLES.httpProxy);
  return proxy === undefined || proxy.length === 0 ? undefined : proxy;
}

/**
 * Decide whether `raw` may be contacted at all (scheme, embedded
 * credentials, cleartext and the proxy hop, TLS verification). Returns the
 * parsed URL. Used by every dispatch here and by the MCP WebSocket
 * transport, whose handshake is not a `fetch`.
 */
function assertOutboundUrl(raw: string, check: OutboundUrlCheck): URL {
  const log = check.logCategory;
  let url: URL;
  try { url = new URL(raw); } catch {
    return refuse(log, "The remote address is not a valid URL, so nothing was sent.", "outbound_url_invalid");
  }
  if (url.username !== "" || url.password !== "") {
    refuse(log, "The remote address carries a user name or password in the URL; credentials belong in the configured headers or auth, so nothing was sent.", "outbound_url_credentials_refused", { origin: url.origin });
  }
  const schemes = SCHEMES[check.schemes ?? "http"];
  const proxy = environmentProxyFor(url);
  if (url.protocol === schemes.secure) {
    if (platformVariable(PLATFORM_NETWORK_VARIABLES.tlsRejectUnauthorized) === "0") {
      refuse(log, "TLS certificate verification is switched off for this process (NODE_TLS_REJECT_UNAUTHORIZED=0), so no request is sent over an unverified connection.", "outbound_tls_verification_disabled", { origin: url.origin });
    }
    if (proxy !== undefined && firstSightOf("proxied", url.origin)) {
      debugLog(log, "info", "outbound_via_environment_proxy", () => ({ origin: url.origin, tunnelled: true }));
    }
    return url;
  }
  if (url.protocol !== schemes.cleartext) {
    refuse(log, `The remote address uses '${url.protocol}', which this caller does not speak (${schemes.secure.slice(0, -1)} or ${schemes.cleartext.slice(0, -1)}), so nothing was sent.`, "outbound_scheme_refused", { origin: url.origin });
  }
  // Loopback never leaves the machine — unless an environment proxy relays it.
  if (proxy === undefined && isLoopbackHostName(url.hostname)) return url;
  const where = proxy === undefined ? "" : " through the environment's proxy";
  if (outboundPolicy().cleartextRemote === "refuse") {
    refuse(log, `The remote address ${url.origin} is not encrypted (${url.protocol.slice(0, -1)}://)${where}, and credentials and content would cross the network in the clear, so nothing was sent. Use the server's secure address, or set network.cleartextRemote to "warn" to allow it.`, "outbound_cleartext_refused", { origin: url.origin, proxied: proxy !== undefined });
  }
  if (firstSightOf("cleartext", url.origin)) {
    debugLog(log, "warn", "outbound_cleartext_remote", () => ({ origin: url.origin, policy: "warn", proxied: proxy !== undefined }));
  }
  return url;
}

/**
 * The request's header set: the operator's headers (validated), then the
 * protocol's (which win on a case-insensitive name match).
 */
function outboundHeaders(
  operator: Readonly<Record<string, string>> | undefined,
  protocol: Readonly<Record<string, string>>,
  logCategory: string,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(operator ?? {})) {
    if (!HEADER_NAME.test(name)) {
      refuse(logCategory, `The configured header name '${name}' is not a valid HTTP header name, so nothing was sent.`, "outbound_header_invalid", { header: name });
    }
    if (CONNECTION_LEVEL_HEADERS.has(name.toLowerCase())) {
      refuse(logCategory, `The configured header '${name}' controls the HTTP connection itself and cannot be set by configuration, so nothing was sent.`, "outbound_header_refused", { header: name });
    }
    if (HEADER_VALUE_FORBIDDEN.test(value)) {
      refuse(logCategory, `The configured header '${name}' has a value with a line break or NUL, so nothing was sent.`, "outbound_header_invalid", { header: name });
    }
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(protocol)) {
    // A protocol value the platform refuses (a credential holding a line
    // break or a non-latin1 character) is the same typed refusal.
    try { headers.set(name, value); } catch {
      return refuse(logCategory, `The request's '${name}' header has a value HTTP cannot carry (a line break or a non-latin1 character), so nothing was sent.`, "outbound_header_invalid", { header: name });
    }
  }
  return headers;
}

export type OutboundHttpRequest = Readonly<{
  url: string;
  method: "GET" | "POST" | "DELETE";
  /** Headers the protocol owns (content negotiation, auth, sessions). */
  protocolHeaders: Readonly<Record<string, string>>;
  /** Headers the operator configured; validated, and never override protocol headers. */
  operatorHeaders?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
  /** The request's lifetime — see `deadline()`. */
  signal: AbortSignal;
  /** REQUIRED: may this request reach a loopback/private address? (the credential's rule, {@link privateAddressesAllowedFor}). */
  allowPrivateAddress: boolean;
}> & OutboundUrlCheck;

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function redirectTarget(response: Response, base: URL): string {
  const location = response.headers.get("location");
  if (location === null) return "(none)";
  try { return new URL(location, base).origin; } catch { return "(invalid)"; }
}

/** A request the policy has admitted: its URL and header set, decided before anything is dispatched. */
export type PreparedOutboundRequest = Readonly<{
  url: URL;
  headers: Headers;
  method: OutboundHttpRequest["method"];
  logCategory: string;
  allowPrivateAddress: boolean;
}>;

/**
 * Decide everything that can be decided without the network (URL, scheme,
 * TLS, cleartext and proxy, headers). A caller whose observers must not see a
 * request that can never be sent prepares first, then dispatches.
 */
export function prepareOutboundRequest(request: Omit<OutboundHttpRequest, "signal" | "body">): PreparedOutboundRequest {
  const url = assertOutboundUrl(request.url, request);
  return Object.freeze({
    url,
    headers: outboundHeaders(request.operatorHeaders, request.protocolHeaders, request.logCategory),
    method: request.method,
    logCategory: request.logCategory,
    allowPrivateAddress: request.allowPrivateAddress,
  });
}

/** Where a request goes: through the environment's proxy, or straight to the addresses the door checked. */
type Route = Readonly<{ proxied: true; proxy: string } | { proxied: false; addresses: readonly LookupAddress[] }>;

/**
 * RESOLVE ONCE, CHECK, PIN. The host is resolved here (an IP literal is its
 * own answer) and every address is held to the request's rule; the socket
 * then connects to exactly these addresses. A resolver failure is the
 * network's (the caller's retry decides), never a policy refusal. A request
 * the environment's proxy would carry cannot be pinned (the proxy resolves
 * the name again): allowed only when private addresses are.
 *
 * A PROCESS UNDER TEST DIALS NOTHING BUT THIS MACHINE (the checkout write
 * door's one "under test" answer: our runners arm their processes). A web test
 * booted the repository's real config and dialed `mcp.deepwiki.com`
 * (step6-readiness-2 F-14), which was invisible until the network was down.
 * Every other rule answers first; then a destination (or the proxy carrying
 * it) that is not a loopback address is refused, typed, before a socket
 * exists: `outbound_network_under_test`. A resolver answer patched by a test
 * to a loopback address is this machine, and passes.
 */
async function routeOf(prepared: Pick<PreparedOutboundRequest, "url" | "logCategory" | "allowPrivateAddress">): Promise<Route> {
  const { url, logCategory } = prepared;
  const proxy = environmentProxyFor(url);
  if (proxy !== undefined) {
    if (!prepared.allowPrivateAddress) {
      refuse(logCategory, `The remote address ${url.origin} would be reached through the environment's proxy, which resolves the name itself, so its address cannot be held to this request's rule (public addresses only). Nothing was sent. An administrator can exempt the host with NO_PROXY in the server's environment, or allow users' requests to private addresses (network.userPrivateAddresses).`, "outbound_destination_unpinnable", { origin: url.origin });
    }
    refuseRemoteUnderTest([bareHost(new URL(proxy).hostname)], url, logCategory);
    return { proxied: true, proxy };
  }
  const host = bareHost(url.hostname);
  const family = isIP(host);
  const addresses: readonly LookupAddress[] = family !== 0 ? [{ address: host, family }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || (!prepared.allowPrivateAddress && addresses.some((entry) => !isPublicAddress(entry.address)))) {
    refuse(logCategory, `The remote address ${url.origin} is on this machine or a private network, which this request may not reach, so nothing was sent.`, "outbound_private_destination_refused", { origin: url.origin });
  }
  refuseRemoteUnderTest(addresses.map((entry) => entry.address), url, logCategory);
  return { proxied: false, addresses };
}

/**
 * Whether this process may not dial `addresses` for `hostname`: it is under
 * test, one address is not this machine's, and the run did not consent to the
 * host as a declared live host (`src/process/live-network.ts`, the one opt-in).
 */
export function remoteRefusedUnderTest(addresses: readonly string[], hostname: string): boolean {
  return processUnderTest() && !addresses.every((address) => isLoopbackHostName(address)) && !liveHostConsented(bareHost(hostname));
}

/** Under test, every address a request would dial must be this machine's (see {@link routeOf}, {@link remoteRefusedUnderTest}). */
function refuseRemoteUnderTest(addresses: readonly string[], url: URL, logCategory: string): void {
  if (!remoteRefusedUnderTest(addresses, url.hostname)) return;
  refuse(logCategory, `This process is under test, and a test never reaches a host that is not this machine (${url.origin}), so nothing was sent. Serve the test from a local server (127.0.0.1) or answer the name with a loopback address.`, "outbound_network_under_test", { origin: url.origin });
}

/**
 * A socket lookup that answers only the addresses the door checked — ALWAYS
 * ASYNCHRONOUSLY, as the platform's resolver does. Answered synchronously, a
 * connect that fails at once (ENETUNREACH: no route, the network down) failed
 * INSIDE `tls.connect` before it had set up its socket: the request rejected
 * with "Cannot read properties of null (reading 'setServername')" and the
 * socket's own error was left with no listener — an uncaught exception that
 * ends a process (reproduced with undici 8.11.2 on Node 24: https, one or
 * many addresses; step6-readiness-2 F-14's `AggregateError`). A pure function
 * of its addresses, exported so a test pins the asynchrony itself.
 */
export function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = typeof options === "object" && options !== null && typeof options.family === "number" && options.family !== 0
      ? addresses.filter((entry) => entry.family === options.family) : addresses;
    const answer = wanted.length > 0 ? wanted : addresses;
    process.nextTick(guarded("outbound.pinned-lookup", () => {
      if (typeof options === "object" && options !== null && options.all === true) {
        (callback as (error: null, all: readonly LookupAddress[]) => void)(null, answer);
      } else {
        callback(null, answer[0]!.address, answer[0]!.family);
      }
    }));
  };
}

/**
 * THE DOOR'S DISPATCHERS — one per checked address set (and one per
 * environment proxy), so a pooled keep-alive connection is only ever reused
 * by a request pinned to the SAME addresses. A pooled connection is closed
 * after `network.idleConnectionMs` of idleness, BEFORE a server's own
 * keep-alive timeout closes it under a request: reusing a connection the
 * server just closed resets it with the request possibly sent, which a
 * non-idempotent call may not retry (measured: a POST lost to a server's 5 s
 * idle close). A WebSocket's dispatcher also bounds a message BEFORE it is
 * assembled (`maxPayloadSize`), where the platform's default was 128 MiB.
 *
 * FRESHNESS IS CHECKED WHEN A CONNECTION IS REUSED, NEVER LEFT TO A TIMER
 * (the coordinator's outbound decision). An idle bound kept by a timer runs only when the
 * event loop does: a process stalled past the server's keep-alive timeout
 * still holds the socket the server has closed, and the next request written
 * on it is reset (measured: a POST lost after a 6 s stall).
 * So every connection is its own client in the door's {@link freshPoolClass}
 * pool, which bounds how long the SERVER may have held each idle — its clock
 * starts at the dispatch of the connection's last request (a monotonic clock;
 * the server's starts when it ends its answer, never earlier), so a stall
 * between the server's answer and the client reading it cannot hide
 * — and, on every dispatch, CLOSES — never writes to — an idle connection
 * whose idle time has reached the server's advertised keep-alive (`Keep-Alive:
 * timeout=N`, capped by `network.idleConnectionMs`; else that setting) minus
 * `network.keepAliveThresholdMs`. The same judgement is made AGAIN right
 * before a reused connection's request is written (undici writes a turn after
 * dispatch, and a stall can fall in between): a connection stale by then is
 * retired and the request — not one byte of it sent — goes on a fresh one.
 * Every method then rides a pooled connection, which costs a handshake only
 * when one is due.
 *
 * HTTP/2 GOAWAY (RFC 9113 §6.8): a stream above the GOAWAY's last-stream-id
 * was never processed, the one case where re-sending a non-idempotent request
 * is safe; the client resends it once on a new connection, and the door logs
 * the GOAWAY. A stream at or below it that the server then cut is NEVER
 * resent: it surfaces as the client's own stream error
 * (`ERR_HTTP2_STREAM_ERROR`, unclassified by {@link transportFailure}, so a
 * caller reports it as an unexpected, non-retryable failure); anything else
 * the door classifies surfaces as the typed network failure. undici itself
 * also retries a stream the server refused (`REFUSED_STREAM`, RFC 9113 §8.7:
 * never processed) — a second resend path the door does not own; a server
 * that lies about it can only get its own origin's request more than once
 * (owned with HTTP2-RST-MIDBODY).
 */
const dispatchers = new Map<string, Dispatcher>();

let httpClientModule: Promise<typeof import("undici")> | undefined;

/**
 * The HTTP client, loaded when the first request or WebSocket is SENT, not
 * when the door is imported: modules every environment loads import the door
 * (the MCP factory, under the shared test setup — whose DOM environment has
 * none of the web-stream globals the client evaluates against at load).
 */
function httpClient(): Promise<typeof import("undici")> {
  return httpClientModule ??= import("undici");
}

/**
 * THE OPTIONS OF EVERY DISPATCHER THE DOOR BUILDS (a pinned `Agent`, a
 * `ProxyAgent`, the WebSocket handshake's): the keep-alive bound, the
 * WebSocket message bound, and NO transport lifetime of its own —
 * `headersTimeout` and `bodyTimeout` are 0, so the caller's `deadline()` is
 * the only one (a pure function: a unit test and the door guard pin it).
 */
export function dispatcherOptions(idle: number, threshold: number, maxMessageBytes?: number): Readonly<{
  pipelining: 1;
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
  keepAliveTimeoutThreshold: number;
  headersTimeout: 0;
  bodyTimeout: 0;
  webSocket?: Readonly<{ maxPayloadSize: number }>;
}> {
  return Object.freeze({
    pipelining: 1,
    keepAliveTimeout: idle,
    keepAliveMaxTimeout: idle,
    keepAliveTimeoutThreshold: threshold,
    headersTimeout: 0,
    bodyTimeout: 0,
    ...(maxMessageBytes === undefined ? {} : { webSocket: Object.freeze({ maxPayloadSize: maxMessageBytes }) }),
  });
}

/** The keep-alive a response advertises (`Keep-Alive: timeout=N`, seconds), in milliseconds; undefined when it names none. */
export function advertisedKeepAliveMs(headers: Readonly<Record<string, string | readonly string[] | undefined>>): number | undefined {
  const value = headers["keep-alive"];
  const match = /(?:^|[\s,;])timeout=(\d+)/iu.exec(Array.isArray(value) ? value.join(",") : String(value ?? ""));
  return match === null ? undefined : Number(match[1]) * 1000;
}

/**
 * The freshness rule (see the dispatchers' doc): an idle connection may be
 * reused while it has been idle LESS than this — the server's advertised
 * keep-alive CAPPED by the configured idle maximum (a server advertising a
 * long timeout never keeps a connection "fresh" past `network.idleConnectionMs`),
 * minus the threshold.
 */
export function connectionFreshForMs(advertisedMs: number | undefined, idle: number, threshold: number): number {
  return Math.min(advertisedMs ?? idle, idle) - threshold;
}

/** One connection of a {@link freshPoolClass} pool: its client, whether a request is on it, and since when it is idle. */
type FreshConnection = { readonly client: Dispatcher; busy: boolean; idleSince: number; advertisedMs: number | undefined };

/** Undici's dispatcher-state symbols, which an Agent reads off the per-origin dispatchers it holds. */
type DispatcherStateSymbols = Readonly<{ kConnected: symbol; kBusy: symbol; kPending: symbol; kRunning: symbol; kDispatch: symbol }>;

/**
 * Destroys a connection the pool no longer holds. Its failure changes nothing the pool does (the connection is
 * already out of it) but is never swallowed: it is said, at warn (logging is never disabled).
 */
export function closeConnection(client: Pick<Dispatcher, "destroy">, origin: string | URL, why: "stale" | "retired"): void {
  void client.destroy().catch((error: unknown) => debugLog("network", "warn", "outbound_connection_destroy_failed", () => ({ origin: String(origin), why, error: error instanceof Error ? error.message : String(error) })));
}

/**
 * A state an Agent reads off its per-origin dispatcher, summed over the pool's clients. Each client answers it as a
 * number (or, for `kConnected`, a boolean); anything else means the pinned client's internals changed — a loud typed
 * failure, never a silent 0.
 */
export function summedDispatcherState(clients: readonly object[], symbol: symbol): number {
  return clients.reduce<number>((total, client) => {
    const value = (client as Record<symbol, unknown>)[symbol];
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new HarnessError(`undici's client answers its ${String(symbol)} state as ${typeof value}, not a number: the pinned client's internals changed (engine/package.json pins it exactly)`, "outbound_pool_state_unreadable");
    }
    return total + Number(value);
  }, 0);
}

let freshPool: (new (origin: string | URL, options: object, idle: number, threshold: number, maxMessageBytes: number | undefined) => Dispatcher) | undefined;

/**
 * THE DOOR'S PER-ORIGIN POOL (see the dispatchers' doc): one client per
 * connection (pipelining 1, so a busy client carries exactly one request),
 * each with the monotonic instant it went idle and the keep-alive its server
 * advertised. Every dispatch first CLOSES each idle connection that is no
 * longer fresh ({@link connectionFreshForMs}) — nothing is written to it —
 * then rides an idle fresh one, or opens one. Built once, on the client
 * module the door loaded.
 */
function freshPoolClass(undici: typeof import("undici")): NonNullable<typeof freshPool> {
  if (freshPool !== undefined) return freshPool;
  // The Agent reads its per-origin dispatchers' state through the client's own symbols. These are the client's
  // INTERNALS, so engine/package.json pins undici EXACTLY (no range): an upgrade is a reviewed change this pool is
  // re-proven against (round 12 E24; the outbound-http tests hold the pin).
  const symbols = createRequire(import.meta.url)("undici/lib/core/symbols") as DispatcherStateSymbols;
  const now = (): number => performance.now();
  class FreshPool extends undici.Dispatcher {
    readonly #origin: string | URL;
    readonly #options: object;
    readonly #idle: number;
    readonly #threshold: number;
    readonly #maxMessageBytes: number | undefined;
    readonly #connections: FreshConnection[] = [];
    #closed = false;
    #destroyed = false;

    /** `options`: what the Agent (or the proxy wrapper) hands its per-origin dispatcher — the connector above all. */
    constructor(origin: string | URL, options: object, idle: number, threshold: number, maxMessageBytes: number | undefined) {
      super();
      this.#origin = origin;
      this.#options = options;
      this.#idle = idle;
      this.#threshold = threshold;
      this.#maxMessageBytes = maxMessageBytes;
    }

    get closed(): boolean { return this.#closed; }
    get destroyed(): boolean { return this.#destroyed; }
    get [symbols.kConnected](): number { return this.#sum(symbols.kConnected); }
    get [symbols.kPending](): number { return this.#sum(symbols.kPending); }
    get [symbols.kRunning](): number { return this.#sum(symbols.kRunning); }
    get [symbols.kBusy](): boolean { return false; }
    /** The proxy wrapper dispatches through the client's own symbol. */
    [symbols.kDispatch](options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean { return this.dispatch(options, handler); }

    #sum(symbol: symbol): number {
      return summedDispatcherState(this.#connections.map((entry) => entry.client), symbol);
    }

    #open(): FreshConnection {
      const client = new undici.Client(this.#origin, { ...this.#options, ...dispatcherOptions(this.#idle, this.#threshold, this.#maxMessageBytes) });
      const entry: FreshConnection = { client, busy: false, idleSince: now(), advertisedMs: undefined };
      // The client's events, re-emitted as this pool's (an Agent closes an unused pool on them).
      const events = client as unknown as { on: (event: string, listener: (origin: unknown, targets: readonly unknown[], error?: unknown) => void) => void };
      const emitter = this as unknown as { emit: (event: string, ...args: unknown[]) => boolean };
      for (const event of ["connect", "disconnect", "connectionError", "drain"] as const) {
        events.on(event, guarded("outbound.pool.client-event", (origin: unknown, targets: readonly unknown[], error?: unknown) => {
          if (event === "disconnect" && error instanceof Error && /GOAWAY/u.test(error.message)) {
            // Undici resends, once and on a new connection, only a stream above the last-stream-id whose response had not started and whose body is replayable — possibly none.
            debugLog("network", "warn", "outbound_http2_goaway", () => ({ origin: String(origin), reason: error.message, resend: "eligible streams only (above the last-stream-id, no response started, a replayable body), once; others fail" }));
          }
          emitter.emit(event, origin, [this, ...targets], error);
        }));
      }
      this.#connections.push(entry);
      return entry;
    }

    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      if (this.#closed || this.#destroyed) throw new undici.errors.ClientDestroyedError();
      return this.#send(options, handler);
    }

    /** One admitted request onto a fresh or freshly-judged connection (`dispatch`, and the resend of a request nothing of which was written). */
    #send(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      // FRESHNESS AT REUSE: an idle connection past its keep-alive is closed, never written to.
      const at = now();
      for (const entry of [...this.#connections]) {
        if (entry.busy || at - entry.idleSince < connectionFreshForMs(entry.advertisedMs, this.#idle, this.#threshold)) continue;
        this.#connections.splice(this.#connections.indexOf(entry), 1);
        debugLog("network", "debug", "outbound_connection_stale_closed", () => ({ origin: String(this.#origin), idleMs: Math.round(at - entry.idleSince) }));
        closeConnection(entry.client, this.#origin, "stale");
      }
      const idle = this.#connections.find((one) => !one.busy);
      const entry = idle ?? this.#open();
      // A REUSED connection is judged again when its request is WRITTEN (onRequestStart): see #tracked.
      const reusedIdleSince = idle === undefined ? undefined : idle.idleSince;
      entry.busy = true;
      return entry.client.dispatch(options, this.#tracked(entry, options, handler, at, reusedIdleSince));
    }

    /** A connection judged stale when its request was about to be written: out of the pool, destroyed, never written to. */
    #retire(entry: FreshConnection): void {
      const index = this.#connections.indexOf(entry);
      if (index >= 0) this.#connections.splice(index, 1);
      closeConnection(entry.client, this.#origin, "retired");
    }

    /**
     * `handler`, with the keep-alive its server advertises, and the
     * connection's idle clock started at `dispatchedAt` — the instant its
     * request was handed over, NOT when the client read the answer. The
     * server's own idle clock starts when it ENDS its answer, which is never
     * before the request was sent; a stall of this process between the
     * server's answer and the client reading it would otherwise start the
     * client's clock late by the whole stall, and the next request would ride
     * a connection the server already closed (the matrix-executor
     * "one reference run lost", reproduced by a deterministic stall shim).
     * So the client never believes a connection idle for less time than the
     * server does; a request that took longer than the freshness bound simply
     * gets the next request a new connection.
     */
    #tracked(entry: FreshConnection, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler, dispatchedAt: number, reusedIdleSince: number | undefined): Dispatcher.DispatchHandler {
      let settled = false;
      let staleBeforeWrite = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        entry.busy = false;
        entry.idleSince = dispatchedAt;
        debugLog("network", "debug", "outbound_connection_released", () => ({ origin: String(this.#origin) }));
        // A pool closed while this request was on it (a graceful close: its requests finish) keeps no connection after it.
        if (this.#closed) this.#retire(entry);
      };
      return {
        // FRESHNESS AGAIN AT THE WRITE: the client writes a request a turn after it is dispatched,
        // and a stall in between (the matrix-executor stall shim) would write it on a
        // connection the server has since closed. Judged right before the first byte is written
        // (undici calls this from writeH1, before the request line): a reused connection that is
        // no longer fresh is retired and the request — not one byte of it sent, so resending it is
        // safe whatever its method — is dispatched again on a fresh connection.
        onRequestStart: (controller, context) => {
          if (reusedIdleSince !== undefined && now() - reusedIdleSince >= connectionFreshForMs(entry.advertisedMs, this.#idle, this.#threshold)) {
            staleBeforeWrite = true;
            debugLog("network", "debug", "outbound_connection_stale_at_write", () => ({ origin: String(this.#origin), idleMs: Math.round(now() - reusedIdleSince) }));
            controller.abort(new undici.errors.InformationalError("the reused connection went stale before the request was written"));
            return;
          }
          return handler.onRequestStart?.(controller, context);
        },
        onRequestUpgrade: (controller, statusCode, headers, socket) => { settle(); return handler.onRequestUpgrade?.(controller, statusCode, headers, socket); },
        onResponseStart: (controller, statusCode, headers, statusMessage) => {
          entry.advertisedMs = advertisedKeepAliveMs(headers) ?? entry.advertisedMs;
          return handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
        },
        onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
        onResponseEnd: (controller, trailers) => { settle(); return handler.onResponseEnd?.(controller, trailers); },
        onResponseError: (controller, error) => {
          if (staleBeforeWrite) {
            // Nothing was written: the same request, on a fresh connection. It was ADMITTED before any close, and a
            // graceful close lets admitted requests finish. A DESTROYED pool never reaches here: destroying it errors
            // every request not yet written on its connections, and undici reports this write-time abort
            // synchronously, inside onRequestStart, so no destroy can come between (measured: the branch that once
            // guarded it was never reached, and is gone). `#send` refuses
            // nothing on its own (the refusals are dispatch's), so the resend cannot throw into the client.
            this.#retire(entry);
            this.#send(options, handler);
            return;
          }
          settle();
          return handler.onResponseError?.(controller, error);
        },
      };
    }

    close(): Promise<void>;
    close(callback: () => void): void;
    close(callback?: () => void): Promise<void> | void {
      this.#closed = true;
      const closing = Promise.all(this.#connections.map((entry) => entry.client.close())).then(() => undefined);
      if (callback === undefined) return closing;
      void closing.then(callback, callback);
    }

    destroy(): Promise<void>;
    destroy(error: Error | null): Promise<void>;
    destroy(callback: () => void): void;
    destroy(error: Error | null, callback: () => void): void;
    destroy(first?: Error | null | (() => void), second?: () => void): Promise<void> | void {
      this.#destroyed = true;
      const error = typeof first === "function" ? null : first ?? null;
      const callback = typeof first === "function" ? first : second;
      const destroying = Promise.all(this.#connections.map((entry) => entry.client.destroy(error))).then(() => undefined);
      if (callback === undefined) return destroying;
      void destroying.then(callback, callback);
    }
  }
  freshPool = FreshPool;
  return FreshPool;
}

async function dispatcherFor(route: Route, maxMessageBytes?: number): Promise<Dispatcher> {
  // Loaded first: everything below runs without a pause, so two concurrent
  // requests for one address set never create two pools.
  const undici = await httpClient();
  const { Agent, ProxyAgent } = undici;
  const FreshPool = freshPoolClass(undici);
  const { idleConnectionMs: idle, keepAliveThresholdMs: threshold } = outboundPolicy();
  const key = JSON.stringify(route.proxied
    ? ["proxy", route.proxy, idle, threshold, maxMessageBytes ?? null]
    : ["pinned", route.addresses.map((entry) => `${entry.family}/${entry.address}`).sort(), idle, threshold, maxMessageBytes ?? null]);
  const known = dispatchers.get(key);
  if (known !== undefined) {
    dispatchers.delete(key);
    dispatchers.set(key, known);
    return known;
  }
  // EVERY CONNECTION THROUGH THE FRESHNESS POOL — the pinned origins', the
  // tunnelled ones and a cleartext target's connection to its proxy alike
  // (the proxy wrapper builds its client with this factory and only `connect`).
  const factory = (origin: string | URL, options: object): Dispatcher => new FreshPool(origin, options, idle, threshold, maxMessageBytes);
  const dispatcher: Dispatcher = route.proxied
    ? new ProxyAgent({ uri: route.proxy, ...dispatcherOptions(idle, threshold, maxMessageBytes), factory })
    : new Agent({ ...dispatcherOptions(idle, threshold, maxMessageBytes), connect: { lookup: pinnedLookup(route.addresses) }, factory });
  dispatchers.set(key, dispatcher);
  while (dispatchers.size > ROOT_POLICY.runtime.limits.maximumPinnedDispatchers) {
    const [oldest, retired] = dispatchers.entries().next().value as [string, Dispatcher];
    dispatchers.delete(oldest);
    // Gracefully: requests already on it finish; it takes no new one.
    void retired.close().catch((error: unknown) => debugLog("network", "warn", "outbound_dispatcher_close_failed", () => ({ error: error instanceof Error ? error.message : String(error) })));
  }
  return dispatcher;
}

/**
 * CLOSE EVERY POOLED OUTBOUND CONNECTION (the door's dispatchers, destroyed:
 * a request still in flight fails as a network failure; the next request
 * opens new connections). The web server's shutdown calls it, so no pooled
 * keep-alive socket outlives the decision to exit. A test that drives the door
 * under a MOCKED clock calls it before the next test (the support helper
 * `mockDoorClock`): a pooled connection's keep-alive timer is armed on the
 * clock of the moment it went idle, and a connection closed later under
 * another test's mocked clock clears that timer there — removing whatever
 * that test's clock holds at its position (measured: another test's request
 * deadline, which then never fired). Resolves once every socket is closed.
 */
export async function closeOutboundConnections(): Promise<void> {
  const open = [...dispatchers.values()];
  dispatchers.clear();
  const outcomes = await Promise.allSettled(open.map((dispatcher) => dispatcher.destroy()));
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") debugLog("network", "warn", "outbound_dispatcher_close_failed", () => ({ error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }));
  }
}

/** Statuses whose response carries no body (RFC 9110), which a `Response` may not be given one for. */
const BODILESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * The platform's and the client's codes of a failure of the NETWORK (not of
 * the peer's protocol). The client's headers/body timeouts are not among
 * them: they are off ({@link dispatcherOptions}), and a cut request would be
 * the door's own bound, not the network's.
 */
const NETWORK_FAILURE_CODES = /^(?:E(?:CONN\w+|HOSTUNREACH|NETUNREACH|NETDOWN|AI_\w+|PIPE|TIMEDOUT|NOTFOUND)|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|CLOSED|DESTROYED))$/u;

/**
 * A failure of the network (a refused connection, a reset, a closed socket):
 * the caller's retry decides. It carries the platform's code and says
 * "network", so every caller's network classification recognises it; a peer
 * that does not speak HTTP (a parser failure) stays what it is, and an abort
 * stays the caller's own reason.
 */
function transportFailure(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !NETWORK_FAILURE_CODES.test(code)) return error;
  const failure = new Error(`network request failed (${code}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  return Object.assign(failure, { code });
}

/** Send one request on the door's own dispatcher and answer the platform `Response` shape. */
async function send(prepared: PreparedOutboundRequest, route: Route, body: string | undefined, signal: AbortSignal): Promise<Response> {
  const { url } = prepared;
  const headers: Record<string, string> = {};
  prepared.headers.forEach((value, name) => { headers[name] = value; });
  let answer: Dispatcher.ResponseData;
  try {
    answer = await (await dispatcherFor(route)).request({ origin: url.origin, path: `${url.pathname}${url.search}`, method: prepared.method, headers, ...(body === undefined ? {} : { body }), signal });
  } catch (error) {
    throw transportFailure(error, signal);
  }
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(answer.headers)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, one);
  }
  const bodiless = BODILESS_STATUSES.has(answer.statusCode);
  if (bodiless) void answer.body.dump().catch((error: unknown) => debugLog("network", "warn", "outbound_bodiless_dump_failed", () => ({ origin: url.origin, status: answer.statusCode, error: error instanceof Error ? error.message : String(error) })));
  // The body's own web stream (a cancel ends the connection's read cleanly).
  return new Response(bodiless ? null : (answer.body as unknown as { body: ReadableStream<Uint8Array> }).body, { status: answer.statusCode, headers: responseHeaders });
}

/** Dispatch a prepared request under the policy: pinned, and no redirect is followed (see the module doc). */
export async function dispatchOutboundRequest(prepared: PreparedOutboundRequest, body: string | undefined, signal: AbortSignal): Promise<Response> {
  const { url } = prepared;
  const response = await send(prepared, await routeOf(prepared), body, signal);
  if (isRedirect(response)) {
    const target = redirectTarget(response, url);
    // Never read: the refusal does not wait on the redirecting server.
    void discardBody(response, prepared.logCategory);
    refuse(prepared.logCategory, `${url.origin} answered with a redirect (${response.status}) to ${target}; redirects are never followed, because the request's credentials would be re-sent to the new location. Configure the final address instead.`, "outbound_redirect_refused", { status: response.status, origin: url.origin, target });
  }
  return response;
}

/** Prepare and dispatch one request under the policy. A refusal is thrown before or instead of any second request. */
export async function outboundFetch(request: OutboundHttpRequest): Promise<Response> {
  return dispatchOutboundRequest(prepareOutboundRequest(request), request.body, request.signal);
}

export type OutboundWebSocketRequest = Readonly<{
  url: string;
  /** Headers the operator configured (auth included): validated like a request's, sent on the handshake. */
  operatorHeaders?: Readonly<Record<string, string>> | undefined;
  /** Offered as `Sec-WebSocket-Protocol`. */
  subprotocol?: string | undefined;
  /** REQUIRED, as for every request: may this handshake reach a loopback/private address? */
  allowPrivateAddress: boolean;
  /** The largest message the caller accepts: bounded by the dispatcher BEFORE a message is assembled. */
  maxMessageBytes: number;
  logCategory: string;
}>;

/**
 * OPEN A WEBSOCKET THROUGH THE DOOR: the same URL checks (scheme `wss:`/`ws:`,
 * embedded credentials, TLS verification, cleartext and the proxy hop), the
 * same header allowlist, the same destination rule — resolved once and
 * PINNED (the handshake connects to exactly the checked addresses, on a
 * dispatcher keyed by them) — on the door's one client. A WebSocket handshake
 * never follows a redirect.
 */
export async function openOutboundWebSocket(request: OutboundWebSocketRequest): Promise<WebSocket> {
  const url = assertOutboundUrl(request.url, { logCategory: request.logCategory, schemes: "websocket" });
  const headers: Record<string, string> = {};
  outboundHeaders(request.operatorHeaders, {}, request.logCategory).forEach((value, name) => { headers[name] = value; });
  const route = await routeOf({ url, logCategory: request.logCategory, allowPrivateAddress: request.allowPrivateAddress });
  const { WebSocket: DoorWebSocket } = await httpClient();
  return new DoorWebSocket(url.href, {
    headers,
    // The handshake is a GET (idempotent); the upgraded connection is the socket's own.
    dispatcher: await dispatcherFor(route, request.maxMessageBytes),
    ...(request.subprotocol === undefined ? {} : { protocols: [request.subprotocol] }),
  }) as unknown as WebSocket;
}

/** A request lifetime: the caller's cancellation plus a REQUIRED timeout (the one owner, re-exported for the door's callers). */
export { deadline as outboundDeadline };

function tooLarge(): OutboundHttpError {
  countOutboundRefusal("outbound_body_too_large");
  return new OutboundHttpError("The response exceeds its byte bound", "outbound_body_too_large");
}

/** Decode a response body stream as UTF-8 text chunks, bounded by `maxBytes`. */
export async function* decodeReadableStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, maxBytes: number, cleanupTimeoutMs: number, logCategory: string): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let bytes = 0;
  const abort = guarded("outbound.body.abort", (): void => { void cancelBody(() => reader.cancel(signal.reason), cleanupTimeoutMs, logCategory); });
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) { const end = decoder.decode(); if (end) yield end; return; }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      const text = decoder.decode(value, { stream: true }); if (text) yield text;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await cancelBody(() => reader.cancel(), cleanupTimeoutMs, logCategory); reader.releaseLock();
  }
}

/** Read a whole response body as text, bounded by `maxBytes` (a leading BOM is dropped). */
export async function readBody(response: Response, signal: AbortSignal, maxBytes: number, cleanupTimeoutMs: number, logCategory: string): Promise<string> {
  if (response.body === null) {
    const text = await response.text(); signal.throwIfAborted();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge();
    return text;
  }
  let text = "";
  for await (const part of decodeReadableStream(response.body, signal, maxBytes, cleanupTimeoutMs, logCategory)) text += part;
  return text.replace(/^﻿/u, "");
}

/** Cancel a body within a bound; a cancel that fails or hangs is logged, never thrown. */
export async function cancelBody(cancel: () => Promise<unknown>, timeoutMs: number, logCategory: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(cancel).then(() => "closed", () => "rejected"),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("deadline"), timeoutMs); }),
    ]);
    if (result !== "closed") debugLog(logCategory, "warn", "outbound_body_cleanup_failed", () => ({ outcome: result }));
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * THE ONE WAY a response body that will not be read is let go: cancelled —
 * within `timeoutMs` when the caller waits for it — and a failure logged,
 * never thrown.
 */
export async function discardBody(response: Response, logCategory: string, timeoutMs?: number): Promise<void> {
  const body = response.body;
  if (body === null || body.locked) return;
  if (timeoutMs !== undefined) {
    await cancelBody(() => body.cancel(), timeoutMs, logCategory);
    return;
  }
  await body.cancel().catch((error: unknown) => {
    debugLog(logCategory, "warn", "outbound_body_cleanup_failed", () => ({ outcome: "rejected", error: error instanceof Error ? error.message : String(error) }));
  });
}
