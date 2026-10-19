import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";

export const DATA_CLASSIFICATION = deepFreeze({
  public: "public",
  projectPrivate: "project-private",
  userPrivate: "user-private",
  credentialSecret: "credential-secret",
  regulatedRestricted: "regulated-restricted",
} as const);

export type DataClassification = typeof DATA_CLASSIFICATION[keyof typeof DATA_CLASSIFICATION];

/**
 * Tuple of every {@link DataClassification} value. Typed as a non-empty
 * readonly tuple so it can feed `z.enum(...)` without a cast.
 */
export const DATA_CLASSIFICATION_VALUES = deepFreeze(
  Object.values(DATA_CLASSIFICATION),
) as readonly [DataClassification, ...DataClassification[]];

export const CLASSIFICATION_CATALOG = deepFreeze([
  {
    id: DATA_CLASSIFICATION.public,
    rank: 0,
    configurableDefault: false,
    forensicId: "public",
  },
  {
    id: DATA_CLASSIFICATION.projectPrivate,
    rank: 1,
    configurableDefault: true,
    forensicId: "project-private",
  },
  {
    id: DATA_CLASSIFICATION.userPrivate,
    rank: 2,
    configurableDefault: true,
    forensicId: "sensitive",
  },
  {
    id: DATA_CLASSIFICATION.credentialSecret,
    rank: 4,
    configurableDefault: false,
    forensicId: "credential-secret",
  },
  {
    id: DATA_CLASSIFICATION.regulatedRestricted,
    rank: 3,
    configurableDefault: true,
    forensicId: "regulated-restricted",
  },
] as const);

export type ForensicClassification = typeof CLASSIFICATION_CATALOG[number]["forensicId"];

export const CONFIGURABLE_DEFAULT_CLASSIFICATIONS = deepFreeze(
  CLASSIFICATION_CATALOG.filter((entry) => entry.configurableDefault).map((entry) => entry.id),
);

export const FORENSIC_CLASSIFICATIONS = deepFreeze(
  CLASSIFICATION_CATALOG.map((entry) => entry.forensicId),
);

export function classificationRank(classification: DataClassification): number {
  const entry = CLASSIFICATION_CATALOG.find((candidate) => candidate.id === classification);
  if (entry === undefined) throw new InputError("data classification is not registered", "classification_not_registered");
  return entry.rank;
}

export function forensicClassification(classification: DataClassification): ForensicClassification {
  const entry = CLASSIFICATION_CATALOG.find((candidate) => candidate.id === classification);
  if (entry === undefined) throw new InputError("data classification is not registered", "classification_not_registered");
  return entry.forensicId;
}
