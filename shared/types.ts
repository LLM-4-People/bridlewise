/**
 * Type-only re-exports from the canonical harness source.
 *
 * Single source of truth: all event/state types originate in the canonical
 * repository (`/home/example/bridlewise/src/`). This module re-exports them
 * as TYPE-ONLY imports — they are erased at compile time and never enter the
 * browser bundle. Runtime Zod validation happens server-side at the trust
 * boundary; the client receives pre-validated typed events.
 *
 * Adding a new contract type: add it here as `export type {... } from "..."`
 * and add the corresponding path alias in tsconfig.json.
 */

export type {
  ModelEvent,
  ModelRequest,
  Usage,
  ToolResult,
  ContractError,
  CapabilityOffer,
  CapabilityRequirement,
  CapabilityNegotiation,
} from "@harness/contracts";

export type {
  TimelineEventRecord,
  TimelineEventSummary,
  TimelineEventSummariesResult,
  TimelineEventType,
  TimelineQueryFilter,
  TimelineQueryResult,
  TimelineRecordKind,
  TimelineOutcome,
  TimelineActor,
  TimelineCorrelation,
  TimelineErrorSummary,
  RollbackPlan,
  RollbackResult,
} from "@harness/timeline-types";

export type {
  AgentState,
  AgentLifecycleState,
  AgentTurnRecord,
  AgentStateStore,
} from "@harness/agent-state";

export type {
  MetricsSnapshot,
  MetricEntrySnapshot,
  MetricCorrelation,
  DurationHistogramSnapshot,
  SampledTrace,
} from "@harness/metrics-collector";

import type { ToolManifestEntry } from "@harness/tool-manifest";

export type {
  ToolManifestEntry,
  ToolManifest,
  ToolCapability,
  ToolResourceBounds,
} from "@harness/tool-manifest";

// Import `ToolKind` locally (from the pure owner) so the `WebToolEntry`
// definition below can reference it; re-export it so existing
// `import { type ToolKind } from "shared/types"` paths are unchanged.
import type { ToolKind } from "./web-ui-types";
export type { ToolKind };

// ── Pure web-UI-local shared types (SPO) ──

/**
 * Web-UI-local tool entry: a `ToolManifestEntry` tagged with a `category`
 * ("built-in" or "mcp") and a granular `kind` so the Tools panel can show
 * ONE merged list with a category badge and filter/sort by kind (binding
 * all tools wired the same way; user directive: "mcp and tools
 * should be merged, mcp inside tools").
 *
 * This extends the canonical backend type without modifying it — the backend
 * `ToolManifestEntry` is frozen and shared; the category and kind are web-UI
 * presentation concerns layered on top at manifest-build time.
 */
export type WebToolEntry = ToolManifestEntry & Readonly<{
  category: "built-in" | "mcp";
  kind: ToolKind;
  /**
   * The plain-words imperative label ("edit file", "read file") the UI shows
   * for one call. Declared at registration on the backend, served on the
   * wire, so a renamed tool's label moves with it and no frontend table ever
   * re-states the answer. Absent only for a tool registered without one —
   * the UI falls back to the name with underscores spaced, never to a
   * bespoke second table.
   */
  label?: string;
  /**
   * The shape the tool's recorded output takes (file / command / search),
   * declared at the tool's registration. The renderer reads this instead of
   * re-deriving the shape from the tool's name.
   */
  outputShape?: "file" | "command" | "search";
  /**
  * Whether this tool's results are stored in the harness memory (exp519:
   * memory opt-in via tool schema). Default false — most tools (read_file,
   * editor, git) produce ephemeral content that would pollute memory. Only
   * high-value knowledge-gathering tools (search_code, get_repository_map,
   * quick_view, find_reuse, …) opt in. Error results are NEVER saved
   * regardless of this flag (enforced in the run route). The user: "we
   * should only ever save specific tool calls in memory, so it's opt-in
   * inside tool schema."
   */
  saveToMemory?: boolean;
 }>;

/**
 * UI-control action — the client-side structural mirror of the server's
 * `UiControlAction` (server/ui-control.ts is the single source of truth;
 * runtime Zod validation happens server-side, the client receives a
 * pre-validated typed event). The LLM calls the `control_interface` tool;
 * the run route emits a `ui_control` SSE event carrying this action; the
 * client applies it (set_tab / toggle_panel / set_theme / open_settings).
 *
 * LLM control of the interface.
 */
export type UiControlAction = Readonly<{
  action: "set_tab" | "toggle_panel" | "set_theme" | "open_settings" | "inspect" | "list_inspector";
  tab?: "chat" | "timeline" | "code" | "files" | "git" | "settings" | "agents" | "metrics" | "memory" | "tools" | "extensions";
  panel?: "left" | "right";
  theme?: "dark" | "light";
  mode?: "open" | "close" | "toggle";
  group?: import("./routes.ts").InspectorGroupId;
  section?: import("./routes.ts").InspectorSectionId;
}>;

export type { ConfigSnapshot, ConfigDocument } from "@harness/config";
