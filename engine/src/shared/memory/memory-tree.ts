// src/shared/memory/memory-tree.ts
// Tree classification. Root = project → conversation → type → entry.
// (User directive #2: "could we class things into memory, like a tree?")
// Single owner of the tree structure. The store maintains the tree as a
// projection over its entry list (the entry list remains the source of
// truth; the tree is rebuildable, matching the root-policy invariant
// `separateLossyHistoriesAllowed: false`).

import type { MemoryEntry } from "./memory-entry.ts";
import type { MemoryType } from "./memory-config.ts";
import { MEMORY_TYPES } from "./memory-config.ts";

export type TreeNode = Readonly<{
  key: string;
  label: string;
  children: readonly TreeNode[];
  entries: readonly MemoryEntry[];
}>;

/** Build the project → conversation → type → entry tree from a flat list. */
export function buildMemoryTree(entries: readonly MemoryEntry[]): TreeNode {
  const byProject = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const list = byProject.get(e.projectId) ?? [];
    list.push(e);
    byProject.set(e.projectId, list);
  }
  const projectChildren: TreeNode[] = [];
  for (const [projectId, projEntries] of byProject) {
    const byConv = new Map<string, MemoryEntry[]>();
    for (const e of projEntries) {
      const list = byConv.get(e.conversationId) ?? [];
      list.push(e);
      byConv.set(e.conversationId, list);
    }
    const convChildren: TreeNode[] = [];
    for (const [convId, convEntries] of byConv) {
      const byType = new Map<MemoryType, MemoryEntry[]>();
      for (const e of convEntries) {
        const list = byType.get(e.type) ?? [];
        list.push(e);
        byType.set(e.type, list);
      }
      const typeChildren: TreeNode[] = [];
      for (const t of MEMORY_TYPES) {
        const list = byType.get(t);
        if (list && list.length > 0) {
          typeChildren.push({ key: t, label: t, children: [], entries: list });
        }
      }
      convChildren.push({ key: convId, label: `conversation ${convId}`, children: typeChildren, entries: convEntries });
    }
    projectChildren.push({ key: projectId, label: `project ${projectId}`, children: convChildren, entries: projEntries });
  }
  // Return a fresh root with children (the original root is frozen).
  return { key: "root", label: "projects", children: projectChildren, entries };
}

/** Traverse the tree to collect entries under a path
 * (projectId, conversationId, type). Null = wildcard. */
export function treePathFilter(entries: readonly MemoryEntry[], path: {
  projectId?: string | null;
  conversationId?: string | null;
  type?: MemoryType | null;
}): readonly MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const e of entries) {
    if (path.projectId !== null && path.projectId !== undefined && e.projectId !== path.projectId) continue;
    if (path.conversationId !== null && path.conversationId !== undefined && e.conversationId !== path.conversationId) continue;
    if (path.type !== null && path.type !== undefined && e.type !== path.type) continue;
    out.push(e);
  }
  return out;
}
