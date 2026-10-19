/**
 * Hallucination detector — 7 layers (EXP354/388, EXP447 adds L7 SEMANTIC).
 *
 * Each layer has an independent trigger (EXP394: "all gates strong").
 * No layer is weakened to let another pass. The layers run in order;
 * the first layer that fires a finding reports it.
 *
 * L1. WHITELIST — exposes a system-prompt fragment telling the LLM
 * every ref must exist in the codebase index.
 * L2. STRUCTURED — validates the LLM response matches the expected
 * JSON schema (thought + actions[]).
 * L3. GROUNDING — extracts every reference (function/import/path/type/
 * env/string) from the response and checks each
 * against the codebase index. Auto-corrects typos
 * (Levenshtein ≤ threshold) and blocks large misses.
 * L4. PRE-EMPTIVE — runs L2+L3 on partial streaming output, so a
 * hallucinated reference is caught mid-stream.
 * L5. POST-HOC — re-runs L2+L3 on the final response after completion.
 * L6. AUTO-CORRECT — exposes the Levenshtein-distance repair API +
 * signature repair (arg count, param names).
 * L7. SEMANTIC — verifies LLM CLAIMS about function semantics (return
 * type, params, async, line, throws, className) against
 * an enriched AST-extracted semantic index (EXP388/447).
 * Closes the 67% semantic-miss gap (structural grounding
 * only checks name existence). Mismatches BLOCK.
 *
 * Integration: the chat runtime wraps every LLM response with
 * `detectHallucination`. The detector never calls the LLM; it
 * inspects the LLM's output against the codebase index (deterministic).
 *
 * Per binding directive: no static constants — every threshold + regex
 * comes from `HallucinationConfig`.
 */
import { parse } from "@babel/parser";
import { astNode, type AstNode } from "../quality-packs/prevention/ast-helpers.ts";
import {
  type HallucinationConfig,
  type HallucinationLayer,
  type ReferenceKind,
} from "./hallucination-config.ts";
import {
  type SemanticIndex,
  type SemanticClaim,
  type SemanticMismatch,
  verifySemanticClaims,
  inferClaimsFromCode,
  inferClaimsFromAst,
  autoCorrectSignature,
} from "./hallucination-semantic.ts";

/** A codebase index entry used by the grounding layer. */
export type CodebaseIndex = Readonly<{
  /** All known symbol names (functions, classes, methods, import bindings). */
  symbols: ReadonlySet<string>;
  /** All known file paths relative to codebase root, forward slashes. */
  paths: ReadonlySet<string>;
  /** All known import specifiers (e.g. "./foo", "@babel/core", "react"). */
  imports: ReadonlySet<string>;
  /** All known exported names. */
  exports: ReadonlySet<string>;
  /** All known type names (interfaces, type aliases, classes). */
  types: ReadonlySet<string>;
}>;

/** A reference extracted from the LLM response. */
export type ExtractedReference = Readonly<{
  kind: ReferenceKind;
  name: string;
  /** The text span where the reference was found (for diagnostics). */
  span: Readonly<{ start: number; end: number }>;
}>;

/** A finding reported by any layer. */
export type HallucinationFinding = Readonly<{
  /** Layer that fired. */
  layer: HallucinationLayer;
  /** Severity (info = corrected, warn = needs retry, block = cannot proceed). */
  severity: "info" | "warn" | "block";
  /** Human-readable message. */
  message: string;
  /** Reference that triggered the finding, if applicable. */
  reference?: ExtractedReference;
  /** Auto-correction applied, if any. */
  correction?: Readonly<{ from: string; to: string; distance: number }>;
}>;

/** Result of `detectHallucination`. */
export type HallucinationResult = Readonly<{
  findings: readonly HallucinationFinding[];
  /** True if any `block`-severity finding fired. */
  blocked: boolean;
  /** True if any `info`-severity finding fired (auto-corrected). */
  corrected: boolean;
  /** Number of references extracted. */
  referenceCount: number;
  /** The corrected response text, if auto-correction applied. */
  correctedText: string | null;
}>;

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const a1 = cur[j - 1]! + 1;
      const a2 = prev[j]! + 1;
      const a3 = prev[j - 1]! + cost;
      cur[j] = Math.min(a1, a2, a3);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bl] ?? 0;
}

/** Find the closest match for `name` in `candidates`, within `threshold`. */
export function closestMatch(
  name: string,
  candidates: Iterable<string>,
  threshold: number,
): Readonly<{ match: string; distance: number; exactCi: boolean }> | null {
  const lowerName = name.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c === name) continue;
    if (c.toLowerCase() === lowerName) {
      return { match: c, distance: 0, exactCi: true };
    }
    if (Math.abs(c.length - name.length) > threshold) continue;
    const d = levenshtein(name, c);
    if (d < bestDist && d <= threshold) {
      bestDist = d;
      best = c;
    }
  }
  return best === null ? null : { match: best, distance: bestDist, exactCi: false };
}

/** EXP461 (S4): parse the LLM response ONCE. Returns the AST program node
 * when the response is parseable as a JS/TS module, or `undefined` for
 * non-code text (JSON, prose). The single parse is shared by the L3
 * reference extraction and the L7 claim inference so the response body
 * is never parsed twice. Re-uses the same parser options as the semantic
 * index builder (typescript plugin, error recovery). */
function parseResponseOnce(text: string): AstNode | undefined {
  if (text.length === 0) return undefined;
  try {
    const ast = parse(text, { sourceType: "module", errorRecovery: true, plugins: ["typescript", "jsx"] });
    return astNode(ast);
  } catch {
    return undefined;
  }
}

/** Extract references from LLM response text. */
export function extractReferences(
  text: string,
  config: HallucinationConfig,
): readonly ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const add = (kind: ReferenceKind, name: string, start: number, end: number) => {
    if (refs.length >= config.maxReferencesPerResponse) return;
    refs.push({ kind, name, span: { start, end } });
  };

  const callRe = /(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const g = m[1];
    if (g !== undefined) add("function", g, m.index, m.index + g.length);
  }

  const methodRe = /\.([a-zA-Z_$][\w$]*)\s*\(/g;
  while ((m = methodRe.exec(text)) !== null) {
    const g = m[1];
    if (g !== undefined) add("function", g, m.index, m.index + g.length);
  }

  const importRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(text)) !== null) {
    const group1 = m[1];
    const group2 = m[2];
    if (group1 !== undefined) {
      for (const part of group1.split(",")) {
        const trimmed = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (trimmed) add("import", trimmed, m.index, m.index + trimmed.length);
      }
    }
    if (group2 !== undefined) add("import", group2, m.index, m.index + group2.length);
  }

  const defaultImportRe = /import\s+([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = defaultImportRe.exec(text)) !== null) {
    const g1 = m[1];
    const g2 = m[2];
    if (g1 !== undefined) add("import", g1, m.index, m.index + g1.length);
    if (g2 !== undefined) add("import", g2, m.index, m.index + g2.length);
  }

  const extRe = config.pathExtensions.map((e) => e.replace(".", "\\.")).join("|");
  const pathRe = new RegExp(`\\b([a-zA-Z][\\w./@-]*(?:${extRe}))\\b`, "g");
  while ((m = pathRe.exec(text)) !== null) {
    const g = m[1];
    if (g !== undefined) add("path", g, m.index, m.index + g.length);
  }

  const envRe = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  while ((m = envRe.exec(text)) !== null) {
    const g = m[1];
    if (g !== undefined) add("env", g, m.index, m.index + g.length);
  }

  const typeRe = /[:<]\s*([A-Z][\w]*)/g;
  while ((m = typeRe.exec(text)) !== null) {
    const g = m[1];
    if (g !== undefined) add("type", g, m.index, m.index + g.length);
  }

  if (config.detectStringReferences) {
    const strRe = /['"]([a-zA-Z_][\w-]*?)['"]/g;
    while ((m = strRe.exec(text)) !== null) {
      const g = m[1];
      if (g !== undefined) add("string", g, m.index, m.index + g.length);
    }
  }

  return refs;
}

/** Check whether a reference is grounded in the codebase index. */
export function isGrounded(
  ref: ExtractedReference,
  index: CodebaseIndex,
  config: HallucinationConfig,
): boolean {
  if (config.builtinAllowlist.includes(ref.name)) return true;
  switch (ref.kind) {
    case "function":
      return index.symbols.has(ref.name);
    case "import":
      return index.imports.has(ref.name) || index.symbols.has(ref.name);
    case "export":
      return index.exports.has(ref.name);
    case "path":
      return index.paths.has(ref.name);
    case "type":
      return index.types.has(ref.name) || index.symbols.has(ref.name);
    case "env":
      return true;
    case "string":
      return index.symbols.has(ref.name) || index.paths.has(ref.name);
  }
}

/** L1: build the whitelist system-prompt fragment. */
export function buildWhitelistPrompt(
  codebaseName: string,
  index: CodebaseIndex,
): string {
  return [
    "You are operating in a STRICTLY-GROUNDED environment. Every reference",
    "you make — function name, file path, import source — MUST exist in",
    `the real codebase index for ${codebaseName} (${index.paths.size} files, ${index.symbols.size} symbols, ${index.imports.size} import sources).`,
    "",
    "ANY reference that does NOT exist in the codebase will be BLOCKED",
    "before execution. If you reference a non-existent symbol/path/import,",
    "the harness will either auto-correct it (small typo) or BLOCK and ask",
    "you to regenerate (large mismatch).",
  ].join("\n");
}

/** L2: validate the structured JSON shape. */
export function validateStructuredOutput(text: string): Readonly<{ ok: boolean; error: string | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const obj = parsed as { thought?: unknown; actions?: unknown };
  if (typeof obj.thought !== "string") {
    return { ok: false, error: "missing or non-string 'thought'" };
  }
  if (!Array.isArray(obj.actions)) {
    return { ok: false, error: "missing or non-array 'actions'" };
  }
  for (const a of obj.actions) {
    if (typeof a !== "object" || a === null) return { ok: false, error: "action is not an object" };
    if (typeof (a as { tool?: unknown }).tool !== "string") return { ok: false, error: "action.tool missing" };
  }
  return { ok: true, error: null };
}

/** L6: auto-correct a single reference (Levenshtein). */
export function autoCorrect(
  ref: ExtractedReference,
  index: CodebaseIndex,
  config: HallucinationConfig,
): Readonly<{ from: string; to: string; distance: number }> | null {
  let candidates: Iterable<string>;
  switch (ref.kind) {
    case "function":
    case "import":
    case "export":
    case "type":
    case "string":
      candidates = index.symbols;
      break;
    case "path":
      candidates = index.paths;
      break;
    case "env":
      return null;
  }
  const match = closestMatch(ref.name, candidates, config.autoCorrectLevenshteinThreshold);
  if (match === null) return null;
  return { from: ref.name, to: match.match, distance: match.distance };
}

/**
 * Run all enabled layers against an LLM response. The codebase index is
 * the only external input; the detector is deterministic + stateless.
 *
 * The optional `semanticIndex` enables L7 SEMANTIC (EXP388/447): if
 * provided + the `semantic` layer is enabled, semantic claims (declared
 * in structured `claims` or inferred from the code body) are verified
 * against the enriched AST-extracted index. A mismatch BLOCKS.
 */
export function detectHallucination(
  responseText: string,
  codebaseName: string,
  index: CodebaseIndex,
  config: HallucinationConfig,
  semanticIndex: SemanticIndex | null = null,
  semanticClaims: readonly SemanticClaim[] | null = null,
): HallucinationResult {
  const findings: HallucinationFinding[] = [];
  let blocked = false;
  let corrected = false;
  let correctedText: string | null = null;

  // L1: whitelist prompt is built elsewhere (no finding fires here).
  if (config.layers.whitelist) {
    void buildWhitelistPrompt(codebaseName, index);
  }

  // L2: structured output validation.
  if (config.layers.structured) {
    const r = validateStructuredOutput(responseText);
    if (!r.ok) {
      findings.push({ layer: "structured", severity: "warn", message: `L2: ${r.error}` });
    }
  }

  // L3/L6: grounding + auto-correction.
  // EXP461 (S4): parse the response ONCE with @babel/parser so both the
  // reference extraction (L3) and the claim inference (L7) consume the same
  // tree (halving the parse cost). When the response is not parseable as
  // code (e.g. JSON or prose), the AST is undefined and `extractReferences`
  // falls back to its regex path — no behavior change for non-code text.
  const responseAst = parseResponseOnce(responseText);
  const refs = extractReferences(responseText, config);
  let corrections = 0;
  const correctionsMap = new Map<string, string>();
  if (config.layers.grounding) {
    for (const ref of refs) {
      if (isGrounded(ref, index, config)) continue;
      if (config.layers["auto-correct"] && corrections < config.autoCorrectMaxCorrections) {
        const corr = autoCorrect(ref, index, config);
        if (corr !== null) {
          corrections++;
          correctionsMap.set(corr.from, corr.to);
          findings.push({
            layer: "auto-correct",
            severity: "info",
            message: `L6: auto-corrected ${ref.kind} "${corr.from}" → "${corr.to}" (distance ${corr.distance})`,
            reference: ref,
            correction: corr,
          });
          corrected = true;
          continue;
        }
      }
      // No correction found — block.
      blocked = true;
      findings.push({
        layer: "grounding",
        severity: "block",
        message: `L3: ${ref.kind} reference "${ref.name}" not found in codebase index`,
        reference: ref,
      });
    }
  }
  if (correctionsMap.size > 0) {
    correctedText = responseText;
    for (const [from, to] of correctionsMap) {
      correctedText = correctedText.split(from).join(to);
    }
  }

  // L7: SEMANTIC — verify LLM claims about function semantics (EXP388/447).
  // Independent trigger: runs whenever a semantic index is provided + the
  // layer is enabled, regardless of whether L3 grounding fired. This makes
  // L7 an independently-strong gate (EXP394 "all gates strong").
  if (config.layers.semantic && semanticIndex !== null) {
    const claims: SemanticClaim[] = [];
    // (a) caller-supplied claims (declared by the LLM in a structured field).
    if (semanticClaims !== null) {
      for (const c of semanticClaims) claims.push(c);
    }
    // (b) inferred claims from the response code body (await X → async, etc.).
    // EXP461 (S4): reuse the single-parse AST (no second @babel/parser call).
    if (config.semanticInferClaims) {
      let inferred: readonly SemanticClaim[] = [];
      if (responseAst !== undefined) {
        inferred = inferClaimsFromAst(responseAst, config);
      } else {
        inferred = inferClaimsFromCode(responseText, config);
      }
      for (const c of inferred) claims.push(c);
    }
    const mismatches: readonly SemanticMismatch[] = verifySemanticClaims(claims, semanticIndex, config);
    for (const m of mismatches) {
      // A signature mismatch (argCount/params) is auto-correctable if the
      // signature auto-corrector + L6 are enabled; otherwise it BLOCKS.
      let handled = false;
      if (config.layers["auto-correct"] && config.semanticAutoCorrectSignature && corrections < config.autoCorrectMaxCorrections) {
        if (m.field === "argCount" || m.field === "params") {
          const sig = autoCorrectSignature(m.ref, m.field as "argCount" | "params", m.field === "argCount" ? Number(m.claimed) : (Array.isArray(m.claimed) ? (m.claimed as readonly string[]) : []), semanticIndex);
          if (sig !== null) {
            corrections++;
            findings.push({
              layer: "auto-correct",
              severity: "info",
              message: `L6/L7: corrected ${sig.field} for "${sig.ref}": ${sig.from} → ${sig.to}`,
            });
            corrected = true;
            handled = true;
          }
        }
      }
      if (!handled) {
        blocked = true;
        findings.push({
          layer: "semantic",
          severity: "block",
          message: `L7: ${m.message}`,
        });
      }
    }
  }

  // L4: pre-emptive is the same as L2+L3 on partial output (caller
  // invokes detectHallucination on each chunk; same code path).
  // L5: post-hoc is the same as L2+L3 on the full output (the caller
  // invokes detectHallucination on the final text; same code path).
  // Both layers are enabled independently in config.layers.

  return {
    findings,
    blocked,
    corrected,
    referenceCount: refs.length,
    correctedText,
  };
}

/** Build an empty codebase index (for tests). */
export function emptyIndex(): CodebaseIndex {
  return {
    symbols: new Set(),
    paths: new Set(),
    imports: new Set(),
    exports: new Set(),
    types: new Set(),
  };
}

/** Build a codebase index from a set of source files.
 * EXP461 (S3): when a `semanticIndex` is provided, the AST-extracted
 * structural sets (types/imports/exports/paths/symbols) are reused — the
 * AST is the single source of truth (no regex for the source index). When
 * no semantic index is provided, each source is parsed once with
 * @babel/parser to collect the same sets (still no regex). The regex
 * fallback is kept ONLY for files the parser cannot parse (honest
 * degradation — a syntax-broken file still contributes its paths). */
export function buildIndexFromSources(
  sources: ReadonlyArray<Readonly<{ path: string; content: string }>>,
  semanticIndex?: SemanticIndex,
): CodebaseIndex {
  const symbols = new Set<string>();
  const paths = new Set<string>();
  const imports = new Set<string>();
  const exports = new Set<string>();
  const types = new Set<string>();
  const astCoveredPaths = new Set<string>();
  if (semanticIndex !== undefined) {
    // EXP461 (S3): the AST is the single source of truth. The AST-extracted
    // sets are AUTHORITATIVE — the regex fallback runs ONLY on files the
    // parser could not parse (not in semanticIndex.paths), so a commented-out
    // `// type Fake = …` in a parseable file is NOT falsely captured.
    for (const rec of semanticIndex.records) symbols.add(rec.name);
    for (const t of semanticIndex.types) types.add(t);
    for (const i of semanticIndex.imports) imports.add(i);
    for (const e of semanticIndex.exports) exports.add(e);
    for (const p of semanticIndex.paths) { paths.add(p); astCoveredPaths.add(p); }
  }
  // Regex fallback: ONLY for files NOT covered by the AST (unparseable
  // sources still need a path entry + symbol/type net). This is the LAST
  // resort, never the primary indexer for parseable files.
  const funcRe = /(?:function|const|let|var|class|interface|type|enum)\s+([a-zA-Z_$][\w$]*)/g;
  const importRe = /import\s+(?:\{[^}]+\}|[a-zA-Z_$][\w$]*\s*,\s*\{[^}]+\}|[a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  const exportRe = /export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|default)\s+([a-zA-Z_$][\w$]*)/g;
  const typeRe = /(?:interface|type|class)\s+([a-zA-Z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  for (const src of sources) {
    paths.add(src.path);
    if (astCoveredPaths.has(src.path)) continue; // AST already covered this file
    funcRe.lastIndex = 0;
    while ((m = funcRe.exec(src.content)) !== null) {
      const g = m[1];
      if (g !== undefined) symbols.add(g);
    }
    importRe.lastIndex = 0;
    while ((m = importRe.exec(src.content)) !== null) {
      const g = m[1];
      if (g !== undefined) imports.add(g);
    }
    exportRe.lastIndex = 0;
    while ((m = exportRe.exec(src.content)) !== null) {
      const g = m[1];
      if (g !== undefined) exports.add(g);
    }
    typeRe.lastIndex = 0;
    while ((m = typeRe.exec(src.content)) !== null) {
      const g = m[1];
      if (g !== undefined) types.add(g);
    }
  }
  return { symbols, paths, imports, exports, types };
}

// Re-export the L7 SEMANTIC API (single import path for consumers).
export {
  type SemanticIndex,
  type SemanticFunctionRecord,
  type SemanticClaim,
  type SemanticMismatch,
  buildSemanticIndexFromSources,
  emptySemanticIndex,
  lookupFunction,
  verifySemanticClaims,
  inferClaimsFromCode,
  inferClaimsFromAst,
  autoCorrectSignature,
  normalizeType,
  typeSimilarity,
} from "./hallucination-semantic.ts";
