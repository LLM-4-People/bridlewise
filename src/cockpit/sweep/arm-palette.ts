/**
 * THE ARM PALETTE — the predicate space DERIVED from the server's own
 * vocabulary, never a hand list.
 *
 * The record's grammar (ARM_PREDICATE_VOCABULARY in shared/arm-vocabulary.ts
 * — the same map the server's validatePredicate enforces) declares five
 * roots and their fields; this module turns THAT declaration into the
 * palette's rows:
 *
 *   - the FIELD LIST (armPaletteFields): every field the map exposes, with
 *     the root's plain-words meaning and the field's evaluation truth —
 *     each an insert button for the custom entry. A field added to the map
 *     tomorrow appears here with ZERO consumer edits (the registry-derivation
 *     pattern; tests/cockpit/arm-palette.test.ts plants a grown map and
 *     proves it).
 *   - the OPERATORS: the grammar's own tokens (WHEN_OPERATORS, declared by
 *     the parser that accepts them), each named by what it means.
 *   - the READY ROWS (armPaletteRows): the common composed shapes — a named
 *     tool failing, a named check failing, the run boundary, a denied
 *     outcome, an error code — each a TEMPLATE over vocabulary fields
 *     (every field a template references is guarded to be a live member),
 *     so arming one builds a real grammar expression the record accepts.
 *
 * The four fixed quick rows (marks.ts's kinds) are NOT here — they stay the
 * arm menu's own one-click layer (the Grafana "Default options" reading:
 * the common cases stay one click away; this palette is the advanced door).
 *
 * RENDERING NOTE (APG Listbox, retrieved 2026-09-04): the palette's rows
 * carry BUTTONS, and "the interaction model conveyed by the listbox role …
 * does not support interacting with elements inside of an option" — so this
 * is NOT a listbox; consumers render plain rows grouped by root, the app's
 * own row grammar.
 */

import {
  ARM_PREDICATE_VOCABULARY,
  armVocabularyFields,
  type ArmVocabularyField,
} from "../../../shared/arm-vocabulary.ts";
import { WHEN_OPERATORS } from "../../../shared/when-eval.ts";

import { armFieldEvaluation } from "./arm-fire";

// ── The field list ──────────────────────────────────────────────────────────

export type ArmPaletteField = Readonly<
  ArmVocabularyField & {
    /** The root's plain-words meaning, verbatim from the map. */
    meaning: string;
    /** The evaluation truth rendered on the row. */
    evaluation: string;
  }
>;

/**
 * Every vocabulary field the palette offers, derived from the map itself.
 * The optional argument exists so the derivation can be proven against a
 * PLANTED map (a grown vocabulary surfaces here with zero test edits).
 */
export function armPaletteFields(
  vocabulary: Readonly<Record<string, string>> = ARM_PREDICATE_VOCABULARY,
): readonly ArmPaletteField[] {
  const meanings = new Map<string, string>();
  for (const [root, description] of Object.entries(vocabulary)) {
    // The meaning is the description up to the first enumerated field —
    // "the received ledger event: event.type, …" reads as "the received
    // ledger event". A description with no colon reads whole.
    const colon = description.indexOf(":");
    meanings.set(root, colon === -1 ? description : description.slice(0, colon).trim());
  }
  return armVocabularyFields(vocabulary).map((f) =>
    Object.freeze({
      ...f,
      meaning: meanings.get(f.root) ?? f.root,
      evaluation: armFieldEvaluation(f.path),
    }),
  );
}

/** The fields grouped by root, in the map's own declaration order — the
 * APG's grouping advice (a flat list whose every name starts with the same
 * word degrades usability; the groups carry the shared prefix instead). */
export function armPaletteFieldGroups(
  vocabulary: Readonly<Record<string, string>> = ARM_PREDICATE_VOCABULARY,
): ReadonlyArray<Readonly<{ root: string; meaning: string; fields: readonly ArmPaletteField[] }>> {
  const fields = armPaletteFields(vocabulary);
  const groups = new Map<string, { root: string; meaning: string; fields: ArmPaletteField[] }>();
  for (const field of fields) {
    let group = groups.get(field.root);
    if (group === undefined) {
      group = { root: field.root, meaning: field.meaning, fields: [] };
      groups.set(field.root, group);
    }
    group.fields.push(field);
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze(group)));
}

// ── The operators ───────────────────────────────────────────────────────────

/** One grammar operator, named by what it means (Grafana's threshold
 * vocabulary idiom — "Is above: `$A > 5`"). */
export type ArmPaletteOperator = Readonly<{
  /** The token the operator inserts. */
  token: string;
  /** Its plain words. */
  label: string;
}>;

/** The operator rows, DERIVED from the parser's own WHEN_OPERATORS list —
 * an operator the tokenizer refuses can never be offered, and one it gains
 * can never be missed. The labels are the presentation of THIS list, keyed
 * by token with a plain-words default. */
const OPERATOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "==": "equals",
  "!=": "is not",
  ">=": "is at least",
  "<=": "is at most",
  ">": "is above",
  "<": "is below",
  "&&": "and",
  "||": "or",
  "!": "not",
});

export function armPaletteOperators(): readonly ArmPaletteOperator[] {
  return Object.freeze(
    WHEN_OPERATORS.map((token) =>
      Object.freeze({ token, label: OPERATOR_LABELS[token] ?? token }),
    ),
  );
}

// ── The ready rows (templates over vocabulary fields) ──────────────────────

export type ArmPaletteRow = Readonly<{
  id: string;
  /** The row's plain-words label. */
  label: string;
  /** Builds the grammar expression. A param row builds from the param;
   *   empty/null means "needs a value first" and the row must not arm. */
  build: (param: string | null) => { predicate: string } | { needs: string };
  /** True when the row takes a typed value (renders an input). */
  paramPlaceholder: string | null;
  /** The evaluation truth rendered under the row. */
  evaluation: string;
}>;

/** Every field path a template's built predicate references — used by the
 * guard that holds templates to live vocabulary members. */
export function armTemplateFields(row: ArmPaletteRow): readonly string[] {
  // A template is data the round controls; build with a sentinel param and
  // collect the dotted paths out of the result, ignoring the sentinel.
  const built = row.build("«»");
  if (!("predicate" in built)) return [];
  const out = new Set<string>();
  for (const m of built.predicate.matchAll(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/g)) {
    out.add(m[0]!);
  }
  return [...out];
}

/** Quote a value into the grammar: single-quoted, inner quotes escaped. */
function quoteValue(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The ready rows — the common composed shapes over vocabulary fields. Each
 * row's built predicate is a real grammar expression the server accepts
 * (drift-tested in tests/cockpit/sweep-arm-sync.test.ts against
 * validatePredicate), and every field it references is held to the live
 * vocabulary by the palette guard.
 */
export function armPaletteRows(
  vocabulary: Readonly<Record<string, string>> = ARM_PREDICATE_VOCABULARY,
): readonly ArmPaletteRow[] {
  void vocabulary;
  return Object.freeze([
    {
      id: "tool-name-fails",
      label: "a tool named X fails",
      build: (param) =>
        param === null || param.trim().length === 0
          ? { needs: "name a tool first" }
          : { predicate: `tool.name == ${quoteValue(param.trim())} && tool.failed` },
      paramPlaceholder: "tool name",
      evaluation: armFieldEvaluation("tool.failed"),
    },
    {
      id: "check-id-fails",
      label: "a check named X fails",
      build: (param) =>
        param === null || param.trim().length === 0
          ? { needs: "name a check first" }
          : {
              predicate:
                `check.id == ${quoteValue(param.trim())} && check.status == 'failed'`,
            },
      paramPlaceholder: "check name",
      evaluation: armFieldEvaluation("check.status"),
    },
    {
      id: "run-boundary",
      label: "a run boundary is reached",
      build: () => ({ predicate: "event.type == 'run'" }),
      paramPlaceholder: null,
      evaluation: armFieldEvaluation("event.type"),
    },
    {
      id: "denied-outcome",
      label: "anything is denied",
      build: () => ({ predicate: "event.outcome == 'denied'" }),
      paramPlaceholder: null,
      evaluation: armFieldEvaluation("event.outcome"),
    },
    {
      id: "error-code",
      label: "an event carries error code X",
      build: (param) =>
        param === null || param.trim().length === 0
          ? { needs: "name an error code first" }
          : { predicate: `event.errorCode == ${quoteValue(param.trim())}` },
      paramPlaceholder: "error code",
      evaluation: armFieldEvaluation("event.errorCode"),
    },
    {
      id: "tool-slow",
      label: "a tool call takes over N ms",
      build: (param) => {
        const n = Number(param ?? NaN);
        if (!Number.isFinite(n) || n <= 0) return { needs: "a duration in ms first" };
        return { predicate: `tool.durationMs >= ${n}` };
      },
      paramPlaceholder: "ms",
      evaluation: armFieldEvaluation("tool.durationMs"),
    },
  ]);
}
