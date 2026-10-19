/**
 * Project context builder — constructs the system prompt that gives the LLM
 * awareness of the selected project: its name, path, file listing, and
 * available tools.
 *
 * This is the SOLE owner of the system prompt template. The run route calls
 * `buildSystemPrompt()` to get the system message content; the LLM bridge
 * prepends it to the messages array.
 *
 * Security: file listing is restricted to the project root (no traversal
 * above it). Only files within the project directory are listed, and the
 * listing is capped at a configurable depth and count.
 */

import { readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

import type { ToolManifestEntry } from "../kernel/canonical.ts";
import { MAX_FILE_NAME_LENGTH } from "../../shared/constants.ts";
import { resolveWithinProject } from "../filesystem/fs-gate.ts";
import { DEFAULT_USER_PREFERENCES, getPromptToneInstruction, getUserPreferences, type PromptTone, type SentenceCase } from "../kernel/harness-config.ts";

/**
 * The project file-listing bounds for the system prompt. NOT a config leaf
 * yet: `runtime.listing` was read here but the strict document schema never
 * declared it, so nothing validated could set it and the reader always
 * answered these values (prompt-registry F-PR-1). The workspace-snapshot task
 * declares the real leaves.
 */
const PROJECT_LISTING_BOUNDS = { maxDepth: 3, maxEntries: 200 } as const;

// ── Types ──

export type ProjectContextInput = Readonly<{
  readonly projectName: string;
  readonly projectPath: string;
  readonly tools: readonly ToolManifestEntry[];
}>;

/**
 * The per-user system-prompt preferences. The config-file defaults
 * are the global seed; the per-user DB override (`user_prompt_prefs`,
 * encrypted) wins field-by-field. `systemPromptOverride` is the user's
 * custom system-prompt text (appended to the base prompt); empty string
 * means "no override". This shape is the single contract shared by the DB
 * schema, the settings route, the run route, and `buildSystemPrompt` so
 * the three layers cannot drift.
 */
export type PromptPrefs = Readonly<{
  readonly systemPromptOverride: string;
  readonly tone: PromptTone;
  readonly sentenceCase: SentenceCase;
  readonly emoji: boolean;
  readonly icons: boolean;
}>;

/**
 * Coerce an untrusted value (from the DB JSON blob or the route body) into a
 * valid `PromptPrefs`. Unknown/invalid fields fall back to the config-file
 * defaults so a corrupt or partial persisted blob never breaks the system
 * prompt. Pure —
 * same input always yields the same output; fully testable in Node.
 */
export function coercePromptPrefs(
  input: unknown,
  defaults: PromptPrefs,
): PromptPrefs {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return defaults;
  }
  const o = input as Record<string, unknown>;
  const asBool = (v: unknown, dflt: boolean): boolean =>
    typeof v === "boolean" ? v : dflt;
  const tone: PromptTone =
    o["tone"] === "concise" || o["tone"] === "detailed" || o["tone"] === "friendly"
      ? (o["tone"] as PromptTone)
      : defaults.tone;
  const sentenceCase: SentenceCase =
    o["sentenceCase"] === "normal" || o["sentenceCase"] === "title" || o["sentenceCase"] === "upper"
      ? (o["sentenceCase"] as SentenceCase)
      : defaults.sentenceCase;
  const overrideRaw = o["systemPromptOverride"];
  const systemPromptOverride =
    typeof overrideRaw === "string" ? overrideRaw : defaults.systemPromptOverride;
  return Object.freeze({
    systemPromptOverride,
    tone,
    sentenceCase,
    emoji: asBool(o["emoji"], defaults.emoji),
    icons: asBool(o["icons"], defaults.icons),
  });
}

/**
 * Resolve the effective system-prompt preferences: merge a per-session DB
 * override over the config-file defaults. Each DB field wins when present;
 * absent DB fields fall back to the config default. The
 * `systemPromptOverride` is the ONE exception to field-by-field merge: a
 * non-empty DB override FULLY replaces the config override (they are
 * alternative custom prompts, not additive — appending both would produce
 * contradictory instructions). An empty DB override falls back to the
 * config override. Pure — the single merge point, tested in isolation.
 */
export function resolvePromptPrefs(
  configDefaults: PromptPrefs,
  sessionOverride: unknown,
): PromptPrefs {
  if (sessionOverride === null || sessionOverride === undefined) {
    return configDefaults;
  }
  const merged = coercePromptPrefs(sessionOverride, configDefaults);
  // Non-empty DB override fully replaces the config override.
  const systemPromptOverride =
    merged.systemPromptOverride.length > 0
      ? merged.systemPromptOverride
      : configDefaults.systemPromptOverride;
  return Object.freeze({ ...merged, systemPromptOverride });
}

/** Build the config-file-default PromptPrefs (the global seed). */
export function buildDefaultPromptPrefs(): PromptPrefs {
  const prefs = getUserPreferences();
  return Object.freeze({
    // No global override: `runtime.systemPromptOverride` was never a declared
    // leaf (F-PR-1); the per-user override (the DB) is the only one until the
    // prompt registry's global version (PRM-3).
    systemPromptOverride: "",
    tone: prefs.tone,
    sentenceCase: prefs.sentenceCase,
    emoji: prefs.emoji,
    icons: prefs.icons,
  });
}

// ── Helpers ──

/** Check if a path is safely within the project root (no traversal).
 * delegates to the fs-gate's `resolveWithinProject` (the SINGLE
 * owner of the "resolve + within-root" check) so the logic is not
 * duplicated. Local boolean adapter for the tree-walk filter (the gate
 * throws; the walk needs a boolean). Not exported — the gate is the
 * canonical owner. */
function isWithinRoot(absPath: string, root: string): boolean {
  try {
    resolveWithinProject(absPath, root);
    return true;
  } catch {
    return false;
  }
}

/** Build a safe file listing of the project root (directories + files). */
function buildFileListing(root: string, maxDepth: number, maxEntries: number): string[] {
  const entries: string[] = [];
  const rootResolved = resolve(root);

  function walk(dir: string, depth: number): void {
    if (entries.length >= maxEntries || depth > maxDepth) return;    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith(".") && d.name.length <= MAX_FILE_NAME_LENGTH)
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= maxEntries) return;
      const fullPath = resolve(dir, name);
      if (!isWithinRoot(fullPath, rootResolved)) continue;
      const rel = relative(rootResolved, fullPath);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          entries.push(`${rel}/`);
          walk(fullPath, depth + 1);
        } else {
          entries.push(rel);
        }
      } catch {
        entries.push(rel);
      }
    }
  }

  walk(rootResolved, 1);
  return entries;
}

/** Format the tool list as a compact human-readable string. */
function formatTools(tools: readonly ToolManifestEntry[]): string {
  if (tools.length === 0) return "(no tools available)";
  return tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
}

// ── Public API ──

/**
 * Build the system prompt that gives the LLM project context.
 *
 * Includes:
 * The project name and absolute path
 * A file listing (directories end with `/`, capped at depth + count)
 * The list of available tools the model can call
 * Instructions on how to use tools and respond
 *
 * the optional `sessionPrefs` is the per-user DB override
 * (encrypted in `user_prompt_prefs`). When provided, it is merged over the
 * config-file defaults (the global seed) — the DB override wins
 * field-by-field, except `systemPromptOverride` which fully replaces the
 * config override when non-empty. The resolved prefs drive the "Response
 * style" section; the override drives the "Additional instructions"
 * section. This is the single point where the per-user system prompt is
 * assembled.
 */
export function buildSystemPrompt(
  input: ProjectContextInput,
  sessionPrefs?: unknown,
): string {
  const { projectName, projectPath, tools } = input;
  const listing = buildFileListing(projectPath, PROJECT_LISTING_BOUNDS.maxDepth, PROJECT_LISTING_BOUNDS.maxEntries);
  const toolsText = formatTools(tools);
  const listingText = listing.length > 0
    ? listing.join("\n")
    : "(empty or unreadable directory)";

  const configDefaults = buildDefaultPromptPrefs();
  const prefs = sessionPrefs !== undefined
    ? resolvePromptPrefs(configDefaults, sessionPrefs)
    : configDefaults;
  const prefsSection = buildPreferencesSection(prefs);

  const sections = [
    `You are an AI coding assistant working in the project "${projectName}".`,
    `Project path: ${projectPath}`,
    "",
    "## Project file listing",
    "```",
    listingText,
    "```",
    "",
    "## Available tools",
    "You can call the following tools to inspect and work with the project:",
    toolsText,
    "",
    "## Instructions",
    "- Use tools to explore the project before answering questions about it.",
    "- Call read_file to read file contents, search_code to search the codebase.",
    "- Use quick_view instead of search_code when you need all edit locations for a symbol.",
    "- Use slice instead of read_file when you need a single function's body.",
    "- Always provide accurate, helpful responses based on what you find.",
    "- If asked to explain the project, read key files first to give an accurate overview.",
    "- When the user asks you to build an app, game, calculator, visualization, spreadsheet, slide deck, or any interactive widget, call create_artifact with self-contained HTML/CSS/JS. The artifact renders LIVE in the chat (a sandboxed iframe), so the user can interact with it directly — not as a code block. Provide a complete, working document (inline CSS + JS).",
  ];

  if (prefsSection.length > 0) {
    sections.push("", "## Response style", prefsSection);
  }
  if (prefs.systemPromptOverride.length > 0) {
    sections.push("", "## Additional instructions", prefs.systemPromptOverride);
  }

  return sections.join("\n");
}

/**
 * Build the user-preferences section of the system prompt.
 * Only includes preferences that differ from the defaults so the prompt
 * stays concise when the user hasn't customized anything. The values match
 * the task spec: tone ∈ {concise, detailed, friendly}, sentenceCase ∈
 * {normal, title, upper}, emoji + icon booleans.
 */
function buildPreferencesSection(prefs: PromptPrefs): string {
  const lines: string[] = [];
  // The defaults are the preferences' one owner (a restated copy lived here).
  const defaults = DEFAULT_USER_PREFERENCES;
  if (prefs.tone !== defaults.tone) {
    // The tone's sentence comes from the one tone catalog, never restated here.
    const instruction = getPromptToneInstruction(prefs.tone);
    if (instruction !== undefined) lines.push(`- ${instruction}`);
  }
  if (prefs.sentenceCase !== defaults.sentenceCase) {
    if (prefs.sentenceCase === "title") {
      lines.push("- Write in Title Case (capitalize the major words of each heading and label).");
    } else if (prefs.sentenceCase === "upper") {
      lines.push("- Write in UPPERCASE.");
    }
  }
  // Emoji and icons are only mentioned when they differ from the defaults
  // (emoji=false, icons=true). This keeps the prompt clean when the user
  // hasn't changed anything.
  if (prefs.emoji) {
    lines.push("- Emojis are acceptable in responses.");
  }
  if (!prefs.icons) {
    lines.push("- Do not use unusual icons or decorative symbols.");
  }
  return lines.join("\n");
}
