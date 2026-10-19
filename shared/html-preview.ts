/**
 * Sandbox-token hardening for untrusted-HTML iframes — the config reader's
 * half of the html-preview split. The CSP composer (`sandboxedSrcdoc`)
 * lives with its rendering consumers in `src/cockpit/render/html-preview.ts`;
 * this half is what the CONFIG path takes (`src/state/web-ui-config.ts`
 * hardens the served sandbox token before any renderer sees it), and
 * `shared/*` is the seam a config reader may depend on without pulling
 * a rendering module into its graph.
 */

/**
 * Harden a config-supplied sandbox token by rejecting `allow-same-origin`
 * (defense-in-depth). `allow-same-origin` lets the iframe read the
 * parent's DOM/cookies/localStorage — never safe for untrusted HTML.
 * If the token contains it, fall back to `allow-scripts` (the artifact
 * default — runs the artifact without same-origin access). Callers that
 * hardcode a known-safe token (e.g. an empty one) do not need to call
 * this.
 */
export function rejectSameOrigin(token: string): string {
  return token.includes("allow-same-origin") ? "allow-scripts" : token;
}
