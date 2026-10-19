/**
 * Pin-authority regeneration — the ONE regeneration choke point for every
 * source-authority pin that is NOT a single hash literal the hash-binding
 * registry carries.
 *
 * WHY THIS EXISTS (the defect it closes). Several pins are `{path, byteLength,
 * sha256}` OBJECT pins the registry cannot carry (it rewrites one 64-hex
 * literal per binding): the handoff semantic-owner set, the planned-node-test
 * source authority, and the unicode case-folding module's source/table pins.
 * Each had an owner-side recompute function, but NOTHING in `harness
 * regenerate` / `harness sync` called it — so a source change left the pin
 * stale and an operator had to run a separate script by hand (or hand-edit the
 * pin). That is the hand-maintained source-authority pin this module removes:
 * every pin here is re-derived from the CURRENT tree bytes by one command, and
 * the command is the regeneration choke point the suite already runs.
 *
 * THE OWNER PATTERN. Each authority file owns its pin STRUCTURE (the recorded
 * `path`/`role` — the semantic identity). This driver owns only the byte
 * MEASUREMENT (`byteLength` + `sha256`), recomputed from the current file at
 * `path`. A pin never moves its `path` here — a move is a deliberate edit to
 * the authority, not a regeneration.
 *
 * Modes:
 *   --check   report each pin as current/stale, exit non-zero on any stale pin
 *   --write   rewrite each stale pin in place, then report current
 * The stdout payload is a single canonical-JSON receipt the caller parses.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseTypeScriptSource } from "@babel/parser";

import { canonicalJson, deepFreeze, sha256 } from "../src/kernel/integrity.ts";
import { atomicWriteFile } from "../src/filesystem/atomic-write.ts";
import { InputError } from "../src/kernel/errors.ts";
import {
  handoffManifestIsCurrent,
  regenerateHandoffManifest,
} from "./regenerate-handoff-manifest.ts";
import { bootstrapProcess, isEntryPoint } from "../src/runtime/cli-debug.ts";
import { PIN_AUTHORITY_PATHS } from "../src/kernel/verification-paths.ts";

/** One measured pin: the semantic identity (`path`, `role`) plus the byte facts. */
export type PinMeasurement = Readonly<{
  role: string;
  path: string;
  byteLength: number;
  sha256: string;
}>;

/** The verdict for one pin: did the recorded bytes match the current tree? */
export type PinVerdict = PinMeasurement & Readonly<{ status: "current" | "stale"; recordedByteLength: number; recordedSha256: string }>;

/**
 * A registered pin authority: a source file whose pins this driver re-derives.
 * `locate` returns every pin the file carries (the semantic identity + the
 * CURRENT recorded measurement); `rewrite` replaces each stale measurement in
 * the file's text. Both are supplied by the authority's own registration so a
 * new pin authority is added by registering, never by editing the driver.
 */
export type PinAuthority = Readonly<{
  id: string;
  /** Repo-relative path of the file carrying the pins. */
  targetPath: string;
  /** True when the authority lives on the testing floor (no product-tree arm). */
  testingOnly: boolean;
  /**
   * A content projection OF this authority that must be re-derived after the
   * pins converge (the handoff manifest projects the semantic-owner set). When
   * present, the projection is regenerated from the converged authority in the
   * same run, so the authority and its projection can never drift apart under
   * the choke point. `isCurrent`/`write`/`target` name the projection file and
   * its idempotent writer.
   */
  projection?: Readonly<{
    targetPath: string;
    isCurrent: (absoluteTarget: string) => boolean;
    write: (absoluteTarget: string) => void;
  }>;
}>;

const NUMERIC_GROUP = /\B(?=(\d{3})+(?!\d))/gu;

/** Format an integer the way the pinned sources write it (1_234_567). */
function numericLiteral(value: number): string {
  return value.toString(10).replace(NUMERIC_GROUP, "_");
}

/**
 * Walk a Babel AST and yield every object expression that carries a string
 * `path` property AND numeric `byteLength` AND 64-hex `sha256` properties —
 * the structural signature of a byte-pin, however it is nested or ordered.
 * This is the robust replacement for a regex over source text: a regex keys
 * on field ORDER and whitespace and silently misses a pin written in a
 * different (still valid) shape; the AST keys on what the object IS.
 */
function* eachBytePinObject(node: unknown): Generator<{
  path: string;
  byteLength: number;
  sha256: string;
  byteLengthNode: { start: number; end: number; raw: string };
  sha256Node: { start: number; end: number; raw: string };
}> {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) yield* eachBytePinObject(item);
    return;
  }
  const record = node as Record<string, unknown> & { type?: string };
  if (record.type === "ObjectExpression" && Array.isArray(record.properties)) {
    const props = (record.properties as Array<Record<string, unknown>>).filter(
      (p) => p.type === "ObjectProperty",
    );
    const keyOf = (p: Record<string, unknown>): string | undefined => {
      const k = p.key as Record<string, unknown> | undefined;
      return k && (k.type === "Identifier" ? (k.name as string) : k.type === "StringLiteral" ? (k.value as string) : undefined);
    };
    const pathProp = props.find((p) => keyOf(p) === "path");
    const byteProp = props.find((p) => keyOf(p) === "byteLength");
    const shaProp = props.find((p) => keyOf(p) === "sha256");
    const pathValue = pathProp?.value as Record<string, unknown> | undefined;
    const byteValue = byteProp?.value as Record<string, unknown> | undefined;
    const shaValue = shaProp?.value as Record<string, unknown> | undefined;
    if (
      pathValue?.type === "StringLiteral" &&
      byteValue?.type === "NumericLiteral" &&
      shaValue?.type === "StringLiteral" &&
      /^[0-9a-f]{64}$/u.test(shaValue.value as string)
    ) {
      const byteExtra = byteValue.extra as Record<string, unknown> | undefined;
      const shaExtra = shaValue.extra as Record<string, unknown> | undefined;
      yield {
        path: pathValue.value as string,
        byteLength: byteValue.value as number,
        sha256: shaValue.value as string,
        byteLengthNode: {
          start: byteValue.start as number,
          end: byteValue.end as number,
          raw: (byteExtra?.raw as string) ?? String(byteValue.value),
        },
        sha256Node: {
          start: shaValue.start as number,
          end: shaValue.end as number,
          raw: (shaExtra?.raw as string) ?? `"${shaValue.value}"`,
        },
      };
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range" || key === "extra" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    yield* eachBytePinObject(record[key]);
  }
}

/**
 * Re-derive every `{path, byteLength, sha256}` object pin in a target file.
 * The pins are recognized by their STRUCTURE (a `path` string + `byteLength`
 * number + `sha256` hex in one object literal) parsed by Babel, never by a
 * hand-written list of variable names. Each pin's `path` is read from the
 * tree; its `byteLength`/`sha256` are rewritten in place when stale, by
 * byte-offset so the surrounding formatting (including the `1_234` numeric
 * separator style) is preserved. The `path` value itself is never rewritten
 * (a move is a deliberate edit, not a regeneration).
 */
export function rederiveObjectPins(
  root: string,
  targetPath: string,
  write: boolean,
): Readonly<{ verdicts: readonly PinVerdict[]; changed: boolean }> {
  const absolute = resolve(root, targetPath);
  const source = readFileSync(absolute, "utf8");
  const program = parseTypeScriptSource(source, { sourceType: "module", plugins: ["typescript"] });
  const pins = [...eachBytePinObject(program)]
    // A byte-pin's `path` names a tracked source FILE. A `path:` field that is
    // a config key (`contracts.limits.…`) or another non-file string is not a
    // byte-pin; only a path resolving to a real file under the root counts.
    .filter((pin) => existsSync(join(root, pin.path)) && statSync(join(root, pin.path)).isFile());
  if (pins.length === 0) {
    throw new InputError(`pin authority ${targetPath} carries no recognizable byte-pin`, "input_error");
  }
  const verdicts: PinVerdict[] = [];
  // Apply rewrites from LAST pin to FIRST so earlier byte-offsets stay valid.
  let rewritten = source;
  const staleEdits: Array<Readonly<{ start: number; end: number; text: string }>> = [];
  for (const pin of pins) {
    const bytes = readFileSync(join(root, pin.path));
    const fresh = { byteLength: bytes.length, sha256: sha256(bytes) };
    const status = fresh.byteLength === pin.byteLength && fresh.sha256 === pin.sha256 ? "current" : "stale";
    verdicts.push({
      role: "",
      path: pin.path,
      byteLength: fresh.byteLength,
      sha256: fresh.sha256,
      recordedByteLength: pin.byteLength,
      recordedSha256: pin.sha256,
      status,
    });
    if (status === "stale" && write) {
      staleEdits.push(
        { start: pin.byteLengthNode.start, end: pin.byteLengthNode.end, text: numericLiteral(fresh.byteLength) },
        { start: pin.sha256Node.start, end: pin.sha256Node.end, text: `"${fresh.sha256}"` },
      );
    }
  }
  for (const edit of staleEdits.sort((a, b) => b.start - a.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.text}${rewritten.slice(edit.end)}`;
  }
  const changed = rewritten !== source;
  if (changed && write) {
    const result = atomicWriteFile(absolute, rewritten);
    if (!result.success) {
      throw new InputError(`could not write pin authority ${targetPath}: ${result.reason ?? "unknown"}`, "input_error");
    }
  }
  return deepFreeze({ verdicts: deepFreeze(verdicts), changed });
}

/**
 * The registered pin authorities. This is the deny-by-default set: an
 * authority not listed here is not re-derived by the choke point. Each entry
 * is discovered by the guard that scans for byte-pin literals, so adding a new
 * pinned authority without registering it reds that guard.
 */
export function pinAuthorities(): readonly PinAuthority[] {
  return deepFreeze([
    {
      id: "handoff-protocol-authority",
      targetPath: PIN_AUTHORITY_PATHS.handoffProtocolAuthority,
      testingOnly: false,
      // The manifest projects the authority's semantic-owner set; a converged
      // authority with a stale manifest fails the runtime conformance gate
      // (`handoff_manifest_authority_mismatch`). Regenerate it in the same run
      // so the authority and its projection move together.
      projection: {
        targetPath: PIN_AUTHORITY_PATHS.handoffProtocolManifest,
        isCurrent: (absoluteTarget) => handoffManifestIsCurrent(absoluteTarget),
        write: (absoluteTarget) => regenerateHandoffManifest(absoluteTarget),
      },
    },
    {
      id: "planned-node-test-source-authority",
      targetPath: PIN_AUTHORITY_PATHS.plannedNodeTestSourceAuthority,
      testingOnly: true,
    },
  ]);
}

/**
 * The authorities THIS tree owes convergence for. A testing-only authority
 * (`testingOnly: true`: its subject never ships) has no subject on a product-only tree — it is
 * converged by absence there: the driver drops it instead of measuring a
 * file the tree does not carry. A product authority is always owed; a
 * product tree whose authority file is missing is a defect the run reports
 * as an error, never a silent skip.
 */
export function authoritiesOwedByTree(root: string): readonly PinAuthority[] {
  return pinAuthorities().filter(
    (authority) => !authority.testingOnly || existsSync(resolve(root, authority.targetPath)),
  );
}

function run(argv: readonly string[]): number {
  const mode = argv[0] ?? "--check";
  if (argv.length !== 1 || (mode !== "--check" && mode !== "--write")) {
    throw new InputError("Usage: pin-authority-regeneration [--check|--write]", "input_error");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const write = mode === "--write";
  const authorities = authoritiesOwedByTree(root);
  const results = authorities.map((authority) => {
    try {
      const { verdicts, changed } = rederiveObjectPins(root, authority.targetPath, write);
      const stale = verdicts.filter((v) => v.status === "stale");
      // The projection is re-derived AFTER this authority's pins converge, so
      // the authority the projection reads is the freshly-written one.
      let projectionStatus: "current" | "regenerated" | "absent" = "absent";
      if (authority.projection !== undefined) {
        const projectionAbsolute = resolve(root, authority.projection.targetPath);
        const projectionCurrent = existsSync(projectionAbsolute) && authority.projection.isCurrent(projectionAbsolute);
        if (projectionCurrent && !changed) {
          projectionStatus = "current";
        } else if (write) {
          authority.projection.write(projectionAbsolute);
          projectionStatus = "regenerated";
        } else {
          projectionStatus = projectionCurrent ? "current" : "absent";
        }
      }
      const staleProjection = authority.projection !== undefined && projectionStatus === "absent";
      const current = stale.length === 0 && !staleProjection;
      return {
        id: authority.id,
        status: current ? "current" : write ? "regenerated" : "stale",
        pins: verdicts.length,
        stale: stale.length,
        changed,
        ...(authority.projection !== undefined ? { projection: projectionStatus } : {}),
      };
    } catch (error) {
      return { id: authority.id, status: "error", message: (error as Error).message, pins: 0, stale: 0, changed: false };
    }
  });
  const allCurrent = results.every((r) => r.status === "current" || r.status === "regenerated");
  process.stdout.write(`${canonicalJson({
    schemaVersion: "bridlewise-pin-authority-regeneration/v1",
    mode,
    allCurrent,
    results,
  })}\n`);
  return allCurrent ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
