/**
 * Fixture builders — construct realistic outbound data that matches the
 * canonical harness contract shapes.
 *
 * Since `harnessReady` is false and the runtime is gated, the server returns
 * fixture data (not live runtime data) for config/timeline. Every fixture is
 * validated against the canonical Zod schemas (or validation functions)
 * before being sent.
 *
 * Values are derived from ROOT_POLICY (the authority) — not hardcoded
 * magic numbers. The fixture builders are the single owner of demo data
 * shape; route handlers call them and validate the result.
 *
 * The agents/metrics/timeline/tool-list fixture builders were removed when
 * their consumers were wired to the real runtime bridges (agents-bridge,
 * metrics-bridge, timeline-bridge, tools-bridge). Only the config-snapshot
 * and stream-model-event builders remain (used by the config route and the
 * LLM fixture fallback respectively).
 */


import {
  MODEL_EVENT_SCHEMA,
  USAGE_SCHEMA,
  randomUuid,
  type ModelEvent,
} from "../kernel/canonical.ts";

// ── ModelEvents (for SSE stream) ──

// ── ModelEvents (for SSE stream) ──

export function buildStreamModelEvents(): readonly ModelEvent[] {
  // A single consistent callId across tool_call_start/delta/done — matches
  // real OpenAI stream behavior (the callId is stable for one tool call).
  // Previously each event had its own random callId, which broke callId-based
  // row tracking and didn't reflect real stream semantics.
  const toolCallId = `call-${randomUuid()}`;
  const events: unknown[] = [
    { sequence: 0, protocol: "openai-responses", type: "start", responseId: `resp-${randomUuid()}` },
    {
      sequence: 1,
      protocol: "openai-responses",
      type: "text_delta",
      outputIndex: 0,
      delta: "The server architecture follows a ",
    },
    {
      sequence: 2,
      protocol: "openai-responses",
      type: "text_delta",
      outputIndex: 0,
      delta: "trust-boundary pattern with Zod validation.",
    },
    {
      sequence: 3,
      protocol: "openai-responses",
      type: "tool_call_start",
      outputIndex: 1,
      callId: toolCallId,
      name: "read_file",
    },
    {
      sequence: 4,
      protocol: "openai-responses",
      type: "tool_call_delta",
      outputIndex: 1,
      callId: toolCallId,
      argumentsDelta: '{"path":"server/index.ts"}',
    },
    {
      sequence: 5,
      protocol: "openai-responses",
      type: "tool_call_done",
      outputIndex: 1,
      callId: toolCallId,
      arguments: { path: "server/index.ts" },
    },
    {
      sequence: 6,
      protocol: "openai-responses",
      type: "usage",
      usage: USAGE_SCHEMA.parse({
        inputTokens: 450,
        outputTokens: 120,
        totalTokens: 570,
      }),
    },
    {
      sequence: 7,
      protocol: "openai-responses",
      type: "finish",
      outputIndex: 0,
      reason: "stop",
    },
  ];

  return events.map((evt) => MODEL_EVENT_SCHEMA.parse(evt));
}
