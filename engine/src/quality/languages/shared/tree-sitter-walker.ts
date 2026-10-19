/**
 * Shared tree-sitter AST walker helpers (EXP368).
 *
 * Generic utilities for walking tree-sitter ASTs that are NOT language-
 * specific. Per-language extractors live in `../<lang>/parser.ts`. This
 * module owns the common traversal primitives they all consume.
 *
 * Used by: python, rust, go, java, c-cpp parsers (and any future
 * tree-sitter-based parser). JS/TS uses babel (already real AST).
 */

import type { TreeNode } from "./tree-sitter-loader.ts";

/** Iterate over all named children of a node (skips punctuation tokens). */
export function namedChildren(node: TreeNode): readonly TreeNode[] {
  return node.namedChildren;
}

/** Iterate over ALL children of a node (including punctuation). */
export function allChildren(node: TreeNode): readonly TreeNode[] {
  return node.children;
}

/** Find the first child of a given type (named or anonymous). */
export function childOfType(node: TreeNode, type: string): TreeNode | null {
  return node.childOfType ? node.childOfType(type) : null;
}

/** Find the first NAMED child with a field name (e.g., `name`, `body`).
 * Falls back to type-based lookup if the tree-sitter binding does not expose
 * field names (web-tree-sitter 0.22.x returns null for `fieldNameForChild`
 * in some grammars). */
export function childForField(node: TreeNode, field: string): TreeNode | null {
  const direct = node.childForFieldName ? node.childForFieldName(field) : null;
  if (direct) return direct;
  return null;
}

/** Find the first NAMED child of a given type (robust — works even when
 * field-name APIs are unavailable). This is the preferred lookup for
 * tree-sitter-wasms grammars. */
export function firstNamedChildOfType(node: TreeNode, type: string): TreeNode | null {
  for (const c of node.namedChildren) {
    if (c.type === type) return c;
  }
  return null;
}

/** Find the first NAMED child whose type is in `types` (robust). */
export function firstNamedChildOfTypes(node: TreeNode, types: readonly string[]): TreeNode | null {
  const set = new Set(types);
  for (const c of node.namedChildren) {
    if (set.has(c.type)) return c;
  }
  return null;
}

/** Find ALL named children of a given type (robust). */
export function namedChildrenOfType(node: TreeNode, type: string): TreeNode[] {
  return node.namedChildren.filter((c) => c.type === type);
}

/** Recursively walk all descendants of a node, depth-first. */
export function walkDescendants(node: TreeNode | null, visit: (n: TreeNode) => void): void {
  if (!node) return;
  visit(node);
  for (const c of node.namedChildren) walkDescendants(c, visit);
}

/** Find all descendants matching a predicate, depth-first. */
export function findDescendants(
  node: TreeNode,
  predicate: (n: TreeNode) => boolean,
): TreeNode[] {
  const out: TreeNode[] = [];
  walkDescendants(node, (n) => {
    if (predicate(n)) out.push(n);
  });
  return out;
}

/** Find all descendants of a specific type. */
export function findByType(node: TreeNode, type: string): TreeNode[] {
  return findDescendants(node, (n) => n.type === type);
}

/** Find all descendants matching any of a set of types. */
export function findByTypes(node: TreeNode, types: readonly string[]): TreeNode[] {
  const set = new Set(types);
  return findDescendants(node, (n) => set.has(n.type));
}

/** Get 1-based line and column of the start of a node. */
export function startLine(node: TreeNode): number {
  return node.startPosition.row + 1;
}

/** Get 1-based line of the end of a node. */
export function endLine(node: TreeNode): number {
  return node.endPosition.row + 1;
}

/** Get the text of the first named child whose field is `field`, or null. */
export function fieldText(node: TreeNode, field: string): string | null {
  const c = node.childForFieldName(field);
  return c ? c.text : null;
}

/** Count direct named children of a node. */
export function namedChildCount(node: TreeNode): number {
  return node.namedChildren.length;
}

/** Return true if a node is a leaf (no named children). */
export function isLeaf(node: TreeNode): boolean {
  return node.namedChildren.length === 0;
}

/** Build a line-offset table for offset→line conversion. */
export function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

/** Count newlines in a string (matches `countLines` in parsers/types.ts). */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** Count branch points for cyclomatic complexity, language-agnostic.
 * Mirrors `countBranchPoints` from parsers/types.ts for parity. */
export function countBranchPoints(body: string): number {
  const patterns = [
    /\bif\b/g,
    /\belse\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\?/g,
    /&&/g,
    /\|\|/g,
    /\?.\?/g,
    /\bmatch\b/g,
  ];
  let total = 1;
  for (const p of patterns) {
    const matches = body.match(p);
    if (matches) total += matches.length;
  }
  return total;
}

/** Compute max nesting depth by scanning braces. */
export function maxNestingDepth(body: string): number {
  let depth = 0;
  let maxDepth = 0;
  let inString: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (c === "}") {
      depth -= 1;
      if (depth < 0) depth = 0;
    }
  }
  return maxDepth;
}
