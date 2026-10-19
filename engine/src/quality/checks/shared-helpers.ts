export function leadingSpaces(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === " " || line[i] === "\t") n += 1;
    else break;
  }
  return n;
}

export function getLine(lines: string[], idx: number): string {
  return lines[idx] ?? "";
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
