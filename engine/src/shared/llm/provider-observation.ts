/** Intentional authentication and safe diagnostic labels share one privacy owner. */
import { isSensitiveKeyName } from "../../privacy/secret-signals.ts";
import { redactMessagesTogether } from "../../privacy/redaction-engine.ts";
import { assertResponseIdentity } from "../../privacy/responses-redaction.ts";
import { SecurityError } from "../../kernel/errors.ts";
import { DEFAULT_PRIVACY_POLICY, redactionReplacement } from "../../privacy/privacy-policy.ts";
import { mapStringValues } from "../string-values.ts";
import { EMPTY_HELD_SET, heldValues, type HeldSet } from "../../privacy/held-set.ts";

export type ProviderCredentialSource = Readonly<{ apiKey: string; headers?: Readonly<Record<string, string>> }>;
/** A provider's own credentials (its key and credential headers), held under `provider:<id>`. */
export function providerHeldSet(target: ProviderCredentialSource & Readonly<{ providerId?: string; id?: string }>): HeldSet {
  const values = [target.apiKey];
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    if (name.toLowerCase() === "authorization" || name.toLowerCase() === "proxy-authorization") {
      const payload = /^\s*[^\s]+\s+(.+?)\s*$/u.exec(value)?.[1] ?? value;
      values.push(payload);
    } else if (isSensitiveKeyName(name)) values.push(value);
  }
  return heldValues(`provider:${target.providerId ?? target.id ?? "configured"}`, values);
}
export function assertProviderIdentity(value: string, held: HeldSet): void {
  if (held.values().includes(value)) throw new SecurityError("A protocol identity collides with sensitive text", "responses_identity_sensitive");
  const turn = redactMessagesTogether([], DEFAULT_PRIVACY_POLICY, { heldCredentials: held });
  assertResponseIdentity(value, turn.detectProtocolIdentity);
}
export function observeProviderLabel(value: string, held: HeldSet = EMPTY_HELD_SET): string {
  if (held.values().includes(value)) return redactionReplacement("token", DEFAULT_PRIVACY_POLICY);
  return redactMessagesTogether([value], DEFAULT_PRIVACY_POLICY, { heldCredentials: held }).redacted[0]!;
}
/** Provider event fields and ambient recording context share intentional credentials. */
export function observeProviderDiagnostic<T extends Readonly<Record<string, unknown>>>(value: T, held: HeldSet): T {
  return mapStringValues(value, text => observeProviderLabel(text, held)) as T;
}
/** Paths may themselves be credentials. Public target metadata only exposes origin. */
export function observeProviderOrigin(value: string, held: HeldSet = EMPTY_HELD_SET): string {
  try { return observeProviderLabel(new URL(value).origin, held); }
  catch { return redactionReplacement("token", DEFAULT_PRIVACY_POLICY); }
}
export function opaqueProviderLocator(): string { return redactionReplacement("token", DEFAULT_PRIVACY_POLICY); }

/** Keep each queue scope distinct even when several private identities redact alike. */
export function observeProviderScopes<T>(entries: readonly (readonly [string, T])[], scopeKeys: readonly string[] = entries.map(([key]) => key), held: HeldSet = EMPTY_HELD_SET, redact?: (text: string) => string): Readonly<Record<string, T>> {
  const project = redact ?? redactMessagesTogether(scopeKeys, DEFAULT_PRIVACY_POLICY, { heldCredentials: held }).redact;
  const labels = scopeKeys.map(value => held.values().includes(value) ? redactionReplacement("token", DEFAULT_PRIVACY_POLICY) : project(value));
  const reserved = new Set(labels), used = new Set<string>();
  const aliases = new Map(scopeKeys.map((key, index) => {
    let label = labels[index]!;
    if (used.has(label)) { let suffix = index; do { label = `${labels[index]} [scope ${suffix++}]`; } while (reserved.has(label) || used.has(label)); }
    used.add(label); return [key, label];
  }));
  return Object.freeze(Object.fromEntries(entries.map(([key, value]) => [aliases.get(key)!, value])));
}
