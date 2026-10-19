/**
 * COCKPIT COMPUTER — the `?` grammar (spec §4.5).
 *
 * `?` asks the COMPUTER, not the model: deterministic computed questions
 * against the intelligence blocks that already exist (code.impact,
 * code.path, code.reuse). The answer is a finding — sentence + derivation +
 * verbs — rendered in the flow, zero model tokens.
 *
 * The askable list below is the autocomplete's source: it enumerates ONLY
 * questions backed by a registered block that exists today, so the palette
 * cannot promise an answer nothing can compute. (`insight.match` questions —
 * "runs that touched X" — are NEEDS-BACKEND and deliberately absent.)
 *
 * READS GO THROUGH THE BROKER'S READ DOOR (§6.2). They used to go through
 * `fetchJson(blockRequestPath(…))` — the transport, not the door — in order
 * to keep hold of the envelope's `meta.asOf`. That bought the asOf and paid
 * for it with the ambient `until`, the honest past-view refusal, and the
 * provenance record: during a past view, `?` answered from LIVE data under a
 * banner saying the screen showed an earlier instant, and the finding it
 * produced was structurally unexplainable because nothing recorded the read.
 *
 * `read()` applies all of it, and the derivation's `asOf` comes back out of
 * the Broker's own provenance record for the read it just performed. None of
 * these three blocks declares `until`, so an ask during a past view REFUSES
 * in plain words rather than answering about the wrong instant — which is
 * the correct answer to "what does the graph say at 10:14:21" when nothing
 * recorded the graph at 10:14:21.
 */

import { read, readKey } from "../../data/broker.ts";
import { ClientError } from "../../data/errors.ts";
import { serverAsOfFor } from "../../state/lens.ts";
import type { ComputedFinding } from "./findings.ts";

export type AskableQuestion = Readonly<{
  id: "impact" | "path" | "reuse";
  /** How you type it. */
  usage: string;
  /** What it computes, in plain words (mirrors the block's own honesty). */
  description: string;
  /** The block that answers — a registered read that exists today. */
  blockId: string;
}>;

export const ASKABLE: readonly AskableQuestion[] = [
  {
    id: "impact",
    usage: "? impact <file>",
    description:
      "files that could be affected if this file changes — everything that imports it, directly or through a chain",
    blockId: "code.impact",
  },
  {
    id: "path",
    usage: "? path <from-file> <to-file>",
    description:
      "how two files are connected through import statements, or a plain no-path answer",
    blockId: "code.path",
  },
  {
    id: "reuse",
    usage: "? reuse <name>",
    description:
      "existing symbols with similar names — candidates to reuse instead of writing something new (name similarity, not behavior)",
    blockId: "code.reuse",
  },
];

export type ParsedAsk = Readonly<{
  question: AskableQuestion;
  args: readonly string[];
}>;

/**
 * The composer prefill an ask door puts in the box: the grammar's leader
 * ALONE. The grammar's own menu (`grammarMenuFor` over `ASKABLE`) then
 * enumerates what is computable from there, keystroke by keystroke. A
 * door that prefilled a guessed phrase instead (a display name, a
 * subject) would promise a question the grammar can never parse — every
 * question keyword names a code-graph fact, and no surface's display
 * name contains one.
 */
export const ASK_PREFILL = "? ";

export type AskParseResult =
  | Readonly<{ ok: true; parsed: ParsedAsk }>
  | Readonly<{ ok: false; hint: string }>;

/** Parse a composer value beginning with `?`. */
export function parseAsk(input: string): AskParseResult {
  const body = input.replace(/^\?\s*/, "").trim();
  if (body.length === 0) {
    return { ok: false, hint: askableHint() };
  }
  const words = body.split(/\s+/);
  const keyword = words[0]!.toLowerCase();
  const question = ASKABLE.find((q) => q.id === keyword);
  if (question === undefined) {
    return { ok: false, hint: `no computable question "${keyword}" — ${askableHint()}` };
  }
  const args = words.slice(1);
  const needed = question.id === "path" ? 2 : 1;
  if (args.length < needed) {
    return { ok: false, hint: `usage: ${question.usage}` };
  }
  return { ok: true, parsed: { question, args } };
}

function askableHint(): string {
  return `askable: ${ASKABLE.map((q) => q.usage).join(" · ")}`;
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * One answered read: the block's payload plus the SERVER's production time
 * for it, both taken from the Broker.
 *
 * `read()` returns the payload; the `asOf` is read back out of the record
 * the choke point wrote for this exact key — the same number the envelope
 * carried, recorded by the door rather than by this call site. A block that
 * answered without stating an `asOf` is a gap, not a zero: §4.4 makes the
 * oldest input's age mandatory on a finding, and substituting "now" would
 * claim a freshness nobody measured, so it refuses in plain words.
 */
async function readAnswered<T>(
  blockId: string,
  params: Record<string, string>,
): Promise<{ data: T; asOf: number }> {
  const data = await read<T>(blockId, { params });
  // Shape guard: a block read answers with a payload. Anything else (e.g. an
  // index still being built) is reported in plain words instead of surfacing
  // as a TypeError from deep inside a join.
  if (data === null || data === undefined) {
    throw new ClientError(
      "malformed_envelope",
      `${blockId} did not answer in the block envelope shape — the index may still be building; ask again shortly`,
    );
  }
  const asOf = serverAsOfFor(readKey(blockId, params));
  if (asOf === undefined) {
    throw new ClientError(
      "missing_as_of",
      `${blockId} answered without stating when it produced the data — the answer's age cannot be shown, so it is not reported as a finding`,
    );
  }
  return { data, asOf };
}

/**
 * Run a parsed ask against its block. Returns the finding; the CALLER docks
 * it in the flow (ask answers bypass admission — the user asked, §1.2).
 * Throws ClientError on a failed read; the composer renders the failure as
 * an honest event, never as an empty finding.
 */
export async function runAsk(
  parsed: ParsedAsk,
  projectPath: string,
): Promise<ComputedFinding> {
  const { question, args } = parsed;
  switch (question.id) {
    case "impact": {
      const file = args[0]!;
      const { data: d, asOf } = await readAnswered<{
        directlyAffected: readonly string[];
        transitivelyAffected: readonly string[];
        totalAffected: number;
      }>("code.impact", { path: projectPath, file });
      const sentence =
        d.totalAffected === 0
          ? `Nothing imports ${file} — a change here reaches no other indexed file`
          : `A change to ${file} can reach ${d.totalAffected} ${d.totalAffected === 1 ? "file" : "files"} — ` +
            `${d.directlyAffected.length} import it directly, ${d.transitivelyAffected.length} through a chain`;
      return {
        sentence,
        derivation: {
          method:
            "walked the indexed import graph in reverse from this file: files importing it directly, then everything importing those",
          steps: [
            { source: "files importing it directly", sourceId: "code.impact", count: d.directlyAffected.length },
            { source: "files reached through chains of imports", sourceId: "code.impact", count: d.transitivelyAffected.length },
          ],
          asOf,
        },
      };
    }
    case "path": {
      const [from, to] = [args[0]!, args[1]!];
      const { data: d, asOf } = await readAnswered<{
        connected: boolean;
        direction: string | null;
        hops: readonly unknown[];
        summary: string;
      }>("code.path", { path: projectPath, from, to });
      const hops = Array.isArray(d.hops) ? d.hops.length : 0;
      // The block's own summary sentence IS the answer — served words, not a
      // client paraphrase that could drift from what was computed.
      return {
        sentence: d.summary,
        derivation: {
          method:
            "searched the indexed import graph for a chain of import statements between the two files, in both directions",
          steps: [{ source: "import steps on the found chain", sourceId: "code.path", count: hops }],
          asOf,
        },
      };
    }
    case "reuse": {
      const q = args.join(" ");
      const { data, asOf } = await readAnswered<unknown>("code.reuse", { path: projectPath, q });
      const list = extractArray(data);
      const sentence =
        list.length === 0
          ? `No existing symbol names look similar to "${q}"`
          : `${list.length} existing ${list.length === 1 ? "symbol has a name" : "symbols have names"} similar to "${q}" — matched by name, not by what the code does`;
      return {
        sentence,
        derivation: {
          method:
            "scored every indexed exported symbol's NAME against your search (name similarity plus small export bonuses) — the code bodies are not compared",
          steps: [{ source: "similar symbol names found", sourceId: "code.reuse", count: list.length }],
          asOf,
        },
      };
    }
  }
}

function extractArray(data: unknown): readonly unknown[] {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["candidates", "results", "matches", "items"]) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return [];
}
