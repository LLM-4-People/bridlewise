/**
 * ANATOMY — the server's door onto the harness anatomy, as a declared block
 * read: the process census (what is running on the machine that belongs to
 * this harness, with chains, CPU, RSS, provenance) PLUS the in-process
 * component registry (worker threads, DB threads, folder watches, the
 * sampler timer, run feeds, MCP children — the live handles inside THIS
 * process).
 *
 * Route (derived from the id, never authored):
 * GET /api/b/observability.anatomy — { data: { processes, components }, meta }
 *
 * BOTH halves come from their single owners (server/observability/
 * process-census.ts, server/observability/component-registry.ts) — the same
 * modules `scripts/trace.ts anatomy` consumes, so the CLI and the block read
 * print the SAME shapes by construction (no duplicated view logic).
 *
 * Auth posture: the sibling observability blocks' — `requireUserContext`
 * (any authenticated session; the coverage blocks gate the same way). The
 * census is read-only and machine-local; it names no payloads.
 */
import { z } from "zod";

import { requireUserContext } from "../auth/user-context.ts";
import {
  censusProcesses,
  censusRepoRoot,
  type CensusProcess,
} from "../observability/process-census.ts";
import {
  componentSnapshot,
  type RegisteredComponent,
} from "../observability/component-registry.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

/** The read's answer: the two anatomy halves, in their owners' shapes. */
type AnatomyView = Readonly<{
  processes: readonly CensusProcess[];
  components: readonly RegisteredComponent[];
}>;

/** Register the anatomy block (the harness-anatomy read). */
export function defineAnatomyBlocks(db: AsyncDbClient): void {
  // Deny-by-default: this read takes NO input, and an unexpected query
  // parameter is a 400, not a silently ignored key.
  const NoInput = z.strictObject({});

  defineBlock({
    id: "observability.anatomy",
    title: "Anatomy — every harness component, live",
    description:
      "The live harness anatomy in one read: the process census (every process this machine runs for this harness, with its parent chain, start time, sampled CPU and RSS) and the in-process component registry (worker threads, DB threads, folder watches, the sampler timer, run feeds, MCP children). Read-only; it names no payloads.",
    read: {
      input: NoInput,
      output: z.unknown(),
      // A live instrument: revalidate quickly, and let the content-derived
      // etag save the transfer when nothing changed between views.
      ttlMs: 5_000,
      handler: async (_input, { ctx }: BlockHandlerContext): Promise<AnatomyView> => {
        await requireUserContext(ctx, db);
        return {
          processes: await censusProcesses(censusRepoRoot()),
          components: componentSnapshot(),
        };
      },
    },
  });
}
