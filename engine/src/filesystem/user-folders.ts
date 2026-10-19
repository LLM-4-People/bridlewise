/**
 * THE ONE RULE FOR A PER-USER BASE FOLDER (the XDG base directories): the
 * variable's value when it is an absolute folder, else its default under this
 * user's home (`~/…`). Every per-user folder the harness keeps outside a
 * checkout hangs from one of these — the private homes (`private-home.ts`:
 * the key home, the evidence store), the user cache folder (the instrument
 * lock, the test key homes, the V8 compile cache). Nothing is created here.
 */
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

import { ROOT_POLICY } from "../kernel/root-policy.ts";

/** How a configured path names a place under this user's home (`~/.ssh`). */
export const HOME_PREFIX = "~/";

/**
 * THE ONE EXPANSION OF `~/`: a configured `~/…` path is that place under this
 * user's home as the environment names it now; any other path is itself.
 * Every `~/` the harness reads (the keep-out floor and the operator's
 * entries, the per-user base folders) is expanded here.
 */
export function underUserHome(path: string): string {
  return path.startsWith(HOME_PREFIX) ? join(homedir(), path.slice(HOME_PREFIX.length)) : path;
}

/** The base folder `baseVariable` names now, else `defaultBase` (`~/…`) under this user's home. */
export function userBaseFolder(baseVariable: string, defaultBase: string): string {
  const base = process.env[baseVariable];
  return base !== undefined && isAbsolute(base) ? base : underUserHome(defaultBase);
}

/** This user's cache folder (`ROOT_POLICY.filesystemInfrastructure.userCacheHome`). */
export function userCacheFolder(): string {
  const { baseVariable, defaultBase } = ROOT_POLICY.filesystemInfrastructure.userCacheHome;
  return userBaseFolder(baseVariable, defaultBase);
}

/**
 * THE HOST USER'S cache folder: the default cache base under the home the
 * password database names for this user (`getpwuid`, `os.userInfo()`), never
 * `$HOME` or `$XDG_CACHE_HOME`. What must be ONE per host user — the
 * instrument lock — hangs from it, so a run under a substitute HOME (a test,
 * a reproduction's fresh world) still serializes with every other run.
 */
export function hostUserCacheFolder(): string {
  const { defaultBase } = ROOT_POLICY.filesystemInfrastructure.userCacheHome;
  return join(userInfo().homedir, defaultBase.slice(HOME_PREFIX.length));
}

/**
 * THE BOOT SETTINGS OF THE PER-USER FOLDERS — every environment variable that
 * decides where a private home or the user cache folder is: each private
 * home's override and its XDG base (the key home, the evidence store), and the
 * cache base. A launcher that starts a harness process with a projected
 * environment (the dev server's launch, `scripts/sd-stale-classifier.ts`)
 * forwards exactly these, from this ONE list: a relocated store must stay the
 * store the process keeps out (design M5).
 */
export const USER_FOLDER_BOOT_VARIABLES: readonly string[] = Object.freeze([...new Set([
  ...[ROOT_POLICY.selfProtection.keyHome, ROOT_POLICY.workflow.evidenceStore].flatMap((home) => [home.environmentVariable, home.baseVariable]),
  ROOT_POLICY.filesystemInfrastructure.userCacheHome.baseVariable,
])]);
