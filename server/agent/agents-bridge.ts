/**
 * Agents bridge — the server-side adapter to the canonical harness agent
 * state store. The store is backed by the real timeline recorder (the same
 * ledger the run route writes to), so agent states recorded by the runtime
 * are returned here. Until agents run, the list is empty (truthful: no
 * active agents), replacing the fixture demo states.
 */

import { getTimelineRecorder } from "../observability/timeline-bridge.ts";
import { createAgentStateStore, type AgentState, type AgentStateStore } from "../kernel/canonical.ts";
import { publishRunFrame } from "../run/run-feed.ts";
import { SSE_EVENT_TYPES } from "../../shared/constants.ts";

let store: AgentStateStore | undefined;

/**
 * Wrap the store so EVERY lifecycle transition publishes the new agent
 * state on the agent's OWN run feed (AgentState carries its runId). Without
 * this the store was written to by the runtime and read only at run end —
 * the Agents pane stayed empty during the run it was meant to narrate (the
 * wired-but-inert class). Publishing at the store's choke point means every
 * record path — the runtime's, a future reconciler's — is live by
 * construction, and the end-of-run batch in run-executor stays as the
 * terminal snapshot.
 */
function publishing(store: AgentStateStore): AgentStateStore {
  const publish = (agent: AgentState): AgentState => {
    publishRunFrame(agent.runId, SSE_EVENT_TYPES.agent, agent);
    return agent;
  };
  return {
    ...store,
    recordAgentStart: (input) => publish(store.recordAgentStart(input)),
    recordAgentTurn: (input) => publish(store.recordAgentTurn(input)),
    recordAgentCompletion: (input) => publish(store.recordAgentCompletion(input)),
    recordAgentFailure: (input) => publish(store.recordAgentFailure(input)),
    recordAgentCancellation: (input) => publish(store.recordAgentCancellation(input)),
    recordAgentSuspension: (input) => publish(store.recordAgentSuspension(input)),
    recordAgentResumption: (input) => publish(store.recordAgentResumption(input)),
    recordAgentTimeout: (input) => publish(store.recordAgentTimeout(input)),
    recordCompaction: (input) => publish(store.recordCompaction(input)),
  };
}

function getAgentStore(): AgentStateStore {
  if (store !== undefined) return store;
  store = publishing(createAgentStateStore(getTimelineRecorder()));
  return store;
}

/**
 * The SHARED agent-state store — the ONE in-memory view over the timeline
 * ledger. The agent-runtime bridge (server/agent-runtime-bridge.ts) records
 * delegations into THIS store so the Agents tab (below) and the delegation
 * tools read the SAME source — two stores over one ledger is the two-answers
 * defect (a delegated agent would land in the run's store and never reach the
 * tab). Per-run isolation for `get_agent_state` is applied at READ time (the
 * bridge filters by its own runId), never by forking the store. Exported for
 * the bridge only; routes keep using the scoped accessors below.
 */
export function sharedAgentStateStore(): AgentStateStore {
  return getAgentStore();
}

// The agent-state store is GLOBAL (keyed by runId, no user_id column).
// DENY-BY-DEFAULT: the store's `allAgentStates` is NOT exported — a caller
// that iterated it directly would leak every user's running agents. Only
// the scoped accessors below are exported: `getAgentStatesForUser` (the
// route supplies the caller's owned-runId set) and `getAgentStatesForRun`
// (the run stream supplies its own server-generated runId). Both filter at
// this choke point so a consumer that forgets to scope cannot leak.

/** The agent states belonging to a caller — `allAgentStates` filtered to
 * the run IDs the caller owns (Single-Party-Owner: the agent-state store is
 * GLOBAL, keyed by runId with no user_id column; without this filter User B
 * would see User A's running agents — a cross-user leak). The caller
 * supplies its owned-runId set (resolved by the route via
 * the data facade's `allRunIdsForUser`) so this bridge stays decoupled from the DB
 * (the route is the integration point). An agent state whose runId is not
 * in the set is hidden (deny-by-default).
 */
export function getAgentStatesForUser(
  userRunIds: ReadonlySet<string>,
): readonly ReturnType<AgentStateStore["allAgentStates"]>[number][] {
  return getAgentStore().allAgentStates().filter((s) => userRunIds.has(s.runId));
}

/** The agent states for a single run — used by the run stream to emit only
 * THIS run's agents over SSE. The runId is the caller's own server-generated
 * run id (bound at /api/run/start), so this is scoped by construction. */
export function getAgentStatesForRun(
  runId: string,
): readonly ReturnType<AgentStateStore["allAgentStates"]>[number][] {
  return getAgentStore().allAgentStates().filter((s) => s.runId === runId);
}
