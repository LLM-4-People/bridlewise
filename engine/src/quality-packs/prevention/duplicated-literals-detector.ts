import { parse } from "@babel/parser";

import {
  astChildren,
  astNode,
  babelParserPluginsForSourcePath,
  type AstNode,
} from "./ast-helpers.ts";

/**
 * Duplicated string/numeric literal detector (D3).
 *
 * Extends `no-generic-errors.test.ts` test 6 (which catches `30_000/30000/
 * 60_000/60000/4096` in `??`/`=`/`.default` positions only) to broader
 * positions. Groups literals by CONCEPT (error code, content type, path
 * length, string length, array items) and requires a named constant per
 * concept with one canonical owner. Concepts + their allowlists are seeded by
 * the test from `test/prevention/duplicate-literals-allowlist.json` (the
 * baseline of already-duplicated literals that are allowed; each entry names
 * its canonical owner). New duplications not in the baseline FAIL. Stale
 * baseline entries (the named constant was deduplicated) FAIL (T7 inversion).
 *
 * No hardcoded paths: the scan scope is a constant in the calling test. No
 * `@babel/traverse` (hand-rolled `astChildren` walker). No `throw new Error`.
 */

export interface DuplicatedLiteralFinding {
  file: string;
  line: number;
  literal: string;
  concept: string;
  canonicalOwner: string;
  occurrences: readonly { file: string; line: number; context: string }[];
}

export type LiteralPosition = "any" | "max-arg";

export interface LiteralConcept {
  canonicalOwner: string;
  literal: string;
  position?: LiteralPosition;
  allowlist: readonly string[];
}

export interface DuplicatedLiteralOptions {
  sources: readonly { path: string; content: string }[];
  concepts: ReadonlyMap<string, LiteralConcept>;
}

export interface DuplicatedLiteralResult {
  findings: readonly DuplicatedLiteralFinding[];
  staleAllowlistEntries: readonly string[];
}

interface Occurrence {
  file: string;
  line: number;
  context: string;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function contextLine(content: string, line: number): string {
  return content.split("\n")[line - 1]?.trim() ?? "";
}

function isMaxArgPosition(ancestors: readonly AstNode[]): boolean {
  const parent = ancestors[ancestors.length - 1];
  if (parent?.type !== "CallExpression" && parent?.type !== "OptionalCallExpression") return false;
  const callee = astNode(parent!.callee);
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return false;
  const prop = astNode(callee!.property);
  return prop?.type === "Identifier" && !callee!.computed && String(prop.name) === "max";
}

function isTypePosition(ancestors: readonly AstNode[]): boolean {
  return ancestors.some((a) =>
    a.type === "TSTypeAnnotation" || a.type === "TSTypeReference" ||
    a.type === "TSTypeAliasDeclaration" || a.type === "TSInterfaceDeclaration" ||
    a.type === "TSImportType" || a.type === "TSLiteralType",
  );
}

function parseProgram(path: string, content: string): AstNode | undefined {
  try {
    const parsed = parse(content, {
      sourceType: "module",
      plugins: [...babelParserPluginsForSourcePath(path)],
    });
    return parsed.program as unknown as AstNode;
  } catch {
    return undefined;
  }
}

function collectOccurrences(
  sources: readonly { path: string; content: string }[],
  concepts: ReadonlyMap<string, LiteralConcept>,
): Map<string, Occurrence[]> {
  const byConcept = new Map<string, Occurrence[]>();
  for (const conceptKey of concepts.keys()) {
    byConcept.set(conceptKey, []);
  }
  const literalToConcepts = new Map<string, string[]>();
  for (const [conceptKey, concept] of concepts) {
    const list = literalToConcepts.get(concept.literal) ?? [];
    list.push(conceptKey);
    literalToConcepts.set(concept.literal, list);
  }
  for (const src of sources) {
    const program = parseProgram(src.path, src.content);
    if (program === undefined) continue;
    const ancestors: AstNode[] = [];
    function walk(node: AstNode): void {
      const literal = literalValue(node);
      if (literal !== undefined && !isTypePosition(ancestors)) {
        const matchingConcepts = literalToConcepts.get(literal) ?? [];
        for (const conceptKey of matchingConcepts) {
          const concept = concepts.get(conceptKey)!;
          const position = concept.position ?? "any";
          if (position === "max-arg" && !isMaxArgPosition(ancestors)) continue;
          const start = typeof node.start === "number" ? node.start : 0;
          byConcept.get(conceptKey)!.push({
            file: src.path,
            line: lineOf(src.content, start),
            context: contextLine(src.content, lineOf(src.content, start)),
          });
        }
      }
      ancestors.push(node);
      for (const child of astChildren(node)) walk(child);
      ancestors.pop();
    }
    walk(program);
  }
  return byConcept;
}

function literalValue(node: AstNode): string | undefined {
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "NumericLiteral") return String(node.value);
  if (node.type === "BigIntLiteral") return String(node.value);
  return undefined;
}

export function detectDuplicatedLiterals(opts: DuplicatedLiteralOptions): DuplicatedLiteralResult {
  const occurrencesByConcept = collectOccurrences(opts.sources, opts.concepts);
  const findings: DuplicatedLiteralFinding[] = [];
  const stale: string[] = [];

  for (const [conceptKey, concept] of opts.concepts) {
    const occurrences = occurrencesByConcept.get(conceptKey) ?? [];
    const allowSet = new Set(concept.allowlist);
    const newOccurrences = occurrences.filter((o) => !allowSet.has(o.file));
    // Group new occurrences by file → emit one finding per file with new occurrences.
    const byFile = new Map<string, Occurrence[]>();
    for (const occ of newOccurrences) {
      const list = byFile.get(occ.file) ?? [];
      list.push(occ);
      byFile.set(occ.file, list);
    }
    for (const [file, fileOccs] of byFile) {
      findings.push({
        file,
        line: fileOccs[0]!.line,
        literal: concept.literal,
        concept: conceptKey,
        canonicalOwner: concept.canonicalOwner,
        occurrences: newOccurrences,
      });
    }
    // Drift detection: every allowlisted file must still have at least one occurrence.
    for (const allowFile of concept.allowlist) {
      const stillHas = occurrences.some((o) => o.file === allowFile);
      if (!stillHas) {
        stale.push(
          `stale literals-allowlist entry: concept ${JSON.stringify(conceptKey)} file ${JSON.stringify(allowFile)} — the file no longer inlines this literal (it was deduplicated); remove the entry`,
        );
      }
    }
  }

  return {
    findings: findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    staleAllowlistEntries: stale.sort(),
  };
}
