/**
 * THE PROMOTION PROFILE — one declaration per pair (a source ref carried to a
 * target ref): the boundary of what ships, the derived files, the phases a
 * promotion runs and its safety budget. A data file on the SOURCE branch
 * (`<promotion.profileDirectory>/<name>.json`), always read from a source
 * commit (or, for the source-side guard, from the source's working tree) and
 * validated here before anything else reads it: strict, versioned, every value
 * stated (no field has a default), every command named from the ONE command
 * registry (`workspaceIsolation.commands`).
 *
 * Generic by construction: no branch name, path or command is spelled in
 * code — a second pair is a second file (merge-door-final §5, §15).
 */
import { z } from "zod";

import { deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { REPOSITORY_RELATIVE_PATH_SCHEMA, WORKSPACE_COMMAND_NAME_SCHEMA } from "../../kernel/config-contracts.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../kernel/json-integrity.ts";
import { gitAcceptsRefName } from "../../git/repository-ownership.ts";
import type { TreeReader } from "../../git/tree-reader.ts";
import { PromotionError } from "./codes.ts";

const PROMOTION_PROFILE_SCHEMA_VERSION = schemaId("promotion-profile", 1);

const refName = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u);
/**
 * A repository-relative file, or a folder PREFIX: the same path with a
 * trailing `/` (it names everything under the folder). Never the top itself
 * (`.`, `./`, `/`): no tree path starts with it, so it would name nothing.
 */
const pathOrPrefix = z.string().refine((value) => {
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  return path !== "" && path !== "." && REPOSITORY_RELATIVE_PATH_SCHEMA.safeParse(path).success;
}, "must be a repository-relative path, or a folder prefix ending in /");

const promotionProfileShape = z.strictObject({
  schema: z.literal(PROMOTION_PROFILE_SCHEMA_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  source: z.strictObject({ ref: refName }),
  target: z.strictObject({ ref: refName }),
  /** The remote both refs are published to; `null`: a local-only pair. */
  remote: z.string().regex(/^[A-Za-z0-9._-]+$/u).nullable(),
  trigger: z.enum(["manual", "on-source-publish"]),
  boundary: z.strictObject({
    /** The modules the shipped program is reached through; the closure walks from them. */
    entryPoints: z.array(REPOSITORY_RELATIVE_PATH_SCHEMA).min(1).max(256),
    /** Paths (a trailing `/`: a prefix) projected without an import edge. */
    include: z.array(pathOrPrefix).max(512),
    /** Paths never projected and never walked; an import into one is a refusal. */
    exclude: z.array(pathOrPrefix).max(512),
    /** Basenames projected iff their folder, or a sub-folder, holds a projected path. */
    companions: z.array(z.string().regex(/^[^/]+$/u)).max(8),
    /** Calls whose string literal at `argument` spawns a script under `base` (a runtime edge). */
    spawnCalls: z.array(z.strictObject({
      callee: z.string().regex(/^[A-Za-z_$][\w$]*$/u),
      argument: z.number().int().min(0).max(8),
      /** The folder the literal is relative to: the repository top (`""`) or a folder prefix (`a/b/`). */
      base: z.string().refine((value) => value === "" || (value.endsWith("/") && pathOrPrefix.safeParse(value).success), "must be \"\" or a repository folder prefix ending in /"),
    })).max(8),
  }),
  transforms: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("package-manifest"), path: REPOSITORY_RELATIVE_PATH_SCHEMA, scripts: z.array(z.string().min(1)).max(128) }),
    z.strictObject({ kind: z.literal("lockfile"), path: REPOSITORY_RELATIVE_PATH_SCHEMA, manifest: REPOSITORY_RELATIVE_PATH_SCHEMA, command: WORKSPACE_COMMAND_NAME_SCHEMA }),
  ])).max(32),
  phases: z.strictObject({
    setup: z.array(WORKSPACE_COMMAND_NAME_SCHEMA).max(32),
    converge: z.array(WORKSPACE_COMMAND_NAME_SCHEMA).max(8),
    verify: z.array(WORKSPACE_COMMAND_NAME_SCHEMA).min(1).max(32),
  }),
  safety: z.strictObject({ maxDeletedFraction: z.number().gt(0).lte(1) }),
});

export type PromotionProfile = z.infer<typeof promotionProfileShape>;
export type PromotionTransform = PromotionProfile["transforms"][number];

/** A profile as found: its validated content, where it was read and the blob it was read from (`null` from a working tree). */
export type LoadedPromotionProfile = Readonly<{ profile: PromotionProfile; path: string; blob: string | null }>;

/** The branch name a profile's ref names (`refs/heads/<branch>` → `<branch>`; the schema admits only branch refs). */
export function branchOf(ref: string): string {
  return ref.slice("refs/heads/".length);
}

/** Whether `path` is named by `entry` (a trailing `/`: the prefix; otherwise the exact path). */
export function pathMatchesEntry(path: string, entry: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/** The exclude entry that names `path`, or `null`. */
export function excludedBy(profile: PromotionProfile, path: string): string | null {
  return profile.boundary.exclude.find((entry) => pathMatchesEntry(path, entry)) ?? null;
}

/** Every registry command `profile` runs (its phases and its transforms): the consumers the dead-command check must see. */
export function profileCommandNames(profile: PromotionProfile): readonly string[] {
  return deepFreeze([
    ...profile.phases.setup, ...profile.phases.converge, ...profile.phases.verify,
    ...profile.transforms.flatMap((transform) => transform.kind === "lockfile" ? [transform.command] : []),
  ]);
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => (seen.has(value) ? true : (seen.add(value), false))))];
}

/** Every rule a well-formed profile still breaks: `[pointer, message]` pairs (see `parsePromotionProfile`). */
function profileViolations(
  profile: PromotionProfile,
  context: Readonly<{ basename: string; profileDirectory: string; commandNames: ReadonlySet<string> }>,
): readonly (readonly [string, string])[] {
  const violations: (readonly [string, string])[] = [];
  if (profile.name !== context.basename) violations.push(["/name", `the name ${profile.name} must equal the file's basename ${context.basename}`]);
  if (profile.source.ref === profile.target.ref) violations.push(["/target/ref", "the source and the target are the same ref"]);
  const directoryPrefix = context.profileDirectory.endsWith("/") ? context.profileDirectory : `${context.profileDirectory}/`;
  if (excludedBy(profile, `${directoryPrefix}${profile.name}.json`) === null) {
    violations.push(["/boundary/exclude", `the profile directory ${directoryPrefix} must be excluded by the profile's own boundary (a profile never ships)`]);
  }
  profile.transforms.forEach((transform, index) => {
    const by = excludedBy(profile, transform.path);
    if (by !== null) violations.push([`/transforms/${String(index)}/path`, `${transform.path} is derived and also excluded (by ${by}): a derived file ships, so it cannot be excluded`]);
  });
  for (const [list, values] of [["entryPoints", profile.boundary.entryPoints], ["include", profile.boundary.include]] as const) {
    values.forEach((value, index) => {
      const by = excludedBy(profile, value.endsWith("/") ? `${value}x` : value);
      if (by !== null) violations.push([`/boundary/${list}/${String(index)}`, `${value} is also excluded (by ${by})`]);
    });
  }
  for (const [list, values] of [["include", profile.boundary.include], ["exclude", profile.boundary.exclude], ["entryPoints", profile.boundary.entryPoints]] as const) {
    for (const duplicate of duplicates(values)) violations.push([`/boundary/${list}`, `${duplicate} is listed twice`]);
  }
  for (const duplicate of duplicates(profile.transforms.map((transform) => transform.path))) violations.push(["/transforms", `two transforms derive ${duplicate}`]);
  const manifests = new Set(profile.transforms.filter((transform) => transform.kind === "package-manifest").map((transform) => transform.path));
  profile.transforms.forEach((transform, index) => {
    if (transform.kind === "lockfile" && !manifests.has(transform.manifest)) {
      violations.push([`/transforms/${String(index)}/manifest`, `${transform.manifest} is not the path of a package-manifest transform`]);
    }
    if (transform.kind === "lockfile" && !context.commandNames.has(transform.command)) {
      violations.push([`/transforms/${String(index)}/command`, `${transform.command} is not a command of the registry (workspaceIsolation.commands)`]);
    }
  });
  for (const phase of ["setup", "converge", "verify"] as const) {
    profile.phases[phase].forEach((name, index) => {
      if (!context.commandNames.has(name)) violations.push([`/phases/${phase}/${String(index)}`, `${name} is not a command of the registry (workspaceIsolation.commands)`]);
    });
  }
  return violations;
}

/**
 * Parses and validates one profile's text, or refuses
 * (`promotion_profile_invalid`, with the JSON pointer of each violation):
 * unknown or missing keys, a value of the wrong shape, a duplicated key, a
 * name that is not the file's basename, the same ref twice, a ref git refuses,
 * a profile directory the boundary does not exclude, a path both excluded and
 * included (or derived), a duplicate, two transforms of one path, a lockfile
 * whose manifest no transform derives, and a command the registry does not
 * declare.
 */
export function parsePromotionProfile(
  text: string,
  context: Readonly<{ path: string; profileDirectory: string; commandNames: ReadonlySet<string> }>,
): PromotionProfile {
  const refuse = (pointers: readonly (readonly [string, string])[]): PromotionError => new PromotionError(
    "promotion_profile_invalid",
    `promotion profile ${context.path} is invalid: ${pointers.map(([pointer, message]) => `${pointer === "" ? "/" : pointer}: ${message}`).join("; ")}`,
    { path: context.path, violations: pointers.map(([pointer, message]) => ({ pointer: pointer === "" ? "/" : pointer, message })) },
  );
  let parsed: unknown;
  try {
    assertNoDuplicateJsonObjectKeys(text, `promotion profile ${context.path} repeats a key`, "promotion_profile_invalid");
    parsed = JSON.parse(text);
  } catch (error) {
    throw refuse([["", error instanceof Error ? error.message : String(error)]]);
  }
  const result = promotionProfileShape.safeParse(parsed);
  if (!result.success) throw refuse(result.error.issues.map((issue) => [`/${issue.path.map(String).join("/")}`, issue.message] as const));
  const basename = context.path.slice(context.path.lastIndexOf("/") + 1).replace(/\.json$/u, "");
  const violations = [
    ...profileViolations(result.data, { basename, profileDirectory: context.profileDirectory, commandNames: context.commandNames }),
    ...(["source", "target"] as const).filter((side) => !gitAcceptsRefName(result.data[side].ref)).map((side) => [`/${side}/ref`, `git refuses the ref name ${result.data[side].ref}`] as const),
  ];
  if (violations.length > 0) throw refuse(violations);
  return deepFreeze(result.data);
}

/** Every profile `reader` holds: each `<profileDirectory>/<name>.json`, parsed and validated (see {@link parsePromotionProfile}). */
export function loadPromotionProfiles(
  reader: TreeReader,
  profileDirectory: string,
  commandNames: ReadonlySet<string>,
): readonly LoadedPromotionProfile[] {
  const prefix = profileDirectory.endsWith("/") ? profileDirectory : `${profileDirectory}/`;
  const files = reader.paths().filter((path) => path.startsWith(prefix) && path.endsWith(".json") && !path.slice(prefix.length).includes("/"));
  reader.prefetch(files);
  return deepFreeze(files.map((path) => deepFreeze({
    profile: parsePromotionProfile(reader.text(path)!, { path, profileDirectory, commandNames }),
    path,
    blob: reader.entry(path)!.oid,
  })));
}

/** The profile named `name` among `loaded`; with no name, the only one. Refuses (`promotion_profile_missing`) otherwise. */
export function selectPromotionProfile(loaded: readonly LoadedPromotionProfile[], name: string | undefined, where: string): LoadedPromotionProfile {
  const found = name === undefined ? (loaded.length === 1 ? loaded[0] : undefined) : loaded.find((entry) => entry.profile.name === name);
  if (found === undefined) {
    const names = loaded.map((entry) => entry.profile.name);
    throw new PromotionError(
      "promotion_profile_missing",
      name === undefined
        ? `${where} holds ${String(loaded.length)} promotion profiles (${names.join(", ") || "none"}): name one with --profile`
        : `${where} holds no promotion profile named ${name} (found: ${names.join(", ") || "none"})`,
      { where, names },
    );
  }
  return found;
}
