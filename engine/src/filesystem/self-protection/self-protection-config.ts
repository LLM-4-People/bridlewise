import { isAbsolute } from "node:path";

import { z } from "zod";

import { canonicalHash, deepFreeze, type DeepReadonly } from "../../kernel/integrity.ts";
import {
  LANDLOCK_ACCESS_FS_FLAG_NAMES,
  type LandlockAccessFsFlagName,
} from "./self-protection-contracts.ts";
import { schemaId } from "../../kernel/product-identity.ts";

/**
 * Operator-facing self-protection configuration. This is the ONLY surface an
 * operator may configure; the non-overridable floor (minimum protected
 * subtrees, minimum allow-set, handled flags, block read/write, binary path +
 * sha256, bundle path) lives in `ROOT_POLICY.selfProtection` and is NOT part
 * of this schema. The operator can only ADD to the floor (additional rules,
 * additional protected subtrees, additional handled flags) or opt in
 * (`enabled: true`) for production mode.
 *
 * This module mirrors `performance/performance-config.ts`: it owns the typed
 * schema fragment, which `src/kernel/config-contracts.ts` composes into the single
 * validated `getConfigDocumentSchema()`. It deliberately does NOT import
 * `root-policy.ts` (the floor is consumed by the compiler in
 * `guardian-binary.ts`, not by the config schema).
 */

export const SELF_PROTECTION_CONFIG_SCHEMA_VERSION =
  schemaId("self-protection-config", 1);

const flagNameEnum = z.enum(LANDLOCK_ACCESS_FS_FLAG_NAMES);

/** An absolute path as every self-protection record spells it (config, store registry). */
export const ABSOLUTE_PATH = z.string().min(1).max(4096).refine(
  (value) => isAbsolute(value),
  { message: "path must be absolute" },
);

/** A kept-out path: absolute, or under the harness user's home (`~/`). */
const KEEP_OUT_PATH = z.string().min(1).max(4096).refine(
  (value) => isAbsolute(value) || value.startsWith("~/"),
  { message: "path must be absolute or start with ~/" },
);

export const SELF_PROTECTION_CONFIG_SCHEMA = z.strictObject({
  schemaVersion: z.literal(SELF_PROTECTION_CONFIG_SCHEMA_VERSION),
  enabled: z.boolean(),
  tempDir: ABSOLUTE_PATH.optional(),
  additionalAllowRules: z.array(
    z.strictObject({
      path: ABSOLUTE_PATH,
      access: z.array(flagNameEnum).min(1).max(16),
    }),
  ).max(128).optional(),
  /**
   * The operator's additions to the ONE keep-out list
   * (`self-protection/keep-out.ts`): places no confined process may be
   * granted and no project may reach, ADDED to the unremovable floor
   * (tighten-only: an empty list removes nothing). Absolute, or `~/` for the
   * harness user's home. Every overlap — with an allow-rule, the temp folder,
   * a project — is decided by the compiler and the doors by identity.
   */
  additionalProtectedSubtrees: z.array(KEEP_OUT_PATH).max(96).optional(),
  additionalHandledAccessFs: z.array(flagNameEnum).max(16).optional(),
});

export type SelfProtectionConfig = DeepReadonly<z.infer<typeof SELF_PROTECTION_CONFIG_SCHEMA>>;

/**
 * THE MEANING OF AN ABSENT `selfProtection` SECTION: CONFINED. One owner for
 * the whole harness — the engine CLI's bootstrap, the dev-mode detector and
 * the web server's confinement status all resolve through
 * {@link resolveSelfProtectionConfig}, so they cannot disagree (they did: the
 * engine read absence as dev mode while the server confined).
 *
 * Absence is not a decision. A fresh install, a trimmed config or a section
 * lost in a merge must not silently remove the sandbox, so turning
 * confinement off is something an operator has to write down
 * (`"enabled": false`); leaving the section out cannot produce an unconfined
 * machine.
 */
export const DEFAULT_SELF_PROTECTION_CONFIG: SelfProtectionConfig = deepFreeze({
  schemaVersion: SELF_PROTECTION_CONFIG_SCHEMA_VERSION,
  enabled: true,
});

export function parseSelfProtectionConfig(value: unknown): SelfProtectionConfig {
  return deepFreeze(SELF_PROTECTION_CONFIG_SCHEMA.parse(value));
}

/**
 * Resolve the runtime self-protection config from a config document: read
 * `document.selfProtection` and fall back to {@link DEFAULT_SELF_PROTECTION_CONFIG}
 * (CONFINED) when absent. The argument is typed structurally so this module does not
 * import the full `ConfigDocument` (which would create a cycle with
 * `config-contracts.ts`).
 */
export function resolveSelfProtectionConfig(
  document: Readonly<{ readonly selfProtection?: unknown }>,
): SelfProtectionConfig {
  if (document.selfProtection === undefined) return DEFAULT_SELF_PROTECTION_CONFIG;
  return parseSelfProtectionConfig(document.selfProtection);
}

/**
 * Cross-field invariants Zod cannot express without filesystem access or the
 * root-policy floor. These are config-internal checks (path absoluteness is
 * already enforced by the schema; this checks overlap relationships and flag
 * uniqueness). The floor-subset check (additionalHandledAccessFs must be a
 * subset of the floor handled flags) is enforced by
 * `compileSelfProtectionConfigToSpec` in `guardian-binary.ts`, which has
 * access to `ROOT_POLICY`.
 */
export function selfProtectionConfigViolations(
  config: SelfProtectionConfig,
): readonly string[] {
  const violations: string[] = [];
  if (!config.enabled) return violations;
  if (config.additionalAllowRules !== undefined) {
    const seenPaths = new Set<string>();
    for (const rule of config.additionalAllowRules) {
      if (seenPaths.has(rule.path)) {
        violations.push(`self_protection_duplicate_allow_rule_path:${rule.path}`);
      }
      seenPaths.add(rule.path);
      const accessSeen = new Set<LandlockAccessFsFlagName>();
      for (const flag of rule.access) {
        if (accessSeen.has(flag)) {
          violations.push(`self_protection_duplicate_allow_rule_access:${rule.path}:${flag}`);
        }
        accessSeen.add(flag);
      }
    }
  }
  if (config.additionalProtectedSubtrees !== undefined) {
    const seen = new Set<string>();
    for (const subtree of config.additionalProtectedSubtrees) {
      if (seen.has(subtree)) {
        violations.push(`self_protection_duplicate_protected_subtree:${subtree}`);
      }
      seen.add(subtree);
    }
  }
  if (config.additionalHandledAccessFs !== undefined) {
    const seen = new Set<LandlockAccessFsFlagName>();
    for (const flag of config.additionalHandledAccessFs) {
      if (seen.has(flag)) {
        violations.push(`self_protection_duplicate_handled_access_fs:${flag}`);
      }
      seen.add(flag);
    }
  }
  return violations;
}

export const SELF_PROTECTION_CONFIG_SCHEMA_HASH = canonicalHash(
  z.toJSONSchema(SELF_PROTECTION_CONFIG_SCHEMA, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    cycles: "ref",
    reused: "inline",
  }),
);
