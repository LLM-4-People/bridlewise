/**
 * THE SWITCH — micro-sweep density decode (§5.2: "the micro-sweep is the
 * real ledger density", §5.4: "from the spectrum block, never decorative").
 *
 * Decodes the `sweep.spectrum` block's packed wire (base64 Int16Array +
 * JSON header — the contract `server/blocks/spectrum.ts` declares) into the
 * ONE shape a 24px strip needs: per-bin totals + the error overlay. This is
 * the Switch's OWN decoder: the big sweep's painter and bin plumbing belong
 * to the sweep surface; a reel's strip shares nothing with them.
 *
 * Honesty (§1.1): the decoder REFUSES payloads it cannot vouch for — a
 * header that will not declare the canonical overlay semantics, geometry
 * that disagrees with itself, negative or impossible counts. An empty scope
 * (0 events) decodes to `null` — the honest blank the caller renders as
 * "no events recorded", never an invented flat line.
 *
 * Pure module: no DOM, no fetch, deterministic from its input.
 */

import { SwitchHonestyViolation, rec } from "./switch-outcome.ts";

/** What a 24px strip paints: per-bin totals with the error overlay. Under
 * the spectrum's canonical `errorRowIsOverlay` semantics, totals are the
 * category rows' sums (errors already included) and `errors[i] <=
 * totals[i]` always. */
export type MicroDensity = Readonly<{
  t0: number;
  t1: number;
  binMs: number;
  totals: readonly number[];
  errors: readonly number[];
  /** Server-counted events matched by the scope. */
  events: number;
}>;

// ── Wire narrowing (`rec` is imported — one owner, no scattered helpers) ──

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function base64ToInt16(b64: string): Int16Array {
  // `atob` exists in every supported browser and in Node ≥16 (the vitest
  // environment) — one path, no Buffer import in client code.
  const bin = atob(b64);
  if (bin.length % 2 !== 0) {
    throw new SwitchHonestyViolation("spectrum packed payload has an odd byte length");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * Decode one spectrum read. Returns null for an honestly-empty scope;
 * throws SwitchHonestyViolation for a payload that lies about itself.
 */
export function decodeMicroDensity(wire: unknown): MicroDensity | null {
  const w = rec(wire);
  const header = w !== null ? rec(w["header"]) : null;
  const packed = w !== null ? w["packed"] : null;
  if (header === null || typeof packed !== "string") {
    throw new SwitchHonestyViolation("spectrum wire is not a {header, packed} payload");
  }
  if (header["errorRowIsOverlay"] !== true) {
    throw new SwitchHonestyViolation(
      "spectrum header does not declare errorRowIsOverlay: true — this decoder assumes the canonical overlay ridge and refuses a payload that will not say so",
    );
  }
  const categories = Array.isArray(header["categories"]) ? header["categories"] : null;
  const rows = int(header["rows"]);
  const bins = int(header["bins"]);
  const errorRow = int(header["errorRow"]);
  const events = int(header["events"]);
  const binMs = typeof header["binMs"] === "number" ? header["binMs"] : null;
  const t0 = header["t0"];
  const t1 = header["t1"];
  if (categories === null || rows === null || bins === null || errorRow === null || events === null || binMs === null) {
    throw new SwitchHonestyViolation("spectrum header is missing declared geometry fields");
  }

  if (t0 === null || t1 === null || bins === 0 || binMs === 0) {
    if (events > 0) {
      throw new SwitchHonestyViolation(
        `spectrum header claims ${events} events but carries no window/bins`,
      );
    }
    return null; // the honest blank — nothing recorded in scope
  }
  if (typeof t0 !== "number" || typeof t1 !== "number" || !(t1 >= t0)) {
    throw new SwitchHonestyViolation("spectrum window is not a sane [t0, t1]");
  }
  if (rows !== categories.length + 1 || errorRow !== categories.length) {
    throw new SwitchHonestyViolation(
      `spectrum header geometry lies: rows=${rows} errorRow=${errorRow} for ${categories.length} categories`,
    );
  }
  if (bins < 1) {
    throw new SwitchHonestyViolation(`spectrum bins must be positive, got ${bins}`);
  }

  const matrix = base64ToInt16(packed);
  if (matrix.length !== rows * bins) {
    throw new SwitchHonestyViolation(
      `spectrum packed length ${matrix.length} != declared ${rows}×${bins}`,
    );
  }

  const totals = new Array<number>(bins).fill(0);
  const errors = new Array<number>(bins).fill(0);
  for (let bin = 0; bin < bins; bin += 1) {
    let sum = 0;
    for (let row = 0; row < errorRow; row += 1) {
      const c = matrix[row * bins + bin]!;
      if (c < 0) {
        throw new SwitchHonestyViolation(`spectrum bin ${bin} row ${row} has a negative count ${c}`);
      }
      sum += c;
    }
    const e = matrix[errorRow * bins + bin]!;
    if (e < 0) {
      throw new SwitchHonestyViolation(`spectrum bin ${bin} has a negative error count ${e}`);
    }
    if (e > sum) {
      throw new SwitchHonestyViolation(
        `spectrum bin ${bin} error overlay ${e} exceeds its stack ${sum} — overlay semantics violated`,
      );
    }
    totals[bin] = sum;
    errors[bin] = e;
  }

  return Object.freeze({ t0, t1, binMs, totals: Object.freeze(totals), errors: Object.freeze(errors), events });
}

/**
 * Internal-consistency guard for an already-decoded density (the painter's
 * precondition; mutation-tested). Server-packed counts cannot be re-derived
 * client-side — this asserts everything that CAN be checked.
 */
export function assertMicroDensityConsistent(d: MicroDensity): void {
  if (d.totals.length !== d.errors.length || d.totals.length === 0) {
    throw new SwitchHonestyViolation(
      `micro density arrays disagree: totals=${d.totals.length} errors=${d.errors.length}`,
    );
  }
  if (!(d.t1 >= d.t0) || d.binMs <= 0) {
    throw new SwitchHonestyViolation("micro density window/bin geometry is not sane");
  }
  for (let i = 0; i < d.totals.length; i += 1) {
    const t = d.totals[i]!;
    const e = d.errors[i]!;
    if (!Number.isInteger(t) || t < 0 || !Number.isInteger(e) || e < 0 || e > t) {
      throw new SwitchHonestyViolation(
        `micro density bin ${i} is impossible: total=${t} errors=${e}`,
      );
    }
  }
}
