/**
 * Tools block — which tools are on for THIS user, and the switch that
 * changes it.
 *
 * The read answers "what will my runs be allowed to use", resolved exactly
 * as the run route resolves it: the global config's enabled list is the
 * default, the per-user rows in `tool_settings` are overrides. The action
 * writes one of those rows through the same `upsertToolSetting` the legacy
 * toggle route uses — one store, two doors during migration.
 *
 * TIMING HONESTY (the consequence sentence must say when it takes effect):
 * the model's tool LIST is fixed when a run starts, but the per-run safety
 * gate re-reads these per-user rows on every check (`server/routes/run.ts`,
 * `createRunSafetyGate` callback), so turning a tool OFF also stops a run
 * already in progress from using it again, while turning one ON only reaches
 * the model on the next run. Both halves are stated, neither is implied.
 */

import { z } from "zod";

import { NotFoundError } from "../kernel/errors.ts";
import { requireUserContext } from "../auth/user-context.ts";
import {
  findManifestTool,
  getToolAccountStates,
  invalidateToolManifestCache,
} from "../tools/tools-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { selfProtectionStatus } from "../safety/landlock-runner.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

const NoInput = z.object({});

const ToggleInput = z.strictObject({
  tool: z.string().min(1).max(256),
  enabled: z.boolean(),
});

const ToolStateView = z.strictObject({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  /** `"you"` when a per-user row decides, `"default"` when the shared config does. */
  source: z.enum(["you", "default"]),
});

const ToolsOutput = z.strictObject({
  tools: z.array(ToolStateView),
  disabled: z.number(),
});

/**
 * The confinement reading. Every field is either measured or explicitly
 * null; `state` distinguishes "not confined" from "cannot tell", because a
 * status that collapses those two says "no" when the honest answer is "I do
 * not know" — and the two lead to different actions.
 */
const ConfinementOutput = z.strictObject({
  state: z.enum(["off", "confined", "unavailable", "unknown"]),
  sentence: z.string(),
  reason: z.string(),
  measuredAt: z.number(),
  kernelAbi: z.number().nullable(),
  guardianSha256: z.string().nullable(),
  code: z.string().nullable(),
});

/** The caller's effective tool states — the bridge's merge rule, over the
 *  caller's own override rows. */
async function effectiveToolStates(db: AsyncDbClient, userId: string) {
  const overrides = new Map(
    (await db.listToolSettings(userId)).map((r) => [r.tool_name, r.enabled] as const),
  );
  const tools = getToolAccountStates(overrides);
  return { tools, disabled: tools.filter((t) => !t.enabled).length };
}

/** Register the tools block. */
export function defineToolsBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "tools.enabled",
    title: "Tools on for you",
    description:
      "Which tools your runs may use: the shared default list, adjusted by the switches you have set for your own account.",
    read: {
      input: NoInput,
      output: ToolsOutput,
      ttlMs: 15_000,
      invalidateOn: ["tools:changed"],
      handler: async (_input, { ctx }: BlockHandlerContext) => {
        const user = await requireUserContext(ctx, db);
        return await effectiveToolStates(db, user.userId);
      },
    },
    actions: {
      /**
       * The per-user override write. Explicit target state rather than a
       * flip: a declared affordance must mean the same thing every time it
       * is pressed, and "toggle" means the opposite of whatever happens to
       * be true at that instant — a race wearing a verb's name.
       */
      toggle: {
        input: ToggleInput,
        title: "Turn on or off",
        consequence:
          "Turns one tool on or off for your account only; other people keep their own settings. Turning a tool off also stops a run already going from using it again, while turning one on reaches the model on your next run.",
        invalidates: ["tools:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          const tool = findManifestTool(input.tool);
          if (tool === undefined) {
            throw new NotFoundError(`Tool '${input.tool}' not found in manifest`);
          }
          // Every real manifest entry is per-account switchable — built-in
          // and live MCP alike: the run's tool decisions honor per-session
          // overrides for ANY category (the same merge rule the read above
          // resolves), so a switch that stopped at the built-in boundary
          // would leave the MCP half of the list it serves unwritable.
          await db.upsertToolSetting({ tool_name: input.tool, enabled: input.enabled }, user.userId);
          // Same cache the legacy route drops: the next manifest read (and
          // the safety gate's next check) sees the new state immediately.
          invalidateToolManifestCache();
          return await effectiveToolStates(db, user.userId);
        },
      },
    },
  });

  /**
   * Whether the commands a run executes are confined to the selected project.
   *
   * Declared beside the tool switches on purpose: the two answer the same
   * user question one layer apart — the switches say WHICH programs a run may
   * start, this says HOW MUCH OF THE MACHINE those programs can reach. Adding
   * it here rather than as a new block file keeps one door for "what my runs
   * are allowed to do".
   *
   * NO CACHE WINDOW, AND NO INVALIDATION EVENT EITHER. A time-to-live here
   * would buy nothing and cost something real: the expensive part — spawning
   * the guardian to ask this kernel what it enforces — is already cached on
   * the IDENTITY of the guardian binary inside the runner, so a repeated read
   * is a config re-read and a few comparisons. What a window would add is an
   * interval during which the cockpit keeps claiming protection that stopped
   * being true. An `invalidateOn` event is likewise not declared, because no
   * event on this bus means "the harness settings changed" — declaring one
   * that nothing publishes would be a refresh promise the system cannot keep.
   */
  defineBlock({
    id: "tools.confinement",
    title: "How much of this computer your runs can reach",
    description:
      "Whether the commands a run executes are held inside the project folder you selected, or can read and change anything this server can.",
    read: {
      input: NoInput,
      output: ConfinementOutput,
      ttlMs: 0,
      handler: async (_input, { ctx }: BlockHandlerContext) => {
        // Same gate as every other read here: a status describing this
        // machine's filesystem authority is not public.
        await requireUserContext(ctx, db);
        return selfProtectionStatus();
      },
    },
  });
}
