/**
 * Settings block — the generic inline write for a declared setting.
 *
 * The action is a thin door onto the EXISTING validated write path:
 * `setSchemaCustomization` → the registry's `setCustomizationValue`, which
 * checks the declared contract (type, min, max, enum) before any module's
 * setter runs. Nothing here re-validates and nothing here bypasses — the
 * choke point stays the choke point, this is just the block-shaped route to
 * it, so any surface can offer "change this setting" without the legacy
 * PUT route's bespoke client function.
 *
 * ADMIN-ONLY, exactly like `PUT /api/schema/ui/customizations/:id`: these
 * values are shared state for every account on this install, and the
 * consequence sentence says so in plain words. Weakening the gate here would
 * make the block door more permissive than the legacy door it mirrors.
 */

import { z } from "zod";

import {
  listCustomizations,
  registerAllExposure,
  getCustomization,
  DIAGNOSTIC_MODE_IDS,
  DEFAULT_PERFORMANCE_CONFIG,
  PERFORMANCE_CONFIG_SCHEMA,
} from "../kernel/canonical.ts";
import { setSchemaCustomization } from "../schema/ui-schema.ts";
import {
  performanceDiagnosticExcludedModes,
  modifyConfigRaw,
} from "../kernel/harness-config.ts";
import { requireAdminContext, requireUserContext } from "../auth/user-context.ts";
import { SettingValueRefusedError, ValidationError } from "../kernel/errors.ts";
import { isHiddenFromUserDisplay } from "../llm/redaction.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

/**
 * A JSON value, spelled out recursively. Deliberately NOT `z.unknown()`:
 * block inputs are deny-by-default (the permissive-schema guard bans any
 * `z.any`/`z.unknown` in an `input:`), and object-typed customizations only
 * ever hold plain JSON — anything else could not have come over the wire.
 */
const JsonValue: z.ZodType<JsonLike> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);
type JsonLike = string | number | boolean | null | JsonLike[] | { [k: string]: JsonLike };

const SetInput = z.strictObject({
  /** The customization id — the setting's registry identity. */
  id: z.string().min(1).max(256),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.record(z.string(), JsonValue),
  ]),
});

/**
 * SAVE consequence — derived from the live customization registry's
 * declared effect timings, not a hardcoded "immediately". A next-run
 * farm knob must not be described as applying at once. The sentence
 * names every timing that is actually declared so a new timing cannot
 * hide behind a generic immediate blurb.
 */
export function settingsSaveConsequence(): string {
  registerAllExposure();
  const timings = new Set<string>();
  for (const c of listCustomizations()) {
    const effect = c.contract?.effect;
    if (typeof effect === "string" && effect.length > 0 && effect !== "unspecified") {
      timings.add(effect);
    }
  }
  const words: string[] = [];
  if (timings.has("immediate")) words.push("immediately");
  if (timings.has("next-run")) words.push("on the next run");
  if (timings.has("restart")) words.push("after a restart");
  const when = words.length === 0
    ? "the setting's declared timing, which is not assumed"
    : words.length === 1
      ? words[0]!
      : `${words.slice(0, -1).join(", ")}, or ${words[words.length - 1]!}`;
  return (
    "Checks the declared bounds, then saves for everyone using this install. " +
    `Applies ${when}, as declared for each setting.`
  );
}

/** Register the settings block. */
export function defineSettingsBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "settings.customizations",
    title: "Setting values",
    description:
      "Change the stored value of a named setting. The new value is checked against the setting's declared bounds and choices before it is applied; a value outside them is refused unchanged.",
    actions: {
      set: {
        input: SetInput,
        title: "Save",
        consequence: settingsSaveConsequence(),
        invalidates: ["settings:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          await requireAdminContext(ctx, db);
          // Idempotent; the registry must exist before an id can resolve.
          registerAllExposure();
          setSchemaCustomization(input.id, input.value);
          // The answer carries the read-back: what NOW stands, and whether
          // the display egress hides it. The egress masks the answer's
          // `value` the same way it masks the values wire, so a surface that
          // paints this answer shows exactly what the server will serve back
          // — for a value the egress hides, that is the masked form, never
          // the raw the user typed (the raw has no business staying on
          // screen after the server hid it). The flag is derived from the
          // same walk, so answer and wire can never disagree.
          const standing = getCustomization(input.id)?.current();
          const masked = standing !== undefined && isHiddenFromUserDisplay(standing);
          return masked
            ? { id: input.id, saved: true, value: standing, masked: true }
            : { id: input.id, saved: true, value: standing };
        },
      },
    },
  });

  defineBlock(diagnosticModesBlock(db));
}

// ── The diagnostic-modes array door ────────────────────────────────────────

/**
 * The config leaf this block serves, declared once beside the block that
 * writes it. The settings room's served-row grammar holds scalars and JSON
 * objects (the sheet refuses array JSON by design), so an array-valued leaf
 * gets its own door here — a checkbox list over the fixed mode vocabulary —
 * exactly the way the tool-server list got its own door for the entity the
 * row grammar could not express. The census the exposure guard keeps reads
 * this declaration, so a leaf the block does not serve and does not file is
 * a red, never a silent gap.
 */
export const DIAGNOSTIC_MODES_CONFIG_PATH = "performance.diagnosticModes.excludedModes";

/**
 * The engine's own element schema for the leaf — the exact zod instance the
 * config document gate validates the same path with. The door refuses an
 * invalid list against THIS (never a restated enum), in the settings
 * family's guided-refusal words; the config gate then re-validates the whole
 * candidate document, which is where the cross-field rules (a mode named
 * twice) refuse with the section checker's own sentence.
 */
const EXCLUDED_MODES_LEAF = PERFORMANCE_CONFIG_SCHEMA.shape.diagnosticModes.shape.excludedModes;

/**
 * The value-domain check, in the sheet's own grammar. The block input carries
 * the transport shape (an array of strings); whether those strings are modes
 * is a VALUE question, so the refusal is the guided family's (428, the 200
 * envelope, the browser console stays quiet) — the same line the
 * customizations door draws between a body it cannot parse (400) and a value
 * the contract declines (the envelope).
 */
function refuseInvalidExcludedModes(raw: readonly string[]): readonly string[] {
  const parsed = EXCLUDED_MODES_LEAF.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  let sentence: string;
  if (issue?.code === "invalid_value") {
    // Issues do not carry the input value by default (zod's own value-leak
    // policy); the offending INDEX does arrive, and the raw list is in hand.
    const at = issue.path[0];
    const offending = typeof at === "number" ? raw[at] : undefined;
    sentence =
      `"${offending ?? "one of the entries"}" is not one of the declared diagnostic modes — ` +
      DIAGNOSTIC_MODE_IDS.join(", ");
  } else if (issue?.code === "too_big" && issue.path.length === 0) {
    sentence =
      `the list holds ${raw.length} modes — each of the ${DIAGNOSTIC_MODE_IDS.length} declared modes ` +
      "may be excluded at most once";
  } else {
    sentence = issue?.message ?? "the excluded-modes list is not valid";
  }
  throw new SettingValueRefusedError(sentence, "invalid_customization_value");
}

/** A plain mutable object check (arrays are not section objects). */
function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Land the list through the ONE config write gate. The candidate document is
 * built from the file's own current state (never a cached projection), the
 * key is ASSIGNED — `excludedModes` is a required key inside its section, the
 * same fallback the customization write path documents for required keys —
 * and a section the file does not carry yet is materialized from the
 * performance contract's declared defaults, so the door works on a fresh
 * install too.
 */
function writeDiagnosticModesExcluded(excluded: readonly string[]): void {
  // The read, the composition and the gated write are ONE locked cycle, so
  // a parallel writer's change cannot land inside this door's window and
  // be composed away by the write.
  try {
    modifyConfigRaw((doc) => {
      const defaults = structuredClone(
        DEFAULT_PERFORMANCE_CONFIG,
      ) as unknown as Record<string, Record<string, unknown>>;
      const section = plainObject(doc["performance"]) ? { ...doc["performance"] } : defaults;
      const modes = plainObject(section["diagnosticModes"])
        ? { ...section["diagnosticModes"] }
        : defaults["diagnosticModes"]!;
      modes["excludedModes"] = [...excluded];
      section["diagnosticModes"] = modes;
      doc["performance"] = section;
      return doc;
    });
  } catch (err) {
    // The gate's schema refusal is a DESIGNED value refusal (the duplicate-mode
    // cross-field rule rides this door with its own sentence); a real I/O
    // failure is not a designed refusal and keeps its honest error.
    if (err instanceof ValidationError) {
      throw new SettingValueRefusedError(err.message, "invalid_customization_value");
    }
    throw err;
  }
}

/** The diagnostic-modes list block's declaration — the array-valued leaf's own
 * door. Returned as a declaration so the family's one register call owns the
 * registration (the id, the duplicate check and the route derivation happen
 * in exactly one place for both settings blocks). */
function diagnosticModesBlock(db: AsyncDbClient): Parameters<typeof defineBlock>[0] {
  return {
    id: "settings.diagnosticModes",
    title: "Diagnostic modes",
    description:
      "Choose which diagnostic modes run. Enabled modes are included; disabled modes are excluded. Save applies this choice to the next diagnostic run.",
    read: {
      // A config-file fact: no query params, no history to render as-of.
      input: z.object({}),
      output: z.strictObject({
        // The declared vocabulary, from the engine's own mode list.
        modes: z.array(z.enum(DIAGNOSTIC_MODE_IDS)),
        // What the file says right now — served as-is, including a value a
        // hand-edited file might hold that no declared mode matches.
        excluded: z.array(z.string()),
      }),
      handler: async (_input, { ctx }) => {
        // User-level, the values-read posture of the settings surfaces.
        await requireUserContext(ctx, db);
        return {
          modes: [...DIAGNOSTIC_MODE_IDS],
          excluded: [...performanceDiagnosticExcludedModes()],
        };
      },
    },
    actions: {
      set: {
        input: z.strictObject({
          // The transport shape only; membership in the mode vocabulary is a
          // VALUE question the handler refuses in the guided family's words.
          excludedModes: z.array(z.string()),
        }),
        title: "Save",
        consequence:
          "Saves which modes run on the next diagnostic run. Enabled modes are included; disabled modes are excluded.",
        invalidates: ["settings:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          await requireAdminContext(ctx, db);
          const excluded = refuseInvalidExcludedModes(input.excludedModes);
          writeDiagnosticModesExcluded(excluded);
          return { excludedModes: [...excluded] };
        },
      },
    },
  };
}
