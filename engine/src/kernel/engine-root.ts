/**
 * THE ENGINE'S OWN ROOT — the one derivation of where this checkout of the
 * engine is: the directory above the root-policy owner's declared location
 * (`ROOT_POLICY.sourcePath`), found from this module's own place. Everything
 * that must know "the harness checkout" asks here: the config document's
 * location (`kernel/config.ts`) and the key home's admission
 * (`filesystem/self-protection/key-home.ts`: keys live outside it). A fold of
 * either owner into another folder changes nothing.
 */
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SecurityError } from "./errors.ts";
import { ROOT_POLICY } from "./root-policy.ts";

/**
 * The root above the root-policy owner's directory, walking up from
 * `modulePath` (a module inside it). Refuses a policy source path outside the
 * source tree or a module that is not below the owner's directory.
 */
function pinnedRepositoryRoot(modulePath: string): string {
  const segments = ROOT_POLICY.sourcePath.split("/");
  if (segments[0] !== "src" || segments.length < 2 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new SecurityError("Root policy source path is outside the source tree", "project_root_invalid");
  }
  const policyOwnerDirectory = join(...segments.slice(0, -1));
  let root = dirname(modulePath);
  while (true) {
    if (root.endsWith(sep + policyOwnerDirectory)) {
      return root.slice(0, root.length - policyOwnerDirectory.length - 1);
    }
    const parent = dirname(root);
    if (parent === root) {
      throw new SecurityError("Root policy owner directory is not an ancestor of the config owner", "project_root_invalid");
    }
    root = parent;
  }
}

/** This engine checkout's root. */
export function engineRoot(): string {
  return pinnedRepositoryRoot(fileURLToPath(import.meta.url));
}
