/**
 * THE HARNESS COMMAND ENVELOPE — the one shape every `harness <subcommand>`
 * answers with (`{schemaVersion, command, status, result, generatedAt,
 * integrityHash}`): built by {@link wrapResult}, read back (its schema and
 * integrity checked) by {@link parseHarnessCommandResult}.
 *
 * A LEAF: it imports no command table, so a command door (`workspace-cli.ts`,
 * `promotion/promote-cli.ts`) that answers with the envelope never imports
 * `harness-commands.ts` back. That module is itself an entry point with a
 * top-level await: a door importing it while it is the entry waits on its
 * own evaluation (Node exits 13, "unsettled top-level await", printing
 * nothing) — PROMO-2-FIX N3.
 */
import { INPUT_ERROR_CODE, InputError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";

export const HARNESS_COMMAND_SCHEMA_VERSION = schemaId("harness-command", 1);

export type HarnessCommandResult<T = unknown> = Readonly<{
  schemaVersion: typeof HARNESS_COMMAND_SCHEMA_VERSION;
  command: string;
  status: "pass" | "fail";
  result: T;
  generatedAt: string;
  integrityHash: string;
}>;

/**
 * A SIGNED REPORT read back (the harness envelope, the auto-generator's and the
 * module registrar's reports): an object of `schemaVersion` whose
 * `integrityHash` is the digest of the rest, else the typed refusal naming
 * what is wrong (`label` says which record).
 */
export function parseSignedReport<T>(value: unknown, schemaVersion: string, label: string): T {
  if (typeof value !== "object" || value === null) {
    throw new InputError(`${label} must be an object`, INPUT_ERROR_CODE);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== schemaVersion) {
    throw new InputError(`${label} schema version is invalid`, INPUT_ERROR_CODE);
  }
  if (record.integrityHash === undefined || typeof record.integrityHash !== "string") {
    throw new InputError(`${label} integrity hash is invalid`, INPUT_ERROR_CODE);
  }
  const { integrityHash, ...unsigned } = record;
  if (sha256(canonicalJson(unsigned)) !== integrityHash) {
    throw new InputError(`${label} integrity is invalid`, INPUT_ERROR_CODE);
  }
  return deepFreeze(record as unknown as T);
}

export function parseHarnessCommandResult(value: unknown): HarnessCommandResult {
  return parseSignedReport<HarnessCommandResult>(value, HARNESS_COMMAND_SCHEMA_VERSION, "harness command result");
}

export function wrapResult<T>(
  command: string,
  result: T,
  options: Readonly<{ status?: "pass" | "fail" }> = {},
): HarnessCommandResult<T> {
  // Explicit status wins when provided; otherwise derive it from the result
  // payload's failure predicates. Commands that repair drift (register --write,
  // regenerate) pass an explicit status computed from POST-WRITE state so a
  // successful correction is reported as pass instead of the pre-fix drift.
  const status: "pass" | "fail" = options.status ?? (resultHasFail(result) ? "fail" : "pass");
  const unsigned = {
    schemaVersion: HARNESS_COMMAND_SCHEMA_VERSION,
    command,
    status,
    result,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as HarnessCommandResult<T>);
}

const FAILURE_PREDICATES: ReadonlyArray<(record: Record<string, unknown>) => boolean> = [
  (r) => r.allPassed === false,
  (r) => r.allMatch === false,
  (r) => r.matches === false,
  (r) => r.registered === false,
  (r) => r.ok === false,
  (r) => r.success === false,
  (r) => r.status === "fail",
  (r) => r.status === "drift",
  (r) => r.status === "error",
  (r) => typeof r.unregisteredModules === "number" && r.unregisteredModules > 0,
  (r) => typeof r.driftedModules === "number" && r.driftedModules > 0,
];

export function resultHasFail(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => resultHasFail(item));
  }
  const record = value as Record<string, unknown>;
  for (const predicate of FAILURE_PREDICATES) {
    if (predicate(record)) return true;
  }
  for (const child of Object.values(record)) {
    if (resultHasFail(child)) return true;
  }
  return false;
}

/**
 * HOW A HARNESS COMMAND ANSWERS — ONE OPTION FOR EVERY VERB: the JSON
 * envelope (`--json`, the default: what scripts and agents parse) or a short
 * report (`--text`: what a person reads). The harness CLI's one dispatch
 * takes the flags out of every verb's argv ({@link takeOutputFormat}) and
 * renders every verb's answer ({@link renderCommandAnswer}); no verb parses
 * them itself.
 */
export type CommandOutputFormat = "json" | "text";

/**
 * The format `argv` asks for — the last of `--json` / `--text` wins, JSON by
 * default — and `argv` without those flags. Only the options before a `--`
 * are read: after it every argument is an operand (a path named `--text` is
 * a path), kept as given.
 */
export function takeOutputFormat(argv: readonly string[]): Readonly<{ format: CommandOutputFormat; argv: readonly string[] }> {
  const end = argv.indexOf("--");
  const options = end < 0 ? argv : argv.slice(0, end);
  const operands = end < 0 ? [] : argv.slice(end);
  const format: CommandOutputFormat = options.lastIndexOf("--text") > options.lastIndexOf("--json") ? "text" : "json";
  return deepFreeze({ format, argv: [...options.filter((argument) => argument !== "--json" && argument !== "--text"), ...operands] });
}

/**
 * A verb's answer, before it is rendered: its envelope; the exit code when
 * the verb maps its own (the class of a promotion code), else pass 0 / fail 1;
 * and its own report when one reads better than the generic
 * {@link envelopeText}.
 */
export type CommandAnswer<T = unknown> = Readonly<{
  result: HarnessCommandResult<T>;
  exitCode?: number;
  text?: () => string;
}>;

/** The bytes a command prints on stdout for `answer` in `format`. */
export function renderCommandAnswer<T>(answer: CommandAnswer<T>, format: CommandOutputFormat): string {
  if (format === "json") return `${canonicalJson(answer.result)}\n`;
  return answer.text === undefined ? envelopeText(answer.result) : answer.text();
}

/** The exit code of `answer`: its own when the verb maps one, else 0 for pass and 1 for fail. */
export function commandExitCode(answer: CommandAnswer): number {
  return answer.exitCode ?? (answer.result.status === "pass" ? 0 : 1);
}

/**
 * THE GENERIC REPORT of an envelope: `<command>: <status>`, then the result
 * as indented `key: value` lines (a list's items as `- ` entries, a nested
 * record one level deeper), in the envelope's own key order. Every verb has
 * it; a verb gives its own only where a summary reads better.
 */
export function envelopeText(result: HarnessCommandResult): string {
  return [`${result.command}: ${result.status}`, ...textLines(result.result, 1)].join("\n").concat("\n");
}

function scalarText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

function isComposite(value: unknown): value is object {
  return typeof value === "object" && value !== null && (!Array.isArray(value) || value.length > 0) && (Array.isArray(value) || Object.keys(value).length > 0);
}

function textLines(value: unknown, depth: number): string[] {
  const indent = "  ".repeat(depth);
  if (!isComposite(value)) return [`${indent}${scalarText(value)}`];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!isComposite(item)) return [`${indent}- ${scalarText(item)}`];
      const [first, ...rest] = textLines(item, depth + 1);
      return [`${indent}- ${first!.trimStart()}`, ...rest];
    });
  }
  return Object.entries(value).flatMap(([key, child]) =>
    isComposite(child) ? [`${indent}${key}:`, ...textLines(child, depth + 1)] : [`${indent}${key}: ${scalarText(child)}`]);
}
