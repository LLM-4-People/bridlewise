/**
 * COCKPIT RENDER — the artifact decision, and the one place it is made.
 *
 * An artifact is a `create_artifact` tool call whose ARGUMENTS carry a
 * complete HTML document. The cockpit renders that document live, inside the
 * beat, in a frame the artifact cannot get out of.
 *
 * This module is pure: it answers "is there an artifact here, and if not,
 * what is the honest reason" and "how big is its frame". It touches no DOM
 * and mounts nothing, so both answers are testable without a browser and the
 * component that renders them has no decisions left to make.
 *
 * ── CONTAINMENT IS A PROPERTY OF THIS DESIGN, NOT A HOPE ──────────────────
 *
 * THE USER'S REPORT, VERBATIM: "it seems like artifacts are breaking the
 * page, we should make sure they are contained properly so it cannot happen."
 *
 * The rule this file and its component encode: AN ARTIFACT MAY FAIL AS BADLY
 * AS IT LIKES INSIDE ITS FRAME, AND THE COCKPIT MUST NOT NOTICE. Each half of
 * that was probed in a live frame before it was written down here:
 *
 *   1. THE FRAME'S SIZE IS DECLARED, NEVER DERIVED FROM CONTENT. `frameHeight`
 *      below is a function of the artifact's KIND alone. An artifact that
 *      appends 20,000 elements and sets its document to 9,999,999px was
 *      measured against a declared frame: the frame stayed exactly its
 *      declared size and the host document's scroll extent did not move by
 *      one pixel. This matters more here than in most UIs because the flow is
 *      a height-indexed virtualizer that measures each beat once — a frame
 *      that grew after measurement would corrupt the height index and take
 *      the scroll position with it.
 *
 *   2. THE HOST LISTENS IN EXACTLY ONE PLACE, FOR EXACTLY ONE THING. A
 *      sandboxed frame CAN still call `parent.postMessage` — that is not
 *      blocked and cannot be — so the containment has to be on our side of the
 *      boundary. It used to be total silence: the cockpit registered no
 *      `message` listener at all. Silence also meant an artifact that RENDERED
 *      AND THEN THREW produced a dead rectangle nobody could explain — not the
 *      user, not the model — which is the fabricated-absence failure
 *      (DESIGN-PERFORMANCE §1 L3) arriving through the security door.
 *      `artifact-errors.ts` is now the ONE listener: it accepts one message
 *      shape, from a window it registered itself, and does nothing with it but
 *      record it. Every security property of that channel is written down
 *      there and pinned in tests/cockpit/artifact-containment.test.ts §F and
 *      tests/cockpit/artifact-runtime-errors.test.ts.
 *
 *   3. A BLOCKED MAIN THREAD STAYS INSIDE THE FRAME. An artifact that blocked
 *      synchronously for three seconds was measured against a host ticking a
 *      50ms timer and a rAF loop: the worst host gap was 65ms against a 55ms
 *      idle baseline. Chrome gives an opaque-origin sandboxed frame its own
 *      renderer, so the artifact's main thread is not ours. This is a
 *      MEASUREMENT OF ONE BROWSER, not a guarantee we can make — a browser
 *      without sandboxed-frame process isolation would behave differently and
 *      we would have no way to stop it. Said plainly here rather than implied
 *      anywhere.
 *
 *   4. THE DOCUMENT NEVER ENTERS THE HOST'S DOM. The content reaches the
 *      frame through `srcdoc` and nothing else. It is never interpolated into
 *      the page, and — unlike every other tool beat — it is never dumped into
 *      the input cell as a code block either: a 55,096-byte artifact (a real
 *      one, from the battle test) would put 1,177 highlighted lines into the
 *      flow, which is a cost the reader never asked for and the virtualizer
 *      has to measure.
 *
 *   5. FRAMES OUTSIDE THE FLOW'S WINDOW DO NOT EXIST. The flow only mounts
 *      the beats in its scroll window, so an artifact two hundred beats back
 *      is not a paused animation loop — it is not in the document at all. The
 *      cockpit gets this for free and it is recorded here so nobody
 *      "optimises" the window away without knowing what else it was holding.
 */

import type { Beat } from "../flow/types.ts";
import { parseJsonContainer } from "./shapes.ts";
import { isRecord } from "../../state/coverage.ts";

/** The tool whose calls carry artifacts. */
export const ARTIFACT_TOOL_NAME = "create_artifact";

/**
 * What a beat's record says about its artifact. Exactly one of `document` or
 * `absence` is present — there is either something to render or a reason
 * there is not, and never both or neither.
 */
export type ArtifactView =
  | Readonly<{
      kind: "document";
      /** The artifact's own kind, as recorded. */
      type: string;
      title: string;
      /** The complete HTML document, exactly as recorded. */
      content: string;
      /** Byte length, stated rather than implied. */
      bytes: number;
    }>
  | Readonly<{
      kind: "absence";
      /** Why there is nothing to render, in the reader's words. */
      reason: string;
      /**
       * The tool's own words about what went wrong, when the record carries
       * them. Kept separate from `reason` so a server message is never
       * presented as our observation, or the reverse.
       */
      detail?: string;
    }>;

/** True when this beat is a `create_artifact` call. */
export function isArtifactBeat(beat: Beat): boolean {
  return beat.kind === "tool" && beat.tool?.name === ARTIFACT_TOOL_NAME;
}

/**
 * Read the tool's recorded output as text, whatever shape it was stored in.
 * The executor returns a JSON string; a transport may have parsed it. Both
 * are handled, and neither is invented.
 */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

/**
 * The server's own error sentence, pulled out of a recorded output when it is
 * there. The executor's failures are plain strings beginning "Error:"; its
 * successes are JSON. Anything else is returned verbatim rather than
 * reshaped — the record is the record.
 */
function serverDetail(output: unknown): string | undefined {
  const text = outputText(output).trim();
  if (text.length === 0) return undefined;
  // Text that is not a JSON container is an ORDINARY outcome — the executor's
  // failures are plain sentences — so the recorded text is returned verbatim.
  const parsed = parseJsonContainer(text);
  if (isRecord(parsed)) {
    const msg = parsed["message"];
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return text;
}

/**
 * THE DECISION. It reads the RECORD — what arguments arrived, what the tool
 * returned — and never the call's status.
 *
 * That is not stylistic. The flow's symmetric-detail rule (ToolBeat.svelte)
 * forbids the shape of a beat from depending on how the call went, and this
 * function is what the shape is built from. A failed artifact and a
 * successful one therefore get the same anatomy: the same frame slot, filled
 * either with the artifact or with the reason there isn't one.
 */
export function artifactViewOf(beat: Beat): ArtifactView {
  const tool = beat.tool;
  if (tool === undefined || tool.name !== ARTIFACT_TOOL_NAME) {
    return { kind: "absence", reason: "this is not an artifact" };
  }
  const detail = serverDetail(tool.output);
  const input = tool.input;
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    // The arguments are what carry the document, so their absence is the
    // whole story. While a call is in flight this is the normal state and the
    // component says so; afterwards it means the document never arrived.
    return detail === undefined
      ? { kind: "absence", reason: "the record carries no artifact document for this call" }
      : { kind: "absence", reason: "the record carries no artifact document for this call", detail };
  }
  const obj = input as Record<string, unknown>;
  const content = typeof obj["content"] === "string" ? obj["content"] : "";
  const type = typeof obj["type"] === "string" ? obj["type"] : "";
  const title = typeof obj["title"] === "string" ? obj["title"] : "";
  if (content.length === 0) {
    return detail === undefined
      ? { kind: "absence", reason: "the recorded arguments carry no document to render" }
      : { kind: "absence", reason: "the recorded arguments carry no document to render", detail };
  }
  // A document that the server REFUSED is present in the arguments but was
  // never accepted, so rendering it would show the user something the tool
  // declined to create. The refusal is what happened; it is what is shown.
  if (isRefusal(tool)) {
    return {
      kind: "absence",
      reason: "this artifact was refused before it was shown — nothing was rendered",
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  return {
    kind: "document",
    type,
    title: title.length > 0 ? title : "untitled artifact",
    content,
    bytes: content.length,
  };
}

/**
 * True when the call's record says the result was a REFUSAL — the typed
 * `refused` fact the data layer sets where a real result landed (the live
 * `tool_result` frame, the ledger heal, the persisted row a reload rebuilds
 * from). That one field covers every refusal shape the executor and the
 * pre-dispatch safety gate produce: the executor's failure sentences, the
 * gate's schema-mismatch blocks, ghost-tool blocks, loop blocks, and the
 * tripped/disabled refusals — where the old prefix test ("Error:") matched
 * only the executor's failures and let a gate-refused artifact mount its
 * document as a live frame.
 *
 * The fact is typed, never re-derived here: an unknown output shape is not
 * evidence of anything, and a call still in flight (no result yet) or a
 * stranded call (the client's own incompleteness observation) carries no
 * refusal and renders as it always did.
 */
function isRefusal(tool: Readonly<{ refused?: true }>): boolean {
  return tool.refused === true;
}

/**
 * THE FRAME'S HEIGHT, in pixels, decided by the artifact's KIND and by
 * nothing else.
 *
 * Declared per kind because the kinds describe SHAPES of use: a game is
 * played on a stage, a sheet is read across, a deck is 16:9 because that is
 * what a slide is. Before this the kind changed nothing but an emoji, which
 * made it a category the model was asked to choose and then nobody used.
 *
 * It is a constant per kind — never a function of the content — because the
 * flow measures a beat once and indexes its height. See the containment note
 * at the top of this file.
 *
 * ── THE EXPAND GESTURE GROWS THE STAGE, NOT THE CARD ─────────────────────
 *
 * THE USER'S RULING, VERBATIM (direction on the run pane's artifact beats):
 * expanding an artifact must grow the preview VERTICALLY, never wider. The
 * expand state is therefore a SECOND declared height for the same kind —
 * the compact box the beat rests at, and a taller one it earns by being
 * asked for. The taller box stays a DECLARED constant (never
 * content-derived, for the height-index reason above) and stays well under
 * a laptop viewport so the reader keeps the beat's head and the conversation
 * around it on screen; an artifact taller than its frame scrolls INSIDE the
 * frame, exactly as the compact one always has.
 */
export function frameHeight(type: string, expanded: boolean = false): number {
  switch (type) {
    case "game":
      return expanded ? 720 : 460;
    case "presentation":
      return expanded ? 640 : 380;
    case "sheet":
      return expanded ? 520 : 300;
    default:
      return expanded ? 640 : 340;
  }
}

/**
 * The one-line summary an artifact beat shows when it is collapsed.
 *
 * The generic tool summariser produced `type=game title=TETRIS — Complete
 * Clone content=<!DOCTYPE html> <html lang="en"> <head> <meta charset…` —
 * the document itself, spilling across the row, which tells a reader nothing
 * they can act on. An artifact's identity is its title, its kind and its
 * size; those fit, and they are all measured.
 */
export function artifactSummary(view: ArtifactView): string {
  if (view.kind === "absence") return view.reason;
  const kind = view.type.length > 0 ? view.type : "artifact";
  return `${view.title} · ${kind} · ${view.bytes.toLocaleString("en-US")} bytes`;
}
