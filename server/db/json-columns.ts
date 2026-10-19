/** JSON representation at the encrypted storage boundary. Protocol interpretation
 * belongs to callers; this owner admits opaque native evidence as plain JSON. */
import { assertNotProxy, ROOT_POLICY, snapshotJsonValue } from "../kernel/canonical.ts";
import { WebError } from "../kernel/errors.ts";

function invalidInput(): WebError {
  return new WebError("Database JSON input is invalid", "db_json_input_invalid");
}

/** One structural ceiling, shared with generic forensic evidence. There is no
 * extra storage byte cap: the provider ingress owns its configured byte limit. */
function snapshotJsonColumn(value: unknown): unknown {
  try {
    const { maximumDepth, maximumNodes } = ROOT_POLICY.forensics.limits;
    const snapshot = snapshotJsonValue(value, { maximumDepth, maximumNodes });
    // JSON.stringify loses negative zero's sign. Refuse instead of silently
    // changing exact opaque evidence. The snapshot is now trap-free and bounded.
    const pending: unknown[] = [snapshot];
    while (pending.length > 0) {
      const current = pending.pop();
      if (Object.is(current, -0)) throw invalidInput();
      if (current !== null && typeof current === "object") {
        for (const child of Object.values(current)) pending.push(child);
      }
    }
    return snapshot;
  } catch {
    throw invalidInput();
  }
}

/** Snapshot selected JSON columns before schema parsing can read their fields.
 * Undefined outer options mean absent; undefined inside a JSON value refuses.
 * Other API fields keep their existing schema semantics. No getter is invoked
 * to discover, inspect or copy a selected value. */
function snapshotJsonFields<T extends object>(input: T, fields?: readonly (keyof T)[]): T {
  try {
    assertNotProxy(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
    const selected = fields ?? Reflect.ownKeys(descriptors) as (keyof T)[];
    const values = Object.create(null) as Record<PropertyKey, unknown>;
    for (const field of selected) {
      const descriptor = Object.hasOwn(descriptors, field) ? descriptors[field] : undefined;
      if (!descriptor) continue;
      if (!("value" in descriptor) || !descriptor.enumerable) throw invalidInput();
      if (descriptor.value === undefined) delete descriptors[field];
      else values[field] = descriptor.value;
    }
    const snapshot = snapshotJsonColumn(values) as Record<PropertyKey, unknown>;
    for (const field of selected) {
      if (Object.hasOwn(descriptors, field)) descriptors[field]!.value = snapshot[field];
    }
    // Schema accessors on other fields must not replace an admitted column.
    return Object.freeze(Object.create(prototype, descriptors)) as T;
  } catch {
    throw invalidInput();
  }
}

/** One column-selection policy for sync writes and async call/transaction
 * admission before structured clone can evaluate getters. The worker repeats
 * the same admission. This switch selects columns, not DB execution handlers. */
export function snapshotDbWriteArguments(method: string, args: readonly unknown[]): readonly unknown[] {
  let index: number;
  let value: unknown;
  switch (method) {
    case "createMessage":
      index = 0;
      value = snapshotJsonFields(args[0] as { metadata?: unknown }, ["metadata"]);
      break;
    case "createToolCall":
      index = 0;
      value = snapshotJsonFields(args[0] as { public_projection?: unknown }, ["public_projection"]);
      break;
    case "updateMessageMetadata":
      index = 1;
      value = snapshotJsonFields(args[1] as object);
      break;
    case "updateToolCall":
      index = 2;
      value = snapshotJsonFields(args[2] as { publicProjection?: unknown }, ["publicProjection"]);
      break;
    default:
      return args;
  }
  const prepared = [...args];
  prepared[index] = value;
  return prepared;
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJsonOrNull(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebError("Stored database JSON is invalid", "db_json_invalid");
  }
}
