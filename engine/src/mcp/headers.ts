/**
 * MCP header builder — merge custom headers, auth headers, and a default
 * Content-Type into one frozen record. Kept separate from `auth.ts` so the
 * caller can compose them: `mergeHeaders(config.headers, authHeaders(auth))`.
 *
 * Header names are canonicalized to `Content-Type` casing for deterministic
 * exposure (signals report headers by canonical name). Values are never
 * logged in full when they look like secrets — the exposure layer redacts
 * `Authorization` and `*-Key` / `*-Token` headers.
 */

export function mergeHeaders(
  ...sources: readonly (Readonly<Record<string, string>> | undefined)[]
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [name, value] of Object.entries(source)) {
      out[canonicalHeaderName(name)] = value;
    }
  }
  return Object.freeze(out);
}

export function canonicalHeaderName(name: string): string {
  return name.split("-").map((part) => {
    if (part.length === 0) return part;
    return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
  }).join("-");
}

/** Redact sensitive headers for signals/logs. Returns a copy with values masked. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === "Authorization" || /key/i.test(name) || /token/i.test(name)) {
      out[name] = `<redacted:${value.length}>`;
    } else {
      out[name] = value;
    }
  }
  return Object.freeze(out);
}
