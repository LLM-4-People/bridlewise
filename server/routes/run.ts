/**
 * RUN CONTROL — start, cancel, steer. Every route here is a POST.
 *
 * The run's OUTPUT is not served from this file. `routes/run-stream.ts` owns
 * `GET /api/run/:runId/stream`, which subscribes to what a run published and
 * can start nothing; `routes/run-status.ts` owns the run's one plain read,
 * `GET /api/run/:runId/status`. Both are GETs, both live outside this file,
 * and that is the shape that makes "a GET cannot execute a run" a fact about
 * the modules rather than a hope about the code — this file reaches the
 * executor and contains no GET handler at all.
 *
 * ── WHY THE SPLIT EXISTS ───────────────────────────────────────────────────
 *
 * The GET used to be the executor and this route started nothing, so a run was
 * executed once per connection: two subscribers meant two provider calls,
 * billed twice, and the same tool dispatched twice. Worse, the run's life was
 * the response's life — either connection closing aborted the shared run, and
 * a dropped connection made it unreachable for good.
 *
 * Now: POST starts, GET attaches. The executor is refused a second time by the
 * database (`run_executions.run_id` is a PRIMARY KEY), and it demands a
 * `MutationWarrant` — which only a state-changing verb is handed, which a GET
 * handler cannot declare, and which is revoked when its request ends. The
 * type system refuses the ordinary route and the warrant registry refuses the
 * cast; `server/router.ts` states exactly which is which. Neither depends on
 * this file staying correct, which is the point of both.
 *
 * A DISCONNECT DOES NOT STOP A RUN. `POST /api/run/:runId/cancel` does, and it
 * is the only thing that does — which is what the product has always meant by
 * cancel. The prompt is already paid for by the time a socket drops; throwing
 * the answer away does not refund it, it only loses it.
 *
 * Persistence: when the start input includes a `chatId`, streamed events are
 * persisted to the DB projection (messages, tool_calls, timeline_refs). That
 * is the durable record; the feed is a replay buffer, not a store.
 *
 * Routes:
 *   POST /api/run/start          — start a run (201) → { runId }
 *   POST /api/run/:runId/cancel  — cancel a run → { cancelled, runId }
 *   POST /api/run/:runId/steer   — queue a steering message for the next turn
 */

import { z } from "zod";

import { generateId } from "../kernel/canonical.ts";
import type { Router } from "../router/router.ts";
import type { MutatingRouteHandler, MutationWarrant, RouteContext } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { MAX_PROMPT_LENGTH } from "../../shared/constants.ts";
import { assertValidBody } from "../router/validate.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import { MISALIGNMENT_POLICY_ERROR_CODE } from "../../engine/src/shared/llm/errors.ts";
import { buildConversationHistory } from "../context/chat-history.ts";
import { retrieveRelevantMemories } from "../context/memory-bridge.ts";
import {
  createRunContextManager,
  seedContextManagerFromHistory,
} from "../context/context-bridge.ts";
import { wireDedupForTurn } from "../awareness/dedup-bridge.ts";
import { getMemoryRetrievalLimit } from "../kernel/harness-config.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { ForbiddenError, NotFoundError, ChatRunLiveError, RunFinishingError, ConversationStoppedError } from "../kernel/errors.ts";
import { principledRefusalOf } from "../blocks/define.ts";
import { loadProviderStore, resolveProviderCredential } from "../llm/providers.ts";
// COCKPIT: the run.compose honoring point — the SAME function the
// `run.compose` block read calls, so the desk's strips and the run's input
// cannot disagree.
import { applyComposeAdjustments } from "../blocks/compose.ts";
import { setActiveRun, getActiveRun, deleteActiveRun, resolveRunOwner, notifyRunPauseAnswer, activeRunForChat, queueSteer } from "../run/run-registry.ts";
import { startRunExecution } from "../run/run-executor.ts";

// ── Input validation ──

const RUN_START_SCHEMA = z.strictObject({
  projectId: z.string().min(1).max(256),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  modelId: z.string().min(1).max(256).optional(),
  chatId: z.string().min(1).max(256).optional(),
});

// ── The effective model — ONE resolution point ──

/**
 * WHICH MODEL THIS RUN ACTUALLY USES.
 *
 * THE DEFECT THIS EXISTS TO KILL (user, verbatim: "the dropdown menu to pick
 * a model does not work, meaning I can pick something else but it does not
 * use it"). The desk's model picker writes the selection to the CHAT RECORD
 * (`PATCH /api/chats/:id { modelId }` → `chats.model_id`) — that write worked,
 * persisted, survived reload, and painted back correctly. The run route then
 * read the model from ONE place only: the request body. The cockpit send path
 * (`beginCockpitRun` → `startRun`) does not put `modelId` in that body, so
 * `input.modelId` was always `undefined`, `active.modelId` was always `null`,
 * and `streamChat` fell through to `loadDefaultModel()`. Captured live: chat
 * record `kimi-k2.6`, request body `{projectId, prompt, chatId}` with no
 * `modelId`, turn served by `gemma-4-31b`. Two sources for one fact, and the
 * one the UI writes to was not the one the run read.
 *
 * The fix is here rather than at the caller because the CHAT RECORD is the
 * owner of "the model this conversation uses" — it is what the picker writes,
 * what survives a reload, and what the picker paints back. A client that
 * forgets to echo it can no longer change which model runs; every client is
 * fixed at once (the cockpit composer, the `retry` verb, the legacy panel).
 *
 * PRECEDENCE, stated because two sources still exist:
 *   1. an explicit `modelId` in the request — a caller that NAMES a model
 *      means it (this is how a one-off run overrides the conversation);
 *   2. the chat's recorded `model_id` — the picker's own write;
 *   3. null — no chat, or a chat that never chose. The user's SAVED default
 *      model then answers, and if they have not saved one the run REFUSES and
 *      says so. Nothing invents a model here any more: the server-wide
 *      default this used to fall through to was a second source of truth for
 *      a question the user answers in Settings.
 *
 * The chat is already proven to belong to the caller by the ownership check
 * above; `getChat` re-scopes by user anyway, so a foreign chat resolves to
 * null rather than leaking its model.
 */
async function resolveRunModelId(
  db: AsyncDbClient,
  input: Readonly<{ modelId?: string | undefined; chatId?: string | undefined }>,
  userId: string,
): Promise<string | null> {
  if (input.modelId !== undefined) return input.modelId;
  if (input.chatId === undefined) return null;
  return (await db.getChat(input.chatId, userId))?.model_id ?? null;
}

// ── Route registration ──

/**
 * The one-live-run-per-conversation refusal sentence. One owner because the
 * gate refuses in two places (the fast early check and the atomic recheck at
 * the registration) and a drift between the two would be two different
 * promises about the same rule.
 */
const CHAT_RUN_LIVE_MESSAGE =
  "a run is already live in this conversation — steer it with your next message, or let it settle before starting another";

/**
 * THE PRINCIPLED-REFUSAL ENVELOPE, at the run-start route's own door.
 *
 * A refused run start is a DESIGNED refusal (the guided 428 family:
 * `chat_run_live` with its remedy sentence, `provider_not_configured`
 * naming the setup step). The browser logs every non-2xx STATUS itself,
 * before any page code runs, so serving the refusal as a bare 428 printed
 * "Failed to load resource: 428" on a raced retry — the same measured defect
 * the block routes (UIE-001) and the git-ops family closed. This route joins
 * the same contract: the refusal travels in a 200 body as data, the client's
 * fetch choke point (`src/data/broker.ts::blockRefusalOf`) reconstructs the
 * typed `ClientError` every consumer already understands, and a real failure
 * (a 403 on someone else's project, a 400 malformed body) keeps its error
 * status and propagates untouched.
 *
 * The body is the refusal ALONE — no top-level `runId`. A refused start
 * started nothing, and a body that also carried an id-shaped hole would hand
 * a conflating reader the exact "something started" lie the refusal exists
 * to prevent. The refusal OBJECT may name the run it is about
 * (`liveRunId`): that is a fact about the refusal's own subject — the run
 * that was already live, looked up by the gate that refused — not a
 * success payload, and it is what lets the client adopt the live run so the
 * sentence's steer remedy names a run the composer can actually reach.
 */
function throughRefusalEnvelope(
  run: (ctx: RouteContext, warrant: MutationWarrant) => Promise<void>,
): MutatingRouteHandler {
  return async (ctx, warrant) => {
    try {
      await run(ctx, warrant);
    } catch (err) {
      const refusal = principledRefusalOf(err);
      if (refusal !== null) {
        sendJson(ctx.res, { refusal });
        return;
      }
      throw err;
    }
  };
}

async function assertConversationCanRun(db: AsyncDbClient, chatId: string | undefined, userId: string): Promise<void> {
  if (chatId === undefined) return;
  // Server-written message/run associations survive rewind, trash and cloning.
  // Mutable message metadata and client-authored timeline references confer no authority.
  const runIds = await db.runIdsForChat(chatId, userId);
  if (runIds.length && getTimelineStore().querySummaries({ runIds, errorCode: MISALIGNMENT_POLICY_ERROR_CODE, limit: 1 }).length) {
    throw new ConversationStoppedError("This conversation was stopped by the provider's policy. Further requests in this conversation are unavailable.", MISALIGNMENT_POLICY_ERROR_CODE);
  }
}

export function registerRunRoutes(router: Router, db: AsyncDbClient): void {
  router.post("/api/run/start", throughRefusalEnvelope(async (ctx, warrant) => {
    const user = await requireUserContext(ctx, db);
    const input = assertValidBody(RUN_START_SCHEMA, ctx.body, "invalid_run_start");
    // Validate the project exists AND belongs to the caller's user.
    // v12 + Single-Party-Owner: getProject(id, userId) enforces the scoping
    // at the DB layer — null → 403 (the isolation contract returns 403
    // for B starting a run in A's existing project; a missing project
    // also yields null → 403 here, which is equally "access denied" — no
    // test asserts 404 for a missing-project run-start, and 403 hides
    // existence better than 404).
    const project = await db.getProject(input.projectId, user.userId);
    if (project === null) {
      throw new ForbiddenError(`Project ${input.projectId} not available`);
    }
    // PROACTIVE FIX: when a chatId is supplied, verify it belongs
    // to the caller's user BEFORE binding the run to it. Previously run-start
    // only checked the project, so a caller could pass their own projectId
    // + ANOTHER user's chatId and the run would write messages into that
    // chat. createMessage now enforces this at the DB layer too (throws
    // ForbiddenError), but the explicit check gives a clean 403 instead of a
    // mid-stream throw, and documents the contract at the entry point.
    if (input.chatId !== undefined && !(await db.chatBelongsToUser(input.chatId, user.userId))) {
      throw new ForbiddenError(`Chat ${input.chatId} belongs to another user`);
    }
    await assertConversationCanRun(db, input.chatId, user.userId);
    // ONE LIVE RUN PER CONVERSATION — the server's own backstop for the
    // concurrent-run defect. The cockpit's composer routes a plain send
    // under a live run to STEERING, but every OTHER door still reaches this
    // route (a second window on the same chat, a hand-rolled call, and the
    // race where the client's run view retired a moment before the POST).
    // Two executors writing one transcript race each other — the history
    // both are reading changes underneath both — so the second start is
    // refused with the remedy in the sentence. A 428 of the guided family:
    // the client renders it as a principled refusal, never as a crash.
    const earlyLiveRunId = input.chatId !== undefined ? activeRunForChat(input.chatId, user.userId) : undefined;
    if (earlyLiveRunId !== undefined) {
      throw new ChatRunLiveError(CHAT_RUN_LIVE_MESSAGE, "chat_run_live", earlyLiveRunId);
    }
    // THE PROVIDER IS RESOLVED BEFORE ANYTHING IS BUILT, AND A MISSING ONE
    // REFUSES HERE.
    //
    // Placed above the run id, the history load, the memory retrieval and the
    // first persisted message on purpose: an account with no provider saved
    // gets a 428 naming the remedy and NOTHING else happens — no half-run in
    // the registry, no orphan user message in a chat, no stream that opens
    // and immediately errors. The refusal a user reads here is the same
    // sentence `GET /api/models` hands the setup surface, because both come
    // from `server/providers.ts` and there is only one of it.
    const credential = resolveProviderCredential(
      await loadProviderStore(db, user.userId),
      await resolveRunModelId(db, input, user.userId),
      user,
    );
    const runId = generateId("run");
    // (conversation memory): seed the manager with the chat's
    // PREVIOUS messages from the DB (not just the current prompt) so the
    // LLM remembers prior turns. When the run is bound to a chat, load
    // every prior user/assistant/tool message and append the current
    // prompt last. The system prompt is NOT included here — streamChat
    // prepends it separately (rebuilt per run), so duplicating it would
    // send two system messages. When no chatId is given (legacy callers),
    // the history is just the current prompt (unchanged behavior).
    const conversationHistory = input.chatId !== undefined
      ? await buildConversationHistory(db, { chatId: input.chatId, currentPrompt: input.prompt, userId: user.userId })
      : [{ role: "user" as const, content: input.prompt }];
    // retrieve relevant memories for the prompt BEFORE sending so
    // the LLM has cross-run/cross-chat recall. The
    // results are injected into the system prompt and persisted in the
    // context SSE event so the "Recalled context" section survives a
    // page refresh. v12: scoped by the authenticated user so User B's run
    // never recalls User A's memories.
    const retrievedMemoriesRaw = retrieveRelevantMemories(input.prompt, getMemoryRetrievalLimit(), user.userId);
    // ── run.compose HONOR POINT (the composition hookup) ──
    // Apply the chat's recorded pin/mute/trim adjustments to the freshly
    // built history + retrieved memories BEFORE the context manager is
    // seeded. Single honoring point, shared with the `run.compose` block
    // read (`buildNextTurnComposition` calls the same function), so the
    // desk strip a user saw IS the assembly the run performs. Chat-less
    // legacy runs have no per-chat compose state — passed through unchanged.
    const composeAdjusted = input.chatId !== undefined
      ? await applyComposeAdjustments(db, {
          chatId: input.chatId,
          userId: user.userId,
          history: conversationHistory,
          memories: retrievedMemoriesRaw,
        })
      : undefined;
    const effectiveHistory = composeAdjusted?.history ?? conversationHistory;
    const retrievedMemories = composeAdjusted?.memories ?? retrievedMemoriesRaw;
    // per-run UNIFIED context manager — the SINGLE source of truth
    // for what is sent to the LLM. Turns are added as they stream; the
    // manager trims automatically approaching the token limit. The
    // LLM-visible history is DERIVED from the manager via
    // buildTrimmedHistory (never a raw unbounded array — the 748% bug).
    //
    // THE LIMIT IS THE ACTIVE MODEL'S OWN when it declares one: the
    // credential was resolved for exactly this model, so its stored context
    // window is the budget the trim reasons about and the run view's gauge
    // denominates. A model that declared none keeps the harness-wide limit —
    // the same honesty the stored schema uses, never a guess.
    const contextManager = createRunContextManager(credential.model.contextWindow);
    // Seed the manager with the full conversation history (preserving
    // tool_calls/tool_call_id) so it knows the existing token pressure
    // before the first turn — and so trimming never orphans a tool_calls
    // group (OpenAI contract). The history is the compose-adjusted one:
    // pin/mute/trim recorded on the chat are already applied above.
    seedContextManagerFromHistory(contextManager, effectiveHistory);
    // THE SEED IS NOT PRICED OR TRIMMED HERE, AND THAT IS THE FIX RATHER THAN
    // AN OMISSION.
    //
    // This route used to read the manifest, set the retrieval route and trim,
    // so that the first request was priced against the request it would
    // actually make. It was right, and it was one of two places that had to
    // remember — the executor re-reads the manifest at every turn boundary and
    // had no matching trim, so the SECOND turn could go out repriced and
    // untrimmed. Adding the missing call here would have made three places.
    //
    // Deriving the history is now what prices and trims (`buildTrimmedHistory`
    // — see its source), and every request, seed included, is derived. Trimming
    // here as well would evict against a manifest read a moment before the
    // executor reads its own, which is an irreversible eviction paid for a
    // request that may never be made.
    // THE RACE THE EARLY GATE CANNOT CLOSE — and the reason the check runs
    // twice. The early gate above refuses the settled case fast, but this
    // route awaits between it and the registration (history, compose
    // adjustments), and a second start that interleaves through those awaits
    // passes the early gate while THIS run is not yet in the registry —
    // observed at the wire as two 201s and two executors racing one
    // transcript. The recheck below and the registration are one
    // synchronous stretch with no await between them, so on one event loop
    // exactly one of two racing starts wins; the loser reads the winner's
    // registration here and is refused with the same sentence. Check-and-
    // insert, made atomic by having no seam.
    const recheckLiveRunId = input.chatId !== undefined ? activeRunForChat(input.chatId, user.userId) : undefined;
    if (recheckLiveRunId !== undefined) {
      throw new ChatRunLiveError(CHAT_RUN_LIVE_MESSAGE, "chat_run_live", recheckLiveRunId);
    }
    setActiveRun(runId, {
      chatId: input.chatId ?? null,
      prompt: input.prompt,
      // Resolved ONCE, here, so every turn of this run — and every record of
      // it — names the same provider and the same model.
      credential,
      userId: user.userId,
      projectId: input.projectId,
      projectPath: project.path,
      projectName: project.name,
      accumulatedText: "",
      assistantMessageId: null,
      abortController: new AbortController(),
      runEventId: null,
      turnId: null,
      steeringQueue: [],
      steeringOpen: false,
      toolCallRows: new Map(),
      toolAttemptCounts: new Map(),
      accumulatedReasoning: "",
      accumulatedTokenMetrics: undefined,
      accumulatedResponseHeaders: undefined,
      accumulatedResponseModel: undefined,
      accumulatedTraceId: undefined,
      accumulatedContext: undefined,
      accumulatedDedupSummary: undefined,
      accumulatedRedactionNotice: undefined,
      turnStartedAt: null,
      turnFirstTokenAt: null,
      turnFirstOutputAt: null,
      turnFinishedAt: null,
      contextManager,
      retrievedMemories,
      safetyGate: undefined,
      toolSettingsSnapshot: new Map(),
    });

    // THE REGISTRY ENTRY IS THIS ROUTE'S HALF OF "A REFUSED START LEAVES
    // NOTHING BEHIND". It is written above because the executor reads the
    // run from the registry, so everything from here on — the timeline
    // record, the persisted prompt, the execution claim — runs inside the
    // unwind: any throw on this stretch deletes the entry rather than
    // leaking it. A leak is not inert bookkeeping while the one-run gate
    // lives: a run that never started would hold its conversation closed
    // until the process restarts.
    try {
      // The registry reservation holds the chat while the mapping is awaited.
      // The canonical check then runs synchronously before any new lifecycle/claim.
      await assertConversationCanRun(db, input.chatId, user.userId);
      // Record the run lifecycle event in the real timeline ledger.
      const runRecord = getTimelineRecorder().recordRun({
        description: "run started",
        correlation: { runId },
      });
      getActiveRun(runId)!.runEventId = runRecord.eventId;

      // If the run is bound to a chat, persist the user's prompt as a
      // user message so the chat history reflects what the user sent.
      if (input.chatId) {
        const userMessage = await db.createMessage(
          {
            chat_id: input.chatId,
            role: "user",
            content: input.prompt,
            run_id: runId,
          },
          user.userId,
        );
        getTimelineRecorder().recordMessage({
          description: "user prompt",
          correlation: { runId, messageId: userMessage.id },
          parentEventId: runRecord.eventId,
        });
      }

    // ── THE RUN STARTS HERE, and this is the whole of the fix ──
    //
    // It used to start in `GET /api/run/:runId/stream`: this route validated,
    // built the history, inserted the user message and returned an id, and
    // NOTHING ran until someone opened the stream. So the number of executions
    // was the number of connections. Measured at the wire with two: two POSTs
    // to /chat/completions, 38,429 bytes each, byte-identical, billed twice.
    //
    // `await`, and only as far as the CLAIM: `startRunExecution` returns once
    // the run is claimed and leaves the work running detached. A second start
    // of the same run therefore learns `409 run_already_executing` on its own
    // request — refused by SQLite's PRIMARY KEY before a prompt is assembled —
    // rather than discovering it later, or not at all.
    //
    // The executor opens the run's feed itself, after the claim, and ends it
    // in its own `finally`. This route used to open it one line above, which
    // meant a start refused at the claim left a feed with no owner to close
    // it — five refused starts, five feeds retained forever, and a subscriber
    // to any of them accepted and held open on a run that would never publish.
    //
    // A REFUSED START LEAVES NOTHING BEHIND, and the registry entry above is
    // the half this route still owns. It has to be written before the call
    // (the executor reads the run from the registry), so it also has to be
    // unwound here: the executor's `finally` is the only other thing that
    // forgets a run, and a start refused at the door never reaches it.
      await startRunExecution(warrant, runId, user.userId, db);
    } catch (startErr) {
      deleteActiveRun(runId);
      throw startErr;
    }
    sendJson(ctx.res, { runId }, 201);
  }));

  router.post("/api/run/:runId/cancel", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const runId = ctx.params["runId"]!;
    // OWNERSHIP IS RESOLVED BEFORE LIVENESS, and the order is the point.
    // Asking "is it running?" first meant a run that had just ended answered
    // 404 to everyone — including a user it does not belong to — so the two
    // questions "no such run" and "not your run" collapsed into one the moment
    // a run finished. `resolveRunOwner` consults the registry AND the feed,
    // which outlives the run, so a foreign caller gets the same 403 either way
    // and only a genuinely unknown run is a 404.
    const owner = resolveRunOwner(runId);
    if (owner === undefined) {
      throw new NotFoundError(`Run ${runId} not found or already completed`);
    }
    if (owner !== user.userId) {
      throw new ForbiddenError(`Run ${runId} belongs to another user`);
    }
    const active = getActiveRun(runId);
    if (active === undefined) {
      throw new NotFoundError(`Run ${runId} has already completed`);
    }
    // THE ABORT IS THE WHOLE CANCEL. The registry entry is NOT removed
    // here: the executor's own `finally` removes it in the same breath as
    // it publishes the `cancelled` terminal frame, which keeps the claim
    // and the reader's run view settling together — the same law the
    // steer door and the one-run gate now live by. A route-side delete
    // here would re-open the exact window this round closed: the entry
    // gone while the executor's bookkeeping still writes, so a racing
    // start would be admitted underneath a run the reader just stopped
    // and whose cancelled frame has not arrived yet.
    active.abortController.abort();
    sendJson(ctx.res, { cancelled: true, runId });
  });

  // ── Steering: inject a message into an active run ──
  // The user can send a steering message while a run is streaming. The
  // message enters the conversation and the run delivers it exactly once:
  // the next turn the loop starts composes it — a turn the loop was going
  // to start anyway (a tool-call continuation) carries it, and when no
  // further turn would run, the loop starts one for it (the drain). This
  // enables bidirectional communication: the user can redirect the agent
  // mid-work.

  const STEER_SCHEMA = z.strictObject({
    prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  });

  router.post("/api/run/:runId/steer", throughRefusalEnvelope(async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const runId = ctx.params["runId"]!;
    // Ownership before liveness — see the cancel route for why the order
    // matters. One resolution shared by all three run routes so they cannot
    // disagree about what a run is.
    const owner = resolveRunOwner(runId);
    if (owner === undefined) {
      throw new NotFoundError("Run not found or already completed");
    }
    if (owner !== user.userId) {
      throw new ForbiddenError(`Run ${runId} belongs to another user`);
    }
    const active = getActiveRun(runId);
    if (active === undefined) {
      throw new NotFoundError(`Run ${runId} has already completed`);
    }
    await assertConversationCanRun(db, active.chatId ?? undefined, user.userId);
    // THE RUN IS STILL SETTLING, BUT ITS TURN LOOP IS DONE — the registry
    // entry now lives to the terminal settle, so this door can be reached
    // while the reader's run view still says "running" (the epilogue — the
    // quality snapshot, the timeline replay — takes seconds and the pane
    // lives until the terminal frame). A steer accepted here would be
    // acknowledged and then silently lost: no further turn will read the
    // queue. That is a designed, named state, so it refuses in the
    // principled-refusal envelope with its remedy — never a raw 404 about
    // a run the reader can still see and stop (UIE-034).
    if (!active.steeringOpen) {
      throw new RunFinishingError(
        `the run has finished its turns and is completing its record — it can no longer take instructions; let it settle (or stop it), then send again`,
      );
    }
    const input = assertValidBody(STEER_SCHEMA, ctx.body, "invalid_steer_input");
    // Persist the steering message as a user message if bound to a chat —
    // BEFORE the live act, so a failed row write is a clean refusal that
    // queued nothing (the client's error path then tells the truth about a
    // delivery that never happened), never an accepted instruction whose
    // durable record is missing.
    if (active.chatId !== null) {
      await db.createMessage(
        {
          chat_id: active.chatId,
          role: "user",
          content: input.prompt,
          run_id: runId,
        },
        active.userId,
      );
    }
    // The ONE live act: the words enter the conversation and the queue
    // takes the signal, in the single owner's one synchronous stretch —
    // never two mutations the executor could observe half-done.
    await assertConversationCanRun(db, active.chatId ?? undefined, user.userId);
    if (!active.steeringOpen) throw new RunFinishingError("The run has finished taking instructions.");
    const queued = queueSteer(active, input.prompt);
    notifyRunPauseAnswer(active);
    // route the turn through the dedup layer (no-op when
    // disabled) so cross-turn duplicate reporting is wired, not decorative.
    wireDedupForTurn(input.prompt);
    sendJson(ctx.res, { runId, queued, steered: true });
  }));
}
