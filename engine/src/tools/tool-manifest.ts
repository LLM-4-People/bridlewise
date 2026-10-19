import { HarnessError, InputError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

/**
 * Governed tool manifest — the authoritative registry of all available
 * tools (built-in and MCP-provided).
 *
 * Each tool entry declares:
 * - stable identity (id, name, description)
 * - input/output JSON Schemas
 * - required capabilities (read, write, execute, network)
 * - resource bounds (timeout, output size, memory)
 * - the adapter that implements it (adapterId)
 *
 * The manifest is extensible: new tools are registered without modifying
 * core logic. Registration validates uniqueness, schema shape, capability
 * membership, and bound ceilings. The manifest is frozen after construction
 * so callers cannot mutate it after validation.
 *
 * This module lives in the domain layer: it declares contracts, not effects.
 */

export const TOOL_CAPABILITIES = deepFreeze(["read", "write", "execute", "network"] as const);
export type ToolCapability = typeof TOOL_CAPABILITIES[number];

export type ToolResourceBounds = Readonly<{
  timeoutMs: number;
  maxOutputBytes: number;
  maxMemoryBytes: number;
}>;

export type ToolManifestEntry = Readonly<{
  id: string;
  name: string;
  description: string;
  /**
   * The plain-words imperative label a UI shows for one call ("edit file",
   * "read file"). Declared here, at the tool's own registration, so the
   * answer to "what is this tool called in plain words" travels with the
   * manifest instead of being re-answered by a consumer's hand table.
   * Optional: a tool with no bespoke label renders as its name with
   * underscores spaced.
   */
  label?: string;
  /**
   * The shape the tool's recorded output takes, for a renderer that picks a
   * view from it: `"file"` (the contents of the file the input names),
   * `"command"` (a shell command's streams), `"search"` (a list of code
   * locations). Declared here, at the tool's own registration, so the
   * renderer reads the registry's answer instead of re-deriving it from the
   * tool's name in a hand-maintained set. Absent for a tool whose output is
   * none of these (renders as JSON/text by its own structure).
   */
  outputShape?: "file" | "command" | "search";
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
  capabilities: readonly ToolCapability[];
  bounds: ToolResourceBounds;
  adapterId: string;
}>;

export type ToolManifest = Readonly<{
  register(entry: ToolManifestEntry): void;
  get(id: string): ToolManifestEntry | undefined;
  getByName(name: string): ToolManifestEntry | undefined;
  entries(): readonly ToolManifestEntry[];
  ids(): readonly string[];
  names(): readonly string[];
  size(): number;
  validate(): readonly string[];
  identityHash(): string;
}>;

export class ToolManifestError extends HarnessError {
  constructor(message: string, code = "tool_manifest_invalid") {
    super(message, code);
  }
}

const CAPABILITY_SET = new Set<string>(TOOL_CAPABILITIES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = ROOT_POLICY.tools.limits.maximumToolNameCharacters;
const MAX_DESCRIPTION_LENGTH = ROOT_POLICY.tools.limits.maximumToolDescriptionCharacters;
const MAX_CAPABILITIES = 8;
const MAX_BOUNDS_TIMEOUT_MS = ROOT_POLICY.tools.limits.maximumToolTimeoutMs;
const MAX_BOUNDS_OUTPUT_BYTES = ROOT_POLICY.tools.limits.maximumToolOutputBytes;
const MAX_BOUNDS_MEMORY_BYTES = ROOT_POLICY.tools.limits.maximumToolMemoryBytes;
const DEFAULT_BOUNDS_TIMEOUT_MS = ROOT_POLICY.tools.limits.defaultToolTimeoutMs;

export const DEFAULT_TOOL_RESOURCE_BOUNDS: ToolResourceBounds = deepFreeze({
  timeoutMs: DEFAULT_BOUNDS_TIMEOUT_MS,
  maxOutputBytes: MAX_BOUNDS_OUTPUT_BYTES,
  maxMemoryBytes: MAX_BOUNDS_MEMORY_BYTES,
});

export function validateToolManifestEntry(entry: ToolManifestEntry): readonly string[] {
  const violations: string[] = [];
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_ID_LENGTH) {
    violations.push("id must be a non-empty string within length limits");
  } else if (!ID_PATTERN.test(entry.id)) {
    violations.push(`id '${entry.id}' does not match required pattern`);
  }
  if (typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > MAX_NAME_LENGTH) {
    violations.push("name must be a non-empty string within length limits");
  } else if (!NAME_PATTERN.test(entry.name)) {
    violations.push(`name '${entry.name}' does not match required pattern`);
  }
  if (typeof entry.description !== "string" || entry.description.length === 0) {
    violations.push("description must be a non-empty string");
  } else if (entry.description.length > MAX_DESCRIPTION_LENGTH) {
    violations.push("description exceeds maximum length");
  }
  if (typeof entry.inputSchema !== "object" || entry.inputSchema === null || Array.isArray(entry.inputSchema)) {
    violations.push("inputSchema must be a JSON object");
  } else {
    const schema = entry.inputSchema as Readonly<Record<string, unknown>>;
    if (schema.type !== "object") {
      violations.push("inputSchema must declare type 'object'");
    }
  }
  if (entry.outputSchema !== undefined) {
    if (typeof entry.outputSchema !== "object" || entry.outputSchema === null || Array.isArray(entry.outputSchema)) {
      violations.push("outputSchema must be a JSON object when present");
    }
  }
  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
    violations.push("capabilities must be a non-empty array");
  } else {
    if (entry.capabilities.length > MAX_CAPABILITIES) {
      violations.push(`capabilities exceed maximum of ${MAX_CAPABILITIES}`);
    }
    const seen = new Set<string>();
    for (const cap of entry.capabilities) {
      if (!CAPABILITY_SET.has(cap)) {
        violations.push(`unknown capability '${cap}'`);
      }
      if (seen.has(cap)) {
        violations.push(`duplicate capability '${cap}'`);
      }
      seen.add(cap);
    }
  }
  if (typeof entry.bounds !== "object" || entry.bounds === null) {
    violations.push("bounds must be an object");
  } else {
    const bounds = entry.bounds;
    if (typeof bounds.timeoutMs !== "number" || !Number.isInteger(bounds.timeoutMs) || bounds.timeoutMs <= 0) {
      violations.push("bounds.timeoutMs must be a positive integer");
    } else if (bounds.timeoutMs > MAX_BOUNDS_TIMEOUT_MS) {
      violations.push("bounds.timeoutMs exceeds maximum");
    }
    if (typeof bounds.maxOutputBytes !== "number" || !Number.isInteger(bounds.maxOutputBytes) || bounds.maxOutputBytes <= 0) {
      violations.push("bounds.maxOutputBytes must be a positive integer");
    } else if (bounds.maxOutputBytes > MAX_BOUNDS_OUTPUT_BYTES) {
      violations.push("bounds.maxOutputBytes exceeds maximum");
    }
    if (typeof bounds.maxMemoryBytes !== "number" || !Number.isInteger(bounds.maxMemoryBytes) || bounds.maxMemoryBytes <= 0) {
      violations.push("bounds.maxMemoryBytes must be a positive integer");
    } else if (bounds.maxMemoryBytes > MAX_BOUNDS_MEMORY_BYTES) {
      violations.push("bounds.maxMemoryBytes exceeds maximum");
    }
  }
  if (typeof entry.adapterId !== "string" || entry.adapterId.length === 0) {
    violations.push("adapterId must be a non-empty string");
  } else if (!ADAPTER_ID_PATTERN.test(entry.adapterId)) {
    violations.push(`adapterId '${entry.adapterId}' does not match required pattern`);
  }
  return violations;
}

export function createToolManifest(initialEntries: readonly ToolManifestEntry[] = []): ToolManifest {
  const byId = new Map<string, ToolManifestEntry>();
  const byName = new Map<string, ToolManifestEntry>();

  function doRegister(entry: ToolManifestEntry): void {
    const violations = validateToolManifestEntry(entry);
    if (violations.length > 0) {
      throw new ToolManifestError(
        `Invalid tool manifest entry '${entry.id ?? "<unknown>"}': ${violations.join("; ")}`,
        "tool_manifest_entry_invalid",
      );
    }
    if (byId.has(entry.id)) {
      throw new InputError(
        `Tool manifest entry '${entry.id}' is already registered`,
        "tool_manifest_duplicate_id",
      );
    }
    if (byName.has(entry.name)) {
      throw new InputError(
        `Tool manifest name '${entry.name}' is already registered`,
        "tool_manifest_duplicate_name",
      );
    }
    const frozen = deepFreeze({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.outputShape !== undefined ? { outputShape: entry.outputShape } : {}),
      inputSchema: deepFreeze({ ...entry.inputSchema }) as Readonly<Record<string, unknown>>,
      ...(entry.outputSchema !== undefined
        ? { outputSchema: deepFreeze({ ...entry.outputSchema }) as Readonly<Record<string, unknown>> }
        : {}),
      capabilities: deepFreeze([...entry.capabilities]),
      bounds: deepFreeze({ ...entry.bounds }),
      adapterId: entry.adapterId,
    });
    byId.set(frozen.id, frozen);
    byName.set(frozen.name, frozen);
  }

  for (const entry of initialEntries) {
    doRegister(entry);
  }

  return deepFreeze({
    register(entry: ToolManifestEntry): void {
      doRegister(entry);
    },
    get(id: string): ToolManifestEntry | undefined {
      return byId.get(id);
    },
    getByName(name: string): ToolManifestEntry | undefined {
      return byName.get(name);
    },
    entries(): readonly ToolManifestEntry[] {
      return [...byId.values()];
    },
    ids(): readonly string[] {
      return [...byId.keys()];
    },
    names(): readonly string[] {
      return [...byName.keys()];
    },
    size(): number {
      return byId.size;
    },
    validate(): readonly string[] {
      const violations: string[] = [];
      const ids = new Set<string>();
      const names = new Set<string>();
      for (const entry of byId.values()) {
        const entryViolations = validateToolManifestEntry(entry);
        for (const v of entryViolations) violations.push(`${entry.id}: ${v}`);
        if (ids.has(entry.id)) violations.push(`duplicate id: ${entry.id}`);
        ids.add(entry.id);
        if (names.has(entry.name)) violations.push(`duplicate name: ${entry.name}`);
        names.add(entry.name);
      }
      return violations;
    },
    identityHash(): string {
      const sorted = [...byId.values()].map((e) => ({
        id: e.id,
        name: e.name,
        capabilities: [...e.capabilities],
        adapterId: e.adapterId,
      })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return canonicalHash(sorted);
    },
  });
}

export function mergeBounds(
  defaults: ToolResourceBounds,
  overrides?: Partial<ToolResourceBounds>,
): ToolResourceBounds {
  if (overrides === undefined) return defaults;
  return deepFreeze({
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    maxOutputBytes: overrides.maxOutputBytes ?? defaults.maxOutputBytes,
    maxMemoryBytes: overrides.maxMemoryBytes ?? defaults.maxMemoryBytes,
  });
}

export { MAX_BOUNDS_TIMEOUT_MS, MAX_BOUNDS_OUTPUT_BYTES, MAX_BOUNDS_MEMORY_BYTES };
