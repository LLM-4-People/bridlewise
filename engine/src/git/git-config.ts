/**
 * Git operational defaults — canonical owner for git-domain configurable
 * values. Deduplicates DEFAULT_MAXIMUM_ERROR_BYTES which was
 * previously declared in BOTH git-adapter.ts and worktree-port.ts (DRY
 * violation — the same 2 MiB value in two files).
 *
 * Also owns the worktree error-output CHARACTER cap + the
 * worktree output BYTES cap, which were inline in worktree-port.ts
 * (`MAXIMUM_ERROR_OUTPUT_CHARACTERS = 4096`, `DEFAULT_MAXIMUM_OUTPUT_BYTES
 * = 8_388_608`) — scattered configurables with no owner.
 */
export const DEFAULT_GIT_INSPECT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAXIMUM_ERROR_BYTES = 2_097_152;
export const DEFAULT_MAXIMUM_INPUT_BYTES = 1_048_576;
export const DEFAULT_MAXIMUM_OUTPUT_BYTES = 8_388_608;
/** Worktree error-output character cap (sanitized stderr slice length). */
export const DEFAULT_MAXIMUM_ERROR_OUTPUT_CHARACTERS = 4_096;
