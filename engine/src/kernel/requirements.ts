import { z } from "zod";

import { InputError } from "./errors.ts";
import { canonicalHash, deepFreeze, sha256HexSchema } from "./integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "./json-integrity.ts";
import { secretLikeValuePaths } from "../privacy/secret-signals.ts";
import { schemaId } from "./product-identity.ts";

export const AUDIT_MATRIX_SCHEMA_VERSION = schemaId("audit-matrix", 1);
export const REQUIREMENTS_REGISTRY_SCHEMA_VERSION = schemaId("requirements", 1);
export const REQUIREMENTS_SCHEMA_ARTIFACT_VERSION = schemaId("requirements-schema", 1);

const HEX_SHA256 = sha256HexSchema;
const REQUIREMENT_ID = z.string().regex(/^REQ-[0-9]{3}$/u);
const USER_STATEMENT_ID = z.string().regex(/^USR-[0-9]{3}$/u);
const DERIVED_CONTROL_ID = z.string().regex(/^DER-[0-9]{3}$/u);
const DECISION_ID = z.string().regex(/^DEC-[A-Z0-9-]+$/u);
const NONEMPTY_TEXT = z.string().min(1);
const LINK = z.string().min(1);
const STATUS = z.enum([
  "unassessed",
  "not-started",
  "implemented",
  "user-authorized-deferred",
  "externally-blocked",
  "pending-user-decision",
]);
const SURFACE_ASSESSMENT_FIELDS = {
  applicability: z.enum(["applicable", "not-applicable"]),
  outcome: z.enum(["pass", "fail", "n/a", "unassessed"]),
  reason: NONEMPTY_TEXT,
  evidenceLinks: z.array(LINK),
} as const;
export const SURFACE_ASSESSMENTS_SCHEMA = z.strictObject({
  builder: z.strictObject({
    subjectRealm: z.literal("builder"),
    executionBoundary: z.literal("repository-build-and-maintenance"),
    ...SURFACE_ASSESSMENT_FIELDS,
  }),
  runtime: z.strictObject({
    subjectRealm: z.literal("runtime"),
    executionBoundary: z.literal("governed-project-execution"),
    ...SURFACE_ASSESSMENT_FIELDS,
  }),
});
export const AUDIT_MATRIX_ANGLES = deepFreeze([
  "alignment",
  "functionality",
  "architecture-and-layers",
  "dry-ssot-and-configuration",
  "data-and-migrations",
  "reliability-concurrency-and-recovery",
  "test-quality-and-false-green-resistance",
  "security-and-privacy",
  "performance-and-overhead",
  "ux-and-operator-error",
  "maintainability-dependencies-and-licenses",
  "extensibility",
  "neutrality",
  "observability-and-learning",
  "real-world-robustness",
] as const);
export const AUDIT_MATRIX_STAGES = deepFreeze([
  "author",
  "independent-source",
  "failure-mutation",
  "integration-and-recovery",
  "real-project",
  "performance-and-ux",
  "frozen-replay",
  "post-run",
] as const);
export const AUDIT_MATRIX_SCHEMA = z.strictObject({
  schemaVersion: z.literal(AUDIT_MATRIX_SCHEMA_VERSION),
  angles: z.array(z.strictObject({
    id: z.enum(AUDIT_MATRIX_ANGLES),
    surfaceAssessments: SURFACE_ASSESSMENTS_SCHEMA,
  })).length(AUDIT_MATRIX_ANGLES.length),
  stages: z.array(z.strictObject({
    id: z.enum(AUDIT_MATRIX_STAGES),
    surfaceAssessments: SURFACE_ASSESSMENTS_SCHEMA,
  })).length(AUDIT_MATRIX_STAGES.length),
  findingLifecycle: z.strictObject({
    requiredSequence: z.tuple([
      z.literal("finding"),
      z.literal("root-cause"),
      z.literal("permanent-regression"),
      z.literal("repair"),
      z.literal("recheck"),
    ]),
    findings: z.array(z.strictObject({
      id: NONEMPTY_TEXT,
      timelineLinks: z.array(LINK).min(5),
    })),
  }),
  independentAudit: z.strictObject({
    required: z.literal(true),
    selfHostedSufficient: z.literal(false),
    outcome: z.enum(["pass", "fail", "unassessed"]),
    reason: NONEMPTY_TEXT,
    evidenceLinks: z.array(LINK),
  }),
});
const REQUIREMENTS_REGISTRY_EXPECTED_COUNTS = deepFreeze({
  userStatements: 57,
  requirements: 35,
  derivedControls: 43,
  openDecisions: 1,
  globalAcceptanceGates: 42,
});
const CURRENT_APPEND_PROVENANCE = deepFreeze({
  userStatements: [
    { id: "USR-057", sourceLine: 1_589 },
  ],
  derivedControl: { id: "DER-043", sourceStartLine: 1_608, sourceEndLine: 1_616 },
  globalGate: { ordinal: 42, sourceLine: 1_618 },
});
const CURRENT_APPEND_PROJECTION_SHA256 =
  "bd1a5fc4c8f910115808ac6e18522c85428debac4386e02f9a2e874633a33e6a";
const PRIOR_056_APPEND_PROJECTION_SHA256 =
  "cc3c3f8c80c42a5bdb7199b6e82215554516997007051cd7bcfe2236448be182";
const PRIOR_055_APPEND_PROJECTION_SHA256 =
  "bbe7f92cd2fa403c6cba0b0cba280248b57801cd5d502ac21c01ec47e697d42a";
const PRIOR_054_APPEND_PROJECTION_SHA256 =
  "dd04b5b6c282fc23192a0255a20175c39e1da4d453e36f89b229d8cb0dde1517";
const PRIOR_053_APPEND_PROJECTION_SHA256 =
  "f9f816afc6be1975907ea8cb2ce6cd7060f61f355f4f440fbae7e1e0b166ddde";
const PRIOR_052_APPEND_PROJECTION_SHA256 =
  "fcbac2004152472e55ea12fa5e24b6c8324b49df45eab940068baecd11c6a14e";

const SOURCE_PROVENANCE = z.strictObject({
  sourceArtifactSha256: HEX_SHA256,
  sourceLine: z.number().int().positive(),
  sourcePointer: z.string().min(1),
  sourceKind: z.string().min(1),
});

const REQUIREMENT_PROVENANCE = SOURCE_PROVENANCE.extend({
  sourcePointer: REQUIREMENT_ID,
});

const USER_PROVENANCE = SOURCE_PROVENANCE.extend({
  sourcePointer: USER_STATEMENT_ID,
});

const DERIVED_PROVENANCE = z.strictObject({
  sourceArtifactSha256: HEX_SHA256,
  sourceStartLine: z.number().int().positive(),
  sourceEndLine: z.number().int().positive(),
  sourcePointer: DERIVED_CONTROL_ID,
  sourceKind: z.string().min(1),
});

const USER_STATEMENT_SCHEMA = z.strictObject({
  id: USER_STATEMENT_ID,
  kind: z.literal("user-source-intent"),
  sourceOrder: z.number().int().positive(),
  secretFreeNormalizedStatement: NONEMPTY_TEXT,
  boundRequirements: z.array(REQUIREMENT_ID).min(1),
  coverageStatus: STATUS,
  surfaceAssessments: SURFACE_ASSESSMENTS_SCHEMA,
  provenance: USER_PROVENANCE,
});

const REQUIREMENT_SCHEMA = z.strictObject({
  id: REQUIREMENT_ID,
  kind: z.literal("normative-requirement"),
  intent: NONEMPTY_TEXT,
  designAnchors: z.array(NONEMPTY_TEXT).min(1),
  acceptanceCriteria: z.array(NONEMPTY_TEXT).min(1),
  status: STATUS,
  surfaceAssessments: SURFACE_ASSESSMENTS_SCHEMA,
  implementationLinks: z.array(LINK),
  configOrInvariantLinks: z.array(LINK),
  testLinks: z.array(LINK),
  evidenceLinks: z.array(LINK),
  provenance: REQUIREMENT_PROVENANCE,
});

const DERIVED_CONTROL_SCHEMA = z.strictObject({
  id: DERIVED_CONTROL_ID,
  kind: z.literal("derived-evidence-control"),
  title: NONEMPTY_TEXT,
  bindingText: NONEMPTY_TEXT,
  boundRequirements: z.array(REQUIREMENT_ID).min(1),
  derivedControlDependencies: z.array(DERIVED_CONTROL_ID),
  controlStatements: z.array(NONEMPTY_TEXT).min(1),
  status: STATUS,
  surfaceAssessments: SURFACE_ASSESSMENTS_SCHEMA,
  implementationLinks: z.array(LINK),
  testLinks: z.array(LINK),
  evidenceLinks: z.array(LINK),
  provenance: DERIVED_PROVENANCE,
});

const OPEN_DECISION_SCHEMA = z.strictObject({
  id: DECISION_ID,
  status: z.literal("pending-user-decision"),
  boundRequirements: z.array(REQUIREMENT_ID).min(1),
  statement: NONEMPTY_TEXT,
  implementationLinks: z.array(LINK),
  testLinks: z.array(LINK),
  provenance: z.strictObject({
    sourceArtifactSha256: HEX_SHA256,
    sourceLine: z.number().int().positive(),
  }),
});

export const REQUIREMENTS_REGISTRY_SCHEMA = z.strictObject({
  schemaVersion: z.literal(REQUIREMENTS_REGISTRY_SCHEMA_VERSION),
  artifactRole: z.literal("canonical-requirements-and-traceability-ssot-draft"),
  authority: z.strictObject({
    requirementsAndSourceIntent: z.literal("authoritative-secret-free-normalized-capture"),
    implementationStatus: z.literal(
      "unassessed-until-repository-evidence-is-linked-and-independently-verified",
    ),
    sliceTraceability: z.literal("derived-projection-only"),
    statusMutationRule: z.literal(
      "no model or implementing agent may mark an item satisfied without linked acceptance evidence",
    ),
  }),
  sourceArtifact: z.strictObject({
    id: z.literal("bridlewise-requirements-governed-source"),
    sha256: HEX_SHA256,
    byteLength: z.number().int().positive(),
    lineCount: z.number().int().positive(),
    contentClass: z.literal("secret-free-normalized-requirements"),
    provenanceLocator: z.literal("traceability/canonical/harness-requirements.md"),
    note: NONEMPTY_TEXT,
  }),
  secretHandling: z.strictObject({
    literalCredentialsIncluded: z.literal(false),
    credentialValuesPersisted: z.literal(false),
    rule: NONEMPTY_TEXT,
  }),
  statusVocabulary: z.tuple([
    z.literal("unassessed"),
    z.literal("not-started"),
    z.literal("implemented"),
    z.literal("user-authorized-deferred"),
    z.literal("externally-blocked"),
    z.literal("pending-user-decision"),
  ]),
  openDecisions: z.array(OPEN_DECISION_SCHEMA),
  rowSetIntegrityHistory: z.strictObject({
    req001Through029Sha256: HEX_SHA256,
    usr001Through029Sha256: HEX_SHA256,
    req001Through030Sha256: HEX_SHA256,
    usr001Through030Sha256: HEX_SHA256,
    req001Through031Sha256: HEX_SHA256,
    usr001Through031Sha256: HEX_SHA256,
    req001Through032Sha256: HEX_SHA256,
    usr001Through032Sha256: HEX_SHA256,
    req001Through033Sha256: HEX_SHA256,
    usr001Through033Sha256: HEX_SHA256,
    req001Through034Sha256: HEX_SHA256,
    usr001Through034Sha256: HEX_SHA256,
    req001Through035Sha256: HEX_SHA256,
    usr001Through035Sha256: HEX_SHA256,
    usr001Through036Sha256: HEX_SHA256,
    usr001Through037Sha256: HEX_SHA256,
    usr001Through038Sha256: HEX_SHA256,
    usr001Through039Sha256: HEX_SHA256,
    usr001Through040Sha256: HEX_SHA256,
    usr001Through041Sha256: HEX_SHA256,
    usr001Through042Sha256: HEX_SHA256,
    usr001Through043Sha256: HEX_SHA256,
    usr001Through044Sha256: HEX_SHA256,
    usr001Through045Sha256: HEX_SHA256,
    usr001Through046Sha256: HEX_SHA256,
    usr001Through047Sha256: HEX_SHA256,
    usr001Through048Sha256: HEX_SHA256,
    usr001Through049Sha256: HEX_SHA256,
    usr001Through050Sha256: HEX_SHA256,
    usr001Through051Sha256: HEX_SHA256,
    usr001Through052Sha256: HEX_SHA256,
    usr001Through053Sha256: HEX_SHA256,
    usr001Through054Sha256: HEX_SHA256,
    usr001Through055Sha256: HEX_SHA256,
    usr001Through056Sha256: HEX_SHA256,
    usr001Through057Sha256: HEX_SHA256,
  }),
  counts: z.strictObject({
    userStatements: z.number().int().nonnegative(),
    requirements: z.number().int().nonnegative(),
    derivedControls: z.number().int().nonnegative(),
    openDecisions: z.number().int().nonnegative(),
    globalAcceptanceGates: z.number().int().nonnegative(),
  }),
  sectionIndex: z.array(z.strictObject({
    heading: NONEMPTY_TEXT,
    sourceLine: z.number().int().positive(),
  })).min(1),
  userStatements: z.array(USER_STATEMENT_SCHEMA).min(1),
  requirements: z.array(REQUIREMENT_SCHEMA).min(1),
  derivedControls: z.array(DERIVED_CONTROL_SCHEMA).min(1),
  globalAcceptanceGates: z.array(z.strictObject({
    sourceLine: z.number().int().positive(),
    statement: NONEMPTY_TEXT,
    surfaceAssessments: SURFACE_ASSESSMENTS_SCHEMA,
  })).min(1),
});

export type RequirementsRegistry = Readonly<z.infer<typeof REQUIREMENTS_REGISTRY_SCHEMA>>;
export type RequirementRegistryId =
  | z.infer<typeof REQUIREMENT_ID>
  | z.infer<typeof DERIVED_CONTROL_ID>;

export const REQUIREMENTS_REGISTRY_FILE_SHA256 =
  "d38bed088fdd7a2d62e61230782135c3ee3ef8111b4b3ccc7eb7284c99080553";
export const REQUIREMENTS_REGISTRY_SOURCE_SHA256 =
  "6e11948810734e09b100246ac169328e27908f08fa24265b476ec33602849495";
export const REQUIREMENTS_REGISTRY_SOURCE_PATH = "traceability/canonical/harness-requirements.md";
const REQUIREMENTS_REGISTRY_PRIOR_056_SOURCE_SHA256 =
  "41b1075de1f1e893c01d10f3ad6af3dcf04acd333fbb622c7f28c113d534d418";
const REQUIREMENTS_REGISTRY_PRIOR_055_SOURCE_SHA256 =
  "35bd2701580802428865118cd8dcfc73930eced3280eb19a19e1b1ce924663e1";
const REQUIREMENTS_REGISTRY_PRIOR_054_SOURCE_SHA256 =
  "fac97d718ad9a1dcb714128264b5b9f2a9d1d988a8de42bf63e6589b5459c353";
const REQUIREMENTS_REGISTRY_PRIOR_053_SOURCE_SHA256 =
  "876e1bb940517644eb1b414e035e27bad0d778a869c4053823affb6037b2f751";
const REQUIREMENTS_REGISTRY_PRIOR_052_SOURCE_SHA256 =
  "10df893f642c46e854c7ac97306a01461f85fa5db0ef2ee5c11f44d98e398e17";
const REQUIREMENTS_REGISTRY_PRIOR_050_SOURCE_SHA256 =
  "7194c4c86f212a0d24a128537fd40e3bc2e43271e6d8a6d00118056ac498838c";
const REQUIREMENTS_REGISTRY_PRIOR_049_SOURCE_SHA256 =
  "59cb1ee9f190e2b4ce2281f672a22553a2e55b1470c797baaf2b691f0cf99912";
const REQUIREMENTS_REGISTRY_PRIOR_048_SOURCE_SHA256 =
  "31bec161da7a6c3389242534f6ab9ce061abcce6473b405c3f1a414656b04a20";
const REQUIREMENTS_REGISTRY_PRIOR_047_SOURCE_SHA256 =
  "cf4956d73bc0b50505a52b654ae035679237f70de9d8e5860940d474295cbd83";
const REQUIREMENTS_REGISTRY_PRIOR_046_SOURCE_SHA256 =
  "9d56968f51145e56948e229d626c3901b8885d4ad96033fdf826d60ad1ad54c6";
const REQUIREMENTS_REGISTRY_PRIOR_045_SOURCE_SHA256 =
  "e669ff8d9dc4222cb58f78a9ecf29245c1f55624869ce0614516952716f9f8b6";
const REQUIREMENTS_REGISTRY_PRIOR_044_SOURCE_SHA256 =
  "1f18d26886310c5cad27950fa17bf64b9455d3ee631edc1175d12277a54f2789";
const REQUIREMENTS_REGISTRY_PRIOR_043_SOURCE_SHA256 =
  "b6153c9eb601ae936667a45b1c51ac9c60e244e5f99ecf4d5ba42f0a586fb266";
const REQUIREMENTS_REGISTRY_PRIOR_042_SOURCE_SHA256 =
  "849b5c6feadfa555a62dc60108de0df7800e92420ec05f696e5a3a8150046fb1";
const REQUIREMENTS_REGISTRY_PRIOR_041_SOURCE_SHA256 =
  "c42ad34c1ab4dc0ee3ea5aaf4b8f0d8bff421b375afc15663fa1a7efaa820f9e";
const REQUIREMENTS_REGISTRY_PRIOR_040_SOURCE_SHA256 =
  "5df7f89ba9bafeb687c64f0d43dc81c1f730d265bf0706e89293eadb0cac3613";
const REQUIREMENTS_REGISTRY_PRIOR_039_SOURCE_SHA256 =
  "8e115888da2ef000baf2fd07415d877fbd42af6647b7c695bcf26e03563c5a32";
const REQUIREMENTS_REGISTRY_PRIOR_038_SOURCE_SHA256 =
  "3f1464ef4312f0caeb23e68866265fcb582977c1c9366882eaa17a1624968c52";
const REQUIREMENTS_REGISTRY_PRIOR_035_SOURCE_SHA256 =
  "78b578607fcf4af35abc70f0b3af6204112bf6966a0c11d479950212aec4e49d";
const REQUIREMENTS_REGISTRY_PRIOR_034_SOURCE_SHA256 =
  "ea9020e2982bfdf1a1091abeb4c473e0d7ec6940accedb261f53fad9c69a74ef";
const REQUIREMENTS_REGISTRY_PREVIOUS_APPEND_SOURCE_SHA256 =
  "59ffcda1d433770c37d7201eeb244d23950a76ee7c606ba7db75db4b03f28a79";
const REQUIREMENTS_REGISTRY_BASE_SOURCE_SHA256 =
  "769663cd46b34d1c9936e2d353de97ce3bd4ee27e16425ee86e39fef94fe1204";
const REQUIREMENTS_SOURCE_BYTE_LENGTH = 356_996;
const REQUIREMENTS_SOURCE_LINE_COUNT = 1_628;
const REQUIREMENTS_PRIOR_056_SOURCE_LINE_COUNT = 1_585;
const REQUIREMENTS_PRIOR_055_SOURCE_LINE_COUNT = 1_541;
const REQUIREMENTS_PRIOR_054_SOURCE_LINE_COUNT = 1_499;
const REQUIREMENTS_PRIOR_053_SOURCE_LINE_COUNT = 1_459;
const REQUIREMENTS_PRIOR_052_SOURCE_LINE_COUNT = 1_417;
const REQUIREMENTS_PRIOR_050_SOURCE_LINE_COUNT = 1_362;
const REQUIREMENTS_PRIOR_049_SOURCE_LINE_COUNT = 1_297;
const REQUIREMENTS_PRIOR_048_SOURCE_LINE_COUNT = 1_254;
const REQUIREMENTS_PRIOR_047_SOURCE_LINE_COUNT = 1_202;
const REQUIREMENTS_PRIOR_046_SOURCE_LINE_COUNT = 1_142;
const REQUIREMENTS_PRIOR_045_SOURCE_LINE_COUNT = 1_111;
const REQUIREMENTS_PRIOR_044_SOURCE_LINE_COUNT = 1_077;
const REQUIREMENTS_PRIOR_043_SOURCE_LINE_COUNT = 1_042;
const REQUIREMENTS_PRIOR_042_SOURCE_LINE_COUNT = 1_007;
const REQUIREMENTS_PRIOR_041_SOURCE_LINE_COUNT = 971;
const REQUIREMENTS_PRIOR_040_SOURCE_LINE_COUNT = 946;
const REQUIREMENTS_PRIOR_039_SOURCE_LINE_COUNT = 920;
const REQUIREMENTS_PRIOR_038_SOURCE_LINE_COUNT = 895;
const REQUIREMENTS_PRIOR_035_SOURCE_LINE_COUNT = 833;
const REQUIREMENTS_PRIOR_034_SOURCE_LINE_COUNT = 789;
const REQUIREMENTS_PREVIOUS_APPEND_SOURCE_LINE_COUNT = 747;
const REQUIREMENTS_BASE_SOURCE_LINE_COUNT = 677;

export const REQUIREMENTS_REGISTRY_ROW_SET_HASHES = deepFreeze({
  req001Through029Sha256: "e786206c758fdfc9e0edbeaedad6907f2dc9d362506e3a419d7517d675fc9d51",
  usr001Through029Sha256: "4c20e7aa5096edb719a9e4672165a6779c37c01e46ae508a5bf050e29d8245d7",
  req001Through030Sha256: "5251a298f6031390b37438ce74c6dd7aeb76d0ee8fe39d630180f9e74315cbf1",
  usr001Through030Sha256: "1cf974356532feef15b4283ce4c87723d8160fa92bdddafdc868247fb3b91349",
  req001Through031Sha256: "333298a914ab55fdd84b674acc5ac56b1a2a44e9c53f41887237c0d851101a56",
  usr001Through031Sha256: "e51c7de4cd66dfb070eb1e2aa373f6727c5856064ef3cf3db41eee30b07fd9ed",
  req001Through032Sha256: "97286f036808735df1ad73fed596af9c7857f93b5e275dc97bfb5fd915d4fb1f",
  usr001Through032Sha256: "a1c847c82559986a1c1ca65f7fbea6c598af401b322862202a7c1139a7c69568",
  req001Through033Sha256: "60b6204db2bfd417854fde25c3198ce810d126b57a1286c6f3d3d33f8f25cd64",
  usr001Through033Sha256: "81ff338e2d9a40b344b1c5cc8a54c274c5d707ea3e1a77bcf975e9198bc5c737",
  req001Through034Sha256: "564ed0c75c7acfbd6668c492ed0d4963901e1f714336afc95fab72e4789c7f6b",
  usr001Through034Sha256: "312d7ca9ee1782b9cda5390f1487e7edbd55e29cc446beb766e9eaca2fa1b9e5",
  req001Through035Sha256: "243083aef46a366ebebe1a353d16bf84b676c3f521ea256fb3e1120e5877706e",
  usr001Through035Sha256: "e4f74b6f8b264b77f9b62588b4d7642861b1bb19ea6260912c00b379414bc69a",
  usr001Through036Sha256: "838ea92742d79d601dfc0462cf92c069bc4970d0921cf1dca54c467a5c481146",
  usr001Through037Sha256: "5ab964b75e0d72d4abe44f0cdca48b973fe1d2d87d4e9ab04f7dd2f7a9f4811f",
  usr001Through038Sha256: "772590863981c149d3b694c628427882d18239d9ae349ac485c2f10ff31ad6b2",
  usr001Through039Sha256: "9e5cfa5a38d9fb67f207dfe4aebcefdeb6707e63abe3e97c07b9eddf03423599",
  usr001Through040Sha256: "c73b306d7423c49d80cff0203cd1c8bb14509471d7d7973a51f448cafdf08ab5",
  usr001Through041Sha256: "6ae040ff660db0550855825b8ec964ee7ebe15a37452caba094845602a6d86db",
  usr001Through042Sha256: "25ba19bfdfdf8b87f226aa9296512bf4af6e0edf43cd2a2c4e867e9b4541bde5",
  usr001Through043Sha256: "f674ae85814df6ecab9569d52449e7744cf36ca1525007f75b48d128d9af8373",
  usr001Through044Sha256: "6a21d3647bc43b6a56637b93c8b9a47c18a90b3f20e4162c99333f0ce5a7bb86",
  usr001Through045Sha256: "b92b96c9feb3914242c97f6c66cc18e9a885c34b7d563cf2047d02da555b15a7",
  usr001Through046Sha256: "ed03a4cd579cc8aeb049fc85cb61e6effebf99e736929f79ea6a68f490b734ff",
  usr001Through047Sha256: "ec0d25617061d2a97d979ca2aa24457a3b75b87e7d88c1d2956e569bebc06fe8",
  usr001Through048Sha256: "b0d281a6e09fabd21cceae35e2d0521a8bd84747dd655ebed7f80825e1aeeff0",
  usr001Through049Sha256: "fe9ffdab36ae6a953f6c02f6c89824d094373379470baa37b71278d06b46cd10",
  usr001Through050Sha256: "c3f86e5932384746fe68eb609b4ea97c8ea3dc502c65808ae69a39d0690f7613",
  usr001Through051Sha256: "2fc780572bcf79ce123708ef94c341500d69f43e6ad211679501c48f53d6eefc",
  usr001Through052Sha256: "6c7bb5f6c2ce0937f27c26394dda352715b5f240e2c2a33b4a6bc62a36dc417d",
  usr001Through053Sha256: "28593e942befe26cec3d2f8090f31096f2889029c8690e7c7b599c5db42dd6e8",
  usr001Through054Sha256: "1793e1b54c9859ce628bf3e3bfd45ff72f77c28ef5d25c87846055fcafd61298",
  usr001Through055Sha256: "6c148d5798defebee96463f787ca4d7093db6c06739348ecee32e5fec05c7ae5",
  usr001Through056Sha256: "0a4f295727745012409d8cb880a5a24b395b9a73e99c4768dbaa55cb0054a734",
  usr001Through057Sha256: "4e30c5dc2326c52f1db44c33d68a2e7f74337dc30d64328ec5595cf8e2d91b40",
});

export const GENERATED_REQUIREMENTS_REGISTRY_SCHEMA = deepFreeze(z.toJSONSchema(
  REQUIREMENTS_REGISTRY_SCHEMA,
  {
    target: "draft-2020-12",
    unrepresentable: "throw",
    cycles: "ref",
    reused: "ref",
  },
));
export const REQUIREMENTS_REGISTRY_SCHEMA_HASH = canonicalHash(GENERATED_REQUIREMENTS_REGISTRY_SCHEMA);
export const REQUIREMENTS_REGISTRY_VALIDATOR_REVISION = "requirements-registry-validator/v17";

export const REQUIREMENTS_REGISTRY_IDENTITY = deepFreeze({
  schemaVersion: REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
  validatorRevision: REQUIREMENTS_REGISTRY_VALIDATOR_REVISION,
  registryFile: "traceability/requirements.json",
  registryFileSha256: REQUIREMENTS_REGISTRY_FILE_SHA256,
  sourceArtifactPath: REQUIREMENTS_REGISTRY_SOURCE_PATH,
  sourceArtifactSha256: REQUIREMENTS_REGISTRY_SOURCE_SHA256,
  rowSetHashes: REQUIREMENTS_REGISTRY_ROW_SET_HASHES,
  schemaHash: REQUIREMENTS_REGISTRY_SCHEMA_HASH,
});
export const REQUIREMENTS_REGISTRY_IDENTITY_HASH = canonicalHash(REQUIREMENTS_REGISTRY_IDENTITY);

const REQUIREMENTS_ROOT_BINDING_SCHEMA = z.strictObject({
  registrySchemaVersion: z.literal(REQUIREMENTS_REGISTRY_SCHEMA_VERSION),
  registryFile: z.literal("traceability/requirements.json"),
  registryFileSha256: HEX_SHA256,
  registrySchemaHash: HEX_SHA256,
  registryIdentityHash: HEX_SHA256,
  sourceArtifact: z.literal("traceability/canonical/harness-requirements.md"),
  applicableIds: z.array(z.union([REQUIREMENT_ID, DERIVED_CONTROL_ID])),
});

export function requirementsRootBindingViolations(value: unknown): readonly string[] {
  const parsed = REQUIREMENTS_ROOT_BINDING_SCHEMA.safeParse(value);
  if (!parsed.success) return ["requirements_registry_root_binding_invalid"];
  const { applicableIds, ...binding } = parsed.data;
  const expected = {
    registrySchemaVersion: REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
    registryFile: "traceability/requirements.json",
    registryFileSha256: REQUIREMENTS_REGISTRY_FILE_SHA256,
    registrySchemaHash: REQUIREMENTS_REGISTRY_SCHEMA_HASH,
    registryIdentityHash: REQUIREMENTS_REGISTRY_IDENTITY_HASH,
    sourceArtifact: REQUIREMENTS_REGISTRY_SOURCE_PATH,
  };
  const violations: string[] = [];
  if (canonicalHash(binding) !== canonicalHash(expected)) {
    violations.push("requirements_registry_root_binding_mismatch");
  }
  if (new Set(applicableIds).size !== applicableIds.length) {
    violations.push("requirements_registry_root_binding_duplicate_reference");
  }
  return violations;
}

export function parseRequirementsRegistryText(text: string): RequirementsRegistry {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Requirements registry contains a duplicate key",
    "requirements_registry_key_duplicate",
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError("Requirements registry must be valid JSON", "requirements_registry_json_invalid");
  }
  return parseRequirementsRegistry(value);
}

export function parseRequirementsRegistry(value: unknown): RequirementsRegistry {
  const parsed = REQUIREMENTS_REGISTRY_SCHEMA.safeParse(value);
  if (!parsed.success) {
    throw new InputError(
      "Requirements registry does not match its canonical schema",
      "requirements_registry_schema_invalid",
    );
  }
  const violations = validateRegistrySemantics(parsed.data);
  if (violations.length > 0) {
    throw new InputError(
      "Requirements registry violates canonical invariants",
      violations[0]!,
    );
  }
  return deepFreeze(parsed.data);
}

export function requirementsRegistryViolations(value: unknown): readonly string[] {
  const parsed = REQUIREMENTS_REGISTRY_SCHEMA.safeParse(value);
  if (!parsed.success) return ["requirements_registry_schema_invalid"];
  return validateRegistrySemantics(parsed.data);
}

export function requirementRegistryIds(
  registry: RequirementsRegistry,
  references?: Iterable<string>,
): ReadonlySet<RequirementRegistryId> {
  const orderedIds: readonly RequirementRegistryId[] = [
    ...registry.requirements.map((entry) => entry.id),
    ...registry.derivedControls.map((entry) => entry.id),
  ];
  if (references === undefined) return new Set<RequirementRegistryId>(orderedIds);

  const knownIds = new Set<RequirementRegistryId>(orderedIds);
  const selectedIds = new Set<RequirementRegistryId>();
  for (const reference of references) {
    if (!knownIds.has(reference as RequirementRegistryId)) {
      throw new InputError(
        "Requirement projection contains an unknown registry reference",
        "requirements_registry_projection_unknown_reference",
      );
    }
    selectedIds.add(reference as RequirementRegistryId);
  }
  return new Set<RequirementRegistryId>(orderedIds.filter((id) => selectedIds.has(id)));
}

export type RequirementApplicabilityProjection = Readonly<{
  orderedIds: readonly RequirementRegistryId[];
  requirementIds: readonly RequirementRegistryId[];
  derivedControlIds: readonly RequirementRegistryId[];
}>;

export function requirementApplicabilityProjection(
  registry: RequirementsRegistry,
  references: Iterable<string>,
): RequirementApplicabilityProjection {
  const orderedIds = [...requirementRegistryIds(registry, references)];
  const requirementIds = orderedIds.filter((id) => id.startsWith("REQ-"));
  const derivedControlIds = orderedIds.filter((id) => id.startsWith("DER-"));
  return deepFreeze({ orderedIds, requirementIds, derivedControlIds });
}

function validateRegistrySemantics(
  registry: z.infer<typeof REQUIREMENTS_REGISTRY_SCHEMA>,
): readonly string[] {
  const violations: string[] = [];
  const requirementIds = new Set<string>();
  const userIds = new Set<string>();
  const derivedIds = new Set<string>();
  const decisionIds = new Set<string>();

  collectUnique(registry.requirements.map((entry) => entry.id), requirementIds, "requirement", violations);
  collectUnique(registry.userStatements.map((entry) => entry.id), userIds, "user-statement", violations);
  collectUnique(registry.derivedControls.map((entry) => entry.id), derivedIds, "derived-control", violations);
  collectUnique(registry.openDecisions.map((entry) => entry.id), decisionIds, "decision", violations);

  if (registry.sourceArtifact.sha256 !== REQUIREMENTS_REGISTRY_SOURCE_SHA256) {
    violations.push("requirements_registry_source_hash_drift");
  }
  if (registry.sourceArtifact.byteLength !== REQUIREMENTS_SOURCE_BYTE_LENGTH ||
    registry.sourceArtifact.lineCount !== REQUIREMENTS_SOURCE_LINE_COUNT) {
    violations.push("requirements_registry_source_metadata_drift");
  }
  if (canonicalHash(registry.rowSetIntegrityHistory) !==
    canonicalHash(REQUIREMENTS_REGISTRY_ROW_SET_HASHES)) {
    violations.push("requirements_registry_row_hash_drift");
  }
  const observedCounts = {
    userStatements: registry.userStatements.length,
    requirements: registry.requirements.length,
    derivedControls: registry.derivedControls.length,
    openDecisions: registry.openDecisions.length,
    globalAcceptanceGates: registry.globalAcceptanceGates.length,
  };
  if (canonicalHash(registry.counts) !== canonicalHash(REQUIREMENTS_REGISTRY_EXPECTED_COUNTS) ||
    canonicalHash(observedCounts) !== canonicalHash(REQUIREMENTS_REGISTRY_EXPECTED_COUNTS)) {
    violations.push("requirements_registry_count_drift");
  }
  const currentAppendProjection = {
    userStatements: CURRENT_APPEND_PROVENANCE.userStatements.map((expected) =>
      registry.userStatements.find((entry) => entry.id === expected.id)),
    derivedControl: registry.derivedControls.find((entry) =>
      entry.id === CURRENT_APPEND_PROVENANCE.derivedControl.id),
    globalGate: registry.globalAcceptanceGates[CURRENT_APPEND_PROVENANCE.globalGate.ordinal - 1],
  };
  if (canonicalHash(currentAppendProjection) !== CURRENT_APPEND_PROJECTION_SHA256) {
    violations.push("requirements_registry_current_append_projection_drift");
  }
  const prior056AppendProjection = {
    userStatements: ["USR-056"].map((id) =>
      registry.userStatements.find((entry) => entry.id === id)),
    derivedControl: registry.derivedControls.find((entry) => entry.id === "DER-042"),
    globalGate: registry.globalAcceptanceGates[40],
  };
  if (canonicalHash(prior056AppendProjection) !== PRIOR_056_APPEND_PROJECTION_SHA256) {
    violations.push("requirements_registry_prior_056_projection_drift");
  }
  const prior055AppendProjection = {
    userStatements: ["USR-055"].map((id) =>
      registry.userStatements.find((entry) => entry.id === id)),
    derivedControl: registry.derivedControls.find((entry) => entry.id === "DER-041"),
    globalGate: registry.globalAcceptanceGates[39],
  };
  if (canonicalHash(prior055AppendProjection) !== PRIOR_055_APPEND_PROJECTION_SHA256) {
    violations.push("requirements_registry_prior_055_projection_drift");
  }
  const prior054AppendProjection = {
    userStatements: ["USR-054"].map((id) =>
      registry.userStatements.find((entry) => entry.id === id)),
    derivedControl: registry.derivedControls.find((entry) => entry.id === "DER-040"),
    globalGate: registry.globalAcceptanceGates[38],
  };
  if (canonicalHash(prior054AppendProjection) !== PRIOR_054_APPEND_PROJECTION_SHA256) {
    violations.push("requirements_registry_prior_054_projection_drift");
  }
  const prior053AppendProjection = {
    userStatements: ["USR-053"].map((id) =>
      registry.userStatements.find((entry) => entry.id === id)),
    derivedControl: registry.derivedControls.find((entry) => entry.id === "DER-039"),
    globalGate: registry.globalAcceptanceGates[37],
  };
  if (canonicalHash(prior053AppendProjection) !== PRIOR_053_APPEND_PROJECTION_SHA256) {
    violations.push("requirements_registry_prior_053_projection_drift");
  }
  const prior052AppendProjection = {
    userStatements: ["USR-051", "USR-052"].map((id) =>
      registry.userStatements.find((entry) => entry.id === id)),
    derivedControl: registry.derivedControls.find((entry) => entry.id === "DER-038"),
    globalGate: registry.globalAcceptanceGates[36],
  };
  if (canonicalHash(prior052AppendProjection) !== PRIOR_052_APPEND_PROJECTION_SHA256) {
    violations.push("requirements_registry_prior_052_projection_drift");
  }

  if (!hasContiguousIds(registry.userStatements.map((entry) => entry.id), "USR", 57) ||
    !hasContiguousIds(registry.requirements.map((entry) => entry.id), "REQ", 35) ||
    !hasContiguousIds(registry.derivedControls.map((entry) => entry.id), "DER", 43)) {
    violations.push("requirements_registry_id_sequence_invalid");
  }

  const alignmentStatements = registry.userStatements.filter((entry) => entry.id === "USR-049");
  const alignmentControls = registry.derivedControls.filter((entry) => entry.id === "DER-036");
  const alignmentText = alignmentStatements[0]?.secretFreeNormalizedStatement ?? "";
  const alignmentCountDependent = /\b(?:twice|second\s+(?:message|reaffirmation)|both\s+source\s+events|two\s+reaffirmations?|[0-9]+\s+reaffirmations?)\b/iu;
  if (alignmentStatements.length !== 1 || alignmentControls.length !== 1 ||
    !alignmentText.includes("Every equivalent reaffirmation is retained as a distinct, ordered, independently addressable runtime-ledger source event with its own identity") ||
    !alignmentText.includes("one non-duplicated semantic authority row regardless of how many reaffirmations occur") ||
    alignmentCountDependent.test(alignmentText)) {
    violations.push("requirements_registry_alignment_reaffirmation_projection_drift");
  }

  const sourceOrders = registry.userStatements.map((entry) => entry.sourceOrder);
  if (sourceOrders.some((order, index) => order !== index + 1)) {
    violations.push("requirements_registry_user_order_invalid");
  }
  const statementBoundRequirements = new Set<string>();
  for (const statement of registry.userStatements) {
    const sourceEpoch = expectedProvenanceSourceEpoch(statement.id);
    const currentProvenance = CURRENT_APPEND_PROVENANCE.userStatements.find((entry) =>
      entry.id === statement.id);
    const currentLineMismatch = currentProvenance !== undefined &&
      statement.provenance.sourceLine !== currentProvenance.sourceLine;
    if (statement.provenance.sourcePointer !== statement.id ||
      statement.provenance.sourceArtifactSha256 !== sourceEpoch.sha256 ||
      statement.provenance.sourceLine < sourceEpoch.minimumLine ||
      statement.provenance.sourceLine > sourceEpoch.maximumLine || currentLineMismatch) {
      violations.push("requirements_registry_provenance_invalid:" + statement.id);
    }
    collectReferenceSet(
      statement.boundRequirements,
      requirementIds,
      "user-statement:" + statement.id,
      statementBoundRequirements,
      violations,
    );
    validateSurfaceAssessments(statement.surfaceAssessments, statement.coverageStatus, statement.id, violations);
    if (statement.coverageStatus === "implemented" &&
      statement.boundRequirements.some((id) =>
        registry.requirements.find((entry) => entry.id === id)?.status !== "implemented")) {
      violations.push("requirements_registry_false_user_coverage:" + statement.id);
    }
  }

  for (const requirement of registry.requirements) {
    const sourceEpoch = expectedProvenanceSourceEpoch(requirement.id);
    if (requirement.provenance.sourcePointer !== requirement.id ||
      requirement.provenance.sourceArtifactSha256 !== sourceEpoch.sha256 ||
      requirement.provenance.sourceLine < sourceEpoch.minimumLine ||
      requirement.provenance.sourceLine > sourceEpoch.maximumLine) {
      violations.push("requirements_registry_provenance_invalid:" + requirement.id);
    }
    if (!statementBoundRequirements.has(requirement.id) && requirement.status !== "unassessed") {
      violations.push("requirements_registry_orphan_requirement:" + requirement.id);
    }
    if (requirement.status === "implemented" &&
      (requirement.implementationLinks.length === 0 ||
        requirement.configOrInvariantLinks.length === 0 ||
        requirement.testLinks.length === 0 ||
        requirement.evidenceLinks.length === 0)) {
      violations.push("requirements_registry_false_satisfied:" + requirement.id);
    }
    validateSurfaceAssessments(
      requirement.surfaceAssessments,
      requirement.status,
      requirement.id,
      violations,
      requirement.evidenceLinks,
    );
    collectNoDuplicates(requirement.designAnchors, "design-anchor:" + requirement.id, violations);
    collectNoDuplicates(requirement.implementationLinks, "implementation-link:" + requirement.id, violations);
    collectNoDuplicates(requirement.configOrInvariantLinks, "authority-link:" + requirement.id, violations);
    collectNoDuplicates(requirement.testLinks, "test-link:" + requirement.id, violations);
    collectNoDuplicates(requirement.evidenceLinks, "evidence-link:" + requirement.id, violations);
  }

  for (const control of registry.derivedControls) {
    const sourceEpoch = expectedProvenanceSourceEpoch(control.id);
    const currentRangeMismatch = control.id === CURRENT_APPEND_PROVENANCE.derivedControl.id &&
      (control.provenance.sourceStartLine !== CURRENT_APPEND_PROVENANCE.derivedControl.sourceStartLine ||
        control.provenance.sourceEndLine !== CURRENT_APPEND_PROVENANCE.derivedControl.sourceEndLine);
    if (control.provenance.sourcePointer !== control.id ||
      control.provenance.sourceArtifactSha256 !== sourceEpoch.sha256 ||
      control.provenance.sourceEndLine < control.provenance.sourceStartLine ||
      control.provenance.sourceStartLine < sourceEpoch.minimumLine ||
      control.provenance.sourceEndLine > sourceEpoch.maximumLine || currentRangeMismatch) {
      violations.push("requirements_registry_provenance_invalid:" + control.id);
    }
    collectReferenceSet(
      control.boundRequirements,
      requirementIds,
      "derived-control:" + control.id,
      undefined,
      violations,
    );
    collectReferenceSet(
      control.derivedControlDependencies,
      derivedIds,
      "derived-dependency:" + control.id,
      undefined,
      violations,
    );
    if (control.derivedControlDependencies.includes(control.id)) {
      violations.push("requirements_registry_self_reference:" + control.id);
    }
    if (control.status === "implemented" &&
      (control.implementationLinks.length === 0 ||
        control.testLinks.length === 0 ||
        control.evidenceLinks.length === 0)) {
      violations.push("requirements_registry_false_satisfied:" + control.id);
    }
    validateSurfaceAssessments(
      control.surfaceAssessments,
      control.status,
      control.id,
      violations,
      control.evidenceLinks,
    );
  }

  for (const decision of registry.openDecisions) {
    if (decision.provenance.sourceArtifactSha256 !== REQUIREMENTS_REGISTRY_BASE_SOURCE_SHA256 ||
      decision.provenance.sourceLine > REQUIREMENTS_BASE_SOURCE_LINE_COUNT) {
      violations.push("requirements_registry_provenance_invalid:" + decision.id);
    }
    collectReferenceSet(
      decision.boundRequirements,
      requirementIds,
      "decision:" + decision.id,
      undefined,
      violations,
    );
  }

  if (registry.sectionIndex.some((entry, index) =>
    entry.sourceLine > REQUIREMENTS_SOURCE_LINE_COUNT ||
    (index > 0 && entry.sourceLine <= registry.sectionIndex[index - 1]!.sourceLine))) {
    violations.push("requirements_registry_section_index_invalid");
  }
  if (registry.globalAcceptanceGates.some((entry, index) =>
    entry.sourceLine > REQUIREMENTS_SOURCE_LINE_COUNT ||
    (index > 0 && entry.sourceLine <= registry.globalAcceptanceGates[index - 1]!.sourceLine))) {
    violations.push("requirements_registry_acceptance_index_invalid");
  }
  registry.globalAcceptanceGates.forEach((gate, index) => {
    const ordinal = index + 1;
    if (ordinal === CURRENT_APPEND_PROVENANCE.globalGate.ordinal &&
      gate.sourceLine !== CURRENT_APPEND_PROVENANCE.globalGate.sourceLine) {
      violations.push(`requirements_registry_acceptance_provenance_invalid:GATE-${ordinal}`);
    }
    if ([gate.surfaceAssessments.builder, gate.surfaceAssessments.runtime]
      .some((assessment) => assessment.outcome === "pass")) {
      violations.push(`requirements_registry_false_gate_satisfied:GATE-${ordinal}`);
    }
    validateSurfaceAssessments(gate.surfaceAssessments, "unassessed", `GATE-${ordinal}`, violations);
  });

  for (const secretPath of secretLikeValuePaths(registry, "admission")) {
    violations.push("requirements_registry_secret_like_value:" + secretPath);
  }
  return [...new Set(violations)].toSorted();
}

function expectedProvenanceSourceEpoch(pointer: string): Readonly<{
  sha256: string;
  minimumLine: number;
  maximumLine: number;
}> {
  const sequence = Number(pointer.slice(4));
  const current = pointer === "DER-043" || pointer.startsWith("USR-") && sequence >= 57;
  if (current) {
    return {
      sha256: REQUIREMENTS_REGISTRY_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_608 : 1_587,
      maximumLine: REQUIREMENTS_SOURCE_LINE_COUNT,
    };
  }
  const prior056 = pointer === "DER-042" || pointer.startsWith("USR-") && sequence >= 56;
  if (prior056) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_056_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_565 : 1_543,
      maximumLine: REQUIREMENTS_PRIOR_056_SOURCE_LINE_COUNT,
    };
  }
  const prior055 = pointer === "DER-041" || pointer.startsWith("USR-") && sequence >= 55;
  if (prior055) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_055_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_523 : 1_501,
      maximumLine: REQUIREMENTS_PRIOR_055_SOURCE_LINE_COUNT,
    };
  }
  const prior054 = pointer === "DER-040" || pointer.startsWith("USR-") && sequence >= 54;
  if (prior054) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_054_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_480 : 1_461,
      maximumLine: REQUIREMENTS_PRIOR_054_SOURCE_LINE_COUNT,
    };
  }
  const prior053 = pointer === "DER-039" || pointer.startsWith("USR-") && sequence >= 53;
  if (prior053) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_053_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_440 : 1_419,
      maximumLine: REQUIREMENTS_PRIOR_053_SOURCE_LINE_COUNT,
    };
  }
  const prior052 = pointer === "DER-038" || pointer.startsWith("USR-") && sequence >= 51;
  if (prior052) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_052_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_397 : 1_364,
      maximumLine: REQUIREMENTS_PRIOR_052_SOURCE_LINE_COUNT,
    };
  }
  const prior050 = pointer === "DER-037" || pointer.startsWith("USR-") && sequence >= 50;
  if (prior050) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_050_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_341 : 1_299,
      maximumLine: REQUIREMENTS_PRIOR_050_SOURCE_LINE_COUNT,
    };
  }
  const prior049 = pointer === "DER-036" || pointer.startsWith("USR-") && sequence >= 49;
  if (prior049) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_049_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? 1_278 : 1_256,
      maximumLine: REQUIREMENTS_PRIOR_049_SOURCE_LINE_COUNT,
    };
  }
  const prior048 = ["DER-034", "DER-035"].includes(pointer) ||
    pointer.startsWith("USR-") && sequence >= 48;
  if (prior048) {
    const derivedMinimum = pointer === "DER-034" ? 1_224 : 1_232;
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_048_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? derivedMinimum : 1_204,
      maximumLine: REQUIREMENTS_PRIOR_048_SOURCE_LINE_COUNT,
    };
  }
  const prior047 = ["DER-031", "DER-032", "DER-033"].includes(pointer) ||
    pointer.startsWith("USR-") && sequence >= 47;
  if (prior047) {
    const derivedMinimum = pointer === "DER-031" ? 1_160 : pointer === "DER-032" ? 1_168 : 1_176;
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_047_SOURCE_SHA256,
      minimumLine: pointer.startsWith("DER-") ? derivedMinimum : 1_144,
      maximumLine: REQUIREMENTS_PRIOR_047_SOURCE_LINE_COUNT,
    };
  }
  const prior046 = pointer === "DER-028" || pointer.startsWith("USR-") && sequence >= 46;
  if (prior046) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_046_SOURCE_SHA256,
      minimumLine: pointer === "DER-028" ? 987 : 1_113,
      maximumLine: REQUIREMENTS_PRIOR_046_SOURCE_LINE_COUNT,
    };
  }
  const prior045 = pointer === "DER-030" || pointer.startsWith("USR-") && sequence >= 45;
  if (prior045) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_045_SOURCE_SHA256,
      minimumLine: pointer === "DER-030" ? 1_056 : 1_079,
      maximumLine: REQUIREMENTS_PRIOR_045_SOURCE_LINE_COUNT,
    };
  }
  const prior044 = pointer.startsWith("USR-") && sequence >= 44;
  if (prior044) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_044_SOURCE_SHA256,
      minimumLine: 1_044,
      maximumLine: REQUIREMENTS_PRIOR_044_SOURCE_LINE_COUNT,
    };
  }
  const prior043 = pointer === "DER-029" || pointer.startsWith("USR-") && sequence >= 43;
  if (prior043) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_043_SOURCE_SHA256,
      minimumLine: pointer === "DER-029" ? 1021 : 1009,
      maximumLine: REQUIREMENTS_PRIOR_043_SOURCE_LINE_COUNT,
    };
  }
  const prior042 = pointer.startsWith("USR-") && sequence >= 42;
  if (prior042) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_042_SOURCE_SHA256,
      minimumLine: 973,
      maximumLine: REQUIREMENTS_PRIOR_042_SOURCE_LINE_COUNT,
    };
  }
  const prior041 = pointer === "DER-025" || pointer.startsWith("USR-") && sequence >= 41;
  if (prior041) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_041_SOURCE_SHA256,
      minimumLine: pointer === "DER-025" ? 841 : 948,
      maximumLine: REQUIREMENTS_PRIOR_041_SOURCE_LINE_COUNT,
    };
  }
  const prior040 = pointer === "DER-027" || pointer.startsWith("USR-") && sequence >= 40;
  if (prior040) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_040_SOURCE_SHA256,
      minimumLine: 922,
      maximumLine: REQUIREMENTS_PRIOR_040_SOURCE_LINE_COUNT,
    };
  }
  const prior039 = pointer.startsWith("DER-") ? sequence >= 26 : sequence >= 39;
  if (prior039) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_039_SOURCE_SHA256,
      minimumLine: 873,
      maximumLine: REQUIREMENTS_PRIOR_039_SOURCE_LINE_COUNT,
    };
  }
  const prior038 = pointer.startsWith("DER-") ? sequence >= 25 : sequence >= 36;
  if (prior038) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_038_SOURCE_SHA256,
      minimumLine: 835,
      maximumLine: REQUIREMENTS_PRIOR_038_SOURCE_LINE_COUNT,
    };
  }
  const prior035 = pointer.startsWith("DER-") ? sequence >= 24 : sequence >= 35;
  if (prior035) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_035_SOURCE_SHA256,
      minimumLine: 791,
      maximumLine: REQUIREMENTS_PRIOR_035_SOURCE_LINE_COUNT,
    };
  }
  const prior034 = pointer.startsWith("DER-") ? sequence >= 23 : sequence >= 34;
  if (prior034) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PRIOR_034_SOURCE_SHA256,
      minimumLine: 749,
      maximumLine: REQUIREMENTS_PRIOR_034_SOURCE_LINE_COUNT,
    };
  }
  const previousAppend = pointer.startsWith("DER-") ? sequence >= 21 : sequence >= 32;
  if (previousAppend) {
    return {
      sha256: REQUIREMENTS_REGISTRY_PREVIOUS_APPEND_SOURCE_SHA256,
      minimumLine: 679,
      maximumLine: REQUIREMENTS_PREVIOUS_APPEND_SOURCE_LINE_COUNT,
    };
  }
  return {
    sha256: REQUIREMENTS_REGISTRY_BASE_SOURCE_SHA256,
    minimumLine: 1,
    maximumLine: REQUIREMENTS_BASE_SOURCE_LINE_COUNT,
  };
}

function collectUnique(
  ids: readonly string[],
  target: Set<string>,
  label: string,
  violations: string[],
): void {
  for (const id of ids) {
    if (target.has(id)) violations.push("requirements_registry_duplicate_" + label + ":" + id);
    target.add(id);
  }
}

function hasContiguousIds(ids: readonly string[], prefix: "USR" | "REQ" | "DER", count: number): boolean {
  return ids.length === count && ids.every((id, index) =>
    id === `${prefix}-${String(index + 1).padStart(3, "0")}`);
}

function collectReferenceSet(
  references: readonly string[],
  known: ReadonlySet<string>,
  label: string,
  collected: Set<string> | undefined,
  violations: string[],
): void {
  collectNoDuplicates(references, label, violations);
  for (const reference of references) {
    if (!known.has(reference)) violations.push("requirements_registry_unknown_reference:" + label + ":" + reference);
    collected?.add(reference);
  }
}

function collectNoDuplicates(
  values: readonly string[],
  label: string,
  violations: string[],
): void {
  if (new Set(values).size !== values.length) {
    violations.push("requirements_registry_duplicate_reference:" + label);
  }
}

function validateSurfaceAssessments(
  assessments: z.infer<typeof SURFACE_ASSESSMENTS_SCHEMA>,
  status: z.infer<typeof STATUS>,
  id: string,
  violations: string[],
  canonicalEvidenceLinks?: readonly string[],
): void {
  for (const [surface, assessment] of Object.entries(assessments) as Array<
    ["builder" | "runtime", z.infer<typeof SURFACE_ASSESSMENTS_SCHEMA>["builder" | "runtime"]]
  >) {
    const notApplicable = assessment.applicability === "not-applicable";
    if (notApplicable !== (assessment.outcome === "n/a")) {
      violations.push(`requirements_registry_surface_applicability:${id}:${surface}`);
    }
    if (assessment.outcome !== "unassessed" && assessment.evidenceLinks.length === 0) {
      violations.push(`requirements_registry_surface_evidence_missing:${id}:${surface}`);
    }
    if (canonicalEvidenceLinks && assessment.evidenceLinks.some((evidenceLink) =>
      !canonicalEvidenceLinks.includes(evidenceLink))) {
      violations.push(`requirements_registry_surface_evidence_unbound:${id}:${surface}`);
    }
    collectNoDuplicates(assessment.evidenceLinks, `surface-evidence:${id}:${surface}`, violations);
  }
  const builderEvidence = new Set(assessments.builder.evidenceLinks);
  if (assessments.runtime.evidenceLinks.some((evidenceLink) => builderEvidence.has(evidenceLink))) {
    violations.push(`requirements_registry_surface_evidence_reused:${id}`);
  }
  if (canonicalEvidenceLinks) {
    const surfaceEvidence = new Set([
      ...assessments.builder.evidenceLinks,
      ...assessments.runtime.evidenceLinks,
    ]);
    if (surfaceEvidence.size !== canonicalEvidenceLinks.length ||
      canonicalEvidenceLinks.some((evidenceLink) => !surfaceEvidence.has(evidenceLink))) {
      violations.push(`requirements_registry_surface_evidence_inventory:${id}`);
    }
  }
  if (status === "implemented" && [assessments.builder, assessments.runtime].some((assessment) =>
    assessment.outcome !== "pass" && assessment.outcome !== "n/a")) {
    violations.push(`requirements_registry_false_surface_satisfied:${id}`);
  }
}
