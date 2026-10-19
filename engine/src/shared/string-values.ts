/** Shared structural traversal; own keys, aliases and cycles survive. */
import { isPlainObject } from "./type-guards.ts";
export type StringValueLocation = Readonly<{ path: readonly (string | number)[]; ancestors: readonly unknown[] }>;
export function mapStringValues(value: unknown, map: (text: string, location: StringValueLocation) => string, visitKey?: (key: string, location: StringValueLocation) => void | string): unknown {
  return mapJsonValues(value, (item, location) => typeof item === "string" ? map(item, location) : item, visitKey);
}
/** A changed value replaces its whole subtree; key projections must preserve distinct keys. */
export function mapJsonValues(value: unknown, map: (item: unknown, location: StringValueLocation) => unknown, visitKey?: (key: string, location: StringValueLocation) => void | string): unknown {
  const seen = new WeakMap<object, unknown>();
  const visit = (item: unknown, path: readonly (string | number)[], ancestors: readonly unknown[]): unknown => {
    const mapped = map(item, { path, ancestors });
    if (mapped !== item) return mapped;
    if (item === null || typeof item !== "object" || (!Array.isArray(item) && !isPlainObject(item))) return item;
    if (seen.has(item)) return seen.get(item);
    const output: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : {};
    seen.set(item, output);
    for (const [key, child] of Object.entries(item)) {
      const mappedKey = !Array.isArray(item) ? visitKey?.(key, { path: [...path, key], ancestors: [...ancestors, item] }) : undefined;
      Object.defineProperty(output, typeof mappedKey === "string" ? mappedKey : key, { value: visit(child, [...path, Array.isArray(item) ? Number(key) : key], [...ancestors, item]),
        enumerable: true, configurable: true, writable: true });
    }
    return output;
  };
  return visit(value, [], []);
}
