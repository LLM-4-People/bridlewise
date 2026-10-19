/** Ordered records linked by explicit, namespaced identities form atomic spans. */
export function dependencySpans(references: readonly (readonly string[])[]): readonly (readonly number[])[] {
  const first = new Map<string, number>();
  const ends = references.map((_, index) => index);
  for (const [index, identities] of references.entries()) {
    for (const identity of identities) {
      const start = first.get(identity);
      if (start === undefined) first.set(identity, index);
      else ends[start] = index;
    }
  }
  const groups: number[][] = [];
  for (let start = 0; start < references.length;) {
    let end = ends[start]!;
    for (let index = start; index <= end; index++) end = Math.max(end, ends[index]!);
    groups.push(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
    start = end + 1;
  }
  return groups;
}
