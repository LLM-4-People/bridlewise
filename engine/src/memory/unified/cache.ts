import { InputError } from "../../kernel/errors.ts";
/**
 * LRU cache for recent retrieve results (from EXP418).
 *
 * If the same query is asked again (common in conversations with repeated
 * probes), return the cached result without re-querying the inverted
 * index. Bounded size with LRU eviction. A Map preserves insertion order,
 * so LRU is implemented by re-inserting on access + evicting the oldest
 * entry on overflow.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1 || !Number.isFinite(capacity)) {
      throw new InputError(`LruCache: capacity must be a positive finite number, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
