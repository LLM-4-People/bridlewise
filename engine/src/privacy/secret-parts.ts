/**
 * THE ONE WRITE-ONLY SECRET PRIMITIVE — how a surface serves a value that
 * carries a credential, and how a write that sends the served form back keeps
 * what it stands for. Reused by every settings surface that holds secrets:
 * the MCP server list and the config document today (a server's URL, its
 * command arguments, its env/header values and auth token), the generated
 * settings UI's `secret: true` fields (CFG) and the credential vault's
 * `SecretField` (CRED) tomorrow.
 *
 * Two shapes, one rule:
 *
 *   - A SCALAR secret (an env value, a header value, a token) is never served;
 *     a write that leaves it EMPTY keeps the saved one ({@link keepScalar}).
 *   - A COMPOSITE value (a URL, an argument list) is served with each secret
 *     PART replaced by a keep mark naming its place — `‹keep:url.query.key.0›`,
 *     `‹keep:after:--token#0›` ({@link concealUrl}, {@link concealArguments}). A write
 *     that sends a mark back keeps the saved part AT THAT PLACE, and only
 *     there: the value is restored, its parts are measured again, and every
 *     mark used must name the same part in the same place — a mark moved to
 *     another flag, another query name or another argument is refused, never
 *     re-matched by text (the previous `*concealed*` sentinel was matched after
 *     display redaction, so identical marks could swap and a vault mask would
 *     have broken it silently; secd-design M8).
 *
 * THE CONTEXT RULE (secd-security SECD-C4; sec-e-correctness H-2): a kept
 * secret is honoured only while what receives it is unchanged — the restored
 * composite value EQUALS the saved one (a mark keeps its part; anything typed
 * is a change) and so does whatever the caller adds (the command, the
 * transport, the read paths). For a URL that is the origin AND the path and
 * the query (a gateway serving many tenants on one origin is many contexts);
 * for an argument list, EVERY argument (a launcher's program is an argument:
 * `npx -y <package>`, `sh -c <script>`, `docker run <image>` — and a changed
 * script may itself be a concealed part, so the served form cannot tell).
 * A write that changes any of it must type every credential again; otherwise
 * an admin (or anyone with the settings door) sends saved credentials to
 * other code or another tenant by changing one field.
 *
 * WHAT IS A SECRET PART — deny by default. A part is SHOWN only when its
 * shape is plainly not a credential ({@link isPlainValue}: a number, a
 * boolean, a path, a short word or version) and no name around it says it
 * is one ({@link isSecretPartName}: every sensitive key name plus the short
 * spellings a name list missed — `pass`, `pwd`, `pat`, `sig`, `code`, `-p`,
 * `-k`); everything else is concealed: a URL's userinfo and fragment, query
 * values (`?key=AIza…`, `?sig=…`, `?code=…`), secret-shaped path segments
 * (webhook tokens), flag values (`--passwd x`, `--pat x`, `-p x`), secret-
 * shaped positional arguments.
 */
import { sameOrderedValues } from "../kernel/ordered.ts";
import { safePercentDecode } from "./data-policy.ts";
import { hasSecretTextSignal, isSensitiveKeyName, normalizeSecretKey } from "./secret-signals.ts";

const KEEP_OPEN = "‹keep:";
const KEEP_CLOSE = "›";
const KEEP_MARK = /‹keep:([^›\s]{1,200})›/gu;

/** The mark a composite value is served with in place of the part at `place`. */
export function keepMark(place: string): string {
  return `${KEEP_OPEN}${place}${KEEP_CLOSE}`;
}

/** Whether a sent value still carries a keep mark. */
export function carriesKeepMark(value: string): boolean {
  return value.includes(KEEP_OPEN);
}

/** Short names that mark a credential in a flag or a query even where a key-name list does not know them. */
const SECRET_PART_NAMES: ReadonlySet<string> = new Set([
  "p", "k", "pass", "passwd", "pwd", "pw", "pat", "sig", "signature", "code", "key", "keys", "psk", "otp", "hmac", "salt", "nonce",
  "sas", "jwt", "session", "sessionid", "sid", "cookie", "access", "refresh",
]);

/** Whether a name (a flag, a query name, an `X=` assignment's name) says its value is a credential. */
function isSecretPartName(name: string): boolean {
  const bare = name.replace(/^-+/u, "");
  if (bare.length === 0) return false;
  if (isSensitiveKeyName(bare)) return true;
  const normalized = normalizeSecretKey(bare);
  return SECRET_PART_NAMES.has(normalized) || [...SECRET_PART_NAMES].some((part) => part.length >= 3 && normalized.endsWith(part));
}

/** A value whose shape is plainly not a credential: a number, a boolean, a path, a short word, a version. */
function isPlainValue(value: string): boolean {
  if (value.length === 0) return true;
  if (hasSecretTextSignal(value, "classification")) return false;
  if (/^(?:true|false|yes|no|on|off|null|none)$/iu.test(value)) return true;
  if (/^[+-]?\d{1,12}(?:\.\d{1,12})?$/u.test(value)) return true;
  if (/^v?\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][\w.]{1,32})?$/u.test(value)) return true;
  if (/^(?:\.{0,2}\/|~\/)[\w./@+-]{0,4096}$/u.test(value) && !highEntropy(value.split("/").at(-1) ?? "")) return true;
  if (/^@?[a-z][a-z0-9]*(?:[._/@-][a-z0-9]+){0,6}$/u.test(value) && value.length <= 64 && !highEntropy(value)) return true;
  return false;
}

/** A token-like run: long, and mixing letter case or letters and digits (a webhook secret, an API key). */
function highEntropy(value: string): boolean {
  if (value.length < 16) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u].filter((pattern) => pattern.test(value)).length;
  return classes >= 2 && !/^[a-z]+(?:-[a-z]+)+$/u.test(value);
}

/** A value shaped like a credential itself (not merely not plain): a token-like run, or a provider's key format. */
function secretShaped(value: string): boolean {
  return !isPlainValue(value) && (highEntropy(value) || hasSecretTextSignal(value, "classification"));
}

/** Form decoding (`application/x-www-form-urlencoded`): `+` is a space, then percent-decoding. */
function formDecoded(text: string): string {
  return safePercentDecode(text.replaceAll("+", " "));
}

// ── The scalar shape ───────────────────────────────────────────────────────

export type KeptValue = Readonly<{ ok: true; value: string; kept: boolean } | { ok: false; reason: "nothing-saved" | "context-changed" }>;

/**
 * A scalar secret sent back by a writer: a non-empty value replaces the
 * saved one; an EMPTY value keeps it — when there is one, and only while the
 * context it is sent to is unchanged.
 */
export function keepScalar(sent: string, saved: string | undefined, contextUnchanged: boolean): KeptValue {
  if (sent.length > 0) return { ok: true, value: sent, kept: false };
  if (saved === undefined) return { ok: false, reason: "nothing-saved" };
  if (!contextUnchanged) return { ok: false, reason: "context-changed" };
  return { ok: true, value: saved, kept: true };
}

// ── The composite shapes ───────────────────────────────────────────────────

/**
 * One secret part of a composite value: where it is, its raw text as written,
 * and whether it is a CREDENTIAL (held for a request's text: a named secret
 * or a secret-shaped value) or only concealed (not plainly safe to show, like
 * prose in a query — deny by default for a surface, never held: it would
 * shred the words it echoes into).
 */
type SecretPart = Readonly<{ place: string; start: number; end: number; credential: boolean }>;

/** A URL's `scheme://` prefix. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

type Span = Readonly<{ start: number; end: number }>;

/** A URL's components as offsets into the text that spells it. */
type UrlSplit = Readonly<{ userinfo?: Span; path: Span; query?: Span; fragment?: Span }>;

/**
 * THE ONE RAW URL SPLITTER: the components of a URL as `text` SPELLS them —
 * offsets into `text`, never a parser's normalised form (the WHATWG parser
 * percent-encodes `@`, `{`, spaces and non-ASCII in a password, strips tabs,
 * and refuses a URL with a space in its host or an IPv6 zone, so a secret
 * read through it was held in a spelling the text does not carry, or not at
 * all — a2-correctness §2). The authority ends at the first `/` or `?`; the
 * userinfo ends at the authority's LAST `@` (a raw `@` in a password is the
 * parser's reading too); the fragment starts at the first `#`. Undefined
 * when `text` does not start with `scheme://`.
 */
function splitUrl(text: string): UrlSplit | undefined {
  const scheme = URL_SCHEME.exec(text);
  if (scheme === null) return undefined;
  const hash = text.indexOf("#");
  const end = hash < 0 ? text.length : hash;
  const authorityStart = scheme[0].length;
  const authorityEnd = [text.indexOf("/", authorityStart), text.indexOf("?", authorityStart)]
    .filter((at) => at >= 0 && at < end).reduce((first, at) => Math.min(first, at), end);
  const at = text.lastIndexOf("@", authorityEnd - 1);
  const query = text.indexOf("?", authorityEnd);
  const pathEnd = query >= 0 && query < end ? query : end;
  return {
    ...(at >= authorityStart ? { userinfo: { start: authorityStart, end: at } } : {}),
    path: { start: authorityEnd, end: pathEnd },
    ...(pathEnd < end ? { query: { start: pathEnd + 1, end } } : {}),
    ...(hash >= 0 ? { fragment: { start: hash + 1, end: text.length } } : {}),
  };
}

/** The `name=value` pairs of a query or fragment, each with its value's offsets into `text`. */
function pairsOf(text: string, span: Span): readonly Readonly<{ name: string; value: Span }>[] {
  const pairs: { name: string; value: Span }[] = [];
  let at = span.start;
  for (const pair of text.slice(span.start, span.end).split("&")) {
    const equals = pair.indexOf("=");
    if (equals >= 0) pairs.push({ name: pair.slice(0, equals), value: { start: at + equals + 1, end: at + pair.length } });
    at += pair.length + 1;
  }
  return pairs;
}

/** The secret parts of a URL written as `text` (raw offsets), each with its place (prefixed by `prefix`). */
function urlParts(text: string, prefix: string): readonly SecretPart[] | undefined {
  const split = splitUrl(text);
  if (split === undefined) return undefined;
  const parts: SecretPart[] = [];
  if (split.userinfo !== undefined) parts.push({ place: `${prefix}url.userinfo`, ...split.userinfo, credential: true });
  let segmentStart = split.path.start;
  text.slice(split.path.start, split.path.end).split("/").forEach((segment, index) => {
    if (segment.length > 0 && secretShaped(safePercentDecode(segment))) {
      parts.push({ place: `${prefix}url.path.${index}`, start: segmentStart, end: segmentStart + segment.length, credential: true });
    }
    segmentStart += segment.length + 1;
  });
  if (split.query !== undefined) {
    const seen = new Map<string, number>();
    for (const { name, value } of pairsOf(text, split.query)) {
      const occurrence = seen.get(name) ?? 0;
      seen.set(name, occurrence + 1);
      const raw = text.slice(value.start, value.end);
      const credential = raw.length > 0 && (isSecretPartName(formDecoded(name)) || secretShaped(formDecoded(raw)));
      if (credential || (raw.length > 0 && !isPlainValue(formDecoded(raw)))) {
        parts.push({ place: `${prefix}url.query.${name}.${occurrence}`, ...value, credential });
      }
    }
  }
  if (split.fragment !== undefined && split.fragment.end > split.fragment.start) parts.push({ place: `${prefix}url.fragment`, ...split.fragment, credential: false });
  return parts;
}

/**
 * THE CREDENTIALS A URL CARRIES, in every spelling a text can carry them —
 * the one answer the held set takes for a URL a request sends (an image or
 * file reference). The parts are the concealment's own selection
 * ({@link urlParts}), its CREDENTIAL ones: a userinfo with no `:` whole
 * (`https://<token>@h`); else the password — and the username when it is
 * secret-shaped itself (GitHub's `https://<token>:x-oauth-basic@github.com`)
 * or stands beside an empty password without being plainly safe
 * (`https://<token>:@h`; a plain `user` or `git` there is never held: it
 * would mask the word and refuse the protocol role it spells) — a
 * secret-shaped path segment (a
 * webhook token), a query value whose name or shape says it is a credential,
 * the same pairs of the fragment and a bare secret-shaped fragment
 * (a2b-correctness M-2, a2b-design M5).
 *
 * Two readings of the text: as WRITTEN (the raw splitter's offsets) and as a
 * URL PARSER reads it (WHATWG — what the provider fetches and the
 * observation shows: a leading space, a tab inside the scheme, `https:\\`
 * and missing slashes are still a URL there, a2b-correctness M-1).
 *
 * The spellings of each part: as written, with the tab/newline a URL parser
 * strips removed, form-decoded for query and fragment values (`+` is a
 * space), and percent-decoded at most `decodeLevels` times (`%2540` is `@`
 * two decodes later). The bound keeps the held set linear in the URL:
 * decoding to a fixed point held EVERY level of a nested `%25…` run, and a
 * few-KB image link stalled the request mint for seconds (a2b-correctness
 * H-1). Empty for a text no reading takes for a URL.
 */
export function urlCredentialSpellings(text: string, decodeLevels: number): readonly string[] {
  const spellings = new Set<string>();
  const hold = (raw: string, form: boolean): void => {
    for (const written of new Set([raw, raw.replace(/[\t\n\r]/gu, "")])) {
      for (const start of form ? new Set([written, written.replaceAll("+", " ")]) : [written]) {
        let current = start;
        for (let level = 0; level <= decodeLevels && current.length > 0; level += 1) {
          spellings.add(current);
          const next = safePercentDecode(current);
          if (next === current) break;
          current = next;
        }
      }
    }
  };
  const read = (spelled: string, userinfo: boolean): void => {
    const split = splitUrl(spelled);
    if (split === undefined) return;
    for (const part of urlParts(spelled, "") ?? []) {
      if (!part.credential) continue;
      const raw = spelled.slice(part.start, part.end);
      if (part.place !== "url.userinfo") { hold(raw, part.place.startsWith("url.query.")); continue; }
      if (!userinfo) continue;
      const colon = raw.indexOf(":");
      if (colon < 0) { hold(raw, false); continue; }
      const username = raw.slice(0, colon), password = raw.slice(colon + 1), name = safePercentDecode(username);
      if (password.length > 0) hold(password, false);
      if (secretShaped(name) || (password.length === 0 && !isPlainValue(name))) hold(username, false);
    }
    if (split.fragment !== undefined) {
      const fragment = spelled.slice(split.fragment.start, split.fragment.end);
      if (!fragment.includes("=") && secretShaped(formDecoded(fragment))) hold(fragment, true);
      for (const { name, value } of pairsOf(spelled, split.fragment)) {
        const raw = spelled.slice(value.start, value.end);
        if (raw.length > 0 && (isSecretPartName(formDecoded(name)) || secretShaped(formDecoded(raw)))) hold(raw, true);
      }
    }
  };
  read(text, true);
  const parsed = URL.parse(text);
  if (parsed !== null && parsed.href !== text) {
    // The parser's own fields for the userinfo: its serialization drops an
    // empty password, so `https://user:@h` would read as a username-only
    // credential there (a plain `user`, which the raw reading never holds).
    if (parsed.password.length > 0) hold(parsed.password, false);
    if (secretShaped(safePercentDecode(parsed.username))) hold(parsed.username, false);
    read(parsed.href, false);
  }
  return Object.freeze([...spellings]);
}

/** `text` with every part replaced by its keep mark. */
function withMarks(text: string, parts: readonly SecretPart[]): string {
  let out = "", at = 0;
  for (const part of [...parts].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, part.start) + keepMark(part.place);
    at = part.end;
  }
  return out + text.slice(at);
}

function partValues(text: string, parts: readonly SecretPart[]): ReadonlyMap<string, string> {
  return new Map(parts.map((part) => [part.place, text.slice(part.start, part.end)]));
}

/** A URL as it is served: its secret parts replaced by keep marks (unchanged when it is not a URL or has none). */
export function concealUrl(text: string): string {
  const parts = urlParts(text, "");
  return parts === undefined ? text : withMarks(text, parts);
}

/**
 * A restored composite value and whether its context is unchanged (the
 * caller's own part of the context — the command, the transport — AND the
 * restored value equal to the saved one); a mark is honoured only in an
 * unchanged context.
 */
export type Restored<T> = Readonly<{ ok: true; value: T; contextUnchanged: boolean } | { ok: false; reason: "unknown-mark" | "moved-mark" | "context-changed" }>;

/** Substitute every mark in `sent` from `saved`'s parts; undefined when a mark names no saved part. */
function substitute(sent: string, saved: ReadonlyMap<string, string>, used: Set<string>): string | undefined {
  let unknown = false;
  const value = sent.replace(KEEP_MARK, (_whole, place: string) => {
    const part = saved.get(place);
    if (part === undefined) { unknown = true; return ""; }
    used.add(place);
    return part;
  });
  return unknown ? undefined : value;
}

/**
 * A URL sent back by a writer: its keep marks replaced by the saved URL's
 * parts — each only at its own place, and only while the context is
 * unchanged: `callerUnchanged` (the transport) and the restored URL equal to
 * the saved one (origin, path, query).
 */
export function restoreUrl(sent: string, saved: string | undefined, callerUnchanged: boolean): Restored<string> {
  let value = sent;
  if (carriesKeepMark(sent)) {
    if (saved === undefined) return { ok: false, reason: "unknown-mark" };
    const savedParts = partValues(saved, urlParts(saved, "") ?? []);
    const used = new Set<string>();
    const restored = substitute(sent, savedParts, used);
    if (restored === undefined) return { ok: false, reason: "unknown-mark" };
    const measured = partValues(restored, urlParts(restored, "") ?? []);
    if (![...used].every((place) => measured.get(place) === savedParts.get(place))) return { ok: false, reason: "moved-mark" };
    value = restored;
  }
  const contextUnchanged = callerUnchanged && value === saved;
  if (carriesKeepMark(sent) && !contextUnchanged) return { ok: false, reason: "context-changed" };
  return { ok: true, value, contextUnchanged };
}

/**
 * The secret parts of an argument list, each placed by WHAT IT IS, not by its
 * index (so an argument added elsewhere moves nothing): the value after a
 * flag `after:<flag>#<n>`, a secret assignment `assign:<NAME>#<n>` (the
 * whole `NAME=value`, its name kept in the place), a
 * secret-shaped positional argument `positional#<n>`, the parts of a URL
 * argument `url#<n>.url…` (or `assign:<NAME>#<n>.url…`) — `<n>` counting the
 * occurrences of that same place.
 */
function argumentParts(args: readonly string[]): readonly (readonly SecretPart[])[] {
  const counts = new Map<string, number>();
  const next = (kind: string): string => {
    const n = counts.get(kind) ?? 0;
    counts.set(kind, n + 1);
    return `${kind}#${n}`;
  };
  let afterFlag: string | undefined;
  return args.map((arg): readonly SecretPart[] => {
    const flagName = afterFlag;
    // An ATTACHED value (`-pSECRET`, the MySQL form; sec-e-correctness M-3):
    // a single-dash token whose letter names a secret (a plain number stays
    // shown, as `-p 8080` is a port) or whose rest is secret-shaped keeps its
    // letter and conceals the rest — and takes the next argument as its value
    // only when the whole token is itself a secret flag's name (`-password x`);
    // `mysql -uroot -pSECRET db` still shows `db`.
    const attached = /^-([A-Za-z])(.+)$/su.exec(arg);
    if (attached !== null && ((isSecretPartName(attached[1]!) && !/^\d{1,6}$/u.test(attached[2]!)) || secretShaped(attached[2]!))) {
      afterFlag = /^-[A-Za-z_][\w.-]*$/u.test(arg) && isSecretPartName(arg) ? arg : undefined;
      return [{ place: next(`attached:-${attached[1]}`), start: 2, end: arg.length, credential: true }];
    }
    afterFlag = /^-{1,2}[A-Za-z_][\w.-]*$/u.test(arg) ? arg : undefined;
    if (afterFlag !== undefined) return [];
    if (flagName !== undefined) {
      // The value of a flag: concealed unless plainly not a credential (a
      // number stays shown for a one-letter flag: `-p 8080` is a port).
      const plainNumber = /^\d{1,6}$/u.test(arg) && flagName.replace(/^-+/u, "").length === 1;
      return plainNumber || (!isSecretPartName(flagName) && isPlainValue(arg)) ? [] : [{ place: next(`after:${flagName}`), start: 0, end: arg.length, credential: true }];
    }
    const assignment = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/su.exec(arg);
    if (assignment !== null) {
      const valueStart = assignment[1]!.length + 1;
      const value = assignment[2]!;
      const place = next(`assign:${assignment[1]}`);
      if (isSecretPartName(assignment[1]!) || (!isPlainValue(value) && urlParts(value, "") === undefined)) {
        // The WHOLE assignment is the part (its name is in the place): a mark
        // left after `NAME=` would itself read as a credential assignment to
        // a display redactor, which would mask the mark away.
        return value.length === 0 ? [] : [{ place, start: 0, end: arg.length, credential: true }];
      }
      return (urlParts(value, `${place}.`) ?? []).map((part) => ({ ...part, start: part.start + valueStart, end: part.end + valueStart }));
    }
    if (URL_SCHEME.test(arg)) return urlParts(arg, `${next("url")}.`) ?? [];
    return secretShaped(arg) ? [{ place: next("positional"), start: 0, end: arg.length, credential: true }] : [];
  });
}

/** An argument list as it is served: each secret part replaced by its keep mark. */
export function concealArguments(args: readonly string[]): readonly string[] {
  const parts = argumentParts(args);
  return Object.freeze(args.map((arg, index) => withMarks(arg, parts[index] ?? [])));
}

/**
 * An argument list sent back by a writer: its keep marks replaced by the
 * saved list's parts — each only at its own place (the same argument
 * position, the same URL component), and only while the context is
 * unchanged: `callerUnchanged` (the command, the transport, the read paths)
 * and the restored list equal to the saved one (an argument added, removed
 * or edited is another program: `npx -y <package>`, `sh -c <script>`).
 */
export function restoreArguments(sent: readonly string[], saved: readonly string[], callerUnchanged: boolean): Restored<readonly string[]> {
  if (!sent.some(carriesKeepMark)) {
    const value = Object.freeze([...sent]);
    return { ok: true, value, contextUnchanged: callerUnchanged && sameOrderedValues(value, saved) };
  }
  const savedParts = new Map<string, string>();
  argumentParts(saved).forEach((parts, index) => { for (const [place, value] of partValues(saved[index]!, parts)) savedParts.set(place, value); });
  const used = new Set<string>();
  const value: string[] = [];
  for (const arg of sent) {
    const restored = substitute(arg, savedParts, used);
    if (restored === undefined) return { ok: false, reason: "unknown-mark" };
    value.push(restored);
  }
  const measured = new Map<string, string>();
  argumentParts(value).forEach((parts, index) => { for (const [place, part] of partValues(value[index]!, parts)) measured.set(place, part); });
  if (![...used].every((place) => measured.get(place) === savedParts.get(place))) return { ok: false, reason: "moved-mark" };
  if (!callerUnchanged || !sameOrderedValues(value, saved)) return { ok: false, reason: "context-changed" };
  return { ok: true, value: Object.freeze(value), contextUnchanged: true };
}
