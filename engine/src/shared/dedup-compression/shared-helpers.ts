import { sha256 as integritySha256 } from "../../kernel/integrity.ts";

/**
 * SHA-256 hex digest of a string.
 *
 * R44: delegates to the canonical `sha256` owner in `src/integrity.ts`
 * (was a private near-duplicate body — "No Scattered Helpers" violation).
 * The canonical owner accepts `string | Uint8Array`; this thin wrapper
 * preserves the string-only call-site signature so existing dedup-
 * compression consumers see the same type.
 */
export function sha256(data: string): string {
  return integritySha256(data);
}

export function stripMarkdownFences(text: string): string {
  return text.replace(/^\`\`\`[a-zA-Z]*\n/gm, "").replace(/\`\`\`$/gm, "").trim();
}
