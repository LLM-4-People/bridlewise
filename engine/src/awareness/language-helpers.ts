export function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
  if (s.length > 0 && s.charCodeAt(s.length - 1) !== 10) n += 1;
  return n;
}

export function computeTypedFraction(
  fns: readonly { parameterCount: number; typedParameters: number }[],
): number {
  let total = 0;
  let typed = 0;
  for (const f of fns) { total += f.parameterCount; typed += f.typedParameters; }
  return total === 0 ? 0 : typed / total;
}

export function stripComment(line: string): string {
  let inStr: '"' | "'" | "`" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inStr) {
      if (c === inStr && line[i - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") inStr = c as '"' | "'" | "`";
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

export function tokenizeBody(
  lines: readonly string[],
  keywords: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const idRe = /\b[A-Za-z_]\w*\b/g;
  const numRe = /\b\d+(?:\.\d+)?\b/g;
  const strRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i] ?? "");
    let m: RegExpExecArray | null;
    strRe.lastIndex = 0;
    while ((m = strRe.exec(line)) !== null) out.push("lit_str");
    numRe.lastIndex = 0;
    while ((m = numRe.exec(line)) !== null) out.push("lit_num");
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      const w = m[0];
      if (!keywords.has(w)) out.push(w.toLowerCase());
    }
  }
  return out;
}
