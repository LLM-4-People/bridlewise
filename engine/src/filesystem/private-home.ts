/**
 * THE ONE OWNER OF A PER-USER PRIVATE HOME — a folder outside every checkout
 * that holds what no other user, no confined process and no checkout may
 * reach: the key home (`self-protection/key-home.ts`) and the evidence store
 * (`workflow/evidence-store.ts`). Both used to spell the same algorithm step
 * for step; it lives here once, and each home is a {@link PrivateHome}
 * (its policy block plus the words its refusals use).
 *
 * WHERE (the boot tier, read once per question, never stored): the
 * operator's override — `<policy>.environmentVariable`, an absolute folder —
 * else `$<baseVariable>/<relative>`, else `<defaultBase>/<relative>` under
 * this user's home. {@link privateHomeSetting} says which of the two named it
 * (the `source` the read-only settings signal shows). A process UNDER TEST
 * never USES the user's own home ({@link privateHomeLocation} refuses
 * `<code>_unset_under_test`): the repository's runners give every run its
 * own.
 *
 * ADMISSION ({@link admitPrivateHome}): created at the private-state mode
 * when absent; the location ITSELF never a link (a link planted where the
 * home is expected would move its contents to the link's target); a real
 * folder, owned by this user, closed to group and other; sharing nothing,
 * by identity and in either direction, with each neighbour the caller names.
 * A home that fails is refused, never repaired: permissions someone widened
 * are a question for them.
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { SecurityError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { protectedCheckoutsOfThisProcess } from "./checkout-write-door.ts";
import { identityOverlapIndex, resolveLocation, type ResolvedAbsolutePath } from "./path-identity.ts";
import { PRIVATE_STATE_DIRECTORY_MODE } from "./private-state.ts";
import { userBaseFolder } from "./user-folders.ts";

/** Where a private home is: the policy block every home declares in ROOT_POLICY. */
export type PrivateHomePolicy = Readonly<{
  /** The operator's override (an absolute folder). */
  environmentVariable: string;
  /** The XDG base the default hangs from, and that base's default under this user's home (`~/…`). */
  baseVariable: string;
  defaultBase: string;
  /** The home below the base (`/`-separated). */
  relative: string;
}>;

/** One private home: its policy, what a refusal calls it, and the prefix of its refusal codes. */
export type PrivateHome = Readonly<{ policy: PrivateHomePolicy; what: string; code: string }>;

/** Where a home is now, and what named it. */
export type PrivateHomeSetting = Readonly<{ location: string; source: "environment" | "default"; variable: string }>;

/** THE KEY HOME: every harness key, the store registry and the binding records (self-protection/key-home.ts). */
export const KEY_HOME: PrivateHome = Object.freeze({ policy: ROOT_POLICY.selfProtection.keyHome, what: "key home", code: "key_home" });

/** THE EVIDENCE STORE: raw evidence kept out of git, by content (workflow/evidence-store.ts). */
export const EVIDENCE_HOME: PrivateHome = Object.freeze({ policy: ROOT_POLICY.workflow.evidenceStore, what: "evidence store", code: "evidence_store" });

/** A place a home must share nothing with, and what to call it in a refusal. */
export type PrivateHomeNeighbour = Readonly<{ path: string; what: string }>;


function refuse(message: string, code: string): never {
  throw new SecurityError(message, code);
}

/**
 * THE BOOT READ of where `home` is, from the environment as it is now
 * (nothing is created; a relative override is refused). Never refuses for a
 * process under test: the keep-out list asks where the home is in every
 * process, and the user's own home stays kept out there too.
 */
export function privateHomeSetting(home: PrivateHome): PrivateHomeSetting {
  const { policy } = home;
  const override = process.env[policy.environmentVariable];
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) refuse(`${policy.environmentVariable} must be an absolute folder, not ${JSON.stringify(override)}`, `${home.code}_not_absolute`);
    return Object.freeze({ location: resolve(override), source: "environment", variable: policy.environmentVariable });
  }
  const root = userBaseFolder(policy.baseVariable, policy.defaultBase);
  return Object.freeze({ location: join(root, ...policy.relative.split("/")), source: "default", variable: policy.environmentVariable });
}

/**
 * Where `home` is for a process about to USE it. A process the checkout
 * write door finds under test with no override is REFUSED
 * (`<code>_unset_under_test`): it would otherwise write into the user's own
 * home. Detection only ever refuses here; it never chooses a folder.
 */
export function privateHomeLocation(home: PrivateHome): string {
  const setting = privateHomeSetting(home);
  if (setting.source === "default" && protectedCheckoutsOfThisProcess().length > 0) {
    refuse(
      `This process runs under a test runner and ${setting.variable} is not set, so it would use your own ${home.what}. Run tests through the repository's runners, or set ${setting.variable} to a private folder.`,
      `${home.code}_unset_under_test`,
    );
  }
  return setting.location;
}

/**
 * ADMIT `home` at `location`: created private when absent, then required to
 * be a real folder of this user, closed to group and other, and disjoint by
 * identity from every neighbour. Returns the resolved location.
 */
export function admitPrivateHome(home: PrivateHome, location: string, neighbours: readonly PrivateHomeNeighbour[]): ResolvedAbsolutePath {
  const variable = home.policy.environmentVariable;
  // The location ITSELF is never a link (asked before resolving, which would follow it).
  if (lstatSync(resolve(location), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    refuse(`The ${home.what} ${location} is a link; it is kept only in a real folder (point ${variable} at the folder itself).`, `${home.code}_unsafe`);
  }
  const resolved = resolveLocation(location, `the ${home.what}`);
  // Created here: exactly the private mode whatever the umask (a umask can only remove bits).
  if (mkdirSync(resolved, { recursive: true, mode: PRIVATE_STATE_DIRECTORY_MODE }) !== undefined) chmodSync(resolved, PRIVATE_STATE_DIRECTORY_MODE);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) refuse(`The ${home.what} ${resolved} is not a folder (a link or a file), so nothing is kept there.`, `${home.code}_unsafe`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) refuse(`The ${home.what} ${resolved} belongs to another user, so nothing is kept there.`, `${home.code}_unsafe`);
  if ((stat.mode & 0o077) !== 0) {
    refuse(`The ${home.what} ${resolved} can be read by other users (mode ${(stat.mode & 0o777).toString(8)}); run \`chmod 700 ${resolved}\` and start again.`, `${home.code}_unsafe`);
  }
  const identity = identityOverlapIndex();
  for (const neighbour of neighbours) {
    const place = resolveLocation(neighbour.path, neighbour.what);
    if (identity.overlaps(resolved, place)) {
      refuse(
        `The ${home.what} ${resolved} overlaps ${neighbour.what} (${place}); it must live outside every checkout, database folder, project and the system temp folder. Set ${variable} to a private folder elsewhere.`,
        `${home.code}_not_disjoint`,
      );
    }
  }
  return resolved;
}
