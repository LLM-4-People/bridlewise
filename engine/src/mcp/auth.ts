/**
 * MCP authentication — translate an `auth` config block into transport-specific
 * material. Three supported types:
 * - `api-key`: a raw API key. For stdio it is injected as a named env var
 * (so `auth.envName` is required for stdio); for http/websocket it is
 * sent as a header (default `X-API-Key`, overridable via `auth.header`).
 * - `bearer`: a bearer token. For stdio it is injected as `auth.envName`
 * (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`); for http/websocket it is sent
 * as `Authorization: Bearer <token>`.
 * - `oauth`: an OAuth2 access token (treated as bearer for the transport
 * layer; the harness does not run the OAuth flow — the caller obtains the
 * token and refreshes it out of band). The `refresh` callback lets the
 * caller supply a refreshed token without reconfiguring the server.
 *
 * `auth` only ever sees concrete values. There is NO secret store yet (the
 * credential vault is CRED-1): a token reaches this layer from the config
 * document, literally or through a `${NAME}` placeholder that the host resolves
 * only for names on `tools.mcp.credentialEnv` (`config.ts`). Every value is
 * registered as the harness's own secret, so it is masked in logs and text.
 */

import type { McpTransportType } from "./transport/types.ts";

export type McpAuthConfig =
  | Readonly<{ type: "api-key"; token: string; header?: string; envName?: string }>
  | Readonly<{ type: "bearer"; token: string; envName?: string }>
  | Readonly<{ type: "oauth"; token: string; refreshToken?: () => Promise<string> }>;

/** Build the header bag contributed by auth for an http/websocket transport. */
export function authHeaders(auth: McpAuthConfig | undefined): Readonly<Record<string, string>> {
  if (auth === undefined) return {};
  if (auth.type === "api-key") {
    const header = auth.header ?? "X-API-Key";
    return { [header]: auth.token };
  }
  if (auth.type === "bearer" || auth.type === "oauth") {
    return { Authorization: `Bearer ${auth.token}` };
  }
  return {};
}

/** Build the env-var contribution for a stdio transport. */
export function authEnv(auth: McpAuthConfig | undefined): Readonly<Record<string, string>> {
  if (auth === undefined) return {};
  if (auth.type === "api-key" || auth.type === "bearer") {
    if (auth.envName === undefined) return {};
    return { [auth.envName]: auth.token };
  }
  return {};
}

/** Resolve the active token for a given transport type (used by exposure). */
export function resolveAuthToken(auth: McpAuthConfig | undefined, _transport: McpTransportType): string | undefined {
  if (auth === undefined) return undefined;
  if (auth.type === "api-key" || auth.type === "bearer" || auth.type === "oauth") return auth.token;
  return undefined;
}
