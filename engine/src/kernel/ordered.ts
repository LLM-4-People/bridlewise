export function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function sameOrderedValues<Value extends string | number | boolean | null>(
  left: readonly Value[],
  right: readonly Value[],
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
