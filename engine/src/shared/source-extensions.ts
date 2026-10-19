import { deepFreeze } from "../kernel/integrity.ts";

/**
 * THE EXECUTABLE SOURCE EXTENSIONS, AND NOTHING ELSE.
 *
 * This is a vocabulary about files, not about architecture. It answers one
 * question — "which extensions carry executable first-party source?" — and
 * six modules ask it: the two intelligence readers (`file-slice`,
 * `quick-view`), the prevention AST helpers, the module registrar, and the
 * two effect-inventory verifiers. Only the last three have anything to do
 * with the architecture manifest.
 *
 * WHY IT LIVES HERE INSTEAD OF IN THE MANIFEST. It used to be declared inside
 * `src/architecture-manifest.ts`, which is a GENERATED data module that grows
 * with every registered module — 421 KB and 5,082 lines at the time this was
 * split out. Importing eight strings from it dragged the whole generated
 * artifact into the closure of everything that asked, including a Svelte UI
 * test three repositories-worth of imports away: the chain was
 * `tests/cockpit/stream-pulse.test.ts` -> `tests/helpers/function-scope.ts`
 * -> `src/shared/source-structure.ts` -> `quality-packs/prevention/
 * ast-helpers.ts` -> the manifest. A cross-repository test suite therefore
 * re-transformed, re-cached and re-evaluated a 421 KB data module every time
 * a module was registered, for one frozen array of eight strings.
 *
 * THERE IS EXACTLY ONE DOOR ONTO THIS VALUE, AND THAT IS WHAT MAKES THE SPLIT
 * HOLD. The direction of the dependency (the manifest imports this module;
 * this module imports nothing from the manifest) is necessary but was never
 * sufficient on its own: while `ArchitectureManifest` still carried a
 * `sourceExtensions` field, any consumer could have reached the extension set
 * by importing the manifest DIRECTLY and reading the field — one import, no
 * cycle, and the 421 KB straight back into the closure. The cycle policy
 * `exact-registered-edges-no-cycles` refuses only the reverse edge, which
 * nobody wanted to write. So the field was removed from the manifest's type
 * and value: `ARCHITECTURE_MANIFEST.sourceExtensions` is now a compile error,
 * and asking the manifest this question is unrepresentable rather than merely
 * discouraged. Every consumer names this module or does not get the answer.
 *
 * WHY `deepFreeze` RATHER THAN A LOCAL FREEZE. Freezing an exported constant
 * has exactly one owner in this repository, and re-deriving it here to save
 * one import edge would be a second implementation of a solved problem. The
 * cost is bounded and measured: `integrity.ts` is 7 KB against the 421 KB
 * this split removes, and everything it pulls (`zod`, `node:crypto`,
 * `errors.ts`) was already inside the closure via the manifest.
 *
 * Deny-by-default: an extension absent from this list is not scanned, not
 * sliced and not registered. Adding a language means adding it here, once.
 */
export const ARCHITECTURE_SOURCE_EXTENSIONS = deepFreeze([
  ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx",
] as const);
