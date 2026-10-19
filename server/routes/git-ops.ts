/**
 * Git operations routes — branches, log, diff, status for a project.
 *
 * Routes:
 * GET /api/git/branches?path=<project> — list branches
 * GET /api/git/log?path=<project>&max=<n> — commit log
 * GET /api/git/diff?path=<project>&file=<f>&ref=<r> — diff summary
 * GET /api/git/diff-patch?path=<project>&file=<f>&ref=<r> — diff patch
 * GET /api/git/status?path=<project> — full git status
 *
 * (filesystem access owner): project-ownership is enforced at the
 * BRIDGE (git-ops-bridge.ts via server/fs-gate.ts), NOT in the route. The
 * route resolves the authenticated user + passes the `FsGate` to the
 * bridge; the bridge calls `assertProjectPathOwnership` at the choke
 * point. The per-route `requireProjectByPath` is removed.
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import type { ServerResponse } from "node:http";
import { getBranches, getLog, getDiffSummary, getDiffPatch, getGitStatus } from "../intelligence/git-ops-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { makeFsGate } from "../filesystem/fs-gate.ts";
import { requirePathQuery } from "../router/validate.ts";
import { serverConfig } from "../kernel/config.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
// The SAME principled-refusal classifier the block door uses — one owner, so
// the family (the typed 428/503 the server raises on purpose) can never
// disagree between the two surfaces.
import { principledRefusalOf } from "../blocks/define.ts";

/**
 * THE PRINCIPLED-REFUSAL ENVELOPE, at this family's own door.
 *
 * A refused git read is a DESIGNED refusal (self-protection's typed 503
 * `git_not_run`, with the guardian's own sentence and the way out). The
 * browser logs every non-2xx STATUS itself, before any page code runs, so
 * serving the refusal as a 503 printed a standing console error at every
 * run-pane open on the self-protected project — the same measured defect the
 * block routes' envelope closed at boot (UIE-001). This family joins that
 * contract: the refusal travels in a 200 body as data, the client's fetch
 * choke point (`src/data/broker.ts::fetchJson`) reconstructs the typed
 * `ClientError` every consumer already understands, and a real failure (an
 * untyped 500, a zod 400) keeps its error status and propagates untouched.
 *
 * The body is the refusal ALONE — no `count`, no `branches`, no
 * `dirtyFiles`. A refusal envelope that also carried an empty data shape
 * would hand a conflating reader the exact "rendered as emptiness" lie the
 * pinned guard below exists to prevent.
 */
function sendGitRead(res: ServerResponse, compute: () => unknown): void {
  try {
    sendJson(res, compute());
  } catch (err) {
    const refusal = principledRefusalOf(err);
    if (refusal !== null) {
      sendJson(res, { refusal });
      return;
    }
    throw err;
  }
}

export function registerGitOpsRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/git/branches", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    sendGitRead(ctx.res, () => {
      const branches = getBranches(projectPath, gate);
      return { count: branches.length, branches };
    });
  });

  router.get("/api/git/log", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    // the default is the single config owner
    // `gitLogDefaultEntries`; the cap is enforced by the bridge
    // (`gitMaxLogEntries`). The route no longer re-caps with a scattered
    // `100` literal — the bridge is the ONLY capper (SPO: one owner).
    const maxRaw = ctx.query.get("max");
    const max = maxRaw !== null && maxRaw.length > 0
      ? (parseInt(maxRaw, 10) || serverConfig.gitLogDefaultEntries)
      : serverConfig.gitLogDefaultEntries;
    sendGitRead(ctx.res, () => {
      const log = getLog(projectPath, max, gate);
      return { count: log.length, log };
    });
  });

  router.get("/api/git/diff", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const ref = ctx.query.get("ref") ?? undefined;
    sendGitRead(ctx.res, () => getDiffSummary(projectPath, ref, gate));
  });

  router.get("/api/git/diff-patch", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    const file = ctx.query.get("file") ?? undefined;
    const ref = ctx.query.get("ref") ?? undefined;
    // The bridge owns the whole answer: the patch, the typed repository
    // fact and the no-repository sentence it carries — so a reader can never
    // be told "no difference" about a folder no repository tracks.
    sendGitRead(ctx.res, () => getDiffPatch(projectPath, file, ref, gate));
  });

  router.get("/api/git/status", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const projectPath = requirePathQuery(ctx);
    const gate = await makeFsGate(user.userId, db, projectPath);
    sendGitRead(ctx.res, () => getGitStatus(projectPath, gate));
  });
}
