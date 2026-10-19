/**
 * HTML-in-iframe preview security — the SINGLE owner of the
 * Content-Security-Policy meta + srcdoc composition used to render
 * untrusted HTML inside a sandboxed iframe.
 *
 * Every untrusted-HTML iframe composes its srcdoc through
 * `sandboxedSrcdoc` so the CSP cannot drift between consumers — a new
 * untrusted-HTML surface (a markdown-HTML render, an SVG preview) calls
 * this and never re-implements the CSP meta or composes the srcdoc by
 * hand, so the security policy cannot be forgotten or duplicated.
 *
 * Security model:
 * The CSP meta is prepended to the srcdoc so the FIRST CSP policy
 * wins (per spec), overriding any CSP the untrusted HTML itself
 * declares. `default-src 'unsafe-inline' 'unsafe-eval' data: blob:`
 * lets the rendered HTML/CSS/JS run inline + show data/blob images,
 * while `connect-src 'none'` blocks ALL network calls (fetch/XHR/
 * WebSocket) so the untrusted HTML cannot exfiltrate data, and
 * `frame-ancestors 'none'` blocks the document from being framed.
 * The sandbox TOKEN (which capabilities the iframe gets) is the
 * CONSUMER's choice; a config-supplied token is hardened by
 * `rejectSameOrigin` (shared/html-preview.ts — the config reader's
 * half of this split, reachable from both sides of the wire).
 */

/**
 * The CSP meta tag prepended to every untrusted-HTML iframe srcdoc.
 * Exported so a prevention test can pin its exact content (the
 * `connect-src 'none'` data-exfiltration block is the critical part).
 */
export const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'unsafe-inline\' \'unsafe-eval\' data: blob:; connect-src \'none\'; frame-ancestors \'none\'">';

/**
 * Compose the srcdoc for an untrusted-HTML iframe: the CSP meta first
 * (so it wins as the first CSP policy), then a newline, then the
 * untrusted content. Every untrusted-HTML iframe in the harness must
 * compose its srcdoc through this so the CSP cannot be forgotten.
 */
export function sandboxedSrcdoc(content: string): string {
  return CSP_META + "\n" + content;
}
