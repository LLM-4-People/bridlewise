/**
 * Client telemetry — the browser's back-channel into the ledger.
 *
 * The web client is a harness component: it renders the run, ingests the
 * SSE feed, and — until this block — produced zero observability of its
 * own. An uncaught page error, a frozen main thread, a stalled feed were
 * all invisible in the one place built to hold them. This block is the
 * single ingestion door that closes that gap: the page sends FACTS (what
 * it measured about itself), the server VALIDATES, REDACTS and ATTRIBUTES
 * them, and only then do they become ledger events.
 *
 * ── WHY A BLOCK ACTION AND NOT A HAND-WRITTEN ROUTE ────────────────────────
 *
 * Ingestion is a POST with side effects (ledger writes), and the block
 * action is the sanctioned door for exactly that shape: the
 * `LEGACY_ROUTES` ratchet's own rule is "a new capability must be a
 * `defineBlock`". Declaring the action buys, without re-implementing any
 * of them: zod input validation at the door (a malformed batch is a typed
 * 400, never a handler crash), the router's auth + CSRF + rate-limit
 * middleware, the ambient actor from the request's recording boundary,
 * and the action's own `task`-lane effect record — the ingest itself is
 * recorded, so "a batch arrived" is an event even when every event inside
 * it is refused.
 *
 * ── THE SERVER NEVER TRUSTS THE CLIENT'S CLAIMS ─────────────────────────────
 *
 * The client sends facts + a correlation claim (runId/chatId/traceId of the
 * run it was watching). Every claim is VERIFIED against the caller's own
 * data before it is attributed: the run must belong to the caller
 * (`runBelongsToUser`), the chat must belong to the caller
 * (`chatBelongsToUser`), and the trace must be provably the caller's (the
 * same indexed ownership probe the timeline query route uses —
 * `traceMatchesAnyRun` over the caller's owned run set). An unverified
 * claim is DROPPED, never recorded as attributed: the events still land,
 * attributed to the caller alone, and the response says so
 * (`correlation: "unattributed"`). Recording the events unattributed
 * rather than refusing the whole batch is the honest choice — the actor
 * is a server-side fact either way, the facts are real either way, and
 * only the CLAIMED correlation (which could be a foreign run id, a stale
 * id, or an attempt to pollute another user's timeline) is discarded.
 * Refusing instead would lose real error facts to protect nothing.
 *
 * ── REDACTION HAPPENS HERE, BEFORE THE DOCUMENT EXISTS ──────────────────────
 *
 * The ledger stores document content verbatim, so masking must happen
 * before the write — the same rule every other capture path follows. A
 * client error message can quote anything the page threw, including a
 * credential a user pasted into a prompt. Every string fact and every
 * error message walks the single redaction owner (`redactStringValues`)
 * before it becomes a document, and the canary arm in the owning test
 * proves a credential-shaped error message reaches the ledger with zero
 * secret bytes on disk.
 *
 * ── VOLUME IS BOUNDED TWICE, AND THE OVERFLOW IS STATED ─────────────────────
 *
 * Once by the schema (a batch over the event cap is a typed 400 refusal
 * — an honest client never sends one, since its own buffer drops with a
 * count first), and once by a dedicated per-user token bucket
 * (`client-telemetry:user:<id>`, the rate-limiter owner's own primitive
 * with a distinct key) so a telemetry storm cannot eat the main API
 * budget and the main API cannot starve telemetry. A refused batch is a
 * 429 the client counts and reports as a `dropped` fact on its next
 * successful batch — the drop is recorded, never silent.
 *
 * ── THE LIVE SUMMARY ───────────────────────────────────────────────────────
 *
 * The ingestion door keeps process-lifetime counters (client errors seen,
 * worst long task reported) that the metrics bridge folds into the
 * performance exposure signals — the instruments room's client-health
 * rows read the same door the ledger writes, so the signal and the record
 * cannot disagree.
 */

import { z } from "zod";

import { RateLimitError } from "../kernel/errors.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import {
  currentActor,
  truncateForLedger,
  withRecordingContext,
} from "../kernel/canonical.ts";
import { redactStringValues } from "../llm/redaction.ts";
import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import { consumeScopedToken, rateLimitRetryAfterSeconds } from "../router/rate-limiter.ts";
import { sha256 } from "../kernel/digest.ts";
import { TIMELINE_CLIENT_FACTS_DOCUMENT } from "../../shared/constants.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

// ── Bounds (safety invariants, not configurables) ───────────────────────────
//
// These are validation limits at a trust boundary — the same class as every
// zod `.max()` on the route surface (the timeline query's 10,000-event page
// cap, the tool-toggle's 256-char name). They bound what an untrusted body
// may claim in one request; they are not operational knobs an operator
// tunes, so they live here beside the schema that enforces them rather
// than in the config file.

// The bounds are inline literals at the schema — the same shape every
// other route schema uses (a trust-boundary validation limit, not an
// operational tunable): a batch past the event cap is a malformed or
// hostile batch (an honest client flushes at most 20 — its own flush cap);
// the fact-value/key/length caps bound an untrusted body's claim; the
// timestamp cap (epoch ms at 2100-01-01T00:00:00Z) keeps a client "clock"
// from claiming a time nobody can check — the client timestamp is recorded
// as a fact and never used as the event's wallTime (the server stamps that).

const ClientTelemetryEvent = z.strictObject({
  kind: z.enum(["client-error", "client-metric"]),
  clientTimestamp: z.number().finite().nonnegative().max(4102444800000),
  facts: z
    .record(
      z.string().min(1).max(64),
      z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
    )
    .refine((facts) => Object.keys(facts).length <= 24, {
      message: "too many facts on one event",
    }),
});

const ClientTelemetryBatch = z.strictObject({
  events: z.array(ClientTelemetryEvent).min(1).max(32),
  /** The correlation the client claims for the batch — the run it was
   * watching, the chat it sat in, the request trace the run carried.
   * Every id is verified before attribution; an unverified claim is
   * dropped, never recorded as attributed. */
  correlation: z
    .strictObject({
      runId: z.string().min(1).max(256).optional(),
      chatId: z.string().min(1).max(256).optional(),
      traceId: z.string().min(1).max(256).optional(),
    })
    .optional(),
  /** How many events THIS CLIENT dropped without sending (buffer cap,
   * refused batches). Reported to the server so the ledger can hold the
   * hole: recorded as its own client-metric, never folded into anything. */
  droppedCount: z.number().int().nonnegative().max(1_000_000).optional(),
});

const IngestOutput = z.strictObject({
  recorded: z.number().int().nonnegative(),
  /** `"verified"` — every claimed id was proven the caller's own;
   *  `"unattributed"` — the batch was recorded against the caller alone
   *  because a claimed id failed verification;
   *  `"none"` — the client claimed no correlation. */
  correlation: z.enum(["verified", "unattributed", "none"]),
  /** The overflow report itself, when the client stated one. */
  droppedRecorded: z.number().int().nonnegative(),
});

// ── The live summary (what the exposure signals read) ───────────────────────

const summary = {
  clientErrors: 0,
  worstLongTaskMs: 0,
};

/**
 * The client-health facts the performance exposure signals serve: how many
 * browser errors this process ingested, and the worst long task any client
 * reported. Zero until the first batch lands — the honest absence, same
 * contract as the resource sampler's last-tick signal.
 */
export function clientTelemetrySummary(): Readonly<{
  clientErrors: number;
  worstLongTaskMs: number;
}> {
  return Object.freeze({ ...summary });
}

/** Reset the live summary (test-only — keeps suites independent). */
export function resetClientTelemetrySummary(): void {
  summary.clientErrors = 0;
  summary.worstLongTaskMs = 0;
}

/** The worst long task a batch reported, read from its (validated) facts. */
function claimedWorstLongTaskMs(facts: Record<string, unknown>): number {
  const claimed = facts["longTaskMs"];
  return typeof claimed === "number" && Number.isFinite(claimed) && claimed > 0 ? claimed : 0;
}

// ── Correlation verification (the trace-gate discipline) ─────────────────────

/**
 * Verify the batch's claimed correlation against the CALLER's own data.
 * Returns the ids that survived verification; a failed claim is absent from
 * the result and the caller records the whole batch as unattributed.
 *
 * The trace probe is the same one the timeline query route uses for its
 * `traceId` filter: an indexed lookup proving SOME event in the trace
 * carries a run the caller owns. It is not a page fetch + scan.
 */
async function verifiedCorrelation(
  db: AsyncDbClient,
  userId: string,
  claimed: Readonly<{ runId?: string; chatId?: string; traceId?: string }>,
): Promise<Readonly<{ runId?: string; chatId?: string; traceId?: string }>> {
  const out: { runId?: string; chatId?: string; traceId?: string } = {};
  let anyClaimed = false;
  let anyVerified = false;
  if (claimed.runId !== undefined) {
    anyClaimed = true;
    if (await db.runBelongsToUser(claimed.runId, userId)) {
      out.runId = claimed.runId;
      anyVerified = true;
    }
  }
  if (claimed.chatId !== undefined) {
    anyClaimed = true;
    if (await db.chatBelongsToUser(claimed.chatId, userId)) {
      out.chatId = claimed.chatId;
      anyVerified = true;
    }
  }
  if (claimed.traceId !== undefined) {
    anyClaimed = true;
    const ownedRunIds = await db.allRunIdsForUser(userId);
    const store = getTimelineStore();
    if (ownedRunIds.length > 0 && store.traceMatchesAnyRun(claimed.traceId, [...ownedRunIds], store.ledgerId)) {
      out.traceId = claimed.traceId;
      anyVerified = true;
    }
  }
  if (!anyClaimed) return {};
  if (!anyVerified) return {};
  // A batch where SOME claims verified and some failed keeps the verified
  // ids and still reports `unattributed` — the caller learns a claim was
  // dropped, and no unverified id reaches the ledger.
  return anyVerified ? out : {};
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * ONE REDACTION PASS, THEN ONE WRITE. The facts object is walked by the
 * single redaction owner before the document exists; the description and
 * the error message are built FROM THE REDACTED copy, so no unredacted
 * byte survives into the description either.
 *
 * The verified run and trace are re-entered as the RECORDING CONTEXT for
 * this one event (the recorder reads both from ambient provenance — one
 * owner, no call site can forget them), which is what joins the fact to
 * the run's causal chain in the ledger. The verified CHAT rides the
 * run instead: the chat↔run binding lives in the projection DB, and the
 * lane's expressible correlation keys are run and trace — a chat-scoped
 * query reaches this event through the run it is verified against.
 */
function recordClientEvent(
  event: z.infer<typeof ClientTelemetryEvent>,
  correlation: Readonly<{ runId?: string; traceId?: string }>,
): void {
  const redactedFacts = redactStringValues(event.facts) as Record<string, unknown>;
  const isMetric = event.kind === "client-metric";
  const description = isMetric
    ? truncateForLedger(`browser metric: ${Object.keys(redactedFacts).sort().join(", ")}`)
    : truncateForLedger(
        `browser error: ${typeof redactedFacts["message"] === "string" ? redactedFacts["message"] : "(no message)"}`,
      );
  const factsJson = JSON.stringify(redactedFacts);
  const input = {
    eventType: event.kind as "client-error" | "client-metric",
    description,
    outcome: (isMetric ? "succeeded" : "failed") as "succeeded" | "failed",
    ...(isMetric
      ? {}
      : { error: { category: "client", code: "client_error", message: description, retryable: false } }),
    documents: [
      {
        name: TIMELINE_CLIENT_FACTS_DOCUMENT,
        contentJson: factsJson,
        contentDigest: sha256(factsJson),
      },
    ],
  };
  if (correlation.runId !== undefined || correlation.traceId !== undefined) {
    withRecordingContext(
      {
        actor: currentActor(),
        ...(correlation.runId !== undefined ? { runId: correlation.runId } : {}),
        ...(correlation.traceId !== undefined ? { traceId: correlation.traceId } : {}),
      },
      () => getTimelineRecorder().recordEvent(input),
    );
  } else {
    // No verified claim: the ambient (ingest request) context stands — the
    // event hangs off this request's own chain, the honest parent for a
    // fact that claimed nothing the server could prove.
    getTimelineRecorder().recordEvent(input);
  }
}

// ── The block ───────────────────────────────────────────────────────────────

/** Register the client-telemetry ingestion block. */
export function defineClientTelemetryBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "client.telemetry",
    title: "Client telemetry ingest",
    description:
      "The browser's back-channel: the page's captured facts — uncaught errors, long tasks, feed-ingest lag — recorded into the timeline ledger, attributed to you and to the run, chat and request trace the server can prove you own.",
    signals: ["performance.clientErrors", "performance.clientWorstLongTaskMilliseconds"],
    actions: {
      ingest: {
        input: ClientTelemetryBatch,
        output: IngestOutput,
        title: "Send browser telemetry",
        consequence:
          "Records this browser's captured facts — uncaught page errors and renderer measurements — into the recorded timeline under your account, and under the run, chat and request trace whose ownership the server can verify. Secret-looking text is masked before it is stored. Takes effect immediately.",
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          // A DEDICATED bucket, charged per batch: telemetry cannot exhaust
          // the shared API budget (the router already charged this request
          // one token there) and the API cannot starve telemetry. The
          // scoped-bucket door is the rate-limiter owner's own — the key is
          // derived inside the limiter from the declared scope + the
          // server-established user id, never from the request.
          if (!consumeScopedToken("client-telemetry", user.userId)) {
            // Honest on overflow: the refusal tells the client to count the
            // drop and report it on its next accepted batch, so the hole the
            // budget carved is itself recorded, never silent. The retry
            // window is the rate-limiter owner's own answer.
            throw new RateLimitError(
              "Client telemetry batch refused: this account's telemetry budget is exhausted. The dropped events are counted client-side and reported on the next accepted batch.",
              rateLimitRetryAfterSeconds(),
              "client_telemetry_rate_limited",
            );
          }
          const claimed = input.correlation ?? {};
          const verified = await verifiedCorrelation(db, user.userId, claimed);
          // All three claims are verified for trust; the two the lane can
          // express (run + trace) are what get attributed. A chat that
          // fails verification still demotes the batch to `unattributed`
          // — an unverified claim is dropped, never half-accepted.
          const correlationState: "verified" | "unattributed" | "none" =
            Object.keys(claimed).length === 0
              ? "none"
              : Object.keys(verified).length === Object.keys(claimed).length
                ? "verified"
                : "unattributed";
          for (const event of input.events) {
            recordClientEvent(event, {
              ...(verified.runId !== undefined ? { runId: verified.runId } : {}),
              ...(verified.traceId !== undefined ? { traceId: verified.traceId } : {}),
            });
            if (event.kind === "client-error") summary.clientErrors += 1;
            const worst = claimedWorstLongTaskMs(event.facts);
            if (worst > summary.worstLongTaskMs) summary.worstLongTaskMs = worst;
          }
          let droppedRecorded = 0;
          if (input.droppedCount !== undefined && input.droppedCount > 0) {
            // THE HOLE IS ITSELF A FACT. The client dropped events it could
            // not send; recording the count (and nothing else about them —
            // the client never held their content by then) keeps the ledger
            // honest about what it does not hold.
            const droppedJson = JSON.stringify({ droppedClientEvents: input.droppedCount });
            getTimelineRecorder().recordEvent({
              eventType: "client-metric",
              description: "browser metric: droppedClientEvents",
              outcome: "succeeded",
              documents: [
                {
                  name: TIMELINE_CLIENT_FACTS_DOCUMENT,
                  contentJson: droppedJson,
                  contentDigest: sha256(droppedJson),
                },
              ],
            });
            droppedRecorded = 1;
          }
          return {
            recorded: input.events.length + droppedRecorded,
            correlation: correlationState,
            droppedRecorded,
          };
        },
      },
    },
  });
}
