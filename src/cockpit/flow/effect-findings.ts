/**
 * COCKPIT FLOW — effect-seam findings (spec §3.3 step 6, §4.3).
 *
 * When an effect beat commits, the computer speaks at the effect seam:
 * the impact reach of the changed file, computed from the EXISTING
 * `code.impact` block (an exact reverse-import walk — no model, no guess).
 * Docked through the admission controller (one per seam; dismissal-learned
 * kinds retreat to ask-only). A zero-reach join docks nothing — absence of
 * a finding is the honest output (§4.8).
 *
 * THE READ GOES THROUGH THE BROKER'S DOOR (§6.2). It used to be a raw
 * `fetchJson(blockRequestPath(…))`, which reached AROUND the one door client
 * I/O goes through and so carried neither the ambient `until` nor the honest
 * refusal: during a past view this join answered from LIVE data while the
 * banner said the screen was showing an earlier instant, and it wrote no
 * provenance, which made the finding structurally unexplainable. `read()`
 * applies all three. `code.impact` declares no `until`, so a past view makes
 * this read THROW — and a seam finding's honest response to "I cannot answer
 * for that instant" is to stay quiet, which is what the catch below does.
 *
 * The derivation's `asOf` is read back out of the Broker's own provenance
 * record for the read it just performed — the server's number, recorded at
 * the choke point, never `Date.now()`.
 */

import { read, readKey } from "../../data/broker.ts";
import { serverAsOfFor } from "../../state/lens.ts";
import { dockEffectSeamFinding } from "./dock.ts";
import type { Beat } from "./types.ts";

type ImpactData = Readonly<{
  directlyAffected: readonly string[];
  transitivelyAffected: readonly string[];
  totalAffected: number;
}>;

/**
 * Compute and dock the impact finding for one effect beat. Failures are
 * swallowed into "no finding" — a seam finding is an offer, not a report
 * the user asked for; the ask grammar surfaces the same join WITH its
 * errors when asked explicitly.
 */
export async function dockImpactFinding(effectBeat: Beat, projectPath: string): Promise<void> {
  const file = effectBeat.effect?.path;
  if (file === undefined) return;
  const params = { path: projectPath, file };
  let d: ImpactData;
  try {
    d = await read<ImpactData>("code.impact", { params });
  } catch {
    // Honest absence — the seam stays quiet rather than guessing. This is
    // also the past-view path: `code.impact` cannot answer for an earlier
    // instant, and no finding is better than a live one wearing a past
    // timestamp.
    return;
  }
  if (typeof d?.totalAffected !== "number" || d.totalAffected === 0) return;
  // §4.4: a finding carries the asOf of its OLDEST input. When the server
  // stated none we have no measured age to report, and inventing one (the
  // moment we happened to look) would claim a freshness nobody measured — so
  // the seam stays quiet instead.
  const asOf = serverAsOfFor(readKey("code.impact", params));
  if (asOf === undefined) return;
  dockEffectSeamFinding(effectBeat.id, [
    {
      finding: {
        findingKind: "impact-reach",
        sentence:
          `This edit to ${file} can reach ${d.totalAffected} ${d.totalAffected === 1 ? "file" : "files"} ` +
          `through imports — ${d.directlyAffected.length} direct, ${d.transitivelyAffected.length} through chains`,
        derivation: {
          method:
            "walked the indexed import graph in reverse from the edited file: files importing it directly, then everything importing those",
          steps: [
            {
              source: "files importing it directly",
              sourceId: "code.impact",
              count: d.directlyAffected.length,
            },
            {
              source: "files reached through chains of imports",
              sourceId: "code.impact",
              count: d.transitivelyAffected.length,
            },
          ],
          asOf,
        },
      },
    },
  ]);
}
