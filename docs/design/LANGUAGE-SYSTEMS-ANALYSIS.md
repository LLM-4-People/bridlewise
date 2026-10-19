---
layout: default
title: 'Language systems analysis'
---

# Language systems analysis

Read-only analysis. Measured from source on 2026-07-27 against
`TIER1-AGENT-CONTRACT.md` §14 (agnostic core / specific folders / one door).

All paths are relative to `/home/example/code-harness-workspaces/harness-main-v1/`
unless stated. The web UI lives at
`/home/example/code-harness-workspaces/web-interface-foundation-v1/` (a SIBLING of
this workspace, not a child — the brief's relative path does not exist here).

---

## 0. Headline

**There are not three language systems. There are five, plus one name collision.**
The brief named three; two more have the same shape and the same duplicated
internals:

| # | System | Location | Languages | Backend | Real consumers |
|---|--------|----------|-----------|---------|----------------|
| 1 | Intelligence registry + extractors | `integration/src/intelligence/` | 22 declared | `web-tree-sitter` WASM + hand tokenizer | repository-map, symbol-search, quick-view, dependency-graph, editor/syntax-validator → **web UI** |
| 2 | Quality pack languages | `integration/src/quality/languages/` | 8 (6 folders) | `web-tree-sitter` WASM + `@babel/parser` | `quality/aggregator.ts` only → **tests only** |
| 3 | Awareness adapters | `integration/src/awareness/languages/` | 4 + generic | **native `tree-sitter`** + `@babel/parser` | `awareness/engine.ts` → **web UI** |
| 4 | Smart-edit language module | `integration/src/smart-edit/language.mjs` | 4 + text | `@babel/parser` + regex | *(no importers found)* |
| 5 | Quality **packs** (different dir) | `integration/src/quality-packs/` | TypeScript only | `@babel/parser` | `src/cli.ts:71` — the actual `quality` CLI command |

Name collision, NOT a language system: `integration/src/shared/exposure/language.ts`
is a natural-language guard for settings copy (`LANGUAGE_ENFORCED_MODULES`).
Unrelated. Do not touch it in this work.

**And two of them are wired but inert.** Details in §4. The short version:

- The intelligence tree-sitter path **never initialises its backend in
  production**, so symbol AND import extraction return empty for all 20
  non-JS/TS languages the registry claims to support.
- The awareness tree-sitter path requires the **native `tree-sitter` npm
  package, which is not a dependency and is not installed anywhere**, so all
  three `*-tree-sitter.ts` adapters fall through to regex 100% of the time
  while their headers say "REAL AST parser, no regex".

---

## 1. Map of each system

### 1.1 Intelligence — `integration/src/intelligence/`

**What it does.** Owns the canonical language table and produces the symbol +
import stream that the repository map, symbol search, quick view and dependency
graph consume.

**What it registers.** `language-registry.ts:138-454` — `LANGUAGE_SPECS`, 22
languages: javascript, typescript, python, rust, go, ruby, java, c, cpp,
c_sharp, lua, swift, elixir, zig, bash, php, kotlin, scala, dart, ocaml, elm,
rescript (`LanguageId` union, `language-registry.ts:48-70`). Each entry carries
extensions, WASM filename, `treeSitter: boolean`, comment prefixes, and
tree-sitter definition node-types.

**Backend.** `tree-sitter-backend.ts` — `web-tree-sitter` 0.22.6 WASM with
grammars from `tree-sitter-wasms` 0.1.13. Both ARE installed in
`integration/node_modules`. All 22 declared `.wasm` grammar files exist in
`integration/node_modules/tree-sitter-wasms/out/` (verified by listing; 36 wasms
present). JS/TS are marked `treeSitter: false` and go through the hand-written
tokenizer in `symbol-extractor.ts:58` instead.

**Consumers (real importers, not the manifest).**
- `intelligence/symbol-extractor.ts:10,11,56`
- `intelligence/multi-import-extractor.ts:35`
- `intelligence/dependency-graph.ts:2,76`
- `intelligence/intelligence-types.ts:3`
- `editor/syntax-validator.ts:10,11,138`
- `intelligence/tree-sitter-backend.ts:230`

**Web UI reachability: YES.** `web-interface-foundation-v1/server/intelligence-bridge.ts:20,27,31,32,33,37`,
`server/repository-map-worker.ts:32`, `server/quick-view-worker.ts:24`,
`server/canonical.ts:245-247`, `server/harness-config.ts:958,1008`.

### 1.2 Quality pack — `integration/src/quality/languages/`

**What it does.** Parses source into a normalised `ParsedFile`
(symbols/imports/exports/comments/parseErrors) that the quality checks and
signals in `quality/checks/` and `quality/signals/` consume.

**What it registers.** `quality/languages/index.ts:22-45` — a hand-written
`switch` over 8 `LanguageId` values (`quality/base.ts:12-21`) dispatching to 6
parser folders: `js-ts`, `python`, `rust`, `go`, `java`, `c-cpp`. Extension
table is a separate hardcoded object at `quality/config.ts:385-406` (20
extensions). Default enabled set at `quality/config.ts:84-93`.

**Backend.** `quality/languages/shared/tree-sitter-loader.ts` — a SECOND,
independent `web-tree-sitter` loader. Unlike the intelligence backend it is
**lazily self-initialising** (`loadLanguage` at `:150-169` awaits
`getTreeSitter()` internally), which is why it actually works when called.
JS/TS use `@babel/parser` (`quality/languages/js-ts/parser.ts:15`).

**Consumers.** `quality/aggregator.ts:79,194` and `quality/index.ts:8`.
`quality/index.ts` is re-exported by `aux/index.ts:48`, which **has no
importers**. `runAnalysis` (the pack's only entry point) is called from
`test/aux/quality.test.ts` and `test/aux/exp462-checks.test.ts` and nowhere
else in `src/` or `scripts/`.

**Web UI reachability: NO.** `web-interface-foundation-v1/server/quality-bridge.ts`
imports `awareness-bridge.ts` and `intelligence-bridge.ts` (lines 14-15) — never
`integration/src/quality/`. The `quality` CLI command routes to
`quality-packs/cli.ts` (`src/cli.ts:71`), a different, TypeScript-only pack.
**The 6-language quality pack is reachable from tests only.**

### 1.3 Awareness — `integration/src/awareness/languages/`

**What it does.** Produces per-file `FileAnalysis` (functions, imports, exports,
health counts, token stream, typed-parameter fraction) feeding ~45 awareness
signal modules.

**What it registers.** `awareness/languages/index.ts:29-34` — an `ADAPTERS`
array of 4 entries (typescript covering JS+TS, python, rust, go) plus
`GENERIC_ADAPTER` at `:60-63`. The identical 4-entry table is **duplicated
verbatim** at `awareness/config.ts:348-353` as `DEFAULT_AWARENESS_LANGUAGES`.

**Backend.** `awareness/languages/tree-sitter-base.ts:53-65` —
`cjsRequire("tree-sitter")`, the **NATIVE** binding. Verified absent:
`integration/package.json` dependencies are `@babel/parser`,
`@xenova/transformers`, `tree-sitter-wasms`, `web-tree-sitter`, `zod`. No
`tree-sitter`, no `tree-sitter-python`/`-go`/`-rust`/`-typescript`. Not present
in `integration/node_modules/`, `harness-main-v1/node_modules/`, or
`code-harness-workspaces/node_modules/`. `node -e "require.resolve('tree-sitter')"`
→ `MODULE_NOT_FOUND`.

**Consumers.** `awareness/engine.ts:36-38,170-173` and `awareness/multi-turn.ts:28,48`.

**Web UI reachability: YES.** `web-interface-foundation-v1/server/awareness-worker.ts:23-25`.

### 1.4 Smart-edit — `integration/src/smart-edit/language.mjs` (698 lines)

Own `detectLanguage` (`:32-40`, 4 languages + `text`), own babel AST helpers,
own regex parsers for Python/Rust, own `getAdapter`/`getAdapterForFile`
(`:629-639`). `grep -rn "smart-edit/language"` across `src/` and `scripts/`
returns **no importers**. Sixth extension table, zero consumers.

### 1.5 Quality-packs — `integration/src/quality-packs/`

`typescript-pack.ts` (38 KB), TypeScript only, consumed by `quality-packs/cli.ts:13`
which is what `src/cli.ts:71` actually runs for the user-facing `quality`
command. This is a seventh place that answers "which languages do we check".

---

## 2. Which is the real owner?

**Answer: none of them is the owner, and they are NOT three views of one
concern — they are three DIFFERENT OUTPUTS sharing ONE duplicated INPUT layer.**

Split it precisely:

**Genuinely distinct (do NOT merge):**
- Intelligence produces a *symbol index and import graph* for retrieval.
- Quality produces *findings against thresholds*.
- Awareness produces *aggregate signals* over a whole tree.

Those three outputs have different shapes (`SymbolInfo`/`ExtractionResult`,
`ParsedFile`/`Finding`, `FileAnalysis`/`AwarenessSnapshot`), different
consumers and different lifecycles. Collapsing them into one output type would
be merging distinct concerns — its own defect.

**NOT distinct (must merge):** everything below the output. All three
independently implement:

1. extension → language id
2. tree-sitter runtime bootstrap + grammar cache
3. tree tokenisation / walking
4. function & class collection
5. import statement collection
6. line counting, cyclomatic complexity, nesting depth
7. a regex fallback for the same 3-4 languages

That is one concern implemented three times, which is exactly what §14 layer 1
("if two language packs contain the same logic, that logic was agnostic")
forbids. Neither of the three can be nominated owner as-is:

- Intelligence has the **best table** (22 languages, all grammars present) but
  the **worst wiring** (never initialised — §4.1) and no quality/awareness output.
- Quality has the **best backend** (self-initialising, works) but the **narrowest
  table** and **no production consumer at all**.
- Awareness has the **most consumers** but a **backend that cannot ever load**.

So the owner has to be built from the best parts, not elected from the three.

---

## 3. Measured duplication

Every row below is the SAME logic in 2+ places, with file:line.

### 3.1 Extension → language tables — SEVEN copies

| Copy | Location | Entries |
|---|---|---|
| 1 | `integration/src/intelligence/language-registry.ts:138-454` | 22 languages |
| 2 | `integration/src/quality/config.ts:385-406` | 20 extensions → 8 ids |
| 3 | `integration/src/awareness/languages/index.ts:29-34` | 4 adapters |
| 4 | `integration/src/awareness/config.ts:348-353` | **verbatim duplicate of copy 3** |
| 5 | `integration/src/language-extensions.ts:13-14` | `TS_EXTENSIONS`, `JS_EXTENSIONS` |
| 6 | `integration/src/intelligence/language-registry.ts:135-136` | `TS_ONLY_EXTENSIONS`/`JS_ONLY_EXTENSIONS` — **re-declares copy 5 locally instead of importing it**, in the file whose own header says it is "the ONE place the language table lives" |
| 7 | `integration/src/smart-edit/language.mjs:32-40` | 4 languages |

Copies 3 and 4 are character-identical including the column alignment. Copies 5
and 6 are the same two sets; `language-extensions.ts:1-10` states it exists
precisely to stop that duplication, and the canonical registry then bypasses it.

`quality/config.ts:400` maps `.h` → `c`; `language-registry.ts:243,256` lists
`.h` under BOTH `c` and `cpp` and resolves it to `c` by first-wins ordering
(`language-registry.ts:458-466`). Two systems, two different answers for the
same file, no guard.

### 3.2 Tree-sitter bootstrap — THREE independent loaders

| Loader | Lines | Module | Init shape |
|---|---|---|---|
| `intelligence/tree-sitter-backend.ts` | 231 | `web-tree-sitter` WASM | **explicit** `initTreeSitterBackend()` must be awaited by the caller (`:144-167`); `parseSync` throws otherwise (`:175-182`) |
| `quality/languages/shared/tree-sitter-loader.ts` | 214 | `web-tree-sitter` WASM | **lazy self-init** inside `loadLanguage` (`:150-169`) |
| `awareness/languages/tree-sitter-base.ts` | 248 | **native `tree-sitter`** | lazy `tsAvailable()` (`:53-65`), permanently false |

All three implement: a module cache, a per-language grammar cache, a WASM/native
dir resolution, a parser instance, and a tree-lifetime/`delete()` strategy.
Three different answers to the same five questions. The intelligence loader
resolves the wasm dir by walking up 25 levels twice
(`tree-sitter-backend.ts:72-110`); the quality loader uses
`require.resolve("tree-sitter-wasms/package.json")`
(`tree-sitter-loader.ts:83-89`). Same question, two mechanisms.

### 3.3 `countLines` — FOUR copies, TWO different semantics

| Location | Semantics for `"a\n"` |
|---|---|
| `awareness/language-helpers.ts:1-6` | **1** (count `\n`, +1 only if the last char is not `\n`) |
| `quality/languages/shared/tree-sitter-walker.ts:129-136` | **2** (`1 + count of \n`) |
| `intelligence/tree-sitter-extractor.ts:246-253` | **2** |
| `intelligence/symbol-extractor.ts:670-677` | **2** |

Awareness and intelligence/quality **disagree by one line on every file that
ends with a newline**, i.e. essentially every source file. The LOC the
awareness panel shows and the LOC the repository map shows are different
numbers for the same file, and nothing detects it. `tree-sitter-walker.ts:128`
even documents the copy: *"matches `countLines` in parsers/types.ts"* —
a comment where an import belongs.

### 3.4 `tokenizeBody` — TWO copies, ALREADY DRIFTED

- Shared: `awareness/language-helpers.ts:29-50`. Its string regex is
  `/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g` — **no backtick handling**.
- Local: `awareness/languages/go.ts:28-47` — byte-identical body except it uses
  the file-local `STR_RE` at `go.ts:18`, which DOES handle backticks and carries
  the comment *"EXP387 fix: … catastrophic backtracking … Replaced with `` `[^`]*` ``"*.

The EXP387 fix was applied to the copy only. `python.ts:13` and `rust.ts:11`
import the shared, unfixed version. Go, Python and Rust are therefore tokenised
by different rules, and the clone/entropy signals compare across them. This is
the drift §2 of the contract predicts, already realised, in the same directory.

### 3.5 `bodyComplexity` — THREE copies

`awareness/languages/python.ts:38-48`, `rust.ts:23-…`, `go.ts:49-58`.
Identical structure (`let c = 1`, `stripComment`, per-line regex test, `c += 1`),
differing only in the keyword alternation. That is one agnostic function with a
per-language keyword set — the exact shape §14 layer 1 describes.

A fourth, string-based variant lives at
`quality/languages/shared/tree-sitter-walker.ts:140-159` (`countBranchPoints`),
whose header comment again says *"Mirrors `countBranchPoints` from
parsers/types.ts for parity"*. A fifth, node-based variant is
`awareness/languages/tree-sitter-base.ts:224-230` (`treeSitterComplexity`).

### 3.6 `maxNestingDepth`, `stripComment`, magic-number allowlist

- `maxNestingDepth`: `quality/languages/shared/tree-sitter-walker.ts:163-190` only —
  but the awareness adapters compute nesting inline per language.
- `ALLOW_NUM = new Set([0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5])` appears
  verbatim at `awareness/languages/python.ts:23`, `go.ts:24`, `rust.ts:19`, and
  again as `allow` at `awareness/languages/python-tree-sitter.ts:186`.
  Four copies of a magic-number allowlist that is itself a configurable
  (contract §17 says it belongs in `bridlewise.config.json`, not in four
  source files).
- `MAGIC_RE` — same four locations, same pattern.
- `TODO_RE` — `python.ts:21`, `go.ts:22`, `rust.ts:17`.

### 3.7 Python symbol collection — THREE implementations of one function

| Implementation | Backend | Lines |
|---|---|---|
| `quality/languages/python/parser.ts:85-233` (`parsePython`) | WASM tree-sitter | 149 |
| `awareness/languages/python-tree-sitter.ts:31-83` (`collectPyFunctions`) + `:86-136` (`collectPyImports`) + `:139-173` (`collectPyExports`) | native tree-sitter (dead) | 143 |
| `awareness/languages/python.ts:53-185` (`analyzePython`) | regex | 133 |

All three walk for `function_definition`/`class_definition`, resolve the name,
count `parameters` children with the SAME node-type list
(`quality/.../python/parser.ts:49` vs `python-tree-sitter.ts:61` — identical
seven-element list, written twice), and read `__all__` for exportedness
(`quality/.../python/parser.ts:107-119` vs `python-tree-sitter.ts:150-169`).
A fourth Python path exists in `intelligence/tree-sitter-extractor.ts:88-112`,
driven by `language-registry.ts:179-182`.

Same for Go (`quality/languages/go/parser.ts` + `awareness/languages/go.ts` +
`go-tree-sitter.ts` + registry entry) and Rust.

### 3.8 Import parsing — THREE implementations

- `intelligence/multi-import-extractor.ts:54-79` — regex, 20 languages, one
  function per language.
- `quality/languages/python/parser.ts:122-162`, `go/parser.ts`, `rust/parser.ts`,
  … — AST-based, per language.
- `awareness/languages/python-tree-sitter.ts:86-136` / `python.ts:82-93` /
  `go.ts` / `rust.ts` — AST and regex, per language.

Three answers to "what does this file import", none of them shared.

---

## 4. The two inert paths (the fabricated-capability findings)

### 4.1 Intelligence tree-sitter is NEVER initialised in production

`tree-sitter-extractor.ts:56-58`:

```ts
if (!isLanguageReady(spec.id)) {
  return emptyResult(source);
}
```

`emptyResult` (`:255-262`) returns empty symbols, empty imports, empty exports.

`isLanguageReady` (`tree-sitter-backend.ts:170-172`) is true only after
`initTreeSitterBackend` has been awaited. Repo-wide search for callers of
`initTreeSitterBackend` outside its own module:

- `integration/src/editor/syntax-validator.ts:138` — inside
  `initTreeSitterSyntaxValidators()`
- `integration/scripts/run-exp437-lang.mjs:37` — an experiment script

And `initTreeSitterSyntaxValidators` / `createLanguageAgnosticSyntaxValidatorRegistry`
have **no production callers either** — they appear only in
`integration/test/architecture/dead-export-scanner.test.ts` (lines 224, 234,
286, 306, 439, 467), i.e. they are on the known-dead-export allowlist. The
editor's real consumers call the SYNC
`createDefaultSyntaxValidatorRegistry()` (`editor/transactional-editor.ts:160`,
`quality-packs/typescript-pack.ts:49`), and
`registerTreeSitterValidators` (`syntax-validator.ts:119-128`) skips every
language whose grammar is not ready.

**Consequences, measured:**

- `intelligence/symbol-extractor.ts:54-57` dispatches every non-JS/TS file to
  `extractSymbolsTreeSitter`, which returns empty. `repository-map.ts:149` calls
  `extractSymbols` — so the repository map, symbol search, quick view and
  reuse discovery see **zero symbols** for Python, Rust, Go, Java, C, C++,
  Ruby, PHP, Swift, Kotlin, Scala, C#, Lua, Elixir, Zig, Bash, Dart, OCaml, Elm,
  ReScript.
- `multi-import-extractor.ts` (383 lines, 20 languages) is called at exactly one
  site: `tree-sitter-extractor.ts:76` — which is **after** the `isLanguageReady`
  early return. So the dependency graph gets **zero edges** for the same 20
  languages. That is precisely the bug the module's own header
  (`multi-import-extractor.ts:6-11`) says it was written to fix: *"the graph
  showed only isolated nodes… This module is that 'future extractor.'"* It is
  wired-but-inert — the INERT shape the contract §8 calls out as the class this
  project keeps rediscovering. Its 20 tests
  (`test/intelligence/multi-import-extractor.test.ts`) call
  `extractMultiLanguageImports` directly, so they pass while production never
  reaches it.
- No warning, no log, no `absent` marker is emitted. `emptyResult` is
  indistinguishable from "this file genuinely has no symbols". This violates
  contract §5 (absence over fabrication): an unmeasured quantity is being
  reported as zero.
- `language-registry.ts:26-28` states *"Adding a language = adding one entry
  here + its grammar WASM"*. Measured, adding an entry adds nothing, because
  the path it feeds is unreachable.

The fix at the right choke point (§3, strength ladder) is to make the backend
lazily self-initialise, exactly as `quality/languages/shared/tree-sitter-loader.ts:150-169`
already does. The intelligence backend chose level 6 (a comment telling callers
to remember); the quality backend chose level 3-4 (the only door does it for
you). One of the two is right and it is already in this tree.

### 4.2 Awareness tree-sitter can never load

`awareness/languages/tree-sitter-base.ts:53-65` requires the native
`tree-sitter` npm package. It is not in `integration/package.json`, not in any
`node_modules` on the resolution path, and `require.resolve` fails. `tsAvailable()`
therefore caches `false` permanently, and:

- `python-tree-sitter.ts:224` → `analyzePythonFallback` (regex)
- `rust-tree-sitter.ts:168` → `analyzeRustFallback` (regex)
- `go-tree-sitter.ts:244` → `analyzeGoFallback` (regex)

100% of the time, in every environment.

The headers assert otherwise:
- `python-tree-sitter.ts:2` — *"Python adapter (tree-sitter) — REAL AST parser, no regex."*
- `tree-sitter-base.ts:12-15` — *"Per the user directive ('Real parsers, no regex'), Go/Python/Rust adapters MUST use a real parser. The line+regex adapters remain only as a fallback when the `tree-sitter` native binding is unavailable (e.g. a fresh clone before `npm install`)."*

`npm install` will never provide it, because it is not declared. The
"exceptional fallback" is the only path. **Every claim of real-parser awareness
for Python/Go/Rust is fabricated capability** — and it is reachable from the web
UI (`server/awareness-worker.ts:23`).

The `handleError` at `tree-sitter-base.ts:61` means the failure is recorded in
the debug system, so it is not literally silent — but nothing on the user path
sees it, and the emitted `FileAnalysis` carries no backend field, so a consumer
cannot tell regex output from AST output.

### 4.3 What the missing web-UI tree-sitter actually means

`web-interface-foundation-v1/package.json` dependencies: `nanostores`, `zod`.
No `web-tree-sitter`, no `tree-sitter-wasms`, no `tree-sitter`. `node_modules`
contains only `css-tree`, `estree-walker`, `symbol-tree` (unrelated).
`server/web-tree-sitter.d.ts:1-7` is a type-only shim stating the module is
absent and the runtime "falls back to regex-based extraction".

Per system:

- **Intelligence (reachable):** the missing package is currently *irrelevant*,
  because §4.1 means the code path stops before `import("web-tree-sitter")` is
  ever evaluated (`tree-sitter-backend.ts:114` is only reached from
  `ensureParserCtor`, called from `initTreeSitterBackend`/`ensureLanguage`).
  **This matters for sequencing: fixing §4.1 without installing the package in
  the web workspace would turn a silent empty result into a runtime
  `ERR_MODULE_NOT_FOUND` in the web server.** The workers run under
  `web-interface-foundation-v1`'s resolution root, so the fix must ship with
  the dependency or with an explicit, reported `absent` capability.
- **Awareness (reachable):** irrelevant — it wants the native package, which is
  missing in both workspaces. Regex either way.
- **Quality (not reachable from the web UI):** irrelevant today.

The shim's own claim — "the runtime falls back to regex extraction" — is
**false for intelligence**. Intelligence has no regex fallback for symbols; it
returns empty. The shim documents a graceful degradation that does not exist.

---

## 5. True language-support matrix, as measured

Backends: `TS-wasm` = web-tree-sitter WASM (installed in `integration/`),
`TS-native` = native `tree-sitter` (**not installed anywhere**),
`babel` = `@babel/parser`, `tok` = hand tokenizer, `regex`, `—` = no path.

**⚠ = silently degrades: reports a result that is empty or regex-derived while
being counted as a supported language.**

| Language | A. Symbols (intelligence) | B. Import graph (intelligence) | C. Quality checks (`quality/`) | D. Awareness signals | E. Syntax validation |
|---|---|---|---|---|---|
| TypeScript | tok ✅ | tok ✅ | babel ✅ *(tests only)* | babel ✅ | babel ✅ |
| JavaScript | tok ✅ | tok ✅ | babel ✅ *(tests only)* | babel ✅ | babel ✅ |
| Python | TS-wasm **⚠ empty** | regex **⚠ empty** | TS-wasm ✅ *(tests only)* | TS-native → **⚠ regex** | **⚠ none** |
| Go | TS-wasm **⚠ empty** | regex **⚠ empty** | TS-wasm ✅ *(tests only)* | TS-native → **⚠ regex** | **⚠ none** |
| Rust | TS-wasm **⚠ empty** | regex **⚠ empty** | TS-wasm ✅ *(tests only)* | TS-native → **⚠ regex** | **⚠ none** |
| Java | TS-wasm **⚠ empty** | regex **⚠ empty** | TS-wasm ✅ *(tests only)* | — (generic ⚠) | **⚠ none** |
| C | TS-wasm **⚠ empty** | regex **⚠ empty** | TS-wasm ✅ *(tests only)* | — (generic ⚠) | **⚠ none** |
| C++ | TS-wasm **⚠ empty** | regex **⚠ empty** | TS-wasm ✅ *(tests only)* | — (generic ⚠) | **⚠ none** |
| Ruby | TS-wasm **⚠ empty** | regex **⚠ empty** | — (skipped) | — (generic ⚠) | **⚠ none** |
| PHP | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| C# | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| Kotlin | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| Scala | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| Swift | TS-wasm **⚠ empty** | — (returns `[]` by design, `multi-import-extractor.ts:267`) | — | — (generic ⚠) | **⚠ none** |
| Lua | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| Elixir | TS-wasm **⚠ empty** | — (`:71`, by design) | — | — (generic ⚠) | **⚠ none** |
| Zig | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| Bash | TS-wasm **⚠ empty** | — (`:70`, by design) | — | generic ⚠ (`.sh` in `generic.ts:25`) | **⚠ none** |
| Dart | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| OCaml | TS-wasm **⚠ empty** | — (`:73`, by design) | — | — (generic ⚠) | **⚠ none** |
| Elm | TS-wasm **⚠ empty** | — (`:352`, by design) | — | — (generic ⚠) | **⚠ none** |
| ReScript | TS-wasm **⚠ empty** | regex **⚠ empty** | — | — (generic ⚠) | **⚠ none** |
| JSON | — | — | — | generic ⚠ | ✅ (`syntax-validator.ts:100-102`) |
| .md/.txt/.toml/.yaml/.ini/.cfg | — | — | — | generic ⚠ | — |

**Read the matrix honestly and the answer to "which languages do we support" is:
TypeScript and JavaScript. Everything else is either empty, regex-behind-an-AST-
label, or reachable only from a test.**

Note also (contract §3/§6): 14 grammars ship in `tree-sitter-wasms/out/` that
the registry never registers — `css`, `html`, `json`, `toml`, `yaml`, `vue`,
`tsx`, `solidity`, `objc`, `ql`, `tlaplus`, `elisp`, `systemrdl`,
`embedded_template`. The registry hardcodes 22 entries where the installed
grammar set could be **discovered**. A list someone must remember to update, in
the file whose job was to end such lists.

---

## 6. Proposed unified shape (contract §14)

```
integration/src/languages/                      ← THE language axis, one home
  core/                                         ── LAYER 1: AGNOSTIC, ONE OWNER
    registry.ts        discovery: readdirSync(../) → every folder exporting
                       `language.ts` IS a language. No authored list.
    extensions.ts      ext → id, DERIVED from the discovered specs. Deletes
                       all 7 tables in §3.1. Resolves the `.h` conflict once,
                       explicitly, with the reason recorded.
    metrics.ts         countLines, stripComment, tokenizeBody, complexity,
                       maxNestingDepth, magic-number scan — ONE definition
                       each. Deletes §3.3–§3.6. Thresholds/allowlists move to
                       bridlewise.config.json per §17.
    shapes.ts          the three normalised outputs, kept SEPARATE:
                       SymbolRecord[] | ParsedFile | FileAnalysis,
                       each carrying `provenance: { backend, complete }`.
    backends/                                   ── LAYER 2, INNER AXIS
      tree-sitter.ts   the ONE loader. Lazy self-init (the quality loader's
                       proven shape). Deletes the other two.
      babel.ts
      regex.ts         a first-class backend, explicitly selected and
                       explicitly reported — never an unannounced fallback.
      index.ts         probes which backends actually resolve at runtime and
                       answers `available(): BackendId[]`. Capability is
                       MEASURED, not declared.
  python/                                       ── LAYER 2, OUTER AXIS
    language.ts        spec: extensions, comment prefixes, capability claims
    tree-sitter.ts     node-type map + walkers for this language
    regex.ts           patterns for this language
    imports.ts
  go/  rust/  java/  c-cpp/  js-ts/  ruby/  php/  …
  index.ts                                      ── LAYER 3: THE ONE DOOR
```

**The one door** — a single module exporting two functions:

- `analyzeFile(path, source, want: Capability[]) → Result` where `Result`
  always carries `provenance: { backend: "tree-sitter"|"babel"|"regex"|"none",
  complete: boolean }`. Intelligence, quality and awareness each project the
  fields they need from one parse. A caller never names a language or a backend.
- `describeSupport() → (language × capability × backend)[]`, computed by asking
  `backends/index.ts` what actually resolves and each `language.ts` what it
  implements. **This is the artifact that makes §5 enforceable: the matrix in
  this document becomes a function, not a document, and it cannot lie because
  it is derived from what loads.** Expose it through one web endpoint so the
  UI shows the true matrix.

**How the cross-product resolves.** Today `awareness/languages/` flattens
language × backend into filenames: `go.ts` + `go-tree-sitter.ts`,
`python.ts` + `python-tree-sitter.ts`, `rust.ts` + `rust-tree-sitter.ts`
(6 files, 2 axes, growing multiplicatively — 22 languages × 3 backends would be
66 files in one directory). Under nesting the **outer axis becomes folders and
the inner becomes files inside them**:

```
before                          after
awareness/languages/go.ts              → languages/go/regex.ts
awareness/languages/go-tree-sitter.ts  → languages/go/tree-sitter.ts
quality/languages/go/parser.ts         → languages/go/tree-sitter.ts (merged)
intelligence registry `go` entry       → languages/go/language.ts
```

A third backend (say an LSP backend) adds ONE file to `core/backends/` and one
file per language that opts in — never a file to a flat directory, never an
edit to a switch. A language that lacks a backend simply has no such file, and
`describeSupport()` reports `absent` instead of pretending. Adding a language is
`mkdir languages/<id>/` + `language.ts`; the registry discovers it, the door
serves it, and no existing file is edited — the §14 layer-2 test.

**What each consumer keeps.** `intelligence/`, `quality/` and `awareness/` keep
their own output types, checks, signals and consumers. They lose only their
private parsers, their private tables and their private helpers. The three
distinct concerns stay three; the one duplicated concern becomes one.

---

## 7. Sequenced plan — one writer at a time, green after every step

Each step is independently verifiable, touches one system (except where noted),
and does not require the other two to move.

**Step 0 — Make the matrix mechanical (test only, no source change).**
Add a test that derives §5's matrix from source + runtime probes and asserts it
against a checked-in snapshot. It must assert on **provenance evidence**, not
on counts, and must FAIL if a language claims a backend that does not resolve.
Green immediately (the snapshot records today's ugly truth). Every later step
is now measurable, and the mutation-verification for steps 1-3 has a home.
*Verify: the test passes; hand-edit the snapshot to claim Python has
tree-sitter symbols → it fails.*

**Step 1 — Stop lying (all three systems, additive only, no behaviour change).**
Add `provenance: { backend, complete }` to the three result shapes and populate
it at the three existing exit points:
`intelligence/tree-sitter-extractor.ts:255` (`emptyResult` → `backend: "none"`),
`awareness/languages/*-tree-sitter.ts:224/168/244` (fallback → `backend: "regex"`),
`quality/languages/*/parser.ts` (→ `"tree-sitter"`/`"babel"`).
Nothing changes except that absence becomes visible. This is contract §5 and it
is the cheapest step that turns two silent failures into stated facts.
*Verify: a Python file analysed by awareness reports `backend: "regex"`;
a Python file analysed by intelligence reports `backend: "none", complete: false`.*
*Mutation (INERT shape): compute provenance and discard it — the test must
assert on the field's value at the consumer, not on its presence.*

**Step 2 — Fix the inert intelligence path (intelligence only).**
Make `tree-sitter-backend.ts` lazily self-initialising at its own choke point,
copying the shape already proven in
`quality/languages/shared/tree-sitter-loader.ts:150-169`. Delete the
`initTreeSitterBackend` contract from the caller's responsibility (level 6 →
level 3/4 on the strength ladder) and record in source why. This makes 20
languages produce real symbols and — via
`tree-sitter-extractor.ts:76` — real import edges for the first time.
**Blocker to resolve inside this step:** `web-tree-sitter` must be installed in
`web-interface-foundation-v1` or the door must report `absent` there; otherwise
the web workers move from empty results to a module-resolution crash.
*Verify: repository map over a Python fixture yields non-empty symbols with
`backend: "tree-sitter"`; dependency graph over a Python fixture yields edges.*
*Mutation: revert the lazy init → symbols empty again and Step 0's snapshot test
fails. Second mutation with a different shape: break the wasm dir resolution →
provenance must say `none`, never silently `tree-sitter`.*

**Step 3 — Resolve the awareness backend (awareness only).**
`tree-sitter` native is undeclared and unavailable. Two honest options:
(a) point the awareness adapters at the WASM backend that is already installed
and now self-initialising after Step 2, or (b) delete the three
`*-tree-sitter.ts` adapters and their headers' claims, leaving regex as the
declared backend. (a) is preferred — it removes a whole loader and makes the
"real parsers" claim true. Do NOT add the native dependency: a second parser
runtime for the same job is a second path (§2).
*Verify: awareness on a Python fixture reports `backend: "tree-sitter"` (a) or
`"regex"` with no AST claim anywhere in the source (b). Either outcome is green;
the current state — claiming AST, delivering regex — is not.*

**Step 4 — Deduplicate the agnostic metrics (cross-cutting, mechanical).**
Create `languages/core/metrics.ts` with ONE `countLines`, `stripComment`,
`tokenizeBody`, complexity, `maxNestingDepth`, and move `ALLOW_NUM`/`MAGIC_RE`
into `bridlewise.config.json` per §17. Redirect the 4 + 2 + 3 + 4 call sites
in §3.3–§3.6. **This step must resolve the `countLines` semantic disagreement
explicitly and record which semantics won and why** — it will change at least
one system's reported LOC by one, so do it in its own step where that is
visible. Fixes the already-drifted `tokenizeBody` in `go.ts` by deletion.
*Verify: a guard test asserts exactly one definition of each name across
`src/**` (mechanical, dynamic discovery — no hardcoded list).*
*Mutation: reintroduce a second `countLines` under a DIFFERENT name with the
same body → the guard must still catch it (assert on the class, not the string).*

**Step 5 — One registry, discovered not authored.**
Create `languages/core/registry.ts` + per-language `language.ts`. Collapse the
seven tables of §3.1 into it. Registry membership comes from `readdirSync`.
Resolve `.h` once. Register the 14 unregistered installed grammars or record in
source why they are excluded.
*Verify: a test asserts the discovered folder set equals the served language set,
so a folder that exists but is not reachable fails. Add a fixture folder →
it appears without editing any source file.*

**Step 6 — Nest the cross-product (awareness + quality file moves).**
Move `awareness/languages/{go,python,rust}.ts` → `languages/<lang>/regex.ts`,
`*-tree-sitter.ts` → `languages/<lang>/tree-sitter.ts`, and
`quality/languages/<lang>/parser.ts` into the same folders, merging the
duplicate per-language collectors identified in §3.7/§3.8. Use move, not
retype.
*Verify: a guard test asserts no path under `languages/**` encodes two axes —
no filename may contain `-tree-sitter`, `-regex`, `-babel`, or a language name
in a non-language folder.*

**Step 7 — The one door.**
`languages/index.ts` exports `analyzeFile` + `describeSupport`. Delete the
switch at `quality/languages/index.ts:22-45` and the `ADAPTERS` array at
`awareness/languages/index.ts:29-34`; both become projections over the door.
Retire `smart-edit/language.mjs` (no importers) and fold `quality-packs/`
language detection into the registry.
*Verify: a test asserts no module outside `languages/` imports a per-language
file directly; `describeSupport()` output equals Step 0's snapshot, which by
now says something true.*

**Step 8 — Expose it.**
One web endpoint serving `describeSupport()`, one UI surface showing the real
matrix in plain language (§7, §11). A user asking "does this work on my Go
repo" gets a measured answer.

**Why this order.** Steps 0-1 make the truth visible without changing
behaviour, so the later steps have a mechanical oracle. Steps 2-3 fix the two
capability lies, each inside one system. Only from Step 4 does anything
cross-cutting move, and by then every change is measurable against Step 0. No
step requires all three systems to change at once, and the first step requires
no source change at all.

---

## 8. Workflow finding (contract §20)

**The three loaders each documented their duplicate instead of importing it.**
`quality/languages/shared/tree-sitter-walker.ts:128` — *"matches `countLines` in
parsers/types.ts"*; `:139` — *"Mirrors `countBranchPoints` from parsers/types.ts
for parity"*; `awareness/languages/go.ts:15` — *"EXP387 fix"* applied to a local
copy while the shared original stayed broken. In every case an agent knew a
canonical version existed, named it in a comment, and copied anyway.

A comment asserting parity with another file is a **mechanically detectable
duplication signal**, and it is cheaper to grep than any AST clone detector.
Proposal: add a source-scan guard for the phrases `matches `…` in`,
`mirrors `…` from`, `same as … in`, `copy of`, `parity with` in comments, and
require either an import or an explicit recorded justification. It is a level-5
guard (the floor), but its scanning universe is the whole source tree with no
allowlist, which is exactly the condition under which level 5 has not failed
this project. It would have caught §3.3, §3.4 and §3.5 at authoring time.

Second, smaller: the `dead-export-scanner` allowlist
(`test/architecture/dead-export-scanner.test.ts:224,234`) is holding
`initTreeSitterSyntaxValidators` and `createLanguageAgnosticSyntaxValidatorRegistry`
as accepted-dead. Both are the ONLY initialisers of a capability the product
claims. An allowlist entry for a dead export should have to state what still
provides the capability the export was for; here nothing does, and the
allowlist made the gap invisible.

---

## COVERAGE — what I read and what I did not

**Read in full:**
`TIER1-AGENT-CONTRACT.md`;
`integration/src/intelligence/language-registry.ts` (495),
`tree-sitter-backend.ts` (231), `tree-sitter-extractor.ts` (262),
`multi-import-extractor.ts` (383), `symbol-extractor.ts:1-90` + `:668-678`;
`integration/src/quality/languages/index.ts` (66),
`shared/tree-sitter-loader.ts` (214), `python/parser.ts` (233),
`shared/tree-sitter-walker.ts:120-190`, `js-ts/parser.ts:1-40`;
`integration/src/awareness/languages/index.ts` (63), `tree-sitter-base.ts` (248),
`python-tree-sitter.ts` (249), `python.ts` (185), `generic.ts:1-30`,
`go.ts:1-60`, `rust.ts:1-22`, `language-helpers.ts:1-50`;
`integration/src/language-extensions.ts` (14);
`integration/src/quality/config.ts:80-95` + `:380-419`, `quality/base.ts:1-30`,
`quality/index.ts`; `integration/src/awareness/config.ts:335-360`,
`awareness/engine.ts:1-80` + dispatch at `:170-173`;
`integration/src/editor/syntax-validator.ts:100-160`;
`integration/src/smart-edit/language.mjs:1-60` + export list;
`integration/package.json`, `web-interface-foundation-v1/package.json`,
`server/web-tree-sitter.d.ts`.

**Verified by command, not by reading:** absence of native `tree-sitter` in all
three candidate `node_modules` roots and via `require.resolve`; the 36 installed
`.wasm` grammars; every importer claim in §1 (grep across `src/`, `test/`,
`scripts/` and the web `server/`, with `architecture-manifest.ts` excluded so
the manifest could not be mistaken for a consumer).

**NOT read — gaps in this analysis:**
- Bodies of `quality/languages/{go,rust,java,c-cpp}/parser.ts` (828 lines total).
  I read `python/parser.ts` in full and inferred the others' shape from their
  identical imports and structure. The §3.7 duplication claim is proven for
  Python and asserted-by-structure for Go/Rust/Java/C.
- Bodies of `awareness/languages/{go,rust}-tree-sitter.ts` beyond their
  fallback lines and imports.
- `awareness/languages/typescript.ts` beyond its first 20 lines, and the ~45
  `awareness/signals/*` modules — I did not check which signals silently
  produce meaningless output when fed regex-derived `FileAnalysis`. **That is a
  real open question: signals like clones, entropy and complexity-distribution
  consume `tokenStream` and `complexity`, which today come from three
  differently-drifted tokenisers.**
- `quality/checks/*` and `quality/signals/*` — not examined; the pack is
  test-only today so their behaviour does not affect the matrix.
- `intelligence/{quick-view,file-slice,exp474-retrieval,dependency-graph}.ts`
  beyond their imports. I confirmed `repository-map.ts:149` is the symbol
  entry point but did not trace whether quick-view has an independent
  extraction path.
- `quality-packs/typescript-pack.ts` (38 KB) and `bug-zoo.ts` (34 KB) —
  identified as a fifth system, not analysed.
- I did **not run any test suite, build, or install** (read-only constraint), so
  every "does not work" claim in §4 is derived from call-graph reading and
  module-resolution probes, not from observed runtime output. The three
  load-bearing derivations — no production caller of `initTreeSitterBackend`,
  no resolvable native `tree-sitter`, and the `isLanguageReady` early return —
  are each independently verifiable in under a minute and I recommend the
  first writer confirm them at runtime before acting on Step 2.
- I did not read `TASKS.md`, `SESSION-STATE.md`, `ALL-BUGS-AND-ISSUES.md` or
  `UNWIRED-INVENTORY.md`, so some findings here may already be recorded there
  under other IDs.
