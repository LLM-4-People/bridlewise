import { InputError } from "./errors.ts";
import { TOOL_PARAMETER_SCHEMA, type ContractSettings } from "./contracts.ts";
import { canonicalJson, deepFreeze } from "./integrity.ts";
import { escapePointer } from "../shared/json-pointer.ts";
import { isPlainObject, memberOf } from "../shared/type-guards.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export const SCHEMA_KEYWORD_MATRIX = deepFreeze({
  root: ["$schema"],
  object: ["additionalProperties", "const", "description", "enum", "properties", "required", "type"],
  array: ["const", "description", "enum", "items", "maxItems", "minItems", "type"],
  string: ["const", "description", "enum", "format", "maxLength", "minLength", "pattern", "type"],
  number: ["const", "description", "enum", "maximum", "minimum", "type"],
  integer: ["const", "description", "enum", "maximum", "minimum", "type"],
  boolean: ["const", "description", "enum", "type"],
  null: ["const", "description", "enum", "type"],
  combinator: ["allOf", "anyOf", "description", "oneOf"],
} as const);

// THE MATRIX IS THE VOCABULARY, AND THESE ARE READ OUT OF IT.
//
// `SchemaType` is already derived — `keyof` the matrix, minus the two rows
// that are not types. The membership set beside it was NOT: it listed the
// same seven names again inside `new Set<SchemaType>([…])`, which reads as a
// type check and is not one, because a set holding FEWER members is
// assignable. A schema type added to the matrix and forgotten there would be
// accepted by the compiler everywhere and REFUSED here, at the validator.
// Read from the matrix and there is nothing to forget.
const NON_TYPE_ROWS = deepFreeze(["root", "combinator"] as const);
type SchemaType = Exclude<keyof typeof SCHEMA_KEYWORD_MATRIX, typeof NON_TYPE_ROWS[number]>;

const isSchemaType = memberOf(
  Object.keys(SCHEMA_KEYWORD_MATRIX).filter(
    (row): row is SchemaType => !(NON_TYPE_ROWS as readonly string[]).includes(row),
  ),
);
// The combinator row names every combinator keyword there is; a third one
// added to the matrix has to be answered here too, so it is read rather than
// copied.
const COMBINATORS = memberOf(SCHEMA_KEYWORD_MATRIX.combinator.filter((k) => k !== "description"));
const KNOWN_KEYWORDS = new Set<string>(Object.values(SCHEMA_KEYWORD_MATRIX).flat());
const FORMATS = new Set(["date", "date-time", "email", "uri", "uuid"]);

export const SCHEMA_SUBSET_REVISION = "strict-json-schema-subset/v2";

export type SchemaSubsetIssue = Readonly<{
  path: string;
  code: string;
}>;

export type SchemaSubsetResult = Readonly<{
  ok: boolean;
  issues: readonly SchemaSubsetIssue[];
  schema?: Readonly<Record<string, unknown>>;
}>;

export function validateToolSchemaSubset(input: unknown, settings: ContractSettings): SchemaSubsetResult {
  const root = TOOL_PARAMETER_SCHEMA.safeParse(input);
  if (!root.success) {
    return deepFreeze({ ok: false, issues: [{ path: "$", code: "root_schema_invalid" }] });
  }
  const issues: SchemaSubsetIssue[] = [];
  const state = { properties: 0 };
  inspectNode(root.data, "$", 0, true, settings, state, issues);
  const bounded = issues.length <= settings.limits.maximumLosses
    ? issues
    : [
        ...issues.slice(0, settings.limits.maximumLosses - 1),
        { path: "$", code: "issue_limit_exceeded" },
      ];
  return deepFreeze(issues.length === 0
    ? { ok: true, issues: [], schema: root.data as Readonly<Record<string, unknown>> }
    : { ok: false, issues: bounded });
}

export function assertToolSchemaSubset(input: unknown, settings: ContractSettings): Readonly<Record<string, unknown>> {
  const result = validateToolSchemaSubset(input, settings);
  if (!result.ok || result.schema === undefined) {
    throw new InputError("Tool schema is outside the supported strict JSON Schema subset", "tool_schema_subset_invalid");
  }
  return result.schema;
}

function inspectNode(
  value: unknown,
  path: string,
  depth: number,
  root: boolean,
  settings: ContractSettings,
  state: { properties: number },
  issues: SchemaSubsetIssue[],
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, settings, path, "schema_node_not_object");
    return;
  }
  if (depth > settings.limits.maximumToolSchemaDepth) {
    addIssue(issues, settings, path, "schema_depth_exceeded");
    return;
  }
  const combinators = Object.keys(value).filter((key) => COMBINATORS(key));
  if (combinators.length > 0) {
    inspectCombinator(value, path, depth, root, settings, state, issues, combinators);
    return;
  }
  if (!isSchemaType(value.type)) {
    addIssue(issues, settings, `${path}/type`, "schema_type_unsupported");
    return;
  }
  const type = value.type as SchemaType;
  inspectKeywordMatrix(value, type, path, root, settings, issues);
  inspectCommonKeywords(value, path, settings, issues);
  if (type === "object") inspectObject(value, path, depth, settings, state, issues);
  else if (type === "array") inspectArray(value, path, depth, settings, state, issues);
  else inspectScalarKeywordSeparation(value, path, settings, issues);
}

function inspectKeywordMatrix(
  value: Record<string, unknown>,
  type: SchemaType,
  path: string,
  root: boolean,
  settings: ContractSettings,
  issues: SchemaSubsetIssue[],
): void {
  const allowed = new Set<string>(SCHEMA_KEYWORD_MATRIX[type]);
  if (root) allowed.add("$schema");
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      addIssue(issues, settings, `${path}/${escapePointer(key)}`, "keyword_unsupported");
    } else if (!allowed.has(key)) {
      addIssue(issues, settings, `${path}/${escapePointer(key)}`, "keyword_wrong_type");
    }
  }
  if (root) {
    if (value.$schema !== undefined && value.$schema !== ROOT_POLICY.contracts.schemaDialect) {
      addIssue(issues, settings, `${path}/$schema`, "schema_dialect_unsupported");
    }
  } else if (value.$schema !== undefined) {
    addIssue(issues, settings, `${path}/$schema`, "nested_schema_dialect_denied");
  }
}

function inspectCombinator(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  root: boolean,
  settings: ContractSettings,
  state: { properties: number },
  issues: SchemaSubsetIssue[],
  combinators: readonly string[],
): void {
  const allowed = new Set<string>(SCHEMA_KEYWORD_MATRIX.combinator);
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      addIssue(issues, settings, `${path}/${escapePointer(key)}`, "keyword_unsupported");
    } else if (!allowed.has(key) || root && key === "$schema") {
      addIssue(issues, settings, `${path}/${escapePointer(key)}`, "keyword_wrong_type");
    }
  }
  if (combinators.length !== 1) {
    addIssue(issues, settings, path, "combinator_ambiguous");
    return;
  }
  if (value.description !== undefined && (typeof value.description !== "string" ||
    value.description.length > settings.limits.maximumTextCharacters)) {
    addIssue(issues, settings, `${path}/description`, "description_invalid");
  }
  const keyword = combinators[0]!;
  const branches = value[keyword];
  if (!Array.isArray(branches) || branches.length === 0 ||
    branches.length > settings.limits.maximumToolSchemaProperties) {
    addIssue(issues, settings, `${path}/${keyword}`, "combinator_branches_invalid");
    return;
  }
  for (const [index, branch] of branches.entries()) {
    inspectNode(branch, `${path}/${keyword}/${index}`, depth + 1, false, settings, state, issues);
  }
}

function inspectObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  settings: ContractSettings,
  state: { properties: number },
  issues: SchemaSubsetIssue[],
): void {
  if (value.additionalProperties !== false) {
    addIssue(issues, settings, `${path}/additionalProperties`, "closed_object_required");
  }
  const properties = value.properties;
  if (properties !== undefined && !isPlainObject(properties)) {
    addIssue(issues, settings, `${path}/properties`, "properties_invalid");
    return;
  }
  const propertyNames = properties ? Object.keys(properties) : [];
  state.properties += propertyNames.length;
  if (state.properties > settings.limits.maximumToolSchemaProperties) {
    addIssue(issues, settings, `${path}/properties`, "property_limit_exceeded");
  }
  for (const name of propertyNames) {
    if (name.length === 0 || name.length > settings.limits.maximumIdentifierCharacters || name.includes("\0")) {
      addIssue(issues, settings, `${path}/properties`, "property_name_invalid");
      continue;
    }
    inspectNode(properties![name], `${path}/properties/${escapePointer(name)}`, depth + 1, false, settings, state, issues);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string")) {
      addIssue(issues, settings, `${path}/required`, "required_invalid");
    } else {
      const required = value.required as string[];
      if (new Set(required).size !== required.length) addIssue(issues, settings, `${path}/required`, "required_duplicate");
      for (const name of required) {
        if (!propertyNames.includes(name)) addIssue(issues, settings, `${path}/required`, "required_property_missing");
      }
    }
  }
  for (const keyword of ["items", "maxItems", "minItems"] as const) {
    if (value[keyword] !== undefined) addIssue(issues, settings, `${path}/${keyword}`, "keyword_wrong_type");
  }
}

function inspectArray(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  settings: ContractSettings,
  state: { properties: number },
  issues: SchemaSubsetIssue[],
): void {
  if (value.items === undefined) addIssue(issues, settings, `${path}/items`, "array_items_required");
  else inspectNode(value.items, `${path}/items`, depth + 1, false, settings, state, issues);
  for (const keyword of ["properties", "required", "additionalProperties"] as const) {
    if (value[keyword] !== undefined) addIssue(issues, settings, `${path}/${keyword}`, "keyword_wrong_type");
  }
  inspectNonnegativeInteger(value.minItems, `${path}/minItems`, settings, issues);
  inspectNonnegativeInteger(value.maxItems, `${path}/maxItems`, settings, issues);
  inspectOrderedBounds(value.minItems, value.maxItems, path, "item_bounds_inverted", settings, issues);
}

function inspectScalarKeywordSeparation(
  value: Record<string, unknown>,
  path: string,
  settings: ContractSettings,
  issues: SchemaSubsetIssue[],
): void {
  for (const keyword of ["properties", "required", "additionalProperties", "items", "minItems", "maxItems"] as const) {
    if (value[keyword] !== undefined) addIssue(issues, settings, `${path}/${keyword}`, "keyword_wrong_type");
  }
  if (value.type === "string") {
    inspectNonnegativeInteger(value.minLength, `${path}/minLength`, settings, issues);
    inspectNonnegativeInteger(value.maxLength, `${path}/maxLength`, settings, issues);
    if (value.pattern !== undefined && typeof value.pattern !== "string") {
      addIssue(issues, settings, `${path}/pattern`, "pattern_invalid");
    } else if (typeof value.pattern === "string") {
      try {
        new RegExp(value.pattern, "u");
      } catch (e) {handleError(e, { module: "schema-subset", operation: "catch" });
        addIssue(issues, settings, `${path}/pattern`, "pattern_invalid");
      }
    }
    if (value.format !== undefined && (typeof value.format !== "string" || !FORMATS.has(value.format))) {
      addIssue(issues, settings, `${path}/format`, "format_unsupported");
    }
    inspectOrderedBounds(value.minLength, value.maxLength, path, "length_bounds_inverted", settings, issues);
  } else {
    for (const keyword of ["minLength", "maxLength", "pattern", "format"] as const) {
      if (value[keyword] !== undefined) addIssue(issues, settings, `${path}/${keyword}`, "keyword_wrong_type");
    }
  }
  if (value.type === "number" || value.type === "integer") {
    if (value.minimum !== undefined && !isFiniteNumber(value.minimum)) {
      addIssue(issues, settings, `${path}/minimum`, "bound_invalid");
    }
    if (value.maximum !== undefined && !isFiniteNumber(value.maximum)) {
      addIssue(issues, settings, `${path}/maximum`, "bound_invalid");
    }
    if (isFiniteNumber(value.minimum) && isFiniteNumber(value.maximum) && value.minimum > value.maximum) {
      addIssue(issues, settings, path, "numeric_bounds_inverted");
    }
  } else if (value.minimum !== undefined || value.maximum !== undefined) {
    addIssue(issues, settings, path, "numeric_keyword_wrong_type");
  }
}

function inspectCommonKeywords(
  value: Record<string, unknown>,
  path: string,
  settings: ContractSettings,
  issues: SchemaSubsetIssue[],
): void {
  if (value.description !== undefined && (typeof value.description !== "string" ||
    value.description.length > settings.limits.maximumTextCharacters)) {
    addIssue(issues, settings, `${path}/description`, "description_invalid");
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      addIssue(issues, settings, `${path}/enum`, "enum_invalid");
    } else {
      if (value.enum.some((entry) => !matchesType(entry, value.type))) {
        addIssue(issues, settings, `${path}/enum`, "enum_type_mismatch");
      }
      if (new Set(value.enum.map((entry) => canonicalJson(entry))).size !== value.enum.length) {
        addIssue(issues, settings, `${path}/enum`, "enum_duplicate");
      }
    }
  }
  if (value.const !== undefined && !matchesType(value.const, value.type)) {
    addIssue(issues, settings, `${path}/const`, "const_type_mismatch");
  }
  if (value.enum !== undefined && value.const !== undefined) {
    addIssue(issues, settings, path, "enum_const_conflict");
  }
}

function inspectNonnegativeInteger(
  value: unknown,
  path: string,
  settings: ContractSettings,
  issues: SchemaSubsetIssue[],
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    addIssue(issues, settings, path, "integer_bound_invalid");
  }
}

function inspectOrderedBounds(
  minimum: unknown,
  maximum: unknown,
  path: string,
  code: string,
  settings: ContractSettings,
  issues: SchemaSubsetIssue[],
): void {
  if (Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && Number(minimum) > Number(maximum)) {
    addIssue(issues, settings, path, code);
  }
}

function addIssue(
  issues: SchemaSubsetIssue[],
  settings: ContractSettings,
  path: string,
  code: string,
): void {
  if (issues.length <= settings.limits.maximumLosses) issues.push({ path, code });
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value);
    case "null":
      return value === null;
    case "number":
      return isFiniteNumber(value);
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
