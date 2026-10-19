/**
 * THE ARCHITECTURE MANIFEST'S MODULE BLOCKS, READ AS DATA — WITHOUT LOADING IT.
 *
 * `src/architecture-manifest.ts` is one generated module (the registrar writes
 * a `moduleContract({...})` block per module) and the largest file in the
 * engine. A reader that needs only the blocks' facts — the registrar's
 * composition-root derivation, a guard mapping the web hub's namespaces to
 * module ids — parses the manifest's TEXT here instead of importing it, so it
 * neither executes the manifest nor carries it into a browser-side test
 * closure (tests/prevention/frontend-test-closure-bound.test.ts).
 *
 * Read from the AST: a block is found whatever its property order or layout,
 * and only `moduleContract({...})` calls count — the other `id`/`path` pairs
 * in the file (benchmark rows, exclusion records) are not modules.
 */
import { parse as parseModule } from "@babel/parser";

import { astNode, astNodeArray, walkAst, type AstNode } from "../quality-packs/prevention/ast-helpers.ts";

export type DeclaredModuleContract = Readonly<{
  id: string;
  path: string;
  realm: string | undefined;
  compositionRoot: boolean;
}>;

/** Every `moduleContract({...})` block in `manifestText` that names a string `id` and `path`, in file order. */
export function declaredModuleContracts(manifestText: string): readonly DeclaredModuleContract[] {
  const program = parseModule(manifestText, { sourceType: "module", plugins: ["typescript"], errorRecovery: false }).program;
  const found: DeclaredModuleContract[] = [];
  walkAst(program, (node) => {
    if (node.type !== "CallExpression" || astNode(node.callee)?.type !== "Identifier" || astNode(node.callee)?.name !== "moduleContract") return;
    const object = astNode((node.arguments as unknown[])[0]);
    if (object?.type !== "ObjectExpression") return;
    const fields = new Map<string, AstNode>();
    for (const property of astNodeArray(object.properties)) {
      const key = astNode(property.key);
      const value = astNode(property.value);
      if (property.type === "ObjectProperty" && key?.type === "Identifier" && value !== undefined) fields.set(String(key.name), value);
    }
    const id = fields.get("id")?.value;
    const path = fields.get("path")?.value;
    if (typeof id !== "string" || typeof path !== "string") return;
    const realm = fields.get("realm")?.value;
    found.push({ id, path, realm: typeof realm === "string" ? realm : undefined, compositionRoot: fields.get("compositionRoot")?.value === true });
  });
  return found;
}
