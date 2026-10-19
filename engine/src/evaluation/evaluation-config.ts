/** Evaluation operational defaults — canonical owner for evaluation-domain configurable values.
 * Also owns the budget-calculator inline constants
 * (`TIMELINE_RECORDS_PER_CELL`, `TIMELINE_RECORD_BYTES`,
 * `INDEX_OVERHEAD_FACTOR`, `DEFAULT_HUMAN_REVIEW_SAMPLE_RATE`) which were
 * scattered inline literals in budget-calculator.ts. */
export const DEFAULT_MAX_CONCURRENCY = 3;
export const IDENTITY_FAILURE_THRESHOLD = 5;
export const IDENTITY_ATTESTATION_TIMEOUT_MS = 30_000;
export const DEFAULT_TIMELINE_RECORDS_PER_CELL = 12;
export const DEFAULT_TIMELINE_RECORD_BYTES = 2_048;
export const DEFAULT_INDEX_OVERHEAD_FACTOR = 0.3;
export const DEFAULT_HUMAN_REVIEW_SAMPLE_RATE = 0.1;
