/**
 * Pilot block — `checks.auto`.
 *
 * Deliberately the SIMPLE end of the ladder: a scoped read with no pagination
 * and no streaming, chosen alongside `code.graph` (the hard end) so the
 * contract is proved at both extremes before anything else migrates.
 *
 * It is DUAL-MOUNTED during migration: the legacy routes in
 * `server/routes/auto-checks.ts` still exist and still serve the current
 * client. The handler logic lives here and is called from both, so there is
 * exactly one implementation while there are temporarily two doors. The
 * legacy door closes — and the ratchet drops — when the client repoints.
 *
 * @see server/blocks/define.ts
 */

import { z } from "zod";

import { NotFoundError } from "../kernel/errors.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";
import { autoCheckToView } from "../routes/views.ts";
import { RUNNABLE_CHECKS, RUNNABLE_CHECK_NAMES, runAutoCheck } from "../awareness/auto-check-runner.ts";
import { makeFsGate } from "../filesystem/fs-gate.ts";

/**
 * Scope input. Exactly one of `projectId` / `chatId` — a request naming both
 * is ambiguous about which ownership check applies, so it is refused rather
 * than silently preferring one.
 */
const ScopeInput = z
  .object({
    projectId: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
  })
  .refine((v) => (v.projectId === undefined) !== (v.chatId === undefined), {
    message: "provide exactly one of projectId or chatId",
  });

const AutoCheckView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  scope: z.string(),
}).loose();

const Output = z.array(AutoCheckView);

/**
 * Rerun input. `projectId` is required (the checks run against the project's
 * code on disk); `checkName` narrows the rerun to one check, and its absence
 * means "every check the runner owns" — which is what the card-level verb
 * wants, since a first-time user pressing "Run again" is asking about the
 * project, not about one named check. `chatId` scopes the recorded result to
 * a conversation, exactly as the legacy POST route does.
 */
const RerunInput = z.strictObject({
  projectId: z.string().min(1),
  checkName: z.enum(RUNNABLE_CHECK_NAMES).optional(),
  chatId: z.string().min(1).optional(),
});

/**
 * Register the block. Takes the db so the handler closes over it rather than
 * reaching for a module-global — the same injection the routes already use.
 */
export function defineChecksBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "checks.auto",
    title: "Auto-checks",
    description:
      "Automated checks (typecheck, lint) recorded for a project or a chat, with their latest status.",
    read: {
      input: ScopeInput,
      output: Output,
      ttlMs: 15_000,
      invalidateOn: ["run:done", "check:complete"],
      handler: async (input, { ctx }: BlockHandlerContext) => {
        // Ownership is resolved exactly as the legacy route does: the DB
        // lookups are user-scoped, and a miss is a 404 that hides existence.
        const user = await requireUserContext(ctx, db);
        if (input.projectId !== undefined) {
          if (await db.getProject(input.projectId, user.userId) === null) {
            throw new NotFoundError(`Project ${input.projectId} not found`);
          }
          return (await db.listAutoChecksByProject(input.projectId, user.userId)).map(autoCheckToView);
        }
        const chatId = input.chatId!;
        if (await db.getChat(chatId, user.userId) === null) {
          throw new NotFoundError(`Chat ${chatId} not found`);
        }
        return (await db.listAutoChecksByChat(chatId, user.userId)).map(autoCheckToView);
      },
    },
    actions: {
      /**
       * The failing-check card's verb. Runs the REAL checks — the same
       * `runAutoCheck` the legacy POST route calls — and persists completed
       * rows, so the handler's effect is exactly what the consequence
       * sentence claims. Ownership is the same user-scoped project lookup
       * the read side performs.
       */
      rerun: {
        input: RerunInput,
        title: "Run again",
        consequence:
          "Runs the project's checks (types and code style) against the code as it is now; each result replaces the one shown when it finishes.",
        params: { projectId: "$sel.projectId" },
        invalidates: ["check:complete"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          const project = await db.getProject(input.projectId, user.userId);
          if (project === null) {
            throw new NotFoundError(`Project ${input.projectId} not found`);
          }
          const names =
            input.checkName !== undefined ? [input.checkName] : [...RUNNABLE_CHECKS];
          const checks = [];
          for (const checkName of names) {
            // THE GATE IS BUILT WHERE OWNERSHIP WAS ESTABLISHED, two lines
            // above, and forwarded — rather than left to be argued from this
            // call chain by whoever reads the bridge next.
            const outcome = await runAutoCheck(checkName, project.path, await makeFsGate(user.userId, db, project.path));
            const row = await db.createAutoCheck(
              {
                project_id: input.projectId,
                check_name: checkName,
                status: outcome.status,
                output: outcome.output,
                ...(input.chatId !== undefined ? { chat_id: input.chatId } : {}),
              },
              user.userId,
            );
            checks.push(autoCheckToView(row));
          }
          return { checks };
        },
      },
    },
  });
}
