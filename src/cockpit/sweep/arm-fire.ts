/**
 * THE ARM FIRING ENGINE — the grammar half + the firing OUTCOMES (§6.4).
 *
 * A trigger armed through the record's when-eval grammar (the custom entry,
 * or a palette row's built predicate) evaluates HERE, against the vocabulary
 * context built per received event — the same roots ARM_PREDICATE_VOCABULARY
 * declares, bound only from what the live stream genuinely carries:
 *
 *   event.*   — the projected ledger columns the event itself holds;
 *   tool.*    — the `tool:<name>` description + outcome of a tool event
 *               (the same parse the breaker fold performs server-side);
 *   check.*   — the `check:<name> <from>→<to>` description of a check
 *               delta event;
 *   run.*     — the event's run + the shared transcript's streaming flag;
 *   context.* — the LAST-KNOWN compose report (the standing gauge), so a
 *               mixed predicate (`event.type == 'run' && context.pct >= 80`)
 *               reads the gauge at the event. A PURE context predicate never
 *               fires here — the compose door owns it, because the crossing
 *               happened at the measurement, not at the next event.
 *
 * THE EVALUATION TRUTH is declared per field in ARM_FIELD_EVALUATION below
 * and rendered on the palette's rows: what evaluates client-side today, and
 * what waits on a feed (tool.durationMs rides the timing document the
 * streamed projection does not carry — an armed duration predicate evaluates
 * honestly never, and the row says so rather than arming a silent lie).
 *
 * THE OUTCOMES (the novel half): a firing stops being only a mark —
 * `announceArmFiring` docks the finding through the ONE admission controller
 * (computer/admission.ts — dwell, one-slot, dismissal learning all apply),
 * carrying the design's own promise (DESIGN-COCKPIT-V2 §6.4: "a finding
 * docks: ∴ Armed trigger fired: … · open at that moment") with its mandatory
 * derivation stating the trigger's address — nothing copied. The verbs:
 * `open at that moment` (the band seam — a READ navigation, the same one a
 * capture row uses) and `re-arm` (oscilloscope semantics: single-shot per
 * arming, re-arm explicit and manual — the scope's own rule).
 *
 * NAVIGATION IS A VERB, NEVER AUTOMATIC: a firing mid-run that planted the
 * head would switch every asOf-reactive surface to a past view without the
 * reader's consent. The mark (at the instant), the finding (the sentence)
 * and the annunciator (the standing light) each carry the way there; the
 * reader chooses when.
 *
 * CIRCULATION NOTE: this module and sweep-store import each other's
 * functions (the doors there call the evaluator + announcer here; the re-arm
 * verb here calls the state mutator there). Every use is INSIDE a function —
 * neither module reads the other at load time — so the live ESM bindings
 * resolve at call time, never at init.
 */

import { evalWhen, type WhenContext } from "../../../shared/when-eval.ts";
import { predicateRoots } from "../../../shared/arm-vocabulary.ts";

import {
  ARM_PREDICATE_LABELS,
  evalContextCross,
  type ArmedTrigger,
} from "./marks";
import type { SweepEvent } from "./types";
// The capture share's window reads the sweep's own clock formatter.
import { formatClock } from "./now-edge";
// The fired finding's re-arm verb — the state mutator (deferred binding:
// see the header's circulation note).
import { reArmTrigger } from "./sweep-store";
// The go verb's seam: planting the head is a READ navigation (band-request).
import { requestBandGo } from "./band-request";
// The dock: the ONE admission controller owns the desk line.
import { proposeDeskLine } from "../computer/admission.ts";
import type { BeatVerb, FindingBody } from "../flow/types.ts";
// run.streaming binds from the shared transcript's own flag; context binds
// the last-known compose report (read-only store subscriptions).
import { isStreaming, lastRunContext, contextPctOf } from "../../state/chat-messages.ts";

// ── The per-field evaluation truth (the palette renders this) ────────────────

/**
 * The DEFAULT evaluation sentence for a vocabulary field (a field added to
 * the map tomorrow is covered with zero edits here), overridden per field
 * where the live stream's truth differs. Keys are field paths; every key
 * must be a LIVE vocabulary member — a stale override is a lie about a
 * field that no longer exists, and the palette guard reds on it.
 */
export const ARM_FIELD_EVALUATION_DEFAULT =
  "evaluates live as each event arrives";

export const ARM_FIELD_EVALUATION: Readonly<Record<string, string>> =
  Object.freeze({
    "tool.name": "evaluates live on received tool events",
    "tool.failed": "evaluates live on received tool events",
    "tool.durationMs":
      "waits on the timing feed — the streamed event carries no durations yet",
    "check.id": "evaluates when a check delta event arrives",
    "check.status": "evaluates when a check delta event arrives",
    "context.pct":
      "evaluates when a run reports its context — the compose refresh, not per token",
    "context.tokens":
      "evaluates when a run reports its context — the compose refresh, not per token",
    "context.limit":
      "evaluates when a run reports its context — the compose refresh, not per token",
    "run.id": "evaluates live as each event arrives",
    "run.streaming": "evaluates live as each event arrives",
  });

/** The evaluation-truth sentence for one vocabulary field path. */
export function armFieldEvaluation(path: string): string {
  return ARM_FIELD_EVALUATION[path] ?? ARM_FIELD_EVALUATION_DEFAULT;
}

/**
 * The vocabulary fields the live stream cannot bind today — the DECLARED
 * honest-absence set. Every member is a live vocabulary field the palette
 * offers whose value no received event carries, disclosed by its own
 * evaluation sentence (never the live default). The binding pin
 * (tests/cockpit/arm-firing.test.ts) holds the palette's derived field set
 * equal to the fields `armEventContext` actually binds PLUS exactly this
 * set — so a description edit that offers an unbindable field reds, and a
 * runtime binding with no description reds the other way. A member that
 * stops being honest (its field becomes bindable, or leaves the map) is a
 * defect this set's own guards name.
 */
export const ARM_UNBOUND_FIELDS: ReadonlySet<string> = Object.freeze(
  new Set(["tool.durationMs"]),
);

// ── The per-event vocabulary context ────────────────────────────────────────

/** Parse `tool:<name>` from a tool event's description — the same slice the
 * server's breaker fold performs (foldToolEvents), so the two ends agree on
 * where the tool's name lives. Null when the description names no tool. */
function toolNameOf(e: SweepEvent): string | undefined {
  if (!e.eventType.startsWith("tool")) return undefined;
  const marker = `${e.eventType}:`;
  if (!e.description.startsWith(marker)) return undefined;
  const name = e.description.slice(marker.length);
  return name.length > 0 ? name : undefined;
}

/** Parse `check:<name> <from>→<to>` from a check delta's description (the
 * record's own encoding — server/db recordCheckStatusEvent). Null when the
 * event is not a check delta. */
function checkDeltaOf(
  e: SweepEvent,
): Readonly<{ id: string; status: string }> | undefined {
  if (e.eventType !== "quality" || !e.description.startsWith("check:")) {
    return undefined;
  }
  const m = /^check:(\S+) (?:\S+)→(\S+)$/.exec(e.description);
  if (m === null) return undefined;
  return { id: m[1]!, status: m[2]! };
}

/**
 * The vocabulary context for ONE received event — exactly the roots
 * ARM_PREDICATE_VOCABULARY declares, bound only from what the event and the
 * standing stores genuinely hold. Fields with no binding this event are
 * ABSENT (undefined → falsy): a predicate over an unbound field evaluates
 * false, which is the honest answer, never a throw.
 */
export function armEventContext(e: SweepEvent): WhenContext {
  const ctx: Record<string, Record<string, unknown>> = {
    event: {
      type: e.eventType,
      ...(e.outcome !== null ? { outcome: e.outcome } : {}),
      ...(e.errorCode !== null ? { errorCode: e.errorCode } : {}),
      description: e.description,
      ...(e.runId !== null ? { runId: e.runId } : {}),
    },
    run: {
      ...(e.runId !== null ? { id: e.runId } : {}),
      streaming: isStreaming.get(),
    },
  };
  const tool = toolNameOf(e);
  if (tool !== undefined) {
    ctx.tool = { name: tool, failed: e.outcome === "failed" };
  }
  const check = checkDeltaOf(e);
  if (check !== undefined) {
    ctx.check = { id: check.id, status: check.status };
  }
  const last = lastRunContext.get();
  const pct = last === null ? null : contextPctOf(last);
  if (pct !== null) {
    ctx.context = {
      pct,
      ...(last!.contextTokens !== undefined ? { tokens: last!.contextTokens } : {}),
      ...(last!.contextTokenLimit !== undefined ? { limit: last!.contextTokenLimit } : {}),
    };
  }
  return ctx;
}

/** Evaluate a grammar predicate against ONE received event. A parse failure
 * (an expression the server would refuse) evaluates false — the client never
 * throws on a predicate it was handed; the arm door is where refusals live. */
export function evalArmGrammar(predicate: string, e: SweepEvent): boolean {
  try {
    return evalWhen(predicate, armEventContext(e));
  } catch {
    return false;
  }
}

/**
 * True when a predicate's roots are ALL `context` — such a predicate never
 * fires on an event (the gauge is not a per-event fact); the COMPOSE door
 * (sweep-store fireContextArms, fed by the run's context report) owns it,
 * firing at the measurement's arrival.
 */
export function isPureContextPredicate(predicate: string): boolean {
  return predicateRoots(predicate).every((r) => r === "context");
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** The row/plain-words label of a cocked trigger. */
export function armTriggerLabel(t: Readonly<ArmedTrigger>): string {
  if (t.kind === "custom") return t.param ?? "a custom condition";
  if (t.kind === "context-crosses") {
    return t.param === null ? ARM_PREDICATE_LABELS["context-crosses"] : `context crosses ${t.param}%`;
  }
  if (t.kind === "file-edited") {
    return t.param === null ? ARM_PREDICATE_LABELS["file-edited"] : `file ${t.param} is edited`;
  }
  return ARM_PREDICATE_LABELS[t.kind];
}

/** The PAST-TENSE fact a fired trigger states in its finding sentence. */
export function armFiredLabel(t: Readonly<ArmedTrigger>): string {
  if (t.kind === "custom") return t.param ?? "a custom condition";
  if (t.kind === "context-crosses") {
    return t.param === null ? "context crossed its threshold" : `context crossed ${t.param}%`;
  }
  if (t.kind === "file-edited") {
    return t.param === null ? "a watched file was edited" : `file ${t.param} was edited`;
  }
  if (t.kind === "check-fails") return "a check failed";
  return "a tool errored";
}

// ── The firing outcomes ─────────────────────────────────────────────────────

/** The finding kind the admission controller learns dismissals under. */
export const ARM_FIRED_FINDING_KIND = "arm-fired";

/** The source the firing matched — one derivation step's worth of address. */
export type ArmFiringSource =
  | Readonly<{ kind: "event"; eventId: string; eventDescription: string }>
  | Readonly<{ kind: "context"; measuredPct: number }>;

/**
 * Dock the fired-trigger finding through the ONE admission controller, with
 * the mandatory derivation stating the trigger's address (§4.4 — nothing
 * copied, the derivation names where the fact lives) and the two verbs:
 * go (the band seam, a read) and re-arm (a write — past views refuse it,
 * the same owned sentence every writing verb carries).
 */
export function announceArmFiring(
  t: Readonly<ArmedTrigger>,
  atMs: number,
  source: ArmFiringSource,
): void {
  const fired = armFiredLabel(t);
  const finding: FindingBody = {
    sentence: `armed trigger fired: ${fired} · open at that moment`,
    derivation: {
      method:
        source.kind === "event"
          ? "matched an armed predicate against a ledger event this browser received on the live stream"
          : "matched an armed predicate against the context measurement the run's compose reported",
      steps:
        source.kind === "event"
          ? [
              { source: "the armed predicate", sourceId: `sweep.arms/${t.id}`, count: 1 },
              {
                source: `the received event (${source.eventDescription})`,
                sourceId: source.eventId,
                count: 1,
              },
            ]
          : [
              { source: "the armed predicate", sourceId: `sweep.arms/${t.id}`, count: 1 },
              { source: "the compose's context report", sourceId: "run context event", count: 1 },
            ],
      asOf: atMs,
      ...(source.kind === "context"
        ? { window: `measured at ${source.measuredPct}% of the context limit` }
        : {}),
    },
    findingKind: ARM_FIRED_FINDING_KIND,
    verbs: armFiredVerbs(t, atMs),
  };
  proposeDeskLine(finding);
}

/** The fired row's verbs: the way back to the instant (a read) and the
 * explicit re-arm (a write, oscilloscope semantics). */
export function armFiredVerbs(t: Readonly<ArmedTrigger>, atMs: number): readonly BeatVerb[] {
  return [
    {
      id: "sweep.arm-go",
      label: "open at that moment",
      wired: true,
      run: () => {
        requestBandGo(atMs);
      },
      writes: false,
    },
    {
      id: "sweep.re-arm",
      label: "re-arm",
      wired: true,
      run: () => {
        reArmTrigger(t.id);
      },
      writes: true,
    },
  ];
}

// ── The capture→finding share (the campaign's standing item) ────────────────

/** The finding kind the admission controller learns dismissals under. */
export const ARM_CAPTURE_FINDING_KIND = "arm-capture";

/**
 * Dock a captured stretch as a finding through the ONE admission controller
 * — the same door the firing's finding walks (dwell, one-slot, dismissal
 * learning all apply; no second path). The derivation states the capture's
 * ADDRESS and nothing copied: the record's flag id and the band's t0→t1,
 * the same derivation grammar the firing's finding carries (§4.4). The
 * one verb is the same read a capture row's label runs — plant the head at
 * the stretch's start — so the finding, the row and the mark all answer
 * "where?" with the same instant.
 *
 * A flag with no t0 (the wire's optional shape) cannot name an address, so
 * it shares nothing — the caller renders the verb only where the address
 * exists, and this guard is the promise the caller leans on.
 */
export function announceArmCapture(
  flag: Readonly<{ id: string; t0?: number; t1?: number; label?: string }>,
): void {
  if (flag.t0 === undefined) return;
  const t0 = flag.t0;
  const t1 = flag.t1 ?? t0;
  const name = flag.label !== undefined && flag.label.length > 0 ? flag.label : "an unnamed stretch";
  const finding: FindingBody = {
    sentence: `capture shared: ${name} · open at that moment`,
    derivation: {
      method:
        "shared from the arm group's captured stretch — the record's band address, nothing copied",
      steps: [
        { source: "the captured stretch", sourceId: `arm.flags/capture ${flag.id}`, count: 1 },
      ],
      asOf: t0,
      window: `the band from ${formatClock(t0)} to ${formatClock(t1)}`,
    },
    findingKind: ARM_CAPTURE_FINDING_KIND,
    verbs: [
      {
        id: "sweep.capture-go",
        label: "open at that moment",
        wired: true,
        run: () => {
          requestBandGo(t0);
        },
        writes: false,
      },
    ],
  };
  proposeDeskLine(finding);
}

// ── The context-crosses evaluation (the compose door's matcher) ─────────────

/**
 * Does THIS trigger match a context measurement? The fixed quick kind reads
 * its threshold through the existing per-kind evaluator (marks.ts
 * evalContextCross — single-shot semantics live in the caller); a pure-
 * context grammar predicate evaluates against the measurement alone.
 */
export function matchesContextReading(
  t: Readonly<ArmedTrigger>,
  measured: Readonly<{ pct: number; tokens?: number; limit?: number }>,
): boolean {
  if (t.kind === "context-crosses") return evalContextCross(t as ArmedTrigger, measured.pct);
  if (t.predicate !== null && isPureContextPredicate(t.predicate)) {
    return evalWhen(t.predicate, {
      context: {
        pct: measured.pct,
        ...(measured.tokens !== undefined ? { tokens: measured.tokens } : {}),
        ...(measured.limit !== undefined ? { limit: measured.limit } : {}),
      },
    });
  }
  return false;
}
