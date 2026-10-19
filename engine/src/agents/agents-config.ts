/** Agents operational defaults — canonical owner for agent-domain configurable values. */
export const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
export const DEFAULT_ALIGNMENT_DRIFT_THRESHOLD_MS = 60_000;
export const DEFAULT_MAX_RECENT_TURNS = 10;
export const DEFAULT_MAX_TIMELINE_EVENTS = 50;
/** R49-V4: event-query limit when reconstructing an agent's state from the
 * timeline event store (agent + turn + token events). Previously three
 * scattered inline `limit: 10000` literals in agent-state.ts.
 * This is a safety cap on a bounded historical read, not an unbounded
 * fetch — the reconstruction reads the most recent N events per type. */
export const DEFAULT_AGENT_EVENT_QUERY_LIMIT = 10_000;

/** R50 (R49-F4): awareness-publish content cap. The orchestrator publishes
 * each agent turn's content into the shared live awareness store so peer
 * agents can observe progress. The published content is capped to bound
 * memory growth (a long agent turn could otherwise publish an unbounded
 * string). Previously a hardcoded inline `content.slice(0, 4096)` literal
 * in orchestrator.ts.
 * This is a safety cap on a bounded publish, mirroring the
 * DEFAULT_AGENT_EVENT_QUERY_LIMIT pattern: the agents operational-defaults
 * owner holds the named constant the orchestrator derives from. */
export const DEFAULT_AWARENESS_PUBLISH_CONTENT_CAP = 4_096;
