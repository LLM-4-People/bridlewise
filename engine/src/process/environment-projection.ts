/**
 * THE ONE WAY a child process's environment is built from this process's:
 * a PROJECTION through an allowlist — exact names, or a `PREFIX*` — and
 * nothing else. Deny by default: a variable no entry names is dropped, so a
 * provider key, a token or the database passphrase never reaches a child
 * because it happened to be in this process's environment.
 *
 * Every spawner asks here: the web server's model-run commands
 * (`HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST`, default {@link COMMAND_ENVIRONMENT})
 * and MCP stdio servers (`tools.mcp.stdioInheritedEnv`), the engine's command
 * tool ({@link COMMAND_ENVIRONMENT}) and its long task runner
 * ({@link SYSTEMD_RUN_ENVIRONMENT}). Every allowlist, whoever configures it,
 * is judged by ONE entry rule ({@link environmentAllowlistEntryRefusal}):
 *   - a bare `*` is refused (the empty prefix forwards everything);
 *   - the harness's own `HARNESS_*` namespace is refused, and so is a prefix
 *     that would match it (`H*`, `HARN*`): the harness's secrets (the web
 *     password seed, the database passphrase, the key home) never reach a
 *     child, and an operator cannot widen a list to them.
 * A proxy variable's value leaves WITHOUT its userinfo: a credentialed proxy
 * URL (`http://user:pass@proxy:8080`) is forwarded as `http://proxy:8080`, so
 * a model-run command can use the proxy but never read its password.
 */
import { z } from "zod";

import { InputError } from "../kernel/errors.ts";

/**
 * What a child needs to find programs and speak the user's locale — no
 * credential, no proxy. (The MCP SDK's own default inherited set.)
 */
export const MINIMAL_CHILD_ENVIRONMENT: readonly string[] = Object.freeze(["PATH", "LANG", "LC_ALL", "TZ", "TERM", "USER", "LOGNAME", "SHELL"]);

/**
 * The proxy variables, each pair in the order the platform reads them
 * (lowercase first; an empty value is passed over). THE owner of these
 * names: the outbound door reads them in this order, and a projection
 * forwards them credential-free.
 */
export const PROXY_VARIABLES = Object.freeze({
  noProxy: Object.freeze(["no_proxy", "NO_PROXY"] as const),
  httpsProxy: Object.freeze(["https_proxy", "HTTPS_PROXY"] as const),
  httpProxy: Object.freeze(["http_proxy", "HTTP_PROXY"] as const),
  allProxy: Object.freeze(["all_proxy", "ALL_PROXY"] as const),
});

const PROXY_NAMES: ReadonlySet<string> = new Set(Object.values(PROXY_VARIABLES).flat());

/** A model-run command's inherited set: the minimal set, its home, and the proxy (credential-free). */
export const COMMAND_ENVIRONMENT: readonly string[] = Object.freeze([...MINIMAL_CHILD_ENVIRONMENT, "HOME", ...PROXY_NAMES]);

/**
 * What git needs to reach a remote for the harness (a promotion's fetch and
 * push, `src/git/worktree-port.ts`): the command set, the user's config home
 * (git's own global file under `XDG_CONFIG_HOME`), and the transport's
 * credential channels — the SSH agent and the program git asks for a
 * password. The values themselves are never read or logged: a remote's
 * credentials stay with the user's own git configuration and agent.
 */
export const GIT_NETWORK_ENVIRONMENT: readonly string[] = Object.freeze([
  ...COMMAND_ENVIRONMENT, "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS",
]);

/** What `systemd-run --user` needs to reach the user's manager (the long task runner). */
export const SYSTEMD_RUN_ENVIRONMENT: readonly string[] = Object.freeze([...MINIMAL_CHILD_ENVIRONMENT, "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);

/** The harness's own environment namespace: never forwarded, never allowlisted. */
const HARNESS_NAMESPACE = "HARNESS_";

/** Whether `name` is in the harness's own environment namespace (case-insensitive: errs toward the namespace). */
/**
 * THE TEMP-FOLDER VARIABLES a child reads (POSIX `TMPDIR`; `TMP`/`TEMP`,
 * which Python's `tempfile` and others also consult). A confined child gets
 * ALL of them pointed at its private temp folder (`withPrivateTemporary`):
 * the system temp folder is never granted, so a child left with `/tmp`
 * would fail every temp file it tries to make.
 */
const TEMPORARY_DIRECTORY_VARIABLES: readonly string[] = Object.freeze(["TMPDIR", "TMP", "TEMP"]);

/** `environment` with every temp-folder variable pointed at `temporaryDirectory`. */
export function withPrivateTemporary(environment: Readonly<Record<string, string | undefined>> | undefined, temporaryDirectory: string): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) if (value !== undefined) projected[name] = value;
  for (const name of TEMPORARY_DIRECTORY_VARIABLES) projected[name] = temporaryDirectory;
  return projected;
}

export function isHarnessEnvironmentName(name: string): boolean {
  return name.toUpperCase().startsWith(HARNESS_NAMESPACE);
}

/**
 * Why `entry` may not be in an environment allowlist, or undefined when it
 * may. THE entry rule for every allowlist (the config schemas and the
 * projection both ask here). Case-insensitive against the harness namespace:
 * the refusal errs toward refusing.
 */
function environmentAllowlistEntryRefusal(entry: string): string | undefined {
  const name = entry.trim();
  const star = name.endsWith("*");
  const stem = (star ? name.slice(0, -1) : name).toUpperCase();
  if (star && stem.length === 0) {
    return "`*` on its own is not accepted: an empty prefix matches every variable name, which would forward the whole process environment (including credentials). List the names or name prefixes you actually want, e.g. `PATH,HOME,GIT_*`.";
  }
  if (stem.startsWith(HARNESS_NAMESPACE) || (star && HARNESS_NAMESPACE.startsWith(stem))) {
    return `\`${name}\` names the harness's own ${HARNESS_NAMESPACE}* variables (its password seed, database passphrase and key home), which never reach a subprocess.`;
  }
  return undefined;
}

/** One allowlist entry as every config schema accepts it (a name or `PREFIX*`, judged by {@link environmentAllowlistEntryRefusal}). */
export const ENVIRONMENT_ALLOWLIST_ENTRY = z.string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/u, "an environment variable name, or a name prefix ending in *")
  .superRefine((entry, context) => {
    const refusal = environmentAllowlistEntryRefusal(entry);
    if (refusal !== undefined) context.addIssue({ code: "custom", message: refusal });
  });

/** `env` projected through `allowlist` (an entry the rule refuses throws `environment_allowlist_refused`). */
export function projectEnvironment(env: NodeJS.ProcessEnv, allowlist: readonly string[]): Readonly<Record<string, string>> {
  const allowed = environmentMatcher(allowlist);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !allowed(name)) continue;
    if (!isProxyVariable(name)) { out[name] = value; continue; }
    const stripped = withoutUserinfo(value);
    // A proxy value no URL parser can read is not forwarded (its credentials could not be told apart).
    if (stripped !== undefined) out[name] = stripped;
  }
  return Object.freeze(out);
}

/** Whether `allowlist` admits the variable `name` (the same matching as {@link projectEnvironment}). */
export function environmentNameAllowed(name: string, allowlist: readonly string[]): boolean {
  return environmentMatcher(allowlist)(name);
}

/**
 * A variable a program reads as a PROXY URL (`HTTP_PROXY`, `all_proxy`,
 * `FTP_PROXY`, `npm_config_https_proxy`, `SOCKS_PROXY`… — any name ending in
 * `proxy`, whatever its case), never `NO_PROXY` (a host list).
 */
function isProxyVariable(name: string): boolean {
  return PROXY_NAMES.has(name) || (/proxy$/iu.test(name) && !/^no_proxy$/iu.test(name));
}

/**
 * A proxy value without its `user:password@` — PARSED the way every consumer
 * parses it (the WHATWG URL parser, a bare `host:port` read as `http://`),
 * so no spelling a parser accepts keeps its credentials: leading whitespace or
 * a newline, `http:/u:p@h`, `http:///u:p@h` (secd-security SECD-V-B2, where a
 * regex forwarded each intact). Undefined when no parser reads it.
 */
function withoutUserinfo(value: string): string | undefined {
  const trimmed = value.trim();
  // A scheme is `name:/…` (`user:pass@host` is a bare authority, not a scheme).
  const schemeless = !/^[A-Za-z][A-Za-z0-9+.-]*:\//u.test(trimmed);
  const url = URL.parse(schemeless ? `http://${trimmed}` : trimmed);
  if (url === null) return undefined;
  if (url.username === "" && url.password === "" && !trimmed.includes("@")) return value;
  url.username = "";
  url.password = "";
  // The parser's form, without a root path the value never wrote.
  const text = url.pathname === "/" && url.search === "" && url.hash === "" && !trimmed.endsWith("/") ? url.href.slice(0, -1) : url.href;
  return schemeless ? text.replace(/^http:\/\//u, "") : text;
}

function environmentMatcher(allowlist: readonly string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of allowlist) {
    const name = entry.trim();
    if (name.length === 0) continue;
    const refusal = environmentAllowlistEntryRefusal(name);
    if (refusal !== undefined) throw new InputError(`Environment allowlist: ${refusal}`, "environment_allowlist_refused");
    if (name.endsWith("*")) prefixes.push(name.slice(0, -1));
    else exact.add(name);
  }
  return (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}
