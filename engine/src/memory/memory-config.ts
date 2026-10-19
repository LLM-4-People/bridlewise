/** Memory operational defaults — canonical owner for memory-domain configurable values. */
export const DEFAULT_MAX_INPUT_CHARS = 65_536;
export const DEFAULT_MAX_INTENT_CHARS = 4_096;
export const DEFAULT_MAX_RESULT_CHARS = 65_536;
export const DEFAULT_MAX_TARGET_CHARS = 1_024;
/** Preview length (chars) for memory/context snippets shown to the LLM or
 * the user (first-sentence fallback, trust-enforcer fact preview,
 * proactive-injector snippet, tool-result-store summary). Previously a
 * scattered `slice(0, 200)` literal across 5 memory-subsystem files. */
export const DEFAULT_MEMORY_PREVIEW_CHARS = 200;
