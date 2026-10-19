/**
 * THE ANNUNCIATOR FEED (§2.4) — what lights the HORIZON's center slots.
 *
 * `ShellApi.setAnnunciators` existed with ZERO callers: the surface was
 * declared, rendered, capped at three, and permanently dark — the product's
 * own "correct and unplugged" failure, on the instrument whose whole job is
 * saying that something is abnormal. This module is the missing PRODUCER,
 * not a second path: the contract, the cap and the rendering all stand
 * unchanged, and the shell consumes this one derivation.
 *
 * WHAT LIGHTS A SLOT, from the design's own words: "dark when healthy (a
 * lit slot = a fact in abnormal state + its verb: `1 check failing ·
 * rerun`)" and "a tripped breaker is an annunciator" (§5.2). The two are
 * the unambiguous core, and they are exactly the abnormal facts with NO
 * OTHER STANDING MANIFESTATION: the flow renders check DELTAS only ("never
 * a static checks block — standing state lives in the annunciator"), and a
 * tripped breaker's row is hidden inside the closed desk.
 *
 * WHAT DELIBERATELY DOES NOT LIGHT ONE — decided, not deferred:
 *   - a REFUSED RUN already stands in the flow's wait row with the server's
 *     sentence (wait-stage.ts `waitEnd`); a slot for it would be a second
 *     manifestation of one fact (§1.4);
 *   - an UNREACHABLE API blocks the whole cockpit (ConnectionBlock) — an
 *     annunciator inside chrome the block hides could never be read.
 * The FIRED-TRIGGER family joined as the third (a trigger the operator
 * armed, tripping, is an abnormal fact by their own declaration, with no
 * other standing light — the mark is at the instant, the row is a list
 * entry, the finding is a sentence that passes; the LAMP is this slot).
 * Any further abnormal family (§2.4 leaves the set open) joins HERE, in the
 * one derivation, never as a second `setAnnunciators` caller.
 *
 * SCOPED BY THE REAL SELECTION (state/projects, state/chats) — deliberately
 * NOT by the auto-check panel's own scope atoms, which nothing in the
 * cockpit arms; deriving from those would rebuild the exact permanently-dark
 * defect this module closes, one layer down.
 */

import { computed, type ReadableAtom } from "nanostores";

import { action } from "../../data/broker.ts";
import { autoChecks, type AutoCheck } from "../../state/auto-checks.ts";
import { currentProject } from "../../state/projects.ts";
import { currentChatId } from "../../state/chats.ts";
import { breakerLoads, resetBreaker } from "../desk/desk-feed.ts";
import { armedTriggers } from "../sweep/sweep-store.ts";
import { armTriggerLabel } from "../sweep/arm-fire.ts";
import { formatClock } from "../sweep/now-edge.ts";
import { requestBandGo } from "../sweep/band-request.ts";
import type { Annunciator } from "./contract.ts";

/**
 * Priorities: a failing check outranks a tripped breaker because the check
 * is about the WORK (the code is broken now) while the breaker is about a
 * TOOL's future calls. A FIRED trigger sits below both — it is a past fact
 * the reader asked to be told about, not a standing fault — and the numbers
 * exist so a further family slots in without renumbering these three.
 */
const CHECKS_PRIORITY = 90;
const BREAKERS_PRIORITY = 80;
const FIRINGS_PRIORITY = 70;

/**
 * The LATEST SETTLED result per check name, for the current project.
 *
 * Every rerun INSERTS a row, so the raw store holds the whole history and
 * "is this check failing" is a question about the newest settled row only.
 * A `running` row is a measurement in flight, not a result — it neither
 * fails nor clears; the last settled result stands until replaced.
 */
function latestSettledByName(
  checks: readonly AutoCheck[],
  projectId: string,
): Map<string, AutoCheck> {
  const latest = new Map<string, AutoCheck>();
  for (const check of checks) {
    if (check.projectId !== projectId) continue;
    if (check.status === "running") continue;
    const held = latest.get(check.checkName);
    if (held === undefined || Date.parse(check.createdAt) >= Date.parse(held.createdAt)) {
      latest.set(check.checkName, check);
    }
  }
  return latest;
}

/**
 * The verb behind "run again". The action ledger records the outcome either
 * way (broker.ts `recordAction`), and the `check:complete` invalidation
 * refreshes the displayed list when results land — the same path the
 * failing-check card's own verb takes. The catch keeps a refusal (a planted
 * head) from surfacing as an unhandled rejection; the refusal is already in
 * the ledger, which is where LENS reads it.
 */
function rerunChecks(projectId: string): void {
  void action("checks.auto", "rerun", { projectId }, { invalidates: ["check:complete"] }).catch(
    () => undefined,
  );
}

/** The lit slots, derived. Empty when everything is healthy — dark is the
 *  resting state, and an empty array is how this feed says it. */
export const horizonAnnunciators: ReadableAtom<readonly Annunciator[]> = computed(
  [autoChecks, currentProject, currentChatId, breakerLoads, armedTriggers],
  (checks, project, chatId, breakers, arms) => {
    const lit: Annunciator[] = [];

    if (project !== null) {
      const latest = latestSettledByName(checks, project.id);
      const failing = [...latest.values()].filter((c) => c.status === "failed");
      if (failing.length > 0) {
        const names = failing.map((c) => c.checkName).sort().join(", ");
        lit.push({
          id: "checks-failing",
          label: `${failing.length} check${failing.length === 1 ? "" : "s"} failing`,
          verb: { label: "run again", run: () => rerunChecks(project.id) },
          priority: CHECKS_PRIORITY,
          reason: `latest result per check in “${project.name}”: ${names} failing — run again replaces each result with a fresh one`,
        });
      }
    }

    if (chatId !== null) {
      const load = breakers[chatId];
      if (load !== undefined && load.kind === "measured") {
        const tripped = load.rows.filter((row) => row.state === "tripped");
        if (tripped.length > 0) {
          const names = tripped.map((row) => row.label).join(", ");
          lit.push({
            id: "breakers-tripped",
            label: `${tripped.length} breaker${tripped.length === 1 ? "" : "s"} tripped`,
            verb: {
              label: "reset",
              run: () => {
                for (const row of tripped) void resetBreaker(chatId, row.id).catch(() => undefined);
              },
            },
            priority: BREAKERS_PRIORITY,
            reason: `${names} tripped after repeated recorded failures — reset closes the breaker so the tool may run again`,
          });
        }
      }
    }

    // A FIRED TRIGGER IS AN ANNUNCIATOR in the aerospace sense: a lamp that
    // lit when its condition occurred and stays lit until acknowledged.
    // The rows in the arm menu's "cocked" group are the acknowledgement —
    // clearing a fired row (or re-arming it, which re-cocks) puts the light
    // out; nothing here clears on its own. Firing state is this browser's
    // (serverSideFiring: false), so the scope is the operator's own arms,
    // not the selected chat — the light follows the reader.
    const fired = arms.filter((t) => t.firedAtMs !== null);
    if (fired.length > 0) {
      const latest = fired.reduce((a, b) =>
        (a.firedAtMs ?? 0) >= (b.firedAtMs ?? 0) ? a : b,
      );
      lit.push({
        id: "arm-fired",
        label: `${fired.length} trigger${fired.length === 1 ? "" : "s"} fired`,
        verb: {
          label: "go",
          run: () => {
            if (latest.firedAtMs !== null) requestBandGo(latest.firedAtMs);
          },
        },
        priority: FIRINGS_PRIORITY,
        reason: `${armTriggerLabel(latest)} fired at ${formatClock(latest.firedAtMs ?? 0)} — go plants the band at that instant; the light clears when the row is cleared or re-armed`,
      });
    }

    return lit;
  },
);
