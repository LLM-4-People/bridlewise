/**
 * Canonical path-extension helper.
 *
 * ONE source of truth for file-extension extraction, previously duplicated
 * across:
 * - `quality-packs/typescript-pack.ts`
 * - `quality-packs/cli.ts`
 * - `workflow/module-registrar.ts`
 *
 * The canonical version lowercases the result (two of the three previous
 * copies already did; the `module-registrar.ts` copy was inconsistent).
 */

/**
 * Return the lowercase file extension including the dot (e.g. `".ts"`).
 * Returns `""` when there is no extension or the dot is at index 0 (hidden
 * file like `.bashrc`).
 */
export function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === 0) return "";
  return filePath.slice(lastDot).toLowerCase();
}

export function extractExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === 0) return "";
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash > lastDot) return "";
  return filePath.slice(lastDot).toLowerCase();
}
