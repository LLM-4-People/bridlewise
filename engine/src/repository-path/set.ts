import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { compareUtf8Bytes } from "../kernel/ordered.ts";
import { snapshotJsonValue, type SnapshotJsonValue } from "../kernel/safe-structural.ts";
import {
  REPOSITORY_PATH_ENTRY_KINDS,
  REPOSITORY_PATH_GIT_MODES,
  REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS,
  type RepositoryPathContext,
  type RepositoryPathLimits,
  type RepositoryPathSetDecision,
  type RepositoryPathSetFinding,
  type RepositoryPathSetMember,
  type RepositoryPathSetPathViolation,
  type ValidRepositoryPath,
} from "./contracts.ts";
import {
  createRepositoryPathInspector,
} from "./logical.ts";

const CANDIDATE_KEYS = new Set(["value", "context"]);
const CONTEXT_KEYS = new Set(["entryKind", "gitMode"]);
const ENTRY_KINDS = new Set<string>(REPOSITORY_PATH_ENTRY_KINDS);
const GIT_MODES = new Set<string>(REPOSITORY_PATH_GIT_MODES);
type ParsedCandidate = Readonly<{
  value: unknown;
  context?: RepositoryPathContext;
}>;

export function inspectRepositoryPathSet(
  input: unknown,
  limits: RepositoryPathLimits,
): RepositoryPathSetDecision {
  const inspector = createRepositoryPathInspector(limits);
  let snapshot: SnapshotJsonValue;
  try {
    snapshot = snapshotJsonValue(input, {
      maximumDepth: 6,
      maximumNodes: REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumPathsPerSet * 10 + 1,
    }, "repository_path_set_structure_invalid");
  } catch {
    return structureRejected();
  }
  if (!Array.isArray(snapshot)) return structureRejected();
  if (snapshot.length > inspector.limits.maximumPathsPerSet) {
    const decision: RepositoryPathSetDecision = {
      ok: false,
      violations: [{ code: "repository_path_set_too_large" }],
      pathViolations: [],
      collisions: [],
    };
    return deepFreeze(decision);
  }

  const paths: ValidRepositoryPath[] = [];
  const pathViolations: RepositoryPathSetPathViolation[] = [];
  const collisions: RepositoryPathSetFinding[] = [];
  const exactFirst = new Map<string, RepositoryPathSetMember>();
  const portableFirst = new Map<string, Readonly<{ member: RepositoryPathSetMember; value: string }>>();

  for (const [ordinal, value] of snapshot.entries()) {
    const parsed = parseCandidate(value);
    if (!parsed) {
      pathViolations.push({
        ordinal,
        violations: [{ code: "repository_path_set_structure_invalid" }],
      });
      continue;
    }
    const decision = inspector.inspect(parsed.value, parsed.context);
    if (!decision.ok) {
      pathViolations.push({ ordinal, violations: decision.violations });
      continue;
    }
    paths.push(decision.path);
    const member = deepFreeze({ ordinal });
    const exact = exactFirst.get(decision.path.value);
    if (exact) {
      collisions.push({
        code: "repository_path_exact_duplicate",
        first: exact,
        second: member,
      });
      continue;
    }
    exactFirst.set(decision.path.value, member);
    const portable = portableFirst.get(decision.path.portabilityKey);
    if (portable && portable.value !== decision.path.value) {
      collisions.push({
        code: "repository_path_portable_collision",
        first: portable.member,
        second: member,
      });
    } else if (!portable) {
      portableFirst.set(decision.path.portabilityKey, { member, value: decision.path.value });
    }
  }

  collisions.sort((left, right) => left.second.ordinal - right.second.ordinal ||
    left.first.ordinal - right.first.ordinal || compareUtf8Bytes(left.code, right.code));
  if (pathViolations.length > 0 || collisions.length > 0) {
    return deepFreeze({ ok: false, violations: [], pathViolations, collisions });
  }
  return deepFreeze({ ok: true, paths });
}

export function requireRepositoryPathSet(
  input: unknown,
  limits: RepositoryPathLimits,
): readonly ValidRepositoryPath[] {
  const decision = inspectRepositoryPathSet(input, limits);
  if (decision.ok) return decision.paths;
  const code = decision.violations[0]?.code ?? decision.pathViolations[0]?.violations[0]?.code ??
    decision.collisions[0]?.code ?? "repository_path_set_structure_invalid";
  throw new InputError("Repository path set is invalid", code);
}

function parseCandidate(input: SnapshotJsonValue): ParsedCandidate | undefined {
  if (typeof input === "string") {
    return { value: input };
  }
  if (!isRecord(input) || !hasOnlyKeys(input, CANDIDATE_KEYS) || !("value" in input)) return undefined;
  const context = parseContext(input.context);
  if (context === false) return undefined;
  return context === undefined ? { value: input.value } : { value: input.value, context };
}

function parseContext(input: SnapshotJsonValue | undefined): RepositoryPathContext | false | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || !hasOnlyKeys(input, CONTEXT_KEYS)) return false;
  const entryKind = input.entryKind;
  const gitMode = input.gitMode;
  if (entryKind !== undefined && (typeof entryKind !== "string" || !ENTRY_KINDS.has(entryKind))) return false;
  if (gitMode !== undefined && (typeof gitMode !== "string" || !GIT_MODES.has(gitMode))) return false;
  if (entryKind === undefined && gitMode === undefined) return {};
  if (entryKind === undefined) return { gitMode: gitMode as NonNullable<RepositoryPathContext["gitMode"]> };
  if (gitMode === undefined) return { entryKind: entryKind as NonNullable<RepositoryPathContext["entryKind"]> };
  return {
    entryKind: entryKind as NonNullable<RepositoryPathContext["entryKind"]>,
    gitMode: gitMode as NonNullable<RepositoryPathContext["gitMode"]>,
  };
}

function isRecord(input: SnapshotJsonValue): input is Readonly<Record<string, SnapshotJsonValue>> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function hasOnlyKeys(input: Readonly<Record<string, SnapshotJsonValue>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(input).every((key) => allowed.has(key));
}

function structureRejected(): RepositoryPathSetDecision {
  const decision: RepositoryPathSetDecision = {
    ok: false,
    violations: [{ code: "repository_path_set_structure_invalid" }],
    pathViolations: [],
    collisions: [],
  };
  return deepFreeze(decision);
}
