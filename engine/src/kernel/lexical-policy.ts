/**
 * Canonical safety ceilings for immutable lexical reuse. This dependency-free
 * leaf is shared by the complete root policy and narrow scanner consumers,
 * so reading three ceilings does not initialize unrelated policy contracts.
 * These bound source characters, span records and entry metadata separately;
 * they are neither heap-byte estimates nor operator performance defaults.
 */
export const LEXICAL_REUSE_LIMITS = Object.freeze({
  maximumInputs: 4096,
  maximumSourceCharacters: 33_554_432,
  maximumSpans: 1_000_000,
} as const);
