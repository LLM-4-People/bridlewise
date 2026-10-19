import { deepFreeze } from "../kernel/integrity.ts";
import { createExtensionManifest, type ExtensionManifest, type ExtensionManifestEntry } from "../extensions/extension-manifest.ts";
import type { RegisteredTool, ToolContext } from "./tool-registry.ts";

/**
 * Extension tools for the interactive chat runtime (delivery-map item 12).
 *
 * Exposes the governed extension manifest to the model:
 * - list_extensions: list registered extension manifest entries
 * (read-only)
 *
 * Per root-policy `selfEvolutionArchitecture` and the canonical requirements,
 * harness self-modification (add/edit/delete/upgrade/downgrade/rollback) goes
 * only through the approval workflow with explicit user approval, exact
 * backups, independent review, and rollback. Exposing `install_extension` or
 * `remove_extension` as free model-callable tools would bypass that
 * governance gate, so they are intentionally NOT exposed here. The
 * self-modification tools (`src/extensions/self-modification-tools.ts`)
 * remain the only entry points for those operations.
 *
 * The manifest is in-memory and empty at session start; extensions are
 * registered through the lifecycle/approval workflow, not through chat
 * tools. This keeps the read surface available without weakening the
 * governance invariant.
 */

export type ExtensionToolsOptions = Readonly<{
  manifest?: ExtensionManifest;
}>;

export function createExtensionTools(options: ExtensionToolsOptions = {}): readonly RegisteredTool[] {
  const manifest = options.manifest ?? createExtensionManifest();

  const listExtensions: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "list_extensions",
        description: "List registered extension manifest entries (id, type, version, status, description, capabilities). Read-only. Extension installation and removal are governed by the approval workflow and are not exposed as model-callable tools.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            type: { type: "string", description: "Optional extension type filter" },
            status: { type: "string", description: "Optional status filter" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const typeFilter = typeof args.type === "string" ? args.type : null;
      const statusFilter = typeof args.status === "string" ? args.status : null;
      const entries = manifest.entries()
        .filter((e: ExtensionManifestEntry) => typeFilter === null || e.type === typeFilter)
        .filter((e: ExtensionManifestEntry) => statusFilter === null || e.status === statusFilter)
        .map((e: ExtensionManifestEntry) => deepFreeze({
          id: e.id,
          type: e.type,
          version: e.version,
          status: e.status,
          description: e.description,
          capabilities: e.capabilities,
        }));
      return JSON.stringify(deepFreeze({ extensions: entries, total: entries.length }));
    },
  });

  return deepFreeze([listExtensions]);
}
