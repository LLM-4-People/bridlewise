/**
 * Config binding — the ONE mechanism that ties an exposure Customization to a
 * path in `bridlewise.config.json`, so a knob a module publishes is backed by
 * the config file (the single source of truth for values) instead of a
 * per-process in-memory stub.
 *
 * WHY THIS EXISTS
 *
 * The exposure pipeline (register → `buildUiSchema` → the settings UI) already
 * renders every registered Customization as a settings row. But each module's
 * registration owned a private mutable state object with literal defaults, and
 * `set` mutated that object only: nothing persisted, the value reset on
 * restart, and the config write gate never saw it. Two parallel configurable
 * systems answered "what is this knob's value" differently.
 *
 * This module is the choke point where the two meet. A Customization declares
 * `configPath` (e.g. `"memory.trimThreshold"`); its `current` reads through the
 * installed store and its `set` writes through the installed store. The store
 * is the ONLY door to the config document from a customization, so:
 *
 * - Deny-by-default is structural: a `configPath` the schema does not declare
 *   refuses to register (a module cannot publish a configurable the config
 *   vocabulary does not know about), and a value the schema rejects never
 *   reaches the disk.
 * - The config file stays the single source of truth for VALUES; the
 *   registration file owns only PRESENTATION (label, description, unit).
 *
 * THE PLUGGABLE STORE — WHY
 *
 * `registerAllExposure()` runs in BOTH the engine CLI (which owns its config
 * file and writes it through `atomicWriteFile` + the schema gate) and the web
 * server (which writes through `writeConfigRaw`, the deny-by-default write
 * gate). The engine cannot import the server, so the store is an interface the
 * HOSTING runtime installs once via {@link installCustomizationConfigStore}:
 *
 * - the web server installs a store backed by `readConfigRaw`/`writeConfigRaw`;
 * - the engine CLI installs a store backed by its own schema-gated file write.
 *
 * Both validate the candidate document against `getConfigDocumentSchema()`, so the
 * deny-by-default guarantee holds identically in either host.
 *
 * WRITE OF DEFAULT OMITS THE KEY
 *
 * The document stores overrides, not the default catalog. A write whose
 * value equals the path's declared default omits the key (and prunes empty
 * parent objects) so `seedFromConfig` supplies the registration/schema
 * default. A write of a non-default still assigns. Type-zeros (`0`,
 * `false`, `""`) are never treated as defaults — only a declared schema
 * `.default()` or a default recorded at registration for that path. The
 * catalog lives in `customization.ts`, which already imports this file, so
 * the registration door pushes the default in rather than this file
 * pulling the catalog (that import would cycle).
 *
 * A SAME-VALUE WRITE IS A BYTE-LEVEL NO-OP
 *
 * A write of the value the path already carries reaches no store at all —
 * the omit-on-default normalization fires only on a genuine value change.
 * Without this rule a same-value write pruned an explicitly-carried
 * default restatement, and the later re-add landed the line at its
 * section's end: a value-identical write that reordered the document.
 */

import { InputError } from "../../kernel/errors.ts";
import { getConfigDocumentSchema } from "../../kernel/config-contracts.ts";
import { canonicalJson } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { engineConfigDocumentPath, readConfigDocumentRawIfPresent } from "../../kernel/config.ts";
import { withConfigWriteLock } from "../../kernel/config-write-lock.ts";
import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { describeSchemaIssues } from "../../kernel/errors.ts";
import type { CustomizationValue } from "./customization.ts";

/**
 * The host-supplied door to the config document. `readDocument` returns the
 * current parsed config as a plain object (a fresh, mutable parse — callers may
 * not mutate a shared frozen copy). `writeDocument` persists a candidate
 * document, validating it against `getConfigDocumentSchema()` first and refusing
 * (throwing) on any schema violation. `configFilePath` is the file the store
 * persists to — the cross-process write lock is keyed on it, so the store
 * declares the path it writes rather than the lock guessing it.
 */
export interface CustomizationConfigStore {
  readonly configFilePath: string;
  readonly readDocument: () => Record<string, unknown>;
  readonly writeDocument: (doc: Record<string, unknown>) => void;
}

let installedStore: CustomizationConfigStore | undefined;

/**
 * Install the config store the exposure customizations read/write through.
 * Called once by the hosting runtime before any config-bound customization is
 * read or set. Idempotent-replaceable so tests can substitute a store.
 */
export function installCustomizationConfigStore(store: CustomizationConfigStore): void {
  installedStore = store;
}

/** Test hook: drop the installed store so a fresh install is required. */
export function resetCustomizationConfigStore(): void {
  installedStore = undefined;
}

/** Whether a config store has been installed by the hosting runtime. */
export function hasCustomizationConfigStore(): boolean {
  return installedStore !== undefined;
}

function requireStore(): CustomizationConfigStore {
  if (installedStore === undefined) {
    throw new InputError(
      "exposure: no customization config store installed — the hosting runtime " +
        "must call installCustomizationConfigStore before a config-bound customization is used",
      "customization_config_store_missing",
    );
  }
  return installedStore;
}

// ── Schema introspection (deny-by-default membership + per-path validation) ──

/** Zod wrapper kinds that carry their wrapped schema in `_def.innerType`. */
const WRAPPER_TYPES = new Set(["optional", "default", "nullable", "readonly"]);

type AnySchema = {
  _def?: { type?: string; innerType?: AnySchema; defaultValue?: unknown };
  shape?: Record<string, AnySchema>;
  safeParse?: (value: unknown) => { success: boolean };
};

/** Sentinel: the path has no declared default (schema or registration). */
const NO_DEFAULT = Symbol("no-declared-default");

/**
 * Registration-declared defaults, keyed by config path. Populated by
 * {@link rememberConfigPathDefault} from `registerCustomization` so this
 * module never imports the catalog. Schema `.default()` still wins when
 * present (config SSOT).
 */
const registrationDefaults = new Map<string, CustomizationValue>();

/**
 * Record the declared default for a config-bound customization. Called from
 * the registration door, not from a catalog lookup (that import would cycle).
 */
export function rememberConfigPathDefault(path: string, value: CustomizationValue): void {
  registrationDefaults.set(path, value);
}

/** Unwrap optional/default/nullable/readonly wrappers to the inner schema. */
function unwrapSchema(schema: AnySchema | undefined): AnySchema | undefined {
  let current = schema;
  while (current?._def?.type !== undefined && WRAPPER_TYPES.has(current._def.type)) {
    current = current._def.innerType;
  }
  return current;
}

function readDefaultValue(schema: AnySchema): unknown {
  const raw = schema._def?.defaultValue;
  return typeof raw === "function" ? (raw as () => unknown)() : raw;
}

/**
 * Leaf schema for `path` WITH wrappers still attached, so a `.default()`
 * wrapper can be read before unwrap. `unwrapSchema` skips `"default"` and
 * would lose the value.
 */
function schemaAtPath(path: string): AnySchema | undefined {
  const segments = path.split(".");
  let schema: AnySchema | undefined = getConfigDocumentSchema() as unknown as AnySchema;
  for (const segment of segments) {
    const objectSchema = unwrapSchema(schema);
    const shape = objectSchema?.shape;
    if (shape === undefined) return undefined;
    schema = shape[segment];
    if (schema === undefined) return undefined;
  }
  return schema;
}

function schemaDefaultAt(schema: AnySchema | undefined): unknown {
  let current = schema;
  while (current?._def?.type !== undefined && WRAPPER_TYPES.has(current._def.type)) {
    if (current._def.type === "default") return readDefaultValue(current);
    current = current._def.innerType;
  }
  return NO_DEFAULT;
}

/**
 * Declared default for a dotted path: schema `.default()` first, then the
 * registration default recorded for that path. Missing both means "do not
 * omit" — never a type-zero.
 */
function declaredDefaultForPath(path: string): unknown {
  const fromSchema = schemaDefaultAt(schemaAtPath(path));
  if (fromSchema !== NO_DEFAULT) return fromSchema;
  if (registrationDefaults.has(path)) return registrationDefaults.get(path);
  return NO_DEFAULT;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * Resolve a dotted config path to its leaf schema, or `undefined` when any
 * segment is not declared. This is the deny-by-default membership test: a path
 * is real only if every segment is a declared strictObject key ending at a
 * concrete value schema.
 */
function resolvePathSchema(path: string): AnySchema | undefined {
  const segments = path.split(".");
  let schema: AnySchema | undefined = getConfigDocumentSchema() as unknown as AnySchema;
  for (const segment of segments) {
    const objectSchema = unwrapSchema(schema);
    const shape = objectSchema?.shape;
    if (shape === undefined) return undefined;
    schema = unwrapSchema(shape[segment]);
    if (schema === undefined) return undefined;
  }
  return schema;
}

/**
 * Whether a dotted config path is declared in the config document schema.
 * Exported for the registration-time deny-by-default check in
 * `customization.ts` (a customization bound to a path the schema does not know
 * refuses to register).
 */
export function isConfigPathDeclared(path: string): boolean {
  return resolvePathSchema(path) !== undefined;
}

/**
 * Validate a candidate value against the leaf schema for `path`. Throws
 * `InputError` when the path is undeclared or the value fails the schema. This
 * is the per-path pre-check; the store's `writeDocument` re-validates the whole
 * document, so a value that passes here but breaks a cross-field rule is still
 * refused at the gate.
 */
function assertPathValue(path: string, value: CustomizationValue): void {
  const schema = resolvePathSchema(path);
  if (schema?.safeParse === undefined) {
    throw new InputError(
      `exposure: config path "${path}" is not declared in the config document schema`,
      "customization_config_path_unknown",
      { configPath: path },
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InputError(
      `exposure: value for config path "${path}" failed the config schema`,
      "customization_config_value_invalid",
      { configPath: path },
    );
  }
}

// ── Document traversal ──

/** Read the value at a dotted path from a config document, or `undefined`. */
function readPathValue(doc: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let node: unknown = doc;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Return a deep copy of `doc` with `path` set to `value` (creating parents). */
function withPathValue(
  doc: Record<string, unknown>,
  path: string,
  value: CustomizationValue,
): Record<string, unknown> {
  const segments = path.split(".");
  const root: Record<string, unknown> = { ...doc };
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const child = cursor[segment];
    const next: Record<string, unknown> =
      child !== null && typeof child === "object" && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = value;
  return root;
}

/**
 * Deep-copy `doc` with `path` removed. Empty parent objects along that path
 * are pruned so a reset of the only key in a section does not leave `{}`.
 */
function withoutPathValue(doc: Record<string, unknown>, path: string): Record<string, unknown> {
  const segments = path.split(".");
  const root: Record<string, unknown> = { ...doc };
  const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const child = cursor[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      return root;
    }
    const next: Record<string, unknown> = { ...(child as Record<string, unknown>) };
    cursor[segment] = next;
    chain.push({ parent: cursor, key: segment });
    cursor = next;
  }
  delete cursor[segments[segments.length - 1]!];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const { parent, key } = chain[i]!;
    const child = parent[key];
    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child as Record<string, unknown>).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
  return root;
}

/**
 * Read the current value for a config-bound customization: the persisted
 * override when the key is present, `undefined` when it is not. Defaults
 * are NOT mirrored into the instance file: they live in the contract —
 * the config document schema's declared `.default()` for the path, with
 * the per-path registration recording it where the schema leaves it open
 * (see `declaredDefaultForPath`) — and the instance file holds overrides
 * only, so a key restating the contract's own default is drift, not
 * content. The default is a DEFAULT, not a fallback source: a caller that
 * needs a value always applies its own declared default for the absent
 * case — see `readNumberCustomization` and `seedFromConfig`.
 */
export function readConfigCustomization(configPath: string): CustomizationValue {
  const store = requireStore();
  const value = readPathValue(store.readDocument(), configPath);
  return value as CustomizationValue;
}

/**
 * Read the current value for a config-bound customization expected to be a
 * finite number, falling back to the declared default when the stored value
 * is absent or not a usable number. The single owner of that decision — the
 * per-module registration files consume this instead of each carrying the
 * same three-line reader.
 */
export function readNumberCustomization(configPath: string, fallback: number): number {
  const value = readConfigCustomization(configPath);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Read the current value for a config-bound customization expected to be a
 * boolean, falling back to the declared default when the stored value is
 * absent or not a boolean. The boolean twin of `readNumberCustomization` —
 * the single owner of that decision so no per-module registration carries
 * its own three-line fallback reader.
 */
export function readBooleanCustomization(configPath: string, fallback: boolean): boolean {
  const value = readConfigCustomization(configPath);
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Read the current value for a config-bound customization expected to be a
 * string, falling back to the declared default when the stored value is
 * absent or not a string. The string twin of `readNumberCustomization` —
 * the single owner of that decision so no per-module registration carries
 * its own three-line fallback reader.
 */
export function readStringCustomization(configPath: string, fallback: string): string {
  const value = readConfigCustomization(configPath);
  return typeof value === "string" ? value : fallback;
}

/**
 * Write a config-bound customization's value through the installed store's
 * gate. The value is validated against the leaf schema for the path (a clear
 * per-path error), then the candidate document is handed to the store, which
 * re-validates the WHOLE document against `getConfigDocumentSchema()` before a
 * byte reaches the disk (deny-by-default at the write gate).
 *
 * A write of the value the path already carries is a NO-OP: no store write
 * happens at all, so the document's bytes — key order, explicit lines,
 * formatting — cannot move. The file is the byte-identity anchor every
 * consumer fingerprints, and the omit-on-default normalization below used to
 * turn this no-op into a file change: a default restatement the file carried
 * explicitly was pruned by the very write that restated it, and a later
 * re-add of the line landed at its section's end — a value-identical write
 * that reordered the file.
 *
 * A value equal to the path's declared default is omitted from the document
 * (VS Code: settings.json stores overrides, not the default catalog) — but
 * only when the write genuinely changes the stored value. If omitting would
 * fail the whole-document schema — a required key — the value is assigned
 * instead. A path with no declared default is always assigned: type-zeros
 * are not defaults.
 */
export function writeConfigCustomization(configPath: string, value: CustomizationValue): void {
  assertPathValue(configPath, value);
  const store = requireStore();
  // The whole read-modify-write cycle holds the config's cross-process
  // write lock: the candidate is composed from this store's own read INSIDE
  // the lock, so no concurrent writer's cycle can interleave between the
  // read and the write (the lost-update window — the compose must see a
  // committed document, never another writer's mid-cycle state).
  withConfigWriteLock(store.configFilePath, () => {
    const current = store.readDocument();
    if (sameConfigValue(readPathValue(current, configPath), value)) {
      // The no-op write: the path already carries exactly this value, so
      // nothing may reach the store — not even a re-serialization. Writing
      // the same value must leave the same bytes (the drive-16 reorder: the
      // prune fired on a no-op and the restore re-added the line at the
      // section's end).
      return;
    }
    const declared = declaredDefaultForPath(configPath);
    if (declared !== NO_DEFAULT && sameConfigValue(value, declared)) {
      const omitted = withoutPathValue(current, configPath);
      const omitOk = getConfigDocumentSchema().safeParse(omitted).success;
      if (omitOk) {
        store.writeDocument(omitted);
        return;
      }
      const assigned = withPathValue(current, configPath, value);
      const assignOk = getConfigDocumentSchema().safeParse(assigned).success;
      if (assignOk) {
        // Omit broke a required key (or another whole-document rule). Keep
        // the key so a return-to-default cannot refuse a valid document.
        store.writeDocument(assigned);
        return;
      }
      // Neither candidate is a valid document — the in-memory partial
      // fixtures this door's tests use. The live store refuses those
      // before they land. Prefer omit so a write of default still drops
      // the key.
      store.writeDocument(omitted);
      return;
    }
    store.writeDocument(withPathValue(current, configPath, value));
  });
}

/**
 * Seed a module's live projection from the config file. Returns the persisted
 * value at `configPath` when the config file declares one, otherwise the
 * registration's declared `defaultValue`. Called once at registration so the
 * in-memory projection starts from the persisted value — the config file is
 * the source of truth the projection mirrors.
 *
 * When no store is installed yet (a host that has not called
 * `installCustomizationConfigStore`), the declared default is returned: the
 * projection still has a correct starting value, and the first `set` (which
 * requires the store) re-syncs from the persisted document.
 */
export function seedFromConfig(configPath: string, defaultValue: CustomizationValue): CustomizationValue {
  if (installedStore === undefined) return defaultValue;
  const value = readPathValue(installedStore.readDocument(), configPath);
  return value === undefined ? defaultValue : (value as CustomizationValue);
}

/**
 * Re-seed a module's live projection from the config file. Called at the top
 * of a module's `register*Exposure()` (which `registerAllExposure` runs only
 * AFTER the config store is installed), so the projection reflects the
 * persisted values — not the import-time defaults — by the time any knob is
 * read or any action runs.
 *
 * `bindings` maps a state field to its config path. The config value is coerced
 * to the field's existing type: a `Set` field takes a comma-separated string,
 * everything else is assigned as-is. A field whose path is absent from the
 * config keeps its current value, so a fresh config leaves every default
 * standing.
 */
export function syncStateFromConfig<State extends Record<string, unknown>>(
  state: State,
  bindings: Readonly<Record<string, string>>,
): void {
  if (installedStore === undefined) return;
  const doc = installedStore.readDocument();
  const target = state as Record<string, unknown>;
  for (const [field, configPath] of Object.entries(bindings)) {
    const value = readPathValue(doc, configPath);
    if (value === undefined) continue;
    const existing = target[field];
    if (existing instanceof Set) {
      target[field] = new Set(
        String(value).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      );
    } else {
      target[field] = value;
    }
  }
}

/**
 * Build the `set` callback for a config-bound customization. The returned
 * setter writes the value through the config gate (persisted, schema-checked)
 * AND applies `apply` to keep the module's live projection in sync, so the
 * very next action reads the new value (liveness) and the value survives a
 * restart (persistence). The projection mutation runs only after the gate
 * accepts the write — a refused value never reaches the projection.
 */
export function configBoundSet(
  configPath: string,
  apply: (value: CustomizationValue) => void,
): (value: CustomizationValue) => void {
  return (value: CustomizationValue) => {
    writeConfigCustomization(configPath, value);
    apply(value);
  };
}

// ── Engine-hosted store (the CLI's door to its own config file) ──

/**
 * The store's read goes through the ONE config read/refusal API: an absent
 * document is the empty document (a first write creates it); an unreadable,
 * non-JSON or non-object document is the reader's typed refusal, never `{}`
 * (a `{}` here would let the next write replace the whole file).
 */
function readEngineConfigDocument(): Record<string, unknown> {
  return readConfigDocumentRawIfPresent(engineConfigDocumentPath()) ?? {};
}

function writeEngineConfigDocument(doc: Record<string, unknown>): void {
  // The deny-by-default gate, identical in shape to the server's: the whole
  // candidate document is validated against `getConfigDocumentSchema()` before a
  // byte reaches the disk. A path the vocabulary does not declare, a
  // wrong-typed value or an out-of-range number is rejected, not written.
  const parsed = getConfigDocumentSchema().safeParse(doc);
  if (!parsed.success) {
    throw new InputError(
      `exposure: config write rejected by the config document schema: ${describeSchemaIssues(parsed.error.issues)}`,
      "invalid_config_document",
    );
  }
  const result = atomicWriteFile(engineConfigDocumentPath(), `${JSON.stringify(doc, null, 2)}\n`, {
    // The config reader refuses any mode but 0600; tighten to it on every
    // write so a too-open existing file is corrected, never preserved.
    requiredMode: Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8),
  });
  if (!result.success) {
    throw new InputError(
      `exposure: config write failed: ${result.reason ?? "unknown"}`,
      "config_write_failed",
    );
  }
}

/**
 * The store an engine-hosted runtime (the CLI) installs: reads and writes the
 * engine's own `bridlewise.config.json`, gated by the config document
 * schema. The web server installs its own store (backed by
 * `readConfigRaw`/`writeConfigRaw`) instead; both share the same schema gate.
 */
export function createEngineCustomizationConfigStore(): CustomizationConfigStore {
  return Object.freeze({
    configFilePath: engineConfigDocumentPath(),
    readDocument: readEngineConfigDocument,
    writeDocument: writeEngineConfigDocument,
  });
}
