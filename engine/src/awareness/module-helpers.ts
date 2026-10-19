import type { SignalContext } from "./types.ts";

export function moduleOf(filePath: string, ctx: SignalContext): string {
  for (const m of ctx.modules) {
    if (filePath.startsWith(m.path + "/") || filePath === m.path) return m.name;
  }
  return "(root)";
}

export function moduleOfPath(filePath: string, modules: readonly { path: string }[]): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const m of modules) {
    if (filePath === m.path || filePath.startsWith(m.path + "/") || filePath.startsWith(m.path + "\\")) {
      if (m.path.length > bestLen) { best = m.path; bestLen = m.path.length; }
    }
  }
  return best;
}
