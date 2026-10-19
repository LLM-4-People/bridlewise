/**
 * REACHABILITY — which files of a tree a set of entry points reaches, and
 * through which edges. The one owner of the walk (moved here from the
 * testing floor's product census; no copy remains): the promotion projection
 * (`promotion/projection.ts`) and the source-side boundary guard ask it, and
 * the floor's census is a call to it.
 *
 * The edges a module declares, read from its TOKENS
 * (`src/intelligence/js-tokenizer.ts`: a specifier in a comment or inside
 * another string is never an edge):
 *
 * - static `import`/`export … from`, side-effect `import "…"`, dynamic
 *   `import("…")`, `require("…")` and `import x = require("…")`;
 * - `new URL("…", import.meta.url)` — a worker or asset spawned by URL;
 * - `import.meta.glob("…")` (or an array of them; `{a,b}` alternatives
 *   expanded) — an import over a glob, expanded against the tree;
 * - a DECLARED spawn call (`{callee, argument, base}`: the string literal at
 *   that argument of that function names a script under `base`) — a runtime
 *   edge no import syntax expresses. A spawned script the walk may not enter
 *   (or the tree does not hold) is a conditional invocation, never an edge;
 * - a symbolic link reaches its target.
 *
 * A relative specifier resolves against its importer (the extension-less and
 * directory forms the toolchain accepts are tried in order; a `?query` suffix
 * is dropped); a `/`-rooted one against the tree's root; a path alias (a
 * tsconfig `paths` entry declared in a directory above the importer) to its
 * target; anything else names a package (a builtin is not recorded). What
 * the walk could not follow is reported, never dropped: an unresolved edge,
 * an edge into a path the caller excludes, an entry point the tree does not
 * hold, every package a reached module names, and every OPAQUE edge — one
 * whose target no literal names (`import(name)`, a computed glob or spawn
 * argument) or a glob that matches nothing.
 *
 * The walk starts from the entry points and from any `seeds` (modules the
 * caller ships without an edge — a promotion's included paths — whose own
 * edges must be judged like any reached module's).
 */
import { builtinModules } from "node:module";

import { deepFreeze } from "../kernel/integrity.ts";
import { tokenizeWithPositions, type Token } from "../intelligence/js-tokenizer.ts";

/** The source extensions a module the walk follows is written in, tried in order for an extension-less specifier. */
const REACHABLE_SOURCE_EXTENSIONS: readonly string[] = deepFreeze([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte"]);

/** A declared spawn call: the string literal at `argument` (0-based) of a call to `callee` names a script under `base`. */
export type SpawnCall = Readonly<{ callee: string; argument: number; base: string }>;

/** A path alias (a tsconfig `paths` entry): `pattern` (at most one `*`) maps to `targets`, repository-relative, for importers under `directory`. */
export type PathAlias = Readonly<{ directory: string; pattern: string; targets: readonly string[] }>;

export type ReachabilityInput = Readonly<{
  entryPoints: readonly string[];
  /** Further modules the walk starts from (shipped without an edge): walked like an entry, never reported missing, never given a `reachedFrom`. */
  seeds?: readonly string[];
  /** Every file path of the tree (the universe a glob edge expands over and a spawned script must belong to). */
  files: readonly string[];
  /** Whether the tree holds `path` (a specifier's resolution asks it); default: membership of `files`. */
  exists?: (path: string) => boolean;
  /** The texts of `paths` (batched: one call per walk round); `null` for a path the tree does not hold. */
  readTexts: (paths: readonly string[]) => ReadonlyMap<string, string | null>;
  /** A path the walk must never enter (the caller's exclusion): an edge into it is reported, not followed. */
  isExcluded?: (path: string) => boolean;
  spawnCalls?: readonly SpawnCall[];
  aliases?: readonly PathAlias[];
  /** The target of `path` when it is a symbolic link (its importer-relative text), else `null`: the walk follows the link to it. */
  linkTarget?: (path: string) => string | null;
}>;

export type ImportEdge = Readonly<{ importer: string; specifier: string }>;
/** An edge the walk cannot follow because no literal names its target (or its glob matches nothing): `detail` says which construct. */
export type OpaqueEdge = Readonly<{ importer: string; detail: string }>;
export type ExcludedEdge = Readonly<{ importer: string; specifier: string; target: string }>;

export type Reachability = Readonly<{
  /** Every reached path, entries included. */
  closure: ReadonlySet<string>;
  /** For every reached path but an entry: the module whose edge reached it first (the explain chain). */
  reachedFrom: ReadonlyMap<string, string>;
  /** Entry points the tree does not hold (or the walk may not enter). */
  missingEntries: readonly string[];
  /** Relative, rooted or aliased edges that name nothing the tree holds. */
  unresolved: readonly ImportEdge[];
  /** Import, URL and glob edges into an excluded path. */
  intoExcluded: readonly ExcludedEdge[];
  /** Every package a reached module names (builtins aside), with the module. */
  bareImports: readonly ImportEdge[];
  /** Every opaque edge of a reached module (see the header). */
  opaque: readonly OpaqueEdge[];
}>;

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Whether the walk parses `path` for edges: a script module, a Svelte component or a stylesheet. */
export function isWalkableModule(path: string): boolean {
  return path.endsWith(".css") || REACHABLE_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** The JS/TS text of a module the walk parses: a Svelte component's `<script>` blocks, a script module whole; `null` for anything else. */
function scriptText(path: string, text: string): string | null {
  if (path.endsWith(".svelte")) return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!).join("\n;\n");
  return REACHABLE_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) ? text : null;
}

/** The first token of argument `argument` (0-based) of the argument list opening at `tokens[open]` (a `(`), or `null` when the call has fewer. */
function argumentToken(tokens: readonly Token[], open: number, argument: number): Token | null {
  let depth = 0;
  let index = open + 1;
  for (let skipped = 0; skipped < argument; index += 1) {
    const token = tokens[index];
    if (token === undefined) return null;
    if (token.kind === "punctuation" && "([{".includes(token.value)) depth += 1;
    else if (token.kind === "punctuation" && ")]}".includes(token.value)) {
      if (depth === 0) return null;
      depth -= 1;
    } else if (token.kind === "punctuation" && token.value === "," && depth === 0) skipped += 1;
  }
  const token = tokens[index];
  return token === undefined || isToken(token, ")") ? null : token;
}

/** The literal a token spells: a string, or a template with no substitution; `null` for anything computed. */
function literalOf(token: Token | undefined | null): string | null {
  if (token?.kind === "string") return token.value;
  return token?.kind === "template" && !token.value.includes("${") ? token.value : null;
}

/** Whether the token after a `(` at `open` is a literal followed by the call's `)` or `,` (a whole-literal argument), and the literal. */
function wholeLiteral(tokens: readonly Token[], open: number): string | null {
  const literal = literalOf(tokens[open + 1]);
  return literal !== null && (isToken(tokens[open + 2], ")") || isToken(tokens[open + 2], ",")) ? literal : null;
}

const isToken = (token: Token | undefined, value: string): boolean => token !== undefined && token.kind !== "string" && token.kind !== "template" && token.value === value;
/** The tokens a static import or re-export may hold between its keyword and `from`. */
const BINDING_TOKEN = /^(?:[A-Za-z_$][\w$]*|[{},*])$/u;

/** The specifiers one module declares, by edge kind, and the edges no literal names (see the header). */
export type ModuleSpecifiers = Readonly<{ imports: readonly string[]; urls: readonly string[]; globs: readonly string[]; opaque: readonly string[] }>;

/**
 * The specifiers one module declares, by edge kind (see the header), read
 * from its TOKENS: a specifier in a comment or inside another string is never
 * an edge. A Svelte component's edges are its `<script>` blocks'; a
 * stylesheet's are its `@import`s.
 */
export function moduleSpecifiers(path: string, text: string): ModuleSpecifiers {
  const imports = new Set<string>();
  const urls = new Set<string>();
  const globs = new Set<string>();
  const opaque = new Set<string>();
  if (path.endsWith(".css")) {
    for (const match of text.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gu)) imports.add(match[1]!);
    return deepFreeze({ imports: [...imports], urls: [], globs: [], opaque: [] });
  }
  const script = scriptText(path, text);
  if (script === null) return deepFreeze({ imports: [], urls: [], globs: [], opaque: [] });
  const tokens = tokenizeWithPositions(script);
  tokens.forEach((token, index) => {
    if (token.kind !== "identifier" || isToken(tokens[index - 1], ".")) return;
    const next = tokens[index + 1];
    if (token.value === "import" && literalOf(next) !== null) imports.add(literalOf(next)!);
    else if ((token.value === "import" || token.value === "require") && isToken(next, "(")) {
      const literal = wholeLiteral(tokens, index + 1);
      if (literal !== null) imports.add(literal);
      // `require(` of a name declared elsewhere (`function require(`, a
      // method) is not CommonJS's; only a call at expression position is.
      else if (token.value === "import" || !isToken(tokens[index - 1], "function")) opaque.add(`${token.value}(<computed>)`);
    } else if (token.value === "import" && isToken(next, ".") && isToken(tokens[index + 2], "meta") && isToken(tokens[index + 3], ".")
      && (isToken(tokens[index + 4], "glob") || isToken(tokens[index + 4], "globEager")) && isToken(tokens[index + 5], "(")) {
      const literal = literalOf(tokens[index + 6]);
      if (literal !== null) globs.add(literal);
      else if (isToken(tokens[index + 6], "[")) {
        let cursor = index + 7;
        for (; literalOf(tokens[cursor]) !== null; cursor += isToken(tokens[cursor + 1], ",") ? 2 : 1) globs.add(literalOf(tokens[cursor])!);
        if (!isToken(tokens[cursor], "]")) opaque.add("import.meta.glob([<computed>])");
      } else opaque.add("import.meta.glob(<computed>)");
    } else if (token.value === "new" && isToken(next, "URL") && isToken(tokens[index + 2], "(") && literalOf(tokens[index + 3]) !== null
      && isToken(tokens[index + 4], ",") && isToken(tokens[index + 5], "import") && isToken(tokens[index + 6], ".") && isToken(tokens[index + 7], "meta")) urls.add(literalOf(tokens[index + 3])!);
    else if ((token.value === "import" || token.value === "export") && !isToken(next, "(") && !isToken(next, ".")) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const current = tokens[cursor]!;
        if (isToken(current, "from") && tokens[cursor + 1]?.kind === "string") {
          imports.add(tokens[cursor + 1]!.value);
          return;
        }
        // `import x = require("…")` (TypeScript's CommonJS import): the require is read on its own token.
        if (isToken(current, "=")) return;
        if (current.kind === "string" || current.kind === "template" || !BINDING_TOKEN.test(current.value)) return;
      }
    }
  });
  return deepFreeze({ imports: [...imports], urls: [...urls], globs: [...globs], opaque: [...opaque] });
}

/** The scripts one module spawns through the declared spawn calls, as repository paths (`base` + the string literal at the declared argument), and the declared calls whose argument no literal names. */
export function spawnedScripts(path: string, text: string, spawnCalls: readonly SpawnCall[]): Readonly<{ scripts: readonly string[]; opaque: readonly string[] }> {
  const script = spawnCalls.length === 0 ? null : scriptText(path, text);
  if (script === null) return deepFreeze({ scripts: [], opaque: [] });
  const tokens = tokenizeWithPositions(script);
  const scripts = new Set<string>();
  const opaque = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.kind !== "identifier" || !isToken(tokens[index + 1], "(") || isToken(tokens[index - 1], "function")) return;
    for (const call of spawnCalls) {
      if (token.value !== call.callee) continue;
      const argument = argumentToken(tokens, index + 1, call.argument);
      const literal = literalOf(argument);
      if (literal !== null) scripts.add(`${call.base}${literal}`);
      else if (argument !== null) opaque.add(`${call.callee}(…, <computed argument ${String(call.argument)}>)`);
    }
  });
  return deepFreeze({ scripts: [...scripts], opaque: [...opaque] });
}

/** `fromDirectory` + `relative`, with `.` and `..` segments resolved (repository-relative; never touches the filesystem). */
export function normalizeRepositoryPath(fromDirectory: string, relative: string): string {
  const normalized: string[] = [];
  for (const segment of `${fromDirectory}${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join("/");
}

/** The folder of a repository path, with its trailing `/` (`""` at the root). */
export function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/** The package a bare specifier names: its first segment, or its first two for a scope. */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") && segments[1] !== undefined ? `${segments[0]!}/${segments[1]}` : segments[0]!;
}

/** Whether `specifier` names a builtin module (`node:x`, or a bare builtin name). */
function isBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier) || BUILTINS.has(packageNameOf(specifier));
}

/** The globs a `{a,b}` alternative stands for (expanded recursively; a glob without braces is itself). */
function expandBraces(glob: string): readonly string[] {
  const match = /\{([^{}]*)\}/u.exec(glob);
  if (match === null) return [glob];
  return match[1]!.split(",").flatMap((alternative) => expandBraces(`${glob.slice(0, match.index)}${alternative}${glob.slice(match.index + match[0].length)}`));
}

/**
 * A glob (`*` within one segment, `**` across any depth — zero folders
 * included — and `{a,b}` alternatives), as a regular expression over
 * repository paths. Each segment carries its own separator, so `a/**\/*.ts`
 * matches `a/x.ts` and `a/b/c/x.ts` alike.
 */
function globPattern(glob: string): RegExp {
  const alternatives = expandBraces(glob).map((expanded) => {
    const segments = expanded.split("/");
    return segments.map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
      return `${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*")}${last ? "" : "/"}`;
    }).join("");
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`, "u");
}

/**
 * THE WALK (see the header). Breadth-first, one `readTexts` call per round,
 * so a commit-backed tree is read in a handful of batched processes.
 */
export function reachabilityClosure(input: ReachabilityInput): Reachability {
  const files = new Set(input.files);
  const exists = input.exists ?? ((path: string): boolean => files.has(path));
  const excluded = input.isExcluded ?? ((): boolean => false);
  const spawnCalls = input.spawnCalls ?? [];
  const aliases = input.aliases ?? [];
  const closure = new Set<string>();
  const reachedFrom = new Map<string, string>();
  const unresolved: ImportEdge[] = [];
  const intoExcluded: ExcludedEdge[] = [];
  const bareImports: ImportEdge[] = [];
  const opaque: OpaqueEdge[] = [];
  const missingEntries = input.entryPoints.filter((entry) => !exists(entry) || excluded(entry));

  /** Whether `base` names a directory of the tree (its root, or a folder some file sits under). */
  const isDirectory = (base: string): boolean => base === "" || input.files.some((path) => path.startsWith(`${base}/`));
  /** The first existing path among the toolchain's candidates for `base`. */
  const resolveBase = (base: string): string | null => {
    for (const candidate of [base, ...REACHABLE_SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`), ...REACHABLE_SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`)]) {
      if (exists(candidate)) return candidate;
    }
    return null;
  };
  const aliasBases = (importer: string, specifier: string): readonly string[] | null => {
    let best: Readonly<{ alias: PathAlias; captured: string }> | null = null;
    for (const alias of aliases) {
      if (!importer.startsWith(alias.directory)) continue;
      const star = alias.pattern.indexOf("*");
      const captured = star < 0
        ? (alias.pattern === specifier ? "" : null)
        : (specifier.startsWith(alias.pattern.slice(0, star)) && specifier.endsWith(alias.pattern.slice(star + 1)) ? specifier.slice(star, specifier.length - (alias.pattern.length - star - 1)) : null);
      if (captured === null) continue;
      if (best === null || alias.directory.length > best.alias.directory.length || alias.pattern.length > best.alias.pattern.length) best = { alias, captured };
    }
    return best === null ? null : best.alias.targets.map((target) => target.replace("*", best.captured));
  };

  let frontier: string[] = [];
  const reach = (path: string, from: string | null): void => {
    if (closure.has(path)) return;
    closure.add(path);
    if (from !== null) reachedFrom.set(path, from);
    frontier.push(path);
  };
  /** Follow one resolved edge: into the closure, or reported as an edge into an excluded path. */
  const follow = (importer: string, specifier: string, target: string): void => {
    if (excluded(target)) intoExcluded.push({ importer, specifier, target });
    else reach(target, importer);
  };
  for (const entry of input.entryPoints) if (!missingEntries.includes(entry)) reach(entry, null);
  for (const seed of input.seeds ?? []) if (exists(seed) && !excluded(seed)) reach(seed, null);

  while (frontier.length > 0) {
    const round = frontier;
    frontier = [];
    const texts = input.readTexts(round);
    for (const importer of round) {
      const text = texts.get(importer) ?? null;
      if (text === null) continue;
      const link = input.linkTarget?.(importer) ?? null;
      if (link !== null) {
        // A symbolic link: its one edge is its target (never parsed as a module).
        const resolved = resolveBase(link.startsWith("/") ? link.slice(1) : normalizeRepositoryPath(directoryOf(importer), link));
        if (resolved === null || link.startsWith("/")) unresolved.push({ importer, specifier: link });
        else follow(importer, link, resolved);
        continue;
      }
      const specifiers = moduleSpecifiers(importer, text);
      const { imports, urls, globs } = specifiers;
      for (const detail of specifiers.opaque) opaque.push({ importer, detail });
      for (const url of urls) {
        const base = url.startsWith("/") ? normalizeRepositoryPath("", url) : normalizeRepositoryPath(directoryOf(importer), url);
        const resolved = resolveBase(base);
        // A URL of a DIRECTORY (`new URL("../", import.meta.url)`: a root to
        // resolve against) names no module, so it is no edge.
        if (resolved !== null) follow(importer, url, resolved);
        else if (!isDirectory(base)) unresolved.push({ importer, specifier: url });
      }
      for (const specifier of imports) {
        const bare = specifier.split("?")[0]!;
        if (bare.startsWith(".") || bare.startsWith("/")) {
          const resolved = resolveBase(bare.startsWith("/") ? normalizeRepositoryPath("", bare) : normalizeRepositoryPath(directoryOf(importer), bare));
          if (resolved === null) unresolved.push({ importer, specifier });
          else follow(importer, specifier, resolved);
          continue;
        }
        const aliased = aliasBases(importer, bare);
        if (aliased !== null) {
          const resolved = aliased.map((base) => resolveBase(base)).find((path) => path !== null) ?? null;
          if (resolved === null) unresolved.push({ importer, specifier });
          else follow(importer, specifier, resolved);
          continue;
        }
        if (!isBuiltinSpecifier(bare)) bareImports.push({ importer, specifier: bare });
      }
      for (const glob of globs) {
        const pattern = globPattern(glob.startsWith("/") ? normalizeRepositoryPath("", glob) : normalizeRepositoryPath(directoryOf(importer), glob));
        const matched = input.files.filter((path) => pattern.test(path));
        if (matched.length === 0) opaque.push({ importer, detail: `import.meta.glob("${glob}") matches nothing` });
        for (const path of matched) follow(importer, glob, path);
      }
      const spawned = spawnedScripts(importer, text, spawnCalls);
      for (const detail of spawned.opaque) opaque.push({ importer, detail });
      for (const script of spawned.scripts) {
        if (files.has(script) && !excluded(script)) reach(script, importer);
      }
    }
  }
  return deepFreeze({
    closure,
    reachedFrom,
    missingEntries: deepFreeze([...missingEntries]),
    unresolved: deepFreeze(unresolved),
    intoExcluded: deepFreeze(intoExcluded),
    bareImports: deepFreeze(bareImports),
    opaque: deepFreeze(opaque),
  });
}

/** The import chain that reached `path` (entry first), from a walk's `reachedFrom`. */
export function reachabilityChain(reachability: Reachability, path: string): readonly string[] {
  const chain = [path];
  for (let current = reachability.reachedFrom.get(path); current !== undefined; current = reachability.reachedFrom.get(current)) chain.unshift(current);
  return deepFreeze(chain);
}
