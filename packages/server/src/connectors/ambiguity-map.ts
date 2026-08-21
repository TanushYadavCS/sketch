/**
 * A Map<K, V> that drops a key when conflicting values arrive for it,
 * and refuses to re-set the key afterward. Same single-unambiguous-match
 * rule used across every name→email lookup map in the connector layer:
 * if two people share a normalized name, neither resolves.
 *
 * Build pattern:
 *   const m = createAmbiguityAwareMap<string, string>();
 *   m.add("bob chen", "bob@a");
 *   m.add("bob chen", "bob@a");   // same value — kept
 *   m.add("bob chen", "bob@b");   // conflict — key dropped, tagged ambiguous
 *   m.add("bob chen", "bob@c");   // no-op (still ambiguous)
 *   m.get("bob chen");             // → undefined
 */
export interface AmbiguityAwareMap<K, V> {
  /** Add a (key, value). Drops the key + tags ambiguous on conflict. */
  add(key: K, value: V): void;
  /** Lookup. Returns undefined for ambiguous or missing keys. */
  get(key: K): V | undefined;
  /** True if the key is ambiguous (was set then dropped). */
  isAmbiguous(key: K): boolean;
  /** Current resolved size (excludes ambiguous keys). */
  readonly size: number;
}

export function createAmbiguityAwareMap<K, V>(): AmbiguityAwareMap<K, V> {
  const resolved = new Map<K, V>();
  const ambiguous = new Set<K>();
  return {
    add(key, value) {
      if (ambiguous.has(key)) return;
      const existing = resolved.get(key);
      if (existing === undefined) {
        resolved.set(key, value);
        return;
      }
      if (existing !== value) {
        resolved.delete(key);
        ambiguous.add(key);
      }
    },
    get(key) {
      return resolved.get(key);
    },
    isAmbiguous(key) {
      return ambiguous.has(key);
    },
    get size() {
      return resolved.size;
    },
  };
}
