/**
 * Agents route — returns the current agent states, available agent types,
 * and configured agent profiles.
 *
 * Routes:
 * GET /api/agents — AgentState[] (live agent states from timeline)
 * GET /api/agents/types — available agent types (from registry)
 * GET /api/agents/profiles — configured agent profiles (from config)
 * GET /api/agents/config — agent config summary (max concurrent, orchestration)
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { getAgentStatesForUser } from "../agent/agents-bridge.ts";
import { listAgentTypes, listAgentProfiles, getAgentsConfigSummary } from "../agent/agent-types-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerAgentRoutes(router: Router, db: AsyncDbClient): void {
  // (deny-by-default): the agent-state store is GLOBAL (keyed by
  // runId, no user_id column). Without scoping, User B would see User A's
  // running agents. The caller's owned-runId set (resolved at the DB layer
  // via `allRunIdsForUser`) filters the list so only the caller's agents
  // surface. types/profiles/config are GLOBAL harness config (not user
  // data), so they remain available to every authenticated user.
  router.get("/api/agents", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const runIds = new Set(await db.allRunIdsForUser(user.userId));
    const agents = getAgentStatesForUser(runIds);
    sendJson(ctx.res, agents);
  });

  router.get("/api/agents/types", async (ctx) => {
    await requireUserContext(ctx, db);
    const types = listAgentTypes();
    sendJson(ctx.res, { count: types.length, types });
  });

  router.get("/api/agents/profiles", async (ctx) => {
    await requireUserContext(ctx, db);
    const profiles = listAgentProfiles();
    sendJson(ctx.res, { count: profiles.length, profiles });
  });

  router.get("/api/agents/config", async (ctx) => {
    await requireUserContext(ctx, db);
    const summary = getAgentsConfigSummary();
    sendJson(ctx.res, summary);
  });
}
