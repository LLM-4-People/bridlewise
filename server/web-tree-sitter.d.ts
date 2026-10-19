/**
 * Minimal type declaration for `web-tree-sitter` — the module is not
 * installed in the web UI workspace. The intelligence module's
 * tree-sitter-backend.ts imports it, but the runtime falls back to
 * regex-based extraction when tree-sitter is unavailable. This declaration
 * satisfies the type checker without adding a runtime dependency.
 */

declare module "web-tree-sitter" {
  export type TreeSitterNode = {
    type: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    childCount: number;
    child(index: number): TreeSitterNode | null;
    children: TreeSitterNode[];
    parent: TreeSitterNode | null;
    text: string;
  };

  export type TreeSitterParser = {
    parse(input: string): { rootNode: TreeSitterNode } | null;
    delete(): void;
  };

  export type TreeSitterLanguage = {
    query(source: string): { matches(node: TreeSitterNode): unknown[] };
  };

  export type WebTreeSitter = {
    init(): Promise<void>;
    Language: {
      load(path: string): Promise<TreeSitterLanguage>;
    };
    Parser: {
      new: TreeSitterParser;
      setLanguage(parser: TreeSitterParser, language: TreeSitterLanguage): void;
    };
  };

  const webTreeSitter: WebTreeSitter;
  export default webTreeSitter;
}
