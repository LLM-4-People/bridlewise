export function lastSeg(path: string, sep: string): string {
  const idx = path.lastIndexOf(sep);
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function extractComments(
  root: any,
  walkDescendants: (node: any, visitor: (n: any) => void) => void,
  startLine: (n: any) => number,
  path: string,
): { filePath: string; line: number; text: string; kind: "line" | "block" }[] {
  const comments: { filePath: string; line: number; text: string; kind: "line" | "block" }[] = [];
  walkDescendants(root, (n: any) => {
    if (n.type === "line_comment") {
      comments.push({ filePath: path, line: startLine(n), text: n.text.replace(/^\/\//, "").trim(), kind: "line" });
    } else if (n.type === "block_comment") {
      comments.push({ filePath: path, line: startLine(n), text: n.text.replace(/^\/\*/, "").replace(/\*\/$/, "").trim(), kind: "block" });
    }
  });
  return comments;
}
