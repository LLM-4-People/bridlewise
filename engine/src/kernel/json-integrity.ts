import { InputError } from "./errors.ts";

/**
 * One exact JSON parse attempt. The parsed value is boxed so JSON `null` stays
 * distinguishable from "not JSON". Never throws, and never surfaces the parser's
 * message: V8 quotes the input text in it, so a caller that logged it would leak
 * the (possibly private) document.
 */
export function parseJsonExact(text: string): Readonly<{ value: unknown }> | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * One JSON number token of a document: its UTF-16 range and its LABEL, the
 * object key it is the value of (for an array element, the key of the nearest
 * array that holds it), or null when nothing names it.
 */
export type JsonNumberRange = Readonly<{ startUtf16: number; endUtf16: number; label: string | null }>;

/** One lexeme of a text read as JSON: a bracket, a string literal or a number token, by its UTF-16 range. */
type JsonLexeme = Readonly<{ kind: "open-object" | "open-array" | "close" | "string" | "number"; startUtf16: number; endUtf16: number }>;

const JSON_NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

/**
 * THE ONE JSON LEXER of this module: the brackets, string literals and number
 * tokens of `text`, in order (every other character is skipped). It stops at
 * an unterminated string literal, so a caller reading malformed text sees
 * only what was well formed before it.
 */
function* jsonLexemes(text: string): Generator<JsonLexeme> {
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === "{" || character === "[") {
      yield { kind: character === "{" ? "open-object" : "open-array", startUtf16: index, endUtf16: index + 1 };
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      yield { kind: "close", startUtf16: index, endUtf16: index + 1 };
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      let closed = false;
      while (index < text.length) {
        const current = text[index]!;
        index += 1;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return;
      yield { kind: "string", startUtf16: start, endUtf16: index };
      continue;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      JSON_NUMBER_TOKEN.lastIndex = index;
      const token = JSON_NUMBER_TOKEN.exec(text);
      if (token !== null) {
        yield { kind: "number", startUtf16: index, endUtf16: index + token[0].length };
        index += token[0].length;
        continue;
      }
    }
    index += 1;
  }
}

/**
 * Where the NUMBER tokens of a JSON document are (each a typed value, not a
 * string of text), in order, each with its label; undefined when `text` is
 * not JSON.
 */
export function jsonNumberRanges(text: string): readonly JsonNumberRange[] | undefined {
  if (parseJsonExact(text) === undefined) return undefined;
  const ranges: JsonNumberRange[] = [];
  // Per open container: the label its elements inherit (an array's key; an object's members carry their own).
  const containers: (string | null)[] = [];
  let pendingKey: string | null = null;
  for (const lexeme of jsonLexemes(text)) {
    const key = pendingKey;
    pendingKey = null;
    if (lexeme.kind === "open-object" || lexeme.kind === "open-array") {
      containers.push(lexeme.kind === "open-array" ? key ?? containers.at(-1) ?? null : null);
    } else if (lexeme.kind === "close") {
      containers.pop();
    } else if (lexeme.kind === "number") {
      ranges.push({ startUtf16: lexeme.startUtf16, endUtf16: lexeme.endUtf16, label: key ?? containers.at(-1) ?? null });
    } else if (followedByColon(text, lexeme.endUtf16)) {
      pendingKey = JSON.parse(text.slice(lexeme.startUtf16, lexeme.endUtf16)) as string;
    }
  }
  return ranges;
}

/** Whether the next non-space character from `index` is a colon: the string literal before it is an object key. */
function followedByColon(text: string, index: number): boolean {
  let lookahead = index;
  while (/\s/u.test(text[lookahead] ?? "")) lookahead += 1;
  return text[lookahead] === ":";
}

export function assertNoDuplicateJsonObjectKeys(text: string, message: string, code: string): void {
  const objectKeys: Array<Set<string> | null> = [];
  for (const lexeme of jsonLexemes(text)) {
    if (lexeme.kind === "open-object" || lexeme.kind === "open-array") {
      objectKeys.push(lexeme.kind === "open-object" ? new Set() : null);
      continue;
    }
    if (lexeme.kind === "close") {
      objectKeys.pop();
      continue;
    }
    if (lexeme.kind !== "string") continue;
    const keys = objectKeys.at(-1);
    if (!followedByColon(text, lexeme.endUtf16) || !keys) continue;
    let key: string;
    try {
      key = JSON.parse(text.slice(lexeme.startUtf16, lexeme.endUtf16)) as string;
    } catch {
      return;
    }
    if (keys.has(key)) throw new InputError(message, code);
    keys.add(key);
  }
}
