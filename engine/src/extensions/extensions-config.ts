/** Extension operational defaults — canonical owner for extension-manifest
 * validation limits.
 *
 * The manifest-validation caps (`MAX_ID_LENGTH`,
 * `MAX_DESCRIPTION_LENGTH`, `MAX_CAPABILITIES`, `MAX_DEPENDENCIES`,
 * `MAX_CAPABILITY_LENGTH`) were inline named consts in
 * `extension-manifest.ts` with no owner — scattered configurables. This
 * module is the single owner, mirroring the `agents-config.ts` /
 * `workflow-config.ts` / `git-config.ts` pattern. The manifest module
 * imports + derives from here (no parallel literals). */
export const DEFAULT_MAX_EXTENSION_ID_LENGTH = 128;
export const DEFAULT_MAX_EXTENSION_DESCRIPTION_LENGTH = 4_096;
export const DEFAULT_MAX_EXTENSION_CAPABILITIES = 32;
export const DEFAULT_MAX_EXTENSION_DEPENDENCIES = 64;
export const DEFAULT_MAX_EXTENSION_CAPABILITY_LENGTH = 64;
