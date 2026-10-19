import { deepFreeze } from "../kernel/integrity.ts";
import { type IntelligenceSpan, NO_SPANS } from "./detection-span.ts";

/**
 * Freeze the array and each entry, but NOT the values inside an entry.
 *
 * `deepFreeze` reaches the RegExp objects, and a frozen RegExp cannot have
 * its `lastIndex` reset — so a shared `g` pattern would scan from wherever
 * the previous string left it and miss every match before that point. The
 * first version of this file did exactly that and threw on the second call;
 * it would have been a silent miss had the assignment been non-strict.
 */
function shallowFreeze<T>(entries: readonly T[]): readonly T[] {
  for (const entry of entries) Object.freeze(entry);
  return Object.freeze(entries);
}

/**
 * LAYERS 1 AND 2 — the value that proves itself, and the value with one
 * grammar.
 *
 * LAYER 1, SELF-VALIDATING. A payment card number is not "16 digits that
 * look like a card"; it is 16 digits whose last one is determined by the
 * other fifteen. An IBAN carries a mod-97 residue. A US routing number
 * carries a weighted digit sum. These are ARITHMETIC facts about the value,
 * so the detection is `proven` in the same sense an identity match is: there
 * is no inference step and no language anywhere in it. A checksum is
 * identical in every locale, which is exactly the property the credential
 * nouns do not have.
 *
 * It was also, until now, completely unused. The engine held four layers and
 * none of them could see a card number.
 *
 * LAYER 2, GRAMMAR-DEFINED. An email address, an IP address, a phone number
 * in E.164 form. One published grammar each, `format` confidence: the shape
 * is proof of shape and nothing more.
 *
 * WHAT IS DELIBERATELY ABSENT, and it is the honest half of this file.
 * PERSONAL NAMES AND STREET ADDRESSES ARE NOT DETERMINISTICALLY SOLVABLE.
 * "Mr Baker went to the baker" needs the world to disambiguate; "12 High
 * Street" and "12 high scores" differ by a dictionary that does not exist in
 * every language. Every deterministic attempt is either a name list — which
 * is a wordlist with worse recall and a nationality bias — or a pattern that
 * masks ordinary sentences. Declared as out of scope in the registry, so the
 * gap is a STATED FACT a user can read rather than a silent hole.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

// ── LAYER 1: checksums ───────────────────────────────────────────────────

/**
 * The Luhn residue. A card number is valid when doubling every second digit
 * from the right (casting out nines) and summing leaves a multiple of ten.
 *
 * Pure, total, and defined on digits only — the caller strips separators.
 */
export function passesLuhn(digits: string): boolean {
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    let value = code - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * THE ISSUER PREFIXES, and why a checksum alone is not enough.
 *
 * One digit in ten passes Luhn by chance, so "16 digits that pass Luhn" would
 * mask roughly a tenth of every long numeric id in the world — order numbers,
 * device ids, a 16-digit timestamp concatenation. The checksum is the proof
 * that a candidate is well-formed; the issuer prefix is what makes it a
 * candidate. Both are required, and neither is a wordlist: an IIN range is
 * published arithmetic, not vocabulary.
 */
// NOT `deepFreeze`: freezing a RegExp freezes its `lastIndex`, and a shared
// `g` regex whose cursor cannot be reset scans from wherever the previous
// call left it — a security control that silently starts mid-string. The
// array and its entries are frozen; the patterns are not.
const CARD_ISSUERS: readonly Readonly<{ name: string; pattern: RegExp }>[] = shallowFreeze([
  { name: "Visa", pattern: /^4\d{12}(?:\d{3})?(?:\d{3})?$/u },
  { name: "Mastercard", pattern: /^(?:5[1-5]\d{14}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20))\d{12})$/u },
  { name: "American Express", pattern: /^3[47]\d{13}$/u },
  { name: "Discover", pattern: /^(?:6011\d{12}|65\d{14}|64[4-9]\d{13})$/u },
  { name: "JCB", pattern: /^35(?:2[89]|[3-8]\d)\d{12}$/u },
  { name: "Diners Club", pattern: /^3(?:0[0-5]|[68]\d)\d{11}$/u },
  { name: "UnionPay", pattern: /^62\d{14,17}$/u },
]);

function cardIssuer(digits: string): string | null {
  for (const issuer of CARD_ISSUERS) {
    if (issuer.pattern.test(digits)) return issuer.name;
  }
  return null;
}

/**
 * The IBAN mod-97 check: move the first four characters to the end, map
 * letters to two-digit numbers (A=10 … Z=35), and the resulting integer must
 * be ≡ 1 (mod 97). Computed incrementally so no big-integer type is needed.
 */
export function passesIbanMod97(iban: string): boolean {
  const compact = iban.replace(/[\s-]/gu, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "0" && ch <= "9" ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * The ABA routing-number check digit: 3·(d1+d4+d7) + 7·(d2+d5+d8) +
 * 1·(d3+d6+d9) ≡ 0 (mod 10).
 */
export function passesAbaRouting(digits: string): boolean {
  if (!/^\d{9}$/u.test(digits)) return false;
  // A routing number's first two digits are a Federal Reserve district; 80–99
  // and 13–20 are unassigned, and excluding them is what stops a nine-digit
  // id passing on the checksum alone.
  const prefix = Number(digits.slice(0, 2));
  if (!((prefix >= 0 && prefix <= 12) || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80)) {
    return false;
  }
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += weights[i]! * (digits.charCodeAt(i) - 48);
  return sum % 10 === 0;
}

/**
 * A US Social Security number, by the rules the administration publishes.
 *
 * There is NO checksum — so this is the honest edge of layer 1, and it is
 * labelled `format` rather than `proven` for exactly that reason. What the
 * rules do give is a set of impossible values: area 000, 666 and 900–999 are
 * never issued, group 00 is never issued, serial 0000 is never issued. Those
 * exclusions are what stop `123-45-6789`-shaped test data and a dotted
 * version number from being masked.
 */
export function isPossibleUsSsn(value: string): boolean {
  const match = /^(\d{3})-(\d{2})-(\d{4})$/u.exec(value);
  if (match === null) return false;
  const area = Number(match[1]);
  const group = Number(match[2]);
  const serial = Number(match[3]);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

// ── LAYER 2: one grammar each ────────────────────────────────────────────

/**
 * An email address. The grammar is bounded on both sides so it cannot run
 * away down a line, and the TLD must be alphabetic and at least two
 * characters, which is what keeps `version@1.2` and `user@localhost` out.
 */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/gu;

/**
 * A dotted-quad IPv4 address, every octet ≤ 255.
 *
 * `RESERVED_IPV4` is subtracted, and that is a correctness rule rather than
 * a tuning one: `127.0.0.1`, `0.0.0.0`, `192.168.x.x` and `10.x.x.x` identify
 * nobody. Masking `localhost` out of a stack trace destroys the trace and
 * protects no one, which is the shape of false positive that costs most.
 */
const IPV4 =
  /(?<![\dA-Za-z._-])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\dA-Za-z._-])/gu;

function isReservedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127 || a === 10 || a === 255) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * A full IPv6 address. Deliberately only the fully-written and
 * one-`::`-elided forms with at least four groups — a short `::1` or a bare
 * `a::b` is loopback or a fragment of something else, and the shape collides
 * with too much punctuation to be worth the recall.
 */
const IPV6 = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])|(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,6}(?::[0-9A-Fa-f]{1,4}){1,5}(?![0-9A-Fa-f:])/gu;

/**
 * A phone number in E.164 form: a leading `+`, a country code, 7–14 more
 * digits, with spaces, dashes and parentheses tolerated inside.
 *
 * The leading `+` is required and it is the whole reason this grammar is
 * safe. Bare digit runs are order numbers, ids, timestamps and prices;
 * a `+` in front of 8–15 digits is a phone number and essentially nothing
 * else. Recall is traded away for precision on purpose, and the trade is
 * stated in the registry.
 */
const E164_PHONE = /\+[1-9]\d{0,2}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){6,13}(?!\d)/gu;

/**
 * A SELF-VALIDATING NUMBER IS A WHOLE TOKEN, and the boundary below is what
 * says so.
 *
 * `IBAN_CANDIDATE` got this right — `(?<![A-Za-z0-9])` — and the card,
 * routing, SSN and IPv4 grammars did not: they excluded only digits and
 * dashes, so a digit run sitting INSIDE a longer alphanumeric token was
 * accepted as a standalone number. A checksum then had a one-in-ten chance
 * of agreeing, and on ordinary source it agreed constantly:
 *
 *     .../commit/7cc09ca8a581783c2391824885206348e5e99934
 *                             ^^^^^^^^^^^^^^^^ passes Luhn
 *     .../commit/f2d801918841e7673ff3f048d0d895592a2f7e23
 *                    ^^^^^^^^^ passes the ABA check
 *
 * Nine vue changelog entries were masked as bank and card data because a
 * slice of a git SHA happened to satisfy an arithmetic check. THE ARITHMETIC
 * WAS NEVER THE PROBLEM — the candidate was, and a candidate that starts or
 * ends against a letter was never a card number in the first place.
 *
 * Costs no recall: a real card, routing or SSN value is delimited by
 * whitespace, punctuation or a quote, never welded to a letter.
 */
const TOKEN_EDGE_BEFORE = "(?<![A-Za-z0-9_-])";
const TOKEN_EDGE_AFTER = "(?![A-Za-z0-9_-])";

/** A payment-card candidate: 12–19 digits, groups optionally separated. */
const CARD_CANDIDATE = new RegExp(
  `${TOKEN_EDGE_BEFORE}(?:\\d[ -]?){11,18}\\d${TOKEN_EDGE_AFTER}`,
  "gu",
);

/** An IBAN candidate: two country letters, two check digits, then the BBAN. */
const IBAN_CANDIDATE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){2,8}(?![A-Za-z0-9])/gu;

/** A routing-number candidate: nine digits with an explicit boundary. */
const ROUTING_CANDIDATE = new RegExp(`${TOKEN_EDGE_BEFORE}\\d{9}${TOKEN_EDGE_AFTER}`, "gu");

/** A US SSN candidate, dashed only — an undashed nine-digit run is
 * indistinguishable from every other nine-digit number. */
const SSN_CANDIDATE = new RegExp(
  `${TOKEN_EDGE_BEFORE}\\d{3}-\\d{2}-\\d{4}${TOKEN_EDGE_AFTER}`,
  "gu",
);

/**
 * A detector declared once and run uniformly: find candidates with a
 * grammar, then confirm each with a predicate. Every layer-1 type is that
 * shape, which is why they share one loop rather than five.
 */
type ValueDetector = Readonly<{
  signalId: string;
  detectorId: string;
  pattern: RegExp;
  confirm: (value: string) => boolean;
  confidence: "proven" | "format";
  explain: (value: string) => string;
  /**
   * ONE CHARACTER THIS GRAMMAR CANNOT MATCH WITHOUT.
   *
   * Every one of these patterns is anchored on something rare: an `@` for an
   * email, a `+` for an E.164 number, a `:` for IPv6, a digit for everything
   * arithmetic. A single `indexOf` refuses the string before the automaton
   * is entered, and on ordinary text that is almost always the answer.
   *
   * MEASURED, and it is the reason this exists rather than a tidy-up: eight
   * automata over every string leaf of every response cost 1.28 microseconds
   * per leaf, which is the largest single item on the egress path. The
   * prefilter cannot change what matches — a string with no `@` has no email
   * in it — so it is a pure cost removal.
   */
  requires: (text: string) => boolean;
}>;

const hasDigit = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) return true;
  }
  return false;
};

const DETECTORS: readonly ValueDetector[] = shallowFreeze([
  {
    signalId: "payment-card",
    detectorId: "luhn-checksum",
    requires: hasDigit,
    pattern: CARD_CANDIDATE,
    confirm: (value: string) => {
      const digits = value.replace(/[ -]/gu, "");
      return cardIssuer(digits) !== null && passesLuhn(digits);
    },
    confidence: "proven" as const,
    explain: (value: string) => {
      const issuer = cardIssuer(value.replace(/[ -]/gu, ""));
      return `is a ${issuer ?? "payment"} card number — its own check digit proves it`;
    },
  },
  {
    signalId: "bank-account",
    detectorId: "iban-mod97",
    requires: hasDigit,
    pattern: IBAN_CANDIDATE,
    confirm: passesIbanMod97,
    confidence: "proven" as const,
    explain: () => "is a bank account number — its own check digits prove it",
  },
  {
    signalId: "bank-routing",
    detectorId: "aba-checksum",
    requires: hasDigit,
    pattern: ROUTING_CANDIDATE,
    confirm: passesAbaRouting,
    confidence: "proven" as const,
    explain: () => "is a bank routing number — its own check digit proves it",
  },
  {
    signalId: "national-id",
    detectorId: "us-ssn-rules",
    requires: hasDigit,
    pattern: SSN_CANDIDATE,
    confirm: isPossibleUsSsn,
    confidence: "format" as const,
    explain: () => "has the shape of a social security number",
  },
  {
    signalId: "email-address",
    detectorId: "email-grammar",
    requires: (t: string) => t.includes("@"),
    pattern: EMAIL,
    confirm: () => true,
    confidence: "format" as const,
    explain: () => "is an email address",
  },
  {
    signalId: "ip-address",
    detectorId: "ipv4-grammar",
    requires: (t: string) => t.includes(".") && hasDigit(t),
    pattern: IPV4,
    confirm: (value: string) => !isReservedIpv4(value),
    confidence: "format" as const,
    explain: () => "is a public network address",
  },
  {
    signalId: "ip-address",
    detectorId: "ipv6-grammar",
    requires: (t: string) => t.includes(":"),
    pattern: IPV6,
    confirm: () => true,
    confidence: "format" as const,
    explain: () => "is a public network address",
  },
  {
    signalId: "phone-number",
    detectorId: "e164-grammar",
    requires: (t: string) => t.includes("+"),
    pattern: E164_PHONE,
    confirm: () => true,
    confidence: "format" as const,
    explain: () => "is a phone number",
  },
]);

/** The detector ids this module offers, for the registry to declare. */
export const IDENTITY_DETECTOR_IDS: readonly string[] = deepFreeze(
  DETECTORS.map((d) => d.detectorId),
);

/**
 * Layers 1 and 2 over one string, restricted to the detector ids the caller
 * has enabled.
 *
 * `enabled` is a set rather than a boolean because these types are exactly
 * the ones a user turns off: a support engineer pastes IP addresses all day
 * and wants them, a finance team never does. The tier switch reaches this
 * function and nothing else needs to know.
 */
export function identitySpans(
  text: string,
  enabled: ReadonlySet<string>,
): readonly IntelligenceSpan[] {
  if (text.length < 7) return NO_SPANS;
  const spans: IntelligenceSpan[] = [];
  for (const detector of DETECTORS) {
    if (!enabled.has(detector.detectorId)) continue;
    // The character this grammar cannot match without. See `requires`.
    if (!detector.requires(text)) continue;
    const pattern = detector.pattern;
    // Shared `g` regexes: the cursor survives the previous call.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];
      if (value.length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      if (!detector.confirm(value)) continue;
      spans.push(
        Object.freeze({
          startUtf16: match.index,
          endUtf16: match.index + value.length,
          signalId: detector.signalId,
          detectorId: detector.detectorId,
          confidence: detector.confidence,
          // The explanation names the KIND, never any part of the value.
          explanation: detector.explain(value),
        }),
      );
    }
  }
  return spans.length === 0 ? NO_SPANS : Object.freeze(spans);
}
