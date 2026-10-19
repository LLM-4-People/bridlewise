/**
 * LENS callout model (DESIGN-COCKPIT-V2 §9.2) — pure functions behind the
 * hairline callout. No DOM listeners, no stores: everything is a function
 * over (stamped target, provenance answer, served schema), so the honesty
 * rules are unit-testable.
 *
 * THE NO-INVENTION LAW (mutation-tested): a source line comes ONLY from a
 * provenance record the Broker itself wrote, or from a declaration stamped
 * on the pixel (`data-setting` — the settings surfaces stamp their own
 * subject). An unbound pixel gets the absence sentence, never a fabricated
 * source. Verbs render only when mechanically derivable (§1.2 — no verb, no
 * pixels): the fact→setting link is the registry linkage
 * (settings-data.settingIdsForSignal), the source room is the block's
 * namespace against the rooms that exist.
 *
 * STAMP VOCABULARY the callout resolves (walked up the ancestor chain):
 *   data-prov     — Broker cache key (shared/provenance.PROVENANCE_ATTR);
 *                   stamped by any surface on its data-bound region.
 *   data-setting  — a setting id (the settings sheet/rows stamp themselves).
 *   data-signal   — an exposure signal id (gauges/instruments may stamp it).
 *   data-finding  — the cockpit computer's findings (FindingNote) — their
 *                   derivation is already ON the finding (§4.4), so the
 *                   callout points at it instead of restating it.
 */

import {
  PROVENANCE_ATTR,
  type ActionProvenanceRecord,
  type ProvenanceAnswer,
  type ProvenanceRecord,
} from "../../../shared/provenance.ts";
import type { UiSchema } from "../../../shared/ui-schema.ts";
import { asOfTime } from "../rooms/instruments-data.ts";
import { moduleOf, settingIdsForSignal } from "../settings/settings-data.ts";
import { ASK_PREFILL } from "../computer/ask.ts";

export const SETTING_ATTR = "data-setting";
export const SIGNAL_ATTR = "data-signal";
export const FINDING_ATTR = "data-finding";

/** What the hovered pixel declares about itself. */
export type CalloutTarget = Readonly<{
  provKey: string | null;
  settingId: string | null;
  signalId: string | null;
  /** Inside a computed finding — its derivation renders on the finding. */
  inFinding: boolean;
}>;

/** Walk the ancestor chain for the stamp vocabulary. Pure over the element
 * API (`closest`), so jsdom-testable. */
export function readTarget(el: Element | null): CalloutTarget {
  const closest = (attr: string): string | null =>
    el?.closest(`[${attr}]`)?.getAttribute(attr) ?? null;
  return Object.freeze({
    provKey: closest(PROVENANCE_ATTR),
    settingId: closest(SETTING_ATTR),
    signalId: closest(SIGNAL_ATTR),
    inFinding: el?.closest(`[${FINDING_ATTR}]`) !== null && el !== null,
  });
}

// ── Age words (finer than the rooms' relativeTime — a live instrument) ────

export function ageWords(thenMs: number, nowMs: number): string {
  const age = Math.max(0, nowMs - thenMs);
  if (age < 1000) return "just now";
  if (age < 60_000) return `${(age / 1000).toFixed(1)}s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

// ── The source line — record or honest absence, NOTHING else ──────────────

const VIA: Readonly<Record<ProvenanceRecord["cacheState"], string>> = {
  fresh: "fresh from the server",
  cached: "from the client's cache",
  revalidating: "revalidating now",
  failed: "read failed",
  refused: "the server declined this read — held until something changes",
};

/**
 * The pixel's source in plain words. Every clause is a field of the record
 * the Broker wrote — nothing is inferred, padded, or invented. Absences
 * speak as absences.
 */
export function sourceLine(
  target: CalloutTarget,
  answer: ProvenanceAnswer | null,
  nowMs: number,
): string {
  if (answer !== null && answer.kind === "record") {
    const r = answer.record;
    if (r.cacheState === "failed") {
      const code = r.errorCode !== undefined ? ` · ${r.errorCode}` : "";
      return `${r.block} · ${VIA.failed}${code} · ${ageWords(r.settledAt, nowMs)}`;
    }
    const when = r.asOf ?? r.settledAt;
    const partial = r.partial === true ? " · marked partial by the server" : "";
    return `${r.block} · ${ageWords(when, nowMs)} · ${VIA[r.cacheState]}${partial}`;
  }
  if (answer !== null && answer.kind === "absent" && answer.reason === "unresolved") {
    return `bound to “${answer.key ?? ""}” — nothing has read it yet`;
  }
  // No provenance record. A stamped declaration still speaks for itself.
  if (target.settingId !== null) {
    return `setting “${target.settingId}” — served by this install's registry`;
  }
  if (target.signalId !== null) {
    return `signal “${target.signalId}” — measured by this install's registry`;
  }
  return "this pixel declares no source — nothing here is bound to a recorded read";
}

/** The derivation note (§9.2 "its derivation if computed") — only the
 * mechanically-known case: the pixel sits inside a finding, whose §4.4
 * derivation already renders on the finding itself. */
export function derivationNote(target: CalloutTarget): string | null {
  return target.inFinding
    ? "computed — the finding shows its own derivation (∴)"
    : null;
}

// ── The action clause — "you changed this", only when it is recorded ──────

/**
 * The last thing YOU did to the region, in plain words, or `null`.
 *
 * Matched on `record.block`: the region's read names the block it came from,
 * and the Broker's write-side row names the block it acted on. Equal blocks
 * mean the recorded verb and the displayed value are the same subject — the
 * only link that exists without guessing. A region with no read record has
 * no block to match on and therefore gets NO clause, however suggestive its
 * setting id looks: a setting the user has never touched this session must
 * not be described as one they changed.
 *
 * `records` is the ledger's own array (oldest first), so the newest matching
 * row is found by walking backwards — no sort, no copy.
 */
export function actionClause(
  answer: ProvenanceAnswer | null,
  records: readonly ActionProvenanceRecord[],
): string | null {
  if (answer === null || answer.kind !== "record") return null;
  const block = answer.record.block;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as ActionProvenanceRecord;
    if (r.block !== block) continue;
    return r.state === "failed"
      ? `your change at ${asOfTime(r.settledAt)} did not go through · recorded`
      : `changed by you at ${asOfTime(r.settledAt)} · recorded`;
  }
  return null;
}

// ── Verbs — only when mechanically derivable (§1.2) ───────────────────────

export type CalloutVerb = Readonly<{
  id: string;
  label: string;
  run: () => void;
}>;

export type VerbDeps = Readonly<{
  schema: UiSchema | null;
  roomExists: (roomId: string) => boolean;
  openSheet: (settingId: string) => void;
  openForSignal: (signalId: string) => void;
  /** Prefill the composer (the `?` ask grammar). Null before the flow is
   * usable — the verb is then simply absent, never inert. */
  prefill: ((text: string) => void) | null;
  openRoom: (roomId: string) => void;
}>;

export function calloutVerbs(
  target: CalloutTarget,
  answer: ProvenanceAnswer | null,
  deps: VerbDeps,
): readonly CalloutVerb[] {
  const verbs: CalloutVerb[] = [];
  const record = answer !== null && answer.kind === "record" ? answer.record : null;

  // adjust — the registry linkage, in preference order: the stamped setting,
  // the stamped signal's linked settings, the record's block namespace.
  if (target.settingId !== null) {
    const id = target.settingId;
    verbs.push({ id: "lens.adjust", label: "adjust", run: () => deps.openSheet(id) });
  } else {
    const factId = target.signalId ?? record?.block ?? null;
    if (factId !== null && settingIdsForSignal(deps.schema, factId).length > 0) {
      verbs.push({ id: "lens.adjust", label: "adjust", run: () => deps.openForSignal(factId) });
    }
  }

  // ask — prefill the grammar's leader (the composer's ask menu lists
  // what is askable from there; the grammar owns the leader's spelling).
  const prefill = deps.prefill;
  if (prefill !== null) {
    verbs.push({ id: "lens.ask", label: "ask", run: () => prefill(ASK_PREFILL) });
  }

  // open source — the block's namespace room when it is actually built;
  // a stamped setting's source is the index itself.
  if (record !== null && deps.roomExists(moduleOf(record.block))) {
    const room = moduleOf(record.block);
    verbs.push({ id: "lens.open-source", label: `open ${room}`, run: () => deps.openRoom(room) });
  } else if (target.settingId !== null && deps.roomExists("settings")) {
    verbs.push({
      id: "lens.open-source",
      label: "open index",
      run: () => deps.openRoom("settings"),
    });
  }

  return verbs;
}
