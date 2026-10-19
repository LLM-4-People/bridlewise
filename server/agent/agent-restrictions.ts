/**
 * Per-delegation restriction sets — the SINGLE owner of "the main thread may
 * hand a sub-agent a NARROWER authority than its own".
 *
 * A delegation may carry an optional `restrictions` argument:
 *   - `preset`: a named vocabulary (`"read-only"` or `"research-only"`), or
 *   - `capabilities`: an explicit capability list (a subset of the harness's
 *     `AGENT_CAPABILITY_CATALOG`), and/or
 *   - `writeSet`: the paths the sub-agent's write tools may touch.
 *
 * NARROWING-ONLY, and it is enforced structurally rather than by review:
 * the sub-agent's effective capability set is the INTERSECTION of the
 * profile's configured capabilities and the requested ones — the requested
 * set can remove authority, never add it (an agent whose profile says
 * read-only cannot be handed `write` by the delegating call). The effective
 * write set is likewise INTERSECTED against the profile's configured write
 * set when the profile declares one. The parent's own confinement (the
 * Landlock guardian on spawned commands, the fs-gate on file tools) applies
 * underneath regardless — restrictions never widen the process boundary.
 *
 * The presets are DERIVED, not tool-name lists: they keep or drop tools by
 * the capabilities each tool DECLARES in the unified manifest, so a tool
 * added tomorrow is classified by what it says it does rather than by a list
 * someone remembered to update. The capability vocabulary presets can name
 * is BOUNDED by the agent-profile catalog (`AGENT_CAPABILITY_CATALOG`:
 * read/write/execute/delegate) — the harness tool manifest's `network`
 * capability is not delegable, so the research preset keeps the read-only
 * project tools plus the delegation surface itself, and a delegation that
 * needs the network names no preset (or a profile whose own tools include
 * it) instead of silently dropping the network the word "research" implied.
 */

import { AGENT_CAPABILITY_CATALOG, createPathLocator, isPathInWriteSet, resolveLocation } from "../kernel/canonical.ts";
import type { AgentCapability, AgentProfile } from "../kernel/canonical.ts";
import { resolveWithinProject } from "../filesystem/fs-gate.ts";
import { ValidationError } from "../kernel/errors.ts";

// ── The restriction vocabulary ──

/**
 * The named presets. The array owns the vocabulary; the manifest schema's
 * enum derives from it so a preset added here is offered to the model with
 * no second edit.
 */
export const DELEGATION_RESTRICTION_PRESETS = ["read-only", "research-only"] as const;
export type DelegationRestrictionPreset = typeof DELEGATION_RESTRICTION_PRESETS[number];

/** The maximum number of paths a delegation's write set may name. */
export const DELEGATION_WRITE_SET_MAX_ENTRIES = 32;

/**
 * The network-research tools, by CAPABILITY: tools whose manifest entry
 * declares the `network` capability are the research surface. The preset's
 * capability list below is what narrows the profile; this adapter-side
 * marker is what lets the registry builder find them without a name list.
 */
export type DelegationRestrictions = Readonly<{
  preset?: DelegationRestrictionPreset;
  capabilities?: readonly AgentCapability[];
  writeSet?: readonly string[];
}>;

/**
 * The resolved restriction: what a delegation is actually allowed after the
 * narrowing ran. `capabilities` is the effective (intersected) set;
 * `writeSet` is the effective (intersected) path list, where an empty list
 * means "may not write anywhere" and `null` means "no restriction applied"
 * (the profile's own write set governs).
 */
export type ResolvedDelegationRestriction = Readonly<{
  capabilities: readonly AgentCapability[];
  writeSet: readonly string[] | null;
}>;

const isAgentCapability = (value: unknown): value is AgentCapability =>
  typeof value === "string" && (AGENT_CAPABILITY_CATALOG as readonly string[]).includes(value);

/**
 * The capabilities a preset keeps. Declared per preset, expressed in the
 * harness's capability vocabulary — never as tool names.
 */
function presetCapabilities(preset: DelegationRestrictionPreset): readonly AgentCapability[] {
  switch (preset) {
    case "read-only":
      return ["read"];
    case "research-only":
      // Research: read the project, write nowhere, execute nothing, and no
      // further delegation. `delegate` is KEPT OFF so a research sub-agent
      // cannot spawn its own agents around the restriction. The harness's
      // tool manifest gates `network` as a separate capability the agent
      // profile vocabulary cannot express — so "research" here means the
      // project-facing read tools (map/symbols/search/slice), and the
      // network tools stay out because the parent registry only hands the
      // sub-agent what this capability list intersects.
      return ["read"];
  }
}

/**
 * Parse the raw (LLM-supplied, untrusted) `restrictions` argument into a
 * typed value. Unknown presets, non-string capabilities, non-array shapes
 * and out-of-catalog capabilities are typed validation failures — unknown
 * input is an error, never a silent default (deny-by-default).
 */
/** The names of `path` below `root`, found by identity, or undefined when it is not inside. */
function projectRelativeNames(path: string, root: string): string | undefined {
  const locator = createPathLocator();
  const names = locator.namesUnder(locator.locate(resolveLocation(path, "a write-set path")), locator.locate(resolveLocation(root, "the project root")));
  return names === undefined ? undefined : names.join("/");
}

export function parseDelegationRestrictions(raw: unknown): DelegationRestrictions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(
      "restrictions must be an object ({ preset, capabilities, writeSet })",
      "delegation_restrictions_invalid",
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: {
    preset?: DelegationRestrictionPreset;
    capabilities?: AgentCapability[];
    writeSet?: string[];
  } = {};

  if (obj.preset !== undefined) {
    if (typeof obj.preset !== "string" ||
        !(DELEGATION_RESTRICTION_PRESETS as readonly string[]).includes(obj.preset)) {
      throw new ValidationError(
        `restrictions.preset must be one of: ${DELEGATION_RESTRICTION_PRESETS.join(", ")}`,
        "delegation_restrictions_invalid",
      );
    }
    out.preset = obj.preset as DelegationRestrictionPreset;
  }
  if (obj.capabilities !== undefined) {
    if (!Array.isArray(obj.capabilities) || !obj.capabilities.every(isAgentCapability)) {
      throw new ValidationError(
        `restrictions.capabilities must be an array drawn from: ${AGENT_CAPABILITY_CATALOG.join(", ")}`,
        "delegation_restrictions_invalid",
      );
    }
    out.capabilities = [...obj.capabilities];
  }
  if (obj.writeSet !== undefined) {
    if (!Array.isArray(obj.writeSet) ||
        obj.writeSet.length > DELEGATION_WRITE_SET_MAX_ENTRIES ||
        !obj.writeSet.every((p) => typeof p === "string" && p.length > 0)) {
      throw new ValidationError(
        `restrictions.writeSet must be an array of at most ${DELEGATION_WRITE_SET_MAX_ENTRIES} non-empty path strings`,
        "delegation_restrictions_invalid",
      );
    }
    out.writeSet = [...obj.writeSet];
  }
  return Object.freeze(out);
}

/**
 * Resolve a delegation's restrictions against the profile being delegated
 * to. NARROWING-ONLY, enforced by construction:
 *
 *   effectiveCapabilities = profile.capabilities ∩ requested
 *
 * A requested capability the profile does not hold is silently ABSENT from
 * the intersection rather than granted — the delegating call can never hand
 * a sub-agent authority the profile does not have (and the profile's own
 * capabilities are themselves validated against the config schema).
 *
 * The write set: when the profile declares one, the requested paths are kept
 * only where they fall INSIDE the profile's write set (prefix match via the
 * engine's `isPathInWriteSet`); a requested path outside the profile's grant
 * is a typed refusal rather than a silent drop (the caller should learn the
 * narrowing failed). When the profile declares no write set, the requested
 * paths become the whole grant. Each requested path is resolved against the
 * project root — a path that escapes the project is a traversal refusal, not
 * a silently different write set.
 */
export function resolveDelegationRestrictions(
  profile: AgentProfile,
  restrictions: DelegationRestrictions | undefined,
  projectRoot: string,
): ResolvedDelegationRestriction {
  if (restrictions === undefined) {
    return Object.freeze({ capabilities: profile.capabilities, writeSet: null });
  }

  // The requested capability set: the preset's list, the explicit list, or —
  // when both are present — their union. Absent both, no capability narrowing.
  const requested: readonly AgentCapability[] | undefined =
    restrictions.preset !== undefined && restrictions.capabilities !== undefined
      ? [...new Set([...presetCapabilities(restrictions.preset), ...restrictions.capabilities])]
      : restrictions.preset !== undefined
        ? presetCapabilities(restrictions.preset)
        : restrictions.capabilities;

  const effectiveCapabilities: readonly AgentCapability[] = requested === undefined
    ? profile.capabilities
    : profile.capabilities.filter((c) => requested.includes(c));

  let effectiveWriteSet: readonly string[] | null = null;
  if (restrictions.writeSet !== undefined) {
    const resolvedPaths = restrictions.writeSet.map((p) => {
      // Resolve against the project root: a path that escapes is a typed
      // traversal refusal (PathTraversalError), not a rewritten grant.
      const resolved = resolveWithinProject(p, projectRoot);
      // Back to the project-relative form the write-set vocabulary uses
      // (the profile's writeSet entries are project-relative).
      // Its names below the project root, by identity (never a spelling prefix).
      return projectRelativeNames(resolved, projectRoot) ?? resolved;
    });
    // Narrowing-only, enforced for EVERY configured write set — including the
    // empty one. An empty `writeSet` is the profile's configured "writes
    // nowhere" (the engine's `isPathInWriteSet` returns false for every path
    // on it), so a requested path is OUTSIDE that grant the moment the grant
    // is empty — not merely when a non-empty grant fails to contain it. The
    // `isPathInWriteSet` prefix check already encodes exactly this (it returns
    // false on an empty set), so the refusal below covers both shapes with no
    // special case. Without it, a "writes-nowhere" profile handed a writeSet
    // would come out the other side holding paths it was never granted — a
    // widening wearing a restriction's clothes.
    const denied = resolvedPaths.filter((p) => !isPathInWriteSet(profile, p));
    if (denied.length > 0) {
      throw new ValidationError(
        `restrictions.writeSet may only narrow the agent's configured write set; these paths are outside agent '${profile.name}'s grant: ${denied.join(", ")}`,
        "delegation_write_set_widening",
      );
    }
    effectiveWriteSet = Object.freeze(resolvedPaths);
  }

  return Object.freeze({ capabilities: effectiveCapabilities, writeSet: effectiveWriteSet });
}

/**
 * The profile the sub-agent actually runs as: the configured profile with
 * the restriction applied. Tool names and capabilities are independent
 * ceilings: a capability-narrowed registry cannot widen a named-tool grant.
 * An orchestrator sharing a broader registry supplies the narrowed names so
 * the resulting profile carries that intersection into every request.
 */
export function restrictedProfile(
  profile: AgentProfile,
  resolved: ResolvedDelegationRestriction,
  availableTools?: readonly string[],
): AgentProfile {
  const names = profile.tools === "all" ? undefined : new Set(profile.tools);
  return Object.freeze({
    ...profile,
    capabilities: Object.freeze([...resolved.capabilities]),
    // A resolved restriction's write set overrides the profile's; absent a
    // restriction, the profile's own grant stands. An empty array means
    // "may write nowhere" and is a REAL answer, distinct from null/absent.
    writeSet: resolved.writeSet === null
      ? profile.writeSet
      : Object.freeze([...resolved.writeSet]),
    tools: availableTools === undefined ? profile.tools
      : Object.freeze(availableTools.filter(name => names === undefined || names.has(name))),
  });
}
