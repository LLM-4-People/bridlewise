/** One syntactic endpoint policy for configuration, saved providers and discovery. */
export function isProviderBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || /[\s?#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function isResponsesPath(value: unknown): value is string {
  return typeof value === "string" && /^\/(?!\/)[^?#\\\s]*$/u.test(value);
}
