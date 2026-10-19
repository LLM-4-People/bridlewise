/**
 * THE ARM VOCABULARY — the arming contract, shared by both ends.
 *
 * This is the map the server's `arm.flags` block validates predicates
 * against (server/blocks/arm.ts — `validatePredicate`) AND the map the
 * client's arm palette derives its field rows from (sweep/arm-palette.ts).
 * It lives in `shared/` because BOTH ends need it at runtime and neither
 * may import the other: the server must not reach into the cockpit, and
 * the browser bundle must not drag the server's module graph. A predicate
 * vocabulary that only the server could read would force the client to
 * re-state it by hand — the exact drift this map exists to prevent (the
 * block's own contract: "the palette/autocomplete enumerates THIS map, so
 * it cannot offer an unbindable key").
 *
 * Each ROOT's value is a plain-words description that ENUMERATES ITS OWN
 * FIELDS (`event.type, event.outcome, …`) — the fields are PARSED from the
 * description by `armVocabularyFields`, never re-listed, so a field added
 * to a description surfaces in the palette with zero consumer edits.
 */

/**
 * Identifier ROOTS a trigger predicate may reference, with what each binds
 * to on the live stream. This is the arming contract: the client's stream
 * consumer builds exactly this context per received event. The palette/
 * autocomplete enumerates THIS map, so it cannot offer an unbindable key.
 */
export const ARM_PREDICATE_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  event: "the received ledger event: event.type, event.outcome, event.errorCode, event.description, event.runId",
  tool: "the tool frame in flight: tool.name, tool.failed, tool.durationMs",
  check: "an auto-check delta: check.id, check.status",
  context: "the context gauge: context.pct, context.tokens, context.limit",
  run: "the live run: run.id, run.streaming",
});

const PREDICATE_KEYWORDS = new Set(["null", "true", "false"]);

/**
 * Identifier roots referenced by a when-eval expression. String literals are
 * stripped first so quoted values are never mistaken for identifiers.
 */
export function predicateRoots(expr: string): readonly string[] {
  const withoutStrings = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  const roots = new Set<string>();
  for (const m of withoutStrings.matchAll(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*/g)) {
    const ident = m[0]!;
    const root = ident.split(".")[0]!;
    if (!PREDICATE_KEYWORDS.has(root)) roots.add(root);
  }
  return [...roots];
}

/** One field a vocabulary root exposes, parsed from the root's own
 * description — the palette's row unit. */
export type ArmVocabularyField = Readonly<{
  /** The full dotted path, e.g. "event.type". */
  path: string;
  /** The root, e.g. "event". */
  root: string;
  /** The field within the root, e.g. "type". */
  field: string;
}>;

/**
 * Every field the vocabulary exposes, derived by parsing each root's
 * description for the dotted paths it enumerates. The parameter is the map
 * itself (defaulting to the live vocabulary) so a test can plant a GROWN
 * map and watch the palette grow through the same derivation — the
 * registry-derivation pattern, mechanically proven rather than asserted.
 *
 * A root whose description enumerates no dotted path yields no fields (the
 * root still exists for `predicateRoots` validation; the palette shows the
 * root's description alone).
 */
export function armVocabularyFields(
  vocabulary: Readonly<Record<string, string>> = ARM_PREDICATE_VOCABULARY,
): readonly ArmVocabularyField[] {
  const out: ArmVocabularyField[] = [];
  const seen = new Set<string>();
  for (const [root, description] of Object.entries(vocabulary)) {
    for (const m of description.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
      const path = m[0]!;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(Object.freeze({ path, root, field: m[2]! }));
    }
  }
  return Object.freeze(out);
}
