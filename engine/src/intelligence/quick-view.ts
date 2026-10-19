import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

import { parse } from "@babel/parser";

import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { babelParserPluginsForSourcePath, jaccard, shingles, walkAst } from "../quality-packs/prevention/ast-helpers.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../shared/source-extensions.ts";

/**
 * Quick-view ALL edit locations for a symbol: "if I change X, show me
 * everywhere that needs to change" — no guessing, no grep, no read_file.
 *
 * This is the AST-based replacement for `grep` (EXP398 / EXP261). For a
 * function/class/type name, returns a structured LLM-optimized view of:
 * (a) definition — the symbol X itself (file, line, kind)
 * (b) callers — every CallExpression of X (file, line, context)
 * (c) clones — every near-duplicate of X (file, line, jaccard)
 * (d) type refs — every TSTypeReference to a type X defines/exports
 * (e) tests — every test file that calls X (file, line, context)
 * (f) docs — every doc line that mentions X (file, line, text)
 *
 * Measured (EXP398, babel 60 queries): quick_view is 137× faster than
 * ripgrep and emits 3.8× fewer tokens, with 99.8% completeness (it finds
 * MORE than rg because it dedups by (file,line) and includes direct +
 * member calls in one structured payload). The 0.2% gap is rg false
 * positives (comments + string-literal mentions that are NOT edit
 * locations).
 *
 * No code extracted from external sources; algorithms (AST walk for
 * CallExpression/TSTypeReference, Jaccard shingles for clones) are
 * textbook. The clone detector reuses the same Jaccard ≥ threshold
 * protocol as EXP154 / the D3 duplicate-body detector.
 *
 * Fallback policy: when the file is not a JS/TS source (no AST parser),
 * or when the parse fails, the index records zero entries for that file
 * and the caller (the model) is expected to fall back to `grep` via
 * `execute_command` for those files. The tool itself never silently
 * downgrades: a parse failure on a `.ts` file is recorded as
 * `parseErrors` in the index summary.
 */

import { DEFAULT_CLONE_JACCARD, DEFAULT_MIN_TOKENS, DEFAULT_CONTEXT_RADIUS, DEFAULT_DOC_TEXT_SLICE, DEFAULT_SHINGLE_K, DEFAULT_DOC_MIN_NAME_LENGTH, DEFAULT_MIN_BODY, DEFAULT_SOURCE_DIRECTORIES, DEFAULT_TEST_DIRECTORIES, DEFAULT_DOC_DIRECTORIES } from "./intelligence-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";
// Context radius 0 = one line (the call line itself), matching the EXP398
// "minimal ~50 tokens/location" design. The LLM gets the call line to
// understand the call site; if it needs the surrounding function body it
// calls `slice`. A 3-line context (radius 1) tripled the per-location
// token cost without improving the "find all edit locations" use case.

export type QuickViewLocation = Readonly<{
  file: string;
  line: number;
  reason: string;
  context?: string;
  kind?: string;
  jaccard?: number;
  text?: string;
}>;

export type QuickViewResult = Readonly<{
  name: string;
  totals: Readonly<{
    definition: number;
    callers: number;
    clones: number;
    typeRefs: number;
    tests: number;
    docs: number;
  }>;
  tokenEstimate: number;
  view: Readonly<{
    definition: readonly QuickViewLocation[];
    callers: readonly QuickViewLocation[];
    clones: readonly QuickViewLocation[];
    typeRefs: readonly QuickViewLocation[];
    tests: readonly QuickViewLocation[];
    docs: readonly QuickViewLocation[];
  }>;
}>;

export type QuickViewIndexOptions = Readonly<{
  cloneJaccard?: number;
  shingleK?: number;
  minTokens?: number;
  minBody?: number;
  contextRadius?: number;
  docMinNameLength?: number;
  docTextSlice?: number;
  /** Source directories scanned for the source-file partition (default
   * `DEFAULT_SOURCE_DIRECTORIES`). Single owner. */
  sourceDirectories?: readonly string[];
  /** Test directories scanned for the test-file partition (default
   * `DEFAULT_TEST_DIRECTORIES`). */
  testDirectories?: readonly string[];
  /** Documentation directories scanned for doc mentions (default
   * `DEFAULT_DOC_DIRECTORIES`). */
  docDirectories?: readonly string[];
}>;

export type QuickViewIndexSummary = Readonly<{
  srcFiles: number;
  testFiles: number;
  docFiles: number;
  srcFunctions: number;
  testFunctions: number;
  cloneEdges: number;
  parseErrors: number;
  parseErrorFiles: readonly string[];
}>;

type CollectedFn = Readonly<{
  path: string;
  name: string;
  line: number;
  nodeType: string;
  bodySize: number;
  normalizedTokens: readonly string[];
}>;

type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

/**
 * The serializable built state of a QuickViewIndex — everything `query`
 * reads, with the heavy `programByPath` AST cache + the lazy `fileLineCache`
 * DROPPED (they are not needed post-build: query reads the index Maps, and
 * line context is re-read lazily on the consumer thread). This is the shape
 * that crosses the worker→main-thread boundary (structured-cloneable: plain
 * objects, arrays, Maps serialized as [key, value] entry arrays — no
 * functions/proxies). The web UI builds a QuickViewIndex off-thread in a
 * worker, exports this state, and rehydrates it on the main thread so the
 * CPU-heavy full-codebase parse never blocks the event loop (Task 3 — the
 * same wedge class as the HTTP 502 map fix). Additive: the existing
 * constructor + query are unchanged.
 */
export type QuickViewBuiltState = Readonly<{
  root: string;
  config: Readonly<{
    cloneJaccard: number;
    shingleK: number;
    minTokens: number;
    minBody: number;
    contextRadius: number;
    docMinNameLength: number;
    docTextSlice: number;
  }>;
  fnById: readonly (readonly [string, CollectedFn])[];
  fnByName: readonly (readonly [string, readonly string[]])[];
  callSitesByName: readonly (readonly [string, readonly Readonly<{ file: string; line: number; kind: string }>[]])[];
  typeRefSitesByName: readonly (readonly [string, readonly Readonly<{ file: string; line: number }>[]])[];
  docMentionsByName: readonly (readonly [string, readonly Readonly<{ file: string; line: number; text: string }>[]])[];
  cloneByName: readonly (readonly [string, readonly Readonly<{ fnId: string; jaccard: number }>[]])[];
  srcRelFiles: readonly string[];
  testRelFiles: readonly string[];
  docRelFiles: readonly string[];
  summary: QuickViewIndexSummary;
}>;

export class QuickViewIndex {
  private readonly root: string;
  private readonly cloneJaccard: number;
  private readonly shingleK: number;
  private readonly minTokens: number;
  private readonly minBody: number;
  private readonly contextRadius: number;
  private readonly docMinNameLength: number;
  private readonly docTextSlice: number;
  private readonly fnById = new Map<string, CollectedFn>();
  private readonly fnByName = new Map<string, string[]>();
  private readonly programByPath = new Map<string, AstNode | null>();
  private readonly callSitesByName = new Map<string, Readonly<{ file: string; line: number; kind: string }>[]>();
  private readonly typeRefSitesByName = new Map<string, Readonly<{ file: string; line: number }>[]>();
  private readonly docMentionsByName = new Map<string, Readonly<{ file: string; line: number; text: string }>[]>();
  private readonly cloneByName = new Map<string, Readonly<{ fnId: string; jaccard: number }>[]>();
  private readonly fileLineCache = new Map<string, readonly string[] | null>();
  private readonly srcRelFiles: readonly string[];
  private readonly testRelFiles: readonly string[];
  private readonly docRelFiles: readonly string[];
  private readonly summary: QuickViewIndexSummary;

  constructor(root: string, options: QuickViewIndexOptions = {}) {
    if (typeof root !== "string" || root.length === 0) {
      throw new InputError("QuickViewIndex: root must be a non-empty string", "quick_view_root_empty");
    }
    this.root = root;
    this.cloneJaccard = options.cloneJaccard ?? DEFAULT_CLONE_JACCARD;
    this.shingleK = options.shingleK ?? DEFAULT_SHINGLE_K;
    this.minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
    this.minBody = options.minBody ?? DEFAULT_MIN_BODY;
    this.contextRadius = options.contextRadius ?? DEFAULT_CONTEXT_RADIUS;
    this.docMinNameLength = options.docMinNameLength ?? DEFAULT_DOC_MIN_NAME_LENGTH;
    this.docTextSlice = options.docTextSlice ?? DEFAULT_DOC_TEXT_SLICE;
    const sourceDirs = options.sourceDirectories ?? DEFAULT_SOURCE_DIRECTORIES;
    const testDirs = options.testDirectories ?? DEFAULT_TEST_DIRECTORIES;
    const docDirs = options.docDirectories ?? DEFAULT_DOC_DIRECTORIES;
    const srcAbs: string[] = [];
    for (const d of sourceDirs) listSourceFiles(join(root, d), srcAbs);
    const testAbs: string[] = [];
    for (const d of testDirs) listSourceFiles(join(root, d), testAbs);
    const docsAbs: string[] = [];
    for (const d of docDirs) listDocFiles(join(root, d), docsAbs);
    // AN EMPTY INDEX IS A REFUSAL, NOT AN EMPTY PROJECT.
    //
    // Each candidate directory is skipped individually when absent, which is
    // right: a project is not obliged to have every one of them. The UNION
    // being empty is a different statement, and answering it with an index of
    // zero files makes every later query return "no results" — a confident
    // answer about a project nobody read. A caller cannot tell that from a
    // genuine miss, which is the worse of the two failures, because it reports
    // success.
    //
    // Named directories, named root, and the way out, so the caller is not
    // asked to know an internal default they were never shown.
    if (srcAbs.length === 0 && testAbs.length === 0 && docsAbs.length === 0) {
      throw new InputError(
        `QuickViewIndex: no source, test or documentation files under ${root}. ` +
        `Looked for source in ${sourceDirs.join(", ")}; tests in ${testDirs.join(", ")}; ` +
        `documentation in ${docDirs.join(", ")}. Point the index at the project root, or pass ` +
        `sourceDirectories / testDirectories / docDirectories for this project's layout.`,
        "quick_view_no_sources",
      );
    }
    this.srcRelFiles = srcAbs.map((p) => relative(root, p));
    this.testRelFiles = testAbs.map((p) => relative(root, p));
    this.docRelFiles = docsAbs.map((p) => relative(root, p));
    this.summary = this.buildIndex();
  }

  getSummary(): QuickViewIndexSummary {
    return this.summary;
  }

  query(name: string): QuickViewResult {
    if (typeof name !== "string" || name.length === 0) {
      throw new InputError("QuickViewIndex.query: name must be a non-empty string", "quick_view_name_empty");
    }
    const definition = this.collectDefinition(name);
    const callers = this.collectCallers(name, false);
    const clones = this.collectClones(name);
    const typeRefs = this.collectTypeRefs(name);
    const tests = this.collectCallers(name, true);
    const docs = this.collectDocs(name);
    const view = { definition, callers, clones, typeRefs, tests, docs };
    const totals = {
      definition: definition.length,
      callers: callers.length,
      clones: clones.length,
      typeRefs: typeRefs.length,
      tests: tests.length,
      docs: docs.length,
    };
    return deepFreeze({
      name,
      totals,
      tokenEstimate: tokenEstimate(view),
      view,
    });
  }

  /**
   * Export the built index as a structured-cloneable state (Task 3). Drops
   * the heavy `programByPath` AST cache + the lazy `fileLineCache` (neither
   * is needed post-build). Used by the web UI worker to ship the built index
   * to the main thread without transferring class instances (which lose
   * their prototype methods under structured clone). Additive — the
   * constructor + query are unchanged.
   */
  toBuiltState(): QuickViewBuiltState {
    return Object.freeze({
      root: this.root,
      config: Object.freeze({
        cloneJaccard: this.cloneJaccard,
        shingleK: this.shingleK,
        minTokens: this.minTokens,
        minBody: this.minBody,
        contextRadius: this.contextRadius,
        docMinNameLength: this.docMinNameLength,
        docTextSlice: this.docTextSlice,
      }),
      fnById: [...this.fnById.entries()] as readonly (readonly [string, CollectedFn])[],
      fnByName: [...this.fnByName.entries()] as readonly (readonly [string, readonly string[]])[],
      callSitesByName: [...this.callSitesByName.entries()] as readonly (readonly [string, readonly Readonly<{ file: string; line: number; kind: string }>[]])[],
      typeRefSitesByName: [...this.typeRefSitesByName.entries()] as readonly (readonly [string, readonly Readonly<{ file: string; line: number }>[]])[],
      docMentionsByName: [...this.docMentionsByName.entries()] as readonly (readonly [string, readonly Readonly<{ file: string; line: number; text: string }>[]])[],
      cloneByName: [...this.cloneByName.entries()] as readonly (readonly [string, readonly Readonly<{ fnId: string; jaccard: number }>[]])[],
      srcRelFiles: this.srcRelFiles,
      testRelFiles: this.testRelFiles,
      docRelFiles: this.docRelFiles,
      summary: this.summary,
    }) as QuickViewBuiltState;
  }

  /**
   * Rehydrate a QuickViewIndex from a built state (Task 3) — bypasses the
   * constructor (no re-build) and pre-fills the index Maps the worker built
   * off-thread. `programByPath` is left empty (query never reads it) and
   * `fileLineCache` is left empty (line context is re-read lazily on the
   * consumer thread). The result behaves identically to a directly-built
   * index for all `query` calls. Additive — does not alter the constructor.
   *
   * The `private readonly` field guards are bypassed by building a plain
   * object with the fields as own properties and assigning the class
   * prototype (so the methods resolve). At runtime the methods read these
   * own properties via `this.*`.
   */
  static fromBuiltState(state: QuickViewBuiltState): QuickViewIndex {
    const obj: Record<string, unknown> = {
      root: state.root,
      cloneJaccard: state.config.cloneJaccard,
      shingleK: state.config.shingleK,
      minTokens: state.config.minTokens,
      minBody: state.config.minBody,
      contextRadius: state.config.contextRadius,
      docMinNameLength: state.config.docMinNameLength,
      docTextSlice: state.config.docTextSlice,
      fnById: new Map(state.fnById),
      fnByName: new Map(state.fnByName),
      callSitesByName: new Map(state.callSitesByName),
      typeRefSitesByName: new Map(state.typeRefSitesByName),
      docMentionsByName: new Map(state.docMentionsByName),
      cloneByName: new Map(state.cloneByName),
      // Not needed post-build: query reads the Maps above; line context is
      // re-read lazily by getLineContext on the consumer thread.
      programByPath: new Map(),
      fileLineCache: new Map(),
      srcRelFiles: state.srcRelFiles,
      testRelFiles: state.testRelFiles,
      docRelFiles: state.docRelFiles,
      summary: state.summary,
    };
    Object.setPrototypeOf(obj, QuickViewIndex.prototype);
    return obj as unknown as QuickViewIndex;
  }

  private buildIndex(): QuickViewIndexSummary {
    const allRel = [...this.srcRelFiles, ...this.testRelFiles];
    let parseErrors = 0;
    const parseErrorFiles: string[] = [];
    for (const rel of allRel) {
      const abs = join(this.root, rel);
      const program = this.parseFile(abs, rel);
      this.programByPath.set(rel, program);
      if (program === null) {
        parseErrors += 1;
        parseErrorFiles.push(rel);
      }
    }
    const srcFns = this.collectFunctions(this.srcRelFiles);
    const testFns = this.collectFunctions(this.testRelFiles);
    const allFns = [...srcFns, ...testFns];
    for (const f of allFns) {
      const id = `${f.path}:${f.name}:${f.line}`;
      this.fnById.set(id, f);
      if (!f.name || f.name === "<anonymous>") continue;
      const existing = this.fnByName.get(f.name);
      if (existing === undefined) this.fnByName.set(f.name, [id]);
      else existing.push(id);
    }
    this.indexCallSites();
    this.indexTypeRefs();
    this.indexDocs();
    const cloneEdges = this.indexClones(srcFns);
    return deepFreeze({
      srcFiles: this.srcRelFiles.length,
      testFiles: this.testRelFiles.length,
      docFiles: this.docRelFiles.length,
      srcFunctions: srcFns.length,
      testFunctions: testFns.length,
      cloneEdges,
      parseErrors,
      parseErrorFiles: deepFreeze(parseErrorFiles),
    });
  }

  private collectFunctions(relFiles: readonly string[]): CollectedFn[] {
    const out: CollectedFn[] = [];
    for (const rel of relFiles) {
      const program = this.programByPath.get(rel) ?? null;
      if (program === null) continue;
      const decls = extractTopLevelDecls(program);
      for (const d of decls) {
        out.push({
          path: rel,
          name: d.name,
          line: d.line,
          nodeType: d.nodeType,
          bodySize: d.bodySize,
          normalizedTokens: d.normalizedTokens,
        });
      }
    }
    return out;
  }

  private parseFile(abs: string, rel: string): AstNode | null {
    try {
      const content = readFileSync(abs, "utf8");
      const plugins = babelParserPluginsForSourcePath(rel);
      const parsed = parse(content, {
        sourceType: "module",
        errorRecovery: true,
        tokens: false,
        ranges: false,
        plugins: [...plugins],
      });
      return parsed.program as unknown as AstNode;
    } catch (e) {
      handleError(e, { module: "intelligence-quick-view", operation: "parseFile" });
      return null;
    }
  }

  private indexCallSites(): void {
    const allRel = [...this.srcRelFiles, ...this.testRelFiles];
    for (const rel of allRel) {
      const prog = this.programByPath.get(rel);
      if (!prog) continue;
      walkAst(prog, (n) => {
        if (n.type !== "CallExpression") return;
        const callee = n.callee as AstNode | undefined;
        if (!callee) return;
        if (callee.type === "Identifier" && callee.name) {
          const l = callee.loc as { start: { line: number } } | undefined;
          if (!l) return;
          this.pushCallSite(callee.name as string, { file: rel, line: l.start.line, kind: "direct" });
        } else if (callee.type === "MemberExpression" && (callee.property as AstNode | undefined)?.type === "Identifier") {
          const prop = callee.property as AstNode;
          const l = prop.loc as { start: { line: number } } | undefined;
          if (!l) return;
          this.pushCallSite(prop.name as string, { file: rel, line: l.start.line, kind: "member" });
        }
      });
    }
  }

  private pushCallSite(name: string, rec: Readonly<{ file: string; line: number; kind: string }>): void {
    const existing = this.callSitesByName.get(name);
    if (existing === undefined) this.callSitesByName.set(name, [rec]);
    else existing.push(rec);
  }

  private indexTypeRefs(): void {
    const allRel = [...this.srcRelFiles, ...this.testRelFiles];
    for (const rel of allRel) {
      const prog = this.programByPath.get(rel);
      if (!prog) continue;
      walkAst(prog, (n) => {
        if (n.type !== "TSTypeReference") return;
        const typeName = n.typeName as AstNode | undefined;
        if (!typeName) return;
        let name: string | null = null;
        if (typeName.type === "Identifier") name = typeName.name as string;
        else if (typeName.type === "TSQualifiedName") {
          let cur: AstNode = typeName;
          while ((cur.left as AstNode | undefined)?.type === "TSQualifiedName") cur = cur.left as AstNode;
          const left = cur.left as AstNode | undefined;
          name = (left?.name as string | undefined) ?? (cur.name as string | undefined) ?? null;
        }
        if (!name) return;
        const l = typeName.loc as { start: { line: number } } | undefined;
        if (!l) return;
        const existing = this.typeRefSitesByName.get(name);
        const rec = { file: rel, line: l.start.line };
        if (existing === undefined) this.typeRefSitesByName.set(name, [rec]);
        else existing.push(rec);
      });
    }
  }

  private indexDocs(): void {
    for (const rel of this.docRelFiles) {
      const abs = join(this.root, rel);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch (e) {handleError(e, { module: "intelligence-quick-view", operation: "catch" });
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const name = m[0];
          if (name.length < this.docMinNameLength) continue;
          const rec = { file: rel, line: i + 1, text: line.trim().slice(0, this.docTextSlice) };
          const existing = this.docMentionsByName.get(name);
          if (existing === undefined) this.docMentionsByName.set(name, [rec]);
          else existing.push(rec);
        }
      }
    }
  }

  private indexClones(srcFns: readonly CollectedFn[]): number {
    const eligible = srcFns.filter(
      (f) => f.bodySize >= this.minBody && f.normalizedTokens.length >= this.minTokens,
    );
    const eligId = eligible.map((f) => `${f.path}:${f.name}:${f.line}`);
    const shingleSets = eligible.map((f) => shingles(f.normalizedTokens, this.shingleK));
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < shingleSets.length; i++) {
      for (const s of shingleSets[i]!) {
        const list = buckets.get(s);
        if (list === undefined) buckets.set(s, [i]);
        else list.push(i);
      }
    }
    const pairSet = new Set<string>();
    for (const [, ids] of buckets) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i]!;
          const b = ids[j]!;
          pairSet.add(a < b ? `${a}:${b}` : `${b}:${a}`);
        }
      }
    }
    let edgeCount = 0;
    for (const key of pairSet) {
      const [a, b] = key.split(":").map(Number) as [number, number];
      const j = jaccard(shingleSets[a]!, shingleSets[b]!);
      if (j >= this.cloneJaccard) {
        edgeCount += 1;
        const idA = eligId[a]!;
        const idB = eligId[b]!;
        for (const [from, to] of [[idA, idB], [idB, idA]] as const) {
          const fn = this.fnById.get(from);
          if (!fn || !fn.name || fn.name === "<anonymous>") continue;
          const rec = { fnId: to, jaccard: j };
          const existing = this.cloneByName.get(fn.name);
          if (existing === undefined) this.cloneByName.set(fn.name, [rec]);
          else existing.push(rec);
        }
      }
    }
    return edgeCount;
  }

  private collectDefinition(name: string): QuickViewLocation[] {
    const ids = this.fnByName.get(name) ?? [];
    const out: QuickViewLocation[] = [];
    for (const id of ids) {
      const f = this.fnById.get(id);
      if (!f) continue;
      out.push({ file: f.path, line: f.line, kind: f.nodeType, reason: "definition" });
    }
    return out;
  }

  private collectCallers(name: string, testOnly: boolean): QuickViewLocation[] {
    const sites = this.callSitesByName.get(name) ?? [];
    // Both direct calls (`parse(x)`) and member calls (`this.parse(x)`,
    // `obj.parse(x)`) are edit locations when the method signature changes,
    // so we count both. The `kind` field is preserved in the raw index for
    // callers that want to distinguish.
    const filtered = sites.filter((c) =>
      testOnly ? c.file.startsWith("test/") : !c.file.startsWith("test/"),
    );
    const seen = new Set<string>();
    const out: QuickViewLocation[] = [];
    for (const c of filtered) {
      const key = `${c.file}:${c.line}:${c.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        file: c.file,
        line: c.line,
        context: this.getLineContext(c.file, c.line).map((l) => `${l.line}: ${l.text}`).join("\n"),
        reason: testOnly ? "test-call" : (c.kind === "member" ? "member-call" : "call-site"),
      });
    }
    return out;
  }

  private collectClones(name: string): QuickViewLocation[] {
    const clones = this.cloneByName.get(name) ?? [];
    const out: QuickViewLocation[] = [];
    for (const c of clones) {
      const f = this.fnById.get(c.fnId);
      if (!f) continue;
      out.push({ file: f.path, line: f.line, jaccard: +c.jaccard.toFixed(3), reason: "near-duplicate" });
    }
    return out;
  }

  private collectTypeRefs(name: string): QuickViewLocation[] {
    const sites = this.typeRefSitesByName.get(name) ?? [];
    return sites.map((t) => ({ file: t.file, line: t.line, reason: "type-reference" }));
  }

  private collectDocs(name: string): QuickViewLocation[] {
    const mentions = this.docMentionsByName.get(name) ?? [];
    const seen = new Set<string>();
    const out: QuickViewLocation[] = [];
    for (const d of mentions) {
      const key = `${d.file}:${d.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: d.file, line: d.line, text: d.text, reason: "doc-mention" });
    }
    return out;
  }

  private getLineContext(rel: string, line: number): Readonly<{ line: number; text: string }[]> {
    if (!this.fileLineCache.has(rel)) {
      const abs = join(this.root, rel);
      try {
        const content = readFileSync(abs, "utf8");
        this.fileLineCache.set(rel, content.split("\n"));
      } catch (e) {handleError(e, { module: "intelligence-quick-view", operation: "catch" });
        this.fileLineCache.set(rel, null);
      }
    }
    const lines = this.fileLineCache.get(rel);
    if (!lines) return [];
    const out: { line: number; text: string }[] = [];
    const start = Math.max(0, line - this.contextRadius);
    const end = Math.min(lines.length - 1, line + this.contextRadius);
    for (let i = start; i <= end; i++) {
      out.push({ line: i + 1, text: lines[i] ?? "" });
    }
    return out;
  }
}

export function extractNameFromQuery(nl: string): string | null {
  if (!nl) return null;
  const bt = /`([A-Za-z_$][A-Za-z0-9_$]*)`/.exec(nl);
  if (bt) return bt[1] ?? null;
  const cc = /\b([A-Z][a-zA-Z0-9]{3,})\b/.exec(nl);
  if (cc) return cc[1] ?? null;
  const camel = /\b([a-z][a-zA-Z0-9]{5,})\b/.exec(nl);
  if (camel) return camel[1] ?? null;
  return null;
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".git")) continue;
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch (e) {handleError(e, { module: "intelligence-quick-view", operation: "catch" });
      continue;
    }
    if (s.isDirectory()) listSourceFiles(p, acc);
    else if (ARCHITECTURE_SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) acc.push(p);
  }
  return acc;
}

function listDocFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".git")) continue;
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch (e) {handleError(e, { module: "intelligence-quick-view", operation: "catch" });
      continue;
    }
    if (s.isDirectory()) listDocFiles(p, acc);
    else if (name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

type TopLevelDecl = Readonly<{
  name: string;
  line: number;
  nodeType: string;
  bodySize: number;
  normalizedTokens: readonly string[];
}>;

function extractTopLevelDecls(program: AstNode): TopLevelDecl[] {
  const out: TopLevelDecl[] = [];
  const body = (program.body as AstNode[] | undefined) ?? [];
  for (const node of body) {
    collectDecl(node, out);
  }
  return out;
}

function collectDecl(node: AstNode | undefined, out: TopLevelDecl[]): void {
  if (!node) return;
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      const name = (node.id as AstNode | undefined)?.name as string | undefined;
      if (!name) return;
      out.push(makeDecl(node, name, node.type));
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const name = (node.id as AstNode | undefined)?.name as string | undefined;
      if (name) out.push(makeDecl(node, name, node.type));
      // Also collect class methods (e.g. babel-parser's `parse`, `finishToken`
      // are methods of the Parser class). A method's "name" is the property
      // key; methods are edit locations too (changing a method signature
      // requires editing every caller of `this.method`).
      const classBody = (node.body as AstNode | undefined)?.body as AstNode[] | undefined;
      if (classBody) {
        for (const member of classBody) {
          if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") {
            const key = member.key as AstNode | undefined;
            const memberName = key?.name as string | undefined ?? (key?.value as string | undefined);
            if (memberName) out.push(makeDecl(member, memberName, "method"));
          }
        }
      }
      return;
    }
    case "VariableDeclaration": {
      const decls = (node.declarations as AstNode[] | undefined) ?? [];
      for (const decl of decls) {
        const init = decl?.init as AstNode | undefined;
        if (!init) continue;
        const id = (decl?.id as AstNode | undefined);
        const name = id?.name as string | undefined;
        if (!name) continue;
        if (
          init.type === "ArrowFunctionExpression" ||
          init.type === "FunctionExpression" ||
          init.type === "ClassExpression"
        ) {
          out.push(makeDecl(init, name, init.type));
        }
      }
      return;
    }
    case "ExportNamedDeclaration": {
      collectDecl(node.declaration as AstNode | undefined, out);
      return;
    }
    case "ExportDefaultDeclaration": {
      collectDecl(node.declaration as AstNode | undefined, out);
      return;
    }
    default:
      return;
  }
}

function makeDecl(node: AstNode, name: string, nodeType: string): TopLevelDecl {
  const loc = (node.loc as { start: { line: number }; end: { line: number } } | undefined);
  const line = loc?.start.line ?? 0;
  const bodySize = loc ? Math.max(0, loc.end.line - loc.start.line) : 0;
  const normalizedTokens = tokenizeNormalized(node);
  return deepFreeze({ name, line, nodeType, bodySize, normalizedTokens });
}

function tokenizeNormalized(node: AstNode): string[] {
  const tokens: string[] = [];
  walkAst(node, (n) => {
    if (n.type === "Identifier" && typeof n.name === "string") tokens.push(n.name);
    else if (n.type === "StringLiteral") tokens.push("STR");
    else if (n.type === "NumericLiteral") tokens.push("NUM");
    else if (n.type === "BooleanLiteral") tokens.push("BOOL");
  });
  return tokens;
}

function tokenEstimate(view: unknown): number {
  return Math.ceil(JSON.stringify(view).length / 4);
}
